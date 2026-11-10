import type { CollectionItem } from '@/app/types/CollectionItem';
import type { DiffNode } from '@/lib/collectionDiff';

// ─────────────────────────────────────────────────────────────────────────
// "Push deste item": enviar UMA pasta ou request, e não a collection toda.
//
// O GitHub guarda um arquivo por collection, então o que sobe continua
// sendo o arquivo inteiro — mas montado a partir da versão que JÁ ESTÁ lá,
// com só o item escolhido trocado pela versão daqui (já mesclada com o
// GitHub, ver rebase). Assim as suas outras mudanças na mesma collection
// ficam aqui, esperando, e o que os colegas enviaram continua intacto.
// ─────────────────────────────────────────────────────────────────────────

/** O nó está dentro do item escolhido (ou é ele)? */
export function isInSubtree(node: DiffNode, itemId: string): boolean {
  return node.id === itemId || node.ancestorIds.includes(itemId);
}

function findNode(items: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const found = item.item ? findNode(item.item, id) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** Pai e posição de um nó, ou undefined. A raiz tem pai `null`. */
function locate(
  root: CollectionItem,
  id: string
): { parent: CollectionItem | null; index: number; node: CollectionItem } | undefined {
  if (root.id === id) return { parent: null, index: 0, node: root };
  const walk = (parent: CollectionItem): ReturnType<typeof locate> => {
    const children = parent.item ?? [];
    for (let i = 0; i < children.length; i++) {
      if (children[i].id === id) return { parent, index: i, node: children[i] };
      const inner = walk(children[i]);
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(root);
}

/**
 * A collection a enviar: `remoteRoot` (o GitHub de agora) com o item
 * `itemId` trocado pelo de `mergedRoot` (o daqui, já mesclado). Se o item não
 * existe lá, entra no mesmo lugar em que está aqui — com as pastas acima dele
 * criadas como pastas vazias quando também forem novas, pra não levar junto
 * outros itens novos que não foram escolhidos.
 *
 * `null` quando o item não existe aqui (não há o que enviar).
 */
export function withSubtreeFrom(
  remoteRoot: CollectionItem,
  mergedRoot: CollectionItem,
  itemId: string
): CollectionItem | null {
  if (itemId === mergedRoot.id) return structuredClone(mergedRoot);

  const mine = locate(mergedRoot, itemId);
  if (!mine) return null;

  const out: CollectionItem = structuredClone(remoteRoot);

  // Tira a cópia de lá (o item pode até ter mudado de pasta aqui).
  const theirs = locate(out, itemId);
  if (theirs?.parent) theirs.parent.item!.splice(theirs.index, 1);

  // Cadeia de pastas, da raiz até o pai do item, do lado daqui.
  const chain: CollectionItem[] = [];
  for (let at = mine.parent; at && at.id !== mergedRoot.id; at = locate(mergedRoot, at.id)?.parent ?? null) {
    chain.unshift(at);
  }

  let parent: CollectionItem = out;
  for (const ancestor of chain) {
    const existing = findNode(out.item ?? [], ancestor.id);
    if (existing) {
      parent = existing;
      continue;
    }
    // Pasta nova aqui: entra vazia, só com o caminho até o item.
    const shell: CollectionItem = { ...structuredClone({ ...ancestor, item: undefined }), item: [] };
    const siblings = (parent.item ??= []);
    const at = locate(mergedRoot, ancestor.id)?.index ?? siblings.length;
    siblings.splice(Math.min(at, siblings.length), 0, shell);
    parent = shell;
  }

  const siblings = (parent.item ??= []);
  siblings.splice(Math.min(mine.index, siblings.length), 0, structuredClone(mine.node));
  return out;
}
