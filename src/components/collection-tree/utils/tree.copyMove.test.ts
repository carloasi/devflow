import { describe, it, expect } from 'vitest';
import {
  canDropAt,
  canMoveOut,
  moveOut,
  moveNode,
  pasteNodes,
  pasteNodesBeside,
  resolvePasteParent,
  cloneItemWithNewIds,
  duplicateNode,
  findNodeById,
  topLevelInTreeOrder,
} from './tree.utils';
import type { CollectionItem } from '@/app/types/CollectionItem';

const folder = (id: string, children: CollectionItem[] = [], extra: Partial<CollectionItem> = {}): CollectionItem =>
  ({ id, name: id, type: 'folder', item: children, ...extra }) as CollectionItem;
const request = (id: string): CollectionItem => ({ id, name: id, type: 'request' }) as CollectionItem;

// Duas collections na raiz; "auth" é request direto dentro da primeira.
const tree = (): CollectionItem[] => [
  folder('colA', [request('auth'), folder('sub', [request('deep')])]),
  folder('colB', [request('b1')]),
];

describe('a raiz só tem collections (pastas)', () => {
  it('"Move out" de uma request direto na collection fica desabilitado', () => {
    expect(canMoveOut(tree(), 'auth')).toBe(false);
    const items = tree();
    expect(moveOut(items, 'auth')).toBe(items);
  });

  it('"Move out" de dentro de uma subpasta continua valendo', () => {
    expect(canMoveOut(tree(), 'deep')).toBe(true);
  });

  it('arrastar uma request pro nível das collections é recusado', () => {
    const items = tree();
    expect(canDropAt(items, 'auth', 'colA', 'after')).toBe(false);
    expect(moveNode(items, 'auth', 'colB', 'before')).toBe(items);
  });

  it('pasta ainda pode virar collection', () => {
    expect(canDropAt(tree(), 'sub', 'colA', 'after')).toBe(true);
  });

  it('colar request sem alvo (raiz) não cria request solta', () => {
    const items = tree();
    expect(pasteNodes(items, null, [request('new')])).toBe(items);
    expect(pasteNodesBeside(items, 'colB', [request('new')], 'after')).toBe(items);
  });

  it('colar sobre uma collection põe dentro dela', () => {
    const items = tree();
    expect(resolvePasteParent(items, items[0], [request('new')])).toBe('colA');
  });
});

describe('copiar uma seleção', () => {
  it('pasta e filho dela selecionados: copia só a pasta, sem duplicar o filho', () => {
    const items = tree();
    expect(topLevelInTreeOrder(items, ['deep', 'sub']).map(n => n.id)).toEqual(['sub']);
  });

  it('vem na ordem da árvore, não na ordem dos cliques', () => {
    const items = tree();
    expect(topLevelInTreeOrder(items, ['b1', 'auth', 'gone']).map(n => n.id)).toEqual(['auth', 'b1']);
  });
});

describe('cópia não herda favorito', () => {
  it('colar/duplicar uma pasta favorita não cria outro favorito', () => {
    const fav = folder('fav', [folder('inner', [], { starred: true })], { starred: true, starredAfterId: 'x' });
    const clone = cloneItemWithNewIds(fav);
    expect(clone.starred).toBeUndefined();
    expect(clone.starredAfterId).toBeUndefined();
    expect(clone.item![0].starred).toBeUndefined();

    const items = [folder('col', [fav])];
    const dup = duplicateNode(items, 'fav');
    const col = findNodeById(dup, 'col')!;
    expect(col.item!.filter(i => i.starred).length).toBe(1);
  });
});
