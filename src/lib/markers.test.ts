import { describe, it, expect } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import {
  MARKER_COLORS,
  type Marker,
  createMarker,
  renameMarker,
  recolorMarker,
  deleteMarker,
  pickColor,
  markersOf,
  hasMarker,
  applyMarker,
  removeMarker,
  toggleMarker,
  purgeMarker,
  markerCounts,
  orphanMarkerIds,
  purgeOrphans,
  nodeMatchesMarkers,
  catalogForPush,
  markerBaseAfterPush,
  markerBaseHashes,
  filterTreeByMarkers,
  markerNote,
  setMarkerNote,
  mergeCatalogs,
  markerChangesFromRemote,
  markerBaseHashes as baseOfCatalog,
  remapMarkers,
} from './markers';

// Árvore de teste com a mesma forma das reais: collection > pasta > request,
// com um example pendurado numa request.
function tree(): CollectionItem[] {
  return [
    {
      id: 'col',
      name: 'Portal de Grupos B2B',
      type: 'folder',
      item: [
        {
          id: 'f1',
          name: 'Checkout permitido',
          type: 'folder',
          item: [
            { id: 'r1', name: '01 - Token v1', type: 'request', method: 'POST' },
            {
              id: 'r2',
              name: '02 - Authenticate v1',
              type: 'request',
              method: 'POST',
              item: [{ id: 'e1', name: '401', type: 'example' }],
            },
          ],
        },
        { id: 'r3', name: 'Cancel Quote', type: 'request', method: 'POST' },
      ],
    },
  ];
}

function find(items: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const hit = item.item && find(item.item, id);
    if (hit) return hit;
  }
  return undefined;
}

const flaky: Marker = { id: 'm1', name: 'flaky', color: MARKER_COLORS[0] };
const smoke: Marker = { id: 'm2', name: 'smoke', color: MARKER_COLORS[1] };

describe('markers > catálogo', () => {
  it('cria com nome limpo e a próxima cor livre', () => {
    const { catalog, marker, existed } = createMarker([], '  Smoke   Test ', { id: 'a' });
    expect(existed).toBe(false);
    expect(marker).toEqual({ id: 'a', name: 'Smoke Test', color: MARKER_COLORS[0] });
    expect(catalog).toHaveLength(1);
  });

  it('nome que já existe devolve o marcador existente, sem duplicar', () => {
    const { catalog, marker, existed } = createMarker([flaky], ' FLAKY ', { id: 'novo' });
    expect(existed).toBe(true);
    expect(marker).toBe(flaky);
    expect(catalog).toHaveLength(1);
  });

  it('recusa nome vazio', () => {
    expect(() => createMarker([], '   ')).toThrow();
  });

  it('corta o nome no limite', () => {
    const { marker } = createMarker([], 'x'.repeat(80), { id: 'a' });
    expect(marker.name).toHaveLength(40);
  });

  it('pickColor só repete quando a paleta acabou', () => {
    const full = MARKER_COLORS.map((color, i) => ({ id: `m${i}`, name: `n${i}`, color }));
    expect(pickColor(full.slice(0, 3))).toBe(MARKER_COLORS[3]);
    expect(MARKER_COLORS).toContain(pickColor(full));
  });

  it('aceita cor pedida só se for da paleta', () => {
    expect(createMarker([], 'a', { id: 'x', color: MARKER_COLORS[5] }).marker.color).toBe(MARKER_COLORS[5]);
    expect(createMarker([], 'b', { id: 'y', color: '#123456' }).marker.color).toBe(MARKER_COLORS[0]);
  });

  it('renomeia, mas não para um nome já usado por outro', () => {
    const catalog = [flaky, smoke];
    expect(renameMarker(catalog, 'm1', 'instável')[0].name).toBe('instável');
    expect(renameMarker(catalog, 'm1', 'SMOKE')).toBe(catalog);
    expect(renameMarker(catalog, 'm1', '  ')).toBe(catalog);
  });

  it('recolore só com cor da paleta', () => {
    expect(recolorMarker([flaky], 'm1', MARKER_COLORS[4])[0].color).toBe(MARKER_COLORS[4]);
    expect(recolorMarker([flaky], 'm1', 'red')[0].color).toBe(MARKER_COLORS[0]);
  });

  it('apaga do catálogo', () => {
    expect(deleteMarker([flaky, smoke], 'm1')).toEqual([smoke]);
  });
});

describe('markers > aplicar na árvore', () => {
  it('aplica a um nó e deixa os outros intactos por referência', () => {
    const before = tree();
    const after = applyMarker(before, ['r1'], 'm1');
    expect(markersOf(find(after, 'r1')!)).toEqual(['m1']);
    expect(find(after, 'r3')).toBe(find(before, 'r3'));
  });

  it('aplica em qualquer nível, inclusive collection e example', () => {
    let items = tree();
    items = applyMarker(items, ['col', 'f1', 'e1'], 'm1');
    expect(hasMarker(find(items, 'col')!, 'm1')).toBe(true);
    expect(hasMarker(find(items, 'f1')!, 'm1')).toBe(true);
    expect(hasMarker(find(items, 'e1')!, 'm1')).toBe(true);
  });

  it('aplicar duas vezes não duplica', () => {
    const once = applyMarker(tree(), ['r1'], 'm1');
    const twice = applyMarker(once, ['r1'], 'm1');
    expect(markersOf(find(twice, 'r1')!)).toEqual(['m1']);
    expect(twice).toBe(once);
  });

  it('um nó acumula marcadores na ordem em que foram postos', () => {
    let items = applyMarker(tree(), ['r1'], 'm1');
    items = applyMarker(items, ['r1'], 'm2');
    expect(markersOf(find(items, 'r1')!)).toEqual(['m1', 'm2']);
  });

  it('remover o último apaga o campo em vez de deixar array vazio', () => {
    const items = removeMarker(applyMarker(tree(), ['r1'], 'm1'), ['r1'], 'm1');
    expect('markers' in find(items, 'r1')!).toBe(false);
  });

  it('remover o que não está não muda nada', () => {
    const before = tree();
    expect(removeMarker(before, ['r1'], 'm1')).toBe(before);
  });

  it('lista de alvos vazia é no-op', () => {
    const before = tree();
    expect(applyMarker(before, [], 'm1')).toBe(before);
    expect(toggleMarker(before, [], 'm1')).toBe(before);
  });
});

describe('markers > toggle em seleção', () => {
  it('aplica a todos quando algum ainda não tem', () => {
    const items = toggleMarker(applyMarker(tree(), ['r1'], 'm1'), ['r1', 'r3'], 'm1');
    expect(hasMarker(find(items, 'r1')!, 'm1')).toBe(true);
    expect(hasMarker(find(items, 'r3')!, 'm1')).toBe(true);
  });

  it('tira de todos só quando todos já têm', () => {
    const items = toggleMarker(applyMarker(tree(), ['r1', 'r3'], 'm1'), ['r1', 'r3'], 'm1');
    expect(hasMarker(find(items, 'r1')!, 'm1')).toBe(false);
    expect(hasMarker(find(items, 'r3')!, 'm1')).toBe(false);
  });

  it('alvo que não existe na árvore não conta como "já tem"', () => {
    const items = toggleMarker(applyMarker(tree(), ['r1'], 'm1'), ['r1', 'fantasma'], 'm1');
    expect(hasMarker(find(items, 'r1')!, 'm1')).toBe(false);
  });
});

describe('markers > contagem e órfãos', () => {
  it('conta por marcador, em todos os níveis', () => {
    let items = applyMarker(tree(), ['col', 'r1', 'e1'], 'm1');
    items = applyMarker(items, ['r1'], 'm2');
    const counts = markerCounts(items);
    expect(counts.get('m1')).toBe(3);
    expect(counts.get('m2')).toBe(1);
  });

  it('acha ids que não estão no catálogo', () => {
    const items = applyMarker(applyMarker(tree(), ['r1'], 'm1'), ['r3'], 'sumiu');
    expect(orphanMarkerIds(items, [flaky]).sort()).toEqual(['sumiu']);
  });

  it('purgeOrphans tira só os órfãos', () => {
    let items = applyMarker(tree(), ['r1'], 'm1');
    items = applyMarker(items, ['r1'], 'sumiu');
    const clean = purgeOrphans(items, [flaky]);
    expect(markersOf(find(clean, 'r1')!)).toEqual(['m1']);
  });

  it('purgeMarker tira da árvore inteira', () => {
    const items = purgeMarker(applyMarker(tree(), ['col', 'f1', 'r1'], 'm1'), 'm1');
    expect(markerCounts(items).get('m1')).toBeUndefined();
  });

  it('árvore sem marca nenhuma volta pela mesma referência', () => {
    const before = tree();
    expect(purgeMarker(before, 'm1')).toBe(before);
    expect(purgeOrphans(before, [flaky])).toBe(before);
  });
});

describe('markers > filtro', () => {
  it('sem marcador selecionado devolve tudo, pela mesma referência', () => {
    const before = tree();
    expect(filterTreeByMarkers(before, [])).toBe(before);
  });

  it('mostra o caminho até a request marcada, sem as irmãs', () => {
    const items = filterTreeByMarkers(applyMarker(tree(), ['r1'], 'm1'), ['m1']);
    expect(items[0].item!.map(i => i.id)).toEqual(['f1']);
    expect(items[0].item![0].item!.map(i => i.id)).toEqual(['r1']);
  });

  it('pasta marcada traz a subárvore inteira', () => {
    const items = filterTreeByMarkers(applyMarker(tree(), ['f1'], 'm1'), ['m1']);
    expect(items[0].item![0].item!.map(i => i.id)).toEqual(['r1', 'r2']);
  });

  it('modo any junta, modo all exige os dois', () => {
    let items = applyMarker(tree(), ['r1'], 'm1');
    items = applyMarker(items, ['r3'], 'm2');
    expect(filterTreeByMarkers(items, ['m1', 'm2'], 'any')[0].item).toHaveLength(2);
    expect(filterTreeByMarkers(items, ['m1', 'm2'], 'all')).toHaveLength(0);

    const both = applyMarker(items, ['r1'], 'm2');
    const filtered = filterTreeByMarkers(both, ['m1', 'm2'], 'all');
    expect(filtered[0].item![0].item!.map(i => i.id)).toEqual(['r1']);
  });

  it('nodeMatchesMarkers respeita o modo', () => {
    const node = { id: 'x', name: 'x', type: 'request', markers: ['m1'] } as CollectionItem;
    expect(nodeMatchesMarkers(node, ['m1', 'm2'], 'any')).toBe(true);
    expect(nodeMatchesMarkers(node, ['m1', 'm2'], 'all')).toBe(false);
    expect(nodeMatchesMarkers(node, [])).toBe(true);
  });
});

describe('markers > catálogo enviado no push', () => {
  const mine = { id: 'm1', name: 'Flaky', color: MARKER_COLORS[0] };
  it('leva os marcadores que outra pessoa criou lá', () => {
    const theirs = { id: 'm9', name: 'Smoke', color: MARKER_COLORS[2] };
    expect(catalogForPush([mine], [theirs]).map(m => m.id)).toEqual(['m1', 'm9']);
  });
  it('mesmo id: vale o daqui (quem envia acabou de renomear)', () => {
    const old = { id: 'm1', name: 'Instável', color: MARKER_COLORS[5] };
    expect(catalogForPush([mine], [old])).toEqual([mine]);
  });
  it('mesmo nome com outro id não duplica — e fica o id do time (o de lá)', () => {
    // Enviar o daqui tirava o do colega do catálogo, e as marcas dele nos
    // itens viravam órfãs. Quem envia troca o id na árvore (withRemoteTwins).
    const twin = { id: 'x', name: 'flaky', color: MARKER_COLORS[1] };
    expect(catalogForPush([mine], [twin])).toEqual([twin]);
  });
  it('sem leitura do GitHub, fica o daqui', () => {
    expect(catalogForPush([mine], null)).toEqual([mine]);
  });
});

describe('markers > merge do catálogo do Git', () => {
  it('mantém o local que o remoto não tem', () => {
    const { catalog, remapped } = mergeCatalogs([flaky], [smoke]);
    expect(catalog.map(m => m.id).sort()).toEqual(['m1', 'm2']);
    expect(remapped.size).toBe(0);
  });

  it('mesmo id: o remoto manda no nome e na cor', () => {
    const renamed = { id: 'm1', name: 'instável', color: MARKER_COLORS[7] };
    const { catalog } = mergeCatalogs([flaky], [renamed]);
    expect(catalog).toEqual([renamed]);
  });

  it('mesmo nome com ids diferentes colapsa no remoto e devolve o remap', () => {
    const meu = { id: 'local-1', name: 'Flaky', color: MARKER_COLORS[3] };
    const { catalog, remapped } = mergeCatalogs([meu], [flaky]);
    expect(catalog).toEqual([flaky]);
    expect(remapped.get('local-1')).toBe('m1');
  });

  it('remapMarkers reescreve os ids na árvore', () => {
    const items = applyMarker(tree(), ['r1'], 'local-1');
    const out = remapMarkers(items, new Map([['local-1', 'm1']]));
    expect(markersOf(find(out, 'r1')!)).toEqual(['m1']);
  });

  it('remap que funde dois ids no mesmo nó não duplica', () => {
    let items = applyMarker(tree(), ['r1'], 'local-1');
    items = applyMarker(items, ['r1'], 'm1');
    const out = remapMarkers(items, new Map([['local-1', 'm1']]));
    expect(markersOf(find(out, 'r1')!)).toEqual(['m1']);
  });

  it('remap vazio é no-op', () => {
    const before = tree();
    expect(remapMarkers(before, new Map())).toBe(before);
  });

  // O remap passa por TODO nó marcado, não só pelos que mudam — sem a
  // guarda de identidade no setMarkers, um pull reescreveria cada nó marcado
  // da árvore e o React re-renderizaria a árvore inteira.
  it('nó cujo marcador não foi remapeado volta pela mesma referência', () => {
    let items = applyMarker(tree(), ['r1'], 'local-1');
    items = applyMarker(items, ['r3'], 'm2');
    const out = remapMarkers(items, new Map([['local-1', 'm1']]));

    expect(find(out, 'r1')).not.toBe(find(items, 'r1'));
    expect(find(out, 'r3')).toBe(find(items, 'r3'));
  });
});

describe('markers > nota por marca', () => {
  it('grava e lê a nota de um marcador no nó', () => {
    const items = setMarkerNote(applyMarker(tree(), ['r1'], 'm1'), 'r1', 'm1', '  flaky desde o gateway novo ')
    expect(markerNote(find(items, 'r1')!, 'm1')).toBe('flaky desde o gateway novo')
  })

  it('a mesma marca em dois itens tem notas independentes', () => {
    let items = applyMarker(tree(), ['r1', 'r3'], 'm1')
    items = setMarkerNote(items, 'r1', 'm1', 'motivo A')
    items = setMarkerNote(items, 'r3', 'm1', 'motivo B')
    expect(markerNote(find(items, 'r1')!, 'm1')).toBe('motivo A')
    expect(markerNote(find(items, 'r3')!, 'm1')).toBe('motivo B')
  })

  it('não grava nota onde a marca não existe', () => {
    const items = setMarkerNote(tree(), 'r1', 'm1', 'texto')
    expect(find(items, 'r1')!.markerNotes).toBeUndefined()
  })

  it('texto em branco apaga a nota, e o campo some quando era a última', () => {
    let items = setMarkerNote(applyMarker(tree(), ['r1'], 'm1'), 'r1', 'm1', 'texto')
    items = setMarkerNote(items, 'r1', 'm1', '   ')
    expect('markerNotes' in find(items, 'r1')!).toBe(false)
  })

  it('tirar a marca leva a nota junto', () => {
    let items = setMarkerNote(applyMarker(tree(), ['r1'], 'm1'), 'r1', 'm1', 'texto')
    items = removeMarker(items, ['r1'], 'm1')
    expect('markerNotes' in find(items, 'r1')!).toBe(false)
  })

  // Sem isto a nota voltaria sozinha ao reaplicar a marca, com um texto que
  // já não vale — e, sem a marca, nenhuma tela a mostra pra apagar.
  it('reaplicar a marca depois de tirar NÃO ressuscita a nota', () => {
    let items = setMarkerNote(applyMarker(tree(), ['r1'], 'm1'), 'r1', 'm1', 'texto velho')
    items = removeMarker(items, ['r1'], 'm1')
    items = applyMarker(items, ['r1'], 'm1')
    expect(markerNote(find(items, 'r1')!, 'm1')).toBe('')
  })

  it('tirar UMA marca preserva a nota das outras', () => {
    let items = applyMarker(applyMarker(tree(), ['r1'], 'm1'), ['r1'], 'm2')
    items = setMarkerNote(items, 'r1', 'm1', 'nota do m1')
    items = setMarkerNote(items, 'r1', 'm2', 'nota do m2')
    items = removeMarker(items, ['r1'], 'm1')
    expect(markerNote(find(items, 'r1')!, 'm2')).toBe('nota do m2')
    expect(markerNote(find(items, 'r1')!, 'm1')).toBe('')
  })

  it('purgeMarker e purgeOrphans também levam a nota', () => {
    let items = setMarkerNote(applyMarker(tree(), ['r1'], 'm1'), 'r1', 'm1', 'texto')
    expect('markerNotes' in find(purgeMarker(items, 'm1'), 'r1')!).toBe(false)

    items = setMarkerNote(applyMarker(items, ['r1'], 'sumiu'), 'r1', 'sumiu', 'orfa')
    const limpo = purgeOrphans(items, [flaky])
    expect(markerNote(find(limpo, 'r1')!, 'sumiu')).toBe('')
    expect(markerNote(find(limpo, 'r1')!, 'm1')).toBe('texto')
  })

  it('gravar a mesma nota devolve a mesma árvore', () => {
    const com = setMarkerNote(applyMarker(tree(), ['r1'], 'm1'), 'r1', 'm1', 'texto')
    expect(setMarkerNote(com, 'r1', 'm1', 'texto')).toBe(com)
  })

  it('o remap do pull leva a nota junto com o id', () => {
    let items = applyMarker(tree(), ['r1'], 'local-1')
    items = setMarkerNote(items, 'r1', 'local-1', 'minha nota')
    const out = remapMarkers(items, new Map([['local-1', 'm1']]))
    expect(markerNote(find(out, 'r1')!, 'm1')).toBe('minha nota')
  })

  // Nas DUAS ordens de gravação: a regra tem que ser "fica a do time", e não
  // "fica a última", que passaria por acidente numa das ordens.
  it.each([
    ['nota local gravada primeiro', ['local-1', 'm1']],
    ['nota do time gravada primeiro', ['m1', 'local-1']],
  ] as const)('ids que se fundem: fica a nota do time (%s)', (_label, ordem) => {
    const texto: Record<string, string> = { 'local-1': 'a minha', m1: 'a do time' }
    let items = applyMarker(applyMarker(tree(), ['r1'], 'local-1'), ['r1'], 'm1')
    for (const id of ordem) items = setMarkerNote(items, 'r1', id, texto[id])
    const out = remapMarkers(items, new Map([['local-1', 'm1']]))
    expect(markerNote(find(out, 'r1')!, 'm1')).toBe('a do time')
  })
})

describe('catálogo com a base da última sincronização', () => {
  const synced: Marker[] = [
    { id: 'a', name: 'Em revisão', color: '#f2c94c' },
    { id: 'b', name: 'Pronto', color: '#27ae60' },
  ];
  const base = markerBaseHashes(synced);
  const ids = (list: Marker[]) => list.map(m => m.id).sort();

  it('marcador apagado aqui não volta no push nem no pull', () => {
    const local = synced.filter(m => m.id !== 'a');
    expect(ids(catalogForPush(local, synced, base))).toEqual(['b']);
    expect(ids(mergeCatalogs(local, synced, base).catalog)).toEqual(['b']);
  });

  it('marcador apagado no GitHub sai daqui também, e o push não o reenvia', () => {
    const remote = synced.filter(m => m.id !== 'b');
    expect(ids(mergeCatalogs(synced, remote, base).catalog)).toEqual(['a']);
    expect(ids(catalogForPush(synced, remote, base))).toEqual(['a']);
  });

  it('renomear aqui e puxar antes de enviar mantém o nome novo', () => {
    const local = synced.map(m => (m.id === 'a' ? { ...m, name: 'Revisão QA' } : m));
    const merged = mergeCatalogs(local, synced, base).catalog;
    expect(merged.find(m => m.id === 'a')?.name).toBe('Revisão QA');
  });

  it('o colega renomeou no GitHub: o push não desfaz', () => {
    const remote = synced.map(m => (m.id === 'b' ? { ...m, color: '#2f80ed' } : m));
    const pushed = catalogForPush(synced, remote, base);
    expect(pushed.find(m => m.id === 'b')?.color).toBe('#2f80ed');
  });

  it('marcador criado do outro lado continua entrando', () => {
    const remote = [...synced, { id: 'c', name: 'Bloqueado', color: '#eb5757' }];
    expect(ids(mergeCatalogs(synced, remote, base).catalog)).toEqual(['a', 'b', 'c']);
    const local = [...synced, { id: 'd', name: 'Urgente', color: '#eb5757' }];
    expect(ids(catalogForPush(local, synced, base))).toEqual(['a', 'b', 'd']);
  });
});

describe('base do catálogo depois do push', () => {
  const ids = (list: Marker[]) => list.map(m => m.id).sort();
  const a: Marker = { id: 'a', name: 'flaky', color: '#eb5757' };

  it('marcador novo do colega: o pull seguinte o traz, e o push seguinte não o apaga', () => {
    const x: Marker = { id: 'x', name: 'do colega', color: '#2f80ed' };
    const previous = markerBaseHashes([a]);
    const sent = catalogForPush([a], [a, x], previous);
    expect(ids(sent)).toEqual(['a', 'x']);
    const base = markerBaseAfterPush([a], sent, previous);
    const pulled = mergeCatalogs([a], sent, base).catalog;
    expect(ids(pulled)).toEqual(['a', 'x']);
    expect(ids(catalogForPush([a], sent, base))).toEqual(['a', 'x']);
  });

  it('o colega renomeou e eu enviei antes de puxar: o pull traz o nome dele', () => {
    const previous = markerBaseHashes([a]);
    const sent = catalogForPush([a], [{ ...a, name: 'renomeado' }], previous);
    const base = markerBaseAfterPush([a], sent, previous);
    expect(mergeCatalogs([a], sent, base).catalog[0].name).toBe('renomeado');
  });

  it('apagado no GitHub e intocado aqui continua saindo no pull', () => {
    const b: Marker = { id: 'b', name: 'pronto', color: '#27ae60' };
    const previous = markerBaseHashes([a, b]);
    const sent = catalogForPush([a, b], [a], previous);
    expect(ids(sent)).toEqual(['a']);
    const base = markerBaseAfterPush([a, b], sent, previous);
    expect(ids(mergeCatalogs([a, b], sent, base).catalog)).toEqual(['a']);
  });

  it('o colega apagou TODOS: o push não os devolve', () => {
    expect(catalogForPush([a], [], markerBaseHashes([a]))).toEqual([]);
  });

  it('catálogo sincronizado vazio ainda conta como base', () => {
    // Sincronizado sem nenhum marcador; o colega apagou "a" depois que eu
    // o vi? Não: aqui "a" é novo meu — continua indo.
    expect(ids(catalogForPush([a], [], markerBaseHashes([])))).toEqual(['a']);
    // E um marcador do GitHub que a base vazia não conhece entra no pull.
    expect(ids(mergeCatalogs([], [a], markerBaseHashes([])).catalog)).toEqual(['a']);
  });
});


describe('markerChangesFromRemote', () => {
  const red = MARKER_COLORS[0];
  const blue = MARKER_COLORS[1];
  const m = (id: string, name: string, color: string = red): Marker => ({ id, name, color });

  it('lista o que um colega criou, recoloriu ou apagou', () => {
    const synced = [m('1', 'flaky'), m('2', 'slow'), m('3', 'old')];
    const base = baseOfCatalog(synced);
    const local = synced;
    const remote = [m('1', 'flaky'), m('2', 'slow', blue), m('4', 'new one')];
    expect(markerChangesFromRemote(local, remote, base)).toEqual({
      added: ['new one'],
      changed: ['slow'],
      removed: ['old'],
    });
  });

  it('nada a receber quando os dois lados batem, ou quando não há catálogo lá', () => {
    const synced = [m('1', 'flaky')];
    expect(markerChangesFromRemote(synced, synced, baseOfCatalog(synced))).toEqual({ added: [], changed: [], removed: [] });
    expect(markerChangesFromRemote(synced, null, baseOfCatalog(synced))).toEqual({ added: [], changed: [], removed: [] });
  });

  it('o que você mudou aqui não conta como recebido', () => {
    const synced = [m('1', 'flaky')];
    const local = [m('1', 'flaky', blue)];
    expect(markerChangesFromRemote(local, synced, baseOfCatalog(synced))).toEqual({ added: [], changed: [], removed: [] });
  });

  it('marcador de mesmo nome criado nos dois lados vira o do time', () => {
    expect(markerChangesFromRemote([m('a', 'flaky')], [m('b', 'Flaky')], undefined).changed).toEqual(['Flaky']);
  });
});
