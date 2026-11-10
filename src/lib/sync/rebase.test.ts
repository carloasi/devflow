import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { nodeHashes } from '@/lib/syncBase';
import { rebaseCollections } from './rebase';

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: `Request ${id}`,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});

const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: `Folder ${id}`, type: 'folder', item: children }) as CollectionItem;

const bodies = (items: CollectionItem[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (list: CollectionItem[]) => {
    for (const it of list) {
      if (it.request) out[it.id] = String(it.request.body);
      if (it.item) walk(it.item);
    }
  };
  walk(items ?? []);
  return out;
};

// Estado da última sincronização: collection "c" com a, b e c1.
const synced = () => [folder('c', [req('a', 'a0'), req('b', 'b0'), req('c1', 'c0')])];
const base = nodeHashes(synced());
const pending = new Set(['c']);

describe('rebaseCollections', () => {
  it('two people changing different requests merge without conflict', () => {
    const local = [folder('c', [req('a', 'a-mine'), req('b', 'b0'), req('c1', 'c0')])];
    const remote = [folder('c', [req('a', 'a0'), req('b', 'b-theirs'), req('c1', 'c0')])];

    const r = rebaseCollections(local, remote, base, pending);

    expect(r.conflicts).toEqual([]);
    expect(r.incoming).toBe(1);
    expect(r.outgoing).toBe(1);
    expect(bodies(r.merged)).toEqual({ a: 'a-mine', b: 'b-theirs', c1: 'c0' });
  });

  it('the same request changed on both sides is a conflict', () => {
    const local = [folder('c', [req('a', 'a-mine'), req('b', 'b0'), req('c1', 'c0')])];
    const remote = [folder('c', [req('a', 'a-theirs'), req('b', 'b-theirs'), req('c1', 'c0')])];

    const r = rebaseCollections(local, remote, base, pending);

    expect(r.conflicts).toEqual(['a']);
    // O resto continua mesclado: b vem do GitHub, a fica como está aqui.
    expect(bodies(r.merged)).toMatchObject({ a: 'a-mine', b: 'b-theirs' });
  });

  it('keeps a request created here and takes one created on GitHub', () => {
    const local = [folder('c', [...synced()[0].item!, req('mine-new', 'x')])];
    const remote = [folder('c', [...synced()[0].item!, req('their-new', 'y')])];

    const r = rebaseCollections(local, remote, base, pending);

    expect(r.conflicts).toEqual([]);
    expect(Object.keys(bodies(r.merged)).sort()).toEqual(['a', 'b', 'c1', 'mine-new', 'their-new']);
  });

  it('deletions on one side win when the other side did not touch the item', () => {
    // Apaguei "a" aqui; apagaram "b" lá.
    const local = [folder('c', [req('b', 'b0'), req('c1', 'c0')])];
    const remote = [folder('c', [req('a', 'a0'), req('c1', 'c0')])];

    const r = rebaseCollections(local, remote, base, pending);

    expect(r.conflicts).toEqual([]);
    expect(Object.keys(bodies(r.merged))).toEqual(['c1']);
  });

  it('deleted here but changed on GitHub is a conflict', () => {
    const local = [folder('c', [req('b', 'b0'), req('c1', 'c0')])];
    const remote = [folder('c', [req('a', 'a-theirs'), req('b', 'b0'), req('c1', 'c0')])];

    expect(rebaseCollections(local, remote, base, pending).conflicts).toEqual(['a']);
  });

  it('changed here but deleted on GitHub is a conflict', () => {
    const local = [folder('c', [req('a', 'a-mine'), req('b', 'b0'), req('c1', 'c0')])];
    const remote = [folder('c', [req('b', 'b0'), req('c1', 'c0')])];

    expect(rebaseCollections(local, remote, base, pending).conflicts).toEqual(['a']);
  });

  it('without a base, a collection with local changes asks instead of guessing', () => {
    const local = [folder('c', [req('a', 'a-mine'), req('b', 'b0'), req('c1', 'c0')])];
    const remote = [folder('c', [req('a', 'a0'), req('b', 'b-theirs'), req('c1', 'c0')])];

    expect(rebaseCollections(local, remote, null, pending).conflicts.sort()).toEqual(['a', 'b']);
  });

  describe('order and moves', () => {
    const ids = (items: CollectionItem[] | undefined) => (items ?? []).map(i => i.id);

    it('takes a reorder made on GitHub, even with local changes elsewhere', () => {
      const local = [folder('c', [req('a', 'a-mine'), req('b', 'b0'), req('c1', 'c0')])];
      const remote = [folder('c', [req('b', 'b0'), req('a', 'a0'), req('c1', 'c0')])];

      const r = rebaseCollections(local, remote, base, pending);

      expect(r.conflicts).toEqual([]);
      expect(ids(r.merged[0].item)).toEqual(['b', 'a', 'c1']);
      expect(bodies(r.merged).a).toBe('a-mine');
    });

    it('keeps my reorder when GitHub changed something else in the folder', () => {
      const local = [folder('c', [req('c1', 'c0'), req('a', 'a0'), req('b', 'b0')])];
      const remote = [folder('c', [req('a', 'a0'), req('b', 'b-theirs'), req('c1', 'c0')])];

      const r = rebaseCollections(local, remote, base, pending);

      expect(r.conflicts).toEqual([]);
      expect(ids(r.merged[0].item)).toEqual(['c1', 'a', 'b']);
      expect(bodies(r.merged).b).toBe('b-theirs');
    });

    it('two different reorders of the same folder are a conflict', () => {
      const local = [folder('c', [req('c1', 'c0'), req('a', 'a0'), req('b', 'b0')])];
      const remote = [folder('c', [req('b', 'b0'), req('a', 'a0'), req('c1', 'c0')])];

      expect(rebaseCollections(local, remote, base, pending).conflicts).toEqual(['c']);
    });

    it('without the order in the base, a reorder with local changes still asks', () => {
      const noOrder = Object.fromEntries(Object.entries(base).filter(([k]) => !k.endsWith('#~order')));
      const remote = [folder('c', [req('b', 'b0'), req('a', 'a0'), req('c1', 'c0')])];

      expect(rebaseCollections(synced(), remote, noOrder, pending).conflicts).toEqual(['c']);
    });

    // Base com uma subpasta: c > [f > [a], b]
    const nested = () => [folder('c', [folder('f', [req('a', 'a0')]), req('b', 'b0')])];
    const nestedBase = nodeHashes(nested());

    it('applies a move made on GitHub', () => {
      const remote = [folder('c', [folder('f', []), req('b', 'b0'), req('a', 'a0')])];

      const r = rebaseCollections(nested(), remote, nestedBase, pending);

      expect(r.conflicts).toEqual([]);
      expect(ids(r.merged[0].item)).toEqual(['f', 'b', 'a']);
      expect(ids(r.merged[0].item![0].item)).toEqual([]);
    });

    it('keeps my move and brings the edit made on GitHub', () => {
      const local = [folder('c', [folder('f', []), req('b', 'b0'), req('a', 'a0')])];
      const remote = [folder('c', [folder('f', [req('a', 'a-theirs')]), req('b', 'b0')])];

      const r = rebaseCollections(local, remote, nestedBase, pending);

      expect(ids(r.merged[0].item)).toEqual(['f', 'b', 'a']);
      expect(bodies(r.merged).a).toBe('a-theirs');
    });
  });

  describe('same request, different fields', () => {
    const withScript = (item: CollectionItem, script: string): CollectionItem => ({
      ...item,
      request: { ...item.request!, scripts: { preRequest: script, postResponse: '' } },
    });
    const withUrl = (item: CollectionItem, url: string): CollectionItem => ({
      ...item,
      request: { ...item.request!, url, urlexport: { host: [], path: [], raw: url } },
    });

    it('takes my URL and their script', () => {
      const local = [folder('c', [withUrl(req('a', 'a0'), '/mine'), req('b', 'b0'), req('c1', 'c0')])];
      const remote = [folder('c', [withScript(req('a', 'a0'), 'theirs()'), req('b', 'b0'), req('c1', 'c0')])];

      const r = rebaseCollections(local, remote, base, pending);

      expect(r.conflicts).toEqual([]);
      expect(r.fieldMerged).toBe(1);
      const a = r.merged[0].item!.find(i => i.id === 'a')!;
      expect(a.request!.url).toBe('/mine');
      expect(a.request!.urlexport.raw).toBe('/mine');
      expect(a.request!.scripts!.preRequest).toBe('theirs()');
    });

    it('the same field changed on both sides is still a conflict', () => {
      const local = [folder('c', [withUrl(req('a', 'a0'), '/mine'), req('b', 'b0'), req('c1', 'c0')])];
      const remote = [folder('c', [withUrl(req('a', 'a0'), '/theirs'), req('b', 'b0'), req('c1', 'c0')])];

      expect(rebaseCollections(local, remote, base, pending).conflicts).toEqual(['a']);
    });

    it('a base without field hashes asks instead of guessing', () => {
      const nodeOnly = Object.fromEntries(Object.entries(base).filter(([k]) => !k.includes('#')));
      const local = [folder('c', [withUrl(req('a', 'a0'), '/mine'), req('b', 'b0'), req('c1', 'c0')])];
      const remote = [folder('c', [withScript(req('a', 'a0'), 'theirs()'), req('b', 'b0'), req('c1', 'c0')])];

      expect(rebaseCollections(local, remote, nodeOnly, pending).conflicts).toEqual(['a']);
    });

    it('a change outside the known fields here is a conflict', () => {
      const local = [folder('c', [{ ...req('a', 'a0'), protocol: 'grpc' } as CollectionItem, req('b', 'b0'), req('c1', 'c0')])];
      const remote = [folder('c', [withScript(req('a', 'a0'), 'theirs()'), req('b', 'b0'), req('c1', 'c0')])];

      expect(rebaseCollections(local, remote, base, pending).conflicts).toEqual(['a']);
    });
  });

  describe('never deletes work by mistake', () => {
    it('first push of a never-synced workspace keeps every collection', () => {
      const local = [folder('c1', [req('a', 'a0')]), folder('c2', [req('b', 'b0')])];

      const r = rebaseCollections(local, [], null, new Set());

      expect(r.merged.map(c => c.id)).toEqual(['c1', 'c2']);
      expect(r.conflicts).toEqual([]);
      expect(r.outgoing).toBe(2);
    });

    it('a collection deleted on GitHub while I edited a request inside it is a conflict', () => {
      // Base: c > [a, b, c1]. Aqui: mudei "a". Lá: apagaram a collection inteira.
      const local = [folder('c', [req('a', 'a-mine'), req('b', 'b0'), req('c1', 'c0')])];

      const r = rebaseCollections(local, [], base, pending);

      expect(r.conflicts).toEqual(['c']);
      expect(bodies(r.merged).a).toBe('a-mine');
    });

    it('a request created here inside a collection deleted on GitHub is a conflict too', () => {
      const local = [folder('c', [...synced()[0].item!, req('new', 'x')])];

      expect(rebaseCollections(local, [], base, pending).conflicts).toEqual(['c']);
    });

    it('a collection nobody touched here still follows a deletion on GitHub', () => {
      const r = rebaseCollections(synced(), [], base, new Set());
      expect(r.merged).toEqual([]);
      expect(r.conflicts).toEqual([]);
    });
  });

  describe('change details', () => {
    it('says what came in, what goes out and what needs a decision', () => {
      const local = [folder('c', [req('a', 'a-mine'), req('b', 'b0'), req('c1', 'c-mine'), req('mine', 'x')])];
      const remote = [folder('c', [req('a', 'a0'), req('b', 'b-theirs'), req('c1', 'c-theirs'), req('theirs', 'y')])];

      const r = rebaseCollections(local, remote, base, pending);

      const short = (d: { id: string; change: string; fields: string[] }) => `${d.id}:${d.change}:${d.fields.join(',')}`;
      expect(r.incomingDetails.map(short).sort()).toEqual(['b:changed:body', 'theirs:new:']);
      expect(r.outgoingDetails.map(short).sort()).toEqual(['a:changed:body', 'mine:new:']);
      expect(r.conflictDetails.map(short)).toEqual(['c1:changed:body']);
    });
  });

  it('nothing different means nothing to do', () => {
    const r = rebaseCollections(synced(), synced(), base, pending);
    expect(r).toMatchObject({ conflicts: [], incoming: 0, outgoing: 0 });
  });
});
