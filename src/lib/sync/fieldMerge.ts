import type { CollectionItem } from '@/app/types/CollectionItem';
import { sameContent } from '@/lib/canonicalCompare';
import { hashContent } from '@/lib/contentHash';
import { stripStarredFlags } from '@/components/collection-tree/utils/tree.utils';

// ─────────────────────────────────────────────────────────────────────────
// Merge CAMPO A CAMPO de um item alterado dos dois lados.
//
// Você mudou a URL de uma request; alguém mudou o script dela no GitHub.
// Pelo item inteiro isso é conflito, mas nada se sobrepõe — dá pra levar as
// duas mudanças. Pra saber quem mudou cada campo, a base da sincronização
// (lib/syncBase) guarda também um hash POR CAMPO, com a chave `id#campo`.
//
// Os campos são os mesmos da tela de revisão (collectionDiff.fieldDiffs).
// Tudo o mais do conteúdo próprio do item (tipo, gRPC, bodyType, headers
// desligados…) vira um campo só, `~rest`: se ele mudou dos dois lados, ou
// mudou aqui (não há como levar "o resto" por cima da versão de lá), o item
// continua sendo conflito — melhor perguntar que perder algo em silêncio.
// ─────────────────────────────────────────────────────────────────────────

export const MERGE_FIELDS = [
  'name',
  'method',
  'url',
  'headers',
  'body',
  'auth',
  'preRequestScript',
  'postResponseScript',
  'example',
  'description',
  'markers',
  'markerNotes',
  // Valores dos path params (urlexport.variable). Fora do REST (o urlexport
  // viaja com a URL), então sem campo próprio a mudança de um `:id` com a
  // mesma URL não era de ninguém: no merge por campo valia a versão de lá.
  'pathParams',
] as const;

/**
 * Campos do diff (collectionDiff.fieldDiffs) que o REST cobre: não têm caixa
 * própria no merge por campo — mudam junto com o resto do conteúdo, de um
 * lado inteiro (ver fieldMergePlan e o Auto merge).
 */
export const REST_DIFF_FIELDS: ReadonlySet<string> = new Set([
  'bodyType',
  'disabledDefaultHeaders',
  'protocol',
  'grpc',
  'variable',
]);

export type MergeField = (typeof MERGE_FIELDS)[number];

export const REST = '~rest';

/** Na base, o id do pai do item ('' na raiz) — pra saber quem o moveu. */
export const PARENT_FIELD = '~parent';
/** Na base, os ids dos filhos em ordem (JSON) — pra saber quem reordenou. */
export const ORDER_FIELD = '~order';
/**
 * Na base, o id da collection raiz do item. Permite substituir a base de UMA
 * collection (recordSyncBase com replaceRoots) sem deixar pra trás os itens
 * que deixaram de existir nela.
 */
export const ROOT_FIELD = '~root';

/** Chave do hash de um campo na base. `#` não aparece num id de nó. */
export function fieldHashKey(nodeId: string, field: string): string {
  return `${nodeId}#${field}`;
}

export function fieldValue(item: CollectionItem, field: MergeField): unknown {
  switch (field) {
    case 'name': return item.name;
    case 'method': return item.method;
    case 'url': return item.request?.url;
    case 'headers': return item.request?.headers;
    case 'body': return item.request?.body;
    case 'auth': return item.request?.auth;
    case 'preRequestScript': return item.request?.scripts?.preRequest;
    case 'postResponseScript': return item.request?.scripts?.postResponse;
    case 'example': return item.example;
    case 'description': return item.description;
    case 'markers': return item.markers;
    case 'markerNotes': return item.markerNotes;
    case 'pathParams': return item.request?.urlexport?.variable;
  }
}

/**
 * O conteúdo próprio que NÃO está em MERGE_FIELDS. `urlexport` fica de fora:
 * ele é derivado da URL e viaja junto com ela (ver fieldMergePlan).
 */
export function restOf(item: CollectionItem): unknown {
  const own: Record<string, unknown> = { ...stripStarredFlags(item) };
  for (const key of ['id', 'item', 'name', 'method', 'example', 'description', 'markers', 'markerNotes']) delete own[key];
  if (item.request) {
    const request: Record<string, unknown> = { ...item.request };
    for (const key of ['url', 'urlexport', 'headers', 'body', 'auth', 'scripts']) delete request[key];
    own.request = request;
  }
  return own;
}

/** Hashes por campo de um item, já com as chaves da base. */
export function fieldHashesOf(item: CollectionItem): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of MERGE_FIELDS) out[fieldHashKey(item.id, field)] = hashContent(fieldValue(item, field));
  out[fieldHashKey(item.id, REST)] = hashContent(restOf(item));
  return out;
}

export type FieldOrigin = 'here' | 'github' | 'both' | 'same' | 'unknown';

/**
 * Quem mudou um campo desde a base. `same` = os dois lados mudaram para o
 * MESMO valor (ou nenhum mudou); `unknown` = a base não tem esse campo.
 */
export function fieldOrigin(
  base: Record<string, string> | null,
  nodeId: string,
  field: string,
  localValue: unknown,
  remoteValue: unknown
): FieldOrigin {
  // Embrulhado: ausente e vazio ([] / {}) são o mesmo valor — sem isto um
  // `undefined` contra `[]` (path params, por exemplo) parecia mudança.
  if (sameContent({ v: localValue }, { v: remoteValue })) return 'same';
  const recorded = base?.[fieldHashKey(nodeId, field)];
  if (recorded === undefined) return 'unknown';
  const changedHere = hashContent(localValue) !== recorded;
  const changedThere = hashContent(remoteValue) !== recorded;
  if (changedHere && changedThere) return 'both';
  return changedHere ? 'here' : 'github';
}

/**
 * Plano de merge de um item alterado dos dois lados: a versão do GitHub com
 * estes campos daqui por cima (formato de OverrideMap, ver diffFields).
 * `null` = algum campo mudou dos dois lados (ou a base não sabe dizer) —
 * conflito de verdade.
 */
export function fieldMergePlan(
  local: CollectionItem,
  remote: CollectionItem,
  base: Record<string, string> | null
): Record<string, unknown> | null {
  if (!base) return null;
  base = withLegacyFieldHashes(base, local, remote);
  const nodeId = local.id;

  const rest = fieldOrigin(base, nodeId, REST, restOf(local), restOf(remote));
  if (rest === 'both' || rest === 'here' || rest === 'unknown') return null;

  const overrides: Record<string, unknown> = {};
  const origins: Partial<Record<MergeField, FieldOrigin>> = {};
  for (const field of MERGE_FIELDS) {
    const origin = fieldOrigin(base, nodeId, field, fieldValue(local, field), fieldValue(remote, field));
    if (origin === 'both' || origin === 'unknown') return null;
    origins[field] = origin;
    if (origin !== 'here') continue;
    overrides[field] = fieldValue(local, field);
    // A URL leva junto o urlexport daqui (host/path/variáveis derivados
    // dela) — só o `raw` deixaria o resto apontando pra URL do GitHub.
    if (field === 'url' && local.request?.urlexport) overrides.urlexport = local.request.urlexport;
  }
  // A URL daqui leva o urlexport daqui inteiro — com os path params daqui.
  // Se foi o GitHub que mudou os path params, levá-los apagaria a mudança
  // dele: é conflito (os dois mexeram no endereço da request).
  if (origins.url === 'here' && origins.pathParams === 'github') return null;
  return overrides;
}

// ─── Base gravada antes de um campo existir ──────────────────────────────
//
// `pathParams` virou campo depois: a base gravada antes dele não tem
// `id#pathParams`, e na primeira sincronização depois da atualização todo
// item mudado dos dois lados com path params diferentes caía na revisão
// (`unknown`), mesmo quando só um lado tinha mexido neles.
//
// A base dessa época tem o hash do NÓ inteiro, que inclui os path params.
// Dá pra reconstruir o item da base campo a campo — cada campo vem do lado
// cujo valor tem o hash que a base registrou (o lado que não mexeu nele) —
// e ver qual dos dois valores de path params reproduz o hash do nó. Só vale
// com o hash batendo exato; senão o campo continua `unknown` (revisão).

/** Hash do conteúdo próprio do nó — o mesmo de syncBase.nodeHashes. */
function ownContentHash(item: CollectionItem): string {
  const own: Record<string, unknown> = { ...stripStarredFlags(item) };
  delete own.item;
  return hashContent(own);
}

type Writable = Record<string, unknown>;

function setOrDelete(target: Writable, key: string, value: unknown) {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function setFieldValue(item: CollectionItem, field: MergeField, value: unknown, from: CollectionItem) {
  const top = item as unknown as Writable;
  const request = () => {
    if (!top.request) top.request = {};
    return top.request as Writable;
  };
  switch (field) {
    case 'name':
    case 'method':
    case 'example':
    case 'description':
    case 'markers':
    case 'markerNotes':
      setOrDelete(top, field, value);
      return;
    case 'url':
      setOrDelete(request(), 'url', value);
      // O urlexport é derivado da URL e viaja com ela (ver fieldMergePlan);
      // os path params dele são decididos à parte, abaixo.
      setOrDelete(request(), 'urlexport', structuredClone(from.request?.urlexport));
      return;
    case 'headers':
    case 'body':
    case 'auth':
      setOrDelete(request(), field, value);
      return;
    case 'preRequestScript':
    case 'postResponseScript': {
      const key = field === 'preRequestScript' ? 'preRequest' : 'postResponse';
      const req = request();
      if (!req.scripts) req.scripts = {};
      setOrDelete(req.scripts as Writable, key, value);
      return;
    }
    case 'pathParams': {
      const req = request();
      if (!req.urlexport) {
        if (value === undefined) return;
        req.urlexport = {};
      }
      setOrDelete(req.urlexport as Writable, 'variable', value);
      return;
    }
  }
}

/**
 * O hash de `id#pathParams` que a base teria, deduzido do hash do nó — ou
 * `undefined` quando não dá pra saber.
 */
export function inferLegacyPathParamsHash(
  base: Record<string, string>,
  local: CollectionItem,
  remote: CollectionItem
): string | undefined {
  const nodeId = local.id;
  const nodeHash = base[nodeId];
  if (nodeHash === undefined) return undefined;

  // O item da base começa do lado cujo "resto" é o da base.
  const restRecorded = base[fieldHashKey(nodeId, REST)];
  if (restRecorded === undefined) return undefined;
  const start =
    hashContent(restOf(remote)) === restRecorded ? remote : hashContent(restOf(local)) === restRecorded ? local : null;
  if (!start) return undefined;
  const other = start === remote ? local : remote;
  const rebuilt = structuredClone(start);

  for (const field of MERGE_FIELDS) {
    if (field === 'pathParams') continue;
    const recorded = base[fieldHashKey(nodeId, field)];
    if (recorded === undefined) return undefined;
    if (hashContent(fieldValue(start, field)) === recorded) continue;
    if (hashContent(fieldValue(other, field)) !== recorded) return undefined; // mudou dos dois lados
    setFieldValue(rebuilt, field, structuredClone(fieldValue(other, field)), other);
  }

  for (const candidate of [fieldValue(remote, 'pathParams'), fieldValue(local, 'pathParams')]) {
    setFieldValue(rebuilt, 'pathParams', structuredClone(candidate), rebuilt);
    if (ownContentHash(rebuilt) === nodeHash) return hashContent(candidate);
  }
  return undefined;
}

/**
 * A base com os hashes de campo que faltam deduzidos para ESTE item (ver
 * acima). Sem nada a deduzir, devolve a própria base.
 */
export function withLegacyFieldHashes<B extends Record<string, string> | null>(
  base: B,
  local: CollectionItem,
  remote: CollectionItem
): B {
  if (!base || !local?.id || local.id !== remote?.id) return base;
  const key = fieldHashKey(local.id, 'pathParams');
  if (base[key] !== undefined) return base;
  const inferred = inferLegacyPathParamsHash(base, local, remote);
  return inferred === undefined ? base : ({ ...base, [key]: inferred } as B);
}
