// ─────────────────────────────────────────────────────────────────────────
// Resultado de merge editado à mão na janela de diferença (prévia), à
// espera da revisão que vai aplicá-lo.
//
// A prévia (aviso de mudança no GitHub, Central de Sincronização) não aplica
// nada: quem aplica é a revisão do merge (SyncDiffDialog), aberta pelo
// "Resolver". Editar o resultado na prévia guarda o texto aqui, por item e
// campo; a revisão, ao abrir, pega o que for dos itens dela e usa como
// rascunho daquele campo — o mesmo que digitar lá.
//
// O texto guardado é o REAL (sem máscara de segredo, sem corte): é o que vai
// ser salvo. Fica só em memória, nunca em storage.
//
// Vence depois de um tempo: uma edição esquecida não pode reaparecer numa
// revisão aberta dias depois, sobre uma versão que já é outra.
// ─────────────────────────────────────────────────────────────────────────

export interface PreparedMergeEdit {
  itemId: string;
  field: string;
  text: string;
}

export const PREPARED_EDIT_TTL_MS = 30 * 60_000;

const edits = new Map<string, PreparedMergeEdit & { at: number }>();
const keyOf = (itemId: string, field: string) => `${itemId}\u0000${field}`;

/** Guarda (ou, com `undefined`, descarta) a edição de um campo. */
export function setPreparedEdit(itemId: string, field: string, text: string | undefined, now: number = Date.now()): void {
  const key = keyOf(itemId, field);
  if (text === undefined) edits.delete(key);
  else edits.set(key, { itemId, field, text, at: now });
}

/** A edição guardada de um campo, se ainda vale — pra a prévia reabrir com ela. */
export function getPreparedEdit(itemId: string, field: string, now: number = Date.now()): string | undefined {
  const key = keyOf(itemId, field);
  const edit = edits.get(key);
  if (!edit) return undefined;
  if (now - edit.at > PREPARED_EDIT_TTL_MS) {
    edits.delete(key);
    return undefined;
  }
  return edit.text;
}

/**
 * Entrega e remove as edições dos itens que a revisão tem. As de outros itens
 * ficam (podem ser de outra revisão); as vencidas saem.
 */
export function takePreparedEdits(hasItem: (itemId: string) => boolean, now: number = Date.now()): PreparedMergeEdit[] {
  const out: PreparedMergeEdit[] = [];
  for (const [key, edit] of edits) {
    if (now - edit.at > PREPARED_EDIT_TTL_MS) {
      edits.delete(key);
      continue;
    }
    if (!hasItem(edit.itemId)) continue;
    edits.delete(key);
    out.push({ itemId: edit.itemId, field: edit.field, text: edit.text });
  }
  return out;
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
