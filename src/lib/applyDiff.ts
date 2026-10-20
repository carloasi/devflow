import type { CollectionItem } from '@/app/types/CollectionItem';
import { matchChildren } from './collectionDiff';
import { applyOverrides, type OverrideMap } from './diffFields';

// ─────────────────────────────────────────────────────────────────────────
// Aplica só as mudanças escolhidas na tela de comparação.
//
// O pull sempre foi tudo ou nada: substituía a árvore inteira pelo remoto.
// Aqui o resultado é uma mistura — para cada nó, a versão de lá ou a daqui,
// conforme a caixinha.
//
// Reaproveita o `matchChildren` do diff de propósito: os ids da seleção vieram
// de lá, e parear de outro jeito aqui faria a aplicação acertar um nó
// diferente do que a tela mostrou. Mesmo pareamento, mesmas decisões.
//
// Função pura: recebe as duas árvores e a seleção, devolve a nova. Nada de
// estado, pra poder testar o que acontece com ordem, aninhamento e seleção
// parcial sem subir o app.
// ─────────────────────────────────────────────────────────────────────────

export function applySelectedChanges(
  local: CollectionItem[] | undefined | null,
  remote: CollectionItem[] | undefined | null,
  selected: ReadonlySet<string>,
  // Valores que o usuário editou à mão na tela de comparação. Vencem sobre os
  // dois lados: o sentido de editar ali é justamente quando nem o local nem o
  // remoto estão certos sozinhos.
  overrides: OverrideMap = {}
): CollectionItem[] {
  return mergeChildren(local ?? [], remote ?? [], selected, overrides);
}

function mergeChildren(
  localItems: CollectionItem[],
  remoteItems: CollectionItem[],
  selected: ReadonlySet<string>,
  overrides: OverrideMap
): CollectionItem[] {
  const pairs = matchChildren(localItems, remoteItems);
  const result: CollectionItem[] = [];

  // Primeira passada na ORDEM LOCAL: quem já estava aqui não muda de lugar
  // por causa de uma escolha que não era sobre ordem.
  for (const pair of pairs) {
    if (pair.local && pair.remote) {
      result.push(mergeNode(pair.local, pair.remote, selected, overrides));
      continue;
    }
    if (pair.local) {
      // Só no local = o remoto apagou. Aceitar a remoção é tirar daqui;
      // recusar é manter, e aí o nó volta a subir no próximo push.
      if (!selected.has(pair.local.id)) result.push(pair.local);
    }
  }

  // Os adicionados entram depois, cada um na posição que ocupa no remoto. A
  // ordem é execução neste app (o Runner roda a pasta na ordem da árvore),
  // então um passo novo no meio do fluxo tem que cair no meio, não no fim.
  const additions = pairs
    .filter(p => !p.local && p.remote && selected.has(p.remote.id))
    .sort((a, b) => (a.remoteIndex ?? 0) - (b.remoteIndex ?? 0));

  for (const addition of additions) {
    const at = Math.min(addition.remoteIndex ?? result.length, result.length);
    // Um nó novo também pode ter sido editado antes de entrar.
    result.splice(at, 0, applyOverrides(addition.remote!, overrides[addition.remote!.id]));
  }

  return result;
}

/**
 * Nó presente dos dois lados.
 *
 * Os campos PRÓPRIOS vêm de um lado só, conforme a caixinha; os filhos são
 * sempre mesclados. Sem essa separação, recusar a alteração de uma pasta
 * descartaria junto as alterações aceitas dentro dela.
 *
 * A seleção é por nó, não por campo: aceitar um nó modificado traz todos os
 * campos dele que diferem — inclusive a ordem dos filhos, quando ela mudou.
 */
function mergeNode(
  local: CollectionItem,
  remote: CollectionItem,
  selected: ReadonlySet<string>,
  overrides: OverrideMap
): CollectionItem {
  const takeRemote = selected.has(local.id);
  // Os valores editados só valem no nó aceito. A tela marca o nó sozinha
  // quando alguém edita um campo dele, então a regra continua uma só — "muda
  // o que está marcado" — e ninguém edita algo que depois não entra.
  const base = takeRemote ? applyOverrides(remote, overrides[local.id]) : local;

  const merged: CollectionItem = {
    ...base,
    // O id local manda sempre: abas abertas, favoritos e a própria seleção
    // referenciam ele. Trocar pelo id remoto faria a aba aberta apontar pra um
    // nó que não existe mais.
    id: local.id,
    // Favorito é marca local e nunca vem no arquivo remoto — sem reaplicar
    // aqui, aceitar uma alteração apagaria a estrela do item.
    ...(local.starred !== undefined ? { starred: local.starred } : {}),
    ...(local.starredAfterId !== undefined ? { starredAfterId: local.starredAfterId } : {}),
  };

  const hasChildren = (local.item?.length ?? 0) > 0 || (remote.item?.length ?? 0) > 0;
  if (hasChildren) {
    merged.item = mergeChildren(local.item ?? [], remote.item ?? [], selected, overrides);
  }

  // Aceitar a ordem do remoto só vale quando o nó foi escolhido; senão a
  // mescla acima já preservou a sequência daqui.
  if (takeRemote && remote.item?.length) {
    merged.item = reorderLike(merged.item ?? [], remote.item, local.item ?? []);
  }

  return merged;
}

/**
 * Reordena os filhos mesclados conforme o remoto, mantendo no lugar os que só
 * existem aqui (recusados na tela) — eles não têm posição do outro lado.
 */
function reorderLike(
  merged: CollectionItem[],
  remoteItems: CollectionItem[],
  localItems: CollectionItem[]
): CollectionItem[] {
  const pairs = matchChildren(localItems, remoteItems);
  const positionByLocalId = new Map<string, number>();
  for (const pair of pairs) {
    if (pair.local && pair.remote) positionByLocalId.set(pair.local.id, pair.remoteIndex ?? 0);
  }

  // Estável: quem não tem posição remota guarda a sua, e o sort só move quem
  // tem referência dos dois lados.
  return [...merged].sort((a, b) => {
    const pa = positionByLocalId.get(a.id);
    const pb = positionByLocalId.get(b.id);
    if (pa === undefined || pb === undefined) return 0;
    return pa - pb;
  });
}
