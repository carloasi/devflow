import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { nodeHashes } from '@/lib/syncBase';
import { rebaseCollections } from './rebase';
import { withSubtreeFrom } from './subtreePush';

// "Receber só este" (AppLayout.handleReceiveItem): a mescla do pull, mas só
// a subárvore do item entra na collection daqui — o resto fica como está.

const req = (id: string, body: string): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});
const col = (children: CollectionItem[]) => [{ id: 'c', name: 'C', type: 'folder', item: children } as CollectionItem];
const bodyOf = (root: CollectionItem, id: string) => root.item?.find(i => i.id === id)?.request?.body;

describe('receive only one item', () => {
  const base = nodeHashes(col([req('a', 'a0'), req('b', 'b0'), req('x', 'x0')]));

  it('brings that item from GitHub and leaves the others (and your edits) alone', () => {
    const local = col([req('a', 'a0'), req('b', 'b-mine'), req('x', 'x0')]);
    const remote = col([req('a', 'a-theirs'), req('b', 'b0'), req('x', 'x-theirs')]);
    const merged = rebaseCollections(local, remote, base, new Set(['c'])).merged;
    const next = withSubtreeFrom(local[0], merged[0], 'a')!;
    expect(bodyOf(next, 'a')).toBe('a-theirs');
    expect(bodyOf(next, 'b')).toBe('b-mine');
    // x também mudou lá, mas não foi pedido: continua como estava aqui.
    expect(bodyOf(next, 'x')).toBe('x0');
  });

  it('a new item on GitHub comes in at its place', () => {
    const local = col([req('a', 'a0'), req('b', 'b0'), req('x', 'x0')]);
    const remote = col([req('a', 'a0'), req('n', 'new'), req('b', 'b0'), req('x', 'x0')]);
    const merged = rebaseCollections(local, remote, base, new Set()).merged;
    const next = withSubtreeFrom(local[0], merged[0], 'n')!;
    expect(next.item!.map(i => i.id)).toEqual(['a', 'n', 'b', 'x']);
  });

  it('an item deleted on GitHub is not in the merge (the caller removes it)', () => {
    const local = col([req('a', 'a0'), req('b', 'b0'), req('x', 'x0')]);
    const remote = col([req('b', 'b0'), req('x', 'x0')]);
    const merged = rebaseCollections(local, remote, base, new Set()).merged;
    expect(withSubtreeFrom(local[0], merged[0], 'a')).toBeNull();
  });
});
