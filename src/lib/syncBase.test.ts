import { describe, it, expect } from 'vitest';
import { nodeHashes, changedSinceBase, changedInSubtree, dropReplaced, pickNodeHashes, reviewedBase } from './syncBase';
import { rebaseCollections } from './sync/rebase';
import type { CollectionItem } from '@/app/types/CollectionItem';

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: `Request ${id}`,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});

const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: `Folder ${id}`, type: 'folder', item: children }) as CollectionItem;

describe('nodeHashes', () => {
  it('cobre pastas e requests em profundidade', () => {
    const tree = [folder('c', [folder('f', [req('r')])])];
    // Fora as chaves por campo (id#campo), uma por nó.
    expect(Object.keys(nodeHashes(tree)).filter(k => !k.includes('#')).sort()).toEqual(['c', 'f', 'r']);
  });

  // A pergunta é "este nó mudou", e o conteúdo nunca sai daqui.
  it('o hash muda com o conteúdo', () => {
    expect(nodeHashes([req('r', 'a')]).r).not.toBe(nodeHashes([req('r', 'b')]).r);
  });

  it('mesmo conteúdo, mesmo hash', () => {
    expect(nodeHashes([req('r', 'a')]).r).toBe(nodeHashes([req('r', 'a')]).r);
  });

  // Incluir os filhos faria toda pasta de um fluxo "mudar" quando uma request
  // lá dentro mudasse, e ela apareceria como conflito sem ninguém tocá-la.
  it('a pasta não muda quando um filho muda', () => {
    const antes = nodeHashes([folder('f', [req('r', 'a')])]);
    const depois = nodeHashes([folder('f', [req('r', 'b')])]);
    expect(depois.f).toBe(antes.f);
    expect(depois.r).not.toBe(antes.r);
  });

  // Mesma regra do diff: ordem de chave e id gerado não são conteúdo.
  it('ignora o que a normalização ignora', () => {
    const a = { ...req('r'), request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [{ id: 'local', key: 'a', value: '1', enabled: true }], body: '' } } as unknown as CollectionItem;
    const b = { ...req('r'), request: { urlexport: { raw: '/x', host: [], path: [] }, url: '/x', body: '', headers: [{ enabled: true, value: '1', key: 'a', id: 'remoto' }] } } as unknown as CollectionItem;
    expect(nodeHashes([a]).r).toBe(nodeHashes([b]).r);
  });

  it('favorito não conta', () => {
    const comEstrela = { ...req('r'), starred: true } as CollectionItem;
    expect(nodeHashes([comEstrela]).r).toBe(nodeHashes([req('r')]).r);
  });

  it('aceita nulo', () => {
    expect(nodeHashes(null)).toEqual({});
  });
});

describe('dropReplaced', () => {
  const old = {
    ...nodeHashes([folder('c1', [req('a'), req('apagada')]), folder('c2', [req('b')])]),
    'env:e1': '1',
    'env:e1:token': 'x',
  };
  const keysOf = (base: Record<string, string>, id: string) => Object.keys(base).filter(k => k === id || k.startsWith(`${id}#`));

  it('substituir UMA collection tira os itens dela, inclusive os que sumiram', () => {
    const out = dropReplaced(old, [], ['c1']);
    expect(keysOf(out, 'c1')).toEqual([]);
    expect(keysOf(out, 'apagada')).toEqual([]);
    expect(keysOf(out, 'b').length).toBeGreaterThan(0); // c2 fica
    expect(out['env:e1']).toBe('1');
  });

  it("'all' tira todas as collections e mantém os environments", () => {
    const out = dropReplaced(old, [], 'all');
    expect(Object.keys(out).sort()).toEqual(['env:e1', 'env:e1:token']);
  });

  // O bug: um item apagado continuava na base; se alguém o restaurasse no
  // GitHub, o merge o lia como "apagado aqui" e o push desfazia a restauração.
  it('depois de substituir, um item restaurado lá volta a ser "novo no GitHub"', () => {
    const afterDeletion = { ...dropReplaced(old, [], ['c1']), ...nodeHashes([folder('c1', [req('a')])]) };
    expect(afterDeletion['apagada']).toBeUndefined();
  });
});

describe('changedInSubtree', () => {
  const base = nodeHashes([folder('c', [folder('f', [req('r', 'a')])])]);

  it('vê mudança num neto', () => {
    expect(changedInSubtree(base, folder('c', [folder('f', [req('r', 'b')])]))).toBe(true);
  });

  it('vê item criado lá dentro depois da base', () => {
    expect(changedInSubtree(base, folder('c', [folder('f', [req('r', 'a'), req('novo')])]))).toBe(true);
  });

  it('nada mudou embaixo', () => {
    expect(changedInSubtree(base, folder('c', [folder('f', [req('r', 'a')])]))).toBe(false);
  });

  it('sem base, não afirma nada', () => {
    expect(changedInSubtree(null, folder('c', [req('r')]))).toBe(false);
  });
});

describe('changedSinceBase', () => {
  const base = nodeHashes([req('r', 'original')]);

  it('intocado desde a base', () => {
    expect(changedSinceBase(base, 'r', req('r', 'original'))).toBe(false);
  });

  it('alterado desde a base', () => {
    expect(changedSinceBase(base, 'r', req('r', 'editado'))).toBe(true);
  });

  // Nó que a base não conhece foi criado depois dela — é trabalho local.
  it('nó novo conta como alterado', () => {
    expect(changedSinceBase(base, 'novo', req('novo'))).toBe(true);
  });

  // Sem base não há como saber quem mexeu: quem chama decide o que fazer.
  it('sem base devolve null em vez de chutar', () => {
    expect(changedSinceBase(null, 'r', req('r'))).toBeNull();
  });
});

describe('reviewedBase', () => {
  // Aqui: A e B como na última sincronização. No GitHub, o colega mudou B.
  const local = [folder('A', [req('a', 'a')]), folder('B', [req('b', 'old')])];
  const remote = [folder('A', [req('a', 'a2')]), folder('B', [req('b', 'new-by-teammate')])];
  const synced = nodeHashes(local);

  it('revisão de UMA collection grava só a base dela — o push seguinte não desfaz o colega na outra', () => {
    const reviewed = reviewedBase(remote, { rootIds: ['A'] });
    expect(reviewed.replaceRoots).toEqual(['A']);
    const base = { ...dropReplaced(synced, [], reviewed.replaceRoots), ...reviewed.hashes };
    // A mudança de B no GitHub continua "nova lá": o merge do push a traz.
    const r = rebaseCollections(local, remote, base, new Set());
    const b = r.merged.find(c => c.id === 'B')!;
    expect(b.item![0].request!.body).toBe('new-by-teammate');
  });

  it('revisão do workspace inteiro substitui a base toda', () => {
    expect(reviewedBase(remote, 'all')).toEqual({ hashes: nodeHashes(remote), replaceRoots: 'all' });
  });

  it('revisão de uma subpasta soma só os itens revisados', () => {
    const reviewed = reviewedBase(remote, { nodeIds: ['a'] });
    expect(reviewed.replaceRoots).toEqual([]);
    expect(Object.keys(reviewed.hashes).every(k => k === 'a' || k.startsWith('a#'))).toBe(true);
    expect(reviewed.hashes.a).toBe(nodeHashes(remote).a);
  });
});

describe('pickNodeHashes', () => {
  it('keeps the node and its per-field keys only', () => {
    expect(pickNodeHashes({ a: '1', 'a#body': '2', ab: '3', 'b#body': '4' }, new Set(['a']))).toEqual({ a: '1', 'a#body': '2' });
  });
});

describe('dropReplaced com a base dos marcadores', () => {
  it("substituir as collections ('all') não apaga a base de environments nem a de marcadores", () => {
    const current = { a: '1', 'a#body': '2', 'env:e1': '1', 'marker:m1': '["x","#fff"]' };
    expect(dropReplaced(current, [], 'all')).toEqual({ 'env:e1': '1', 'marker:m1': '["x","#fff"]' });
  });

  it('o prefixo marker: substitui só a base dos marcadores', () => {
    const current = { a: '1', 'marker:m1': 'x', 'marker:m2': 'y' };
    expect(dropReplaced(current, ['marker:'], [])).toEqual({ a: '1' });
  });
});
