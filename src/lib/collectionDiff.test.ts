import { describe, it, expect } from 'vitest';
import { diffTrees, fieldDiffs, matchChildren, groupByRoot, filterSubtree } from './collectionDiff';
import type { CollectionItem } from '@/app/types/CollectionItem';

const req = (id: string, name: string, over: Partial<CollectionItem['request']> = {}): CollectionItem => ({
  id,
  name,
  type: 'request',
  method: 'GET',
  request: {
    url: '{{baseUrl}}/x',
    urlexport: { host: [], path: [], raw: '{{baseUrl}}/x' },
    headers: [],
    body: '',
    ...over,
  },
});

const folder = (id: string, name: string, children: CollectionItem[] = []): CollectionItem => ({
  id,
  name,
  type: 'folder',
  item: children,
});

describe('diffTrees', () => {
  it('não acusa nada em árvores iguais', () => {
    const tree = [folder('c', 'Pagamentos', [req('r1', 'Token')])];
    expect(diffTrees(tree, tree)).toEqual([]);
  });

  it('acusa request só no remoto como added', () => {
    const local = [folder('c', 'Pagamentos', [req('r1', 'Token')])];
    const remote = [folder('c', 'Pagamentos', [req('r1', 'Token'), req('r2', 'Checkout')])];
    const nodes = diffTrees(local, remote);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].change).toBe('added');
    expect(nodes[0].path).toEqual(['Pagamentos', 'Checkout']);
  });

  it('acusa request só no local como removed', () => {
    const local = [folder('c', 'P', [req('r1', 'Token'), req('r2', 'Checkout')])];
    const remote = [folder('c', 'P', [req('r1', 'Token')])];
    const nodes = diffTrees(local, remote);
    expect(nodes.map(n => n.change)).toEqual(['removed']);
  });

  // A razão de casar por id: sem isso renomear viraria apagar + criar, e a
  // tela pediria pra escolher entre duas linhas que são o mesmo item.
  it('renomear é modificação, não remoção mais adição', () => {
    const local = [folder('c', 'P', [req('r1', 'Token')])];
    const remote = [folder('c', 'P', [req('r1', 'Gerar token')])];
    const nodes = diffTrees(local, remote);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].change).toBe('modified');
    expect(nodes[0].fields.map(f => f.field)).toContain('name');
  });

  // O ponto que evita a tela virar ruído.
  it('alteração numa request não marca a pasta nem a collection', () => {
    const local = [folder('c', 'P', [folder('f', 'Sub', [req('r1', 'Token')])])];
    const remote = [folder('c', 'P', [folder('f', 'Sub', [req('r1', 'Token', { body: '{"a":1}' })])])];
    const nodes = diffTrees(local, remote);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].path).toEqual(['P', 'Sub', 'Token']);
  });

  it('desce em pasta idêntica pra achar a mudança lá embaixo', () => {
    const deep = (body: string) => [folder('c', 'P', [folder('f1', 'A', [folder('f2', 'B', [req('r', 'X', { body })])])])];
    expect(diffTrees(deep(''), deep('x'))[0].path).toEqual(['P', 'A', 'B', 'X']);
  });

  it('informa a collection raiz de cada nó', () => {
    const local = [folder('c1', 'A', [req('r1', 'X')]), folder('c2', 'B', [req('r2', 'Y')])];
    const remote = [folder('c1', 'A', [req('r1', 'X')]), folder('c2', 'B', [req('r2', 'Y', { body: 'z' })])];
    expect(diffTrees(local, remote)[0].rootId).toBe('c2');
  });

  it('collection inteira nova aparece uma vez, não por nó', () => {
    const remote = [folder('c', 'Nova', [req('r1', 'A'), req('r2', 'B')])];
    const nodes = diffTrees([], remote);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].change).toBe('added');
    expect(nodes[0].kind).toBe('folder');
  });

  it('aceita nulo dos dois lados', () => {
    expect(diffTrees(null, undefined)).toEqual([]);
  });
});

describe('fieldDiffs', () => {
  it('pega mudança de url, body e script', () => {
    const a = req('r', 'X', { url: 'a', body: '1' });
    const b = req('r', 'X', { url: 'b', body: '2' });
    b.request!.scripts = { preRequest: '', postResponse: 'pm.test()' };
    const fields = fieldDiffs(a, b).map(f => f.field);
    expect(fields).toContain('url');
    expect(fields).toContain('body');
    expect(fields).toContain('postResponseScript');
  });

  it('carrega os dois valores, pro painel mostrar antes e depois', () => {
    const diff = fieldDiffs(req('r', 'X', { url: 'antigo' }), req('r', 'X', { url: 'novo' }));
    const url = diff.find(f => f.field === 'url')!;
    expect(url.local).toBe('antigo');
    expect(url.remote).toBe('novo');
  });

  // Favorito é marca local e nunca está no arquivo remoto: compará-lo
  // acusaria diferença em todo item favoritado, sempre.
  it('ignora as marcas de favorito', () => {
    const a = { ...req('r', 'X'), starred: true, starredAfterId: 'z' };
    expect(fieldDiffs(a, req('r', 'X'))).toEqual([]);
  });

  // A ordem vive no walk, não aqui: ela depende do pareamento dos filhos, e
  // só lá ele existe.
  it('não olha os filhos', () => {
    const before = folder('f', 'F', [req('r1', 'A'), req('r2', 'B')]);
    const after = folder('f', 'F', [req('r2', 'B'), req('r1', 'A')]);
    expect(fieldDiffs(before, after)).toEqual([]);
  });
});

// A ordem da pasta é o que o Runner executa: trocar dois passos muda o que o
// fluxo faz, então não é cosmético.
describe('reordenação', () => {
  it('marca a pasta cujos filhos trocaram de lugar', () => {
    const before = [folder('f', 'F', [req('r1', 'A'), req('r2', 'B')])];
    const after = [folder('f', 'F', [req('r2', 'B'), req('r1', 'A')])];
    const nodes = diffTrees(before, after);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].fields.map(f => f.field)).toEqual(['order']);
  });

  it('mostra as duas sequências, pro painel exibir antes e depois', () => {
    const before = [folder('f', 'F', [req('r1', 'A'), req('r2', 'B')])];
    const after = [folder('f', 'F', [req('r2', 'B'), req('r1', 'A')])];
    const order = diffTrees(before, after)[0].fields[0];
    expect(order.local).toEqual(['A', 'B']);
    expect(order.remote).toEqual(['B', 'A']);
  });

  // Estes dois são o motivo de a ordem olhar só os filhos comuns: sem isso a
  // mudança seria contada duas vezes, a segunda num nó que ninguém tocou.
  it('renomear um filho não marca a pasta como reordenada', () => {
    const before = [folder('f', 'F', [req('r1', 'A'), req('r2', 'B')])];
    const after = [folder('f', 'F', [req('r1', 'Renomeada'), req('r2', 'B')])];
    const nodes = diffTrees(before, after);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('request');
  });

  it('apagar um filho não marca a pasta como reordenada', () => {
    const before = [folder('f', 'F', [req('r1', 'A'), req('r2', 'B'), req('r3', 'C')])];
    const after = [folder('f', 'F', [req('r1', 'A'), req('r3', 'C')])];
    const nodes = diffTrees(before, after);
    expect(nodes.map(n => n.change)).toEqual(['removed']);
  });

  it('não acusa ordem com um filho só', () => {
    expect(diffTrees([folder('f', 'F', [req('r1', 'A')])], [folder('f', 'F', [req('r1', 'A')])])).toEqual([]);
  });
});

describe('matchChildren', () => {
  it('casa por id mesmo com nome diferente', () => {
    const pairs = matchChildren([req('r1', 'Antigo')], [req('r1', 'Novo')]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].local?.name).toBe('Antigo');
    expect(pairs[0].remote?.name).toBe('Novo');
  });

  // Duas máquinas que criaram "a mesma" request têm ids diferentes; sem o
  // fallback o diff mostraria um add e um remove do mesmo item.
  it('casa por nome quando o id não bate', () => {
    const pairs = matchChildren([req('local-1', 'Token')], [req('remoto-9', 'Token')]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].local && pairs[0].remote).toBeTruthy();
  });

  it('não casa por nome itens de tipos diferentes', () => {
    const pairs = matchChildren([req('a', 'X')], [folder('b', 'X')]);
    expect(pairs).toHaveLength(2);
  });

  // Com nomes repetidos qualquer par seria arbitrário, e errar o par é pior
  // que mostrar adicionar + remover.
  it('desiste do nome quando ele se repete', () => {
    const pairs = matchChildren(
      [req('l1', 'Token'), req('l2', 'Token')],
      [req('r1', 'Token'), req('r2', 'Token')]
    );
    expect(pairs).toHaveLength(4);
  });

  it('não reaproveita o mesmo nó remoto em dois pares', () => {
    const pairs = matchChildren([req('r1', 'A'), req('x', 'A')], [req('r1', 'A')]);
    const matched = pairs.filter(p => p.local && p.remote);
    expect(matched).toHaveLength(1);
  });
});

describe('groupByRoot', () => {
  it('agrupa por collection', () => {
    const local = [folder('c1', 'A', [req('r1', 'X')]), folder('c2', 'B', [req('r2', 'Y')])];
    const remote = [
      folder('c1', 'A', [req('r1', 'X', { body: '1' })]),
      folder('c2', 'B', [req('r2', 'Y', { body: '2' })]),
    ];
    const groups = groupByRoot(diffTrees(local, remote));
    expect(groups.size).toBe(2);
    expect(groups.get('c1')).toHaveLength(1);
  });
});

describe('filterSubtree', () => {
  const req2 = (id: string, name: string, body = ''): CollectionItem => ({
    id, name, type: 'request', method: 'GET',
    request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
  });
  const dir = (id: string, name: string, children: CollectionItem[] = []): CollectionItem =>
    ({ id, name, type: 'folder', item: children });

  // Sprint com duas User Stories: trazer a atualização de uma sem mexer na
  // outra é o caso que motivou o recorte.
  const local = [dir('c', 'Sprints', [
    dir('s1', 'US 1342018', [req2('a1', 'Checkout'), req2('a2', 'Order')]),
    dir('s2', 'US 1345299', [req2('b1', 'Change')]),
  ])];
  const remote = [dir('c', 'Sprints', [
    dir('s1', 'US 1342018', [req2('a1', 'Checkout', 'novo'), req2('a2', 'Order'), req2('a3', 'Payment')]),
    dir('s2', 'US 1345299', [req2('b1', 'Change', 'tambem-novo')]),
  ])];

  const nodes = diffTrees(local, remote);
  const names = (list: typeof nodes) => list.map(n => n.path[n.path.length - 1]).sort();

  it('traz só o que está dentro da pasta escolhida', () => {
    expect(names(filterSubtree(nodes, 's1'))).toEqual(['Checkout', 'Payment']);
  });

  it('não traz nada da pasta irmã', () => {
    expect(names(filterSubtree(nodes, 's1'))).not.toContain('Change');
  });

  it('a outra pasta recorta a sua própria parte', () => {
    expect(names(filterSubtree(nodes, 's2'))).toEqual(['Change']);
  });

  // Um nó adicionado só existe do lado remoto; é pelo pai que se sabe onde
  // ele entra.
  it('inclui o que foi adicionado dentro da pasta', () => {
    expect(names(filterSubtree(nodes, 's1'))).toContain('Payment');
  });

  it('a raiz recorta tudo', () => {
    expect(filterSubtree(nodes, 'c')).toHaveLength(nodes.length);
  });

  it('pasta sem alteração devolve vazio', () => {
    const iguais = diffTrees(local, local);
    expect(filterSubtree(iguais, 's1')).toEqual([]);
  });

  it('id inexistente devolve vazio', () => {
    expect(filterSubtree(nodes, 'zzz')).toEqual([]);
  });

  // A lista é achatada e um filho pode vir antes do pai: uma passada só
  // perderia os netos.
  it('alcança netos', () => {
    const deepLocal = [dir('c', 'Raiz', [dir('f1', 'A', [dir('f2', 'B', [req2('r', 'X')])])])];
    const deepRemote = [dir('c', 'Raiz', [dir('f1', 'A', [dir('f2', 'B', [req2('r', 'X', 'mudou')])])])];
    expect(names(filterSubtree(diffTrees(deepLocal, deepRemote), 'f1'))).toEqual(['X']);
  });
});

describe('fieldDiffs > campos do time', () => {
  it('acusa descrição diferente', () => {
    const a = { ...req('r', 'Token'), description: 'local' };
    const b = { ...req('r', 'Token'), description: 'remoto' };
    expect(fieldDiffs(a, b)).toEqual([{ field: 'description', local: 'local', remote: 'remoto' }]);
  });

  it('acusa marcador diferente', () => {
    const a = { ...req('r', 'Token'), markers: ['m1'] };
    const b = { ...req('r', 'Token'), markers: ['m1', 'm2'] };
    expect(fieldDiffs(a, b).map(f => f.field)).toEqual(['markers']);
  });

  it('não acusa quando os dois lados têm os mesmos', () => {
    const a = { ...req('r', 'Token'), markers: ['m1'], description: 'igual' };
    const b = { ...req('r', 'Token'), markers: ['m1'], description: 'igual' };
    expect(fieldDiffs(a, b)).toEqual([]);
  });

  // starred continua local: favoritar nao pode virar alteracao pendente.
  it('favorito continua fora do diff', () => {
    const a = { ...req('r', 'Token'), starred: true };
    const b = req('r', 'Token');
    expect(fieldDiffs(a, b)).toEqual([]);
  });
});
