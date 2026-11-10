import type { CollectionItem } from '@/app/types/CollectionItem';
import type { DiffNode } from '@/lib/collectionDiff';
import { sameContent } from '@/lib/canonicalCompare';
import { classifyNode, type NodeOrigin } from '@/lib/diffOrigin';
import type { NodeHashes } from '@/lib/syncBase';
import { diffableText, lcsTable, MAX_CELLS } from '@/lib/textDiff';
import { fieldOrigin, fieldValue, MERGE_FIELDS, REST, restOf, type FieldOrigin, type MergeField } from './fieldMerge';
import { orderDecision } from './rebase';

// ─────────────────────────────────────────────────────────────────────────
// "Auto merge" da tela de revisão: resolve sozinho tudo o que dá pra
// resolver sem adivinhar, e deixa pra pessoa só o conflito de verdade.
//
//   mudou só lá                → GitHub;
//   mudou só aqui              → Mine;
//   mudou dos dois lados       → campo a campo (fieldOrigin): cada campo fica
//                                com o lado que mexeu nele;
//   o MESMO campo dos dois     → merge de três vias contra a última
//                                sincronização: no body e nos scripts, linha
//                                a linha (mergeText); nos marcadores, como
//                                conjunto. Só é conflito se as mudanças caem
//                                nas mesmas linhas (ou em linhas vizinhas,
//                                como no git).
//
// É a mesma régua do merge automático do push (rebase/fieldMerge), com um
// passo a mais: aqui a tela tem a versão da última sincronização (lida do
// GitHub), e com ela dá pra combinar duas mudanças no mesmo body.
//
// Função pura: nada é aplicado aqui. A tela traduz o resultado em seleção
// e caixas de "Merge", e nada sai sem o mesmo botão de confirmar de sempre.
// ─────────────────────────────────────────────────────────────────────────

// ─── Merge de texto, linha a linha (diff3) ────────────────────────────────

export type TextMerge = { ok: true; text: string } | { ok: false };

/** Para cada linha de `a`, a linha de `b` com que ela casa na LCS (ou -1). */
export function matchLines(a: string[], b: string[]): Int32Array | null {
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) return null;
  const cols = b.length + 1;
  const table = lcsTable(a, b);
  const out = new Int32Array(a.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out[i] = j;
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i++;
    else j++;
  }
  return out;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

/** Um trecho entre dois pontos estáveis: vale o lado que mexeu nele. */
function resolveChunk(base: string[], mine: string[], theirs: string[]): string[] | null {
  if (sameLines(mine, base)) return theirs;
  if (sameLines(theirs, base)) return mine;
  if (sameLines(mine, theirs)) return mine;
  return null;
}

/**
 * Merge de três vias por linha. Junta as duas versões quando as mudanças de
 * cada lado caem em trechos diferentes do texto da base; `ok: false` quando
 * os dois mexeram no mesmo trecho de jeitos diferentes.
 *
 * CRLF ≡ LF (como no canonicalCompare): o resultado sai com a quebra de
 * linha da versão daqui.
 */
export function mergeText(base: string, mine: string, theirs: string): TextMerge {
  const crlf = mine.includes('\r\n');
  const lf = (text: string) => text.replace(/\r\n/g, '\n');
  const done = (text: string): TextMerge => ({ ok: true, text: crlf ? text.replace(/\n/g, '\r\n') : text });
  const [o, a, b] = [lf(base), lf(mine), lf(theirs)];

  if (a === b || b === o) return done(a);
  if (a === o) return done(b);

  const O = o.split('\n');
  const A = a.split('\n');
  const B = b.split('\n');
  const toMine = matchLines(O, A);
  const toTheirs = matchLines(O, B);
  if (!toMine || !toTheirs) return { ok: false };

  const out: string[] = [];
  let i = 0;
  let x = 0;
  let y = 0;
  for (;;) {
    // Próximo ponto estável: linha da base que os dois lados mantiveram.
    let k = i;
    while (k < O.length && (toMine[k] < 0 || toTheirs[k] < 0)) k++;
    const xEnd = k < O.length ? toMine[k] : A.length;
    const yEnd = k < O.length ? toTheirs[k] : B.length;
    const chunk = resolveChunk(O.slice(i, k), A.slice(x, xEnd), B.slice(y, yEnd));
    if (!chunk) return { ok: false };
    out.push(...chunk);
    if (k >= O.length) break;
    out.push(O[k]);
    i = k + 1;
    x = xEnd + 1;
    y = yEnd + 1;
  }
  return done(out.join('\n'));
}

// ─── Merge de um campo mudado dos dois lados ──────────────────────────────

/** Campos de texto livre: mesclados linha a linha. */
export const TEXT_MERGE_FIELDS: ReadonlySet<string> = new Set(['body', 'preRequestScript', 'postResponseScript', 'description']);

/**
 * Campos estruturados: mesclados linha a linha sobre o JSON formatado, com as
 * chaves em ordem fixa — e só valem se o resultado ainda for JSON válido.
 */
const JSON_MERGE_FIELDS: ReadonlySet<string> = new Set(['headers', 'auth', 'example']);

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, sortedKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

const jsonText = (value: unknown) => (value === undefined || value === null ? '' : JSON.stringify(sortedKeys(value), null, 2));

const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

const notesOf = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};

/** Marcadores como conjunto: o que cada lado pôs ou tirou desde a base. */
function mergeMarkerIds(base: unknown, mine: unknown, theirs: unknown): string[] {
  const o = new Set(idsOf(base));
  const a = idsOf(mine);
  const b = idsOf(theirs);
  const removed = new Set([...o].filter(id => !a.includes(id) || !b.includes(id)));
  const out = b.filter(id => !removed.has(id));
  for (const id of a) if (!o.has(id) && !out.includes(id)) out.push(id);
  return out;
}

/** Notas por marcador: conflito só se os dois mexeram na nota do MESMO marcador. */
function mergeMarkerNotes(base: unknown, mine: unknown, theirs: unknown): Record<string, string> | null {
  const o = notesOf(base);
  const a = notesOf(mine);
  const b = notesOf(theirs);
  const out: Record<string, string> = {};
  for (const key of new Set([...Object.keys(o), ...Object.keys(a), ...Object.keys(b)])) {
    const pick = resolveValue(o[key], a[key], b[key]);
    if (pick === CONFLICT) return null;
    if (pick !== undefined) out[key] = pick;
  }
  return out;
}

const CONFLICT = Symbol('conflict');

function resolveValue<T>(base: T, mine: T, theirs: T): T | typeof CONFLICT {
  if (sameContent(mine, theirs) || sameContent(theirs, base)) return mine;
  if (sameContent(mine, base)) return theirs;
  return CONFLICT;
}

export type FieldMerge = { ok: true; value: unknown } | { ok: false };

/**
 * Combina as duas mudanças num campo que mudou dos dois lados, contra o valor
 * da última sincronização. Nome, método e URL são um valor só: dos dois lados,
 * é conflito.
 */
export function mergeFieldValues(field: string, base: unknown, mine: unknown, theirs: unknown): FieldMerge {
  if (TEXT_MERGE_FIELDS.has(field)) {
    const merged = mergeText(diffableText(base), diffableText(mine), diffableText(theirs));
    return merged.ok ? { ok: true, value: merged.text } : { ok: false };
  }
  if (JSON_MERGE_FIELDS.has(field)) {
    const merged = mergeText(jsonText(base), jsonText(mine), jsonText(theirs));
    if (!merged.ok) return { ok: false };
    if (merged.text.trim() === '') return { ok: true, value: undefined };
    try {
      return { ok: true, value: JSON.parse(merged.text) };
    } catch {
      return { ok: false };
    }
  }
  if (field === 'markers') return { ok: true, value: mergeMarkerIds(base, mine, theirs) };
  if (field === 'markerNotes') {
    const notes = mergeMarkerNotes(base, mine, theirs);
    return notes ? { ok: true, value: notes } : { ok: false };
  }
  return { ok: false };
}

// ─── Um item ──────────────────────────────────────────────────────────────

export type NodeResolution =
  /** Aceitar a versão do GitHub (só lá mudou). */
  | { kind: 'github' }
  /** Manter a sua (só aqui mudou). */
  | { kind: 'mine' }
  /**
   * A versão do GitHub com estes campos por cima (formato de OverrideMap).
   * `mine` = campos que só você mudou; `combined` = campos mudados dos dois
   * lados e juntados (linha a linha no body).
   */
  | { kind: 'merged'; overrides: Record<string, unknown>; mine: string[]; combined: string[] }
  /** Precisa de decisão. `fields` = os campos em conflito (vazio = o item inteiro). */
  | { kind: 'conflict'; fields: string[] };

export interface AutoMergeContext {
  /** O que fica em Mine por padrão (diffSelection.conflictingIds e extras). */
  conflicts: ReadonlySet<string>;
  /** Hashes da última sincronização (lib/syncBase). */
  base: NodeHashes | null;
  /**
   * O item como estava na última sincronização. `undefined` = não dá pra
   * saber (sem a versão da base); `null` = o item ainda não existia.
   */
  baseItemOf?: (node: DiffNode) => CollectionItem | null | undefined;
}

export type BaseValue = { value: unknown } | undefined;

/** fieldOrigin pela base de hashes; sem ela, pelo conteúdo da última sincronização (`baseValue`). */
export function originOf(
  base: NodeHashes | null,
  nodeId: string,
  field: string,
  local: unknown,
  remote: unknown,
  baseValue: BaseValue
): FieldOrigin {
  const byHash = fieldOrigin(base, nodeId, field, local, remote);
  if (byHash !== 'unknown' || !baseValue) return byHash;
  const here = !sameContent(local, baseValue.value);
  const there = !sameContent(remote, baseValue.value);
  return here && there ? 'both' : here ? 'here' : there ? 'github' : 'same';
}

export function resolveNode(node: DiffNode, ctx: AutoMergeContext, origin?: NodeOrigin): NodeResolution {
  if (!ctx.conflicts.has(node.id)) return { kind: 'github' };
  const nodeOrigin = origin ?? classifyNode(node, ctx.base).origin;
  if (nodeOrigin === 'here') return { kind: 'mine' };
  // Apagado de um lado e mudado do outro (ou sem base pra saber): só a
  // pessoa sabe se o item ainda deve existir.
  if (node.change !== 'modified' || !node.local || !node.remote) return { kind: 'conflict', fields: [] };

  const baseItem = ctx.baseItemOf?.(node);
  const baseOf = (read: (item: CollectionItem) => unknown): BaseValue =>
    baseItem ? { value: read(baseItem) } : undefined;

  const overrides: Record<string, unknown> = {};
  const mine: string[] = [];
  const combined: string[] = [];
  const conflicts: string[] = [];
  let fromGithub = false;
  let orderMine = false;

  for (const diff of node.fields) {
    const field = diff.field;
    if (field === 'order') {
      const decision = orderDecision(ctx.base, node.id, node.local.item, node.remote.item);
      if (decision === 'remote') fromGithub = true;
      else if (decision === 'local') orderMine = true;
      else conflicts.push(field);
      continue;
    }
    if (!(MERGE_FIELDS as readonly string[]).includes(field)) {
      conflicts.push(field);
      continue;
    }
    const baseValue = baseOf(item => fieldValue(item, field as MergeField));
    switch (originOf(ctx.base, node.id, field, diff.local, diff.remote, baseValue)) {
      case 'same':
        break;
      case 'github':
        fromGithub = true;
        break;
      case 'here':
        overrides[field] = diff.local;
        mine.push(field);
        // A URL leva junto o urlexport daqui (ver fieldMergePlan).
        if (field === 'url' && node.local.request?.urlexport) overrides.urlexport = node.local.request.urlexport;
        break;
      case 'both': {
        const merged = baseValue ? mergeFieldValues(field, baseValue.value, diff.local, diff.remote) : ({ ok: false } as FieldMerge);
        if (!merged.ok) {
          conflicts.push(field);
          break;
        }
        overrides[field] = merged.value;
        combined.push(field);
        fromGithub = true;
        break;
      }
      default:
        conflicts.push(field);
    }
  }

  // O resto do conteúdo (tipo de body, gRPC, headers desligados…) não tem
  // caixa na tela: só dá pra levar um lado inteiro dele.
  const rest = originOf(ctx.base, node.id, REST, restOf(node.local), restOf(node.remote), baseOf(restOf));
  if (rest === 'github') fromGithub = true;
  else if (rest === 'both' || rest === 'unknown') conflicts.push(REST);

  if (conflicts.length > 0) return { kind: 'conflict', fields: conflicts };
  // Tudo o que mudou é seu: a sua versão inteira já é o resultado.
  if (!fromGithub) return { kind: 'mine' };
  // Do GitHub há algo a levar, mas a sua ordem dos filhos (ou o resto do
  // conteúdo) só vem com a sua versão inteira — não dá pra ter os dois.
  if (orderMine) return { kind: 'conflict', fields: ['order'] };
  if (rest === 'here') return { kind: 'conflict', fields: [REST] };
  if (Object.keys(overrides).length === 0) return { kind: 'github' };
  return { kind: 'merged', overrides, mine, combined };
}

// ─── A lista inteira ──────────────────────────────────────────────────────

export interface AutoMergeSummary {
  /** Itens que ficam com a versão do GitHub. */
  github: number;
  /** Itens que ficam com a sua. */
  mine: number;
  /** Itens mudados dos dois lados e juntados. */
  merged: number;
  /** Desses, quantos juntaram o mesmo campo (linha a linha no body). */
  combined: number;
  /** Ids que ainda pedem decisão. */
  conflicts: string[];
}

export interface AutoMergeResult {
  resolutions: Map<string, NodeResolution>;
  summary: AutoMergeSummary;
}

export function autoMerge(nodes: DiffNode[], ctx: AutoMergeContext): AutoMergeResult {
  const resolutions = new Map<string, NodeResolution>();
  const summary: AutoMergeSummary = { github: 0, mine: 0, merged: 0, combined: 0, conflicts: [] };
  for (const node of nodes) {
    const resolution = resolveNode(node, ctx);
    resolutions.set(node.id, resolution);
    if (resolution.kind === 'github') summary.github++;
    else if (resolution.kind === 'mine') summary.mine++;
    else if (resolution.kind === 'merged') {
      summary.merged++;
      if (resolution.combined.length > 0) summary.combined++;
    } else summary.conflicts.push(node.id);
  }
  return { resolutions, summary };
}

/**
 * A seleção da tela depois do auto merge: GitHub e Merge marcados, Mine
 * desmarcado. Conflito fica como estava — é a pessoa quem decide.
 */
export function selectionAfter(selected: ReadonlySet<string>, resolutions: ReadonlyMap<string, NodeResolution>): Set<string> {
  const next = new Set(selected);
  for (const [id, resolution] of resolutions) {
    if (resolution.kind === 'github' || resolution.kind === 'merged') next.add(id);
    else if (resolution.kind === 'mine') next.delete(id);
  }
  return next;
}

// ─── O botão "Merge" de um item ───────────────────────────────────────────

export interface MergePrefill {
  /** Campos a pôr por cima da versão do GitHub (formato de OverrideMap). */
  overrides: Record<string, unknown>;
  /** Campos mudados dos dois lados e juntados (linha a linha no body). */
  combined: string[];
  /** Campos mudados dos dois lados que não deu pra juntar: ficam com o GitHub e pedem revisão. */
  conflicts: string[];
}

/**
 * Ponto de partida do "Merge" à mão: a versão do GitHub com os campos que só
 * você mudou por cima, e os mudados dos dois lados já juntados quando dá.
 * Antes, um body mudado dos dois lados começava igual ao do GitHub, e quem
 * confirmava sem editar perdia a própria mudança sem aviso.
 *
 * `baseItem`: o item na última sincronização (`undefined` = sem como saber;
 * `null` = não existia).
 */
export function mergePrefill(
  node: DiffNode,
  base: NodeHashes | null,
  baseItem: CollectionItem | null | undefined
): MergePrefill {
  const out: MergePrefill = { overrides: {}, combined: [], conflicts: [] };
  if (node.change !== 'modified' || !node.local) return out;
  for (const diff of node.fields) {
    const field = diff.field;
    if (!(MERGE_FIELDS as readonly string[]).includes(field)) continue;
    const baseValue: BaseValue = baseItem ? { value: fieldValue(baseItem, field as MergeField) } : undefined;
    const origin = originOf(base, node.id, field, diff.local, diff.remote, baseValue);
    if (origin === 'here') {
      out.overrides[field] = diff.local;
      if (field === 'url' && node.local.request?.urlexport) out.overrides.urlexport = node.local.request.urlexport;
    } else if (origin === 'both' || origin === 'unknown') {
      const merged = origin === 'both' && baseValue ? mergeFieldValues(field, baseValue.value, diff.local, diff.remote) : null;
      if (merged?.ok) {
        out.overrides[field] = merged.value;
        out.combined.push(field);
      } else {
        out.conflicts.push(field);
      }
    }
  }
  return out;
}
