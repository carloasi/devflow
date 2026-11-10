import { matchLines } from './autoMerge';

// ─────────────────────────────────────────────────────────────────────────
// Trechos do editor de merge de três painéis (o layout do merge do Visual
// Studio): GitHub e a sua versão lado a lado, cada trecho alterado com uma
// caixinha, e o resultado embaixo.
//
// O texto é cortado nos pontos que os três lados (base, aqui e GitHub)
// mantiveram — a mesma conta do mergeText (diff3). Entre dois pontos fica um
// trecho, com quem o mudou:
//
//   theirs   → só o GitHub mudou     (começa marcado do lado do GitHub)
//   mine     → só você mudou          (começa marcado do seu lado)
//   same     → os dois, igual         (tanto faz o lado)
//   conflict → os dois, diferente     (começa sem marca: a pessoa decide)
//
// Sem a versão da última sincronização (base null), não dá pra saber quem
// mudou: toda diferença vira `conflict`.
//
// Funções puras: a tela guarda só as marcas; o texto sai daqui.
// ─────────────────────────────────────────────────────────────────────────

export type ChunkKind = 'stable' | 'theirs' | 'mine' | 'same' | 'conflict';

export interface MergeChunk {
  kind: ChunkKind;
  /** Linhas na base (vazio sem base, num merge de duas vias). */
  base: string[];
  mine: string[];
  theirs: string[];
}

/** O que entra no resultado, por trecho. Os dois = os dois, o do GitHub primeiro. */
export interface ChunkPick {
  theirs: boolean;
  mine: boolean;
}

const lf = (text: string) => text.replace(/\r\n/g, '\n');
const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

/** Trechos de um merge. `null` quando o texto é grande demais pra comparar linha a linha. */
export function mergeChunks(base: string | null, mine: string, theirs: string): MergeChunk[] | null {
  const A = lf(mine).split('\n');
  const B = lf(theirs).split('\n');
  const out: MergeChunk[] = [];
  const stable = (line: string) => out.push({ kind: 'stable', base: [line], mine: [line], theirs: [line] });

  if (base === null) {
    // Duas vias: o que casa entre os dois lados fica; o resto é decisão.
    const toTheirs = matchLines(A, B);
    if (!toTheirs) return null;
    let y = 0;
    let x = 0;
    for (;;) {
      let k = x;
      while (k < A.length && toTheirs[k] < 0) k++;
      const yEnd = k < A.length ? toTheirs[k] : B.length;
      const a = A.slice(x, k);
      const b = B.slice(y, yEnd);
      if (a.length || b.length) out.push({ kind: sameLines(a, b) ? 'same' : 'conflict', base: [], mine: a, theirs: b });
      if (k >= A.length) break;
      stable(A[k]);
      x = k + 1;
      y = yEnd + 1;
    }
    return out;
  }

  const O = lf(base).split('\n');
  const toMine = matchLines(O, A);
  const toTheirs = matchLines(O, B);
  if (!toMine || !toTheirs) return null;
  let i = 0;
  let x = 0;
  let y = 0;
  for (;;) {
    let k = i;
    while (k < O.length && (toMine[k] < 0 || toTheirs[k] < 0)) k++;
    const xEnd = k < O.length ? toMine[k] : A.length;
    const yEnd = k < O.length ? toTheirs[k] : B.length;
    const o = O.slice(i, k);
    const a = A.slice(x, xEnd);
    const b = B.slice(y, yEnd);
    if (o.length || a.length || b.length) {
      const kind: ChunkKind = sameLines(a, o) ? 'theirs' : sameLines(b, o) ? 'mine' : sameLines(a, b) ? 'same' : 'conflict';
      out.push({ kind, base: o, mine: a, theirs: b });
    }
    if (k >= O.length) break;
    stable(O[k]);
    i = k + 1;
    x = xEnd + 1;
    y = yEnd + 1;
  }
  return out;
}

const NONE: ChunkPick = { theirs: false, mine: false };

/** Marcas iniciais: cada trecho com o lado que mudou; conflito sem marca. */
export function defaultPicks(chunks: MergeChunk[]): ChunkPick[] {
  return chunks.map(chunk => {
    switch (chunk.kind) {
      case 'theirs': return { theirs: true, mine: false };
      case 'mine': return { theirs: false, mine: true };
      case 'same': return { theirs: true, mine: true };
      default: return NONE;
    }
  });
}

/** Tudo de um lado só — o resultado fica igual a esse lado. */
export function sidePicks(chunks: MergeChunk[], side: 'mine' | 'theirs'): ChunkPick[] {
  return chunks.map(chunk =>
    chunk.kind === 'stable' ? NONE : side === 'mine' ? { theirs: false, mine: true } : { theirs: true, mine: false }
  );
}

/** Aplica uma escolha só aos conflitos, mantendo o resto. */
export function pickConflicts(chunks: MergeChunk[], picks: ChunkPick[], pick: ChunkPick): ChunkPick[] {
  return chunks.map((chunk, i) => (chunk.kind === 'conflict' ? pick : picks[i] ?? NONE));
}

/** Linhas que um trecho põe no resultado; `null` = conflito ainda sem decisão. */
export function chunkResult(chunk: MergeChunk, pick: ChunkPick): string[] | null {
  if (chunk.kind === 'stable') return chunk.base;
  if (pick.theirs && pick.mine) return sameLines(chunk.theirs, chunk.mine) ? chunk.theirs : [...chunk.theirs, ...chunk.mine];
  if (pick.theirs) return chunk.theirs;
  if (pick.mine) return chunk.mine;
  // Nenhum lado marcado: num trecho que só um lado mudou, volta a base
  // (desfaz a mudança dos dois); num conflito, é decisão pendente.
  return chunk.kind === 'conflict' ? null : chunk.base;
}

export interface ComposedMerge {
  /** O texto do resultado. Conflito pendente entra com as linhas da base (ou as suas, sem base). */
  text: string;
  /** Conflitos sem decisão. */
  unresolved: number;
}

/**
 * Texto do resultado a partir das marcas. `crlf` = a quebra de linha da sua
 * versão (CRLF ≡ LF na comparação, como no mergeText).
 */
export function composeMerge(chunks: MergeChunk[], picks: ChunkPick[], crlf = false): ComposedMerge {
  const lines: string[] = [];
  let unresolved = 0;
  chunks.forEach((chunk, i) => {
    const result = chunkResult(chunk, picks[i] ?? NONE);
    if (result) lines.push(...result);
    else {
      unresolved++;
      lines.push(...(chunk.base.length ? chunk.base : chunk.mine));
    }
  });
  const text = lines.join('\n');
  return { text: crlf ? text.replace(/\n/g, '\r\n') : text, unresolved };
}

/**
 * Marcas que reproduzem um texto já existente (um rascunho salvo, o Auto
 * merge, "Use mine"), ou `null` se ele foi editado à mão. Só tenta as marcas
 * iniciais quando elas não deixam conflito pendente.
 */
export function inferPicks(chunks: MergeChunk[], text: string): ChunkPick[] | null {
  const target = lf(text);
  const candidates = [sidePicks(chunks, 'mine'), sidePicks(chunks, 'theirs')];
  if (!chunks.some(chunk => chunk.kind === 'conflict')) candidates.unshift(defaultPicks(chunks));
  return candidates.find(picks => composeMerge(chunks, picks).text === target) ?? null;
}
