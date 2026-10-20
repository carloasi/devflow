import { describe, it, expect } from 'vitest';
import {
  toggleNode,
  toggleRoot,
  rootState,
  conflictingIds,
  summarize,
  defaultSelection,
  safeSelection,
  countByRisk,
  selectWithin,
} from './diffSelection';
import type { DiffNode } from './collectionDiff';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { nodeHashes } from './syncBase';

const node = (id: string, rootId: string, change: DiffNode['change'] = 'modified'): DiffNode => ({
  id,
  path: [rootId, id],
  rootId,
  ancestorIds: [rootId],
  kind: 'request',
  change,
  fields: [],
});

const nodes = [node('a1', 'c1'), node('a2', 'c1', 'added'), node('b1', 'c2', 'removed')];

describe('toggleNode', () => {
  it('marca e desmarca', () => {
    const once = toggleNode(new Set(), 'a1');
    expect(once.has('a1')).toBe(true);
    expect(toggleNode(once, 'a1').has('a1')).toBe(false);
  });

  it('não altera o conjunto recebido', () => {
    const original = new Set(['a1']);
    toggleNode(original, 'a2');
    expect(original.size).toBe(1);
  });
});

describe('toggleRoot', () => {
  it('marca a collection inteira', () => {
    const next = toggleRoot(new Set(), nodes, 'c1');
    expect(next.has('a1') && next.has('a2')).toBe(true);
    expect(next.has('b1')).toBe(false);
  });

  it('desmarca quando já estava tudo marcado', () => {
    const all = toggleRoot(new Set(), nodes, 'c1');
    expect(toggleRoot(all, nodes, 'c1').size).toBe(0);
  });

  // Caixa em estado intermediário: clicar completa, não esvazia.
  it('a partir de parcial, completa a seleção', () => {
    const next = toggleRoot(new Set(['a1']), nodes, 'c1');
    expect(next.has('a1') && next.has('a2')).toBe(true);
  });

  it('não mexe nas outras collections', () => {
    const next = toggleRoot(new Set(['b1']), nodes, 'c1');
    expect(next.has('b1')).toBe(true);
  });
});

describe('rootState', () => {
  it('none, partial e all', () => {
    expect(rootState(new Set(), nodes, 'c1')).toBe('none');
    expect(rootState(new Set(['a1']), nodes, 'c1')).toBe('partial');
    expect(rootState(new Set(['a1', 'a2']), nodes, 'c1')).toBe('all');
  });

  it('collection sem nó nenhum é none', () => {
    expect(rootState(new Set(), nodes, 'inexistente')).toBe('none');
  });
});

// O ponto da tela: aceitar o remoto numa collection que você editou e não
// enviou apaga a sua versão.
describe('conflictingIds', () => {
  it('acusa nó de collection com push pendente', () => {
    expect([...conflictingIds(nodes, new Set(['c1']))]).toEqual(['a1']);
  });

  it('ignora added — não há versão local pra perder', () => {
    const conflicts = conflictingIds(nodes, new Set(['c1']));
    expect(conflicts.has('a2')).toBe(false);
  });

  it('inclui removed, que apaga algo que está aqui', () => {
    expect(conflictingIds(nodes, new Set(['c2'])).has('b1')).toBe(true);
  });

  it('sem pendência local, nada conflita', () => {
    expect(conflictingIds(nodes, new Set()).size).toBe(0);
  });
});

describe('defaultSelection', () => {
  // Tudo marcado faria o caminho de menor esforço descartar trabalho local em
  // silêncio; nada marcado obrigaria a clicar item a item no caso comum.
  it('marca tudo quando não há conflito', () => {
    expect(defaultSelection(nodes, new Set()).size).toBe(3);
  });

  it('deixa o conflitante desmarcado', () => {
    const conflicts = conflictingIds(nodes, new Set(['c1']));
    const selection = defaultSelection(nodes, conflicts);
    expect(selection.has('a1')).toBe(false);
    expect(selection.has('a2')).toBe(true);
  });
});

describe('summarize', () => {
  it('conta por tipo de mudança', () => {
    const s = summarize(nodes, new Set(['a1', 'a2', 'b1']), new Set());
    expect(s).toMatchObject({ total: 3, selected: 3, modified: 1, added: 1, removed: 1 });
  });

  it('conta só o que está selecionado', () => {
    expect(summarize(nodes, new Set(['a1']), new Set()).selected).toBe(1);
  });

  // É o número que o botão de aplicar precisa mostrar antes de o usuário
  // confirmar algo irreversível.
  it('conta conflitos selecionados', () => {
    const conflicts = conflictingIds(nodes, new Set(['c1']));
    expect(summarize(nodes, new Set(['a1', 'a2']), conflicts).conflicts).toBe(1);
    expect(summarize(nodes, new Set(['a2']), conflicts).conflicts).toBe(0);
  });
});

describe('conflictingIds com base de três vias', () => {
  const req = (id: string, body: string): CollectionItem => ({
    id,
    name: `Request ${id}`,
    type: 'request',
    method: 'GET',
    request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
  });

  const diffNode = (id: string, local: CollectionItem, change: DiffNode['change'] = 'modified'): DiffNode => ({
    id,
    path: ['C', id],
    rootId: 'c1',
    ancestorIds: ['c1'],
    kind: 'request',
    change,
    local,
    fields: [],
  });

  // A base é o estado da última sincronização.
  const base = nodeHashes([req('a', 'base'), req('b', 'base')]);
  const todaAcollectionPendente = new Set(['c1']);

  // O caso que motivou a mudança: a collection inteira pendente marcava os
  // 313 itens como conflito, e o aviso deixava de informar.
  it('mudou só no GitHub não é conflito, mesmo com a collection pendente', () => {
    const nodes = [diffNode('a', req('a', 'base'))];
    expect(conflictingIds(nodes, todaAcollectionPendente, base).size).toBe(0);
  });

  it('mudou nos dois lados é conflito', () => {
    const nodes = [diffNode('a', req('a', 'editei aqui'))];
    expect([...conflictingIds(nodes, todaAcollectionPendente, base)]).toEqual(['a']);
  });

  it('separa os dois dentro da mesma collection', () => {
    const nodes = [diffNode('a', req('a', 'editei aqui')), diffNode('b', req('b', 'base'))];
    expect([...conflictingIds(nodes, todaAcollectionPendente, base)]).toEqual(['a']);
  });

  // Criada depois da base = trabalho local; aceitar a remoção apagaria.
  it('item local que a base não conhece é conflito', () => {
    const nodes = [diffNode('novo', req('novo', 'x'), 'removed')];
    expect([...conflictingIds(nodes, todaAcollectionPendente, base)]).toEqual(['novo']);
  });

  it('remoção de item intocado não é conflito', () => {
    const nodes = [diffNode('a', req('a', 'base'), 'removed')];
    expect(conflictingIds(nodes, todaAcollectionPendente, base).size).toBe(0);
  });

  it('added nunca é conflito — não há versão local', () => {
    const nodes: DiffNode[] = [{
      id: 'z', path: ['C', 'z'], rootId: 'c1', ancestorIds: ['c1'],
      kind: 'request', change: 'added', fields: [],
    }];
    expect(conflictingIds(nodes, todaAcollectionPendente, base).size).toBe(0);
  });

  // Sem base não há como saber quem mexeu: avisar demais é melhor que calar.
  describe('sem base', () => {
    it('recai no critério por collection', () => {
      const nodes = [diffNode('a', req('a', 'base'))];
      expect([...conflictingIds(nodes, todaAcollectionPendente, null)]).toEqual(['a']);
    });

    it('e não acusa nada quando a collection não está pendente', () => {
      const nodes = [diffNode('a', req('a', 'base'))];
      expect(conflictingIds(nodes, new Set(), null).size).toBe(0);
    });
  });
});

describe('safeSelection', () => {
  it('marca tudo que não conflita', () => {
    expect([...safeSelection(nodes, new Set(['a1']))].sort()).toEqual(['a2', 'b1']);
  });

  it('com conflito em tudo, volta vazia — nada se aceita sem decisão', () => {
    expect(safeSelection(nodes, new Set(['a1', 'a2', 'b1'])).size).toBe(0);
  });

  it('sem conflito nenhum, marca tudo', () => {
    expect(safeSelection(nodes, new Set()).size).toBe(nodes.length);
  });

  // O botão da barra precisa DESCARTAR escolhas anteriores, não somar a elas:
  // é o atalho para voltar ao recorte seguro depois de mexer na lista.
  it('não parte da seleção atual', () => {
    const only = safeSelection(nodes, new Set(['a2', 'b1']));
    expect([...only]).toEqual(['a1']);
  });
});

describe('countByRisk', () => {
  it('divide entre seguro e precisa de decisão', () => {
    expect(countByRisk(nodes, new Set(['a1']))).toEqual({ safe: 2, conflicting: 1 });
  });

  it('soma sempre o total', () => {
    const r = countByRisk(nodes, new Set(['a1', 'b1']));
    expect(r.safe + r.conflicting).toBe(nodes.length);
  });

  // Conflito apontando id que não está na lista não pode virar contagem negativa.
  it('ignora conflito fora da lista', () => {
    expect(countByRisk(nodes, new Set(['fantasma']))).toEqual({ safe: 3, conflicting: 0 });
  });

  it('lista vazia', () => {
    expect(countByRisk([], new Set())).toEqual({ safe: 0, conflicting: 0 });
  });
});

describe('selectWithin', () => {
  // O escopo é o que está na tela. Clicar "All" com filtro ativo achando que
  // marca três e marcar oitenta é a pior armadilha possível aqui: o que foi
  // marcado sem se ver não cabe mais na tela pra ser conferido.
  it('"all" marca só o escopo', () => {
    const escopo = [node('a1', 'c1')];
    expect([...selectWithin(new Set(), escopo, 'all')]).toEqual(['a1']);
  });

  it('"none" desmarca só o escopo', () => {
    const escopo = [node('a1', 'c1')];
    const antes = new Set(['a1', 'b1']);
    expect([...selectWithin(antes, escopo, 'none')]).toEqual(['b1']);
  });

  // Trocar o filtro não pode desfazer escolha já feita, senão revisar por
  // partes seria impossível.
  it('preserva o que está fora do escopo', () => {
    const escopo = [node('a1', 'c1')];
    const antes = new Set(['b1']);
    expect([...selectWithin(antes, escopo, 'all')].sort()).toEqual(['a1', 'b1']);
  });

  it('"safe" marca os seguros e DESMARCA os conflitantes do escopo', () => {
    const antes = new Set(['a1']);
    const next = selectWithin(antes, nodes, 'safe', new Set(['a1']));
    expect([...next].sort()).toEqual(['a2', 'b1']);
  });

  it('não altera o conjunto recebido', () => {
    const original = new Set(['b1']);
    selectWithin(original, nodes, 'all');
    expect([...original]).toEqual(['b1']);
  });

  it('escopo vazio não muda nada', () => {
    const antes = new Set(['a1']);
    expect([...selectWithin(antes, [], 'none')]).toEqual(['a1']);
  });

  // safeSelection é selectWithin num conjunto vazio: as duas não podem divergir.
  it('equivale a safeSelection quando parte do vazio', () => {
    const conflitos = new Set(['a1']);
    expect([...selectWithin(new Set(), nodes, 'safe', conflitos)].sort()).toEqual(
      [...safeSelection(nodes, conflitos)].sort()
    );
  });
});
