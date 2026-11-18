import { describe, it, expect } from 'vitest';
import { moveNodes, moveNodesInto, restoreMoved, captureRemoval, rootIdOf, findNodeById, renameNode } from './tree.utils';
import { rangeIds, activeGuide } from './treeRows';
import type { CollectionItem } from '@/app/types/CollectionItem';

const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: id, type: 'folder', item: children }) as CollectionItem;
const request = (id: string): CollectionItem => ({ id, name: id, type: 'request' }) as CollectionItem;
const ids = (list: CollectionItem[] | undefined) => (list ?? []).map(i => i.id);

// colA[ a, b, c, sub[ d ] ], colB[ x ]
const tree = (): CollectionItem[] => [
  folder('colA', [request('a'), request('b'), request('c'), folder('sub', [request('d')])]),
  folder('colB', [request('x')]),
];

describe('moveNodes', () => {
  it('dentro de uma pasta: todos no fim, na ordem da árvore', () => {
    const next = moveNodes(tree(), ['c', 'a'], 'colB', 'inside');
    expect(ids(findNodeById(next, 'colB')!.item)).toEqual(['x', 'a', 'c']);
    expect(ids(findNodeById(next, 'colA')!.item)).toEqual(['b', 'sub']);
  });

  it('depois de um alvo: encadeados, sem inverter', () => {
    const next = moveNodes(tree(), ['a', 'b'], 'x', 'after');
    expect(ids(findNodeById(next, 'colB')!.item)).toEqual(['x', 'a', 'b']);
  });

  it('antes de um alvo', () => {
    const next = moveNodes(tree(), ['b', 'a'], 'x', 'before');
    expect(ids(findNodeById(next, 'colB')!.item)).toEqual(['a', 'b', 'x']);
  });

  it('pasta e filho dela: só a pasta vai, com o filho dentro', () => {
    const next = moveNodes(tree(), ['sub', 'd'], 'colB', 'inside');
    expect(ids(findNodeById(next, 'colB')!.item)).toEqual(['x', 'sub']);
    expect(ids(findNodeById(next, 'sub')!.item)).toEqual(['d']);
  });

  it('alvo dentro de um dos movidos: nada muda', () => {
    const items = tree();
    expect(moveNodes(items, ['sub', 'a'], 'd', 'after')).toBe(items);
  });

  it('o que não cabe no destino fica onde está', () => {
    // Request não vira collection: só a pasta sobe pra raiz.
    const next = moveNodes(tree(), ['a', 'sub'], 'colB', 'after');
    expect(ids(next)).toEqual(['colA', 'colB', 'sub']);
    expect(ids(findNodeById(next, 'colA')!.item)).toEqual(['a', 'b', 'c']);
  });
});

describe('restoreMoved', () => {
  it('desfaz um mover em grupo, cada um no lugar de antes', () => {
    const items = tree();
    const before = captureRemoval(items, ['a', 'c']);
    const moved = moveNodes(items, ['a', 'c'], 'colB', 'inside');
    const back = restoreMoved(moved, before);
    expect(ids(findNodeById(back, 'colA')!.item)).toEqual(['a', 'b', 'c', 'sub']);
    expect(ids(findNodeById(back, 'colB')!.item)).toEqual(['x']);
  });

  it('mantém o que foi editado depois de mover', () => {
    const items = tree();
    const before = captureRemoval(items, ['a']);
    const moved = renameNode(moveNodes(items, ['a'], 'colB', 'inside'), 'a', 'renamed');
    const back = restoreMoved(moved, before);
    expect(findNodeById(back, 'colA')!.item![0].name).toBe('renamed');
  });
});

describe('rootIdOf', () => {
  it('a collection de cada item', () => {
    expect(rootIdOf(tree(), 'd')).toBe('colA');
    expect(rootIdOf(tree(), 'colB')).toBe('colB');
    expect(rootIdOf(tree(), 'nope')).toBeNull();
  });
});

describe('rangeIds', () => {
  const rows = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  it('intervalo nos dois sentidos', () => {
    expect(rangeIds(rows, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(rows, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });
  it('sem âncora visível: só o clicado', () => {
    expect(rangeIds(rows, null, 'c')).toEqual(['c']);
    expect(rangeIds(rows, 'gone', 'c')).toEqual(['c']);
  });
});

describe('activeGuide', () => {
  // colA(aberta) > a, sub(aberta) > d ; colB
  const rows = [
    { depth: 0, isOpen: true },
    { depth: 1, isOpen: false },
    { depth: 1, isOpen: true },
    { depth: 2, isOpen: false },
    { depth: 0, isOpen: false },
  ];
  it('guia da pasta que contém a linha', () => {
    expect(activeGuide(rows, 1)).toEqual({ level: 0, start: 1, end: 4 });
    expect(activeGuide(rows, 3)).toEqual({ level: 1, start: 3, end: 4 });
  });
  it('pasta aberta: a guia dela mesma', () => {
    expect(activeGuide(rows, 2)).toEqual({ level: 1, start: 3, end: 4 });
  });
  it('raiz fechada: nenhuma', () => {
    expect(activeGuide(rows, 4)).toBeNull();
  });
});

describe('moveNodesInto (colar um recorte)', () => {
  it('no fim de uma pasta', () => {
    const next = moveNodesInto(tree(), ['a'], 'sub');
    expect(ids(findNodeById(next, 'sub')!.item)).toEqual(['d', 'a']);
  });
  it('na raiz só entra pasta', () => {
    const next = moveNodesInto(tree(), ['a', 'sub'], null);
    expect(ids(next)).toEqual(['colA', 'colB', 'sub']);
    expect(ids(findNodeById(next, 'colA')!.item)).toEqual(['a', 'b', 'c']);
  });
  it('pai que não existe: nada muda', () => {
    const items = tree();
    expect(moveNodesInto(items, ['a'], 'nope')).toBe(items);
  });
});
