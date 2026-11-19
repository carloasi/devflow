import { hashText } from '@/lib/contentHash';

// ─────────────────────────────────────────────────────────────────────────
// Resultado de merge editado à mão na janela de diferença (prévia), à
// espera da revisão que vai aplicá-lo.
//
// A prévia (aviso de mudança no GitHub, Central de Sincronização) não aplica
// nada: quem aplica é a revisão do merge (SyncDiffDialog), aberta pelo
// "Resolver". Editar o resultado na prévia guarda o texto aqui, por
// workspace, item e campo; a revisão, ao abrir, pega o que for dos itens dela
// e usa como rascunho daquele campo — o mesmo que digitar lá.
//
// Cada edição leva o CARIMBO das duas versões sobre as quais foi feita (a
// daqui e a do GitHub). Se uma delas mudou até a revisão abrir (o colega
// enviou de novo, você editou o item), a edição é descartada: aplicada, ela
// desfaria em silêncio o que mudou depois.
//
// Só sai daqui quando a revisão é APLICADA (clearPreparedEdits): abrir e
// fechar a revisão sem aplicar não perde a edição.
//
// O texto guardado é o REAL (sem máscara de segredo, sem corte): é o que vai
// ser salvo. Fica só em memória, nunca em storage, e vence depois de um tempo.
// ─────────────────────────────────────────────────────────────────────────

export interface PreparedMergeEdit {
  itemId: string;
  field: string;
  text: string;
}

interface StoredEdit extends PreparedMergeEdit {
  /** Workspace da prévia. Ausente = não se sabia (vale o carimbo). */
  workspace?: string;
  /** preparedEditStamp das versões daqui e do GitHub quando foi editada. */
  stamp?: string;
  at: number;
}

export const PREPARED_EDIT_TTL_MS = 30 * 60_000;

const edits = new Map<string, StoredEdit>();
const keyOf = (workspace: string | undefined, itemId: string, field: string) =>
  `${workspace ?? ''}\u0000${itemId}\u0000${field}`;
const lf = (text: string) => text.replace(/\r\n/g, '\n');

/** Carimbo das duas versões de um campo (a daqui e a do GitHub), como texto. */
export function preparedEditStamp(local: string, remote: string): string {
  return hashText(`${lf(local)}\u0000${lf(remote)}`);
}

export interface PreparedEditScope {
  workspace?: string;
  stamp?: string;
}

/** Guarda (ou, com `undefined`, descarta) a edição de um campo. */
export function setPreparedEdit(
  itemId: string,
  field: string,
  text: string | undefined,
  scope: PreparedEditScope = {},
  now: number = Date.now()
): void {
  const key = keyOf(scope.workspace, itemId, field);
  if (text === undefined) edits.delete(key);
  else edits.set(key, { itemId, field, text, workspace: scope.workspace, stamp: scope.stamp, at: now });
}

/**
 * A edição guardada de um campo, se ainda vale — pra a prévia reabrir com
 * ela. Com `stamp`, só se foi feita sobre as mesmas versões.
 */
export function getPreparedEdit(
  itemId: string,
  field: string,
  scope: PreparedEditScope = {},
  now: number = Date.now()
): string | undefined {
  const key = keyOf(scope.workspace, itemId, field);
  const edit = edits.get(key);
  if (!edit) return undefined;
  if (now - edit.at > PREPARED_EDIT_TTL_MS) {
    edits.delete(key);
    return undefined;
  }
  if (scope.stamp !== undefined && edit.stamp !== undefined && edit.stamp !== scope.stamp) return undefined;
  return edit.text;
}

/**
 * As edições que valem pra uma revisão, SEM tirá-las daqui (quem tira é
 * clearPreparedEdits, ao aplicar). `stampOf` dá o carimbo atual do campo na
 * revisão — `undefined` quando o item/campo não está nela. Edição de outro
 * workspace fica; edição feita sobre outra versão sai (já não vale).
 */
export function preparedEditsFor(
  workspace: string | undefined,
  stampOf: (itemId: string, field: string) => string | undefined,
  now: number = Date.now()
): PreparedMergeEdit[] {
  const out: PreparedMergeEdit[] = [];
  for (const [key, edit] of edits) {
    if (now - edit.at > PREPARED_EDIT_TTL_MS) {
      edits.delete(key);
      continue;
    }
    if (edit.workspace !== undefined && workspace !== undefined && edit.workspace !== workspace) continue;
    const current = stampOf(edit.itemId, edit.field);
    if (current === undefined) continue;
    if (edit.stamp !== undefined && edit.stamp !== current) {
      edits.delete(key);
      continue;
    }
    out.push({ itemId: edit.itemId, field: edit.field, text: edit.text });
  }
  return out;
}

/** A revisão foi aplicada: as edições destes itens já entraram (ou foram trocadas). */
export function clearPreparedEdits(workspace: string | undefined, itemIds: Iterable<string>): void {
  const ids = new Set(itemIds);
  for (const [key, edit] of edits) {
    if (!ids.has(edit.itemId)) continue;
    if (edit.workspace !== undefined && workspace !== undefined && edit.workspace !== workspace) continue;
    edits.delete(key);
  }
}

/**
 * Rascunhos da revisão a partir das edições guardadas, por item. Em "Minha"
 * (o item ainda não foi aceito do GitHub), os outros campos editáveis começam
 * com o valor daqui — a mesma regra de editar um campo na própria revisão:
 * só o campo mexido muda, o resto continua seu.
 */
export function draftsFromPreparedEdits(
  edits: PreparedMergeEdit[],
  nodeOf: (itemId: string) => { fields: { field: string; local: unknown }[] } | undefined,
  options: {
    isEditable: (field: string) => boolean;
    format: (field: string, value: unknown) => string;
    /** O item está em "Minha" (não marcado pra vir do GitHub)? */
    inMine: (itemId: string) => boolean;
    /** Em "Minha", dá pra virar mescla sem perder nada daqui? */
    canEditFromMine: (itemId: string) => boolean;
  }
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const edit of edits) {
    const node = nodeOf(edit.itemId);
    if (!node || !options.isEditable(edit.field)) continue;
    if (!node.fields.some(f => f.field === edit.field)) continue;
    if (!out[edit.itemId]) {
      if (options.inMine(edit.itemId)) {
        if (!options.canEditFromMine(edit.itemId)) continue;
        const seed: Record<string, string> = {};
        for (const f of node.fields) if (options.isEditable(f.field)) seed[f.field] = options.format(f.field, f.local);
        out[edit.itemId] = seed;
      } else {
        out[edit.itemId] = {};
      }
    }
    out[edit.itemId][edit.field] = edit.text;
  }
  return out;
}
