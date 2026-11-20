import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import { withoutSessionTokens } from '@/lib/jwt';
import { adoptedRemoteBase, nodeHashes, type NodeHashes } from '@/lib/syncBase';
import { adoptedRemoteEnvBase, ENV_BASE_PREFIX, environmentHashes, rebaseEnvironments, type EnvRebaseResult } from './envMerge';
import { rebaseCollections, type RebaseResult } from './rebase';
import { isInSubtree, withSubtreeFrom } from './subtreePush';

// ─────────────────────────────────────────────────────────────────────────
// O push, num fluxo só — a parte que DECIDE, sem rede.
//
// Antes eram cinco caminhos (workspace aberto, workspace pelo menu, uma
// collection, um item, um environment), cada um com a sua versão de "lê o
// GitHub → mescla → aplica aqui → grava a base → envia → registra". Quase
// todo bug de sync achado nasceu de um caminho fazer um passo diferente dos
// outros. Aqui a decisão é uma só, por alcance:
//
//   workspace   → tudo (collections e environments);
//   collection  → só ela;
//   item        → a collection de lá com só o item trocado (subtreePush);
//   environment → só ele.
//
// Quem executa (ler o GitHub, aplicar aqui, gravar o commit) é o executor
// (AppLayout.runPush + GitHubSync.commitPush). Função pura: testável.
// ─────────────────────────────────────────────────────────────────────────

export type PushScope =
  | { kind: 'workspace' }
  | { kind: 'collection'; rootId: string }
  | { kind: 'item'; rootId: string; itemId: string }
  | { kind: 'environment'; envId: string };

/**
 * normal   → mescla com o GitHub (o que mudou só lá entra; conflito → revisão);
 * reviewed → logo depois de uma revisão: as collections já foram decididas,
 *            só os environments ainda passam pela mescla;
 * force    → "sobrescrever o GitHub com o meu": nada é mesclado.
 */
export type PushMode = 'normal' | 'reviewed' | 'force';

export interface PushRequest {
  workspace: string;
  scope: PushScope;
  mode: PushMode;
}

export interface PreparePushInput {
  scope: PushScope;
  mode: PushMode;
  local: { collections: CollectionItem[]; environments: Environment[] };
  /** O GitHub de agora, já como árvore (importData). */
  remote: { collections: CollectionItem[]; environments: Environment[] };
  base: NodeHashes | null;
  pendingCollectionIds: ReadonlySet<string>;
}

export interface PushReport {
  /** Mudanças de lá que entraram aqui (itens, campos, variáveis). */
  incoming: number;
  /** Mudou dos dois lados e ficou a versão daqui, sem perguntar. */
  keptMine: string[];
  rebase: RebaseResult | null;
  envResult: EnvRebaseResult | null;
}

export type PreparedPush =
  | {
      status: 'review';
      /** Itens em conflito dentro do alcance (vazio: a collection sumiu lá). */
      conflicts: string[];
      report: PushReport;
      /** A mescla dos environments vale mesmo com a revisão aberta. */
      environments: Environment[] | null;
    }
  | { status: 'nothing'; message: string }
  | {
      status: 'ready';
      /** O que fica aqui (com o que veio de lá). `null` = sem mudança. */
      localNext: { collections: CollectionItem[] | null; environments: Environment[] | null };
      /** A base do que entrou aqui (já igual ao GitHub), gravada ANTES do commit. */
      baseAdopt: { hashes: NodeHashes; dropKeys: string[] };
      /** O que sobe. */
      send: { collections: CollectionItem[]; environments: Environment[] };
      report: PushReport;
    };

const EMPTY_REPORT: PushReport = { incoming: 0, keptMine: [], rebase: null, envResult: null };

function replaceRoot(tree: CollectionItem[], root: CollectionItem): CollectionItem[] {
  return tree.some(c => c.id === root.id) ? tree.map(c => (c.id === root.id ? root : c)) : [...tree, root];
}

function findById<T extends { id: string }>(list: T[], id: string): T | undefined {
  return list.find(x => x.id === id);
}

function containsItem(root: CollectionItem, id: string): boolean {
  if (root.id === id) return true;
  return (root.item ?? []).some(child => containsItem(child, id));
}

/** O par de lá de um environment daqui: pelo id e, sem ele, pelo nome. */
function remoteEnvOf(env: Environment, remote: Environment[]): Environment | undefined {
  return findById(remote, env.id) ?? remote.find(e => e.name === env.name);
}

function mergeBases(a: { hashes: NodeHashes; dropKeys: string[] }, b: { hashes: NodeHashes; dropKeys: string[] }) {
  return { hashes: { ...a.hashes, ...b.hashes }, dropKeys: [...a.dropKeys, ...b.dropKeys] };
}

const NO_BASE = { hashes: {}, dropKeys: [] as string[] };

export function preparePush(input: PreparePushInput): PreparedPush {
  const { scope, mode, local, remote, base } = input;

  // ── Environment ────────────────────────────────────────────────────────
  if (scope.kind === 'environment') {
    const env = findById(local.environments, scope.envId);
    if (!env) return { status: 'nothing', message: 'This environment no longer exists here — nothing was sent.' };
    if (mode === 'force') {
      return { status: 'ready', localNext: { collections: null, environments: null }, baseAdopt: NO_BASE, send: { collections: [], environments: [env] }, report: EMPTY_REPORT };
    }
    const remoteEnv = remoteEnvOf(env, remote.environments);
    const envResult = rebaseEnvironments([env], remoteEnv ? [remoteEnv] : [], base);
    const merged = findById(envResult.merged, env.id) ?? env;
    const changed = envResult.incoming > 0;
    return {
      status: 'ready',
      localNext: { collections: null, environments: changed ? local.environments.map(e => (e.id === env.id ? merged : e)) : null },
      baseAdopt: changed ? adoptedRemoteEnvBase([merged], remoteEnv ? [remoteEnv] : [], base) : NO_BASE,
      send: { collections: [], environments: [merged] },
      report: { incoming: envResult.incoming, keptMine: envResult.keptMineNames, rebase: null, envResult },
    };
  }

  // ── Force: o daqui, sem mesclar ───────────────────────────────────────
  if (mode === 'force') {
    if (scope.kind === 'workspace') {
      return { status: 'ready', localNext: { collections: null, environments: null }, baseAdopt: NO_BASE, send: { collections: local.collections, environments: local.environments }, report: EMPTY_REPORT };
    }
    const localRoot = findById(local.collections, scope.rootId);
    if (!localRoot) return { status: 'nothing', message: 'This collection no longer exists here — nothing was sent.' };
    const remoteRoot = findById(remote.collections, scope.rootId);
    const sent = scope.kind === 'item' && remoteRoot ? withSubtreeFrom(remoteRoot, localRoot, scope.itemId) : localRoot;
    if (!sent) return { status: 'nothing', message: 'This item no longer exists here — nothing was sent.' };
    return { status: 'ready', localNext: { collections: null, environments: null }, baseAdopt: NO_BASE, send: { collections: [sent], environments: [] }, report: EMPTY_REPORT };
  }

  // ── Collections (normal: mescla; reviewed: como a revisão decidiu) ─────
  const rebase = mode === 'normal' ? rebaseCollections(local.collections, remote.collections, base, input.pendingCollectionIds) : null;
  // Os environments só entram no push do workspace inteiro.
  const envResult = scope.kind === 'workspace' ? rebaseEnvironments(local.environments, remote.environments, base) : null;
  const envChanged = !!envResult && envResult.incoming > 0;
  const envAdopt = envChanged ? adoptedRemoteEnvBase(envResult!.merged, remote.environments, base) : NO_BASE;

  const inScope = (nodeId: string): boolean => {
    if (scope.kind === 'workspace') return true;
    const node = rebase?.nodes.find(n => n.id === nodeId);
    if (!node) return false;
    return scope.kind === 'collection'
      ? node.rootId === scope.rootId || node.id === scope.rootId
      : isInSubtree(node, scope.itemId);
  };
  const conflicts = (rebase?.conflicts ?? []).filter(inScope);
  const report: PushReport = {
    incoming: (rebase ? rebase.incoming + rebase.fieldMerged : 0) + (envResult?.incoming ?? 0),
    keptMine: [...(rebase?.keptMineNames ?? []), ...(envResult?.keptMineNames ?? [])],
    rebase,
    envResult,
  };
  if (conflicts.length > 0) {
    return { status: 'review', conflicts, report, environments: envChanged ? envResult!.merged : null };
  }

  const mergedTree = rebase?.merged ?? local.collections;
  const collectionsChanged = !!rebase && rebase.incoming + rebase.fieldMerged > 0;

  if (scope.kind === 'workspace') {
    const environments = envResult?.merged ?? local.environments;
    return {
      status: 'ready',
      localNext: { collections: collectionsChanged ? mergedTree : null, environments: envChanged ? environments : null },
      baseAdopt: mergeBases(collectionsChanged ? adoptedRemoteBase(mergedTree, remote.collections, base) : NO_BASE, envAdopt),
      send: { collections: mergedTree, environments },
      report,
    };
  }

  // Collection ou item: só a collection do alcance muda aqui.
  const localRoot = findById(local.collections, scope.rootId);
  const mergedRoot = findById(mergedTree, scope.rootId);
  const remoteRoot = findById(remote.collections, scope.rootId);
  if (!localRoot) return { status: 'nothing', message: 'This collection no longer exists here — nothing was sent.' };
  // Apagada lá e intocada aqui: a mescla a tirou — é decisão pra revisão,
  // não pra um envio que a recriaria.
  if (!mergedRoot) return { status: 'review', conflicts: [], report, environments: null };
  if (scope.kind === 'item' && !containsItem(mergedRoot, scope.itemId)) {
    return { status: 'nothing', message: 'This item no longer exists here — nothing was sent.' };
  }

  const rootChanged = collectionsChanged && JSON.stringify(mergedRoot) !== JSON.stringify(localRoot);
  const sent =
    scope.kind === 'item' && remoteRoot ? withSubtreeFrom(remoteRoot, mergedRoot, scope.itemId) ?? mergedRoot : mergedRoot;
  return {
    status: 'ready',
    localNext: { collections: rootChanged ? replaceRoot(local.collections, mergedRoot) : null, environments: null },
    baseAdopt: rootChanged ? adoptedRemoteBase([mergedRoot], remoteRoot ? [remoteRoot] : [], base) : NO_BASE,
    send: { collections: [sent], environments: [] },
    report,
  };
}

/**
 * O que gravar na base depois de um push que DEU CERTO (o GitHub agora tem
 * `sent`). `local` = a árvore daqui que foi enviada (localNext, ou a de
 * antes se nada mudou). Os mesmos argumentos de recordSyncBase.
 */
export function baseAfterPush(input: {
  scope: PushScope;
  local: { collections: CollectionItem[]; environments: Environment[] };
  sent: { collections: CollectionItem[]; environments: Environment[] };
  base: NodeHashes | null;
  /** Arquivos apagados aqui que a pessoa manteve no GitHub. */
  keptStale?: boolean;
}): { hashes: NodeHashes; replacePrefixes: string[]; replaceRoots: 'all' | string[]; dropKeys: string[] } {
  const { scope, sent } = input;
  const envs = withoutSessionTokens(sent.environments);
  switch (scope.kind) {
    case 'workspace':
      // O push leva o workspace inteiro: o que subiu SUBSTITUI a base. Com
      // arquivos mantidos lá (keptStale), só a base do que subiu é trocada —
      // a do que ficou lá não pode sair (o pull o leria como "novo lá").
      return {
        hashes: { ...nodeHashes(sent.collections), ...environmentHashes(envs) },
        replacePrefixes: input.keptStale ? [] : [ENV_BASE_PREFIX],
        replaceRoots: input.keptStale ? sent.collections.map(c => c.id) : 'all',
        dropKeys: [],
      };
    case 'collection':
      return { hashes: nodeHashes(sent.collections), replacePrefixes: [], replaceRoots: sent.collections.map(c => c.id), dropKeys: [] };
    case 'item': {
      // Vira base só o que ficou igual dos dois lados: um conflito FORA do
      // item (ignorado por este envio) não pode passar por sincronizado.
      const localRoot = findById(input.local.collections, scope.rootId);
      const adopted = adoptedRemoteBase(localRoot ? [localRoot] : [], sent.collections, input.base);
      return { hashes: adopted.hashes, replacePrefixes: [], replaceRoots: [], dropKeys: adopted.dropKeys };
    }
    case 'environment':
      return { hashes: environmentHashes(envs), replacePrefixes: envs.map(e => `${ENV_BASE_PREFIX}${e.id}`), replaceRoots: [], dropKeys: [] };
  }
}
