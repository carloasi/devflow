// ─────────────────────────────────────────────────────────────────────────
// Diff semântico entre duas versões de um arquivo do GitHub Sync.
//
// Os arquivos no repositório são cifrados, então o patch do próprio GitHub
// não diz nada. Aqui as duas versões já chegam descriptografadas e a
// comparação é feita por estrutura: pastas e requests por id, variáveis de
// environment por id/key — o que importa pra quem lê o histórico ("criou a
// request X", "trocou a URL", "mudou o valor de baseUrl"), não linhas de JSON.
// ─────────────────────────────────────────────────────────────────────────

export type ChangeKind = 'added' | 'removed' | 'modified';

// Uma linha de diff de texto (body, script) — mesmo formato do diff unificado.
export interface TextDiffLine {
  type: 'same' | 'add' | 'del' | 'skip';
  text: string;
}

export interface FieldChange {
  field: string;
  before?: string;
  after?: string;
  // Para campos de texto longo (body, scripts): diff linha a linha.
  lines?: TextDiffLine[];
  // Valor sensível — a UI mostra só que mudou, não o conteúdo.
  masked?: boolean;
}

export interface ItemChange {
  kind: ChangeKind;
  itemType: 'folder' | 'request' | 'example' | 'variable' | 'environment' | 'collection';
  name: string;
  // Caminho até o item ("Collection / Flows / Booking Flow") — vazio na raiz.
  path: string;
  method?: string;
  fields: FieldChange[];
}

export interface FileChange {
  file: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  kind: 'collection' | 'environment' | 'other';
  // Nome amigável (nome da collection / do environment).
  title: string;
  changes: ItemChange[];
  // Arquivo que não deu pra baixar/descriptografar — mostra só o status.
  error?: string;
  // Conteúdo completo (JSON formatado) de cada lado, pro diff lado a lado.
  // null = o arquivo não existia daquele lado.
  beforeText?: string | null;
  afterText?: string | null;
}

// ── Helpers de texto ─────────────────────────────────────────────────────

const SECRET_KEY_REGEX = /auth|token|key|secret|password|passwd|senha|cookie|session|credential/i;

function str(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

// Diff linha a linha por LCS. Bodies e scripts costumam ter poucas centenas
// de linhas; acima do limite devolve só um resumo pra não travar a UI.
const MAX_DIFF_CELLS = 400_000;
const CONTEXT_LINES = 2;

export function diffLines(before: string, after: string): TextDiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);

  // Corta prefixo e sufixo iguais antes do LCS — normalmente é quase tudo.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle: TextDiffLine[] = [];

  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    middle.push(...midA.map((text): TextDiffLine => ({ type: 'del', text })));
    middle.push(...midB.map((text): TextDiffLine => ({ type: 'add', text })));
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ type: 'same', text: midA[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        middle.push({ type: 'del', text: midA[i++] });
      } else {
        middle.push({ type: 'add', text: midB[j++] });
      }
    }
    while (i < n) middle.push({ type: 'del', text: midA[i++] });
    while (j < m) middle.push({ type: 'add', text: midB[j++] });
  }

  const full: TextDiffLine[] = [
    ...a.slice(0, start).map((text): TextDiffLine => ({ type: 'same', text })),
    ...middle,
    ...a.slice(endA).map((text): TextDiffLine => ({ type: 'same', text })),
  ];

  // Só mantém algumas linhas de contexto em volta de cada mudança.
  const keep = new Array<boolean>(full.length).fill(false);
  full.forEach((line, idx) => {
    if (line.type === 'same') return;
    for (let k = Math.max(0, idx - CONTEXT_LINES); k <= Math.min(full.length - 1, idx + CONTEXT_LINES); k++) {
      keep[k] = true;
    }
  });

  const out: TextDiffLine[] = [];
  let skipped = 0;
  full.forEach((line, idx) => {
    if (keep[idx]) {
      if (skipped) out.push({ type: 'skip', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
      skipped = 0;
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped && out.length) out.push({ type: 'skip', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
  return out;
}

// ── Collections ──────────────────────────────────────────────────────────

// Forma comum de uma request, aceitando tanto o formato interno do app
// (CollectionItem) quanto o Postman v2.1 que versões antigas enviavam.
interface NormalizedRequest {
  method: string;
  url: string;
  headers: { key: string; value: string; enabled: boolean }[];
  params: { key: string; value: string }[];
  body: string;
  bodyType: string;
  authType: string;
  authFingerprint: string;
  preRequest: string;
  postResponse: string;
}

interface NormalizedNode {
  id: string;
  name: string;
  type: 'folder' | 'request' | 'example';
  path: string[];
  parentId: string | null;
  childIds: string[];
  request?: NormalizedRequest;
  example?: string;
  grpc?: NormalizedGrpc;
}

// Request gRPC (CollectionItem.protocol === 'grpc').
interface NormalizedGrpc {
  target: string;
  useTls: boolean;
  insecureTls: boolean;
  method: string;
  message: string;
  metadata: { key: string; value: string; enabled: boolean }[];
  schemaSource: string;
  // Só um "carimbo" do schema: o conteúdo em base64 não diz nada pra quem lê.
  schemaFingerprint: string;
}

function normalizeGrpc(raw: any): NormalizedGrpc {
  const descriptor = str(raw?.descriptorSet);
  return {
    target: str(raw?.target),
    useTls: !!raw?.useTls,
    insecureTls: !!raw?.insecureTls,
    method: str(raw?.method),
    message: str(raw?.message),
    metadata: (Array.isArray(raw?.metadata) ? raw.metadata : []).map((m: any) => ({
      key: str(m?.key),
      value: str(m?.value),
      enabled: m?.enabled !== false,
    })),
    schemaSource: str(raw?.schemaSource),
    schemaFingerprint: `${descriptor.length}:${descriptor.slice(-32)}`,
  };
}

function grpcFieldChanges(before: NormalizedGrpc, after: NormalizedGrpc): FieldChange[] {
  const changes: FieldChange[] = [];
  if (before.target !== after.target) changes.push({ field: 'Server', before: before.target, after: after.target });
  const tlsLabel = (g: NormalizedGrpc) => (!g.useTls ? 'off' : g.insecureTls ? 'on (certificate not verified)' : 'on');
  if (tlsLabel(before) !== tlsLabel(after)) {
    changes.push({ field: 'TLS', before: tlsLabel(before), after: tlsLabel(after) });
  }
  if (before.method !== after.method) changes.push({ field: 'Method', before: before.method, after: after.method });
  const message = textChange('Message', before.message, after.message);
  if (message) changes.push(message);
  changes.push(...keyValueChanges('Metadata', before.metadata, after.metadata));
  if (before.schemaSource !== after.schemaSource || before.schemaFingerprint !== after.schemaFingerprint) {
    changes.push({
      field: 'Schema',
      before: before.schemaSource || '(none)',
      after: `${after.schemaSource || '(none)'} (reloaded)`,
    });
  }
  return changes;
}

function postmanScript(events: any[] | undefined, listen: string): string {
  const event = (events ?? []).find((e) => e?.listen === listen);
  const exec = event?.script?.exec;
  return Array.isArray(exec) ? exec.join('\n') : str(exec);
}

function normalizeRequest(node: any): NormalizedRequest {
  const req = node?.request ?? {};
  const url = typeof req.url === 'string' ? req.url : req.url?.raw ?? '';
  const auth = req.auth ?? {};
  const rawHeaders = req.headers ?? req.header ?? [];
  const params = req.urlexport?.variable ?? req.url?.variable ?? [];

  return {
    method: String(node?.method ?? req.method ?? 'GET').toUpperCase(),
    url: str(url),
    headers: (Array.isArray(rawHeaders) ? rawHeaders : []).map((h: any) => ({
      key: str(h?.key),
      value: str(h?.value),
      enabled: h?.enabled !== false && h?.disabled !== true,
    })),
    params: (Array.isArray(params) ? params : []).map((p: any) => ({ key: str(p?.key), value: str(p?.value) })),
    body: typeof req.body === 'string' ? req.body : str(req.body?.raw ?? req.body?.graphql?.query ?? ''),
    bodyType: str(req.bodyType ?? req.body?.mode ?? ''),
    authType: str(auth.type ?? 'none'),
    // Credenciais nunca aparecem: só dá pra saber SE mudaram.
    authFingerprint: JSON.stringify(auth),
    preRequest: str(req.scripts?.preRequest ?? postmanScript(node?.event, 'prerequest')),
    postResponse: str(req.scripts?.postResponse ?? postmanScript(node?.event, 'test')),
  };
}

function nodeType(node: any): NormalizedNode['type'] {
  if (node?.type === 'example') return 'example';
  if (node?.type === 'request' || (node?.request && !Array.isArray(node?.item))) return 'request';
  return 'folder';
}

function flattenCollection(roots: any[]): Map<string, NormalizedNode> {
  const out = new Map<string, NormalizedNode>();

  const walk = (nodes: any[], path: string[], parentId: string | null) => {
    const childIds: string[] = [];
    nodes.forEach((node, index) => {
      if (!node || typeof node !== 'object') return;
      const name = str(node.name ?? node.info?.name ?? 'Untitled');
      // Sem id (formato Postman antigo), identifica pelo caminho + nome.
      const id = str(node.id ?? node._postman_id ?? node.info?._postman_id ?? `${parentId ?? ''}/${name}#${index}`);
      const type = nodeType(node);

      const normalized: NormalizedNode = { id, name, type, path, parentId, childIds: [] };
      if (type === 'request' && node.protocol === 'grpc') normalized.grpc = normalizeGrpc(node.grpc);
      else if (type === 'request') normalized.request = normalizeRequest(node);
      if (type === 'example') {
        normalized.example = JSON.stringify(node.example ?? {});
        normalized.request = node.request ? normalizeRequest(node) : undefined;
      }
      out.set(id, normalized);
      childIds.push(id);

      if (Array.isArray(node.item)) {
        normalized.childIds = walk(node.item, [...path, name], id);
      }
    });
    return childIds;
  };

  walk(roots, [], null);
  return out;
}

function toRoots(content: unknown): any[] {
  if (content == null) return [];
  if (typeof content === 'string') {
    try {
      return toRoots(JSON.parse(content));
    } catch {
      return [];
    }
  }
  return Array.isArray(content) ? content : [content];
}

function keyValueChanges(
  label: string,
  before: { key: string; value: string; enabled?: boolean }[],
  after: { key: string; value: string; enabled?: boolean }[]
): FieldChange[] {
  const changes: FieldChange[] = [];
  const beforeMap = new Map(before.map((h) => [h.key, h]));
  const afterMap = new Map(after.map((h) => [h.key, h]));

  for (const [key, b] of beforeMap) {
    const a = afterMap.get(key);
    const masked = SECRET_KEY_REGEX.test(key);
    if (!a) {
      changes.push({ field: `${label} removed: ${key}`, before: masked ? undefined : b.value, masked });
    } else if (a.value !== b.value) {
      changes.push({ field: `${label}: ${key}`, before: b.value, after: a.value, masked });
    } else if (a.enabled !== b.enabled) {
      changes.push({ field: `${label}: ${key}`, before: b.enabled ? 'enabled' : 'disabled', after: a.enabled ? 'enabled' : 'disabled' });
    }
  }
  for (const [key, a] of afterMap) {
    if (beforeMap.has(key)) continue;
    const masked = SECRET_KEY_REGEX.test(key);
    changes.push({ field: `${label} added: ${key}`, after: masked ? undefined : a.value, masked });
  }
  return changes;
}

function textChange(field: string, before: string, after: string): FieldChange | null {
  if (before === after) return null;
  const multiline = before.includes('\n') || after.includes('\n') || before.length > 120 || after.length > 120;
  if (!multiline) return { field, before, after };
  return { field, lines: diffLines(before, after) };
}

function requestFieldChanges(before: NormalizedRequest, after: NormalizedRequest): FieldChange[] {
  const changes: FieldChange[] = [];
  if (before.method !== after.method) changes.push({ field: 'Method', before: before.method, after: after.method });

  const url = textChange('URL', before.url, after.url);
  if (url) changes.push(url);

  changes.push(...keyValueChanges('Path param', before.params, after.params));
  changes.push(...keyValueChanges('Header', before.headers, after.headers));

  if (before.authType !== after.authType) {
    changes.push({ field: 'Auth type', before: before.authType, after: after.authType });
  } else if (before.authFingerprint !== after.authFingerprint) {
    changes.push({ field: 'Auth credentials', masked: true });
  }

  if (before.bodyType !== after.bodyType && (before.bodyType || after.bodyType)) {
    changes.push({ field: 'Body type', before: before.bodyType || 'none', after: after.bodyType || 'none' });
  }
  const body = textChange('Body', before.body, after.body);
  if (body) changes.push(body);

  const pre = textChange('Pre-request script', before.preRequest, after.preRequest);
  if (pre) changes.push(pre);
  const post = textChange('Post-response script', before.postResponse, after.postResponse);
  if (post) changes.push(post);

  return changes;
}

export function diffCollection(beforeContent: unknown, afterContent: unknown): ItemChange[] {
  const before = flattenCollection(toRoots(beforeContent));
  const after = flattenCollection(toRoots(afterContent));
  const changes: ItemChange[] = [];

  const label = (node: NormalizedNode) => node.path.join(' / ');
  const itemType = (node: NormalizedNode): ItemChange['itemType'] =>
    node.parentId === null && node.type === 'folder' ? 'collection' : node.type;

  for (const [id, b] of before) {
    if (after.has(id)) continue;
    // Pasta removida inteira: não lista cada filho de novo.
    if (b.parentId && !after.has(b.parentId) && before.has(b.parentId)) continue;
    changes.push({ kind: 'removed', itemType: itemType(b), name: b.name, path: label(b), method: b.request?.method, fields: [] });
  }

  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) {
      if (a.parentId && !before.has(a.parentId) && after.has(a.parentId)) continue;
      const fields: FieldChange[] = [];
      if (a.type === 'folder') {
        const count = a.childIds.length;
        if (count) fields.push({ field: 'Contains', after: `${count} item${count === 1 ? '' : 's'}` });
      } else if (a.grpc) {
        fields.push({ field: 'Method', after: `${a.grpc.target} ${a.grpc.method}`.trim() });
      } else if (a.request) {
        fields.push({ field: 'URL', after: a.request.url });
      }
      changes.push({ kind: 'added', itemType: itemType(a), name: a.name, path: label(a), method: a.request?.method, fields });
      continue;
    }

    const fields: FieldChange[] = [];
    if (a.name !== b.name) fields.push({ field: 'Name', before: b.name, after: a.name });
    if (a.parentId !== b.parentId) fields.push({ field: 'Moved', before: label(b) || '(root)', after: label(a) || '(root)' });

    if (a.request && b.request) fields.push(...requestFieldChanges(b.request, a.request));
    if (a.grpc && b.grpc) fields.push(...grpcFieldChanges(b.grpc, a.grpc));
    if (a.example !== b.example) fields.push({ field: 'Saved response', lines: diffLines(b.example ?? '', a.example ?? '') });

    // Ordem dos filhos — num fluxo, a ordem É o comportamento. Compara só
    // os ids presentes nas duas versões, pra adição/remoção não contar.
    if (a.type === 'folder') {
      const common = new Set(b.childIds.filter((cid) => a.childIds.includes(cid)));
      const orderBefore = b.childIds.filter((cid) => common.has(cid));
      const orderAfter = a.childIds.filter((cid) => common.has(cid));
      if (orderBefore.join('|') !== orderAfter.join('|')) {
        const names = (ids: string[], map: Map<string, NormalizedNode>) =>
          ids.map((cid, i) => `${i + 1}. ${map.get(cid)?.name ?? cid}`).join('\n');
        fields.push({ field: 'Order', lines: diffLines(names(orderBefore, before), names(orderAfter, after)) });
      }
    }

    if (fields.length) {
      changes.push({ kind: 'modified', itemType: itemType(a), name: a.name, path: label(a), method: a.request?.method, fields });
    }
  }

  return changes;
}

// ── Environments ─────────────────────────────────────────────────────────

function toEnvironments(content: unknown): any[] {
  return toRoots(content).filter((env) => env && typeof env === 'object');
}

export function diffEnvironment(beforeContent: unknown, afterContent: unknown): ItemChange[] {
  const beforeEnvs = toEnvironments(beforeContent);
  const afterEnvs = toEnvironments(afterContent);
  const changes: ItemChange[] = [];

  const envKey = (env: any, i: number) => str(env.id ?? env.name ?? i);
  const beforeById = new Map(beforeEnvs.map((env, i) => [envKey(env, i), env]));
  const afterById = new Map(afterEnvs.map((env, i) => [envKey(env, i), env]));

  for (const [id, b] of beforeById) {
    if (!afterById.has(id)) {
      changes.push({ kind: 'removed', itemType: 'environment', name: str(b.name), path: '', fields: [] });
    }
  }

  for (const [id, a] of afterById) {
    const b = beforeById.get(id);
    const envName = str(a.name);
    if (!b) {
      const count = Array.isArray(a.values) ? a.values.length : 0;
      changes.push({
        kind: 'added',
        itemType: 'environment',
        name: envName,
        path: '',
        fields: [{ field: 'Variables', after: String(count) }],
      });
      continue;
    }

    if (str(a.name) !== str(b.name)) {
      changes.push({ kind: 'modified', itemType: 'environment', name: envName, path: '', fields: [{ field: 'Name', before: str(b.name), after: envName }] });
    }

    const vars = (env: any) => (Array.isArray(env.values) ? env.values : []);
    // Por id quando existe (renomear a key continua sendo a mesma variável);
    // senão por key + ordem, porque keys duplicadas são permitidas.
    const varKey = (v: any, i: number, all: any[]) => {
      if (v?.id) return `id:${v.id}`;
      const dupIndex = all.slice(0, i).filter((o) => o?.key === v?.key).length;
      return `key:${v?.key}#${dupIndex}`;
    };
    const beforeVars = new Map<string, any>(vars(b).map((v: any, i: number, all: any[]) => [varKey(v, i, all), v]));
    const afterVars = new Map<string, any>(vars(a).map((v: any, i: number, all: any[]) => [varKey(v, i, all), v]));

    const isSecret = (v: any) => v?.type === 'secret' || SECRET_KEY_REGEX.test(str(v?.key));

    for (const [k, bv] of beforeVars) {
      if (afterVars.has(k)) continue;
      changes.push({
        kind: 'removed',
        itemType: 'variable',
        name: str(bv.key),
        path: envName,
        fields: isSecret(bv) ? [{ field: 'Value', masked: true }] : [{ field: 'Value', before: str(bv.value) }],
      });
    }

    for (const [k, av] of afterVars) {
      const bv = beforeVars.get(k);
      const secret = isSecret(av) || (bv && isSecret(bv));
      if (!bv) {
        changes.push({
          kind: 'added',
          itemType: 'variable',
          name: str(av.key),
          path: envName,
          fields: secret ? [{ field: 'Value', masked: true }] : [{ field: 'Value', after: str(av.value) }],
        });
        continue;
      }

      const fields: FieldChange[] = [];
      if (str(av.key) !== str(bv.key)) fields.push({ field: 'Key', before: str(bv.key), after: str(av.key) });
      if (str(av.value) !== str(bv.value)) {
        fields.push(secret ? { field: 'Value', masked: true } : { field: 'Value', before: str(bv.value), after: str(av.value) });
      }
      if ((av.enabled !== false) !== (bv.enabled !== false)) {
        fields.push({ field: 'Enabled', before: String(bv.enabled !== false), after: String(av.enabled !== false) });
      }
      if (str(av.type) !== str(bv.type) && (av.type || bv.type)) {
        fields.push({ field: 'Type', before: str(bv.type) || 'default', after: str(av.type) || 'default' });
      }
      if (fields.length) {
        changes.push({ kind: 'modified', itemType: 'variable', name: str(av.key), path: envName, fields });
      }
    }
  }

  return changes;
}

// JSON formatado e estável pro diff lado a lado. Tira as marcas locais de
// favorito, que não sobem pro GitHub mas podem aparecer em arquivos antigos.
export function prettyContent(content: unknown): string | null {
  if (content == null) return null;
  const parsed = typeof content === 'string' ? (() => { try { return JSON.parse(content); } catch { return content; } })() : content;
  if (typeof parsed === 'string') return parsed;
  return JSON.stringify(parsed, (key, value) => (key === 'starred' || key === 'starredAfterId' ? undefined : value), 2);
}

// Nome amigável do arquivo: nome da collection/environment se der pra ler,
// senão o nome do arquivo sem as extensões do sync.
export function fileTitle(path: string, content: unknown): string {
  const first = toRoots(content)[0];
  const name = first?.name ?? first?.info?.name;
  if (name) return str(name);
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.postman_(collection|environment)\.json$/i, '').replace(/\.json$/i, '');
}
