import { describe, it, expect } from 'vitest';
import {
  moveNode,
  moveOut,
  canMoveOut,
  pasteNodes,
  pasteNodesBeside,
  canPlaceNode,
  resolvePasteParent,
  pruneExpandedIds,
} from './tree.utils';
import type { CollectionItem } from '@/app/types/CollectionItem';

// Árvore com uma request que tem Saved Examples — o caso que o arraste e o
// colar deixavam inconsistente (request dentro de request, example solto numa
// pasta).
const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: id, type: 'folder', item: children }) as CollectionItem;
const request = (id: string, examples: CollectionItem[] = []): CollectionItem =>
  ({ id, name: id, type: 'request', method: 'GET', ...(examples.length ? { item: examples } : {}) }) as CollectionItem;
const example = (id: string): CollectionItem =>
  ({ id, name: id, type: 'example' }) as CollectionItem;

const tree = (): CollectionItem[] => [
  folder('col', [
    request('login', [example('ex1'), example('ex2')]),
    request('quote'),
    folder('sub', [request('pay')]),
  ]),
];

const find = (items: CollectionItem[], id: string): CollectionItem | undefined => {
  for (const i of items) {
    if (i.id === id) return i;
    const deep = i.item && find(i.item, id);
    if (deep) return deep;
  }
};

describe('moveNode respeita request → examples', () => {
  it('não põe uma request entre os examples de outra (arrastar pra linha de um example)', () => {
    const items = tree();
    expect(moveNode(items, 'quote', 'ex1', 'after')).toBe(items);
    expect(find(items, 'login')!.item!.map(i => i.id)).toEqual(['ex1', 'ex2']);
  });

  it('não põe uma pasta entre os examples de uma request', () => {
    const items = tree();
    expect(moveNode(items, 'sub', 'ex2', 'before')).toBe(items);
  });

  it('não tira um example da request pra uma pasta', () => {
    const items = tree();
    expect(moveNode(items, 'ex1', 'quote', 'after')).toBe(items);
    expect(moveNode(items, 'ex1', 'sub', 'inside')).toBe(items);
  });

  it('ainda reordena examples dentro da mesma request', () => {
    const moved = moveNode(tree(), 'ex2', 'ex1', 'before');
    expect(find(moved, 'login')!.item!.map(i => i.id)).toEqual(['ex2', 'ex1']);
  });

  it('ainda move requests e pastas normalmente', () => {
    const moved = moveNode(tree(), 'quote', 'sub', 'inside');
    expect(find(moved, 'sub')!.item!.map(i => i.id)).toEqual(['pay', 'quote']);
  });
});

describe('mover pelo menu com examples', () => {
  it('"Move out" de um example fica desabilitado e não faz nada', () => {
    const items = tree();
    expect(canMoveOut(items, 'ex1')).toBe(false);
    expect(moveOut(items, 'ex1')).toBe(items);
  });

  it('"Move out" de uma request continua valendo', () => {
    expect(canMoveOut(tree(), 'pay')).toBe(true);
  });
});

describe('canPlaceNode', () => {
  it('example só dentro de request; o resto só na raiz ou numa pasta', () => {
    expect(canPlaceNode(request('r'), example('e'))).toBe(true);
    expect(canPlaceNode(folder('f'), example('e'))).toBe(false);
    expect(canPlaceNode(null, example('e'))).toBe(false);
    expect(canPlaceNode(request('r'), request('x'))).toBe(false);
    expect(canPlaceNode(folder('f'), request('x'))).toBe(true);
    expect(canPlaceNode(null, folder('x'))).toBe(true);
  });
});

describe('colar respeita request → examples', () => {
  it('colar requests ao lado de um example não as põe dentro da request', () => {
    const items = tree();
    expect(pasteNodesBeside(items, 'ex1', [request('new')], 'after')).toBe(items);
  });

  it('colar dentro de uma request descarta o que não é example', () => {
    const items = tree();
    const next = pasteNodes(items, 'login', [request('new'), example('ex3')]);
    expect(find(next, 'login')!.item!.map(i => i.id)).toEqual(['ex1', 'ex2', 'ex3']);
  });

  it('colar examples numa pasta descarta os examples', () => {
    const next = pasteNodes(tree(), 'sub', [example('ex3'), request('new')]);
    expect(find(next, 'sub')!.item!.map(i => i.id)).toEqual(['pay', 'new']);
  });
});

describe('resolvePasteParent', () => {
  const items = tree();
  it('sem alvo → raiz; pasta → ela mesma', () => {
    expect(resolvePasteParent(items, null, [request('n')])).toBe(null);
    expect(resolvePasteParent(items, find(items, 'sub')!, [request('n')])).toBe('sub');
  });

  it('request: requests viram irmãs; examples entram nela', () => {
    expect(resolvePasteParent(items, find(items, 'login')!, [request('n')])).toBe('col');
    expect(resolvePasteParent(items, find(items, 'login')!, [example('n')])).toBe('login');
  });

  it('example: requests vão pro lado da request dona; examples ficam na mesma request', () => {
    // Antes: colar sobre um example punha as requests DENTRO da request.
    expect(resolvePasteParent(items, find(items, 'ex1')!, [request('n')])).toBe('col');
    expect(resolvePasteParent(items, find(items, 'ex1')!, [example('n')])).toBe('login');
  });
});

describe('pruneExpandedIds', () => {
  it('tira só os ids que sumiram da árvore anterior, mantendo os de outro workspace', () => {
    const prev = tree();
    const next = moveNode(prev, 'quote', 'sub', 'inside').map(c => ({
      ...c,
      item: c.item!.filter(i => i.id !== 'sub'),
    }));
    // 'sub' foi apagada; 'other-ws' nunca esteve em nenhuma das duas árvores.
    const expanded = new Set(['col', 'sub', 'other-ws']);
    expect([...pruneExpandedIds(expanded, prev, next)].sort()).toEqual(['col', 'other-ws']);
  });

  it('troca de workspace (nenhuma raiz em comum) não apaga nada', () => {
    const expanded = new Set(['col', 'login']);
    const other = [folder('ws2', [request('x')])];
    expect(pruneExpandedIds(expanded, tree(), other)).toBe(expanded);
  });

  it('árvore ainda vazia (carregando) não apaga nada', () => {
    const expanded = new Set(['col']);
    expect(pruneExpandedIds(expanded, tree(), [])).toBe(expanded);
    expect(pruneExpandedIds(expanded, [], tree())).toBe(expanded);
  });
});
