"use client";

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { saveSecret, getSecret, deleteSecret } from '@/lib/secureStorage'
import { AlertTriangle, ArrowDown, ArrowUp, Check, FolderGit2 } from "lucide-react";
import { useSyncDiffStrings } from "@/lib/i18n/syncDiffStrings";
import { isCapturingSyncStatus, openSyncCenter, reportSyncStatus, setRemoteBehind, throwIfSyncCancelled, useKnownConflicts } from "@/lib/sync/syncCenterStore";
import { storeGet, storeSet } from "@/lib/tauriStore";
import { toast } from "sonner";
import { withoutSessionTokens } from "@/lib/jwt";
import { RemoteChangeToast, type RemoteCommitInfo } from "@/components/SyncDiff/RemoteChangeToast";
import type { RemoteChangePreview } from "@/lib/sync/remoteChangeAlert";
import { loadWorkspaceLocalData, loadWorkspaceMarkers } from "@/storage/localSyncStore";
import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import type { PushScope } from "@/lib/sync/pushPipeline";
import { acquireSyncLock, holdsSyncLock, releaseSyncLock, SYNC_BUSY_MESSAGE, syncLockHolder } from "@/lib/sync/syncLock";
import { stripStarredFlags } from "@/components/collection-tree/utils/tree.utils";
import { clearDerivedKeyCache, MissingPassphraseError } from "@/lib/syncCrypto";
import type { FileChange } from "@/lib/commitDiff";
import { CommitChangesView } from "@/components/CommitChangesView";
import { ModalCard } from "@/components/ui/modal-card";
import { catalogForPush, MARKER_BASE_PREFIX, markerBaseAfterPush, remapMarkers, withRemoteTwins, type Marker } from "@/lib/markers";
import { loadSyncBase, recordSyncBase } from "@/lib/syncBase";
import {
  applyShaChanges,
  behindPaths,
  countBehind,
  loadSyncedShas,
  recordSyncedShas,
  repoKeyOf,
  subscribeSyncedShas,
  workspaceShaChanges,
  type FileShas,
} from "@/lib/remoteVersions";
import { isPendingEmpty, readPendingPush, type PendingPush } from "@/storage/pendingPushStore";
import { DevFlowBusyCard, DevFlowSpinner } from "@/components/helper/DevFlowLoader";
import {
  GitHubConflictError,
  GitHubRateLimitError,
  GitHubStorageClient,
  RECENT_WRITE_MS,
  recentWrites,
  type CommitInfo,
  type GitHubConfig,
  type RepoItem,
} from "@/lib/sync/githubStorage";
// Os erros e o commit do histórico continuam saindo daqui pra quem já importava.
export { GitHubConflictError, GitHubRateLimitError };
export type { CommitInfo };
import {
  buildPushPlan,
  collectionFilePath,
  collectionNameOf,
  findNameCollisions,
  collisionMessage,
  duplicateIdGroups,
  environmentFilePath,
  markersFilePath,
  newestOf,
  pushCommitMessage,
  renamedStalePaths,
  rootIdOf,
} from "@/lib/sync/pushPlan";


// HTTP 401 do GitHub = token ausente/inválido/expirado (403 é permissão —
// não confundir). Usado pra trocar a mensagem genérica "HTTP 401" por um
// aviso acionável, e pra disparar um toast global (ver showStatus) já que
// pushes silenciosos (Ctrl+S) podem falhar com o painel de sync fechado,
// onde a mensagem de status normal (dentro do popover) nunca seria vista.
function isAuthError(e: any): boolean {
  const msg = e?.message ?? "";
  return /HTTP 401\b/.test(msg);
}

const SettingsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.93 2.93 0 1 1 0-5.86 2.93 2.93 0 0 1 0 5.86z"/>
  </svg>
);

const BranchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.7 }}>
    <path d="M5 3.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zm0 9.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zm8.5-6.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0zM3.75 4.5v7M3.75 11.5A4.75 4.75 0 0 0 8.5 6.75V6.25M11.25 6.5v-.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  </svg>
);

const EyeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
    <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="8" cy="8" r="2" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
    <path d="M1 8s2.5-5 7-5c1.4 0 2.6.4 3.6 1M15 8s-1 2-3 3.4M8 13c-4.5 0-7-5-7-5a12 12 0 0 1 2.4-3.1M6.6 6.6a2 2 0 0 0 2.9 2.9" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M1.5 1.5l13 13" strokeLinecap="round"/>
  </svg>
);

const CheckDotIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const MissingDotIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round"/>
  </svg>
);

// Relógio com seta (histórico/versões) — usado no cabeçalho da janela de
// commits e no botão correspondente do menu de workspaces.
const HistoryClockIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2.2 1.8v2.6h2.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 5v3.2l2.2 1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const RefreshIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);


const FolderIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.85 }}>
    <path d="M2 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3z" />
  </svg>
);


interface SyncStatus {
  type: "success" | "error" | "info" | null;
  message: string;
}



export interface GitHubSyncHandle {
  /**
   * Grava um push (qualquer alcance) — a decisão do que sobe é do executor
   * (AppLayout.runPush, lib/sync/pushPipeline). Ver commitPush.
   */
  commitPush: (input: CommitPushInput) => Promise<CommitPushResult>;
  /** Mensagem no painel de sync (e na Central, quando ela capturou). */
  report: (type: "success" | "error" | "info", message: string) => void;
  // Traz o remoto decriptado SEM aplicar nada. É o que permite comparar
  // antes de sobrescrever (etapas 4-6).
  // `statusLabel` acende a pílula de operação pontual enquanto baixa. É
  // opcional porque quem chama de dentro do painel já tem o próprio aviso;
  // quem chama da árvore não tem nada, e a busca pode levar segundos.
  // `peek`: só pra mostrar (prévias, avisos) — não conta como versão lida
  // (ver getFile).
  fetchWorkspace: (
    workspaceName: string,
    ref?: string,
    statusLabel?: string,
    options?: { peek?: boolean }
  ) => Promise<RemoteWorkspaceData>;
  // Baixa todos os workspaces do repositório e substitui os daqui (os que têm
  // alteração não enviada são pulados) — Configurações → Avançado.
  replaceAllFromGitHub: () => Promise<void>;
  // Renomeia a pasta remota do workspace (ver renameRemoteWorkspace) — no-op
  // silencioso se o workspace nunca foi sincronizado.
  /**
   * 'renamed' = a pasta foi movida; 'nothing' = não havia o que mover (sync
   * desligado, ou o workspace nunca subiu); 'failed' = ficou com o nome
   * antigo lá (ocupado, sem senha) — com erro de verdade, lança.
   */
  renameWorkspace: (oldName: string, newName: string) => Promise<'renamed' | 'nothing' | 'failed'>;
  // Abre a janela de histórico de commits do workspace, onde dá pra escolher
  // qual versão baixar (em vez de sempre pegar a mais recente).
  openCommitHistory: (workspaceName: string) => void;
  // Uma revisão foi aplicada: o que ela comparou passa a contar como
  // sincronizado (ver lib/remoteVersions). Sem isso o contador "mudou no
  // GitHub" continuaria apontando o que a pessoa acabou de ver e decidir.
  markReviewed: (workspaceName: string, scope: ReviewScope) => Promise<void>;
  // Último commit no GitHub do arquivo que contém esta collection raiz (ou
  // environment) — pra revisão dizer quem mexeu e quando. `null` = o arquivo
  // não está na última leitura, ou o GitHub não respondeu.
  lastChangeOf: (workspaceName: string, rootId: string) => Promise<CommitInfo | null>;
  /**
   * O conteúdo do arquivo de uma collection raiz como estava na ÚLTIMA
   * SINCRONIZAÇÃO desta máquina (pelo sha registrado em lib/remoteVersions).
   * `null` = não dá pra saber (nunca sincronizado, arquivo novo).
   */
  syncedVersionOf: (workspaceName: string, rootId: string) => Promise<unknown | null>;
  /** O que esta máquina registrou como sincronizado no workspace — pro "Desfazer" do pull. */
  snapshotSynced: (workspaceName: string) => Promise<FileShas>;
  /** Volta o registro de sincronizado ao de um snapshot (sem dizer nada sobre o GitHub de agora). */
  restoreSynced: (workspaceName: string, snapshot: FileShas) => Promise<void>;
  /**
   * Os últimos commits do arquivo de uma collection raiz, com como ler o
   * arquivo em cada um — pro "quem mudou este item". `null` = arquivo
   * desconhecido (nunca lido nesta sessão).
   */
  fileHistoryOf: (
    workspaceName: string,
    rootId: string,
    limit?: number
  ) => Promise<{ commits: CommitInfo[]; read: (sha: string) => Promise<unknown | null> } | null>;
}

/** O que uma revisão cobriu: o workspace inteiro, ou só algumas collections. */
export type ReviewScope = 'collections' | 'environments' | { rootIds: string[] };

interface GitHubSyncProps {
  workspace: string; // path local do workspace (ex: "MeuWorkspace"), dono é o AppLayout
  currentCollections: any;
  currentEnvironments: any;
  // Devolve Promise porque persiste em disco: quem chama TEM que esperar.
  // O catalogo de marcadores e lido logo depois, do que acabou de ser
  // gravado — sem o await ele leria a arvore anterior ao pull.
  onPullCollections: (data: any) => void | Promise<void>;
  onPullEnvironments: (data: any[]) => void;
  onImportWorkspace: (name: string) => void | Promise<void>;
  onSyncStatusChange?: (isSynced: boolean) => void; // ✅ novo
  // Pull "todos os workspaces": pra cada workspace remoto encontrado em
  // Postman/*, o GitHubSync baixa os arquivos e entrega aqui já
  // descriptografados — quem persiste em disco (criando o workspace local
  // se precisar) é o AppLayout.
  onPullWorkspaceData?: (
    workspaceName: string,
    rawCollections: any[],
    rawEnvironments: any[],
    // fromCommit: restauração de um commit antigo — não vira a base do sync.
    options?: { fromCommit?: boolean }
  ) => void | Promise<void>;
  // Se true, existem abas com alterações não salvas (ou dados locais ainda
  // não enviados pro GitHub) — o Pull pergunta antes de sobrescrever.
  hasUnsyncedChanges?: boolean;
  // Se true, há conteúdo salvo localmente esperando push — mostra um ponto
  // no botão do sync pra isso não passar despercebido.
  hasPendingPush?: boolean;
  // O que está esperando push no workspace ATUAL — pro contador "↑ N to push".
  pendingPushSummary?: PendingPush;
  // Catalogo de marcadores do workspace ativo — sobe junto no push.
  currentMarkers?: Marker[];
  // Catalogo que veio do repositorio. Quem funde com o local e o AppLayout
  // (ver mergeCatalogs): aqui so se sabe baixar.
  onPullMarkers?: (workspaceName: string, markers: Marker[]) => void | Promise<void>;
  // A pasta do workspace foi apagada do GitHub (o daqui fica). Quem esquece
  // a base da sincronização e marca o que existe aqui como "para enviar" é o
  // AppLayout — sem isso o sync seguinte lia tudo como "apagado lá".
  onRemoteWorkspaceDeleted?: (workspaceName: string) => void | Promise<void>;
  // Pull do workspace ATUAL passando pela tela de revisão. Quando existe, é
  // o que o botão Pull faz; o pull de todos os workspaces (que substitui o
  // local sem mescla) fica numa ação à parte.
  onPullWithReview?: () => Promise<void>;
  // Restaurar um commit do workspace ATUAL passa pela revisão: a versão
  // daquele commit é comparada com a daqui, e a pessoa escolhe o que volta.
  onReviewSnapshot?: (workspaceName: string, collections: unknown[], environments: unknown[], commitSha: string) => void;
  // Aviso em segundo plano: o GitHub mudou um arquivo do workspace — roda o
  // merge "de teste" (nada é aplicado) e diz QUAIS itens mudaram dos dois
  // lados e, de cada item que veio de lá, o antes/depois (`preview`, pro
  // mini-diff do aviso). `null` = não deu pra checar.
  // changedRootIds: collections cujos arquivos mudaram no GitHub — sem item a
  // trazer, a prévia mostra o que o último commit delas mudou.
  onConflictPreview?: (workspaceName: string, changedRootIds?: string[]) => Promise<{ conflicts: string[]; incoming: number; preview?: RemoteChangePreview } | null>;
  // "Conflict history…": as decisões de conflito tomadas nesta máquina.
  onShowConflictHistory?: () => void;
}

/** O que gravar num push (ver GitHubSyncHandle.commitPush). */
export interface CommitPushInput {
  workspaceName: string;
  scope: PushScope;
  /** O que sobe: o workspace inteiro, ou só a collection / o environment do alcance. */
  collections: CollectionItem[];
  environments: Environment[];
  /** Catálogo de marcadores daqui (null = não enviar o catálogo). */
  markers: Marker[] | null;
  /** Tudo o que existe aqui — pra achar nomes que colidem com o que sobe. */
  allLocal?: { collections: CollectionItem[]; environments: Environment[] };
  /** "Sobrescrever o GitHub com o meu": sem checagem de versão. */
  force?: boolean;
  /** Mensagem do commit (sem ela, a do push do workspace). */
  message?: string;
  /** Nome no aviso "Sending ...". */
  label?: string;
  /** Trava do push que chama (runPush): a gravação é parte dele (lib/sync/syncLock). */
  lockToken?: string;
}

export type CommitPushResult =
  | { status: "pushed"; collections: CollectionItem[]; removed: string[]; keptStale: string[] }
  | { status: "conflict"; paths: string[] }
  | { status: "collision"; message: string }
  | { status: "busy"; message: string }
  | { status: "error"; message: string };

const GH_TOKEN_KEY = 'gh_sync_token'
// Senha de sincronização: deriva a chave que cifra o conteúdo enviado ao
// GitHub. Fica no armazenamento seguro do SO, junto do token.
const GH_PASSPHRASE_KEY = 'gh_sync_passphrase'



const WORKSPACES_ROOT = "Postman";

// Catálogo de marcadores, nomes de arquivo e nomes que colidem: ver
// lib/sync/pushPlan.ts — a regra é uma só pra todos os caminhos de push.

// Baixa e descriptografa os arquivos de UM workspace (dado seus paths já
// resolvidos), sem depender de estado de componente — usado tanto pelo Pull
// de um workspace só quanto pelo Pull de todos os workspaces do repositório.
// Cada arquivo é baixado individualmente (allSettled) pra que a falha de um
// não derrube os outros; retorna também quais paths falharam.
/**
 * Environment de arquivo sem `id` (editado à mão, export antigo) ganha um id
 * estável, derivado do caminho e da posição no arquivo. Sem id, todos caíam
 * na mesma chave `undefined` da deduplicação por id: só o último sobrevivia
 * ao pull, e o push seguinte propunha apagar os outros arquivos. Estável (e
 * não aleatório) pra que o mesmo arquivo dê o mesmo id a cada leitura — a
 * base da sincronização e a pendência são por id.
 */
function withEnvironmentIds<T>(list: T[], path: string): T[] {
  return list.map((env, index) =>
    env && typeof env === "object" && typeof (env as { id?: unknown }).id !== "string"
      ? ({ ...env, id: `gh-env:${path}#${index}` } as T)
      : env
  );
}

async function downloadWorkspaceFilesData(
  storage: GitHubStorageClient,
  cPaths: string[],
  ePaths: string[],
  // SHA de commit opcional — quando informado, baixa a versão dos arquivos
  // naquele commit (histórico) em vez da versão atual da branch.
  ref?: string,
  peek = false
): Promise<{
  collections: any[];
  environments: any[];
  failedPaths: string[];
  /** sha de cada arquivo lido (os que falharam ficam de fora). */
  shas: FileShas;
  /** Ids das collections raiz em cada arquivo — pra saber qual arquivo uma revisão de UMA collection cobriu. */
  idsByPath: Record<string, string[]>;
  /**
   * Arquivos deixados de fora por guardarem o mesmo id de outro mais novo
   * (renomeação que manteve o antigo), com os ids de cada um.
   */
  superseded: Record<string, string[]>;
}> {
  const failedPaths: string[] = [];
  const shas: FileShas = {};
  const idsByPath: Record<string, string[]> = {};
  // Conteúdo por arquivo, na ordem da listagem (o Map guarda a ordem).
  const collectionByPath = new Map<string, unknown[]>();
  const envByPath = new Map<string, unknown[]>();

  const collectionSettled = await Promise.allSettled(cPaths.map((p) => storage.getFile(p, ref, { peek })));
  collectionSettled.forEach((settled, i) => {
    if (settled.status === "rejected" || !settled.value || !settled.value.content) {
      failedPaths.push(cPaths[i]);
      return;
    }
    if (settled.value.sha) shas[cPaths[i]] = settled.value.sha;
    const content = settled.value.content;
    const list = Array.isArray(content) ? content : [content];
    idsByPath[cPaths[i]] = list.map(rootIdOf).filter((id): id is string => !!id);
    collectionByPath.set(cPaths[i], list);
  });

  const envSettled = await Promise.allSettled(ePaths.map((p) => storage.getFile(p, ref, { peek })));
  envSettled.forEach((settled, i) => {
    if (settled.status === "rejected" || !settled.value || !settled.value.content) {
      failedPaths.push(ePaths[i]);
      return;
    }
    if (settled.value.sha) shas[ePaths[i]] = settled.value.sha;
    let content = settled.value.content;
    if (typeof content === "string") {
      try { content = JSON.parse(content); } catch (e) {}
    }
    const list = withEnvironmentIds(Array.isArray(content) ? content : [content], ePaths[i]);
    idsByPath[ePaths[i]] = list
      .map((env: any) => env?.id)
      .filter((id: unknown): id is string => typeof id === "string");
    envByPath.set(ePaths[i], list);
  });

  // O mesmo id em dois arquivos: alguém renomeou e manteve o arquivo antigo.
  // Antes valia o que viesse primeiro (collections) ou por último
  // (environments) na listagem — e o pull podia trazer a versão VELHA por
  // cima da nova, sem aviso. Vale o do commit mais recente; os outros ficam
  // de fora (e o próximo push os apaga, ver renamedStalePaths). Sem conseguir
  // a data de algum, o grupo inteiro conta como não lido: nada é aplicado.
  const superseded: Record<string, string[]> = {};
  const groups = [
    ...duplicateIdGroups(idsByPath, [...collectionByPath.keys()]),
    ...duplicateIdGroups(idsByPath, [...envByPath.keys()]),
  ];
  for (const group of groups) {
    const dates = await Promise.all(
      group.map((p) => storage.listCommits(p, 1).then((c) => c[0]?.committedAt || c[0]?.date).catch(() => undefined))
    );
    const keep = newestOf(group, (p) => dates[group.indexOf(p)]);
    for (const p of group) {
      if (p === keep) continue;
      if (keep) superseded[p] = idsByPath[p];
      else failedPaths.push(p);
      delete idsByPath[p];
      delete shas[p];
      collectionByPath.delete(p);
      envByPath.delete(p);
    }
    if (!keep) {
      console.warn("Could not tell which of these files is the current one (same id):", group);
    }
  }

  const collections = [...collectionByPath.values()].flat() as any[];
  const rawEnvironments = [...envByPath.values()].flat() as any[];
  const environments = Array.from(
    new Map(rawEnvironments.map((env: any) => [env.id, env])).values()
  );

  return { collections, environments, failedPaths, shas, idsByPath, superseded };
}

// ─── O que a última leitura do remoto trouxe, por workspace ─────────────
//
// Uma revisão aplicada no AppLayout (handleApplyDiff) torna o workspace
// "sincronizado" com a versão que foi COMPARADA — não com a de agora, que
// pode já ser outra. É aqui que essa versão fica, até a revisão ser aplicada
// (ver markReviewed).
interface FetchedVersions {
  wsRemotePath: string;
  shas: FileShas;
  idsByPath: Record<string, string[]>;
  /** Arquivos deixados de fora na leitura (mesmo id de um mais novo), com os ids. */
  superseded?: Record<string, string[]>;
}
const lastFetched = new Map<string, FetchedVersions>();

/**
 * A lista de arquivos de uma prévia, acertada com o que esta máquina gravou
 * ou apagou há pouco: a listagem do GitHub também atrasa, e uma collection
 * recém-criada (ou apagada) pelo envio voltava a aparecer na Central.
 */
function withRecentWrites(
  repoKey: string,
  wsRemotePath: string,
  lists: { collectionPaths: string[]; envPaths: string[] }
): { collectionPaths: string[]; envPaths: string[] } {
  const prefix = `${repoKey}|${wsRemotePath}/`;
  const collectionPaths = new Set(lists.collectionPaths);
  const envPaths = new Set(lists.envPaths);
  for (const [key, entry] of recentWrites) {
    if (!key.startsWith(prefix) || Date.now() - entry.at >= RECENT_WRITE_MS) continue;
    const filePath = key.slice(repoKey.length + 1);
    if (!isTrackedPath(wsRemotePath, filePath)) continue;
    const list = isEnvironmentPath(wsRemotePath, filePath) ? envPaths : collectionPaths;
    if (entry.sha === null) list.delete(filePath);
    else list.add(filePath);
  }
  return { collectionPaths: [...collectionPaths], envPaths: [...envPaths] };
}
// O que uma PRÉVIA leu (aviso em segundo plano, "Check for updates", "Preview
// push"). Fica à parte: lastFetched é a versão que a revisão aberta comparou
// (markReviewed a registra como sincronizada), e uma prévia no meio a
// trocava pela versão nova — que ninguém revisou. Serve só pra achar o
// arquivo de uma collection (histórico, versão sincronizada).
const lastPeeked = new Map<string, FetchedVersions>();

/** Arquivos e ids da última leitura, revisada ou de prévia — só pra localizar arquivos. */
function knownVersions(storage: GitHubStorageClient, workspaceName: string): FetchedVersions | undefined {
  const key = `${storage.repoKey}|${workspaceName}`;
  return lastFetched.get(key) ?? lastPeeked.get(key);
}

// Commit mais recente por arquivo, guardado pelo sha do blob: enquanto o
// arquivo não muda, quem mexeu por último também não.
const lastCommitCache = new Map<string, CommitInfo | null>();

// Conteúdo de uma versão de arquivo, pelo sha (ver syncedVersionOf).
const syncedVersionCache = new Map<string, Promise<unknown | null>>();
// Arquivo como estava num commit (ver fileHistoryOf) — commit não muda.
const fileAtCommitCache = new Map<string, Promise<unknown | null>>();

function rememberFetched(storage: GitHubStorageClient, workspaceName: string, data: FetchedVersions) {
  lastFetched.set(`${storage.repoKey}|${workspaceName}`, data);
}

/** Arquivo de environment do workspace? (O resto da listagem são collections.) */
function isEnvironmentPath(wsRemotePath: string, path: string): boolean {
  return path.startsWith(`${wsRemotePath}/environments/`);
}

/** Collection ou environment — o que a listagem do workspace acompanha. */
function isTrackedPath(wsRemotePath: string, path: string): boolean {
  if (!path.startsWith(`${wsRemotePath}/`)) return false;
  if (isEnvironmentPath(wsRemotePath, path)) return /\.json$/i.test(path);
  return /(\.postman_collection\.json|collection.*\.json)$/i.test(path);
}

/**
 * Registra como sincronizado o que um pull acabou de aplicar. Arquivos do
 * workspace que não vieram (apagados lá, ou que falharam) deixam de contar
 * como sincronizados — o contador volta a apontá-los como pendentes.
 */
async function recordPulledWorkspace(
  storage: GitHubStorageClient,
  wsRemotePath: string,
  shas: FileShas,
  options: { remoteToo?: boolean } = {}
) {
  const synced = await loadSyncedShas(storage.repoKey);
  const changes = workspaceShaChanges(shas, synced, (p) => isTrackedPath(wsRemotePath, p));
  await recordSyncedShas(storage.repoKey, changes, options);
}

/**
 * Dos arquivos que existem lá e não correspondem a nada daqui, os que já
 * estiveram sincronizados nesta máquina — esses você apagou (ou renomeou)
 * aqui. Os outros nunca passaram por aqui: são novos no GitHub, e propor
 * apagá-los era propor apagar o trabalho de um colega.
 */
async function removedHere(storage: GitHubStorageClient, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return paths;
  const synced = await loadSyncedShas(storage.repoKey);
  return paths.filter((path) => !!synced[path]);
}

/**
 * Dos arquivos que sobraram lá: os que são RENOMEAÇÃO (tudo o que guardam
 * está sendo gravado neste push com outro nome) saem sem perguntar — mantê-los
 * deixava dois arquivos com o mesmo id, e o pull seguinte podia trazer a
 * versão velha de volta. Os outros seguem a regra de sempre (removedHere) e
 * a pessoa confirma.
 */
async function staleToRemove(
  storage: GitHubStorageClient,
  workspaceName: string,
  stalePaths: string[],
  writtenIds: ReadonlySet<string>
): Promise<{ renamed: string[]; ask: string[] }> {
  if (stalePaths.length === 0) return { renamed: [], ask: [] };
  const fetched = knownVersions(storage, workspaceName);
  const renamed = fetched
    ? renamedStalePaths(stalePaths, (path) => fetched.idsByPath[path] ?? fetched.superseded?.[path], writtenIds)
    : [];
  const ask = await removedHere(storage, stalePaths.filter((path) => !renamed.includes(path)));
  return { renamed, ask };
}

// O que o remoto tem, decriptado, SEM nada aplicado localmente.
export interface RemoteWorkspaceData {
  // Cru, como saiu do arquivo decriptado: ainda não passou pelo importData
  // que o transforma em árvore.
  collections: unknown[];
  environments: unknown[];
  collectionPaths: string[];
  envPaths: string[];
  failedPaths: string[];
  shas: FileShas;
  idsByPath: Record<string, string[]>;
  // Catálogo de marcadores do workspace. `null` = não tem (ou falhou a
  // leitura) — nunca "lista vazia", pelo mesmo motivo de fetchRemoteMarkers.
  // Incluído aqui (e não só no pull de workspace inteiro) pra que as ações
  // de UMA collection (pull, "Check for updates", a checagem antes do push)
  // deixem de ser cegas pra mudança só-no-catálogo (renomear/recolorir um
  // marcador existente) — todas passam por fetchWorkspace/fetchRemoteWorkspace.
  markers: Marker[] | null;
  /**
   * Arquivos com o mesmo id de outro mais novo (renomeação que manteve o
   * antigo): ficaram de fora da leitura, e o próximo push os apaga.
   */
  supersededPaths: string[];
}

// Resolve os caminhos e baixa — a metade "buscar" do pull, separada da
// metade "aplicar".
//
// Até aqui as duas eram a mesma função: `pullSingleWorkspace` baixava e
// substituía a árvore numa tacada, então não havia instante em que o remoto
// existisse sem já ter sobrescrito o local. Comparar as duas versões, ou
// escolher o que aceitar, exige exatamente esse instante.
//
// Devolve também os paths, porque quem aplica precisa deles pra manter o
// painel de sync coerente — e quem só compara simplesmente ignora.
/**
 * Lê o catálogo de marcadores do workspace no repositório.
 *
 * Ausência do arquivo é o caso normal, não erro: todo workspace criado antes
 * desta feature — e todo workspace sem nenhum marcador — simplesmente não o
 * tem. Qualquer falha devolve `null`, que o chamador lê como "não há nada
 * remoto", e nunca como "o catálogo remoto é vazio" (que apagaria o local).
 */
async function fetchRemoteMarkers(
  storage: GitHubStorageClient,
  remotePath: string,
  ref?: string
): Promise<Marker[] | null> {
  try {
    return await fetchRemoteMarkersStrict(storage, remotePath, ref);
  } catch {
    return null;
  }
}

/**
 * Igual, mas FALHA quando o arquivo existe e não deu pra ler (rede, senha,
 * conteúdo estragado) — `null` só quando não existe. É a que o PUSH usa: com
 * a leitura falhando, ele gravava só o catálogo daqui (sem checagem de
 * versão) e apagava do GitHub os marcadores dos colegas.
 */
async function fetchRemoteMarkersStrict(
  storage: GitHubStorageClient,
  remotePath: string,
  ref?: string
): Promise<Marker[] | null> {
  const file = await storage.getFile(markersFilePath(remotePath), ref);
  if (!file) return null;
  let content = file.content;
  if (typeof content === "string") content = JSON.parse(content);
  const list = Array.isArray(content) ? content : (content as { markers?: unknown })?.markers;
  if (!Array.isArray(list)) throw new Error("Unexpected content in the markers file on GitHub");
  // Valida entrada a entrada: o arquivo é editável à mão no repositório, e
  // um marcador sem id derrubaria o Map do catálogo inteiro.
  return list.filter(
    (m): m is Marker =>
      !!m &&
      typeof (m as Marker).id === "string" &&
      typeof (m as Marker).name === "string" &&
      typeof (m as Marker).color === "string"
  );
}

/**
 * O catálogo a gravar num push e a base que ele deixa — ou `null` quando o
 * de lá não pôde ser lido: aí o catálogo fica fora do push (o resto sobe).
 */
async function markersForPush(
  storage: GitHubStorageClient,
  remotePath: string,
  workspaceName: string,
  local: Marker[]
): Promise<{ send: Marker[]; base: Record<string, string>; remapped: Map<string, string> } | null> {
  let remote: Marker[] | null;
  try {
    remote = await fetchRemoteMarkersStrict(storage, remotePath);
  } catch (e) {
    console.log("Could not read the markers catalog on GitHub — leaving it out of this push:", e);
    return null;
  }
  const previous = await loadSyncBase(workspaceName);
  // Marcador daqui com o mesmo nome de um de lá (outro id): vale o id de lá,
  // e quem envia troca o id nas marcas da árvore (remapped) antes de gravar.
  const { catalog: mine, remapped } = withRemoteTwins(local, remote);
  const send = catalogForPush(mine, remote, previous);
  return { send, base: markerBaseAfterPush(mine, send, previous), remapped };
}

async function fetchRemoteWorkspace(
  storage: GitHubStorageClient,
  workspaceName: string,
  ref?: string,
  opts?: { peek?: boolean }
): Promise<RemoteWorkspaceData> {
  const peek = opts?.peek === true;
  const wsRemotePath = `${WORKSPACES_ROOT}/${workspaceName}`;
  const listed = await storage.resolveWorkspaceFilePaths(wsRemotePath, ref);
  // Prévia logo depois de um envio daqui: arquivos criados ou apagados por
  // ele entram (ou saem) mesmo que a listagem ainda não os mostre.
  const { collectionPaths, envPaths } = !ref && peek ? withRecentWrites(storage.repoKey, wsRemotePath, listed) : listed;

  const [{ collections, environments, failedPaths, shas, idsByPath, superseded }, markers] = await Promise.all([
    downloadWorkspaceFilesData(storage, collectionPaths, envPaths, ref, peek),
    fetchRemoteMarkers(storage, wsRemotePath, ref),
  ]);

  if (!ref && peek) lastPeeked.set(`${storage.repoKey}|${workspaceName}`, { wsRemotePath, shas, idsByPath, superseded });
  else if (!ref) rememberFetched(storage, workspaceName, { wsRemotePath, shas, idsByPath, superseded });
  return {
    collections, environments, collectionPaths, envPaths, failedPaths, shas, idsByPath, markers,
    supersededPaths: Object.keys(superseded),
  };
}

// Aviso em segundo plano (GitHubSync): de quanto em quanto tempo relê a
// listagem do GitHub, e o intervalo mínimo entre duas leituras (voltar pra
// janela várias vezes seguidas não dispara uma leitura por vez).
const WATCH_INTERVAL_MS = 3 * 60 * 1000;
const WATCH_MIN_GAP_MS = 60 * 1000;

// Versão de cada arquivo já avisada — pra o mesmo aviso não voltar a cada
// abertura do app enquanto ninguém faz o pull.
const NOTIFIED_KEY = "devflow_remote_notified";
const NOTIFIED_DELETED = "deleted";

function loadNotified(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Só os mais recentes: a lista cresce a cada arquivo avisado, de todo repo
// e workspace, e mora no localStorage (cota compartilhada com o resto).
const NOTIFIED_MAX = 300;

function saveNotified(seen: Record<string, string>): void {
  try {
    const entries = Object.entries(seen);
    const kept = entries.length > NOTIFIED_MAX ? Object.fromEntries(entries.slice(-NOTIFIED_MAX)) : seen;
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(kept));
  } catch {
    /* sem storage: no pior caso o aviso se repete */
  }
}

const GitHubSync = forwardRef<GitHubSyncHandle, GitHubSyncProps>(function GitHubSync({
  workspace,
  currentCollections,
  currentEnvironments,
  onPullCollections,
  onPullEnvironments,
  onImportWorkspace,
  onSyncStatusChange, // ✅ novo
  onPullWorkspaceData, // ✅ novo — pull de todos os workspaces
  hasUnsyncedChanges, // ✅ novo — avisa antes de sobrescrever com Pull
  hasPendingPush,
  pendingPushSummary,
  onPullWithReview,
  onReviewSnapshot,
  onConflictPreview,
  onShowConflictHistory,
  currentMarkers,
  onPullMarkers,
  onRemoteWorkspaceDeleted,
}, ref) {
  // Sem repositório padrão: dono e repositório vêm só do que a pessoa
  // configurou. Vazios, o sync fica desligado (isConfigValid).
  const [config, setConfig] = useState<GitHubConfig>({
    token: "",
    owner: "",
    repo: "",
    branch: "main",
  });
  const [configDraft, setConfigDraft] = useState<GitHubConfig>(config);
  const configDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Lido no showStatus, que roda no fim de um push começado num render
  // anterior: o isOpen daquele render pode já não valer (abriu ou fechou o
  // painel no meio do envio).
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const [loading, setLoading] = useState(false);
  // Separado de `loading` de propósito: `loading` aciona o overlay
  // fullscreen (isBlocking) usado pelas operações de workspace inteiro
  // (push/pull de tudo), que realmente precisam travar a tela porque
  // substituem o estado local inteiro. Salvar UM environment ou baixar UM
  // workspace são operações pontuais — não devem congelar a tela inteira,
  // só impedir que outra operação pontual comece em cima (evitar corrida
  // gravando/lendo os mesmos arquivos remotos ao mesmo tempo).
  // Guarda o RÓTULO da operação pontual em curso (null = nenhuma). Antes era
  // só um booleano, que servia pra barrar operações simultâneas mas não
  // aparecia em lugar nenhum: o pull de um workspace disparado pelo menu de
  // workspaces rodava totalmente mudo, porque o `showStatus` dele só é
  // desenhado dentro do popover do GitHub Sync — que está fechado nessa hora.
  const [singleOp, setSingleOp] = useState<string | null>(null);
  const singleOpBusy = singleOp !== null;
  // A trava de uma operação de sync por vez (push, pull, rename, exclusão)
  // é a de lib/sync/syncLock — a MESMA do AppLayout, pra um pull não rodar
  // no meio de um push.
  const [status, setStatus] = useState<SyncStatus>({ type: null, message: "" });
  const [showToken, setShowToken] = useState(false);
  const [collectionPaths, setCollectionPaths] = useState<string[]>([]);
  const [envPaths, setEnvPaths] = useState<string[]>([]);
  // sha de cada collection/environment na listagem mais recente da pasta do
  // workspace. `null` = a listagem não veio (erro, ou pasta vazia): sem ela
  // não dá pra contar o que mudou lá, e contar errado é pior que não contar.
  const [remoteShas, setRemoteShas] = useState<FileShas | null>(null);
  // Versão de cada arquivo na última sincronização desta máquina.
  const [syncedShas, setSyncedShas] = useState<FileShas>({});
  const [resolvingFiles, setResolvingFiles] = useState(false);
  // Senha que deriva a chave de criptografia do conteúdo sincronizado. Vazia
  // significa que o usuário ainda não definiu uma: dá pra LER repositórios no
  // formato antigo, mas não dá pra gravar.
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSecret(GH_PASSPHRASE_KEY)
      .then(value => setPassphrase(value ?? ''))
      .catch(() => setPassphrase(''));
  }, []);

  const remotePath = workspace ? `${WORKSPACES_ROOT}/${workspace}` : "";

  const saveConfig = async (newConfig: GitHubConfig) => {
    setConfig(newConfig);
    const { token, ...rest } = newConfig;
    await storeSet("gh_sync_config", rest);
    if (token) {
      await saveSecret(GH_TOKEN_KEY, token);
    } else {
      await deleteSecret(GH_TOKEN_KEY);
    }
  };

  const client = useCallback(
    (options?: { force?: boolean }) => new GitHubStorageClient(config, passphrase || null, options),
    [config, passphrase]
  );

  // Trocar a senha invalida a chave derivada guardada em memória, senão a
  // próxima gravação ainda usaria a chave antiga.
  const savePassphrase = useCallback(async (value: string) => {
    const trimmed = value.trim();
    clearDerivedKeyCache();
    if (trimmed) await saveSecret(GH_PASSPHRASE_KEY, trimmed);
    else await deleteSecret(GH_PASSPHRASE_KEY);
    setPassphrase(trimmed);
  }, []);

  const AUTH_ERROR_MESSAGE = "Your GitHub token is invalid or has expired. Update it in GitHub Sync settings to keep syncing.";

  const showStatus = (type: SyncStatus["type"], message: string) => {
    const isAuth = type === "error" && /HTTP 401\b/.test(message);
    // As mensagens vinham com ✓/✗/⚠ escritos à mão, cada uma de um jeito (e
    // muitas sem nenhum). O ícone agora sai do TIPO, no quadro de status —
    // aqui só se tira o que tiver sido escrito no texto.
    const finalMessage = (isAuth ? AUTH_ERROR_MESSAGE : message).replace(/^\s*(✓|✗|⚠️?|❌)\s*/u, "");

    setStatus({ type, message: finalMessage });
    // A Central de Sincronização dispara push e pull com este painel
    // fechado: o que ele diria aqui volta no resultado da ação dela.
    if (type) reportSyncStatus(type, finalMessage);
    // Fora da Central e com este painel fechado (a revisão que reenvia
    // depois da mescla, uma chamada de fora), o erro só existiria aqui —
    // invisível. Vira toast. Na Central ele já aparece na faixa dela.
    if (type === "error" && !isAuth && !isOpenRef.current && !isCapturingSyncStatus()) {
      toast.error(finalMessage, {
        duration: 10000,
        action: { label: "Open Sync", onClick: () => openSyncCenter() },
      });
    }
    if (type === "success" || type === "info") {
      setTimeout(() => setStatus({ type: null, message: "" }), 5000);
    }

    // Push silencioso (Ctrl+S) roda com o popover de sync fechado — sem
    // isso, um token expirado falhava em silêncio (só um erro no console).
    // O toast garante que o usuário veja o aviso mesmo sem abrir o painel.
    if (isAuth) {
      toast.error(AUTH_ERROR_MESSAGE, {
        duration: 10000,
        action: {
          label: "Open settings",
          onClick: () => setIsOpen(true),
        },
      });
    }
  };

const isConfigValid = Boolean(
  config.token && config.owner && config.repo && config.branch
);

// Sem senha de sync não dá pra cifrar nada — checa ANTES de qualquer
// chamada ao GitHub. Antes o push consultava o repositório, só então o
// encryptData estourava MissingPassphraseError, e isso ia pro console como
// erro (tela de erro do Next em dev) — e, disparado pelo menu de
// workspaces, o aviso ficava dentro do painel de sync fechado.
const PASSPHRASE_MISSING_MESSAGE = "Set a sync passphrase in GitHub Sync settings before pushing.";
const requirePassphrase = (): boolean => {
  if (passphrase) return true;
  setStatus({ type: "error", message: `✗ ${PASSPHRASE_MISSING_MESSAGE}` });
  reportSyncStatus("error", PASSPHRASE_MISSING_MESSAGE);
  toast.error(PASSPHRASE_MISSING_MESSAGE, {
    id: "missing-sync-passphrase",
    duration: 10000,
    action: {
      label: "Open settings",
      onClick: () => setIsOpen(true),
    },
  });
  return false;
};

// O workspace e a pasta ficam guardados com a confirmação: trocar de
// workspace com ela aberta não pode mudar o que é apagado (nem o nome na
// mensagem, nem a listagem que é zerada no fim).
const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<
  { files: RepoItem[]; workspace: string; remotePath: string } | null
>(null);
const [deletingWorkspace, setDeletingWorkspace] = useState(false);

// ✅ mover pra cá, depois de isConfigValid
const [remoteWorkspaces, setRemoteWorkspaces] = useState<RepoItem[] | null>(null);
const [loadingRemoteWorkspaces, setLoadingRemoteWorkspaces] = useState(false);
const [importingName, setImportingName] = useState<string | null>(null);

const handleRequestDeleteRemoteWorkspace = useCallback(async () => {
  if (!isConfigValid || !remotePath) return;

  setDeletingWorkspace(true);
  try {
    const files = await client().listAllFilesRecursive(remotePath);
    if (files.length === 0) {
      showStatus("info", "No files found in this remote workspace — nothing to delete.");
      setDeletingWorkspace(false);
      return;
    }
    setPendingDeleteWorkspace({ files, workspace, remotePath });
  } catch (e: any) {
    console.error("❌ Erro ao listar arquivos para exclusão:", e);
    showStatus("error", `✗ Failed to check files: ${e.message}`);
  } finally {
    setDeletingWorkspace(false);
  }
}, [isConfigValid, remotePath, client, workspace]);

const handleConfirmDeleteRemoteWorkspace = useCallback(async () => {
  if (!pendingDeleteWorkspace) return;
  const target = pendingDeleteWorkspace;
  const lock = acquireSyncLock("delete workspace");
  if (!lock) {
    showStatus("error", SYNC_BUSY_MESSAGE);
    return;
  }

  setDeletingWorkspace(true);
  showStatus("info", "Deleting workspace from GitHub...");
  try {
    // Um commit só, e sem checagem de versão: a pessoa confirmou apagar a
    // pasta inteira, seja qual for a versão que está lá.
    const storage = client();
    // A lista de AGORA, não a de quando a confirmação abriu: um arquivo que
    // alguém enviou no meio ficava lá, a pasta continuava existindo e o
    // "Pull de todos" recriava o workspace.
    const files = await storage.listAllFilesRecursive(target.remotePath);
    if (files.length > 0) {
      await storage.commitFiles(
        files.map((file) => ({ path: file.path, delete: true, noCheck: true })),
        `sync: remove workspace "${target.workspace}"`
      );
    }
    setPendingDeleteWorkspace(null);
    if (target.workspace === workspace) {
      setCollectionPaths([]);
      setEnvPaths([]);
    }
    // O registro do que estava sincronizado sai junto: o GitHub não tem mais
    // nada desse workspace.
    const prefix = `${target.remotePath}/`;
    const synced = await loadSyncedShas(storage.repoKey);
    const gone: Record<string, null> = {};
    for (const path of Object.keys(synced)) if (path.startsWith(prefix)) gone[path] = null;
    await recordSyncedShas(storage.repoKey, gone);
    await onRemoteWorkspaceDeleted?.(target.workspace);
    showStatus("success", `Workspace "${target.workspace}" removed from GitHub.`);
  } catch (e: any) {
    console.error("❌ Erro ao excluir workspace remoto:", e);
    showStatus("error", `✗ Delete failed: ${e.message}`);
  } finally {
    releaseSyncLock(lock);
    setDeletingWorkspace(false);
  }
}, [pendingDeleteWorkspace, client, workspace, onRemoteWorkspaceDeleted]);

const handleListRemoteWorkspaces = useCallback(async () => {
  if (!isConfigValid) return;
  setLoadingRemoteWorkspaces(true);
  try {
    const folders = await client().listFolders(WORKSPACES_ROOT);
    setRemoteWorkspaces(folders);
    if (folders.length === 0) {
      showStatus("info", `No workspace found under "${WORKSPACES_ROOT}/" in this repository.`);
    }
  } catch (e: any) {
    console.error("❌ Erro ao listar workspaces remotos:", e);
    showStatus("error", `✗ Failed to list workspaces: ${e.message}`);
    setRemoteWorkspaces(null);
  } finally {
    setLoadingRemoteWorkspaces(false);
  }
}, [isConfigValid, client]);

const handleImportClick = useCallback(async (name: string) => {
  setImportingName(name);
  try {
    await onImportWorkspace(name);
    showStatus("success", `✓ Workspace "${name}" ready — use Pull to download the data.`);
  } catch (e: any) {
    showStatus("error", `✗ Failed to import workspace: ${e.message}`);
  } finally {
    setImportingName(null);
  }
}, [onImportWorkspace]);

useEffect(() => {
  setRemoteWorkspaces(null);
}, [config.owner, config.repo, config.branch]);

  const canSync = isConfigValid && !!workspace;

  // Sobe a cada versão registrada como "o que está no GitHub agora" (push,
  // pull, revisão) — a listagem compara antes de gravar o resultado.
  const shaGenerationRef = useRef(0);

  // De qual workspace (e repositório) são os paths guardados. Ao trocar, a
  // lista do anterior sai NA HORA: antes ela ficava até a listagem nova
  // chegar — e pra sempre, se a listagem falhasse —, e o push de uma
  // collection ou environment a usava pra propor apagar "arquivos que você
  // removeu aqui", que eram de OUTRO workspace.
  const listingKey = `${repoKeyOf(config)}|${remotePath}`;
  const listingKeyRef = useRef(listingKey);
  // Antes do efeito que relista (declarado abaixo): roda primeiro.
  useEffect(() => {
    listingKeyRef.current = listingKey;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- descarta a lista de outro workspace/repositório ao trocar
    setCollectionPaths([]);
    setEnvPaths([]);
    setRemoteShas(null);
  }, [listingKey]);

  // ── Resolve os arquivos remotos do workspace atual sempre que o
  //    workspace (prop, controlado pelo AppLayout) ou a config mudam.
  // `quiet`: atualização de fundo (ao abrir o painel) — sem o overlay que
  // trava a tela e sem mensagem de erro; serve só pro contador.
  const resolveWorkspaceFiles = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = opts?.quiet === true;
    if (!isConfigValid || !remotePath) {
      setCollectionPaths([]);
      setEnvPaths([]);
      setRemoteShas(null);
      return;
    }

    // Uma listagem que começou antes de um push e chega depois dele traz o
    // sha ANTIGO do arquivo que acabou de subir — gravá-la fazia o aviso
    // dizer "X changed on GitHub" sobre o seu próprio push.
    const generation = shaGenerationRef.current;
    const listingKey = listingKeyRef.current;
    if (!quiet) setResolvingFiles(true);
    try {
      // Estrita (falha em vez de devolver []): com a pasta environments
      // vazia por um erro de rede, todo environment aparecia como "removido
      // no GitHub" no aviso e no contador. Na falha fica o que se sabia.
      // Numa chamada só (a árvore do repositório; ver workspaceListing) — e
      // com a leitura condicional, a checagem de fundo a cada 3 minutos não
      // gasta a cota do GitHub quando nada mudou.
      const listing = await client().workspaceListing(remotePath);

      // Um push/pull registrou versões no meio: esta listagem já nasceu velha.
      // A próxima checagem (ou a abertura do painel) traz a atual.
      if (shaGenerationRef.current !== generation) return;
      // Trocou de workspace (ou de repositório) no meio: é a listagem do
      // anterior, e gravá-la punha os arquivos dele no lugar dos deste.
      if (listingKeyRef.current !== listingKey) return;
      setCollectionPaths(listing.collectionPaths);
      setEnvPaths(listing.envPaths);
      // Pasta do workspace que não existe lá (404): nada pra comparar.
      setRemoteShas(listing.exists ? listing.shas : null);
    } catch (e: any) {
      console.error("❌ Erro ao resolver arquivos do workspace:", e);
      if (!quiet) showStatus("error", `✗ Failed to fetch files: ${e.message}`);
    } finally {
      if (!quiet) setResolvingFiles(false);
    }
  }, [isConfigValid, remotePath, client]);

  useEffect(() => {
    resolveWorkspaceFiles();
  }, [resolveWorkspaceFiles]);

  // Abrir o painel relê a listagem (só os shas, sem baixar conteúdo): é o
  // que mantém o "mudou no GitHub" atual sem ficar consultando sozinho.
  useEffect(() => {
    if (isOpen) void resolveWorkspaceFiles({ quiet: true });
  }, [isOpen, resolveWorkspaceFiles]);

  // Versões sincronizadas: carrega as do repositório atual e acompanha o que
  // pushes, pulls e revisões registram (lib/remoteVersions).
  const repoKey = repoKeyOf(config);
  useEffect(() => {
    let alive = true;
    loadSyncedShas(repoKey).then((v) => { if (alive) setSyncedShas({ ...v }); });
    const unsubscribe = subscribeSyncedShas((key, changes, remoteToo) => {
      if (key !== repoKey) return;
      // Invalida a listagem em voo (ver resolveWorkspaceFiles).
      if (remoteToo) shaGenerationRef.current++;
      setSyncedShas((prev) => applyShaChanges(prev, changes));
      // Push e pull também dizem o que está no GitHub agora — sem isso, o
      // arquivo que acabou de subir pareceria "mudado lá" até reabrir o painel.
      if (remoteToo && remotePath) {
        const mine = Object.fromEntries(
          Object.entries(changes).filter(([path]) => isTrackedPath(remotePath, path))
        );
        if (Object.keys(mine).length > 0) {
          setRemoteShas((prev) => applyShaChanges(prev ?? {}, mine));
        }
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [repoKey, remotePath]);

  const lastChangeOf = useCallback(async (workspaceName: string, rootId: string): Promise<CommitInfo | null> => {
    const storage = client();
    const fetched = knownVersions(storage, workspaceName);
    if (!fetched) return null;
    const path = Object.keys(fetched.idsByPath).find((p) => fetched.idsByPath[p].includes(rootId));
    if (!path) return null;
    const key = `${storage.repoKey}|${path}@${fetched.shas[path] ?? ""}`;
    if (lastCommitCache.has(key)) return lastCommitCache.get(key) ?? null;
    try {
      const [latest] = await storage.listCommits(path, 1);
      lastCommitCache.set(key, latest ?? null);
      return latest ?? null;
    } catch {
      // Sem cache em falha: a próxima tentativa pode dar certo.
      return null;
    }
  }, [client]);

  // Versão da última sincronização do arquivo de uma collection raiz — a
  // "terceira coluna" da revisão (o que cada lado mudou). Guardada por sha:
  // uma versão de arquivo não muda.
  const syncedVersionOf = useCallback(async (workspaceName: string, rootId: string): Promise<unknown | null> => {
    const storage = client();
    const fetched = knownVersions(storage, workspaceName);
    if (!fetched) return null;
    const path = Object.keys(fetched.idsByPath).find((p) => fetched.idsByPath[p].includes(rootId));
    if (!path) return null;
    const sha = (await loadSyncedShas(storage.repoKey))[path];
    if (!sha) return null;
    const key = `${storage.repoKey}|${sha}`;
    let pending = syncedVersionCache.get(key);
    if (!pending) {
      pending = storage.readBlob(sha).catch(() => null);
      syncedVersionCache.set(key, pending);
    }
    return pending;
  }, [client]);

  // ── Aviso em segundo plano: alguém mudou o workspace no GitHub ─────────
  // A cada poucos minutos (e ao voltar pra janela) relê só a LISTAGEM do
  // workspace — os shas, sem baixar conteúdo — e, se um arquivo mudou desde
  // a última sincronização desta máquina, avisa o quê e quem mudou, com o
  // Pull a um clique. Antes isso só aparecia no contador do painel, e só
  // quando alguém abria o painel.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = loading || !!singleOp;
  }, [loading, singleOp]);
  const lastWatchRef = useRef(0);
  useEffect(() => {
    if (!canSync) return;
    const tick = () => {
      // Durante um push/pull nosso, a listagem já mostra o commit novo antes
      // de ele ser registrado como sincronizado — o aviso seria sobre nós.
      // A trava cobre também o que roda fora deste painel (o push e o
      // Aplicar da revisão, no AppLayout).
      if (document.visibilityState !== "visible" || busyRef.current || syncLockHolder()) return;
      if (Date.now() - lastWatchRef.current < WATCH_MIN_GAP_MS) return;
      lastWatchRef.current = Date.now();
      void resolveWorkspaceFiles({ quiet: true });
    };
    const timer = window.setInterval(tick, WATCH_INTERVAL_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [canSync, resolveWorkspaceFiles]);

  useEffect(() => {
    if (!remoteShas || !remotePath || busyRef.current || syncLockHolder()) return;
    const { changed, added, deleted } = behindPaths(
      remoteShas,
      syncedShas,
      `${remotePath}/`,
      (p) => isTrackedPath(remotePath, p)
    );
    // Uma vez por versão de arquivo — guardado, pra não repetir a cada
    // abertura do app enquanto ninguém faz o pull.
    const seen = loadNotified();
    const fresh = [...changed, ...added].filter((p) => seen[p] !== remoteShas[p]);
    const gone = deleted.filter((p) => seen[p] !== NOTIFIED_DELETED);
    if (fresh.length + gone.length === 0) return;
    // delete antes de gravar: move a chave pro FIM do objeto. saveNotified
    // guarda só as NOTIFIED_MAX últimas pela ordem de inserção, e atualizar
    // no lugar deixava um arquivo antigo, recém-avisado, cair no corte — o
    // próximo ciclo o via como novo e repetia o aviso.
    for (const p of fresh) {
      delete seen[p];
      seen[p] = remoteShas[p];
    }
    for (const p of gone) {
      delete seen[p];
      seen[p] = NOTIFIED_DELETED;
    }
    saveNotified(seen);

    const collections: any[] = Array.isArray(currentCollections) ? currentCollections : [];
    const environments: any[] = Array.isArray(currentEnvironments) ? currentEnvironments : [];
    const labelOf = (path: string): { name: string; id?: string } => {
      const col = collections.find((c) => c?.id && collectionFilePath(remotePath, c) === path);
      if (col) return { name: col.name, id: col.id };
      const env = environments.find((e) => e?.id && environmentFilePath(remotePath, e) === path);
      if (env) return { name: env.name, id: env.id };
      const file = path.split("/").pop() ?? path;
      return { name: file.replace(/\.postman_(collection|environment)\.json$/i, "") };
    };
    const storage = client();
    void (async () => {
      // Quem mudou, quando e com que mensagem: o último commit de cada
      // arquivo (até 5, pra não gastar chamadas de API com uma leva grande).
      const entries = await Promise.all(
        fresh.slice(0, 5).map(async (path) => {
          let author = "";
          let date = "";
          let message = "";
          try {
            const [latest] = await storage.listCommits(path, 1);
            author = latest?.authorName ?? "";
            date = latest?.date ?? "";
            message = latest?.message ?? "";
          } catch {
            /* sem autor, o aviso continua útil */
          }
          return { ...labelOf(path), author, date, message };
        })
      );
      const total = fresh.length + gone.length;
      // O merge "de teste" (nada é aplicado): quais itens vêm do GitHub, com
      // o antes/depois de cada campo pra prévia, e se algum vai dar conflito
      // com o que você ainda não enviou — antes de descobrir no push. Roda
      // sempre, não só quando há pendência sua: a prévia é o que diz O QUE
      // o colega mudou.
      let check: Awaited<ReturnType<NonNullable<typeof onConflictPreview>>> = null;
      if (onConflictPreview) {
        try {
          const changedRootIds = fresh
            .map((p) => collections.find((c) => c?.id && collectionFilePath(remotePath, c) === p)?.id as string | undefined)
            .filter((id): id is string => !!id);
          check = await onConflictPreview(workspace, changedRootIds);
        } catch {
          check = null;
        }
      }
      const commits: RemoteCommitInfo[] = [
        ...entries.map((e) => ({ name: e.name, author: e.author, date: e.date, message: e.message })),
        ...gone.slice(0, Math.max(0, 5 - entries.length)).map((p) => ({ name: labelOf(p).name, author: "", date: "", message: "", removed: true })),
      ];
      const conflicts = check?.preview?.conflicts.length ?? check?.conflicts.length ?? 0;
      // A prévia pode faltar (workspace não aberto, falha ao ler): o aviso
      // ainda diz quem mudou o quê, por arquivo.
      const preview: RemoteChangePreview | null =
        check?.preview ?? (check ? { conflicts: check.conflicts, incoming: check.incoming, items: [], environments: [] } : null);
      toast.custom(
        (id) => (
          <RemoteChangeToast
            workspace={workspace}
            commits={commits}
            otherFiles={Math.max(0, total - commits.length)}
            preview={preview}
            onPull={onPullWithReview ? () => void onPullWithReview() : undefined}
            onDismiss={() => toast.dismiss(id)}
          />
        ),
        // Com prévia aberta a pessoa lê; o sonner já pausa no hover.
        // id por workspace: um aviso novo do mesmo workspace SUBSTITUI o que
        // está na tela em vez de empilhar outro card igual por cima (a prévia
        // é do workspace inteiro, então o mais novo já contém o anterior).
        { id: `remote-change:${workspace}`, duration: conflicts > 0 ? 60000 : 30000 }
      );
    })();
  }, [
    remoteShas,
    syncedShas,
    remotePath,
    client,
    workspace,
    currentCollections,
    currentEnvironments,
    onPullWithReview,
    onConflictPreview,
  ]);

  const markReviewed = useCallback(async (workspaceName: string, scope: ReviewScope) => {
    const storage = client();
    const fetched = lastFetched.get(`${storage.repoKey}|${workspaceName}`);
    if (!fetched) return;
    const { wsRemotePath, shas, idsByPath } = fetched;
    const inScope = (path: string) => {
      if (!isTrackedPath(wsRemotePath, path)) return false;
      const env = isEnvironmentPath(wsRemotePath, path);
      if (scope === "environments") return env;
      if (env) return false;
      if (scope === "collections") return true;
      return (idsByPath[path] ?? []).some((id) => scope.rootIds.includes(id));
    };
    const seen = Object.fromEntries(Object.entries(shas).filter(([path]) => inScope(path)));
    // Arquivo que sumiu só conta como visto numa revisão do escopo INTEIRO:
    // na de uma collection, a ausência de outro arquivo não diz nada.
    const changes = scope === "collections" || scope === "environments"
      ? workspaceShaChanges(seen, await loadSyncedShas(storage.repoKey), inScope)
      : seen;
    await recordSyncedShas(storage.repoKey, changes);
  }, [client]);

  const performPull = useCallback(
    async (cPaths: string[], ePaths: string[]) => {
      if (cPaths.length === 0 && ePaths.length === 0) {
        showStatus("info", "Workspace empty on GitHub — nothing to download.");
        return;
      }

      // Um sync por vez (lib/sync/syncLock).
      const lock = acquireSyncLock("pull");
      if (!lock) {
        showStatus("error", SYNC_BUSY_MESSAGE);
        return;
      }
      setLoading(true);
      showStatus("info", `Downloading and decrypting files...`);

      // Cada path é baixado individualmente e com allSettled — assim, se UM
      // arquivo falhar (rede, parse, arquivo grande, etc.) os outros ainda
      // são baixados normalmente, e a gente avisa quais falharam em vez de
      // descartar tudo em silêncio (era isso que fazia o Pull "esquecer"
      // collections sem nenhum erro visível).
      const failedPaths: string[] = [];
      const pulledShas: FileShas = {};
      let collectionsToApply: any[] = [];
      // null = o workspace não tem environments lá: os daqui ficam como estão.
      let environmentsToApply: any[] | null = null;

      try {
        const storage = client();

        if (cPaths.length > 0) {
          const collectionSettled = await Promise.allSettled(cPaths.map((p) => storage.getFile(p)));
          const loadedCollections = collectionSettled
            .map((settled, i) => {
              if (settled.status === "rejected") {
                console.error(`❌ Falha ao baixar ${cPaths[i]}:`, settled.reason);
                failedPaths.push(cPaths[i]);
                return null;
              }
              if (!settled.value || !settled.value.content) {
                failedPaths.push(cPaths[i]);
                return null;
              }
              if (settled.value.sha) pulledShas[cPaths[i]] = settled.value.sha;
              return settled.value.content;
            })
            .filter((content) => content !== null)
            .flat();

          collectionsToApply = loadedCollections;
        }

        if (ePaths.length > 0) {
          const envSettled = await Promise.allSettled(ePaths.map((p) => storage.getFile(p)));
          const loadedEnvironments = envSettled
            .map((settled, i) => {
              if (settled.status === "rejected") {
                console.error(`❌ Falha ao baixar ${ePaths[i]}:`, settled.reason);
                failedPaths.push(ePaths[i]);
                return null;
              }
              if (!settled.value || !settled.value.content) {
                failedPaths.push(ePaths[i]);
                return null;
              }
              if (settled.value.sha) pulledShas[ePaths[i]] = settled.value.sha;
              let content = settled.value.content;
              if (typeof content === "string") {
                try { content = JSON.parse(content); } catch (e) {}
              }
              // Sem id, todos colapsavam numa chave só (ver withEnvironmentIds).
              return withEnvironmentIds(Array.isArray(content) ? content : [content], ePaths[i]);
            })
            .filter((content) => content !== null)
            .flat();

          environmentsToApply = Array.from(
            new Map(loadedEnvironments.map((env: any) => [env.id, env])).values()
          );
        }

        // Tudo ou nada: aplicar com um arquivo faltando substituía o local
        // SEM aquela collection (ou zerava os environments, quando todos
        // falhavam) — o pull apagava o que não conseguiu ler.
        if (failedPaths.length > 0) {
          showStatus(
            "error",
            `Pull cancelled — ${failedPaths.length} file(s) could not be downloaded: ${failedPaths.map((p) => p.split("/").pop()).join(", ")}. Nothing was changed here.`
          );
          return;
        }

        if (collectionsToApply.length > 0) await onPullCollections(collectionsToApply);

        // O catálogo vem junto com as collections, não depois: os ids de
        // marcador que acabaram de chegar nos nós precisam existir no
        // catálogo, senão viram marca invisível até o próximo pull.
        if (onPullMarkers) {
          const remoteMarkers = await fetchRemoteMarkers(storage, remotePath);
          if (remoteMarkers) await onPullMarkers(workspace, remoteMarkers);
        }

        if (environmentsToApply) onPullEnvironments(environmentsToApply);

        await recordPulledWorkspace(storage, remotePath, pulledShas);
        showStatus("success", "Data updated and decrypted.");
      } catch (e: any) {
        console.error("❌ Erro durante o performPull:", e);
        showStatus("error", `✗ Pull failed: ${e.message}`);
      } finally {
        releaseSyncLock(lock);
        setLoading(false);
      }
    },
    // remotePath e workspace também: sem eles, depois de trocar de workspace o
    // Pull gravava os shas filtrando pelo workspace ANTERIOR (zerando o
    // "sincronizado" dele e sem registrar o novo) e mesclava o catálogo dele.
    [client, onPullCollections, onPullEnvironments, onPullMarkers, remotePath, workspace]
  );

  const [pendingDelete, setPendingDelete] = useState<{ paths: string[] } | null>(null);
  const deleteConfirmResolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  function askDeleteConfirmation(paths: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      // Um diálogo anterior ainda aberto (não deveria, com a trava acima):
      // responde "manter" a ele em vez de deixá-lo pendurado pra sempre.
      deleteConfirmResolveRef.current?.(false);
      deleteConfirmResolveRef.current = resolve;
      setPendingDelete({ paths });
    });
  }

  function resolvePendingDelete(confirmed: boolean) {
    deleteConfirmResolveRef.current?.(confirmed);
    deleteConfirmResolveRef.current = null;
    setPendingDelete(null);
  }


  // ── Histórico de commits de um workspace ────────────────────────────────
  // Janela aberta pelo ícone de relógio no menu de workspaces: lista os
  // commits que tocaram a pasta daquele workspace no GitHub e deixa baixar
  // o estado dos arquivos em qualquer um deles (não só o mais recente).
  const [commitHistoryWorkspace, setCommitHistoryWorkspace] = useState<string | null>(null);
  const [commitList, setCommitList] = useState<CommitInfo[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(null);
  const [restoringCommit, setRestoringCommit] = useState(false);
  // O que cada commit mudou (painel "Changes"), por SHA — calcular custa
  // baixar e descriptografar duas versões de cada arquivo, então guarda.
  const [commitChanges, setCommitChanges] = useState<
    Record<string, { loading: boolean; error: string | null; files: FileChange[] | null }>
  >({});

  // O Pull de UM workspace (menu de workspaces) saiu: receber é pela Central
  // de Sincronização, com merge; substituir tudo, em Configurações → Avançado.

  // Abre a janela de histórico e busca os commits daquele workspace.
  const openCommitHistory = useCallback((workspaceName: string) => {
    setCommitHistoryWorkspace(workspaceName);
    setSelectedCommitSha(null);
    setCommitChanges({});
    setCommitsError(null);
    setCommitList([]);

    if (!isConfigValid) {
      setCommitsError("Configure GitHub sync before browsing commit history.");
      return;
    }

    setCommitsLoading(true);
    client()
      .listCommits(`${WORKSPACES_ROOT}/${workspaceName}`)
      .then((commits) => {
        setCommitList(commits);
        if (commits.length === 0) {
          setCommitsError(`No commits found for "${workspaceName}" on GitHub.`);
        }
      })
      .catch((e: any) => {
        console.error("❌ Erro ao listar commits:", e);
        setCommitsError(e?.message || "Failed to load commit history.");
      })
      .finally(() => setCommitsLoading(false));
  }, [isConfigValid, client]);

  // Seleciona um commit e calcula o que ele mudou (uma vez por SHA).
  const selectCommit = useCallback((sha: string) => {
    setSelectedCommitSha(sha);
    if (!commitHistoryWorkspace || commitChanges[sha]) return;

    setCommitChanges((prev) => ({ ...prev, [sha]: { loading: true, error: null, files: null } }));
    client()
      .getCommitChanges(sha, `${WORKSPACES_ROOT}/${commitHistoryWorkspace}`)
      .then((files) => {
        setCommitChanges((prev) => ({ ...prev, [sha]: { loading: false, error: null, files } }));
      })
      .catch((e: any) => {
        console.error("❌ Erro ao comparar commit:", e);
        setCommitChanges((prev) => ({
          ...prev,
          [sha]: { loading: false, error: e?.message || "Failed to load the changes of this commit.", files: null },
        }));
      });
  }, [commitHistoryWorkspace, commitChanges, client]);

  const closeCommitHistory = useCallback(() => {
    if (restoringCommit) return;
    setCommitHistoryWorkspace(null);
    setCommitChanges({});
    setCommitList([]);
    setSelectedCommitSha(null);
    setCommitsError(null);
  }, [restoringCommit]);

  // Baixa o estado do workspace EM UM COMMIT específico. Mesma mecânica do
  // pullSingleWorkspace, mas resolvendo paths e conteúdo com `ref` = SHA,
  // então traz os arquivos como estavam naquele ponto do histórico.
  const pullWorkspaceAtCommit = useCallback(async (workspaceName: string, sha: string) => {
    if (!isConfigValid) {
      showStatus("error", "✗ Configure GitHub sync before pulling.");
      return;
    }

    // Um sync por vez (lib/sync/syncLock).
    const lock = acquireSyncLock("pull");
    if (!lock) {
      showStatus("error", SYNC_BUSY_MESSAGE);
      return;
    }
    setRestoringCommit(true);
    showStatus("info", `Downloading "${workspaceName}" at ${sha.slice(0, 7)}...`);

    try {
      const storage = client();
      const wsRemotePath = `${WORKSPACES_ROOT}/${workspaceName}`;
      const { collectionPaths: cPaths, envPaths: ePaths } =
        await storage.resolveWorkspaceFilePaths(wsRemotePath, sha);

      if (cPaths.length === 0 && ePaths.length === 0) {
        showStatus("info", `No files for "${workspaceName}" in commit ${sha.slice(0, 7)}.`);
        return;
      }

      const { collections, environments, failedPaths, shas } =
        await downloadWorkspaceFilesData(storage, cPaths, ePaths, sha);

      // Workspace aberto: revisão em vez de substituir tudo. Nada é marcado
      // como sincronizado — o que voltar vira pendência de push.
      if (workspaceName === workspace && onReviewSnapshot) {
        onReviewSnapshot(workspaceName, collections, environments, sha.slice(0, 7));
        if (failedPaths.length > 0) {
          showStatus("error", `${failedPaths.length} file(s) could not be read from that commit — they are not in the review.`);
        } else {
          showStatus("info", `Pick what to bring back from commit ${sha.slice(0, 7)}.`);
        }
        setCommitHistoryWorkspace(null);
        setCommitList([]);
        setSelectedCommitSha(null);
        return;
      }

      // Mesma regra do pull: restaurar sem um arquivo apagaria aquela collection.
      if (failedPaths.length > 0) {
        showStatus(
          "error",
          `Restore cancelled — ${failedPaths.length} file(s) could not be read from commit ${sha.slice(0, 7)}. Nothing was changed here.`
        );
        return;
      }

      await onPullWorkspaceData?.(workspaceName, collections, environments, { fromCommit: true });
      // Local agora = a versão daquele commit. O que o GitHub tem hoje
      // continua outra coisa (remoteToo: false), e se for diferente o
      // contador mostra — que é exatamente a situação.
      await recordPulledWorkspace(storage, wsRemotePath, shas, { remoteToo: false });

      // O painel de sync guarda os paths do estado ATUAL da branch — os
      // paths daquele commit podem nem existir mais hoje, então só atualiza
      // quando é o workspace ativo, e mesmo assim o próximo push vai
      // recalcular tudo a partir do que está local agora.
      if (workspaceName === workspace) {
        setCollectionPaths(cPaths);
        setEnvPaths(ePaths);
      }

      if (failedPaths.length > 0) {
        showStatus("error", `⚠ ${failedPaths.length} file(s) could not be downloaded from that commit.`);
      } else {
        showStatus(
          "success",
          `✓ "${workspaceName}" restored from commit ${sha.slice(0, 7)} (${collections.length} collection(s), ${environments.length} environment(s))!`
        );
        setCommitHistoryWorkspace(null);
        setCommitList([]);
        setSelectedCommitSha(null);
      }
    } catch (e: any) {
      console.error(`❌ Erro ao baixar commit de "${workspaceName}":`, e);
      showStatus("error", `✗ Pull failed: ${e.message}`);
    } finally {
      releaseSyncLock(lock);
      setRestoringCommit(false);
    }
  }, [isConfigValid, workspace, client, onPullWorkspaceData, onReviewSnapshot, showStatus]);

  // ── Gravação de um push, qualquer alcance (lib/sync/pushPipeline) ───────
  // A decisão do que sobe (mescla com o GitHub, o que entra aqui, a base) é
  // do executor (AppLayout.runPush). Aqui fica só a gravação, igual pra
  // todos os alcances: nomes que colidem → catálogo de marcadores → o que
  // sobrou lá (no workspace inteiro, com confirmação; nos outros, só a
  // renomeação do próprio item) → UM commit com checagem de versão.
  async function commitPush(input: CommitPushInput): Promise<CommitPushResult> {
    if (!isConfigValid) return { status: "error", message: "Configure GitHub sync before pushing." };
    if (!requirePassphrase()) return { status: "error", message: PASSPHRASE_MISSING_MESSAGE };
    // Chamada de dentro do push (runPush), já com a trava dele: segue. Sozinha,
    // pega a própria.
    const ownLock = holdsSyncLock(input.lockToken) ? null : acquireSyncLock("push");
    if (!holdsSyncLock(input.lockToken) && !ownLock) return { status: "busy", message: SYNC_BUSY_MESSAGE };
    const label = input.label ?? input.workspaceName;
    setSingleOp(`Sending "${label}"...`);
    try {
      const storage = client({ force: input.force });
      const { scope } = input;
      const wsRemotePath = `${WORKSPACES_ROOT}/${input.workspaceName}`;
      const allLocal = input.allLocal ?? { collections: input.collections, environments: input.environments };

      // Nomes diferentes que viram o MESMO arquivo ("API's Tests" e "API S
      // Tests"): o GitHub nunca vê isso como conflito, um apagaria o outro.
      // No push de um item só, só conta o grupo que tem o que está subindo.
      const sentIds = new Set([...input.collections.map((c) => c.id), ...input.environments.map((e) => e.id)]);
      const collectionGroups = findNameCollisions(allLocal.collections, (c) => collectionFilePath(wsRemotePath, c));
      const envGroups = findNameCollisions(allLocal.environments, (e) => environmentFilePath(wsRemotePath, e));
      const relevant = <T extends { id: string }>(list: T[][]) =>
        scope.kind === "workspace" ? list : list.filter((g) => g.some((x) => sentIds.has(x.id)));
      const collisions = [
        ...relevant(collectionGroups).map((g) => ({ kind: "collection" as const, names: g.map(collectionNameOf) })),
        ...relevant(envGroups).map((g) => ({ kind: "environment" as const, names: g.map((e) => e.name || "environment") })),
      ];
      if (collisions.length > 0) return { status: "collision", message: collisionMessage(collisions) };

      // Uma collection só: o arquivo de mesmo nome lá é de OUTRA collection
      // (alguém criou uma com esse nome) — gravar por cima apagaria a dela.
      if ((scope.kind === "collection" || scope.kind === "item") && input.collections[0]) {
        const root = input.collections[0];
        const targetPath = collectionFilePath(wsRemotePath, root);
        const idsThere = lastFetched.get(`${storage.repoKey}|${input.workspaceName}`)?.idsByPath[targetPath] ?? [];
        const knownHere = (await removedHere(storage, [targetPath])).length > 0;
        if (idsThere.length > 0 && !idsThere.includes(root.id) && !knownHere) {
          return {
            status: "collision",
            message: `Push cancelled: GitHub already has a different collection named "${collectionNameOf(root)}" (someone else created it). Pull it first, or rename yours.`,
          };
        }
      }

      const existing = await storage.resolveWorkspaceFilePaths(wsRemotePath);
      // Catálogo, árvore e plano saem juntos de UMA leitura do catálogo de lá
      // — e são refeitos se só ele mudar no meio do envio (laço do commit).
      // Environment sozinho não leva o catálogo.
      const prepare = async () => {
        const markers =
          scope.kind === "environment" || !input.markers
            ? null
            : await markersForPush(storage, wsRemotePath, input.workspaceName, input.markers);
        // Marcador com o mesmo nome de um do GitHub (outro id): a árvore sobe
        // já com o id de lá, o mesmo que o catálogo enviado leva.
        const collections = markers && markers.remapped.size > 0 ? remapMarkers(input.collections, markers.remapped) : input.collections;
        const plan = buildPushPlan({
          wsRemotePath,
          collections,
          // Token de sessão (OAuth2) não sobe: é de cada pessoa e expira (lib/jwt).
          environments: withoutSessionTokens(input.environments),
          markers: markers?.send ?? null,
          existingPaths: [...existing.collectionPaths, ...existing.envPaths],
        });
        return { markers, collections, plan };
      };
      let { markers, collections, plan } = await prepare();

      // O que sobrou lá: renomeação (o mesmo id gravado com outro nome) sai
      // sem perguntar. O resto só no push do workspace inteiro — e só o que
      // já esteve sincronizado aqui (você apagou), com confirmação.
      const writtenIds = new Set(
        plan.files.filter((f) => f.kind !== "markers").map((f) => rootIdOf(f.content)).filter((id): id is string => !!id)
      );
      const { renamed, ask } = await staleToRemove(storage, input.workspaceName, plan.stalePaths, writtenIds);
      let removed: string[] = [...renamed];
      let keptStale: string[] = [];
      if (scope.kind === "workspace" && ask.length > 0) {
        if (await askDeleteConfirmation(ask)) removed = [...removed, ...ask];
        else keptStale = ask;
      }

      const message = input.message ?? pushCommitMessage(input.workspaceName, plan, removed.length);
      // O catálogo também passa pela checagem de versão; se só ele mudou no
      // meio, é relido e recalculado (ele é mesclado, não revisado).
      const markersPath = markersFilePath(wsRemotePath);
      let result: Awaited<ReturnType<typeof storage.commitFiles>>;
      for (let attempt = 0; ; attempt++) {
        result = await storage.commitFiles(
          [...plan.files.map((f) => ({ path: f.path, content: f.content })), ...removed.map((path) => ({ path, delete: true }))],
          message
        );
        if (result.ok || attempt >= 2 || !result.conflicts.every((path) => path === markersPath)) break;
        ({ markers, collections, plan } = await prepare());
      }
      if (!result.ok) return { status: "conflict", paths: result.conflicts };

      // A base do catálogo: o que ficou igual dos dois lados (markerBaseAfterPush).
      if (markers) await recordSyncBase(input.workspaceName, markers.base, [MARKER_BASE_PREFIX]);
      // Trocou id de marcador: o daqui passa a ser o que subiu (catálogo e
      // marcas da árvore), pelo mesmo merge do pull.
      if (markers && markers.remapped.size > 0) await onPullMarkers?.(input.workspaceName, markers.send);

      // O painel guarda os paths do workspace aberto.
      if (input.workspaceName === workspace) {
        const isEnv = (path: string) => path.startsWith(`${wsRemotePath}/environments/`);
        const written = plan.files.filter((f) => f.kind !== "markers").map((f) => f.path);
        if (scope.kind === "workspace") {
          setCollectionPaths([...written.filter((p) => !isEnv(p)), ...keptStale.filter((p) => !isEnv(p))]);
          setEnvPaths([...written.filter(isEnv), ...keptStale.filter(isEnv)]);
        } else {
          setCollectionPaths((prev) => [...new Set([...prev.filter((p) => !removed.includes(p)), ...written.filter((p) => !isEnv(p))])]);
          setEnvPaths((prev) => [...new Set([...prev.filter((p) => !removed.includes(p)), ...written.filter(isEnv)])]);
        }
      }
      return { status: "pushed", collections: collections as CollectionItem[], removed, keptStale };
    } catch (e) {
      if (e instanceof MissingPassphraseError) {
        requirePassphrase();
        return { status: "error", message: PASSPHRASE_MISSING_MESSAGE };
      }
      throw e;
    } finally {
      releaseSyncLock(ownLock);
      setSingleOp(null);
    }
  }

  // Renomeia a pasta remota de um workspace ("Postman/<nome>") — copia cada
  // arquivo pro novo nome e só então apaga os antigos. Sem isso, renomear só
  // localmente deixa a pasta velha intacta no GitHub, e um Pull de todos os
  // workspaces mais tarde a redescobre como se fosse um workspace à parte,
  // recriando localmente o que já tinha sido renomeado.
  //
  // Silencioso quando não há nada pra fazer (sync não configurado, ou o
  // workspace nunca foi enviado pro GitHub) — não é um erro, é o caso comum
  // de quem não usa sync nenhum.
  const renameRemoteWorkspace = useCallback(async (oldName: string, newName: string): Promise<"renamed" | "nothing" | "failed"> => {
    if (!isConfigValid) return "nothing";

    const storage = client();
    const oldRemotePath = `${WORKSPACES_ROOT}/${oldName}`;
    const newRemotePath = `${WORKSPACES_ROOT}/${newName}`;

    const files = await storage.listAllFilesRecursive(oldRemotePath);
    if (files.length === 0) return "nothing";

    // Já existe uma pasta com o nome novo no GitHub (outra pessoa criou um
    // workspace com esse nome, que talvez nem exista aqui): copiar por cima
    // substituiria os arquivos dela. Para antes de mexer em qualquer coisa.
    const destination = await storage.listAllFilesRecursive(newRemotePath);
    if (destination.length > 0) {
      const message = `A workspace named "${newName}" already exists on GitHub (${destination.length} file(s)). Nothing was moved there — pick another name, or remove that folder on GitHub first.`;
      showStatus("error", message);
      throw new Error(message);
    }

    if (!passphrase) {
      showStatus(
        "error",
        `✗ "${oldName}" has files on GitHub but couldn't be renamed there — set your sync passphrase and rename again.`
      );
      return "failed";
    }

    const lock = acquireSyncLock("rename");
    if (singleOpBusy || !lock) {
      releaseSyncLock(lock);
      showStatus("error", SYNC_BUSY_MESSAGE);
      return "failed";
    }

    setSingleOp(`Renaming "${oldName}" on GitHub...`);
    showStatus("info", `Renaming "${oldName}" to "${newName}" on GitHub...`);

    // Copia tudo ANTES de apagar qualquer coisa: se parar no meio (rede,
    // conflito, token expirado), a pasta antiga continua intacta e completa —
    // só sobra, no pior caso, uma pasta nova pela metade, não dado perdido.
    // Um commit só: cópia e exclusão entram juntas, ou nada entra. Antes eram
    // dois commits POR ARQUIVO, e uma falha no meio deixava as duas pastas.
    try {
      const changes: { path: string; content?: unknown; delete?: boolean; noCheck?: boolean }[] = [];
      for (const file of files) {
        const data = await storage.getFile(file.path);
        // Sem conteúdo (sumiu no meio, ou não deu pra ler): pular deixava a
        // pasta antiga com esse arquivo — e o "Pull de todos" recriava o
        // workspace antigo. Para tudo; a pasta antiga continua inteira.
        if (!data) {
          throw new Error(`Could not read "${file.path.split("/").pop()}" on GitHub — nothing was renamed there. Try again.`);
        }
        changes.push({ path: `${newRemotePath}${file.path.slice(oldRemotePath.length)}`, content: data.content, noCheck: true });
        changes.push({ path: file.path, delete: true, noCheck: true });
      }
      const result = await storage.commitFiles(changes, `sync: rename workspace "${oldName}" to "${newName}"`);
      if (!result.ok) throw new Error(`"${oldName}" changed on GitHub while renaming — try again.`);
      showStatus("success", `"${oldName}" renamed to "${newName}" on GitHub.`);
      return "renamed";
    } catch (e) {
      console.error(`❌ Erro ao renomear a pasta remota de "${oldName}" para "${newName}":`, e);
      throw e;
    } finally {
      releaseSyncLock(lock);
      setSingleOp(null);
    }
  }, [isConfigValid, client, passphrase, showStatus, singleOpBusy]);

  useEffect(() => {
    setConfigDraft(config);
  }, [config.token, config.owner, config.repo, config.branch]);

  useEffect(() => {
    return () => {
      if (configDebounceRef.current) clearTimeout(configDebounceRef.current);
    };
  }, []);

  const handleConfigFieldChange = (field: keyof GitHubConfig, value: string) => {
    setConfigDraft(prev => {
      const next = { ...prev, [field]: value };
      if (configDebounceRef.current) clearTimeout(configDebounceRef.current);
      configDebounceRef.current = setTimeout(() => {
        saveConfig(next);
      }, 500);
      return next;
    });
  };
  

  useEffect(() => {
  onSyncStatusChange?.(collectionPaths.length > 0 || envPaths.length > 0);
}, [collectionPaths, envPaths, onSyncStatusChange]);

  useEffect(() => {
    const loadConfig = async () => {
      const parsed = (await storeGet<Partial<GitHubConfig>>("gh_sync_config")) || {};

      let token = "";
      try {
        token = (await getSecret(GH_TOKEN_KEY)) || "";
      } catch (e) {}

      setConfig({
        token,
        owner: parsed.owner || "",
        repo: parsed.repo || "",
        branch: parsed.branch || "main",
      });
    };
    loadConfig();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) setIsOpen(false);
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  async function handlePullEverything() {
    if (!isConfigValid || !workspace) return;
    // Lista de agora, não a que o painel guardou: um arquivo apagado lá desde
    // então fazia o pull falhar (e um novo não vinha).
    let paths: { collectionPaths: string[]; envPaths: string[] };
    try {
      paths = await client().resolveWorkspaceFilePaths(remotePath);
    } catch (e: any) {
      showStatus("error", `Pull failed: ${e?.message ?? String(e)}`);
      return;
    }
    if (paths.collectionPaths.length === 0 && paths.envPaths.length === 0) {
      showStatus("error", `No file found in the remote workspace.`);
      return;
    }
    setCollectionPaths(paths.collectionPaths);
    setEnvPaths(paths.envPaths);
    await performPull(paths.collectionPaths, paths.envPaths);
  }

  // Pull de TODOS os workspaces encontrados em Postman/* no repositório —
  // não só o workspace selecionado no momento. Cada workspace remoto vira
  // (ou atualiza) um workspace local, via onPullWorkspaceData.
  async function handlePullAllWorkspaces() {
    if (!isConfigValid) return;
    if (!onPullWorkspaceData) {
      // Sem esse callback, cai no comportamento antigo (só o workspace atual).
      await handlePullEverything();
      return;
    }

    // Um sync por vez (lib/sync/syncLock).
    const lock = acquireSyncLock("pull");
    if (!lock) {
      showStatus("error", SYNC_BUSY_MESSAGE);
      return;
    }
    setLoading(true);
    showStatus("info", "Discovering workspaces in the repository...");

    try {
      const storage = client();
      const folders = await storage.listFolders(WORKSPACES_ROOT);

      if (folders.length === 0) {
        showStatus("info", `No workspace found under "${WORKSPACES_ROOT}/" in this repository.`);
        return;
      }

      let pulledCollections = 0;
      let pulledEnvironments = 0;
      const failedWorkspaces: string[] = [];
      // Workspaces fechados com alteração não enviada: substituir apagaria o
      // trabalho deles sem pergunta nenhuma (a confirmação do "Pull all" fala
      // só do aberto). Ficam de fora — Pull ou Push deles pelo menu.
      const skippedUnsynced: string[] = [];

      for (let i = 0; i < folders.length; i++) {
        const folder = folders[i];
        // O aberto conta também as abas com edição (hasUnsyncedChanges).
        if (folder.name === workspace ? !!hasUnsyncedChanges : !isPendingEmpty(readPendingPush(folder.name))) {
          skippedUnsynced.push(folder.name);
          continue;
        }
        showStatus("info", `Downloading workspace "${folder.name}" (${i + 1}/${folders.length})...`);

        try {
          const { collectionPaths: cPaths, envPaths: ePaths } =
            await storage.resolveWorkspaceFilePaths(folder.path);

          const { collections, environments, failedPaths, shas } =
            await downloadWorkspaceFilesData(storage, cPaths, ePaths);

          // Arquivo que não baixou ficaria de fora da substituição — a
          // collection sumiria daqui. Pula o workspace inteiro e avisa.
          if (failedPaths.length > 0) {
            failedWorkspaces.push(folder.name);
            continue;
          }

          await onPullWorkspaceData(folder.name, collections, environments);
          await recordPulledWorkspace(storage, folder.path, shas);

          if (onPullMarkers) {
            const remoteMarkers = await fetchRemoteMarkers(storage, folder.path);
            if (remoteMarkers) await onPullMarkers(folder.name, remoteMarkers);
          }

          pulledCollections += collections.length;
          pulledEnvironments += environments.length;
          if (failedPaths.length > 0) failedWorkspaces.push(folder.name);

          // Se for o workspace ativo no app agora, mantém o painel atual coerente.
          if (folder.name === workspace) {
            setCollectionPaths(cPaths);
            setEnvPaths(ePaths);
          }
        } catch (e: any) {
          console.error(`❌ Falha ao baixar workspace "${folder.name}":`, e);
          failedWorkspaces.push(folder.name);
        }
      }

      const downloaded = folders.length - failedWorkspaces.length - skippedUnsynced.length;
      const skippedNote = skippedUnsynced.length > 0
        ? ` Skipped (unpushed changes — push or pull them from the workspace menu): ${skippedUnsynced.join(", ")}.`
        : "";
      if (failedWorkspaces.length > 0) {
        showStatus(
          "error",
          `⚠ ${downloaded}/${folders.length} workspaces downloaded successfully. Failed: ${failedWorkspaces.join(", ")}.${skippedNote}`
        );
      } else if (skippedUnsynced.length > 0) {
        showStatus("info", `${downloaded}/${folders.length} workspace(s) downloaded.${skippedNote}`);
      } else {
        showStatus(
          "success",
          `✓ ${folders.length} workspace(s) downloaded (${pulledCollections} collection(s), ${pulledEnvironments} environment(s))!`
        );
      }
    } catch (e: any) {
      console.error("❌ Erro ao baixar todos os workspaces:", e);
      showStatus("error", `✗ Pull failed: ${e.message}`);
    } finally {
      releaseSyncLock(lock);
      setLoading(false);
    }
  }

useImperativeHandle(ref, () => ({
  commitPush: (input: CommitPushInput) => commitPush(input),
  report: (type: "success" | "error" | "info", message: string) => showStatus(type, message),
  fetchWorkspace: async (workspaceName: string, ref?: string, statusLabel?: string, options?: { peek?: boolean }) => {
    if (!statusLabel) return fetchRemoteWorkspace(client(), workspaceName, ref, options);
    setSingleOp(statusLabel);
    try {
      return await fetchRemoteWorkspace(client(), workspaceName, ref, options);
    } finally {
      setSingleOp(null);
    }
  },
  isSynced: () => collectionPaths.length > 0 || envPaths.length > 0,
  // Configurações → Avançado: baixa todos os workspaces e substitui os daqui.
  replaceAllFromGitHub: () => handlePullAllWorkspaces(),
  renameWorkspace: (oldName: string, newName: string) => renameRemoteWorkspace(oldName, newName),
  openCommitHistory: (workspaceName: string) => openCommitHistory(workspaceName),
  markReviewed: (workspaceName: string, scope: ReviewScope) => markReviewed(workspaceName, scope),
  lastChangeOf: (workspaceName: string, rootId: string) => lastChangeOf(workspaceName, rootId),
  syncedVersionOf: (workspaceName: string, rootId: string) => syncedVersionOf(workspaceName, rootId),
  snapshotSynced: async (workspaceName: string) => {
    const prefix = `${WORKSPACES_ROOT}/${workspaceName}/`;
    const all = await loadSyncedShas(client().repoKey);
    return Object.fromEntries(Object.entries(all).filter(([path]) => path.startsWith(prefix)));
  },
  restoreSynced: async (workspaceName: string, snapshot: FileShas) => {
    const storage = client();
    const prefix = `${WORKSPACES_ROOT}/${workspaceName}/`;
    const current = await loadSyncedShas(storage.repoKey);
    const changes: Record<string, string | null> = { ...snapshot };
    for (const path of Object.keys(current)) {
      if (path.startsWith(prefix) && !(path in snapshot)) changes[path] = null;
    }
    // remoteToo: false — o GitHub de agora continua o que era.
    await recordSyncedShas(storage.repoKey, changes, { remoteToo: false });
  },
  fileHistoryOf: async (workspaceName: string, rootId: string, limit = 15) => {
    const storage = client();
    const fetched = knownVersions(storage, workspaceName);
    const path = fetched && Object.keys(fetched.idsByPath).find((p) => fetched.idsByPath[p].includes(rootId));
    if (!path) return null;
    const commits = await storage.listCommits(path, limit);
    const read = (sha: string) => {
      const key = `${storage.repoKey}|${path}@${sha}`;
      let pending = fileAtCommitCache.get(key);
      if (!pending) {
        pending = storage.getFile(path, sha).then((f) => f?.content ?? null).catch(() => null);
        fileAtCommitCache.set(key, pending);
      }
      return pending;
    };
    return { commits, read };
  },
}));

  // ── "↑ N para enviar · ↓ N mudou no GitHub" ─────────────────────────────
  // Para enviar: o que pendingPushStore marcou (por collection/environment).
  // Mudou no GitHub: arquivos cujo sha na listagem difere do da última
  // sincronização desta máquina (lib/remoteVersions). `null` = sem referência.
  const behindCount = remoteShas && remotePath
    ? countBehind(remoteShas, syncedShas, `${remotePath}/`, (p) => isTrackedPath(remotePath, p))
    : null;
  const aheadCount = pendingPushSummary
    ? pendingPushSummary.collections.length + pendingPushSummary.environments.length
    : 0;
  const aheadDeletions = pendingPushSummary?.requiresFullPush ?? false;
  const hasAhead = pendingPushSummary ? aheadCount > 0 || aheadDeletions : !!hasPendingPush;

  const isBlocking = loading || resolvingFiles;
  const knownConflicts = useKnownConflicts(workspace);
  // Sincronizado de fato: nada lá (com referência), nada aqui, sem conflito.
  const inSync = behindCount === 0 && aheadCount === 0 && !aheadDeletions && !knownConflicts;
  // O ↓N também vai pra Central: com arquivo mudado lá e nada a mesclar, ela
  // ainda libera o "Receber" (o pull é que marca o arquivo como lido).
  useEffect(() => {
    setRemoteBehind(workspace, behindCount);
  }, [workspace, behindCount]);
  const syncText = useSyncDiffStrings();

  return (
    <>
      {/* As duas pílulas vão por portal pro <body>: dentro do painel, um
          ancestral com transform vira a referência do `fixed`, e o aviso
          aparecia deslocado em vez de no centro da janela. */}
      {isBlocking && typeof document !== "undefined" && createPortal(
        // No topo ela dividia espaço com a barra de abas e ficava fácil de
        // não notar — bloqueante merece ocupar o centro, igual um diálogo,
        // com o fundo escurecido deixando claro que o app pausou pra isso.
        <div className="fixed inset-0 z-[9999] select-none flex items-center justify-center bg-black/25 backdrop-blur-[3px] animate-in fade-in duration-150">
          <DevFlowBusyCard
            title={resolvingFiles ? "Syncing workspace" : "Processing"}
            detail={
              resolvingFiles
                ? `"${workspace.split(/[\\/]/).pop() || workspace}" — reading the files on GitHub`
                : "Hold on — the app continues as soon as this finishes"
            }
          />
        </div>,
        document.body
      )}

      {/* Mesma pílula, para operações PONTUAIS (pull/push de um workspace,
          save silencioso, envio de um environment). Também no centro da
          janela, mas sem escurecer o fundo e com pointer-events-none: essas
          operações não travam o app, então o aviso não pode capturar
          cliques. Só aparece quando a bloqueante não está na tela, pra as
          duas nunca se sobreporem. */}
      {singleOp && !isBlocking && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[9999] pointer-events-none select-none flex items-center justify-center">
          <DevFlowBusyCard title={singleOp} detail="You can keep using the app meanwhile" />
        </div>,
        document.body
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-[10001] pointer-events-auto flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <ModalCard className="w-[380px]" onClose={() => resolvePendingDelete(false)} closeLabel="Keep on GitHub">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-pm-border">
              <span className="w-[22px] h-[22px] rounded-md bg-rose-500/15 text-rose-400 flex items-center justify-center">
                <MissingDotIcon />
              </span>
              <span className="text-[13px] font-semibold text-pm-text">
                Remove from GitHub?
              </span>
            </div>

            <div className="px-4 py-3 flex flex-col gap-2">
              <p className="text-[12px] text-pm-text-muted leading-relaxed">
                {pendingDelete.paths.length === 1
                  ? "You removed this here. Pushing can remove it from GitHub too:"
                  : `You removed these ${pendingDelete.paths.length} files here. Pushing can remove them from GitHub too:`}
              </p>
              <ul className="max-h-[140px] overflow-y-auto text-[11.5px] text-pm-text-secondary bg-pm-hover/60 border border-pm-border rounded-md p-2 list-disc list-inside">
                {pendingDelete.paths.map((p) => (
                  <li key={p} className="truncate">{p.split("/").pop()}</li>
                ))}
              </ul>
              <p className="text-[11px] text-amber-400/90">
                Everyone pulling this workspace loses them. They stay in the GitHub history and can be restored from Commit history.
              </p>
            </div>

            <div className="flex gap-2 px-4 py-3 border-t border-pm-border bg-pm-hover/20">
              <button
                className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text hover:bg-pm-row-active hover:text-pm-text transition-colors"
                onClick={() => resolvePendingDelete(false)}
              >
                Keep on GitHub
              </button>
              <button
                className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border-none bg-rose-600 text-white hover:bg-rose-500 transition-colors"
                onClick={() => resolvePendingDelete(true)}
              >
                Remove
              </button>
            </div>
          </ModalCard>
        </div>
      )}

      {pendingDeleteWorkspace && (
        <div className="fixed inset-0 z-[10001] pointer-events-auto flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <ModalCard className="w-[380px]" onClose={deletingWorkspace ? undefined : () => setPendingDeleteWorkspace(null)} closeLabel="Cancel">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-pm-border">
              <span className="w-[22px] h-[22px] rounded-md bg-rose-500/15 text-rose-400 flex items-center justify-center">
                <MissingDotIcon />
              </span>
              <span className="text-[13px] font-semibold text-pm-text">
                Delete workspace from GitHub?
              </span>
            </div>

            <div className="px-4 py-3 flex flex-col gap-2">
              <p className="text-[12px] text-pm-text-muted leading-relaxed">
                {pendingDeleteWorkspace.files.length === 1
                  ? `1 file will be permanently removed from "${pendingDeleteWorkspace.remotePath}" in the repository:`
                  : `${pendingDeleteWorkspace.files.length} files will be permanently removed from "${pendingDeleteWorkspace.remotePath}" in the repository:`}
              </p>
              <ul className="max-h-[140px] overflow-y-auto text-[11.5px] text-pm-text-secondary bg-pm-hover/60 border border-pm-border rounded-md p-2 list-disc list-inside">
                {pendingDeleteWorkspace.files.map((f) => (
                  <li key={f.path} className="truncate">{f.path.replace(`${pendingDeleteWorkspace.remotePath}/`, "")}</li>
                ))}
              </ul>
              <p className="text-[11px] text-amber-400/90">
                This action cannot be undone. The local workspace will not be affected.
              </p>
            </div>

            <div className="flex gap-2 px-4 py-3 border-t border-pm-border bg-pm-hover/20">
              <button
                className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text hover:bg-pm-row-active hover:text-pm-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={deletingWorkspace}
                onClick={() => setPendingDeleteWorkspace(null)}
              >
                Cancel
              </button>
              <button
                className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border-none bg-rose-600 text-white hover:bg-rose-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={deletingWorkspace}
                onClick={handleConfirmDeleteRemoteWorkspace}
              >
                {deletingWorkspace ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </ModalCard>
        </div>
      )}

      {/* Os modais de confirmação de pull saíram: a Central de Sincronização
          mostra o que vai entrar antes de aplicar, e o "substituir tudo" tem a
          própria confirmação em Configurações → Avançado. */}

      {/* Histórico de commits do workspace — escolher qual versão baixar */}
      {commitHistoryWorkspace && (
        <div
          className="fixed inset-0 z-[10001] pointer-events-auto flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={closeCommitHistory}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[1080px] max-w-[94vw] h-[80vh] bg-pm-surface border border-pm-border rounded-xl shadow-2xl overflow-hidden font-sans flex flex-col"
          >
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-pm-border shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-[22px] h-[22px] rounded-md bg-[#1a8ad4]/15 text-[#007acc] flex items-center justify-center shrink-0">
                  <HistoryClockIcon />
                </span>
                <div className="flex flex-col min-w-0">
                  <span className="text-[13px] font-semibold text-pm-text truncate">
                    Commit history
                  </span>
                  <span className="text-[10.5px] text-pm-text-muted truncate">
                    {commitHistoryWorkspace}
                  </span>
                </div>
              </div>
              <button
                onClick={closeCommitHistory}
                disabled={restoringCommit}
                className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 min-h-0 flex flex-col md:flex-row">
            <div className="md:w-[400px] md:shrink-0 max-md:max-h-[40%] overflow-y-auto min-h-[160px] md:border-r border-pm-border">
              {commitsLoading && (
                <div className="px-4 py-10 text-center text-[12px] text-pm-text-muted">
                  Loading commits...
                </div>
              )}

              {!commitsLoading && commitsError && (
                <div className="px-4 py-10 text-center text-[12px] text-rose-400">
                  {commitsError}
                </div>
              )}

              {!commitsLoading && !commitsError && (
                <div className="flex flex-col p-1.5 gap-1">
                  {commitList.map((commit, index) => {
                    const isSelected = selectedCommitSha === commit.sha;
                    const firstLine = commit.message.split("\n")[0];
                    const when = commit.date ? new Date(commit.date).toLocaleString() : "";
                    return (
                      <button
                        key={commit.sha}
                        type="button"
                        onClick={() => selectCommit(commit.sha)}
                        className={`flex flex-col gap-1 text-left px-2.5 py-2 rounded-lg border transition-colors cursor-pointer ${
                          isSelected
                            ? "border-[#007acc]/60 bg-[#007acc]/10"
                            : "border-transparent hover:bg-pm-hover"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[12px] text-pm-text truncate flex-1">
                            {firstLine || "(no message)"}
                          </span>
                          {index === 0 && (
                            <span className="shrink-0 px-1.5 py-0 rounded text-[9px] font-bold uppercase tracking-wide bg-emerald-500/15 text-emerald-400">
                              latest
                            </span>
                          )}
                          <span className="shrink-0 font-mono text-[10px] text-pm-text-muted">
                            {commit.sha.slice(0, 7)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[10.5px] text-pm-text-muted">
                          <span className="truncate max-w-[220px]">{commit.authorName}</span>
                          <span>·</span>
                          <span className="truncate">{when}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0 min-h-0 overflow-y-auto max-md:border-t border-pm-border">
              <div className="sticky top-0 z-[1] px-3 py-2 border-b border-pm-border bg-pm-surface text-[11px] font-semibold uppercase tracking-wide text-pm-text-muted">
                Changes{selectedCommitSha ? ` in ${selectedCommitSha.slice(0, 7)}` : ""}
              </div>
              <CommitChangesView
                loading={!!selectedCommitSha && !!commitChanges[selectedCommitSha]?.loading}
                error={selectedCommitSha ? commitChanges[selectedCommitSha]?.error ?? null : null}
                files={selectedCommitSha ? commitChanges[selectedCommitSha]?.files ?? null : null}
                commitLabel={selectedCommitSha?.slice(0, 7)}
              />
            </div>
            </div>

            <div className="flex items-center gap-2 px-4 py-3 border-t border-pm-border bg-pm-hover/20 shrink-0">
              <p className="flex-1 text-[10.5px] text-amber-400/90 leading-snug">
                Downloading replaces this workspace&apos;s local data with the files as
                they were in the selected commit — there is no merge.
              </p>
              <button
                className="h-[32px] px-3 rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text hover:bg-pm-row-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={closeCommitHistory}
                disabled={restoringCommit}
              >
                Cancel
              </button>
              <button
                className="h-[32px] px-3 rounded-md text-xs font-semibold cursor-pointer border-none bg-[#007acc] text-white hover:bg-[#0b8ae6] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={!selectedCommitSha || restoringCommit}
                onClick={() => {
                  if (selectedCommitSha && commitHistoryWorkspace) {
                    pullWorkspaceAtCommit(commitHistoryWorkspace, selectedCommitSha);
                  }
                }}
              >
                {restoringCommit ? "Downloading..." : "Download this version"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Indicador da Central de Sincronização: ↓ receber · ↑ enviar · ⚠
          conflitos (o ⚠ é o que a última verificação achou). Clicar abre a
          Central — o lugar único de ver o que entra e o que sai. */}
      {canSync && (
        <button
          type="button"
          onClick={() => openSyncCenter()}
          title={inSync ? syncText.scIndicatorSynced : syncText.scIndicatorTitle(behindCount, aheadCount, knownConflicts)}
          aria-label={syncText.scTitle}
          className="inline-flex items-center gap-1.5 h-6 px-1.5 rounded-md border border-transparent text-[11px] tabular-nums cursor-pointer text-pm-text-muted hover:bg-pm-row-active hover:border-pm-border transition-colors"
        >
          {inSync ? (
            // Nada a receber, enviar nem decidir: um ✓ diz isso de uma vez,
            // em vez de "↓0 ↑0" que obriga a ler os dois números.
            <span className="inline-flex items-center gap-1 text-[#4ff09d]">
              <Check size={12} />
            </span>
          ) : (<>
          <span className={`inline-flex items-center gap-0.5 ${behindCount ? "text-[#9fd3f7]" : ""}`}>
            <ArrowDown size={11} />
            {behindCount ?? "–"}
          </span>
          <span className={`inline-flex items-center gap-0.5 ${aheadCount > 0 || aheadDeletions ? "text-[#4ff09d]" : ""}`}>
            <ArrowUp size={11} />
            {aheadCount}
          </span>
          {!!knownConflicts && (
            <span className="inline-flex items-center gap-0.5 text-amber-300">
              <AlertTriangle size={11} />
              {knownConflicts}
            </span>
          )}
          </>)}
        </button>
      )}

      <div className="relative inline-block text-pm-text font-sans" ref={popoverRef}>
        <button
          className={`relative inline-flex items-center justify-center h-6 px-1 rounded-md cursor-pointer text-xs font-medium border transition-all ${
            isOpen
              ? "bg-pm-row-active text-pm-text border-pm-border"
              : "bg-pm-bg border-pm-bg text-pm-text hover:bg-pm-row-active hover:text-pm-text hover:border-pm-border"
          }`}
          onClick={() => setIsOpen(!isOpen)}
          title={
            [
              "GitHub Sync",
              hasPendingPush ? "local changes waiting to be pushed" : null,
              behindCount ? `${behindCount} file(s) changed on GitHub` : null,
            ].filter(Boolean).join(" — ")
          }
        >
          {/* Sem pontos de aviso aqui: o contador ↓/↑ ao lado já mostra o que
              há para baixar e para enviar. */}
          <FolderGit2 size={17} className="text-pm-text-muted" />
        </button>

        {isOpen && (
          <div className="absolute top-[calc(100%+8px)] left-0 w-[336px] bg-pm-surface border border-pm-border rounded-lg shadow-2xl z-[9999] flex flex-col overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
            <div className="flex items-center justify-between p-3.5 border-b border-pm-border">
              <div className="flex items-center gap-2">
                <span className="w-[22px] h-[22px] rounded-md bg-[#1a8ad4]/15 text-[#007acc] flex items-center justify-center">
                  <SettingsIcon />
                </span>
                <span className="text-[12.5px] font-semibold text-pm-text">
                  GitHub Sync
                </span>
              </div>
              <button
                className="bg-transparent border-none text-pm-text-muted text-sm cursor-pointer px-2 py-0.5 rounded leading-none transition-colors hover:text-pm-text hover:bg-pm-hover"
                onClick={() => setIsOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="p-3.5 flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
              <span className="text-[10px] font-bold text-pm-text-muted uppercase tracking-wider -mb-1">
                connection
              </span>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-pm-text-muted font-semibold uppercase tracking-wider">
                  Personal Access Token
                </label>
                <div className="relative flex items-center">
                  <input
                    type={showToken ? "text" : "password"}
                    className="w-full bg-pm-hover border border-pm-border text-pm-text pr-8 pl-2 py-1.5 rounded-md text-xs outline-none focus:border-[#007acc] transition-colors"
                    placeholder="github_pat_... or ghp_..."
                    value={configDraft.token}
                    onChange={(e) => handleConfigFieldChange('token', e.target.value)}
                  />
                  <button
                    type="button"
                    className="absolute right-1 bg-transparent border-none text-pm-text-muted cursor-pointer p-1 flex rounded transition-colors hover:text-pm-text hover:bg-pm-hover"
                    title={showToken ? "Hide token" : "Show token"}
                    onClick={() => setShowToken((v) => !v)}
                  >
                    {showToken ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-pm-text-muted font-semibold uppercase tracking-wider">
                  Sync passphrase
                </label>
                <div className="relative flex items-center">
                  <input
                    type={showPassphrase ? "text" : "password"}
                    className="w-full bg-pm-hover border border-pm-border text-pm-text pr-8 pl-2 py-1.5 rounded-md text-xs outline-none focus:border-[#007acc] transition-colors"
                    placeholder="Required to encrypt what goes to GitHub"
                    defaultValue={passphrase}
                    onBlur={(e) => savePassphrase(e.target.value)}
                  />
                  <button
                    type="button"
                    className="absolute right-1 bg-transparent border-none text-pm-text-muted cursor-pointer p-1 flex rounded transition-colors hover:text-pm-text hover:bg-pm-hover"
                    title={showPassphrase ? "Hide passphrase" : "Show passphrase"}
                    onClick={() => setShowPassphrase((v) => !v)}
                  >
                    {showPassphrase ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
                <span className="text-[10px] text-pm-text-muted leading-relaxed">
                  Your collections and environments are encrypted with this before
                  being pushed. Use the same passphrase on every machine that syncs
                  this repository — it is stored only on this computer, so there is
                  no way to recover it if lost.
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-pm-text-muted font-semibold uppercase tracking-wider">
                    owner
                  </label>
                  <input
                    className="w-full bg-pm-hover border border-pm-border text-pm-text px-2 py-1.5 rounded-md text-xs outline-none focus:border-[#007acc] transition-colors"
                    placeholder="your-org"
                    value={configDraft.owner}
                    onChange={(e) => handleConfigFieldChange('owner', e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-pm-text-muted font-semibold uppercase tracking-wider">
                    repository
                  </label>
                  <input
                    className="w-full bg-pm-hover border border-pm-border text-pm-text px-2 py-1.5 rounded-md text-xs outline-none focus:border-[#007acc] transition-colors"
                    placeholder="your-repo"
                    value={configDraft.repo}
                    onChange={(e) => handleConfigFieldChange('repo', e.target.value)}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-pm-text-muted font-semibold uppercase tracking-wider">
                  Branch
                </label>
                <div className="relative flex items-center">
                  <span className="absolute left-2 flex text-pm-text-muted pointer-events-none">
                    <BranchIcon />
                  </span>
                  <input
                    className="w-full bg-pm-hover border border-pm-border text-pm-text pl-6.5 pr-2 py-1.5 rounded-md text-xs outline-none focus:border-[#007acc] transition-colors"
                    placeholder="main"
                    value={configDraft.branch}
                    onChange={(e) => handleConfigFieldChange('branch', e.target.value)}
                  />
                </div>
              </div>

              <div className="h-[1px] bg-pm-border my-0.5" />

              <div className="flex items-center justify-between -mb-1">
                <span className="text-[10px] font-bold text-pm-text-muted uppercase tracking-wider">
                  Workspaces in the repository
                </span>
                <button
                  type="button"
                  onClick={handleListRemoteWorkspaces}
                  disabled={!isConfigValid || loadingRemoteWorkspaces}
                  className="text-[11px] text-[#3794ff] hover:underline cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                >
                  {loadingRemoteWorkspaces ? "Loading..." : "List"}
                </button>
              </div>

              {remoteWorkspaces !== null && (
                // shrink-0: o painel pai é flex-col com max-h-[60vh] — sem
                // isso, quando o conteúdo não cabe, essa lista (por ter
                // overflow-y-auto) é espremida até ~0px e só sobra a scrollbar.
                <div className="shrink-0 max-h-[160px] overflow-y-auto rounded-md border border-pm-border bg-pm-hover flex flex-col p-1 gap-0.5">
                  {remoteWorkspaces.length === 0 ? (
                    <div className="py-3 text-center text-[11px] text-pm-text-muted">
                      No workspace found
                    </div>
                  ) : (
                    remoteWorkspaces.map((w) => (
                      <button
                        key={w.path}
                        type="button"
                        onClick={() => handleImportClick(w.name)}
                        disabled={importingName === w.name}
                        className="flex items-center gap-2 px-2 py-1.5 rounded text-[12px] text-pm-text hover:bg-pm-row-active transition-colors cursor-pointer text-left disabled:opacity-50 disabled:cursor-wait"
                      >
                        <span className="text-pm-text-muted shrink-0"><FolderIcon /></span>
                        <span className="flex-1 truncate">{w.name}</span>
                        {importingName === w.name && (
                          <span className="text-[10px] text-pm-text-muted shrink-0">importing...</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}

              {!workspace && (
                <div className="text-[11px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-md px-2.5 py-2">
                  Select a workspace to sync.
                </div>
              )}

              {workspace && (
                <>
                  <div className="h-[1px] bg-pm-border my-0.5" />
                  <span className="text-[10px] font-bold text-pm-text-muted uppercase tracking-wider -mb-1">
                    Remote Workspace: {workspace}
                  </span>

                      {/* Como o `git status`: o que falta enviar e o que mudou lá. */}
                      {!resolvingFiles && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {!(collectionPaths.length > 0 || envPaths.length > 0) ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-pm-hover text-pm-text-muted border border-pm-border">
                              only local
                            </span>
                          ) : (
                            <>
                              {hasAhead && (
                                <span
                                  title="Changed here since your last push — Push sends them"
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#007acc]/15 text-[#63b3ed] border border-[#007acc]/30"
                                >
                                  ↑ {pendingPushSummary
                                    ? aheadCount > 0
                                      ? `${aheadCount} to push${aheadDeletions ? " + deletions" : ""}`
                                      : "deletions to push"
                                    : "changes to push"}
                                </span>
                              )}
                              {!!behindCount && (
                                <span
                                  title={`${behindCount} file(s) changed on GitHub since this machine last synced — Pull shows what changed before applying`}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-500/15 text-sky-300 border border-sky-500/25"
                                >
                                  ↓ {behindCount} changed on GitHub
                                </span>
                              )}
                              {!hasAhead && behindCount === 0 && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                                  <CheckDotIcon /> Up to date with GitHub
                                </span>
                              )}
                              {!hasAhead && behindCount === null && (
                                <span
                                  title="This machine hasn't pulled or pushed this workspace since tracking started. Pull once to start showing what changes on GitHub."
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-pm-hover text-pm-text-muted border border-pm-border"
                                >
                                  On GitHub · not compared yet
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      )}

                  <div className="bg-pm-hover border border-pm-border rounded-md p-2.5 flex flex-col gap-1.5">
                    {resolvingFiles ? (
                      <span className="text-[11.5px] text-pm-text-muted">
                        Loading files...
                      </span>
                    ) : (
                      <>
                        <div className="flex items-start gap-1.5 text-[11.5px]">
                          <span
                            className={`w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5 ${
                              collectionPaths.length > 0
                                ? "bg-emerald-500/20 text-emerald-500"
                                : "bg-rose-500/20 text-rose-500"
                            }`}
                          >
                            {collectionPaths.length > 0 ? <CheckDotIcon /> : <MissingDotIcon />}
                          </span>
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="text-pm-text font-medium">
                              Collections on GitHub ({collectionPaths.length})
                            </span>
                          </div>
                        </div>

                        <div className="flex items-start gap-1.5 text-[11.5px]">
                          <span
                            className={`w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5 ${
                              envPaths.length > 0
                                ? "bg-emerald-500/20 text-emerald-500"
                                : "bg-rose-500/20 text-rose-500"
                            }`}
                          >
                            {envPaths.length > 0 ? <CheckDotIcon /> : <MissingDotIcon />}
                          </span>
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="text-pm-text font-medium">
                              Environments on GitHub ({envPaths.length})
                            </span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}

              {status.type && (
                <div
                  className={`flex flex-col gap-2 text-[11.5px] p-2 rounded-md leading-snug border ${
                    status.type === "info"
                      ? "bg-sky-500/10 text-sky-400 border-sky-500/20"
                      : status.type === "success"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : "bg-rose-400/10 text-rose-400 border-rose-400/20"
                  }`}
                >
                  <span className="flex items-start gap-1.5">
                    <span aria-hidden className="shrink-0 font-bold">
                      {status.type === "success" ? "✓" : status.type === "error" ? "!" : "i"}
                    </span>
                    <span className="flex-1">{status.message}</span>
                    {/* Erro não some sozinho (só sucesso/info somem em 5s):
                        sem o X, o aviso de conflito ficava no painel até a
                        próxima ação, mesmo depois de resolvido. */}
                    <button
                      type="button"
                      aria-label="Dismiss"
                      title="Dismiss"
                      onClick={() => {
                        setStatus({ type: null, message: "" });
                      }}
                      className="shrink-0 -mr-0.5 -mt-0.5 h-5 w-5 flex items-center justify-center rounded opacity-70 hover:opacity-100 hover:bg-black/20 cursor-pointer border-none bg-transparent text-current"
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                      </svg>
                    </button>
                  </span>

                </div>
              )}

              {/* "Substituir tudo pelo GitHub" foi para Configurações →
                  Avançado (zona de perigo); a prévia do push é a aba "Para
                  enviar" da Central de Sincronização. */}

              {onShowConflictHistory && (
                <button
                  type="button"
                  onClick={onShowConflictHistory}
                  title="What was chosen in each conflict on this computer"
                  className="self-start text-[11px] text-pm-text-muted hover:text-pm-text hover:underline cursor-pointer -mt-0.5"
                >
                  Conflict history…
                </button>
              )}

              <button
                type="button"
                onClick={handleRequestDeleteRemoteWorkspace}
                disabled={!canSync || deletingWorkspace || resolvingFiles}
                className="self-start text-[11px] text-rose-400/80 hover:text-rose-400 hover:underline cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline -mt-0.5"
              >
                Delete this workspace from GitHub
              </button>
            </div>


            <div className="flex gap-2 p-3.5 border-t border-pm-border bg-pm-hover/20">
              <button
                className="w-[30px] h-[32px] bg-pm-hover border border-pm-border text-pm-text-muted rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-pm-row-active hover:text-pm-text disabled:opacity-40 disabled:cursor-not-allowed"
                title="Reload remote workspace files"
                disabled={!canSync || resolvingFiles}
                onClick={() => { void resolveWorkspaceFiles(); }}
              >
                {resolvingFiles ? <DevFlowSpinner size={14} /> : <RefreshIcon />}
              </button>

              {/* Pull e Push daqui foram para a Central de Sincronização —
                  um lugar só pro que entra, o que sai e o que conflita. */}
              <button
                className="flex-1 inline-flex items-center justify-center gap-1.5 h-[32px] px-3 rounded-md text-xs font-semibold cursor-pointer border-none bg-[#007acc] text-white transition-colors hover:bg-[#1a8ad4] disabled:opacity-35 disabled:cursor-not-allowed"
                disabled={!canSync}
                onClick={() => {
                  setIsOpen(false);
                  openSyncCenter();
                }}
              >
                <ArrowDown size={13} className="text-[#9fd3f7]" />
                <ArrowUp size={13} className="-ml-1.5 text-[#4ff09d]" />
                {syncText.scOpen}
                {(!!behindCount || aheadCount > 0) && (
                  <span className="text-white/80 tabular-nums">
                    ({behindCount ?? 0}/{aheadCount})
                  </span>
                )}
              </button>

              
            </div>
          </div>
        )}
      </div>
    </>
  );
});

export default GitHubSync;
