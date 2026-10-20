import { describe, it, expect } from 'vitest';
import {
  moveNode,
  projectSiblingDrop,
  toggleStarNode,
  stripStarredFlags,
  collectStarMarks,
  applyStarMarks,
  duplicateNode,
  moveUp,
  moveDown,
  moveOut,
  canMoveUp,
  canMoveDown,
  canMoveOut,
  findRequestsByName,
} from './tree.utils';
import type { CollectionItem } from '@/app/types/CollectionItem';

const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: id, type: 'folder', item: children }) as CollectionItem;

const find = (items: CollectionItem[], id: string): CollectionItem | undefined => {
  for (const i of items) {
    if (i.id === id) return i;
    const deep = i.item && find(i.item, id);
    if (deep) return deep;
  }
};

const parentOf = (
  items: CollectionItem[],
  id: string,
  parent: CollectionItem | null = null
): CollectionItem | null | undefined => {
  for (const i of items) {
    if (i.id === id) return parent;
    if (i.item) {
      const found = parentOf(i.item, id, i);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const names = (items: CollectionItem[] | undefined) => (items ?? []).map(i => i.name);

describe('moveNode', () => {
  // ColA > X > Y > Z, e ColB solta na raiz.
  const tree = () => [folder('ColA', [folder('X', [folder('Y', [folder('Z')])])]), folder('ColB')];

  it('move uma pasta para dentro de outra', () => {
    const next = moveNode(tree(), 'Y', 'ColB', 'inside');
    expect(parentOf(next, 'Y')?.id).toBe('ColB');
    expect(find(next, 'X')!.item).toHaveLength(0);
  });

  it('move a subárvore junto', () => {
    const next = moveNode(tree(), 'Y', 'ColB', 'inside');
    expect(find(next, 'Z')).toBeDefined();
    expect(parentOf(next, 'Z')?.id).toBe('Y');
  });

  it('reordena irmãos na raiz', () => {
    expect(names(moveNode(tree(), 'ColB', 'ColA', 'before'))).toEqual(['ColB', 'ColA']);
  });

  // Mover uma pasta pra dentro do próprio filho a desconectaria da árvore.
  it('recusa criar ciclo', () => {
    const original = tree();
    expect(moveNode(original, 'X', 'Z', 'inside')).toBe(original);
  });

  it('ignora id inexistente', () => {
    const original = tree();
    expect(moveNode(original, 'naoExiste', 'ColB', 'inside')).toBe(original);
  });
});

// Converte a posição horizontal do ponteiro em "de quem vou virar irmão".
// É o que permite tirar uma pasta de dentro de outra arrastando pra esquerda.
describe('projectSiblingDrop', () => {
  // Linhas visíveis de ColA > X > Y, com ColB logo depois na raiz.
  const rows = [
    { id: 'ColA', depth: 0 },
    { id: 'X', depth: 1 },
    { id: 'Y', depth: 2 },
    { id: 'ColB', depth: 0 },
  ];
  const belowY = 2;

  it('sem puxar, vira irmão da linha de cima', () => {
    expect(projectSiblingDrop(rows, belowY, 0)).toEqual({ targetId: 'Y', depth: 2 });
  });

  it('cada nível puxado sobe um ancestral', () => {
    expect(projectSiblingDrop(rows, belowY, 1)).toEqual({ targetId: 'X', depth: 1 });
    expect(projectSiblingDrop(rows, belowY, 2)).toEqual({ targetId: 'ColA', depth: 0 });
  });

  it('satura na raiz em vez de passar do limite', () => {
    expect(projectSiblingDrop(rows, belowY, 9)).toEqual({ targetId: 'ColA', depth: 0 });
  });

  // Com irmãos ainda abaixo, subir faria o item pular na frente deles — e o
  // traço na tela estaria mentindo sobre onde ele vai parar.
  it('não sobe além do nível da linha seguinte', () => {
    const comIrmao = [
      { id: 'ColA', depth: 0 },
      { id: 'X', depth: 1 },
      { id: 'Y', depth: 2 },
      { id: 'W', depth: 1 },
    ];
    expect(projectSiblingDrop(comIrmao, 2, 9).depth).toBe(1);
  });
});

describe('toggleStarNode', () => {
  const tree = () => [folder('Col', [folder('A'), folder('B'), folder('C')])];

  it('favoritar move para o topo dos irmãos', () => {
    const next = toggleStarNode(tree(), 'C');
    expect(names(find(next, 'Col')!.item)).toEqual(['C', 'A', 'B']);
    expect(find(next, 'C')!.starred).toBe(true);
  });

  it('guarda de onde saiu', () => {
    expect(find(toggleStarNode(tree(), 'C'), 'C')!.starredAfterId).toBe('B');
  });

  it('desfavoritar devolve à posição original', () => {
    const favoritado = toggleStarNode(tree(), 'C');
    const next = toggleStarNode(favoritado, 'C');
    expect(names(find(next, 'Col')!.item)).toEqual(['A', 'B', 'C']);
    expect(find(next, 'C')!.starred).toBeFalsy();
    expect(find(next, 'C')!.starredAfterId).toBeUndefined();
  });

  it('quem já era o primeiro continua no lugar ao desfavoritar', () => {
    const next = toggleStarNode(toggleStarNode(tree(), 'A'), 'A');
    expect(names(find(next, 'Col')!.item)).toEqual(['A', 'B', 'C']);
  });

  // Sem a âncora, desfavoritar teleportaria a pasta pra um lugar que o
  // usuário já abandonou de propósito.
  it('arrastar esquece a âncora', () => {
    const favoritado = toggleStarNode(tree(), 'C');
    const arrastado = moveNode(favoritado, 'C', 'B', 'after');
    expect(find(arrastado, 'C')!.starredAfterId).toBeUndefined();
    expect(names(find(toggleStarNode(arrastado, 'C'), 'Col')!.item)).toEqual(['A', 'B', 'C']);
  });
});

// A estrela é preferência pessoal: não sobe pro GitHub, e o pull não pode
// apagá-la.
describe('marcas de favorito são locais', () => {
  const comEstrela = () => toggleStarNode([folder('Col', [folder('A'), folder('B')])], 'B');

  it('o que vai pro GitHub não leva marca nenhuma', () => {
    const enviado = comEstrela().map(stripStarredFlags);
    const texto = JSON.stringify(enviado);
    expect(texto).not.toContain('starred');
    expect(texto).not.toContain('starredAfterId');
  });

  it('o resto do conteúdo é preservado', () => {
    expect(names(stripStarredFlags(comEstrela()[0]).item)).toEqual(['B', 'A']);
  });

  it('o pull recoloca as marcas locais', () => {
    const local = comEstrela();
    const doGitHub = local.map(stripStarredFlags);
    const merged = applyStarMarks(doGitHub, collectStarMarks(local));
    expect(find(merged, 'B')!.starred).toBe(true);
    expect(find(merged, 'B')!.starredAfterId).toBe('A');
  });
});

describe('duplicateNode', () => {
  const named = (id: string, name: string, children?: CollectionItem[]): CollectionItem =>
    ({ id, name, type: children ? 'folder' : 'request', ...(children ? { item: children } : {}) }) as CollectionItem;

  const names = (items: CollectionItem[] | undefined) => (items ?? []).map(i => i.name);
  const allIds = (items: CollectionItem[]): string[] =>
    items.flatMap(i => [i.id, ...allIds(i.item ?? [])]);

  it('insere a cópia logo depois do original', () => {
    const result = duplicateNode([named('a', 'Pagamentos'), named('b', 'Reservas')], 'a');
    expect(names(result)).toEqual(['Pagamentos', 'Pagamentos (Copy)', 'Reservas']);
  });

  // O que motivou a mudança: num fluxo o nome da request é o passo
  // ("1 - Gerar token"), e o sufixo em cada filho estraga o que se lê pra
  // entender a ordem.
  it('só o nó duplicado ganha (Copy) — os filhos mantêm o nome', () => {
    const tree = [named('f', 'Fluxo', [named('r1', '1 - Gerar token'), named('r2', '2 - Checkout')])];
    const copy = duplicateNode(tree, 'f')[1];
    expect(copy.name).toBe('Fluxo (Copy)');
    expect(names(copy.item)).toEqual(['1 - Gerar token', '2 - Checkout']);
  });

  it('mantém os nomes também em subpastas', () => {
    const tree = [named('f', 'Fluxo', [named('sub', 'Auth', [named('r', 'Token')])])];
    const copy = duplicateNode(tree, 'f')[1];
    expect(copy.item![0].name).toBe('Auth');
    expect(copy.item![0].item![0].name).toBe('Token');
  });

  // Id repetido faz findNodeById devolver o primeiro, e editar a cópia
  // passaria a editar o original.
  it('troca todos os ids da subárvore', () => {
    const tree = [named('f', 'Fluxo', [named('r1', 'A'), named('r2', 'B')])];
    const result = duplicateNode(tree, 'f');
    const ids = allIds(result);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('duplica um nó aninhado sem tocar nos irmãos', () => {
    const tree = [named('f', 'Fluxo', [named('r1', 'A'), named('r2', 'B')])];
    const result = duplicateNode(tree, 'r1');
    expect(names(result[0].item)).toEqual(['A', 'A (Copy)', 'B']);
  });

  it('id inexistente não altera nada', () => {
    const tree = [named('f', 'Fluxo', [named('r1', 'A')])];
    expect(names(duplicateNode(tree, 'zzz'))).toEqual(['Fluxo']);
  });
});

describe('mover pelo menu', () => {
  const node = (id: string, children?: CollectionItem[]): CollectionItem =>
    ({ id, name: id, type: children ? 'folder' : 'request', ...(children ? { item: children } : {}) }) as CollectionItem;

  const ids = (items: CollectionItem[] | undefined) => (items ?? []).map(i => i.id);

  // a[ x, y, z ], b
  const tree = () => [node('a', [node('x'), node('y'), node('z')]), node('b')];

  describe('moveUp', () => {
    it('troca com o irmão de cima', () => {
      expect(ids(moveUp(tree(), 'y')[0].item)).toEqual(['y', 'x', 'z']);
    });

    it('não faz nada no primeiro', () => {
      const before = tree();
      expect(ids(moveUp(before, 'x')[0].item)).toEqual(['x', 'y', 'z']);
    });

    it('funciona na raiz', () => {
      expect(ids(moveUp(tree(), 'b'))).toEqual(['b', 'a']);
    });

    it('não tira o nó da pasta', () => {
      expect(ids(moveUp(tree(), 'y'))).toEqual(['a', 'b']);
    });
  });

  describe('moveDown', () => {
    it('troca com o irmão de baixo', () => {
      expect(ids(moveDown(tree(), 'y')[0].item)).toEqual(['x', 'z', 'y']);
    });

    it('não faz nada no último', () => {
      expect(ids(moveDown(tree(), 'z')[0].item)).toEqual(['x', 'y', 'z']);
    });
  });

  describe('moveOut', () => {
    // Depois da pasta, não antes: ele veio de dentro dela.
    it('tira da pasta e põe logo depois dela', () => {
      expect(ids(moveOut(tree(), 'y'))).toEqual(['a', 'y', 'b']);
    });

    it('o nó sai mesmo da pasta', () => {
      expect(ids(moveOut(tree(), 'y')[0].item)).toEqual(['x', 'z']);
    });

    it('não faz nada em quem já está na raiz', () => {
      const before = tree();
      expect(moveOut(before, 'a')).toBe(before);
    });

    it('sobe só um nível por vez', () => {
      const deep = [node('a', [node('f', [node('x')])])];
      const result = moveOut(deep, 'x');
      expect(ids(result[0].item)).toEqual(['f', 'x']);
      expect(ids(result)).toEqual(['a']);
    });

    it('leva os filhos junto', () => {
      const deep = [node('a', [node('f', [node('x'), node('y')])])];
      const result = moveOut(deep, 'f');
      // `f` saiu de `a` e foi pra raiz, logo depois dela.
      expect(ids(result)).toEqual(['a', 'f']);
      expect(ids(result.find(i => i.id === 'f')?.item)).toEqual(['x', 'y']);
    });
  });

  describe('o que o menu habilita', () => {
    it('primeiro não sobe, último não desce', () => {
      expect(canMoveUp(tree(), 'x')).toBe(false);
      expect(canMoveDown(tree(), 'z')).toBe(false);
      expect(canMoveUp(tree(), 'y')).toBe(true);
      expect(canMoveDown(tree(), 'y')).toBe(true);
    });

    it('quem está na raiz não tem de onde sair', () => {
      expect(canMoveOut(tree(), 'a')).toBe(false);
      expect(canMoveOut(tree(), 'y')).toBe(true);
    });

    it('id inexistente não habilita nada', () => {
      expect(canMoveUp(tree(), 'zzz')).toBe(false);
      expect(canMoveDown(tree(), 'zzz')).toBe(false);
      expect(canMoveOut(tree(), 'zzz')).toBe(false);
    });
  });
});

describe('findRequestsByName', () => {
  const req = (id: string, name: string): CollectionItem =>
    ({ id, name, type: 'request', method: 'GET' }) as CollectionItem;
  const dir = (id: string, name: string, children: CollectionItem[]): CollectionItem =>
    ({ id, name, type: 'folder', item: children }) as CollectionItem;

  const tree = [
    dir('c1', 'Portal APIs', [
      dir('f1', 'Flow Tests', [req('r1', 'Quote By Number'), req('r2', 'Order')]),
    ]),
    dir('c2', 'Portal B2B', [
      dir('f2', 'Flow Tests', [req('r3', 'Quote By Number')]),
    ]),
    req('r4', 'Quote By Number'),
  ];

  it('acha as homônimas em outras collections', () => {
    expect(findRequestsByName(tree, 'Quote By Number', 'r1').map(m => m.id)).toEqual(['r3', 'r4']);
  });

  it('exclui a própria request', () => {
    expect(findRequestsByName(tree, 'Quote By Number', 'r1').map(m => m.id)).not.toContain('r1');
  });

  it('devolve o caminho, pra confirmação mostrar onde', () => {
    const match = findRequestsByName(tree, 'Quote By Number', 'r1')[0];
    expect(match.path).toEqual(['Portal B2B', 'Flow Tests']);
  });

  // Falso positivo aqui SOBRESCREVE uma request que ninguém mandou mexer.
  describe('comparação exata', () => {
    it('não ignora maiúsculas', () => {
      expect(findRequestsByName([req('a', 'quote by number')], 'Quote By Number', 'x')).toEqual([]);
    });

    it('não apara espaços', () => {
      expect(findRequestsByName([req('a', 'Quote By Number ')], 'Quote By Number', 'x')).toEqual([]);
    });
  });

  it('não casa pasta com o mesmo nome', () => {
    const comPasta = [dir('f', 'Quote By Number', [req('r', 'outro')])];
    expect(findRequestsByName(comPasta, 'Quote By Number', 'x')).toEqual([]);
  });

  it('nome vazio não casa nada', () => {
    expect(findRequestsByName(tree, '', 'x')).toEqual([]);
  });

  it('sem homônima devolve vazio', () => {
    expect(findRequestsByName(tree, 'Order', 'r2')).toEqual([]);
  });
});
