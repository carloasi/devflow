import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import { adoptedRemoteBase, nodeHashes, type NodeHashes } from '@/lib/syncBase';
import { rebaseCollections } from './rebase';
import { withSubtreeFrom } from './subtreePush';
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

  it('pushing ONE item keeps a conflict outside it as a conflict', () => {
    // Você e o colega mudaram a; você envia só b ("Push deste item").
    const local = [folder('c', [req('a', 'a-mine'), req('b', 'b-mine')])];
    const remote = [folder('c', [req('a', 'a-theirs'), req('b', 'b0')])];
    const r = rebaseCollections(local, remote, base0, new Set(['c']));
    expect(r.conflicts).toEqual(['a']);
    const mergedRoot = r.merged[0];
    const toSend = withSubtreeFrom(remote[0], mergedRoot, 'b')!;
    expect(bodyOf([toSend], 'a')).toBe('a-theirs');
    expect(bodyOf([toSend], 'b')).toBe('b-mine');

    // Depois do envio, o próximo push do workspace ainda pergunta sobre a.
    const after = apply(base0, adoptedRemoteBase([mergedRoot], [toSend], base0));
    expect(rebaseCollections([mergedRoot], [toSend], after, new Set(['c'])).conflicts).toEqual(['a']);

    // Gravando o GitHub inteiro como base (o de antes), a virava "só sua" e
    // ia por cima da do colega sem revisão.
    const old = nodeHashes([toSend]);
    const silent = rebaseCollections([mergedRoot], [toSend], old, new Set(['c']));
    expect(silent.conflicts).toEqual([]);
    expect(bodyOf(silent.merged, 'a')).toBe('a-mine');
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

  // O mesmo "tst" criado aqui (e1) e no GitHub (gh-1): casados pelo nome. A
  // base (gravada num pull) o conhece pelo id de lá.
  it("an environment matched only by name has its base updated too", () => {
    const base = environmentHashes([env({ baseUrl: 'https://tst', user: 'ana' }, 'gh-1')]);
    const local = [env({ baseUrl: 'https://tst', user: 'ana' }, 'e1')];
    const remote1 = [env({ baseUrl: 'https://tst', user: 'bia' }, 'gh-1')];
    const r1 = rebaseEnvironments(local, remote1, base);
    expect(valuesOf(r1.merged).user).toBe('bia');
    const adopted = adoptedRemoteEnvBase(r1.merged, remote1, base);
    expect(Object.keys(adopted.hashes)).toEqual(['env:gh-1:user']);
    const base1 = apply(base, adopted);

    // O push falhou; o colega apagou a variável. O push seguinte não a
    // devolve — com a base antiga, "bia" contra a base "ana" era sua.
    const remote2 = [env({ baseUrl: 'https://tst' }, 'gh-1')];
    const r2 = rebaseEnvironments(r1.merged, remote2, base1);
    expect(valuesOf(r2.merged)).toEqual({ baseUrl: 'https://tst' });
  });

  it("deleted on both sides is dropped also for an environment matched by name", () => {
    const base = environmentHashes([env({ baseUrl: 'https://tst', old: '1' }, 'gh-1')]);
    const { dropKeys } = adoptedRemoteEnvBase([env({ baseUrl: 'https://tst' }, 'e1')], [env({ baseUrl: 'https://tst' }, 'gh-1')], base);
    expect(dropKeys).toEqual(['env:gh-1:old']);
  });

  it("with no base for either id, the keys go under the local id (the one pushed)", () => {
    const { hashes } = adoptedRemoteEnvBase([env({ a: '1' }, 'e1')], [env({ a: '1' }, 'gh-1')], {});
    expect(Object.keys(hashes).sort()).toEqual(['env:e1', 'env:e1:a']);
  });
});
