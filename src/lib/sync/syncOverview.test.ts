import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { nodeHashes } from '@/lib/syncBase';
import { rebaseCollections } from './rebase';
import { buildSyncOverview, filterOverview, namePathTo, overviewCounts } from './syncOverview';

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'POST',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});
const col = (id: string, items: CollectionItem[]): CollectionItem => ({ id, name: id, type: 'folder', item: items });
const noEnv = { incomingNames: [], outgoingNames: [], keptMineNames: [] };

describe('buildSyncOverview', () => {
  const synced = [col('A', [req('pay', 'a'), req('ord', 'a'), req('both', 'a')]), col('B', [req('x', 'a')])];
  const local = [col('A', [req('pay', 'a'), req('ord', 'mine'), req('both', 'mine')]), col('B', [req('x', 'a')])];
  const remote = [col('A', [req('pay', 'theirs'), req('ord', 'a'), req('both', 'theirs')]), col('B', [req('x', 'b')])];
  const result = rebaseCollections(local, remote, nodeHashes(synced), new Set(['A']));
  const overview = buildSyncOverview(result, { incomingNames: ['Dev › token'], outgoingNames: ['Dev › url'], keptMineNames: [] });

  it('separates what comes, what goes and what needs a decision', () => {
    expect(overview.incoming.map(i => i.id).sort()).toEqual(['pay', 'x']);
    expect(overview.outgoing.map(i => i.id)).toEqual(['ord']);
    expect(overview.conflicts.map(i => i.id)).toEqual(['both']);
    expect(overviewCounts(overview)).toEqual({ incoming: 3, outgoing: 2, conflicts: 1 });
  });

  it('keeps the root of each item, so the Central can filter by collection', () => {
    const onlyA = filterOverview(overview, { rootId: 'A' });
    expect(onlyA.incoming.map(i => i.id)).toEqual(['pay']);
    expect(onlyA.envIncoming).toEqual([]);
    expect(filterOverview(overview, { environmentName: 'Dev' }).envOutgoing).toEqual(['Dev › url']);
  });

  it('is empty when both sides match', () => {
    const same = rebaseCollections(synced, synced, nodeHashes(synced), new Set());
    expect(overviewCounts(buildSyncOverview(same, noEnv))).toEqual({ incoming: 0, outgoing: 0, conflicts: 0 });
  });
it('counts marker changes as incoming, only for the whole workspace', () => {
    const same = rebaseCollections(synced, synced, nodeHashes(synced), new Set());
    const withMarkers = buildSyncOverview(same, noEnv, undefined, { added: ['flaky'], changed: ['slow'], removed: [] });
    expect(overviewCounts(withMarkers)).toEqual({ incoming: 2, outgoing: 0, conflicts: 0 });
    // Marcador é do workspace: filtrada numa collection, a Central não o mostra.
    expect(overviewCounts(filterOverview(withMarkers, { rootId: 'A' })).incoming).toBe(0);
  });
});


describe('recorte numa pasta ou request', () => {
  const tree = col('A', [{ id: 'F', name: 'Flow', type: 'folder', item: [req('step1'), req('step2')] } as CollectionItem, req('other')]);

  it('namePathTo dá o caminho de nomes até o item', () => {
    expect(namePathTo(tree, 'step2')).toEqual(['A', 'Flow', 'step2']);
    expect(namePathTo(tree, 'A')).toEqual(['A']);
    expect(namePathTo(tree, 'nope')).toBeNull();
  });

  it('mostra a pasta e o que está dentro, inclusive o que é novo lá', () => {
    const item = (id: string, path: string[]) => ({ id, path, change: 'changed' as const, conflict: false, fields: [], rootId: 'A' });
    const overview = {
      incoming: [item('novo', ['A', 'Flow', 'novo'])],
      outgoing: [item('step1', ['A', 'Flow', 'step1']), item('other', ['A', 'other'])],
      conflicts: [],
      envIncoming: [],
      envOutgoing: [],
      envKeptMine: [],
      envSessionTokens: [],
      envValues: {},
      markers: { added: [], changed: [], removed: [] },
    };
    const onlyFlow = filterOverview(overview, { rootId: 'A', itemId: 'F', pathPrefix: ['A', 'Flow'] });
    expect(onlyFlow.outgoing.map(i => i.id)).toEqual(['step1']);
    expect(onlyFlow.incoming.map(i => i.id)).toEqual(['novo']);
  });
});
