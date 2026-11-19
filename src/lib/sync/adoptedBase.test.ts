import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import { adoptedRemoteBase, nodeHashes, type NodeHashes } from '@/lib/syncBase';
import { rebaseCollections } from './rebase';
import { adoptedRemoteEnvBase, environmentHashes, rebaseEnvironments } from './envMerge';

// O merge automático do push grava aqui o que veio do GitHub ANTES do commit.
// Se o commit falha (rede, cancelar, alguém enviando sem parar), o push
// seguinte parte dessa árvore — e a base tem que dizer que aquilo veio de lá.

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: `Request ${id}`,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});

const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: `Folder ${id}`, type: 'folder', item: children }) as CollectionItem;

const ids = (items: CollectionItem[]): string[] => items.flatMap(it => [it.id, ...ids(it.item ?? [])]);
const bodyOf = (items: CollectionItem[], id: string): string | undefined => {
  for (const it of items) {
    if (it.id === id) return it.request ? String(it.request.body) : undefined;
    const inner = bodyOf(it.item ?? [], id);
    if (inner !== undefined) return inner;
  }
  return undefined;
};

/** O que recordSyncBase grava com o resultado de adoptedRemoteBase. */
const apply = (base: NodeHashes, adopted: { hashes: NodeHashes; dropKeys: string[] }): NodeHashes => {
  const out = { ...base };
  for (const key of adopted.dropKeys) delete out[key];
  return { ...out, ...adopted.hashes };
};

const base0 = nodeHashes([folder('c', [req('a', 'a0'), req('b', 'b0')])]);

describe('adoptedRemoteBase', () => {
  it('a request the colleague created and then deleted does not come back after a failed push', () => {
    // Push 1: o colega criou z; o merge o traz pra cá. O commit falha.
    const local = [folder('c', [req('a', 'a-mine'), req('b', 'b0')])];
    const remote1 = [folder('c', [req('a', 'a0'), req('b', 'b0'), req('z', 'z0')])];
    const r1 = rebaseCollections(local, remote1, base0, new Set(['c']));
    expect(ids(r1.merged)).toContain('z');
    const base1 = apply(base0, adoptedRemoteBase(r1.merged, remote1, base0));

    // O colega apaga z. Push 2, a partir da árvore mesclada.
    const remote2 = [folder('c', [req('a', 'a0'), req('b', 'b0')])];
    const r2 = rebaseCollections(r1.merged, remote2, base1, new Set(['c']));
    expect(r2.conflicts).toEqual([]);
    expect(ids(r2.merged)).not.toContain('z');
    // E a sua mudança continua indo.
    expect(bodyOf(r2.merged, 'a')).toBe('a-mine');

    // Sem a base atualizada, z era lido como "novo aqui" e voltava pro GitHub.
    const stale = rebaseCollections(r1.merged, remote2, base0, new Set(['c']));
    expect(ids(stale.merged)).toContain('z');
  });

  it('a field the colleague changed twice is not a false conflict', () => {
    const local = [folder('c', [req('a', 'a-mine'), req('b', 'b0')])];
    const remote1 = [folder('c', [req('a', 'a0'), req('b', 'b1')])];
    const r1 = rebaseCollections(local, remote1, base0, new Set(['c']));
    const base1 = apply(base0, adoptedRemoteBase(r1.merged, remote1, base0));

    const remote2 = [folder('c', [req('a', 'a0'), req('b', 'b2')])];
    const r2 = rebaseCollections(r1.merged, remote2, base1, new Set(['c']));
    expect(r2.conflicts).toEqual([]);
    expect(bodyOf(r2.merged, 'b')).toBe('b2');
    expect(bodyOf(r2.merged, 'a')).toBe('a-mine');
  });

  it('never adopts what is still different here (your change stays yours)', () => {
    const merged = [folder('c', [req('a', 'a-mine'), req('b', 'b1')])];
    const remote = [folder('c', [req('a', 'a0'), req('b', 'b1')])];
    const { hashes } = adoptedRemoteBase(merged, remote, base0);
    expect(hashes.b).toBe(nodeHashes(remote).b);
    expect(hashes.a).toBeUndefined();
  });

  it('drops what was deleted on both sides, and leaves other collections alone', () => {
    const base = nodeHashes([folder('c', [req('a', 'a0'), req('b', 'b0')]), folder('o', [req('x', 'x0')])]);
    const merged = [folder('c', [req('a', 'a0')])];
    const remote = [folder('c', [req('a', 'a0')])];
    const { dropKeys } = adoptedRemoteBase(merged, remote, base);
    expect(dropKeys.length).toBeGreaterThan(0);
    expect(dropKeys.every(key => key === 'b' || key.startsWith('b#'))).toBe(true);
  });

  it('keeps the base of something you deleted here that GitHub still has', () => {
    const merged = [folder('c', [req('a', 'a0')])];
    const remote = [folder('c', [req('a', 'a0'), req('b', 'b0')])];
    expect(adoptedRemoteBase(merged, remote, base0).dropKeys).toEqual([]);
  });
});

const env = (vars: Record<string, string>, id = 'e1'): Environment => ({
  id,
  name: 'tst',
  values: Object.entries(vars).map(([key, value]) => ({ key, value, type: 'default', enabled: true })),
});
const valuesOf = (envs: Environment[]) => Object.fromEntries((envs[0]?.values ?? []).map(v => [v.key, v.value]));

describe('adoptedRemoteEnvBase', () => {
  it('a variable the colleague changed and then deleted is not pushed back after a failed push', () => {
    const base = environmentHashes([env({ baseUrl: 'https://tst', user: 'ana' })]);
    const local = [env({ baseUrl: 'https://tst', user: 'ana' })];
    const remote1 = [env({ baseUrl: 'https://tst', user: 'bia' })];
    const r1 = rebaseEnvironments(local, remote1, base);
    expect(valuesOf(r1.merged).user).toBe('bia');
    const base1 = apply(base, adoptedRemoteEnvBase(r1.merged, remote1, base));

    const remote2 = [env({ baseUrl: 'https://tst' })];
    const r2 = rebaseEnvironments(r1.merged, remote2, base1);
    expect(valuesOf(r2.merged)).toEqual({ baseUrl: 'https://tst' });
  });

  it('drops a variable deleted on both sides, only in environments present on both', () => {
    const base = environmentHashes([env({ baseUrl: 'https://tst', old: '1' }), env({ k: 'v' }, 'e2')]);
    const { dropKeys } = adoptedRemoteEnvBase([env({ baseUrl: 'https://tst' })], [env({ baseUrl: 'https://tst' })], base);
    expect(dropKeys).toEqual(['env:e1:old']);
  });
});
