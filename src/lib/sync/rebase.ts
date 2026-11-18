import type { CollectionItem } from '@/app/types/CollectionItem';
import { applySelectedChanges } from '@/lib/applyDiff';
import { sameContent } from '@/lib/canonicalCompare';
import { diffTrees, type DiffNode } from '@/lib/collectionDiff';
import { classifyNode } from '@/lib/diffOrigin';
import { conflictingIds } from '@/lib/diffSelection';
import { applyOverrides, type OverrideMap } from '@/lib/diffFields';
import { changedSinceBase, type NodeHashes } from '@/lib/syncBase';
import { fieldHashKey, fieldMergePlan, ORDER_FIELD, PARENT_FIELD } from './fieldMerge';

// ─────────────────────────────────────────────────────────────────────────
// "Rebase" das collections na hora do push: leva só o que VOCÊ mudou.
//
// O arquivo no GitHub é um por collection, então duas pessoas mexendo em
// requests diferentes da mesma collection batiam no mesmo arquivo — e o push
// abria a revisão inteira, mesmo sem nada se sobrepor. Com a base (o estado
// da última sincronização, ver syncBase) dá pra decidir item a item, sem
// perguntar nada:
//
//   mudou só lá           → entra a versão do GitHub;
//   mudou só aqui         → fica a sua (é o que o push leva);
//   mudou dos dois lados  → junta campo a campo (fieldMerge) quando cada
//                           lado mexeu em campos DIFERENTES — senão, CONFLITO,
//                           e só isso vai pra revisão;
//   sem base pra decidir  → também conflito (melhor perguntar que adivinhar).
//
// Ordem dos filhos e mudança de pasta seguem a mesma regra, com o pai e a
// ordem guardados na base: vale o lado que mexeu; os dois reordenando a
// mesma pasta de jeitos diferentes é conflito.
//
// É a mesma conta da tela de revisão com "Safe defaults" (conflictingIds +
// classifyNode + applySelectedChanges), só que sem a tela quando não sobra
// nada pra decidir. Função pura: as duas árvores e a base entram, a árvore
// mesclada sai.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Uma mudança, em linguagem de gente: qual item, que tipo, quais campos. É o
 * que o relatório do merge, a prévia do push e o histórico mostram.
 */
export interface ChangeDetail {
  id: string;
  /** Caminho do item, da collection até ele. */
  path: string[];
  change: 'new' | 'deleted' | 'changed' | 'moved' | 'reordered';
  /** Campos (só em 'changed'). */
  fields: string[];
}

export interface RebaseResult {
  /** Árvore a enviar: a do GitHub com as suas mudanças por cima. */
  merged: CollectionItem[];
  /** O diff completo entre local e GitHub (pra abrir a revisão, se precisar). */
  nodes: DiffNode[];
  /** Itens que mudaram dos dois lados (ou sem base) — pedem decisão humana. */
  conflicts: string[];
  /** Itens do GitHub incorporados sozinhos (conteúdo, ordem ou pasta). */
  incoming: number;
  /** Itens seus que seguem no push por cima do GitHub. */
  outgoing: number;
  /** Itens mudados dos dois lados, juntados campo a campo. */
  fieldMerged: number;
  /**
   * Itens movidos de pasta e editados dos dois lados no mesmo campo. A tela
   * de revisão não mostra item movido, então fica a versão daqui.
   */
  keptMine: number;
  /** Nomes desses itens — pra dizer na mensagem do push o que ficou como está aqui. */
  keptMineNames: string[];
  /** O que veio do GitHub, item a item. */
  incomingDetails: ChangeDetail[];
  /** O que é seu e segue no push, item a item. */
  outgoingDetails: ChangeDetail[];
  /** O que pede decisão, item a item. */
  conflictDetails: ChangeDetail[];
}

const ownFields = (node: DiffNode) => node.fields.map(f => f.field).filter(f => f !== 'order');

/** Detalhe de um nó do diff, visto pelo lado que MUDOU (`side`). */
function detailOf(node: DiffNode, side: 'github' | 'here'): ChangeDetail {
  const base = { id: node.id, path: node.path, fields: [] as string[] };
  // 'added' = só existe lá; 'removed' = só existe aqui.
  if (node.change === 'added') return { ...base, change: side === 'github' ? 'new' : 'deleted' };
  if (node.change === 'removed') return { ...base, change: side === 'github' ? 'deleted' : 'new' };
  const fields = ownFields(node);
  return fields.length === 0 ? { ...base, change: 'reordered' } : { ...base, change: 'changed', fields };
}

export type OrderDecision = 'local' | 'remote' | 'conflict';

/**
 * Quem reordenou os filhos de uma pasta desde a base. Compara só os filhos
 * que existem nos três (base, aqui e lá): criar ou apagar um item não é
 * reordenar. `null` = a base não guarda a ordem dessa pasta.
 */
export function orderDecision(
  base: NodeHashes | null,
  folderId: string,
  localChildren: CollectionItem[] | undefined,
  remoteChildren: CollectionItem[] | undefined
): OrderDecision | null {
  const recorded = base?.[fieldHashKey(folderId, ORDER_FIELD)];
  if (recorded === undefined) return null;
  let baseIds: string[];
  try {
    baseIds = JSON.parse(recorded);
  } catch {
    return null;
  }
  const localIds = (localChildren ?? []).map(c => c.id);
  const remoteIds = (remoteChildren ?? []).map(c => c.id);
  const common = new Set(baseIds.filter(id => localIds.includes(id) && remoteIds.includes(id)));
  const seq = (ids: string[]) => ids.filter(id => common.has(id));
  const b = seq(baseIds);
  const l = seq(localIds);
  const r = seq(remoteIds);
  if (sameContent(l, r)) return 'remote';
  const changedHere = !sameContent(l, b);
  const changedThere = !sameContent(r, b);
  if (changedHere && changedThere) return 'conflict';
  return changedHere ? 'local' : 'remote';
}

/**
 * Reordena `items` pela sequência de `order`, deixando nos mesmos lugares os
 * que não estão nela (criados de um lado só) — só quem tem posição troca.
 */
function sortLike(items: CollectionItem[], order: string[]): CollectionItem[] {
  const position = new Map(order.map((id, i) => [id, i]));
  const slots = items.map((item, i) => (position.has(item.id) ? i : -1)).filter(i => i >= 0);
  const sorted = slots.map(i => items[i]).sort((a, b) => position.get(a.id)! - position.get(b.id)!);
  const out = [...items];
  slots.forEach((slot, k) => {
    out[slot] = sorted[k];
  });
  return out;
}

interface Located {
  node: CollectionItem;
  parentId: string;
  index: number;
}

function indexTree(roots: CollectionItem[]): Map<string, Located> {
  const out = new Map<string, Located>();
  const walk = (items: CollectionItem[], parentId: string) => {
    items.forEach((node, index) => {
      if (!node?.id) return;
      out.set(node.id, { node, parentId, index });
      if (node.item?.length) walk(node.item, node.id);
    });
  };
  walk(roots, '');
  return out;
}

/** Conteúdo próprio de `source` com os filhos e as marcas locais de `target`. */
function withOwnContentOf(target: CollectionItem, source: CollectionItem): CollectionItem {
  const next: CollectionItem = { ...source, id: target.id };
  if (target.item) next.item = target.item;
  else delete next.item;
  if (target.starred !== undefined) next.starred = target.starred;
  if (target.starredAfterId !== undefined) next.starredAfterId = target.starredAfterId;
  return next;
}

export function rebaseCollections(
  local: CollectionItem[] | null | undefined,
  remote: CollectionItem[] | null | undefined,
  base: NodeHashes | null,
  pendingCollectionIds: ReadonlySet<string>
): RebaseResult {
  const localTree = local ?? [];
  const remoteTree = remote ?? [];
  const nodes = diffTrees(localTree, remoteTree);

  // Ficam em "Mine" por padrão: o que você mudou e o que pede decisão.
  const keepMine = conflictingIds(nodes, pendingCollectionIds, base);

  const accepted = new Set<string>();
  const overrides: OverrideMap = {};
  const conflicts: string[] = [];
  const orders = new Map<string, { decision: 'local' | 'remote'; local: string[]; remote: string[] }>();
  let incoming = 0;
  let outgoing = 0;
  let fieldMerged = 0;
  let keptMine = 0;
  const keptMineNames: string[] = [];
  const incomingDetails: ChangeDetail[] = [];
  const outgoingDetails: ChangeDetail[] = [];
  const conflictDetails: ChangeDetail[] = [];
  const conflict = (node: DiffNode) => {
    conflicts.push(node.id);
    conflictDetails.push({ ...detailOf(node, 'here'), change: node.change === 'modified' ? 'changed' : detailOf(node, 'here').change });
  };

  for (const node of nodes) {
    // Ordem dos filhos: decidida à parte, pela base (o hash do item não
    // inclui a ordem). Aplicada no fim, sobre a árvore já mesclada.
    const hasOrder = node.change === 'modified' && node.fields.some(f => f.field === 'order');
    if (hasOrder && node.local && node.remote) {
      const decision = orderDecision(base, node.id, node.local.item, node.remote.item);
      if (decision === 'conflict') {
        conflict(node);
        continue;
      }
      if (decision) {
        orders.set(node.id, {
          decision,
          local: (node.local.item ?? []).map(c => c.id),
          remote: (node.remote.item ?? []).map(c => c.id),
        });
        if (decision === 'remote') incoming++;
        else outgoing++;
        // Só a ordem mudou: nada mais a decidir neste item.
        if (node.fields.every(f => f.field === 'order')) {
          (decision === 'remote' ? incomingDetails : outgoingDetails).push({ id: node.id, path: node.path, change: 'reordered', fields: [] });
          continue;
        }
      }
    }

    if (!keepMine.has(node.id)) {
      accepted.add(node.id);
      incoming++;
      incomingDetails.push(detailOf(node, 'github'));
      continue;
    }
    // Sem base, "só existe aqui" é o caso de todo workspace que ainda não
    // subiu (ou que foi importado): fica e vai no push. Não é exclusão — que
    // apagaria a collection daqui — nem conflito pra revisar.
    if (node.change === 'removed' && !base) {
      outgoing++;
      outgoingDetails.push(detailOf(node, 'here'));
      continue;
    }
    // Só a SUA mudança (origem "here") segue sem perguntar.
    const origin = classifyNode(node, base).origin;
    if (origin === 'here') {
      outgoing++;
      outgoingDetails.push(detailOf(node, 'here'));
      continue;
    }
    // Mudou dos dois lados: se cada um mexeu em campos diferentes, fica a
    // versão do GitHub com os campos daqui por cima — o mesmo "Merge" da
    // tela de revisão, só que sem precisar dela.
    if (origin === 'both' && node.change === 'modified' && node.local && node.remote) {
      const plan = fieldMergePlan(node.local, node.remote, base);
      if (plan) {
        accepted.add(node.id);
        if (Object.keys(plan).length > 0) overrides[node.id] = plan;
        fieldMerged++;
        // Os campos daqui vão no push; os outros vieram de lá.
        const mineFields = Object.keys(plan).filter(f => f !== 'urlexport');
        const theirFields = ownFields(node).filter(f => !mineFields.includes(f));
        if (theirFields.length) incomingDetails.push({ id: node.id, path: node.path, change: 'changed', fields: theirFields });
        if (mineFields.length) outgoingDetails.push({ id: node.id, path: node.path, change: 'changed', fields: mineFields });
        continue;
      }
    }
    conflict(node);
  }

  // Cópia própria: os ajustes abaixo mexem na árvore no lugar.
  const merged: CollectionItem[] = structuredClone(applySelectedChanges(localTree, remoteTree, accepted, overrides));

  // ── Ordem ────────────────────────────────────────────────────────────
  const placeOf = (tree: CollectionItem[]) => indexTree(tree);
  const mergedIndex = placeOf(merged);
  for (const [folderId, order] of orders) {
    const folder = mergedIndex.get(folderId)?.node;
    if (!folder?.item) continue;
    folder.item = sortLike(folder.item, order.decision === 'remote' ? order.remote : order.local);
  }

  // ── Itens movidos de pasta (applyRemoteMoves) ─────────────────────────
  const moves = applyRemoteMoves(merged, localTree, remoteTree, base);
  incoming += moves.incoming;
  keptMine += moves.keptMine;
  keptMineNames.push(...moves.keptMineNames);
  incomingDetails.push(...moves.incomingDetails);
  outgoingDetails.push(...moves.outgoingDetails);

  return {
    merged, nodes, conflicts, incoming, outgoing, fieldMerged, keptMine, keptMineNames,
    incomingDetails, outgoingDetails, conflictDetails,
  };
}

export interface MovesResult {
  incoming: number;
  keptMine: number;
  keptMineNames: string[];
  incomingDetails: ChangeDetail[];
  outgoingDetails: ChangeDetail[];
}

/**
 * Itens que mudaram de pasta — aplicados em `merged` (no lugar).
 *
 * O diff não os mostra (ver diffTrees: mudar de pasta não é apagar e
 * criar), então a mescla os deixa onde estão AQUI, com o conteúdo daqui.
 * Exportada porque a REVISÃO (applySelectedChanges) tem o mesmo ponto cego:
 * sem isto, o que o colega moveu (e editou) ficava aqui no lugar antigo, a
 * base passava a dizer "está na pasta nova", e o push seguinte lia o lugar
 * antigo como mudança SUA — e desfazia a mudança dele no GitHub.
 *
 * Sem base, não move nada (não há como saber quem moveu).
 */
export function applyRemoteMoves(
  merged: CollectionItem[],
  localTree: CollectionItem[],
  remoteTree: CollectionItem[],
  base: NodeHashes | null
): MovesResult {
  let incoming = 0;
  let keptMine = 0;
  const keptMineNames: string[] = [];
  const incomingDetails: ChangeDetail[] = [];
  const outgoingDetails: ChangeDetail[] = [];
  // O diff não os mostra (ver diffTrees: mudar de pasta não é apagar e
  // criar), então o merge acima manteve cada um onde está AQUI, com o
  // conteúdo daqui. Sem isto, mover uma request enquanto alguém a editava
  // descartava a edição de lá, e o que outra pessoa moveu voltava pro lugar.
  const placeOf = (tree: CollectionItem[]) => indexTree(tree);
  let mergedIndex = placeOf(merged);
  const localIndex = indexTree(localTree);
  const remoteIndex = indexTree(remoteTree);
  for (const [id, mine] of localIndex) {
    const theirs = remoteIndex.get(id);
    if (!theirs || theirs.parentId === mine.parentId) continue;
    mergedIndex = placeOf(merged);
    const current = mergedIndex.get(id);
    if (!current) {
      // Saiu da mescla junto com a pasta antiga daqui: o colega o tirou da
      // pasta e APAGOU a pasta, e aceitar a exclusão levava o item junto —
      // ele sumia daqui, e o push seguinte o apagava do GitHub. Volta, no
      // lugar novo, com o conteúdo pela mesma regra de quem mexeu.
      const target = theirs.parentId ? mergedIndex.get(theirs.parentId)?.node : null;
      if (theirs.parentId && !target) continue;
      const changedHere = changedSinceBase(base, id, mine.node) === true;
      const changedThere = changedSinceBase(base, id, theirs.node) === true;
      let node: CollectionItem = structuredClone(theirs.node);
      if (changedHere && !changedThere) node = withOwnContentOf(node, mine.node);
      else if (changedHere && changedThere) {
        const plan = fieldMergePlan(mine.node, theirs.node, base);
        if (plan) node = applyOverrides(node, plan);
        else {
          node = withOwnContentOf(node, mine.node);
          keptMine++;
          keptMineNames.push(mine.node.name);
        }
      }
      const into = target ? (target.item ??= []) : merged;
      into.splice(Math.min(theirs.index, into.length), 0, node);
      incoming++;
      incomingDetails.push({ id, path: [mine.node.name], change: 'moved', fields: [] });
      continue;
    }

    // Conteúdo próprio: vale quem mexeu; dos dois lados, campo a campo.
    const ownLocal = { ...mine.node, item: undefined };
    const ownRemote = { ...theirs.node, item: undefined };
    if (!sameContent(ownLocal, ownRemote)) {
      const changedHere = changedSinceBase(base, id, mine.node) === true;
      const changedThere = changedSinceBase(base, id, theirs.node) === true;
      let next: CollectionItem | null = null;
      if (changedThere && !changedHere) {
        next = withOwnContentOf(current.node, theirs.node);
      } else if (changedThere && changedHere) {
        const plan = fieldMergePlan(mine.node, theirs.node, base);
        if (plan) next = applyOverrides(withOwnContentOf(current.node, theirs.node), plan);
        else {
          keptMine++;
          keptMineNames.push(mine.node.name);
        }
      }
      if (next) {
        const siblings = current.parentId ? mergedIndex.get(current.parentId)?.node.item : merged;
        if (siblings) siblings[current.index] = next;
        incoming++;
        incomingDetails.push({ id, path: [mine.node.name], change: 'changed', fields: [] });
      }
    }

    // Pasta: só sai daqui se quem moveu foi o OUTRO lado.
    const recordedParent = base?.[fieldHashKey(id, PARENT_FIELD)];
    if (recordedParent !== undefined && mine.parentId !== recordedParent) {
      outgoingDetails.push({ id, path: [mine.node.name], change: 'moved', fields: [] });
    }
    if (recordedParent === undefined || mine.parentId !== recordedParent || theirs.parentId === recordedParent) continue;
    mergedIndex = placeOf(merged);
    const located = mergedIndex.get(id);
    if (!located) continue;
    const target = theirs.parentId ? mergedIndex.get(theirs.parentId)?.node : null;
    if (theirs.parentId && !target) continue; // a pasta de destino não existe aqui
    const from = located.parentId ? mergedIndex.get(located.parentId)?.node.item : merged;
    if (!from) continue;
    from.splice(located.index, 1);
    const into = target ? (target.item ??= []) : merged;
    into.splice(Math.min(theirs.index, into.length), 0, located.node);
    incoming++;
    incomingDetails.push({ id, path: [mine.node.name], change: 'moved', fields: [] });
  }

  return { incoming, keptMine, keptMineNames, incomingDetails, outgoingDetails };
}
