import type { DiffNode } from './collectionDiff';
import { changedSinceBase, type NodeHashes } from './syncBase';

// ─────────────────────────────────────────────────────────────────────────
// Estado das caixinhas da tela de comparação.
//
// Separado da UI porque a parte que importa não é desenho: é saber quais
// escolhas descartam trabalho local. Um nó pode estar alterado no GitHub E
// ter alteração sua não enviada — aceitar o remoto ali apaga a sua versão, e
// isso não pode parecer uma atualização qualquer no meio da lista.
// ─────────────────────────────────────────────────────────────────────────

export type RootState = 'all' | 'none' | 'partial';

export function toggleNode(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function nodesOfRoot(nodes: DiffNode[], rootId: string): DiffNode[] {
  return nodes.filter(n => n.rootId === rootId);
}

/** Marca ou desmarca a collection inteira — o atalho para "aceitar tudo daqui". */
export function toggleRoot(
  selected: ReadonlySet<string>,
  nodes: DiffNode[],
  rootId: string
): Set<string> {
  const ids = nodesOfRoot(nodes, rootId).map(n => n.id);
  const next = new Set(selected);
  // Parcial conta como "não está tudo", então o clique completa a seleção em
  // vez de esvaziá-la: é o que se espera de uma caixa em estado intermediário.
  if (ids.every(id => next.has(id))) {
    for (const id of ids) next.delete(id);
  } else {
    for (const id of ids) next.add(id);
  }
  return next;
}

export function rootState(
  selected: ReadonlySet<string>,
  nodes: DiffNode[],
  rootId: string
): RootState {
  const ids = nodesOfRoot(nodes, rootId).map(n => n.id);
  if (ids.length === 0) return 'none';
  const count = ids.filter(id => selected.has(id)).length;
  if (count === 0) return 'none';
  return count === ids.length ? 'all' : 'partial';
}

/**
 * Nós em que aceitar o remoto descarta trabalho local.
 *
 * É o caso de uma collection que está marcada como pendente de push (você
 * editou e ainda não enviou) e que também mudou no GitHub. Aceitar sobrescreve
 * a sua versão, e sem destacar isso a linha fica igual a qualquer outra
 * atualização — a perda só apareceria depois, sem explicação.
 *
 * Nós `added` ficam de fora: não existe versão local para perder.
 */
export function conflictingIds(
  nodes: DiffNode[],
  pendingCollectionIds: ReadonlySet<string>,
  base: NodeHashes | null = null
): Set<string> {
  const out = new Set<string>();

  for (const node of nodes) {
    // `added` só existe do lado remoto: não há versão local para perder.
    if (node.change === 'added') continue;

    const changedHere = changedSinceBase(base, node.id, node.local);

    // Sem base — primeira sincronização depois desta mudança, ou workspace
    // nunca enviado — não há como saber quem mexeu. Recai no critério
    // antigo, que erra para o lado de avisar demais em vez de calar.
    if (changedHere === null) {
      if (pendingCollectionIds.has(node.rootId)) out.add(node.id);
      continue;
    }

    // Mudou dos DOIS lados. Se mudou só lá, aceitar não descarta nada seu.
    if (changedHere) out.add(node.id);
  }

  return out;
}

export interface SelectionSummary {
  total: number;
  selected: number;
  added: number;
  removed: number;
  modified: number;
  /** Selecionados que descartam alteração local não enviada. */
  conflicts: number;
}

export function summarize(
  nodes: DiffNode[],
  selected: ReadonlySet<string>,
  conflicts: ReadonlySet<string>
): SelectionSummary {
  const chosen = nodes.filter(n => selected.has(n.id));
  return {
    total: nodes.length,
    selected: chosen.length,
    added: chosen.filter(n => n.change === 'added').length,
    removed: chosen.filter(n => n.change === 'removed').length,
    modified: chosen.filter(n => n.change === 'modified').length,
    conflicts: chosen.filter(n => conflicts.has(n.id)).length,
  };
}

/**
 * Seleção inicial: tudo que NÃO conflita.
 *
 * Deixar tudo marcado faria o caminho de menor esforço descartar trabalho
 * local em silêncio; deixar tudo desmarcado obrigaria a clicar item a item no
 * caso comum, que é não haver conflito nenhum.
 */
export function defaultSelection(
  nodes: DiffNode[],
  conflicts: ReadonlySet<string>
): Set<string> {
  return safeSelection(nodes, conflicts);
}

/**
 * Tudo que pode ser aceito sem descartar trabalho local.
 *
 * É o atalho que torna a tela usável em volume: depois da comparação de três
 * vias a maioria das mudanças só aconteceu do outro lado, e revisar uma a uma
 * não acrescenta nada. O que sobra marcado é exatamente o que precisa de
 * decisão humana.
 */
export function safeSelection(
  nodes: DiffNode[],
  conflicts: ReadonlySet<string>
): Set<string> {
  return selectWithin(new Set(), nodes, 'safe', conflicts);
}

export type ScopeMode = 'all' | 'none' | 'safe';

/**
 * Aplica um recorte APENAS aos nós do escopo, preservando o resto da seleção.
 *
 * O escopo é o que está visível. Com um filtro ativo, um "All" que marcasse a
 * lista inteira seria a pior armadilha da tela: você filtra para ver os três
 * conflitos, clica em "All" achando que marca três, e marca oitenta — e o
 * que foi marcado sem você ver não cabe mais na tela pra ser conferido.
 *
 * Preservar o de fora é o outro lado disso: trocar o filtro não pode desfazer
 * escolha já feita, senão revisar por partes seria impossível.
 */
export function selectWithin(
  selected: ReadonlySet<string>,
  scope: DiffNode[],
  mode: ScopeMode,
  conflicts: ReadonlySet<string> = new Set()
): Set<string> {
  const next = new Set(selected);
  for (const node of scope) {
    const on = mode === 'all' ? true : mode === 'none' ? false : !conflicts.has(node.id);
    if (on) next.add(node.id);
    else next.delete(node.id);
  }
  return next;
}

export interface SelectionCounts {
  /** Aceitáveis sem perder nada. */
  safe: number;
  /** Precisam de decisão: mudaram dos dois lados. */
  conflicting: number;
}

export function countByRisk(
  nodes: DiffNode[],
  conflicts: ReadonlySet<string>
): SelectionCounts {
  const conflicting = nodes.filter(n => conflicts.has(n.id)).length;
  return { safe: nodes.length - conflicting, conflicting };
}
