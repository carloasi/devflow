import type { DiffNode } from './collectionDiff';
import { changedInSubtree, changedSinceBase, type NodeHashes } from './syncBase';

// ─────────────────────────────────────────────────────────────────────────
// QUEM mexeu em cada item da tela de comparação.
//
// O diff de duas vias só sabe que os lados diferem: "existe só no GitHub"
// tanto pode ser algo novo lá quanto algo que você apagou aqui; "existe só
// aqui" tanto pode ser algo seu, nunca enviado, quanto algo que apagaram lá.
// São decisões opostas com o mesmo rótulo.
//
// Com a base (o estado da última sincronização, ver syncBase) dá pra separar:
//
//   github  → só mudou lá: aceitar é seguro;
//   here    → só mudou aqui: aceitar DESFAZ o que você fez;
//   both    → mudou dos dois lados: precisa de decisão;
//   unknown → sem base pra esse item (environments, primeira sincronização).
// ─────────────────────────────────────────────────────────────────────────

export type NodeOrigin = 'github' | 'here' | 'both' | 'unknown';

/** Identifica o caso, pra tela traduzir rótulo e detalhe (i18n/syncDiffStrings). */
export type StatusKey =
  | 'onlyOnGithub' | 'onlyHere' | 'changed'
  | 'newOnGithub' | 'deletedHereChangedOnGithub' | 'deletedHere'
  | 'newHere' | 'changedHereDeletedOnGithub' | 'deletedOnGithub'
  | 'changedBoth' | 'changedHere' | 'changedOnGithub';

export interface NodeStatus {
  origin: NodeOrigin;
  key: StatusKey;
  /** Rótulo curto, para a lista e o cabeçalho do detalhe. */
  label: string;
  /** O que marcar/desmarcar faz com ESTE item. */
  detail: string;
}

const status = (origin: NodeOrigin, key: StatusKey, label: string, detail: string): NodeStatus =>
  ({ origin, key, label, detail });

/** Os rótulos antigos, de duas vias — usados quando não há base. */
function twoWay(node: DiffNode): NodeStatus {
  switch (node.change) {
    case 'added':
      return status('unknown', 'onlyOnGithub', 'Only on GitHub', 'This exists only on GitHub — accepting adds it here.');
    case 'removed':
      return status('unknown', 'onlyHere', 'Only here', 'This exists only here — accepting removes it.');
    default:
      return status('unknown', 'changed', 'Changed', "Accepting replaces your version with GitHub's.");
  }
}

export function classifyNode(node: DiffNode, base: NodeHashes | null): NodeStatus {
  // Environments não têm base (a identidade lá é a key da variável).
  if (!base || node.kind === 'variable') return twoWay(node);

  const known = base[node.id] !== undefined;

  if (node.change === 'added') {
    if (!known) {
      return status('github', 'newOnGithub', 'New on GitHub', 'Someone added this on GitHub — accepting adds it here.');
    }
    // A base conhece = já existiu aqui. Sumiu daqui, então foi apagado aqui.
    // Mudança DENTRO dele lá também conta: trazer de volta é decisão.
    const remoteChanged = changedSinceBase(base, node.id, node.remote) === true || changedInSubtree(base, node.remote);
    return remoteChanged
      ? status(
          'both',
          'deletedHereChangedOnGithub',
          'Deleted here, changed on GitHub',
          "You deleted this, and someone changed it on GitHub. Choose GitHub to bring back their version, or Mine to keep it deleted."
        )
      : status(
          'here',
          'deletedHere',
          'Deleted here',
          "You deleted this and haven't pushed yet. Mine keeps it deleted; GitHub brings it back."
        );
  }

  if (node.change === 'removed') {
    if (!known) {
      return status(
        'here',
        'newHere',
        'New here',
        "You created this and haven't pushed it yet. Mine keeps it — it goes out with your next push. GitHub deletes your copy."
      );
    }
    // Inclui o que está DENTRO: apagar a pasta leva junto uma request
    // editada aqui, e isso não pode passar por 'só o GitHub mexeu'.
    const localChanged = changedSinceBase(base, node.id, node.local) === true || changedInSubtree(base, node.local);
    return localChanged
      ? status(
          'both',
          'changedHereDeletedOnGithub',
          'Changed here, deleted on GitHub',
          'Someone deleted this on GitHub after you changed it here. GitHub deletes your copy; Mine keeps it.'
        )
      : status('github', 'deletedOnGithub', 'Deleted on GitHub', 'Someone deleted this on GitHub — accepting deletes it here too.');
  }

  // modified
  if (!known) return twoWay(node);
  const changedHere = changedSinceBase(base, node.id, node.local) === true;
  const changedThere = changedSinceBase(base, node.id, node.remote) === true;
  if (changedHere && changedThere) {
    return status(
      'both',
      'changedBoth',
      'Changed on both sides',
      "You and someone on GitHub both changed this. GitHub takes their version, Mine keeps yours, Merge lets you combine them field by field below."
    );
  }
  if (changedHere) {
    return status(
      'here',
      'changedHere',
      'Changed here',
      "Only you changed this. Mine keeps your version; GitHub reverts it to theirs."
    );
  }
  if (changedThere) {
    return status('github', 'changedOnGithub', 'Changed on GitHub', 'Only GitHub changed this — accepting is safe.');
  }
  return twoWay(node);
}

export interface OriginCounts {
  /** Só mudou lá: aceitar não perde nada. */
  github: number;
  /** Só mudou aqui: fica desmarcado, e é o que o próximo push envia. */
  here: number;
  /** Precisa de decisão: mudou dos dois lados, ou não há como saber. */
  decide: number;
}

/**
 * Contagem para a barra da tela. `conflicts` é o conjunto que fica
 * em Mine por padrão (ver conflictingIds): o que não está nele é seguro;
 * dentro dele, separa o que é só seu do que pede decisão de verdade.
 */
export function countByOrigin(
  nodes: DiffNode[],
  statuses: ReadonlyMap<string, NodeStatus>,
  conflicts: ReadonlySet<string>
): OriginCounts {
  const out: OriginCounts = { github: 0, here: 0, decide: 0 };
  for (const node of nodes) {
    if (!conflicts.has(node.id)) out.github++;
    else if (statuses.get(node.id)?.origin === 'here') out.here++;
    else out.decide++;
  }
  return out;
}
