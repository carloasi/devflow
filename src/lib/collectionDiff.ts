import type { CollectionItem } from '@/app/types/CollectionItem';
import { sameContent } from './canonicalCompare';

// ─────────────────────────────────────────────────────────────────────────
// Diff semântico entre a árvore local e a que veio do GitHub.
//
// Semântico, e não textual, por duas razões. O conteúdo sobe cifrado, então o
// diff do próprio GitHub não serve pra nada aqui. E mesmo decriptado, comparar
// JSON como texto acusaria diferença por ordem de chave ou indentação — ruído
// que afogaria a mudança real.
//
// A saída é uma lista achatada de nós, não uma árvore: a tela de comparação
// precisa de uma lista de caixinhas pra marcar, e a hierarquia é reconstruída
// pelo `path` de cada entrada.
// ─────────────────────────────────────────────────────────────────────────

export type ChangeType = 'added' | 'removed' | 'modified';

export interface FieldDiff {
  field: string;
  local: unknown;
  remote: unknown;
}

export interface DiffNode {
  /** Id do nó. Vem do local quando existe dos dois lados. */
  id: string;
  /** Nomes dos ancestrais + o próprio, pra exibir e agrupar. */
  path: string[];
  /** Id da collection raiz a que o nó pertence. */
  rootId: string;
  /**
   * Ids dos ancestrais, da raiz até o pai direto. É o que permite recortar o
   * diff por SUBÁRVORE — "só desta pasta" — em vez de só por collection.
   *
   * A cadeia INTEIRA, e não só o pai: pastas intermediárias sem alteração não
   * entram na lista de nós, e seguir de pai em pai se perderia nelas.
   *
   * O `path` não serve pra isso: ele é por nomes, e nomes se repetem.
   */
  ancestorIds: string[];
  // 'variable' é uma entrada de environment: a tela de comparação é a mesma,
  // e separar em dois componentes duplicaria seleção, conflito e edição.
  kind: CollectionItem['type'] | 'variable';
  change: ChangeType;
  local?: CollectionItem;
  remote?: CollectionItem;
  /** Só em `modified`: quais campos do próprio nó diferem. */
  fields: FieldDiff[];
}

// Campos que o push nunca grava: compará-los acusaria diferença em todo nó
// favoritado, já que a marca é local e jamais está no arquivo remoto.
const LOCAL_ONLY: ReadonlySet<string> = new Set(['starred', 'starredAfterId']);

// sameContent, e não JSON.stringify: o lado remoto é reconstruído pelo
// importData e vem com as chaves noutra ordem, então a comparação literal
// acusava alteração em praticamente todo item (ver canonicalCompare).
const same = sameContent;

/**
 * Diferenças nos campos DO PRÓPRIO nó — filhos não entram.
 *
 * Sem essa separação, mudar uma request marcaria como "modificada" também a
 * pasta dela, a pasta acima e a collection inteira, e a tela pediria pra
 * escolher entre ancestrais que não mudaram em nada.
 */
export function fieldDiffs(local: CollectionItem, remote: CollectionItem): FieldDiff[] {
  const out: FieldDiff[] = [];
  const compare = (field: string, a: unknown, b: unknown) => {
    if (LOCAL_ONLY.has(field)) return;
    if (!same(a, b)) out.push({ field, local: a, remote: b });
  };

  compare('name', local.name, remote.name);
  compare('method', local.method, remote.method);
  compare('url', local.request?.url, remote.request?.url);
  compare('headers', local.request?.headers, remote.request?.headers);
  compare('body', local.request?.body, remote.request?.body);
  compare('auth', local.request?.auth, remote.request?.auth);
  compare('preRequestScript', local.request?.scripts?.preRequest, remote.request?.scripts?.preRequest);
  compare('postResponseScript', local.request?.scripts?.postResponse, remote.request?.scripts?.postResponse);
  compare('example', local.example, remote.example);
  // Descrição e marcadores são do TIME (ver CollectionItem) — sem entrar
  // aqui, o nó não conta como modificado e a alteração de quem deu push
  // sumiria em silêncio no merge, sem nunca aparecer na tela de comparação.
  compare('description', local.description, remote.description);
  compare('markers', local.markers, remote.markers);
  compare('markerNotes', local.markerNotes, remote.markerNotes);

  return out;
}

/**
 * A pasta teve os filhos reordenados?
 *
 * Ordem é conteúdo neste app: o Runner executa a pasta na ordem da árvore,
 * então trocar dois passos de lugar muda o que o fluxo faz.
 *
 * Só entram os filhos que existem dos DOIS lados. Comparar a lista toda faria
 * renomear ou apagar uma request aparecer também como "a pasta foi
 * reordenada" — a mudança seria contada duas vezes, e a segunda num nó que
 * ninguém mexeu.
 */
function orderDiff(pairs: Pair[]): FieldDiff | null {
  // `pairs` já vem na ordem local; ordenar por remoteIndex dá a sequência do
  // outro lado, com os mesmos itens.
  const common = pairs.filter(p => p.local && p.remote);
  if (common.length < 2) return null;

  const asRemote = [...common].sort((a, b) => (a.remoteIndex ?? 0) - (b.remoteIndex ?? 0));
  if (same(common.map(p => p.local!.id), asRemote.map(p => p.local!.id))) return null;

  return {
    field: 'order',
    local: common.map(p => p.local!.name),
    remote: asRemote.map(p => p.remote!.name),
  };
}

// remoteIndex guarda a posição do nó no lado remoto;  sai na ordem
// local, então é a única forma de reconstruir a sequência de lá.
type Pair = { local?: CollectionItem; remote?: CollectionItem; remoteIndex?: number };

/**
 * Casa os filhos de um nó entre os dois lados.
 *
 * Id primeiro: ele sobrevive ao push/pull (o import faz `id: raw.id ?? uid()`),
 * então renomear uma request aparece como alteração, e não como apagar + criar.
 *
 * Nome como segunda tentativa, porque duas máquinas que criaram "a mesma"
 * request independentemente têm ids diferentes — sem isso o diff mostraria
 * dois itens idênticos, um pra adicionar e um pra remover. Só vale quando o
 * nome é único dos dois lados: com nomes repetidos qualquer escolha seria
 * arbitrária, e errar o par é pior que mostrar adicionar+remover.
 */
export function matchChildren(
  localItems: CollectionItem[],
  remoteItems: CollectionItem[]
): Pair[] {
  const pairs: Pair[] = [];
  const usedRemote = new Set<string>();

  const remoteById = new Map(remoteItems.filter(r => r.id).map(r => [r.id, r]));

  const countByName = (items: CollectionItem[]) => {
    const counts = new Map<string, number>();
    for (const i of items) {
      const key = `${i.type}:${i.name}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const localNameCounts = countByName(localItems);
  const remoteNameCounts = countByName(remoteItems);

  for (const localItem of localItems) {
    const byId = remoteById.get(localItem.id);
    if (byId && !usedRemote.has(byId.id)) {
      usedRemote.add(byId.id);
      pairs.push({ local: localItem, remote: byId, remoteIndex: remoteItems.indexOf(byId) });
      continue;
    }

    const key = `${localItem.type}:${localItem.name}`;
    const unique = localNameCounts.get(key) === 1 && remoteNameCounts.get(key) === 1;
    const byName = unique
      ? remoteItems.find(r => !usedRemote.has(r.id) && r.type === localItem.type && r.name === localItem.name)
      : undefined;

    if (byName) {
      usedRemote.add(byName.id);
      pairs.push({ local: localItem, remote: byName, remoteIndex: remoteItems.indexOf(byName) });
    } else {
      pairs.push({ local: localItem });
    }
  }

  for (const remoteItem of remoteItems) {
    if (!usedRemote.has(remoteItem.id)) pairs.push({ remote: remoteItem, remoteIndex: remoteItems.indexOf(remoteItem) });
  }

  return pairs;
}

export function diffTrees(
  local: CollectionItem[] | undefined | null,
  remote: CollectionItem[] | undefined | null
): DiffNode[] {
  const out: DiffNode[] = [];
  walk(local ?? [], remote ?? [], [], null, out);
  return out;
}

function walk(
  localItems: CollectionItem[],
  remoteItems: CollectionItem[],
  parentPath: string[],
  rootId: string | null,
  out: DiffNode[]
): void {
  walkPairs(matchChildren(localItems, remoteItems), parentPath, rootId, [], out);
}

function walkPairs(
  pairs: Pair[],
  parentPath: string[],
  rootId: string | null,
  ancestors: string[],
  out: DiffNode[]
): void {
  for (const pair of pairs) {
    const node = pair.local ?? pair.remote!;
    const path = [...parentPath, node.name];
    const currentRoot = rootId ?? node.id;
    // Id local quando o nó existe dos dois lados: é o id que a árvore local
    // usa, e é por ele que o filtro por subárvore navega.
    const selfId = pair.local?.id ?? pair.remote!.id;

    if (!pair.remote) {
      out.push({ id: node.id, path, rootId: currentRoot, ancestorIds: ancestors, kind: node.type, change: 'removed', local: pair.local, fields: [] });
      continue;
    }
    if (!pair.local) {
      out.push({ id: node.id, path, rootId: currentRoot, ancestorIds: ancestors, kind: node.type, change: 'added', remote: pair.remote, fields: [] });
      continue;
    }

    // O pareamento dos filhos é calculado aqui porque serve a duas coisas: a
    // reordenação da pasta e a descida recursiva. Calcular duas vezes seria
    // arriscar que as duas discordem.
    const childPairs = matchChildren(pair.local.item ?? [], pair.remote.item ?? []);
    const fields = fieldDiffs(pair.local, pair.remote);
    const reordered = orderDiff(childPairs);
    if (reordered) fields.push(reordered);

    if (fields.length > 0) {
      out.push({
        id: pair.local.id,
        path,
        rootId: currentRoot,
        ancestorIds: ancestors,
        kind: node.type,
        change: 'modified',
        local: pair.local,
        remote: pair.remote,
        fields,
      });
    }

    // Desce sempre, mesmo quando o nó em si não mudou: a alteração pode estar
    // só lá embaixo, e uma pasta idêntica com request diferente dentro é o
    // caso mais comum de todos.
    walkPairs(childPairs, path, currentRoot, [...ancestors, selfId], out);
  }
}

/**
 * Recorta o diff na subárvore de um nó — a pasta escolhida e tudo abaixo
 * dela.
 *
 * Serve ao "pull desta pasta" em qualquer nível: o remoto guarda um arquivo
 * por collection raiz, mas a ESCOLHA do que trazer não precisa ter essa
 * granularidade. Limitar o que se oferece já limita o que muda, porque o
 * applySelectedChanges só mexe no que está selecionado.
 *
* Usa a cadeia de ancestrais em vez de comparar caminhos por nome: um nó
 * adicionado só existe do lado remoto, e nomes se repetem.
 */
export function filterSubtree(nodes: DiffNode[], folderId: string): DiffNode[] {
  return nodes.filter(n => n.id === folderId || n.ancestorIds.includes(folderId));
}

/** Resumo por collection raiz, pra agrupar a lista na tela. */
export function groupByRoot(nodes: DiffNode[]): Map<string, DiffNode[]> {
  const groups = new Map<string, DiffNode[]>();
  for (const node of nodes) {
    const list = groups.get(node.rootId);
    if (list) list.push(node);
    else groups.set(node.rootId, [node]);
  }
  return groups;
}
