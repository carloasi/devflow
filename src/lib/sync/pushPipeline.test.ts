import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import { dropReplaced, nodeHashes } from '@/lib/syncBase';
import { environmentHashes } from './envMerge';
import { baseAfterPush, preparePush, type PreparePushInput } from './pushPipeline';

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});
const col = (id: string, children: CollectionItem[]): CollectionItem => ({ id, name: id, type: 'folder', item: children });
const env = (vars: Record<string, string>, id = 'e1'): Environment => ({
  id,
  name: id,
  values: Object.entries(vars).map(([key, value]) => ({ key, value, enabled: true, type: 'default' })),
});
const bodyOf = (tree: CollectionItem[], rootId: string, id: string) =>
  tree.find(c => c.id === rootId)?.item?.find(i => i.id === id)?.request?.body;

// Última sincronização: c1 (a, b), c2 (x), environment e1.
const syncedCols = [col('c1', [req('a', 'a0'), req('b', 'b0')]), col('c2', [req('x', 'x0')])];
const syncedEnvs = [env({ url: 'u0', user: 'ana' })];
const base = { ...nodeHashes(syncedCols), ...environmentHashes(syncedEnvs) };

function input(over: Partial<PreparePushInput>): PreparePushInput {
  return {
    scope: { kind: 'workspace' },
    mode: 'normal',
    local: { collections: syncedCols, environments: syncedEnvs },
    remote: { collections: syncedCols, environments: syncedEnvs },
    base,
    pendingCollectionIds: new Set(['c1']),
    ...over,
  };
}

describe('preparePush — workspace', () => {
  it('your change goes up over GitHub, theirs comes in, no review', () => {
    const local = [col('c1', [req('a', 'a-mine'), req('b', 'b0')]), col('c2', [req('x', 'x0')])];
    const remote = [col('c1', [req('a', 'a0'), req('b', 'b-theirs')]), col('c2', [req('x', 'x-theirs')])];
    const p = preparePush(input({ local: { collections: local, environments: syncedEnvs }, remote: { collections: remote, environments: syncedEnvs } }));
    expect(p.status).toBe('ready');
    if (p.status !== 'ready') return;
    expect(bodyOf(p.send.collections, 'c1', 'a')).toBe('a-mine');
    expect(bodyOf(p.send.collections, 'c1', 'b')).toBe('b-theirs');
    expect(bodyOf(p.send.collections, 'c2', 'x')).toBe('x-theirs');
    expect(p.localNext.collections).not.toBeNull();
    // A base passa a conhecer o que veio de lá (b e x), não o seu a.
    expect(p.baseAdopt.hashes.b).toBe(nodeHashes(remote).b);
    expect(p.baseAdopt.hashes.a).toBeUndefined();
  });

  it('the same item changed on both sides opens the review', () => {
    const local = [col('c1', [req('a', 'a-mine'), req('b', 'b0')]), col('c2', [req('x', 'x0')])];
    const remote = [col('c1', [req('a', 'a-theirs'), req('b', 'b0')]), col('c2', [req('x', 'x0')])];
    const p = preparePush(input({ local: { collections: local, environments: syncedEnvs }, remote: { collections: remote, environments: syncedEnvs } }));
    expect(p).toMatchObject({ status: 'review', conflicts: ['a'] });
  });

  it('environments are merged variable by variable', () => {
    const local = [env({ url: 'u0', user: 'bia' })];
    const remote = [env({ url: 'u1', user: 'ana' })];
    const p = preparePush(input({ local: { collections: syncedCols, environments: local }, remote: { collections: syncedCols, environments: remote } }));
    expect(p.status).toBe('ready');
    if (p.status !== 'ready') return;
    expect(Object.fromEntries(p.send.environments[0].values.map(v => [v.key, v.value]))).toEqual({ url: 'u1', user: 'bia' });
  });

  it('reviewed: collections go as decided, without a new merge', () => {
    const local = [col('c1', [req('a', 'decided'), req('b', 'b0')]), col('c2', [req('x', 'x0')])];
    const remote = [col('c1', [req('a', 'a-theirs'), req('b', 'b0')]), col('c2', [req('x', 'x0')])];
    const p = preparePush(input({ mode: 'reviewed', local: { collections: local, environments: syncedEnvs }, remote: { collections: remote, environments: syncedEnvs } }));
    expect(p.status).toBe('ready');
    if (p.status !== 'ready') return;
    expect(bodyOf(p.send.collections, 'c1', 'a')).toBe('decided');
  });

  it('force: yours, as it is', () => {
    const local = [col('c1', [req('a', 'mine'), req('b', 'b0')])];
    const remote = [col('c1', [req('a', 'theirs'), req('b', 'b0')])];
    const p = preparePush(input({ mode: 'force', local: { collections: local, environments: [] }, remote: { collections: remote, environments: [] } }));
    expect(p.status === 'ready' && p.send.collections).toEqual(local);
  });
});

describe('preparePush — one collection', () => {
  it('only that collection goes up and changes here; the others are untouched', () => {
    const local = [col('c1', [req('a', 'a-mine'), req('b', 'b0')]), col('c2', [req('x', 'x0')])];
    const remote = [col('c1', [req('a', 'a0'), req('b', 'b-theirs')]), col('c2', [req('x', 'x-theirs')])];
    const p = preparePush(input({ scope: { kind: 'collection', rootId: 'c1' }, local: { collections: local, environments: syncedEnvs }, remote: { collections: remote, environments: syncedEnvs } }));
    expect(p.status).toBe('ready');
    if (p.status !== 'ready') return;
    expect(p.send.collections.map(c => c.id)).toEqual(['c1']);
    expect(bodyOf(p.send.collections, 'c1', 'b')).toBe('b-theirs');
    expect(bodyOf(p.localNext.collections!, 'c2', 'x')).toBe('x0');
    expect(p.send.environments).toEqual([]);
  });

  it('a conflict in ANOTHER collection does not block it', () => {
    const local = [col('c1', [req('a', 'a-mine'), req('b', 'b0')]), col('c2', [req('x', 'x-mine')])];
    const remote = [col('c1', [req('a', 'a0'), req('b', 'b0')]), col('c2', [req('x', 'x-theirs')])];
    const p = preparePush(input({ scope: { kind: 'collection', rootId: 'c1' }, pendingCollectionIds: new Set(['c1', 'c2']), local: { collections: local, environments: syncedEnvs }, remote: { collections: remote, environments: syncedEnvs } }));
    expect(p.status).toBe('ready');
  });
});

describe('preparePush — one item', () => {
  it("GitHub's collection with only the item swapped; a conflict outside it is ignored", () => {
    const local = [col('c1', [req('a', 'a-mine'), req('b', 'b-mine')]), col('c2', [req('x', 'x0')])];
    const remote = [col('c1', [req('a', 'a-theirs'), req('b', 'b0')]), col('c2', [req('x', 'x0')])];
    const p = preparePush(input({ scope: { kind: 'item', rootId: 'c1', itemId: 'b' }, local: { collections: local, environments: syncedEnvs }, remote: { collections: remote, environments: syncedEnvs } }));
    expect(p.status).toBe('ready');
    if (p.status !== 'ready') return;
    expect(bodyOf(p.send.collections, 'c1', 'b')).toBe('b-mine');
    expect(bodyOf(p.send.collections, 'c1', 'a')).toBe('a-theirs');
  });

  it('after the push, the conflict outside the item is NOT marked as synced', () => {
    const local = [col('c1', [req('a', 'a-mine'), req('b', 'b-mine')])];
    const sent = [col('c1', [req('a', 'a-theirs'), req('b', 'b-mine')])];
    const after = baseAfterPush({ scope: { kind: 'item', rootId: 'c1', itemId: 'b' }, local: { collections: local, environments: [] }, sent: { collections: sent, environments: [] }, base });
    expect(after.hashes.b).toBe(nodeHashes(sent).b);
    expect(after.hashes.a).toBeUndefined();
  });

  it('a conflict inside the item opens the review', () => {
    const local = [col('c1', [req('a', 'a0'), req('b', 'b-mine')])];
    const remote = [col('c1', [req('a', 'a0'), req('b', 'b-theirs')])];
    const p = preparePush(input({ scope: { kind: 'item', rootId: 'c1', itemId: 'b' }, local: { collections: local, environments: [] }, remote: { collections: remote, environments: [] } }));
    expect(p).toMatchObject({ status: 'review', conflicts: ['b'] });
  });
});

describe('preparePush — one environment', () => {
  it('merges only that environment; a variable they changed comes in', () => {
    const local = [env({ url: 'u0', user: 'bia' }), env({ k: 'v' }, 'e2')];
    const remote = [env({ url: 'u1', user: 'ana' })];
    const p = preparePush(input({ scope: { kind: 'environment', envId: 'e1' }, local: { collections: syncedCols, environments: local }, remote: { collections: syncedCols, environments: remote } }));
    expect(p.status).toBe('ready');
    if (p.status !== 'ready') return;
    expect(p.send.environments).toHaveLength(1);
    expect(Object.fromEntries(p.send.environments[0].values.map(v => [v.key, v.value]))).toEqual({ url: 'u1', user: 'bia' });
    expect(p.localNext.environments!.find(e => e.id === 'e2')).toEqual(local[1]);
  });

  it('a missing environment sends nothing', () => {
    expect(preparePush(input({ scope: { kind: 'environment', envId: 'nope' } })).status).toBe('nothing');
  });
});

describe('baseAfterPush — one environment', () => {
  // Ids gerados pela posição no arquivo: #1 é prefixo de #10…#19.
  it("pushing environment #1 does not drop the base of #10", () => {
    const one = env({ a: '1' }, 'gh-env:Postman/W/environments/all.json#1');
    const ten = env({ token: 't' }, 'gh-env:Postman/W/environments/all.json#10');
    const base = environmentHashes([one, ten]);
    const after = baseAfterPush({
      scope: { kind: 'environment', envId: one.id },
      local: { collections: [], environments: [one, ten] },
      sent: { collections: [], environments: [env({ a: '2' }, one.id)] },
      base,
    });
    const next = { ...dropReplaced(base, after.replacePrefixes, after.replaceRoots), ...after.hashes };
    expect(next[`env:${ten.id}`]).toBe(base[`env:${ten.id}`]);
    expect(next[`env:${ten.id}:token`]).toBe(base[`env:${ten.id}:token`]);
    expect(next[`env:${one.id}:a`]).not.toBe(base[`env:${one.id}:a`]);
  });

  it("a variable gone from the pushed environment leaves its base", () => {
    const before = env({ a: '1', old: 'x' });
    const base = environmentHashes([before]);
    const after = baseAfterPush({
      scope: { kind: 'environment', envId: 'e1' },
      local: { collections: [], environments: [env({ a: '1' })] },
      sent: { collections: [], environments: [env({ a: '1' })] },
      base,
    });
    const next = { ...dropReplaced(base, after.replacePrefixes, after.replaceRoots), ...after.hashes };
    expect(next['env:e1:old']).toBeUndefined();
    expect(next['env:e1']).toBe('1');
  });
});

// Workspace apagado do GitHub e mantido aqui (handleRemoteWorkspaceDeleted).
describe('preparePush — after the workspace was deleted from GitHub', () => {
  const empty = { collections: [] as CollectionItem[], environments: [] as Environment[] };

  it("with the old base, the push would remove everything here (why the base is forgotten)", () => {
    const out = preparePush(input({ remote: empty, pendingCollectionIds: new Set() }));
    expect(out.status).toBe('ready');
    if (out.status !== 'ready') return;
    expect(out.localNext.collections).toEqual([]);
  });

  it("with the base forgotten, everything here stays and is sent", () => {
    const out = preparePush(input({ remote: empty, base: null, pendingCollectionIds: new Set(['c1', 'c2']) }));
    expect(out.status).toBe('ready');
    if (out.status !== 'ready') return;
    expect(out.localNext.collections).toBeNull();
    expect(out.send.collections.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(out.send.environments.map(e => e.id)).toEqual(['e1']);
  });
});

