import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { diffTrees } from '@/lib/collectionDiff';
import { nodeHashes, pendingChanges } from '@/lib/syncBase';
import { fieldHashKey, ORDER_FIELD } from './fieldMerge';
import {
  CONFLICT_END,
  CONFLICT_MID,
  CONFLICT_START,
  composeForEditing,
  composeMerge,
  conflictMarkerCount,
  defaultPicks,
  mergeChunks,
  sameChunkShape,
} from './mergeChunks';
import { detailItems } from './remoteChangeAlert';

describe('editing a merge by hand with an undecided conflict', () => {
  const base = 'a\nb\nc';
  const mine = 'a\nb-mine\nc';
  const theirs = 'a\nb-theirs\nc';

  it('starts with both sides between markers, not with the base line', () => {
    const chunks = mergeChunks(base, mine, theirs)!;
    const text = composeForEditing(chunks, defaultPicks(chunks));
    expect(text.split('\n')).toEqual(['a', CONFLICT_START, 'b-theirs', CONFLICT_MID, 'b-mine', CONFLICT_END, 'c']);
    // A versão das caixinhas continua com a base no lugar (e conta 1 pendente).
    expect(composeMerge(chunks, defaultPicks(chunks)).unresolved).toBe(1);
  });

  it('keeps CRLF when your version had it', () => {
    const chunks = mergeChunks(base, mine, theirs)!;
    expect(composeForEditing(chunks, defaultPicks(chunks), true)).toContain('\r\n');
  });

  it('counts the conflicts left until the markers are removed', () => {
    const chunks = mergeChunks('x\n1\ny\n2\nz', 'x\n1m\ny\n2m\nz', 'x\n1t\ny\n2t\nz')!;
    const text = composeForEditing(chunks, defaultPicks(chunks));
    expect(conflictMarkerCount(text)).toBe(2);
    expect(conflictMarkerCount(text.replace(/\r?\n/g, '\r\n'))).toBe(2);
    expect(conflictMarkerCount('x\n1m\ny\n2t\nz')).toBe(0);
  });

  it('nothing undecided: same text as the checkboxes', () => {
    const chunks = mergeChunks(base, mine, base)!;
    expect(composeForEditing(chunks, defaultPicks(chunks))).toBe(composeMerge(chunks, defaultPicks(chunks)).text);
  });
});

describe('sameChunkShape', () => {
  it('same number of chunks is not enough: the cuts must line up', () => {
    const a = mergeChunks('1\n2\n3', '1\nX\n3', '1\n2\n3')!;
    // Mesmo número de trechos, mas o do meio é de outro lado...
    const b = mergeChunks('1\n2\n3', '1\n2\n3', '1\nX\n3')!;
    // ...ou tem outro tamanho (o corte da prévia muda isso).
    const c = mergeChunks('1\n2\n3', '1\nX\nY\n3', '1\n2\n3')!;
    expect(a.length).toBe(b.length);
    expect(a.length).toBe(c.length);
    expect(sameChunkShape(a, b)).toBe(false);
    expect(sameChunkShape(a, c)).toBe(false);
    expect(sameChunkShape(a, mergeChunks('1\n2\n3', '1\nZ\n3', '1\n2\n3')!)).toBe(true);
  });
});

const req = (id: string, auth: unknown, body = ''): CollectionItem =>
  ({
    id,
    name: `Request ${id}`,
    type: 'request',
    method: 'GET',
    request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body, auth },
  }) as unknown as CollectionItem;

describe('diff preview with secrets', () => {
  it('flags a field whose preview hides a secret, and not a plain one', () => {
    const local = [{ id: 'c', name: 'C', type: 'folder', item: [req('r', { type: 'bearer', token: 'eyJhbGciOiJIUzI1NiJ9.mine.signature' }, 'b1')] } as CollectionItem];
    const remote = [{ id: 'c', name: 'C', type: 'folder', item: [req('r', { type: 'bearer', token: 'eyJhbGciOiJIUzI1NiJ9.theirs.signature' }, 'b2')] } as CollectionItem];
    const nodes = diffTrees(local, remote);
    const node = nodes.find(n => n.id === 'r')!;
    const [item] = detailItems([{ id: 'r', path: ['C', 'r'], change: 'changed', fields: node.fields.map(f => f.field) }], nodes, { conflict: true });
    const auth = item.fields.find(f => f.field === 'auth');
    const body = item.fields.find(f => f.field === 'body');
    expect(auth?.masked).toBe(true);
    expect(body?.masked).toBeUndefined();
  });
});

describe('pendingChanges with a corrupted base', () => {
  it('does not throw on an unreadable child order, and counts the folder', () => {
    const tree = [{ id: 'c', name: 'C', type: 'folder', item: [req('a', undefined), req('b', undefined)] } as CollectionItem];
    const base = { ...nodeHashes(tree), [fieldHashKey('c', ORDER_FIELD)]: '{not json' };
    const out = pendingChanges(base, tree[0]);
    expect(out?.changed).toContain('c');
  });
});
