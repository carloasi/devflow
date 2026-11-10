import { LazyStore } from '@tauri-apps/plugin-store';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { canonicalString } from './canonicalCompare';
import { hashText } from './contentHash';
import { stripStarredFlags } from '@/components/collection-tree/utils/tree.utils';
import { fieldHashesOf, fieldHashKey, ORDER_FIELD, PARENT_FIELD, ROOT_FIELD } from './sync/fieldMerge';

// ─────────────────────────────────────────────────────────────────────────
// Estado comum da última sincronização — a "base" de uma comparação de três
// vias.
//
// Sem ela só dá para saber que local e remoto diferem, não QUEM mexeu. O
// conflito então era marcado por collection: bastava a collection ter
// qualquer pendência para TODOS os itens dela saírem com o aviso de "isto
// descarta trabalho seu". Num workspace com 313 itens o aviso aparecia nos
// 313 e deixava de informar qualquer coisa.
//
// Com a base, as três situações se separam:
//
//   • mudou só lá      → aceitar é seguro;
//   • mudou só aqui    → nem deveria pedir decisão;
//   • mudou nos dois   → conflito de verdade, e costuma ser pouca coisa.
//
// Guarda HASH por nó, não o conteúdo: a pergunta é só "este nó mudou desde a
// última sincronização?". Guardar as árvores inteiras custaria megabytes por
// workspace para responder um sim ou não.
// ─────────────────────────────────────────────────────────────────────────

/**
 * nodeId → hash do conteúdo na última sincronização. Também guarda o hash de
 * cada CAMPO do nó, nas chaves `nodeId#campo` (ver lib/sync/fieldMerge) — é
 * o que deixa o push juntar duas mudanças na mesma request quando elas
 * mexeram em campos diferentes.
 */
export type NodeHashes = Record<string, string>;

// Arquivo próprio, como o histórico de runs: o localStorage é cota
// compartilhada, e são milhares de entradas por workspace.
const store = new LazyStore('sync-base.json', { autoSave: 300 });

const KEY_PREFIX = 'base:';

export async function loadSyncBase(workspace: string): Promise<NodeHashes | null> {
  if (!workspace) return null;
  try {
    const stored = await store.get<NodeHashes>(KEY_PREFIX + workspace);
    return stored && typeof stored === 'object' ? stored : null;
  } catch (e) {
    console.log('Could not read the sync base:', e);
    return null;
  }
}

/**
 * Grava o estado comum depois de uma sincronização.
 *
 * `merge` porque push e pull tocam partes diferentes: enviar UMA collection
 * não torna as outras sincronizadas, e sobrescrever o arquivo inteiro faria o
 * resto perder a base e voltar a avisar demais.
 */
export async function recordSyncBase(
  workspace: string,
  hashes: NodeHashes,
  // Chaves com estes prefixos saem antes da gravação — pra um environment
  // regravado não guardar variáveis que já não existem (ver envMerge).
  replacePrefixes: string[] = [],
  // Collections cuja base é SUBSTITUÍDA, não somada: 'all' = todas (push ou
  // pull do workspace inteiro), ou os ids das raízes gravadas. Sem isso o
  // que foi apagado ficava na base pra sempre — e um item que alguém
  // restaurasse no GitHub era lido como "apagado aqui", e o push seguinte
  // desfazia a restauração.
  replaceRoots: 'all' | string[] = []
): Promise<void> {
  if (!workspace) return;
  // Em fila por workspace: é ler → mesclar → gravar, e duas chamadas
  // seguidas (a base dos environments e a das collections no mesmo pull, ou
  // o fim de um push e a revisão) liam o mesmo estado — a segunda gravava
  // por cima da primeira e perdia o que ela tinha registrado.
  const previous = writeQueue.get(workspace) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      const current = dropReplaced({ ...((await loadSyncBase(workspace)) ?? {}) }, replacePrefixes, replaceRoots);
      await store.set(KEY_PREFIX + workspace, { ...current, ...hashes });
    } catch (e) {
      // Perder a base não pode derrubar o push que acabou de dar certo: a
      // comparação só volta a avisar demais até a próxima sincronização.
      console.log('Could not record the sync base:', e);
    }
  });
  writeQueue.set(workspace, next);
  await next;
}

const writeQueue = new Map<string, Promise<void>>();

/**
 * Só os hashes dos nós `ids` (o próprio e os `id#campo`). Pra revisão de
 * uma SUBPASTA: o que foi revisado vira sincronizado; o resto do workspace,
 * que ninguém viu, continua com a base que tinha.
 */
export function pickNodeHashes(hashes: NodeHashes, ids: ReadonlySet<string>): NodeHashes {
  const out: NodeHashes = {};
  for (const [key, value] of Object.entries(hashes)) {
    const hash = key.indexOf('#');
    if (ids.has(hash < 0 ? key : key.slice(0, hash))) out[key] = value;
  }
  return out;
}

/**
 * A base a gravar depois de uma revisão de collections — só do que foi
 * revisado. Gravar o GitHub inteiro numa revisão de UMA collection marcava
 * como "já sincronizado" o que colegas mudaram nas outras, e o push seguinte
 * mandava a versão antiga daqui por cima (desfazendo o trabalho deles).
 *
 *   'all'      → revisão do workspace inteiro: substitui a base toda;
 *   rootIds    → collections inteiras: substitui só a base delas;
 *   nodeIds    → itens de uma subpasta: soma só a deles.
 */
export function reviewedBase(
  remoteTree: CollectionItem[],
  scope: 'all' | { rootIds: string[] } | { nodeIds: string[] }
): { hashes: NodeHashes; replaceRoots: 'all' | string[] } {
  if (scope === 'all') return { hashes: nodeHashes(remoteTree), replaceRoots: 'all' };
  if ('rootIds' in scope) {
    const roots = new Set(scope.rootIds);
    return { hashes: nodeHashes(remoteTree.filter(root => roots.has(root.id))), replaceRoots: scope.rootIds };
  }
  return { hashes: pickNodeHashes(nodeHashes(remoteTree), new Set(scope.nodeIds)), replaceRoots: [] };
}

export async function clearSyncBase(workspace: string): Promise<void> {
  if (!workspace) return;
  try {
    await store.delete(KEY_PREFIX + workspace);
  } catch (e) {
    console.log('Could not clear the sync base:', e);
  }
}

const hash = hashText;

/**
 * Hash de cada nó da árvore, pelo conteúdo PRÓPRIO dele.
 *
 * Sem os filhos de propósito: incluí-los faria toda pasta de um fluxo mudar
 * quando uma request lá dentro mudasse, e a pasta apareceria como conflito
 * sem ninguém ter tocado nela.
 */
/** Conteúdo próprio do nó, sem filhos e sem as marcas locais de favorito. */
function ownContent(item: CollectionItem): Omit<CollectionItem, 'item'> {
  const own = { ...stripStarredFlags(item) };
  delete own.item;
  return own;
}

export function nodeHashes(roots: CollectionItem[] | undefined | null): NodeHashes {
  const out: NodeHashes = {};

  const walk = (items: CollectionItem[], parentId: string, rootId: string | null) => {
    for (const item of items) {
      if (!item?.id) continue;
      out[item.id] = hash(canonicalString(ownContent(item)));
      Object.assign(out, fieldHashesOf(item));
      out[fieldHashKey(item.id, ROOT_FIELD)] = rootId ?? item.id;
      // Onde o item estava e em que ordem estavam os filhos — guardados como
      // são (não hash): o merge do push precisa deles pra saber quem moveu
      // e quem reordenou (lib/sync/rebase).
      out[fieldHashKey(item.id, PARENT_FIELD)] = parentId;
      if (item.item?.length) {
        out[fieldHashKey(item.id, ORDER_FIELD)] = JSON.stringify(item.item.map(child => child.id));
        walk(item.item, item.id, rootId ?? item.id);
      }
    }
  };

  walk(roots ?? [], '', null);
  return out;
}

/**
 * Tira da base o que vai ser regravado (ver recordSyncBase). Exportada pros
 * testes; função pura sobre o registro.
 */
export function dropReplaced(
  current: NodeHashes,
  replacePrefixes: string[],
  replaceRoots: 'all' | string[]
): NodeHashes {
  const out = { ...current };
  for (const key of Object.keys(out)) {
    if (replacePrefixes.some(prefix => key.startsWith(prefix))) delete out[key];
  }
  if (replaceRoots === 'all') {
    // Tudo que é de collection — não os environments ('env:') nem o
    // catálogo de marcadores ('marker:', ver lib/markers markerBaseHashes):
    // esses têm a própria gravação, por prefixo.
    for (const key of Object.keys(out)) if (!key.startsWith('env:') && !key.startsWith('marker:')) delete out[key];
    return out;
  }
  if (replaceRoots.length === 0) return out;
  const roots = new Set(replaceRoots);
  const suffix = `#${ROOT_FIELD}`;
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(out)) {
    if (key.endsWith(suffix) && roots.has(value)) ids.add(key.slice(0, -suffix.length));
  }
  // A própria raiz também (bases antigas não tinham o ~root dela).
  for (const root of roots) ids.add(root);
  for (const key of Object.keys(out)) {
    const hash = key.indexOf('#');
    if (ids.has(hash < 0 ? key : key.slice(0, hash))) delete out[key];
  }
  return out;
}

/**
 * Algo ABAIXO do nó mudou (ou foi criado) desde a base? Só os descendentes —
 * o próprio nó é com changedSinceBase.
 *
 * Existe por causa das exclusões: apagar uma pasta ou collection leva tudo o
 * que está dentro, e o hash do nó não inclui os filhos. Sem olhar pra baixo,
 * "apagaram a collection no GitHub" passava por seguro mesmo com uma request
 * editada aqui dentro dela — e a edição sumia junto.
 */
export function changedInSubtree(base: NodeHashes | null, node: CollectionItem | undefined): boolean {
  if (!base || !node?.item?.length) return false;
  return node.item.some(
    child => changedSinceBase(base, child.id, child) !== false || changedInSubtree(base, child)
  );
}

/** O nó mudou desde a base? `null` quando a base não o conhece. */
export function changedSinceBase(
  base: NodeHashes | null,
  nodeId: string,
  local: CollectionItem | undefined
): boolean | null {
  if (!base) return null;
  const recorded = base[nodeId];
  if (recorded === undefined) {
    // Nó que a base não tem é nó criado depois dela — portanto, trabalho local.
    return true;
  }
  if (!local) return null;
  return hash(canonicalString(ownContent(local))) !== recorded;
}
