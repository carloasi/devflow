// ─────────────────────────────────────────────────────────────────────────
// Diferença entrada a entrada em campos que são lista de chave/valor —
// headers e variáveis de environment.
//
// Esses campos apareciam na tela de comparação como dois blocos de JSON lado
// a lado. Com dez headers e um deles alterado, achar QUAL mudou era procurar
// a olho em vinte linhas quase idênticas — e o erro silencioso aí é aceitar a
// versão errada achando que era a outra.
//
// Resolver também era caro: a única saída era editar o array inteiro à mão na
// caixa de resultado, e um JSON quebrado no meio do caminho bloqueia o
// aplicar. Aqui cada entrada vira uma linha com os dois lados, e a escolha é
// por linha.
//
// `auth`, `example` e `order` não passam por aqui: não são listas de
// chave/valor, e a tela cai no JSON de antes.
// ─────────────────────────────────────────────────────────────────────────

export interface KeyedEntry {
  key: string;
  value: string;
  enabled?: boolean;
}

export type Side = 'local' | 'remote';

export type EntryChange = 'same' | 'changed' | 'added' | 'removed';

export interface EntryRow {
  /** Chave + ocorrência: chaves repetem, e a linha precisa de id estável. */
  id: string;
  key: string;
  /** Qual ocorrência desta chave esta linha é, da primeira (0) em diante. */
  occurrence: number;
  change: EntryChange;
  local?: KeyedEntry;
  remote?: KeyedEntry;
  /** Posição no lado remoto — é onde uma entrada nova deve ser inserida. */
  remoteIndex?: number;
}

export function isKeyedList(value: unknown): value is KeyedEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      e => e !== null && typeof e === 'object' && typeof (e as KeyedEntry).key === 'string'
    )
  );
}

/** Desligado é conteúdo: um header presente e desligado não é o mesmo que o ligado. */
function isOn(entry: KeyedEntry): boolean {
  return entry.enabled !== false;
}

export function sameEntry(a: KeyedEntry, b: KeyedEntry): boolean {
  return (a.value ?? '') === (b.value ?? '') && isOn(a) === isOn(b);
}

/**
 * Campo ausente conta como lista vazia.
 *
 * "A request de lá não tem mais headers" é uma diferença que se quer ver
 * entrada a entrada tanto quanto qualquer outra — cair no JSON ali mostraria
 * a lista local inteira contra um `—`.
 */
function toList(value: unknown): { list: KeyedEntry[]; real: boolean } | null {
  if (value === undefined || value === null) return { list: [], real: false };
  return isKeyedList(value) ? { list: value, real: true } : null;
}

/**
 * Linhas da comparação, ou `null` quando o campo não é lista de chave/valor —
 * aí quem chama volta pro JSON lado a lado.
 *
 * Casa por CHAVE, não por posição: reordenar headers não muda o que a request
 * faz, e mostrar tudo deslocado por causa de uma inserção no topo esconderia
 * a mudança real.
 *
 * Chave repetida casa por ocorrência — a primeira com a primeira. Dados reais
 * têm chave duplicada (um environment aqui tem `username` duas vezes, uma
 * ligada e outra não), então isso não é hipótese.
 */
export function diffEntries(local: unknown, remote: unknown): EntryRow[] | null {
  const a = toList(local);
  const b = toList(remote);
  if (!a || !b) return null;
  // Nenhum dos dois lados era lista de verdade: não há nada que esta tela
  // mostre melhor que o JSON.
  if (!a.real && !b.real) return null;

  // Fila de posições remotas por chave, pra casar ocorrência com ocorrência.
  const pending = new Map<string, number[]>();
  b.list.forEach((entry, i) => {
    const queue = pending.get(entry.key);
    if (queue) queue.push(i);
    else pending.set(entry.key, [i]);
  });

  const seen = new Set<number>();
  const counts = new Map<string, number>();
  const rows: EntryRow[] = [];

  const nextOccurrence = (key: string) => {
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return n;
  };

  for (const entry of a.list) {
    const queue = pending.get(entry.key);
    const remoteIndex = queue && queue.length > 0 ? queue.shift() : undefined;
    if (remoteIndex !== undefined) seen.add(remoteIndex);
    const counterpart = remoteIndex !== undefined ? b.list[remoteIndex] : undefined;
    const occurrence = nextOccurrence(entry.key);

    rows.push({
      id: `${entry.key}#${occurrence}`,
      key: entry.key,
      occurrence,
      change: counterpart ? (sameEntry(entry, counterpart) ? 'same' : 'changed') : 'removed',
      local: entry,
      remote: counterpart,
      remoteIndex,
    });
  }

  // O que só existe lá entra no fim. A ordem da SUA lista é a que você
  // reconhece; o que é novo chama atenção por ser novo, não pela posição.
  b.list.forEach((entry, i) => {
    if (seen.has(i)) return;
    const occurrence = nextOccurrence(entry.key);
    rows.push({
      id: `${entry.key}#${occurrence}`,
      key: entry.key,
      occurrence,
      change: 'added',
      remote: entry,
      remoteIndex: i,
    });
  });

  return rows;
}

export function countChangedEntries(rows: EntryRow[]): number {
  return rows.filter(r => r.change !== 'same').length;
}

/** Lê a lista que está na caixa de resultado. `null` se não for uma lista. */
export function entriesFromText(text: string): KeyedEntry[] | null {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isKeyedList(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Onde, na lista do rascunho, está a entrada desta linha. `-1` se não está.
 *
 * Por chave + ocorrência. Com chave duplicada, resolver uma linha desloca as
 * ocorrências seguintes — a segunda escolha pode cair na entrada vizinha. É o
 * preço de casar por chave em vez de por posição, e o caso só aparece quando
 * a MESMA chave está duplicada E foi alterada duas vezes.
 */
function findSlot(current: KeyedEntry[], row: EntryRow): number {
  let n = 0;
  for (let i = 0; i < current.length; i++) {
    if (current[i].key !== row.key) continue;
    if (n === row.occurrence) return i;
    n++;
  }
  return -1;
}

/** Aplica a escolha de UMA linha sobre a lista do rascunho. */
export function applyChoice(current: KeyedEntry[], row: EntryRow, side: Side): KeyedEntry[] {
  const target = side === 'local' ? row.local : row.remote;
  const at = findSlot(current, row);
  const next = [...current];

  if (at >= 0) {
    // Escolher o lado que não tem a entrada é removê-la.
    if (target) next[at] = target;
    else next.splice(at, 1);
    return next;
  }

  if (!target) return next;

  // Entrada que o rascunho não tem: entra na posição que ocupa no remoto, que
  // é de onde ela vem. Sem isso toda entrada aceita iria parar no fim.
  const at2 = Math.min(row.remoteIndex ?? next.length, next.length);
  next.splice(at2, 0, target);
  return next;
}

/**
 * De qual lado está a entrada desta linha no rascunho. `null` quando não bate
 * com nenhum dos dois — a caixa de resultado foi editada à mão.
 */
export function sideOf(current: KeyedEntry[], row: EntryRow): Side | null {
  const at = findSlot(current, row);
  const inDraft = at >= 0 ? current[at] : undefined;

  if (!inDraft) {
    // Ausente: equivale ao lado que também não a tem.
    if (!row.local) return 'local';
    if (!row.remote) return 'remote';
    return null;
  }

  if (row.remote && sameEntry(inDraft, row.remote)) return 'remote';
  if (row.local && sameEntry(inDraft, row.local)) return 'local';
  return null;
}
