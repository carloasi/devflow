import type { CollectionItem } from '@/app/types/CollectionItem';
import { sameContent } from '@/lib/canonicalCompare';
import { applyOverrides } from '@/lib/diffFields';
import { fieldValue, MERGE_FIELDS, REST, restOf, type MergeField } from './fieldMerge';

// ─────────────────────────────────────────────────────────────────────────
// Salvar uma aba cuja request mudou num sync ENQUANTO ela tinha edição.
//
// A aba fica com a versão de antes do sync (não dá pra recarregá-la sem
// perder a edição). Salvar gravava a request inteira da aba por cima da que
// acabou de chegar: a mudança do colega sumia daqui, e o push seguinte a
// apagava do GitHub sem conflito — parecia mudança só sua.
//
// Aqui é um merge de três vias, campo a campo, com a base = a request como
// estava quando a aba foi aberta (antes do sync):
//
//   só a aba mudou o campo     → fica o da aba;
//   só o sync mudou            → fica o que chegou;
//   os dois, de jeitos diferentes → conflito (quem chama pergunta).
//
// O "resto" do conteúdo (tipo de body, gRPC, headers padrão desligados…)
// vai inteiro de um lado, como no merge do push (fieldMerge).
// ─────────────────────────────────────────────────────────────────────────

export type TabSaveMerge =
  | { ok: true; item: CollectionItem; incoming: string[] }
  | { ok: false; conflicts: string[] };

const same = (a: unknown, b: unknown) => sameContent({ v: a }, { v: b });

/**
 * `base`: a request quando a aba foi aberta. `mineBase`: essa mesma base
 * passada pela aba sem edição nenhuma (a conversão aba → request normaliza
 * campos; comparar com ela evita acusar como "seu" o que você não mexeu).
 * `mine`: a aba aplicada sobre a base. `theirs`: a request como está agora.
 */
export function mergeTabSave(input: {
  base: CollectionItem;
  mineBase: CollectionItem;
  mine: CollectionItem;
  theirs: CollectionItem;
}): TabSaveMerge {
  const { base, mineBase, mine, theirs } = input;
  const mineFields: MergeField[] = [];
  const theirFields: MergeField[] = [];
  const conflicts: string[] = [];

  for (const field of MERGE_FIELDS) {
    const m = fieldValue(mine, field);
    const r = fieldValue(theirs, field);
    const changedMine = !same(m, fieldValue(mineBase, field));
    const changedTheirs = !same(r, fieldValue(base, field));
    if (changedMine && changedTheirs && !same(m, r)) conflicts.push(field);
    else if (changedMine) mineFields.push(field);
    else if (changedTheirs) theirFields.push(field);
  }

  const restMine = !same(restOf(mine), restOf(mineBase));
  const restTheirs = !same(restOf(theirs), restOf(base));
  if (restMine && restTheirs && !same(restOf(mine), restOf(theirs))) conflicts.push(REST);

  // A URL leva o urlexport inteiro (com os path params) do lado dela: com os
  // path params mudados do OUTRO lado, é conflito (ver fieldMergePlan).
  if (mineFields.includes('url') && theirFields.includes('pathParams')) conflicts.push('pathParams');
  if (theirFields.includes('url') && mineFields.includes('pathParams')) conflicts.push('pathParams');

  if (conflicts.length > 0) return { ok: false, conflicts };

  // Parte da versão cujo "resto" vale e traz por cima os campos do outro.
  const fromMine = restMine;
  const start: CollectionItem = fromMine ? { ...mine } : { ...theirs };
  const source = fromMine ? theirs : mine;
  const fields = fromMine ? theirFields : mineFields;
  const overrides: Record<string, unknown> = {};
  for (const field of fields) {
    overrides[field] = fieldValue(source, field);
    if (field === 'url' && source.request?.urlexport) overrides.urlexport = source.request.urlexport;
  }
  const merged = applyOverrides(start, overrides);

  // O que fica embaixo da request (examples) e as marcas locais são os de
  // agora, nunca os da base.
  const item: CollectionItem = { ...merged, id: theirs.id };
  if (theirs.item) item.item = theirs.item;
  else delete item.item;
  if (theirs.starred !== undefined) item.starred = theirs.starred;
  else delete item.starred;
  if (theirs.starredAfterId !== undefined) item.starredAfterId = theirs.starredAfterId;
  else delete item.starredAfterId;

  return { ok: true, item, incoming: theirFields };
}
