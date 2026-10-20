import type { CollectionItem } from '@/app/types/CollectionItem';

// ─────────────────────────────────────────────────────────────────────────
// Edição de um campo na tela de comparação.
//
// Sem isto a escolha era binária: a versão daqui ou a de lá, inteira. Mas o
// caso que dói é justamente o do meio — o colega mudou o corpo e você mudou
// outra parte do mesmo corpo, e nenhum dos dois lados sozinho está certo.
//
// Três responsabilidades, todas puras: dizer quais campos dá pra editar,
// converter entre o valor e o texto que aparece na caixa, e gravar o valor
// editado de volta no nó.
// ─────────────────────────────────────────────────────────────────────────

/** Campos cujo valor é texto puro — editados como estão. */
const TEXT_FIELDS = new Set(['name', 'method', 'url', 'body', 'preRequestScript', 'postResponseScript']);

/** Campos estruturados — editados como JSON e validados antes de aplicar. */
const JSON_FIELDS = new Set(['headers', 'auth', 'example']);

/**
 * `order` fica de fora de propósito: ele não é um campo guardado, é a
 * sequência dos filhos, derivada. Editar a lista de nomes não teria como
 * voltar pros nós certos — e um "resolvi" que não aplica é pior que não
 * oferecer.
 */
export function isEditableField(field: string): boolean {
  return TEXT_FIELDS.has(field) || JSON_FIELDS.has(field);
}

export function isJsonField(field: string): boolean {
  return JSON_FIELDS.has(field);
}

export function formatFieldValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function parseFieldValue(field: string, text: string): ParseResult {
  if (!isJsonField(field)) return { ok: true, value: text };

  const trimmed = text.trim();
  // Vazio é legítimo: significa "este nó não tem auth / não tem example".
  if (trimmed === '') return { ok: true, value: undefined };

  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (e) {
    // A mensagem do JSON.parse diz a posição, que é o que ajuda a achar o
    // erro numa caixa de texto.
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Grava o valor editado no nó, devolvendo uma cópia.
 *
 * Campo desconhecido devolve o nó intacto em vez de inventar uma chave: é
 * preferível a edição não ter efeito a corromper a request com um campo que
 * o resto do app não lê.
 */
export function applyFieldOverride(
  node: CollectionItem,
  field: string,
  value: unknown
): CollectionItem {
  const next: CollectionItem = { ...node };
  const request = { ...(node.request ?? { url: '', urlexport: { host: [], path: [], raw: '' }, headers: [] }) };

  switch (field) {
    case 'name':
      next.name = String(value ?? '');
      return next;

    case 'method':
      next.method = String(value ?? 'GET').toUpperCase() as CollectionItem['method'];
      return next;

    case 'url': {
      const url = String(value ?? '');
      // `urlexport.raw` acompanha: os dois guardam a mesma URL, e deixá-los
      // divergentes é o tipo de inconsistência que só aparece na exportação.
      next.request = { ...request, url, urlexport: { ...request.urlexport, raw: url } };
      return next;
    }

    case 'body':
      next.request = { ...request, body: String(value ?? '') };
      return next;

    case 'headers': {
      type Headers = NonNullable<CollectionItem['request']>['headers'];
      // Valor que não é lista cai pra vazio em vez de entrar como está: um
      // `headers` que não é array quebra todo lugar que itera sobre ele.
      next.request = { ...request, headers: (Array.isArray(value) ? value : []) as Headers };
      return next;
    }

    case 'auth':
      next.request = { ...request, auth: value as NonNullable<CollectionItem['request']>['auth'] };
      return next;

    case 'preRequestScript':
      next.request = {
        ...request,
        scripts: { preRequest: String(value ?? ''), postResponse: request.scripts?.postResponse ?? '' },
      };
      return next;

    case 'postResponseScript':
      next.request = {
        ...request,
        scripts: { preRequest: request.scripts?.preRequest ?? '', postResponse: String(value ?? '') },
      };
      return next;

    case 'example':
      next.example = value as CollectionItem['example'];
      return next;

    default:
      return node;
  }
}

/** Overrides por nó: { [nodeId]: { [field]: valor } }. */
export type OverrideMap = Record<string, Record<string, unknown>>;

export function applyOverrides(node: CollectionItem, fields: Record<string, unknown> | undefined): CollectionItem {
  if (!fields) return node;
  let result = node;
  for (const [field, value] of Object.entries(fields)) {
    result = applyFieldOverride(result, field, value);
  }
  return result;
}
