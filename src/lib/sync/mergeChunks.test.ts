import { describe, expect, it } from 'vitest';
import { composeMerge, defaultPicks, inferPicks, mergeChunks, pickConflicts, sidePicks } from './mergeChunks';

const lines = (...xs: string[]) => xs.join('\n');

const BASE = lines('{', '  "period": "OrderCreation",', '  "a": 1,', '  "transaction": "Payment",', '  "b": 2,', '  "authorization": "b2b"', '}');
const MINE = BASE.replace('"period": "OrderCreation"', '"period": "PaymentDate"').replace('"authorization"', '//"authorization"');
const THEIRS = BASE.replace('"period": "OrderCreation"', '"period": "Settlement"').replace('"transaction"', '//"transaction"');

describe('mergeChunks', () => {
  it('tells who changed each part, against the last sync', () => {
    const chunks = mergeChunks(BASE, MINE, THEIRS)!;
    expect(chunks.filter(c => c.kind !== 'stable').map(c => c.kind)).toEqual(['conflict', 'theirs', 'mine']);
  });

  it('starts with the side that changed each part and leaves the conflict open', () => {
    const chunks = mergeChunks(BASE, MINE, THEIRS)!;
    const result = composeMerge(chunks, defaultPicks(chunks));
    expect(result.unresolved).toBe(1);
    expect(result.text).toContain('//"transaction"');
    expect(result.text).toContain('//"authorization"');
    // Conflito pendente fica com a linha da base.
    expect(result.text).toContain('"period": "OrderCreation"');
  });

  it('resolves the conflict with one side, or both (GitHub first)', () => {
    const chunks = mergeChunks(BASE, MINE, THEIRS)!;
    const mine = composeMerge(chunks, pickConflicts(chunks, defaultPicks(chunks), { theirs: false, mine: true }));
    expect(mine.unresolved).toBe(0);
    expect(mine.text).toContain('"period": "PaymentDate"');

    const both = composeMerge(chunks, pickConflicts(chunks, defaultPicks(chunks), { theirs: true, mine: true })).text;
    expect(both.indexOf('Settlement')).toBeLessThan(both.indexOf('PaymentDate'));
  });

  it('gives back each whole side', () => {
    const chunks = mergeChunks(BASE, MINE, THEIRS)!;
    expect(composeMerge(chunks, sidePicks(chunks, 'mine')).text).toBe(MINE);
    expect(composeMerge(chunks, sidePicks(chunks, 'theirs')).text).toBe(THEIRS);
  });

  it('unticking a one-side change brings back the last synced lines', () => {
    const chunks = mergeChunks(BASE, MINE, THEIRS)!;
    const picks = defaultPicks(chunks);
    const theirsAt = chunks.findIndex(c => c.kind === 'theirs');
    picks[theirsAt] = { theirs: false, mine: false };
    expect(composeMerge(chunks, picks).text).toContain('  "transaction": "Payment",');
  });

  it('without the last synced version, every difference is a conflict', () => {
    const chunks = mergeChunks(null, MINE, THEIRS)!;
    expect(chunks.filter(c => c.kind !== 'stable').every(c => c.kind === 'conflict')).toBe(true);
    expect(composeMerge(chunks, sidePicks(chunks, 'theirs')).text).toBe(THEIRS);
  });

  it('keeps the local line endings', () => {
    const chunks = mergeChunks('a\nb\nc\nd', 'A\r\nb\r\nc\r\nd', 'a\nb\nc\nD')!;
    expect(composeMerge(chunks, defaultPicks(chunks), true).text).toBe('A\r\nb\r\nc\r\nD');
  });
});

describe('inferPicks', () => {
  it('recognises a text that came from the default picks, or from one side', () => {
    const base = lines('a', 'b', 'c', 'd', 'e');
    const mine = lines('A', 'b', 'c', 'd', 'e');
    const theirs = lines('a', 'b', 'c', 'd', 'E');
    const chunks = mergeChunks(base, mine, theirs)!;
    expect(inferPicks(chunks, lines('A', 'b', 'c', 'd', 'E'))).toEqual(defaultPicks(chunks));
    expect(inferPicks(chunks, mine)).toEqual(sidePicks(chunks, 'mine'));
    expect(inferPicks(chunks, theirs)).toEqual(sidePicks(chunks, 'theirs'));
    expect(inferPicks(chunks, 'edited by hand')).toBeNull();
  });
});
