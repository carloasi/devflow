import { describe, it, expect } from 'vitest';
import {
  applyFilter,
  groupByParent,
  isFiltering,
  labelOf,
  matchesFilter,
  NO_FILTER,
  type DiffFilter,
} from './diffList';
import type { DiffNode } from './collectionDiff';

const node = (
  path: string[],
  change: DiffNode['change'] = 'modified',
  id = path.join('/')
): DiffNode => ({
  id,
  path,
  rootId: path[0],
  ancestorIds: [path[0]],
  kind: 'request',
  change,
  fields: [],
});

const filter = (partial: Partial<DiffFilter>): DiffFilter => ({ ...NO_FILTER, ...partial });

describe('labelOf', () => {
  it('separa o nome das pastas', () => {
    expect(labelOf(node(['Voos', 'Auth', 'Token', 'Get MSAL token']))).toEqual({
      name: 'Get MSAL token',
      parents: 'Auth / Token',
    });
  });

  // A collection já é o cabeçalho do grupo: repeti-la na linha gastaria a
  // largura que falta pro nome.
  it('não conta a collection como pasta', () => {
    expect(labelOf(node(['Voos', 'Search']))).toEqual({ name: 'Search', parents: '' });
  });

  it('a própria collection raiz', () => {
    expect(labelOf(node(['Voos']))).toEqual({ name: 'Voos', parents: '' });
  });

  it('caminho vazio não quebra', () => {
    expect(labelOf(node([]))).toEqual({ name: '', parents: '' });
  });
});

describe('isFiltering', () => {
  it('nada ativo', () => {
    expect(isFiltering(NO_FILTER)).toBe(false);
  });

  // Espaço digitado por acidente não pode esconder a lista inteira.
  it('texto em branco não conta', () => {
    expect(isFiltering(filter({ text: '   ' }))).toBe(false);
  });

  it('texto, tipo de mudança e conflitos contam', () => {
    expect(isFiltering(filter({ text: 'token' }))).toBe(true);
    expect(isFiltering(filter({ change: 'added' }))).toBe(true);
    expect(isFiltering(filter({ conflictsOnly: true }))).toBe(true);
  });
});

describe('matchesFilter', () => {
  const target = node(['Voos', 'Auth', 'Get MSAL token']);
  const semConflito = new Set<string>();
  const comConflito = new Set([target.id]);

  it('casa no nome, ignorando caixa', () => {
    expect(matchesFilter(target, semConflito, filter({ text: 'msal' }))).toBe(true);
  });

  // É assim que se procura "aquele fluxo de token" sem lembrar o nome exato.
  it('casa no nome da pasta e traz o que está dentro', () => {
    expect(matchesFilter(target, semConflito, filter({ text: 'auth' }))).toBe(true);
  });

  it('casa no nome da collection', () => {
    expect(matchesFilter(target, semConflito, filter({ text: 'voos' }))).toBe(true);
  });

  it('casa no caminho montado, com os separadores', () => {
    expect(matchesFilter(target, semConflito, filter({ text: 'auth / get' }))).toBe(true);
  });

  it('o que não casa fica fora', () => {
    expect(matchesFilter(target, semConflito, filter({ text: 'tarifa' }))).toBe(false);
  });

  it('espaço nas pontas é ignorado', () => {
    expect(matchesFilter(target, semConflito, filter({ text: '  msal  ' }))).toBe(true);
  });

  it('tipo de mudança', () => {
    expect(matchesFilter(target, semConflito, filter({ change: 'modified' }))).toBe(true);
    expect(matchesFilter(target, semConflito, filter({ change: 'added' }))).toBe(false);
  });

  it('só conflitos', () => {
    expect(matchesFilter(target, comConflito, filter({ conflictsOnly: true }))).toBe(true);
    expect(matchesFilter(target, semConflito, filter({ conflictsOnly: true }))).toBe(false);
  });

  // Os critérios se somam: quem filtra por conflito E por texto quer os dois.
  it('critérios se acumulam', () => {
    const f = filter({ text: 'msal', conflictsOnly: true });
    expect(matchesFilter(target, comConflito, f)).toBe(true);
    expect(matchesFilter(target, semConflito, f)).toBe(false);
  });
});

describe('applyFilter', () => {
  const nodes = [
    node(['Voos', 'Auth', 'Get MSAL token']),
    node(['Voos', 'Auth', 'Refresh token'], 'added'),
    node(['Voos', 'Search', 'Availability']),
  ];

  it('recorta pelo texto', () => {
    expect(applyFilter(nodes, new Set(), filter({ text: 'token' })).length).toBe(2);
  });

  it('recorta pelo tipo', () => {
    expect(applyFilter(nodes, new Set(), filter({ change: 'added' })).map(n => n.id)).toEqual([
      'Voos/Auth/Refresh token',
    ]);
  });

  // A lista inteira depende deste array; recriá-la a cada render descartaria a
  // rolagem no caso comum, que é não haver filtro.
  it('sem filtro devolve o MESMO array', () => {
    expect(applyFilter(nodes, new Set(), NO_FILTER)).toBe(nodes);
  });

  it('nada casa devolve vazio, não a lista toda', () => {
    expect(applyFilter(nodes, new Set(), filter({ text: 'xyz' }))).toEqual([]);
  });

  it('preserva a ordem da árvore', () => {
    expect(applyFilter(nodes, new Set(), filter({ text: 'voos' })).map(n => n.id)).toEqual(
      nodes.map(n => n.id)
    );
  });
});

describe('groupByParent', () => {
  it('junta as linhas da mesma pasta', () => {
    const nodes = [
      node(['Voos', 'Auth', 'Get MSAL token']),
      node(['Voos', 'Auth', 'Refresh token']),
      node(['Voos', 'Search', 'Availability']),
    ];
    const groups = groupByParent(nodes);
    expect([...groups.keys()]).toEqual(['Auth', 'Search']);
    expect(groups.get('Auth')!.length).toBe(2);
  });

  it('itens na raiz da collection caem no grupo sem nome', () => {
    const groups = groupByParent([node(['Voos', 'Search']), node(['Voos'])]);
    expect([...groups.keys()]).toEqual(['']);
    expect(groups.get('')!.length).toBe(2);
  });

  // walkPairs desce em profundidade, então os filhos diretos de uma pasta
  // aparecem antes E depois dos filhos de uma subpasta. Precisam cair no mesmo
  // grupo, senão o cabeçalho "Auth" se repete no meio da lista.
  it('junta pedaços não contíguos da mesma pasta', () => {
    const groups = groupByParent([
      node(['Voos', 'Auth', 'primeiro']),
      node(['Voos', 'Auth', 'Sub', 'dentro']),
      node(['Voos', 'Auth', 'ultimo']),
    ]);
    expect([...groups.keys()]).toEqual(['Auth', 'Auth / Sub']);
    expect(groups.get('Auth')!.map(n => labelOf(n).name)).toEqual(['primeiro', 'ultimo']);
  });

  it('a ordem dos grupos é a da árvore', () => {
    const groups = groupByParent([
      node(['Voos', 'Zz', 'a']),
      node(['Voos', 'Aa', 'b']),
    ]);
    expect([...groups.keys()]).toEqual(['Zz', 'Aa']);
  });

  it('lista vazia', () => {
    expect(groupByParent([]).size).toBe(0);
  });
});

describe('ordem do grupo da raiz', () => {
  // Sem cabeçalho pra chamar de seu, o grupo da raiz no meio da lista parece
  // parte do grupo acima dele. No topo, a ausência de cabeçalho diz a verdade.
  it('vem primeiro mesmo aparecendo por último na árvore', () => {
    const groups = groupByParent([
      node(['Voos', 'Disponibilidade', 'Tarifas', 'Familia']),
      node(['Voos', 'Reserva']),
    ]);
    expect([...groups.keys()]).toEqual(['', 'Disponibilidade / Tarifas']);
  });

  it('não reordena quando a raiz é o único grupo', () => {
    const groups = groupByParent([node(['Voos', 'Reserva'])]);
    expect([...groups.keys()]).toEqual(['']);
  });

  it('o resto mantém a ordem da árvore', () => {
    const groups = groupByParent([
      node(['Voos', 'Zz', 'a']),
      node(['Voos', 'solto']),
      node(['Voos', 'Aa', 'b']),
    ]);
    expect([...groups.keys()]).toEqual(['', 'Zz', 'Aa']);
  });
});
