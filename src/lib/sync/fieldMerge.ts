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
] as const;

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
  if (sameContent(localValue, remoteValue)) return 'same';
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
  const nodeId = local.id;

  const rest = fieldOrigin(base, nodeId, REST, restOf(local), restOf(remote));
  if (rest === 'both' || rest === 'here' || rest === 'unknown') return null;

  const overrides: Record<string, unknown> = {};
  for (const field of MERGE_FIELDS) {
    const origin = fieldOrigin(base, nodeId, field, fieldValue(local, field), fieldValue(remote, field));
    if (origin === 'both' || origin === 'unknown') return null;
    if (origin !== 'here') continue;
    overrides[field] = fieldValue(local, field);
    // A URL leva junto o urlexport daqui (host/path/variáveis derivados
    // dela) — só o `raw` deixaria o resto apontando pra URL do GitHub.
    if (field === 'url' && local.request?.urlexport) overrides.urlexport = local.request.urlexport;
  }
  return overrides;
}
