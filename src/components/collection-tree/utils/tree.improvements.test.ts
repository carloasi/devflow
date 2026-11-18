import { describe, it, expect } from 'vitest';
import {
  filterTree,
  captureRemoval,
  restoreRemoved,
  removeNode,
  moveNode,
  positionOf,
  restorePosition,
  renameNode,
} from './tree.utils';
import type { CollectionItem } from '@/app/types/CollectionItem';

const folder = (id: string, children: CollectionItem[] = [], name = id): CollectionItem =>
  ({ id, name, type: 'folder', item: children }) as CollectionItem;
const request = (id: string, name = id, examples: CollectionItem[] = []): CollectionItem =>
  ({ id, name, type: 'request', method: 'POST', ...(examples.length ? { item: examples } : {}) }) as CollectionItem;
const example = (id: string, name = id): CollectionItem =>
  ({ id, name, type: 'example' }) as CollectionItem;

const ids = (items: CollectionItem[]): string[] =>
  items.flatMap(i => [i.id, ...(i.item ? ids(i.item) : [])]);

const tree = (): CollectionItem[] => [
  folder('col', [
    folder('pay', [request('create', 'Create'), request('list', 'List')], 'Order.Groups.Payments'),
    folder('quote', [request('qcreate', 'Create'), request('ex', 'Export', [example('e1', 'Payments sample')])], 'Quote.Groups'),
  ], 'Portal de Grupos B2B'),
];

describe('filterTree com o caminho de pastas', () => {
  it('um termo na pasta e outro na request acha a request', () => {
    // Antes os dois termos tinham que estar no nome da request.
    const out = filterTree(tree(), 'payments create');
    expect(ids(out)).toEqual(['col', 'pay', 'create']);
  });

  it('a request de mesmo nome em outra pasta não entra', () => {
    expect(ids(filterTree(tree(), 'payments create'))).not.toContain('qcreate');
  });

  it('termo só no nome da pasta continua mostrando a pasta inteira', () => {
    expect(ids(filterTree(tree(), 'payments'))).toEqual(['col', 'pay', 'create', 'list', 'quote', 'ex', 'e1']);
  });

  it('nome de request não qualifica os examples dela', () => {
    // "export payments": o example casa "payments", a request casa "export" —
    // mas o nome da request não passa pros examples, então não basta.
    expect(ids(filterTree(tree(), 'export sample'))).toEqual([]);
  });

  it('keepIds mantém o item recém-criado mesmo sem casar', () => {
    const items = tree();
    items[0].item![0].item!.push(request('new', 'New Request'));
    expect(ids(filterTree(items, 'list', new Set(['new'])))).toEqual(['col', 'pay', 'list', 'new']);
  });

  it('termos fora de ordem e métodos continuam valendo', () => {
    expect(ids(filterTree(tree(), 'post list'))).toEqual(['col', 'pay', 'list']);
  });
});

describe('desfazer exclusão', () => {
  it('devolve cada item ao lugar de onde saiu', () => {
    const before = tree();
    const removed = captureRemoval(before, ['create', 'quote']);
    const after = removeNode(removeNode(before, 'create'), 'quote');
    expect(restoreRemoved(after, removed)).toEqual(before);
  });

  it('item dentro de outro também apagado volta junto com o de cima', () => {
    const removed = captureRemoval(tree(), ['pay', 'create']);
    expect(removed.map(r => r.node.id)).toEqual(['pay']);
  });

  it('mantém o que foi editado depois da exclusão', () => {
    const before = tree();
    const removed = captureRemoval(before, ['list']);
    const edited = renameNode(removeNode(before, 'list'), 'create', 'Create v2');
    const restored = restoreRemoved(edited, removed);
    expect(ids(restored)).toEqual(ids(before));
    expect(restored[0].item![0].item![0].name).toBe('Create v2');
  });

  it('Undo duas vezes não duplica', () => {
    const before = tree();
    const removed = captureRemoval(before, ['list']);
    const once = restoreRemoved(removeNode(before, 'list'), removed);
    expect(restoreRemoved(once, removed)).toBe(once);
  });
});

describe('desfazer mover', () => {
  it('volta pra pasta e posição de antes', () => {
    const before = tree();
    const pos = positionOf(before, 'create')!;
    const moved = moveNode(before, 'create', 'quote', 'inside');
    expect(restorePosition(moved, 'create', pos)).toEqual(before);
  });
});

describe('removeNode', () => {
  it('não recria os galhos que não mudaram', () => {
    const before = tree();
    const after = removeNode(before, 'list');
    expect(after[0].item![1]).toBe(before[0].item![1]);
    expect(removeNode(before, 'nao-existe')).toBe(before);
  });
});
