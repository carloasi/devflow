import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { nodeHashes } from '@/lib/syncBase';
import { diffLines } from '@/lib/textDiff';
import { mergeText } from './autoMerge';
import { rebaseCollections } from './rebase';

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});
const folder = (id: string, items: CollectionItem[]): CollectionItem => ({ id, name: id, type: 'folder', item: items });

describe('line endings', () => {
  it('CRLF against LF is not a difference in every line', () => {
    expect(diffLines('a\r\nb\r\nc', 'a\nb\nc').every(l => l.type === 'same')).toBe(true);
    const lines = diffLines('a\r\nb\r\nc', 'a\nB\nc');
    expect(lines.filter(l => l.type !== 'same').map(l => l.text)).toEqual(['b', 'B']);
  });

  it("taking GitHub's text whole keeps GitHub's line endings", () => {
    const base = 'a\nb';
    const mine = 'a\nb'; // nada mudou aqui (LF)
    const theirs = 'a\r\nB'; // o colega mudou, com CRLF
    expect(mergeText(base, mine, theirs)).toEqual({ ok: true, text: theirs });
  });

  it('nothing changed on GitHub: your text stays exactly as it is', () => {
    expect(mergeText('a\nb', 'a\r\nB', 'a\nb')).toEqual({ ok: true, text: 'a\r\nB' });
  });
});

describe('rebase report', () => {
  it('a folder with reordered children and a changed field counts once', () => {
    const synced = [folder('c', [folder('f', [req('a'), req('b')])])];
    const base = nodeHashes(synced);
    const local = [folder('c', [folder('f', [req('b'), req('a')])])]; // você reordenou
    const remoteF = { ...folder('f', [req('a'), req('b')]), description: 'doc' }; // o colega descreveu
    const remote = [folder('c', [remoteF])];
    const r = rebaseCollections(local, remote, base, new Set(['c']));
    expect(r.conflicts).toEqual([]);
    expect(r.incoming + r.outgoing + r.fieldMerged).toBeLessThanOrEqual(2);
  });

  it('moved to different folders on both sides: yours stays, and it is reported', () => {
    const synced = [folder('c', [folder('A', [req('x')]), folder('B', []), folder('C', [])])];
    const base = nodeHashes(synced);
    const local = [folder('c', [folder('A', []), folder('B', [req('x')]), folder('C', [])])];
    const remote = [folder('c', [folder('A', []), folder('B', []), folder('C', [req('x')])])];
    const r = rebaseCollections(local, remote, base, new Set(['c']));
    expect(r.keptMineNames).toContain('x');
    const where = r.merged[0].item!.find(f => f.item?.some(i => i.id === 'x'))?.id;
    expect(where).toBe('B');
  });
});
