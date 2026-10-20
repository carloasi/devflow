import type { DiffNode } from './collectionDiff';

// ─────────────────────────────────────────────────────────────────────────
// Como a lista da tela de comparação se apresenta: rótulo de cada linha,
// agrupamento por pasta e filtro.
//
// O problema que isto resolve é de leitura, não de lógica. A linha mostrava
// o caminho inteiro (`Auth / Token / Get MSAL token`) num painel de meia
// largura, então o que sobrava na tela era o começo do caminho — a parte
// IGUAL em todas as linhas da mesma pasta — e o nome do item, que é o que se
// procura, era exatamente o pedaço cortado.
//
// Com centenas de itens some também a chance de achar algo por rolagem, daí
// o filtro. Separado da UI porque "o que conta como achado" é regra: a busca
// casa no caminho inteiro, e não só no nome, porque se procura tanto pelo
// item quanto pela pasta que o contém.
// ─────────────────────────────────────────────────────────────────────────

export interface NodeLabel {
  /** O nome do item — o que a pessoa lê e procura. */
  name: string;
  /** Pastas entre a collection e o item. Vazio quando está na raiz dela. */
  parents: string;
}

/**
 * Quebra o caminho em nome e pastas.
 *
 * `path` começa no nome da collection, então ele sai fora de `parents`: a
 * linha já vive embaixo do cabeçalho da collection, e repeti-lo em cada
 * linha gastaria a largura que falta pro nome.
 */
export function labelOf(node: DiffNode): NodeLabel {
  const path = node.path;
  // Caminho de um só segmento é a própria collection raiz — ela aparece como
  // linha quando o que mudou é um campo dela.
  if (path.length <= 1) return { name: path[0] ?? '', parents: '' };
  return { name: path[path.length - 1], parents: path.slice(1, -1).join(' / ') };
}

export type ChangeFilter = 'all' | DiffNode['change'];

export interface DiffFilter {
  text: string;
  change: ChangeFilter;
  /** Só o que mudou dos dois lados — o que de fato precisa de decisão. */
  conflictsOnly: boolean;
}

export const NO_FILTER: DiffFilter = { text: '', change: 'all', conflictsOnly: false };

export function isFiltering(filter: DiffFilter): boolean {
  return filter.text.trim() !== '' || filter.change !== 'all' || filter.conflictsOnly;
}

export function matchesFilter(
  node: DiffNode,
  conflicts: ReadonlySet<string>,
  filter: DiffFilter
): boolean {
  if (filter.change !== 'all' && node.change !== filter.change) return false;
  if (filter.conflictsOnly && !conflicts.has(node.id)) return false;

  const text = filter.text.trim().toLowerCase();
  if (!text) return true;
  // Caminho inteiro, com a collection: digitar o nome da pasta tem que trazer
  // o que está dentro dela, que é como se procura "aquele fluxo de token".
  return node.path.join(' / ').toLowerCase().includes(text);
}

/**
 * Sem filtro ativo devolve o MESMO array, não uma cópia: a lista inteira
 * depende dele, e recriá-la a cada render descartaria o estado de rolagem no
 * caso comum, que é não haver filtro.
 */
export function applyFilter(
  nodes: DiffNode[],
  conflicts: ReadonlySet<string>,
  filter: DiffFilter
): DiffNode[] {
  if (!isFiltering(filter)) return nodes;
  return nodes.filter(n => matchesFilter(n, conflicts, filter));
}

/**
 * Agrupa por pasta, preservando a ordem da árvore.
 *
 * Isto é o que tira a repetição da tela: doze requests da mesma pasta passam
 * a ser um cabeçalho e doze nomes, em vez de doze caminhos idênticos até o
 * último segmento.
 *
 * Pastas irmãs de nome igual caem no mesmo grupo. É aceitável porque na
 * árvore elas também se parecem — e o nome de cada linha continua distinto.
 */
export function groupByParent(nodes: DiffNode[]): Map<string, DiffNode[]> {
  const groups = new Map<string, DiffNode[]>();
  for (const node of nodes) {
    const key = labelOf(node).parents;
    const list = groups.get(key);
    if (list) list.push(node);
    else groups.set(key, [node]);
  }

  // O grupo da raiz vem primeiro, SEMPRE. Ele é o único sem cabeçalho — não
  // há pasta pra nomear — e no meio da lista isso o fazia parecer parte do
  // grupo de cima: um item solto na collection aparecia colado embaixo de
  // "Disponibilidade / Tarifas", como se estivesse lá dentro. No topo, logo
  // abaixo do nome da collection, a ausência de cabeçalho diz a coisa certa.
  const root = groups.get('');
  if (root && groups.size > 1) {
    groups.delete('');
    return new Map([['', root], ...groups]);
  }

  return groups;
}
