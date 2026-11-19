import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import {
  catalogForPush,
  markerBaseHashes,
  markersOf,
  mergeCatalogs,
  purgeOrphans,
  remapMarkers,
  withRemoteTwins,
  type Marker,
} from './markers';

// Duas pessoas criaram "flaky" cada uma na sua máquina: ids diferentes, o
// mesmo marcador. Quem envia por último não pode tirar o do outro do
// catálogo — as marcas dele nos itens ficavam órfãs e o pull as apagava.

const flakyA: Marker = { id: 'A', name: 'flaky', color: '#f00' };
const flakyB: Marker = { id: 'B', name: 'Flaky', color: '#0f0' };
const other: Marker = { id: 'X', name: 'slow', color: '#00f' };

const marked = (id: string, markerIds: string[]): CollectionItem =>
  ({ id, name: id, type: 'request', markers: markerIds }) as unknown as CollectionItem;

describe('withRemoteTwins', () => {
  it('takes the id GitHub already has for a marker with the same name', () => {
    const { catalog, remapped } = withRemoteTwins([flakyA, other], [flakyB]);
    expect(catalog.map(m => m.id)).toEqual(['B', 'X']);
    expect([...remapped]).toEqual([['A', 'B']]);
  });

  it('changes nothing without a twin, or when the ids already match', () => {
    expect(withRemoteTwins([flakyA], [flakyA]).remapped.size).toBe(0);
    expect(withRemoteTwins([other], [flakyB]).catalog).toEqual([other]);
    expect(withRemoteTwins([flakyA], null).catalog).toEqual([flakyA]);
  });
});

describe('push with a same-name marker from a colleague', () => {
  it('keeps the colleague id in the pushed catalog and remaps your tree to it', () => {
    // O colega já enviou B; você nunca puxou (sem base de marcadores).
    const send = catalogForPush([flakyA], [flakyB], null);
    expect(send.map(m => m.id)).toEqual(['B']);
    const { remapped } = withRemoteTwins([flakyA], [flakyB]);
    const tree = remapMarkers([marked('r1', ['A'])], remapped);
    expect(markersOf(tree[0])).toEqual(['B']);
  });

  it("the colleague's marks survive even if GitHub ended up with YOUR id", () => {
    // Estado de antes da correção do push: o GitHub ficou só com A. O
    // colega tinha B sincronizado (na base), e itens marcados com B.
    const base = markerBaseHashes([flakyB]);
    const { catalog, remapped } = mergeCatalogs([flakyB], [flakyA], base);
    expect(catalog.map(m => m.id)).toEqual(['A']);
    expect(remapped.get('B')).toBe('A');
    const tree = purgeOrphans(remapMarkers([marked('r1', ['B'])], remapped), catalog);
    expect(markersOf(tree[0])).toEqual(['A']);
  });

  it('a marker deleted on GitHub with no twin still goes away', () => {
    const base = markerBaseHashes([flakyB, other]);
    const { catalog } = mergeCatalogs([flakyB, other], [flakyB], base);
    expect(catalog.map(m => m.id)).toEqual(['B']);
  });
});
