import { CollectionItem } from '@/app/types/CollectionItem';

// ─────────────────────────────────────────────────────────────────────────
// Importação de OpenAPI 3.x e Swagger 2.0.
//
// A saída é a MESMA árvore de CollectionItem que o import do Postman produz,
// de propósito: tudo que já existe depois disso — árvore, execução, runner,
// export — funciona sem saber de onde o item veio.
//
// Módulo puro: sem React, sem Tauri, sem I/O. É o que permite testá-lo.
// ─────────────────────────────────────────────────────────────────────────

export interface OpenApiImportResult {
  collection: CollectionItem | null;
  /** Variáveis sugeridas pro environment (hoje: baseUrl). */
  variables: { key: string; value: string }[];
  warnings: string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

const uid = () => crypto.randomUUID();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Detecta o formato e devolve a versão maior, ou null se não for OpenAPI. */
export function detectOpenApiVersion(doc: unknown): 2 | 3 | null {
  if (!isRecord(doc)) return null;
  if (typeof doc.openapi === 'string' && doc.openapi.startsWith('3')) return 3;
  if (doc.swagger === '2.0' || doc.swagger === 2) return 2;
  return null;
}

// Resolve um $ref local ("#/components/schemas/Pedido"). Referência externa
// (outro arquivo ou URL) não é resolvida: exigiria buscar na rede, e o import
// é offline — nesse caso o campo vira um exemplo genérico e vai um aviso.
function resolveRef(doc: Record<string, unknown>, node: unknown, seen: Set<string>): unknown {
  let current = node;
  let hops = 0;
  while (isRecord(current) && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (!ref.startsWith('#/') || seen.has(ref) || hops++ > 20) return undefined;
    seen.add(ref);
    let target: unknown = doc;
    for (const part of ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      target = isRecord(target) ? target[key] : undefined;
    }
    current = target;
  }
  return current;
}

// Gera um valor de exemplo a partir do schema. Prefere `example`/`default`
// declarados; só inventa quando não há nada, e aí usa o tipo.
function exampleFromSchema(
  doc: Record<string, unknown>,
  schemaNode: unknown,
  depth = 0,
  seen = new Set<string>()
): unknown {
  // Schema recursivo (um Pedido que contém Pedido) estouraria a pilha; o
  // corte devolve null em vez de travar o import.
  if (depth > 8) return null;

  const schema = resolveRef(doc, schemaNode, new Set(seen));
  if (!isRecord(schema)) return null;

  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  // Composição: usa o primeiro ramo pra allOf/oneOf/anyOf. Combinar de
  // verdade exigiria um merge de schemas que não paga o custo aqui.
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const branch = schema[key];
    if (Array.isArray(branch) && branch.length > 0) {
      if (key === 'allOf') {
        const merged: Record<string, unknown> = {};
        for (const part of branch) {
          const value = exampleFromSchema(doc, part, depth + 1, seen);
          if (isRecord(value)) Object.assign(merged, value);
        }
        return merged;
      }
      return exampleFromSchema(doc, branch[0], depth + 1, seen);
    }
  }

  const type = typeof schema.type === 'string' ? schema.type : isRecord(schema.properties) ? 'object' : undefined;

  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = isRecord(schema.properties) ? schema.properties : {};
      for (const [name, sub] of Object.entries(props)) {
        out[name] = exampleFromSchema(doc, sub, depth + 1, seen);
      }
      return out;
    }
    case 'array':
      return [exampleFromSchema(doc, schema.items, depth + 1, seen)];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'string': {
      const format = typeof schema.format === 'string' ? schema.format : '';
      if (format === 'date-time') return '1970-01-01T00:00:00Z';
      if (format === 'date') return '1970-01-01';
      if (format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      return '';
    }
    default:
      return null;
  }
}

/** URL base: `servers` no 3.x, `schemes`+`host`+`basePath` no 2.0. */
function baseUrlOf(doc: Record<string, unknown>, version: 2 | 3): string {
  if (version === 3) {
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    const first = servers.find(isRecord);
    const url = first && typeof first.url === 'string' ? first.url : '';
    // Variáveis de server ({version}) viram variáveis do app, com o default
    // do próprio documento quando existe.
    const vars = first && isRecord(first.variables) ? first.variables : {};
    return url.replace(/\{(\w+)\}/g, (match, name: string) => {
      const entry = vars[name];
      const fallback = isRecord(entry) && entry.default !== undefined ? String(entry.default) : '';
      return fallback || match;
    });
  }

  const scheme = Array.isArray(doc.schemes) && typeof doc.schemes[0] === 'string' ? doc.schemes[0] : 'https';
  const host = typeof doc.host === 'string' ? doc.host : '';
  const basePath = typeof doc.basePath === 'string' ? doc.basePath : '';
  return host ? `${scheme}://${host}${basePath}` : basePath;
}

interface BuiltRequest {
  item: CollectionItem;
  tag: string;
}

function buildRequest(
  doc: Record<string, unknown>,
  version: 2 | 3,
  routePath: string,
  method: string,
  operation: Record<string, unknown>,
  sharedParams: unknown[],
  warnings: string[]
): BuiltRequest {
  const params = [...sharedParams, ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
    .map(p => resolveRef(doc, p, new Set()))
    .filter(isRecord);

  const headers: { key: string; value: string; enabled: boolean }[] = [];
  const query: { key: string; value: string; enabled: boolean }[] = [];
  const pathVars: { key: string; value: string }[] = [];

  for (const p of params) {
    const name = typeof p.name === 'string' ? p.name : '';
    if (!name) continue;
    const schema = version === 3 ? p.schema : p;
    const example = p.example !== undefined ? p.example : exampleFromSchema(doc, schema);
    const value = example === null || example === undefined || isRecord(example) ? '' : String(example);
    const required = p.required === true;

    if (p.in === 'header') headers.push({ key: name, value, enabled: required });
    else if (p.in === 'query') query.push({ key: name, value, enabled: required });
    else if (p.in === 'path') pathVars.push({ key: name, value });
  }

  // O app representa path param como ":nome"; o OpenAPI usa "{nome}".
  const appPath = routePath.replace(/\{([^}]+)\}/g, ':$1');
  const base = baseUrlOf(doc, version);
  const queryString = query.length
    ? '?' + query.filter(q => q.enabled).map(q => `${q.key}=${q.value}`).join('&')
    : '';
  const url = `${base}${appPath}${queryString}`;

  // ── Corpo ──────────────────────────────────────────────────────────────
  let body = '';
  let contentType = '';

  if (version === 3) {
    const requestBody = resolveRef(doc, operation.requestBody, new Set());
    const content = isRecord(requestBody) && isRecord(requestBody.content) ? requestBody.content : null;
    if (content) {
      // Prefere JSON; se a operação só aceita outro formato, avisa em vez de
      // gerar um corpo que não corresponde ao declarado.
      const jsonKey = Object.keys(content).find(k => k.includes('json'));
      const chosen = jsonKey ?? Object.keys(content)[0];
      if (chosen) {
        contentType = chosen;
        const media = content[chosen];
        if (isRecord(media)) {
          const example = media.example !== undefined ? media.example : exampleFromSchema(doc, media.schema);
          body = JSON.stringify(example, null, 2);
        }
        if (!jsonKey) {
          warnings.push(`${method.toUpperCase()} ${routePath}: corpo "${chosen}" não é JSON — importado como texto.`);
        }
      }
    }
  } else {
    const bodyParam = params.find(p => p.in === 'body');
    if (bodyParam) {
      contentType = 'application/json';
      body = JSON.stringify(exampleFromSchema(doc, bodyParam.schema), null, 2);
    }
    const formParams = params.filter(p => p.in === 'formData');
    if (formParams.length > 0) {
      warnings.push(`${method.toUpperCase()} ${routePath}: formData não é suportado — parâmetros omitidos.`);
    }
  }

  if (contentType && !headers.some(h => h.key.toLowerCase() === 'content-type')) {
    headers.push({ key: 'Content-Type', value: contentType, enabled: true });
  }

  const name =
    (typeof operation.summary === 'string' && operation.summary.trim()) ||
    (typeof operation.operationId === 'string' && operation.operationId.trim()) ||
    `${method.toUpperCase()} ${routePath}`;

  const tag = Array.isArray(operation.tags) && typeof operation.tags[0] === 'string' ? operation.tags[0] : 'default';

  return {
    tag,
    item: {
      id: uid(),
      name,
      type: 'request',
      method: method.toUpperCase() as CollectionItem['method'],
      request: {
        url,
        urlexport: { raw: url, host: [], path: [], variable: pathVars.map(v => ({ ...v, enabled: true })) },
        headers,
        body,
        bodyType: body ? 'raw' : 'none',
        auth: { type: 'none' },
        scripts: { preRequest: '', postResponse: '' },
      },
    } as unknown as CollectionItem,
  };
}

export function parseOpenApi(doc: unknown, fallbackName = 'OpenAPI'): OpenApiImportResult {
  const warnings: string[] = [];
  const version = detectOpenApiVersion(doc);

  if (!version || !isRecord(doc)) {
    return { collection: null, variables: [], warnings: ['Arquivo não é OpenAPI 3.x nem Swagger 2.0.'] };
  }

  const paths = isRecord(doc.paths) ? doc.paths : {};
  if (Object.keys(paths).length === 0) {
    return { collection: null, variables: [], warnings: ['O documento não declara nenhum path.'] };
  }

  const info = isRecord(doc.info) ? doc.info : {};
  const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : fallbackName;

  // Agrupa por tag, que é como a própria especificação organiza operações —
  // e vira pasta na árvore. Sem tag, cai em "default".
  const byTag = new Map<string, CollectionItem[]>();

  for (const [routePath, pathItemRaw] of Object.entries(paths)) {
    const pathItem = resolveRef(doc, pathItemRaw, new Set());
    if (!isRecord(pathItem)) continue;
    const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      const built = buildRequest(doc, version, routePath, method, operation, shared, warnings);
      const list = byTag.get(built.tag) ?? [];
      list.push(built.item);
      byTag.set(built.tag, list);
    }
  }

  if (byTag.size === 0) {
    return { collection: null, variables: [], warnings: ['Nenhuma operação encontrada nos paths.'] };
  }

  // Uma tag só não merece uma pasta intermediária: os requests ficam direto
  // sob a collection.
  const children: CollectionItem[] =
    byTag.size === 1
      ? [...byTag.values()][0]
      : [...byTag.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([tag, items]) => ({ id: uid(), name: tag, type: 'folder', item: items } as CollectionItem));

  const base = baseUrlOf(doc, version);
  const variables = base ? [{ key: 'baseUrl', value: base }] : [];
  if (!base) warnings.push('O documento não declara servidor — as URLs ficaram relativas.');

  return {
    collection: { id: uid(), name: title, type: 'folder', item: children },
    variables,
    warnings,
  };
}
