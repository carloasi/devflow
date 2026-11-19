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
  replaceRoots: 'all' | string[] = [],
  // Chaves exatas que saem (ver adoptedRemoteBase: o que foi apagado dos
  // dois lados não pode continuar na base).
  dropKeys: string[] = []
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
      for (const key of dropKeys) delete current[key];
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

/** Ordem dos filhos gravada na base: [] sem registro, `null` se ilegível. */
function parseOrder(recorded: string | undefined): string[] | null {
  if (!recorded) return [];
  try {
    const ids: unknown = JSON.parse(recorded);
    return Array.isArray(ids) && ids.every(id => typeof id === 'string') ? ids : null;
  } catch {
    return null;
  }
}

/**
 * A base depois de trazer pra cá, ANTES do push, o que veio do GitHub (o
 * merge automático do push, lib/sync/rebase).
 *
 * A árvore mesclada é gravada aqui antes do commit. Sem atualizar a base
 * junto, se o commit falhasse (rede, cancelar, alguém enviando sem parar), o
 * que veio de lá ficava aqui como se fosse SEU: um item que o colega criou e
 * depois apagou era lido como "novo aqui" e voltava pro GitHub no push
 * seguinte; um campo que ele mudou duas vezes virava conflito falso.
 *
 * Regra por chave da base (nó, campo, pai, ordem): onde a árvore mesclada
 * ficou IGUAL ao GitHub, aquela parte está sincronizada com a versão que foi
 * lida — vira base. Onde ainda difere, é mudança sua e a base antiga fica.
 * Nó que a base tinha nestas collections e que não existe mais em nenhum dos
 * dois lados (apagado lá e aqui) sai da base.
 *
 * `merged` e `remote`: as mesmas collections dos dois lados (pode ser só uma).
 */
export function adoptedRemoteBase(
  merged: CollectionItem[] | null | undefined,
  remote: CollectionItem[] | null | undefined,
  base: NodeHashes | null
): { hashes: NodeHashes; dropKeys: string[] } {
  const mergedHashes = nodeHashes(merged);
  const remoteHashes = nodeHashes(remote);
  const hashes: NodeHashes = {};
  for (const [key, value] of Object.entries(remoteHashes)) {
    if (mergedHashes[key] === value && base?.[key] !== value) hashes[key] = value;
  }

  const dropKeys: string[] = [];
  if (base) {
    // Só nós destas collections: as outras não entraram na conta.
    const roots = new Set([...(merged ?? []), ...(remote ?? [])].map(root => root?.id).filter(Boolean));
    const suffix = `#${ROOT_FIELD}`;
    const gone = new Set<string>();
    for (const [key, value] of Object.entries(base)) {
      if (!key.endsWith(suffix) || !roots.has(value)) continue;
      const id = key.slice(0, -suffix.length);
      if (mergedHashes[id] === undefined && remoteHashes[id] === undefined) gone.add(id);
    }
    if (gone.size > 0) {
      for (const key of Object.keys(base)) {
        const hash = key.indexOf('#');
        if (gone.has(hash < 0 ? key : key.slice(0, hash))) dropKeys.push(key);
      }
    }
  }
  return { hashes, dropKeys };
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

/**
 * A collection está exatamente como na última sincronização?
 *
 * Serve ao ponto laranja de pendência da árvore. Ele é ligado por "algo
 * mudou desde a última vez que olhei" (collectionFingerprint), então editar
 * e desfazer à mão — renomear e voltar o nome, favoritar e desfavoritar —
 * deixava o ponto aceso pra sempre, pedindo um push que não envia nada.
 * Comparado com a base, dá pra apagá-lo quando a collection voltou a ser o
 * que está no GitHub.
 *
 * Confere tudo o que a base guarda da collection: conteúdo e campos de cada
 * nó, pai e ordem dos filhos — e que nenhum nó que a base tinha nela sumiu
 * (exclusão). Na dúvida (sem base, ou base que não conhece a collection)
 * responde `false`: deixar o ponto aceso é o lado seguro.
 */
export function matchesSyncBase(base: NodeHashes | null, root: CollectionItem | undefined): boolean {
  if (!base || !root?.id || base[root.id] === undefined) return false;

  const local = nodeHashes([root]);
  for (const [key, value] of Object.entries(local)) {
    if (base[key] === value) continue;
    // Campo que a base ainda não registra (base gravada antes de o campo
    // existir, como `pathParams`): o hash do nó inteiro, acima, já diz se
    // ele mudou — não é motivo pra deixar a pendência acesa.
    const hash = key.indexOf('#');
    if (base[key] === undefined && hash > 0 && base[key.slice(0, hash)] !== undefined) continue;
    return false;
  }

  // Nó que a base tinha nesta collection e que não existe mais aqui.
  const suffix = `#${ROOT_FIELD}`;
  for (const [key, value] of Object.entries(base)) {
    if (value !== root.id || !key.endsWith(suffix)) continue;
    if (local[key] === undefined) return false;
  }
  return true;
}

/**
 * O que mudou na collection desde a última sincronização: os nós
 * alterados ou criados (ids) e quantos a base tinha nela e sumiram. Serve
 * ao ponto de pendência da árvore, que até então só dizia "tem algo".
 * Sem base, ou base que não conhece a collection: null (não dá pra dizer).
 */
export function pendingChanges(
  base: NodeHashes | null,
  root: CollectionItem | undefined
): { changed: string[]; deleted: number } | null {
  if (!base || !root?.id || base[root.id] === undefined) return null;

  const changed: string[] = [];
  const present = new Set<string>();
  const walk = (node: CollectionItem, parentId: string) => {
    present.add(node.id);
    const known = base[node.id] !== undefined;
    const own = changedSinceBase(base, node.id, node) === true;
    // Trocou de pai: conta no item que se moveu.
    const moved = known && (base[fieldHashKey(node.id, PARENT_FIELD)] ?? '') !== parentId;
    // Ordem dos filhos: só conta na pasta quando os filhos são os MESMOS
    // (reordenou). Filho que entrou, saiu ou foi apagado já conta nele —
    // senão mover um item contava 3 (ele e as duas pastas).
    const ids = node.item?.map(c => c.id) ?? [];
    const recorded = base[fieldHashKey(node.id, ORDER_FIELD)];
    // Ordem gravada ilegível (base corrompida ou editada à mão): antes o
    // JSON.parse estourava e a contagem inteira nunca saía. Conta a pasta
    // como mudada — na dúvida, a pendência fica à vista.
    const before = parseOrder(recorded);
    const reordered =
      known &&
      (before === null ||
        (before.length === ids.length &&
          before.some((id, i) => id !== ids[i]) &&
          before.every(id => ids.includes(id))));
    // Campo sem registro na base (gravada antes de ele existir): o hash do
    // nó (`own`) já cobre — sem isto todo item contaria como mudado.
    const fields = Object.entries(fieldHashesOf(node)).some(([k, v]) => base[k] !== undefined && base[k] !== v);
    if (own || moved || reordered || fields) changed.push(node.id);
    node.item?.forEach(child => walk(child, node.id));
  };
  walk(root, '');

  // Apagados: só os de cima. Apagar uma pasta com 10 requests é 1 alteração,
  // não 11 — o que estava dentro dela sai junto.
  const suffix = `#${ROOT_FIELD}`;
  let deleted = 0;
  for (const [key, value] of Object.entries(base)) {
    if (value !== root.id || !key.endsWith(suffix)) continue;
    const id = key.slice(0, -suffix.length);
    if (present.has(id)) continue;
    const parent = base[fieldHashKey(id, PARENT_FIELD)];
    if (!parent || present.has(parent)) deleted++;
  }
  return { changed, deleted };
}
