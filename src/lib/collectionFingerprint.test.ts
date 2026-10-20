import { describe, it, expect } from 'vitest';
import { fingerprintRoots, diffRoots } from './collectionFingerprint';
import type { CollectionItem } from '@/app/types/CollectionItem';

const request = (id: string, name = id, over: Partial<CollectionItem> = {}): CollectionItem => ({
  id,
  name,
  type: 'request',
  method: 'GET',
  ...over,
});

const collection = (id: string, children: CollectionItem[] = [], over: Partial<CollectionItem> = {}): CollectionItem => ({
  id,
  name: `Collection ${id}`,
  type: 'folder',
  item: children,
  ...over,
});

const diff = (before: CollectionItem[], after: CollectionItem[]) =>
  diffRoots(fingerprintRoots(before), fingerprintRoots(after));

describe('diffRoots', () => {
  it('não acusa nada quando nada mudou', () => {
    const tree = [collection('a', [request('r1')]), collection('b')];
    expect(diff(tree, tree)).toEqual({ changed: [], removed: [] });
  });

  it('acusa collection nova', () => {
    expect(diff([collection('a')], [collection('a'), collection('b')])).toEqual({
      changed: ['b'],
      removed: [],
    });
  });

  it('acusa collection que sumiu', () => {
    expect(diff([collection('a'), collection('b')], [collection('a')])).toEqual({
      changed: [],
      removed: ['b'],
    });
  });

  // O ponto do módulo: só a collection tocada é marcada, senão um push
  // seletivo enviaria tudo.
  it('isola a collection alterada das demais', () => {
    const before = [collection('a', [request('r1')]), collection('b', [request('r2')])];
    const after = [collection('a', [request('r1')]), collection('b', [request('r2'), request('r3')])];
    expect(diff(before, after)).toEqual({ changed: ['b'], removed: [] });
  });

  describe('alterações em profundidade', () => {
    it('pega request renomeada dentro de subpasta', () => {
      const before = [collection('a', [collection('f', [request('r1', 'Antigo')])])];
      const after = [collection('a', [collection('f', [request('r1', 'Novo')])])];
      expect(diff(before, after).changed).toEqual(['a']);
    });

    it('pega mudança no corpo da request', () => {
      const withBody = (body: string) =>
        request('r1', 'x', { request: { url: 'u', urlexport: { host: [], path: [], raw: 'u' }, headers: [], body } });
      expect(diff([collection('a', [withBody('{}')])], [collection('a', [withBody('{"a":1}')])]).changed).toEqual(['a']);
    });

    it('pega reordenação de irmãos', () => {
      const before = [collection('a', [request('r1'), request('r2')])];
      const after = [collection('a', [request('r2'), request('r1')])];
      expect(diff(before, after).changed).toEqual(['a']);
    });
  });

  // Favorito é marca local e não sobe pro GitHub; o que sobe é a ordem, que
  // favoritar de fato muda.
  describe('marcas de favorito', () => {
    it('acender a estrela sem mover nada não marca pendência', () => {
      const before = [collection('a', [request('r1'), request('r2')])];
      const after = [collection('a', [request('r1', 'r1', { starred: true }), request('r2')])];
      expect(diff(before, after)).toEqual({ changed: [], removed: [] });
    });

    it('o starredAfterId também é ignorado', () => {
      const before = [collection('a', [request('r1')])];
      const after = [collection('a', [request('r1', 'r1', { starred: true, starredAfterId: null })])];
      expect(diff(before, after).changed).toEqual([]);
    });

    it('mas a reordenação que favoritar provoca marca, porque vai pro arquivo', () => {
      const before = [collection('a', [request('r1'), request('r2')])];
      const after = [collection('a', [request('r2', 'r2', { starred: true }), request('r1')])];
      expect(diff(before, after).changed).toEqual(['a']);
    });
  });

  describe('casos de borda', () => {
    it('árvore vazia nos dois lados', () => {
      expect(diff([], [])).toEqual({ changed: [], removed: [] });
    });

    it('do vazio para uma collection', () => {
      expect(diff([], [collection('a')]).changed).toEqual(['a']);
    });

    it('aceita undefined', () => {
      expect(fingerprintRoots(undefined).size).toBe(0);
      expect(fingerprintRoots(null).size).toBe(0);
    });

    it('ignora nó sem id', () => {
      const semId = { name: 'x', type: 'folder' } as CollectionItem;
      expect(fingerprintRoots([semId]).size).toBe(0);
    });

    it('troca de workspace: nada em comum vira tudo novo e tudo removido', () => {
      expect(diff([collection('a')], [collection('z')])).toEqual({
        changed: ['z'],
        removed: ['a'],
      });
    });
  });
});
