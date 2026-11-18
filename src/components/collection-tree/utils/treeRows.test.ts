import { describe, it, expect } from 'vitest';
import {
  flattenVisibleTree,
  visibleRange,
  scrollTopToReveal,
  findTypeAheadMatch,
} from './treeRows';
import type { CollectionItem } from '@/app/types/CollectionItem';

const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: id, type: 'folder', item: children }) as CollectionItem;
const request = (id: string, examples: CollectionItem[] = []): CollectionItem =>
  ({ id, name: id, type: 'request', ...(examples.length ? { item: examples } : {}) }) as CollectionItem;
const example = (id: string): CollectionItem => ({ id, name: id, type: 'example' }) as CollectionItem;

const tree = (): CollectionItem[] => [
  folder('a', [request('a1', [example('e1')]), folder('a2', [request('a21')])]),
  folder('b'),
];

describe('flattenVisibleTree', () => {
  it('só desce no que está aberto, na ordem da tela', () => {
    const rows = flattenVisibleTree(tree(), new Set(['a']));
    expect(rows.map(r => [r.item.id, r.depth])).toEqual([['a', 0], ['a1', 1], ['a2', 1], ['b', 0]]);
  });

  it('marca o que pode abrir: pasta (mesmo vazia) e request com examples', () => {
    const rows = flattenVisibleTree(tree(), new Set(['a', 'a1', 'a2']));
    const byId = Object.fromEntries(rows.map(r => [r.item.id, r]));
    expect(byId.b.hasChildren).toBe(true);
    expect(byId.a1.hasChildren).toBe(true);
    expect(byId.a21.hasChildren).toBe(false);
    expect(byId.e1.depth).toBe(2);
    expect(byId.a21.parentId).toBe('a2');
  });

  it('posição entre irmãos pro aria', () => {
    const rows = flattenVisibleTree(tree(), new Set(['a']));
    expect(rows.map(r => `${r.posInSet}/${r.setSize}`)).toEqual(['1/2', '1/2', '2/2', '2/2']);
  });

  it('id aberto que não pode abrir (request sem example) não desce', () => {
    const rows = flattenVisibleTree(tree(), new Set(['a', 'a2', 'a21']));
    expect(rows.map(r => r.item.id)).toEqual(['a', 'a1', 'a2', 'a21', 'b']);
  });
});

describe('visibleRange', () => {
  it('janela do scroll mais a folga, presa aos limites', () => {
    expect(visibleRange(0, 220, 1000, 22, 5)).toEqual({ start: 0, end: 15 });
    expect(visibleRange(2200, 220, 1000, 22, 5)).toEqual({ start: 95, end: 115 });
    expect(visibleRange(21_900, 220, 1000, 22, 5)).toEqual({ start: 990, end: 1000 });
  });

  it('lista vazia ou menor que a janela', () => {
    expect(visibleRange(0, 500, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(0, 500, 3)).toEqual({ start: 0, end: 3 });
  });
});

describe('scrollTopToReveal', () => {
  it('não mexe se a linha já está inteira à vista', () => {
    expect(scrollTopToReveal(5, 0, 220, 22)).toBeNull();
  });
  it('sobe até a linha quando ela está acima', () => {
    expect(scrollTopToReveal(2, 100, 220, 22)).toBe(44);
  });
  it('desce o mínimo quando ela está abaixo', () => {
    expect(scrollTopToReveal(20, 0, 220, 22)).toBe(242);
  });
});

describe('findTypeAheadMatch', () => {
  const rows = ['Auth', 'Booking', 'Bags', 'Payments', 'bundle'].map(name => ({ id: name, name }));

  it('acha o próximo que começa com o prefixo, sem diferenciar maiúsculas', () => {
    expect(findTypeAheadMatch(rows, 0, 'p')).toBe(3);
    expect(findTypeAheadMatch(rows, -1, 'BO')).toBe(1);
  });

  it('a mesma letra repetida percorre os itens e dá a volta', () => {
    expect(findTypeAheadMatch(rows, 1, 'b')).toBe(2);
    expect(findTypeAheadMatch(rows, 2, 'bb')).toBe(4);
    expect(findTypeAheadMatch(rows, 4, 'bbb')).toBe(1);
  });

  it('prefixo maior fica na linha atual enquanto ela casa', () => {
    expect(findTypeAheadMatch(rows, 2, 'ba')).toBe(2);
  });

  it('sem resultado', () => {
    expect(findTypeAheadMatch(rows, 0, 'z')).toBe(-1);
  });
});
