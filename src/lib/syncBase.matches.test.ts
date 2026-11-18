import { describe, it, expect } from 'vitest';
import { nodeHashes, matchesSyncBase } from './syncBase';
import { renameNode, removeNode, moveNode, toggleStarNode } from '@/components/collection-tree/utils/tree.utils';
import type { CollectionItem } from '@/app/types/CollectionItem';

const req = (id: string): CollectionItem =>
  ({ id, name: `Request ${id}`, type: 'request', method: 'GET', request: { url: '/x', headers: [], body: '' } }) as unknown as CollectionItem;
const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: `Folder ${id}`, type: 'folder', item: children }) as CollectionItem;

const tree = (): CollectionItem[] => [folder('c', [folder('f', [req('a'), req('b')]), req('r')])];

describe('matchesSyncBase', () => {
  it('collection igual à base', () => {
    const base = nodeHashes(tree());
    expect(matchesSyncBase(base, tree()[0])).toBe(true);
  });

  it('editar e desfazer volta a bater (o ponto pode apagar)', () => {
    const base = nodeHashes(tree());
    const renamed = renameNode(tree(), 'a', 'Outro nome');
    expect(matchesSyncBase(base, renamed[0])).toBe(false);
    const back = renameNode(renamed, 'a', 'Request a');
    expect(matchesSyncBase(base, back[0])).toBe(true);
  });

  it('favoritar e desfavoritar volta a bater', () => {
    const base = nodeHashes(tree());
    const starred = toggleStarNode(tree(), 'b');
    expect(matchesSyncBase(base, starred[0])).toBe(false); // reordenou os irmãos
    expect(matchesSyncBase(base, toggleStarNode(starred, 'b')[0])).toBe(true);
  });

  it('item apagado não bate', () => {
    const base = nodeHashes(tree());
    expect(matchesSyncBase(base, removeNode(tree(), 'b')[0])).toBe(false);
  });

  it('item movido de pasta não bate', () => {
    const base = nodeHashes(tree());
    expect(matchesSyncBase(base, moveNode(tree(), 'r', 'f', 'inside')[0])).toBe(false);
  });

  it('item novo não bate', () => {
    const base = nodeHashes(tree());
    const items = tree();
    items[0].item!.push(req('novo'));
    expect(matchesSyncBase(base, items[0])).toBe(false);
  });

  it('sem base, ou base que não conhece a collection: mantém o ponto', () => {
    expect(matchesSyncBase(null, tree()[0])).toBe(false);
    expect(matchesSyncBase(nodeHashes([folder('outra')]), tree()[0])).toBe(false);
  });

  it('ignora o que a base guarda de outras collections', () => {
    const base = { ...nodeHashes([folder('outra', [req('z')])]), ...nodeHashes(tree()) };
    expect(matchesSyncBase(base, tree()[0])).toBe(true);
  });
});
