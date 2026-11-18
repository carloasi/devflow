import type { EnvRebaseResult } from './envMerge';
import type { RebaseResult } from './rebase';
import { buildRemoteChangePreview, detailItems, type BaseItemOf, type RemoteChangeItem } from './remoteChangeAlert';
import { markerChangeCount, type MarkerChanges } from '@/lib/markers';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { findItem, itemText, namePathIn } from './discardChange';

// ─────────────────────────────────────────────────────────────────────────
// O que a Central de Sincronização mostra: as três listas, tiradas do MESMO
// merge de teste que o push e o pull fazem (rebaseCollections +
// rebaseEnvironments). Nada é aplicado — é a prévia de "Sincronizar tudo".
//
//   Recebidos   → o que vem do GitHub e entra sozinho;
//   Para enviar → o que é seu e segue no push;
//   Conflitos   → o que mudou dos dois lados e pede decisão.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Um item da Central: o do aviso, mais o que ela precisa pra explicar a
 * mudança — o tipo do item, e onde ele está aqui e no GitHub (movido).
 */
export type SyncItem = RemoteChangeItem & {
  /** Tipo do item aqui (ou lá, se só existir lá). */
  kind?: CollectionItem['type'];
  /** O item existe aqui (dá pra abrir numa aba). */
  existsHere?: boolean;
  /** Caminho aqui e no GitHub — o "de onde pra onde" de um item movido. */
  localPath?: string[];
  remotePath?: string[];
  /** Pasta: quantas requests há dentro (na versão que o descarte apaga ou traz). */
  insideRequests?: number;
  /** Apagado aqui junto com a pasta onde ficava: o nome dela (o descarte a recria). */
  missingParent?: string;
  /**
   * Pasta nova ou apagada: cada request de dentro, inteira (método, URL,
   * headers, body, scripts). `before` é o daqui, `after` o do GitHub — o lado
   * que não tem a request fica vazio. Sem isto a pasta só mostrava os nomes.
   */
  requests?: { id: string; path: string[]; before: string; after: string }[];
};

export interface SyncOverview {
  incoming: SyncItem[];
  outgoing: SyncItem[];
  conflicts: SyncItem[];
  /** Variáveis de environment ("Dev › baseUrl"), por lista. */
  envIncoming: string[];
  envOutgoing: string[];
  /** Mudaram dos dois lados: fica a sua (environments nunca perguntam). */
  envKeptMine: string[];
  /** Tokens de sessão que diferem do GitHub mas não sobem (só pro aviso). */
  envSessionTokens: string[];
  /** Valor daqui e do GitHub de cada linha de environment (o diff da Central). */
  envValues: Record<string, { local?: string; remote?: string }>;
  /**
   * O catálogo de marcadores (cor e nome), que é do workspace inteiro. Fica
   * fora do merge das collections — sem isto, o colega que só criou ou
   * recoloriu um marcador não aparecia em lugar nenhum e não havia como
   * receber a mudança.
   */
  markers: MarkerChanges;
}

const NO_MARKERS: MarkerChanges = { added: [], changed: [], removed: [] };

export function buildSyncOverview(
  result: RebaseResult,
  envResult: Pick<EnvRebaseResult, 'incomingNames' | 'outgoingNames' | 'keptMineNames'> &
    Partial<Pick<EnvRebaseResult, 'sessionTokenNames' | 'values'>>,
  baseItemOf?: BaseItemOf,
  markers: MarkerChanges = NO_MARKERS
): SyncOverview {
  const preview = buildRemoteChangePreview(result, [], baseItemOf);
  return {
    incoming: preview.items.filter(item => !item.conflict),
    conflicts: preview.items.filter(item => item.conflict),
    outgoing: dedupe(detailItems(result.outgoingDetails, result.nodes, { baseItemOf })),
    envIncoming: envResult.incomingNames,
    envOutgoing: envResult.outgoingNames,
    envKeptMine: envResult.keptMineNames,
    envSessionTokens: envResult.sessionTokenNames ?? [],
    envValues: envResult.values ?? {},
    markers,
  };
}

/** Um item pode aparecer duas vezes (conteúdo e pasta, por exemplo): uma linha só. */
function dedupe(items: RemoteChangeItem[]): RemoteChangeItem[] {
  const seen = new Set<string>();
  return items.filter(item => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

/**
 * Caminho de nomes da collection até o item (inclusive) — o mesmo formato do
 * `path` dos itens da Central, pro recorte numa pasta ou request.
 */
export function namePathTo(
  root: { id: string; name: string; item?: { id: string; name: string; item?: unknown[] }[] },
  id: string
): string[] | null {
  if (root.id === id) return [root.name];
  for (const child of root.item ?? []) {
    const below = namePathTo(child as Parameters<typeof namePathTo>[0], id);
    if (below) return [root.name, ...below];
  }
  return null;
}

/** Recorte da Central aberta a partir de uma collection, pasta/request ou environment. */
export function filterOverview(
  overview: SyncOverview,
  filter: { rootId?: string; itemId?: string; pathPrefix?: string[]; environmentName?: string } | undefined
): SyncOverview {
  if (!filter?.rootId && !filter?.environmentName) return overview;
  // Pasta ou request: ela mesma e o que está dentro — pelo id ou pelo caminho
  // de nomes (o caminho pega também o que é novo lá dentro, que ainda não
  // tem id conhecido aqui).
  const prefix = filter.pathPrefix ?? [];
  const insideItem = (item: RemoteChangeItem) =>
    item.id === filter.itemId ||
    (prefix.length > 0 && prefix.length <= item.path.length && prefix.every((name, i) => item.path[i] === name));
  const byRoot = (items: RemoteChangeItem[]) =>
    filter.rootId
      ? items.filter(
          item =>
            (item.rootId === filter.rootId || item.id === filter.rootId) && (!filter.itemId || insideItem(item))
        )
      : [];
  const byEnv = (names: string[]) =>
    filter.environmentName ? names.filter(name => name.split(' › ')[0] === filter.environmentName) : [];
  return {
    incoming: byRoot(overview.incoming),
    outgoing: byRoot(overview.outgoing),
    conflicts: byRoot(overview.conflicts),
    envIncoming: byEnv(overview.envIncoming),
    envOutgoing: byEnv(overview.envOutgoing),
    envKeptMine: byEnv(overview.envKeptMine),
    envSessionTokens: byEnv(overview.envSessionTokens ?? []),
    envValues: overview.envValues ?? {},
    // Marcador é do workspace, não de uma collection ou environment.
    markers: NO_MARKERS,
  };
}

export function overviewCounts(overview: SyncOverview): { incoming: number; outgoing: number; conflicts: number } {
  return {
    incoming: overview.incoming.length + overview.envIncoming.length + markerChangeCount(overview.markers ?? NO_MARKERS),
    outgoing: overview.outgoing.length + overview.envOutgoing.length + overview.envKeptMine.length,
    conflicts: overview.conflicts.length,
  };
}

/**
 * Completa os itens com o que a Central precisa pra explicar cada mudança:
 *   • item novo ou apagado (sem diff de campo): o conteúdo inteiro, como
 *     diff contra o vazio — antes a linha nem abria;
 *   • movido: o caminho aqui e no GitHub;
 *   • o tipo do item, e se ele existe aqui (pra "Abrir").
 * `before` é sempre o daqui e `after` o do GitHub (mesma convenção dos campos).
 */
export function withContentPreviews(
  overview: SyncOverview,
  local: CollectionItem[],
  remote: CollectionItem[]
): SyncOverview {
  const complete = (item: SyncItem): SyncItem => {
    const mine = findItem(local, item.id);
    const theirs = findItem(remote, item.id);
    const localPath = namePathIn(local, item.id) ?? undefined;
    const remotePath = namePathIn(remote, item.id) ?? undefined;
    const extra: Partial<SyncItem> = {
      kind: (mine ?? theirs)?.type,
      existsHere: !!mine,
      localPath,
      remotePath,
    };
    // O que o "Descartar" vai apagar ou trazer, pra o aviso dizer com números.
    const subject = item.change === 'new' ? mine : theirs ?? mine;
    if (subject && subject.type === 'folder') extra.insideRequests = countRequestsIn(subject);
    if (!mine && theirs) {
      const parentId = parentIdIn(remote, item.id);
      const parent = parentId ? findItem(remote, parentId) : undefined;
      if (parent && !findItem(local, parent.id)) extra.missingParent = parent.name;
    }
    // Item movido vem do merge só com o nome e sem a collection: a Central o
    // punha num grupo com o próprio nome. Completa com o caminho e a raiz.
    if (item.path.length <= 1 && (localPath ?? remotePath)) extra.path = localPath ?? remotePath;
    if (!item.rootId) {
      const rootId = rootIdIn(local, item.id) ?? rootIdIn(remote, item.id);
      if (rootId) extra.rootId = rootId;
    }
    if (item.fields.length === 0 && (item.change === 'new' || item.change === 'deleted') && (mine || theirs)) {
      extra.fields = [{ field: 'content', before: mine ? itemText(mine) : '', after: theirs ? itemText(theirs) : '', base: null }];
      // Pasta: o detalhe de cada request de dentro, não só o nome.
      if ((mine ?? theirs)?.type === 'folder') {
        const requests = insideRequestTexts(mine, theirs, local, remote);
        if (requests.length) extra.requests = requests;
      }
    } else if (
      mine &&
      theirs &&
      (mine.type === 'request' || mine.type === 'example') &&
      !item.fields.some(f => f.field === 'content')
    ) {
      // Alterada: além do campo que mudou, a request inteira dos dois lados
      // (com o payload) — a Central a mostra num "ver a request completa".
      const before = itemText(mine);
      const after = itemText(theirs);
      if (before !== after) extra.fields = [...item.fields, { field: 'content', before, after, base: null }];
    }
    return { ...item, ...extra };
  };
  return {
    ...overview,
    incoming: overview.incoming.map(complete),
    outgoing: overview.outgoing.map(complete),
    conflicts: overview.conflicts.map(complete),
  };
}

/** Id da collection raiz que contém o item, numa árvore. */
function rootIdIn(tree: CollectionItem[], id: string): string | undefined {
  return tree.find(root => !!findItem([root], id))?.id;
}

/**
 * As requests de dentro de uma pasta, nos dois lados, com o texto completo de
 * cada uma. Uma request que existe do outro lado FORA da pasta (movida pra
 * dentro dela) é comparada com essa versão: só mudou de lugar → sai da lista
 * (a linha "Movido" já diz isso); mudou também de conteúdo → mostra só o que
 * mudou. Sem isso ela aparecia inteira, como se fosse nova.
 */
function insideRequestTexts(
  mine: CollectionItem | undefined,
  theirs: CollectionItem | undefined,
  localTree: CollectionItem[],
  remoteTree: CollectionItem[]
): NonNullable<SyncItem['requests']> {
  const collect = (folder: CollectionItem | undefined) => {
    const found = new Map<string, { item: CollectionItem; path: string[] }>();
    const walk = (items: CollectionItem[], path: string[]) => {
      for (const child of items) {
        if (child.type === 'request') found.set(child.id, { item: child, path: [...path, child.name] });
        else if (child.type === 'folder') walk(child.item ?? [], [...path, child.name]);
      }
    };
    walk(folder?.item ?? [], []);
    return found;
  };
  const here = collect(mine);
  const there = collect(theirs);
  const ids = [...new Set([...there.keys(), ...here.keys()])];
  return ids
    .map(id => {
      const a = here.get(id);
      const b = there.get(id);
      const mineAnywhere = a?.item ?? findItem(localTree, id);
      const theirsAnywhere = b?.item ?? findItem(remoteTree, id);
      return {
        id,
        path: (b ?? a)!.path,
        before: mineAnywhere ? itemText(mineAnywhere) : '',
        after: theirsAnywhere ? itemText(theirsAnywhere) : '',
      };
    })
    .filter(r => r.before !== r.after);
}

function countRequestsIn(item: CollectionItem): number {
  return (item.item ?? []).reduce((n, child) => n + (child.type === 'request' ? 1 : countRequestsIn(child)), 0);
}

function parentIdIn(tree: CollectionItem[], id: string, parent: string | null = null): string | null | undefined {
  for (const item of tree) {
    if (item.id === id) return parent;
    const below = item.item ? parentIdIn(item.item, id, item.id) : undefined;
    if (below !== undefined) return below;
  }
  return undefined;
}
