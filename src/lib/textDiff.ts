// ─────────────────────────────────────────────────────────────────────────
// Diff de texto por linha, pra tela de revisão do GitHub.
//
// Comparar dois blocos de body/script a olho, lado a lado, é onde a revisão
// mais erra: a diferença está numa vírgula no meio de 80 linhas iguais.
// Aqui sai a lista de linhas com o que entrou/saiu, o trecho que mudou
// DENTRO da linha (quando uma linha foi trocada por outra parecida) e os
// trechos longos sem mudança recolhidos.
//
// LCS simples (O(n·m)): os campos de uma request são pequenos; acima do
// limite, cai num diff "tudo saiu, tudo entrou", que ainda é correto.
// ─────────────────────────────────────────────────────────────────────────

export type DiffLineType = 'same' | 'del' | 'add';

export interface DiffSegment {
  text: string;
  /** Trecho que mudou dentro da linha (só em del/add pareadas). */
  changed: boolean;
}

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** Presente quando a linha foi trocada por uma parecida: o que mudou dentro dela. */
  segments?: DiffSegment[];
}

export interface CollapsedRun {
  type: 'collapsed';
  count: number;
}

export const MAX_CELLS = 4_000_000;

export function lcsTable(a: string[], b: string[]): Uint32Array {
  const cols = b.length + 1;
  const table = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  return table;
}

/** Trecho igual no começo e no fim; o meio é o que mudou. */
function inlineSegments(before: string, after: string): [DiffSegment[], DiffSegment[]] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end++;
  const split = (text: string): DiffSegment[] =>
    [
      { text: text.slice(0, start), changed: false },
      { text: text.slice(start, text.length - end), changed: true },
      { text: text.slice(text.length - end), changed: false },
    ].filter(s => s.text.length > 0);
  return [split(before), split(after)];
}

/** Linhas parecidas o bastante pra valer destacar o trecho dentro delas. */
function similar(a: string, b: string): boolean {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return true;
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  let tail = 0;
  while (tail < a.length - same && tail < b.length - same && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return (same + tail) / longest >= 0.4;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (before === after) return a.map(text => ({ type: 'same', text }));

  const out: DiffLine[] = [];
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    for (const text of a) out.push({ type: 'del', text });
    for (const text of b) out.push({ type: 'add', text });
    return out;
  }

  const cols = b.length + 1;
  const table = lcsTable(a, b);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || table[(i + 1) * cols + j] >= table[i * cols + j + 1])) {
      // Saída antes da entrada: é o que deixa parear a linha velha com a nova.
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }

  // Bloco de saídas seguido de entradas: pareia linha a linha as parecidas
  // e marca o trecho que mudou dentro delas.
  for (let k = 0; k < out.length; ) {
    if (out[k].type !== 'del') {
      k++;
      continue;
    }
    let delEnd = k;
    while (delEnd < out.length && out[delEnd].type === 'del') delEnd++;
    let addEnd = delEnd;
    while (addEnd < out.length && out[addEnd].type === 'add') addEnd++;
    const pairs = Math.min(delEnd - k, addEnd - delEnd);
    for (let p = 0; p < pairs; p++) {
      const del = out[k + p];
      const add = out[delEnd + p];
      if (!similar(del.text, add.text)) continue;
      [del.segments, add.segments] = inlineSegments(del.text, add.text);
    }
    k = addEnd;
  }
  return out;
}

/** Recolhe trechos iguais longos, deixando `context` linhas em volta das mudanças. */
export function collapseUnchanged(lines: DiffLine[], context = 3): (DiffLine | CollapsedRun)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.type === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: (DiffLine | CollapsedRun)[] = [];
  for (let k = 0; k < lines.length; ) {
    if (keep[k]) {
      out.push(lines[k]);
      k++;
      continue;
    }
    let end = k;
    while (end < lines.length && !keep[end]) end++;
    if (end - k <= 2) for (let m = k; m < end; m++) out.push(lines[m]);
    else out.push({ type: 'collapsed', count: end - k });
    k = end;
  }
  return out;
}

/** Texto comparável de um valor de campo (JSON formatado pra objetos). */
export function diffableText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
