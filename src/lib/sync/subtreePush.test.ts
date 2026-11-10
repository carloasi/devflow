import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { withSubtreeFrom } from './subtreePush';

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: `Request ${id}`,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});

const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: `Folder ${id}`, type: 'folder', item: children }) as CollectionItem;

const shape = (item: CollectionItem): unknown =>
  item.item ? { [item.id]: item.item.map(shape) } : `${item.id}:${item.request?.body ?? ''}`;

describe('withSubtreeFrom', () => {
  it('replaces only the chosen request, keeping my other changes out', () => {
    const remote = folder('c', [folder('f1', [req('a', 'a0')]), folder('f2', [req('b', 'b0')])]);
    const mine = folder('c', [folder('f1', [req('a', 'a-mine')]), folder('f2', [req('b', 'b-mine')])]);

    expect(shape(withSubtreeFrom(remote, mine, 'a')!)).toEqual({
      c: [{ f1: ['a:a-mine'] }, { f2: ['b:b0'] }],
    });
  });

  it('replaces a whole folder, with what is inside it', () => {
    const remote = folder('c', [folder('f1', [req('a', 'a0')]), req('b', 'b0')]);
    const mine = folder('c', [folder('f1', [req('a', 'a-mine'), req('n', 'new')]), req('b', 'b-mine')]);

    expect(shape(withSubtreeFrom(remote, mine, 'f1')!)).toEqual({
      c: [{ f1: ['a:a-mine', 'n:new'] }, 'b:b0'],
    });
  });

  it('adds a new request where it is here', () => {
    const remote = folder('c', [folder('f1', [req('a', 'a0'), req('b', 'b0')])]);
    const mine = folder('c', [folder('f1', [req('a', 'a0'), req('n', 'new'), req('b', 'b0')])]);

    expect(shape(withSubtreeFrom(remote, mine, 'n')!)).toEqual({ c: [{ f1: ['a:a0', 'n:new', 'b:b0'] }] });
  });

  it('creates new parent folders empty, without other new items', () => {
    const remote = folder('c', [req('a', 'a0')]);
    const mine = folder('c', [req('a', 'a0'), folder('nf', [req('n1', 'x'), req('n2', 'y')])]);

    expect(shape(withSubtreeFrom(remote, mine, 'n2')!)).toEqual({ c: ['a:a0', { nf: ['n2:y'] }] });
  });

  it('moves the item when I moved it to another folder', () => {
    const remote = folder('c', [folder('f1', [req('a', 'a0')]), folder('f2', [])]);
    const mine = folder('c', [folder('f1', []), folder('f2', [req('a', 'a0')])]);

    expect(shape(withSubtreeFrom(remote, mine, 'a')!)).toEqual({ c: [{ f1: [] }, { f2: ['a:a0'] }] });
  });

  it('returns null when the item is not here', () => {
    expect(withSubtreeFrom(folder('c', [req('a')]), folder('c', []), 'a')).toBeNull();
  });
});
