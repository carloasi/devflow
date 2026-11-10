"use client";

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { saveSecret, getSecret, deleteSecret } from '@/lib/secureStorage'
import { FolderGit2 } from "lucide-react";
import { storeGet, storeSet } from "@/lib/tauriStore";
import { toast } from "sonner";
import { withoutSessionTokens } from "@/lib/jwt";
import { RemoteChangeToast, type RemoteCommitInfo } from "@/components/SyncDiff/RemoteChangeToast";
import type { RemoteChangePreview } from "@/lib/sync/remoteChangeAlert";
import { loadWorkspaceLocalData, loadWorkspaceMarkers } from "@/storage/localSyncStore";
import type { CollectionItem } from '@/app/types/CollectionItem';
import { stripStarredFlags } from "@/components/collection-tree/utils/tree.utils";
import { encryptData, decryptData, clearDerivedKeyCache, MissingPassphraseError } from "@/lib/syncCrypto";
import { diffCollection, diffEnvironment, fileTitle, prettyContent, FileChange } from "@/lib/commitDiff";
import { CommitChangesView } from "@/components/CommitChangesView";
import { ModalCard } from "@/components/ui/modal-card";
import { catalogForPush, MARKER_BASE_PREFIX, markerBaseHashes, type Marker } from "@/lib/markers";
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
import type { PendingPush } from "@/storage/pendingPushStore";
import {
  buildPushPlan,
  collectionFilePath,
  collisionMessage,
  environmentFilePath,
  markersFilePath,
  pushCommitMessage,
} from "@/lib/sync/pushPlan";

// Mesma chave/comando que o UserBadge.tsx usa pro nome exibido no canto
// superior direito ("CarlosSilva" / "Windows account") — reaproveitado aqui
// pra atribuir os commits do GitHub Sync à pessoa que realmente rodou a
// ação no Windows, em vez de só à conta/token compartilhado configurado no
// Settings. Útil quando várias pessoas do time usam o mesmo repositório.
const WIN_USERNAME_STORAGE_KEY = "app_win_username";
let cachedCommitterName: string | null = null;

async function getCommitterName(): Promise<string | null> {
  if (cachedCommitterName) return cachedCommitterName;
  try {
    const cached = localStorage.getItem(WIN_USERNAME_STORAGE_KEY);
    if (cached) {
      cachedCommitterName = cached;
      return cached;
    }
    const winUser = await invoke<string>("get_windows_username");
    if (winUser) {
      localStorage.setItem(WIN_USERNAME_STORAGE_KEY, winUser);
      cachedCommitterName = winUser;
      return winUser;
    }
  } catch (e) {
    console.error("Não foi possível obter o usuário do Windows para o commit:", e);
  }
  return null;
}

// Git exige author/committer.email, mas não existe um e-mail real do
// Windows — gera um sintético a partir do nome. De propósito não bate com
// nenhuma conta do GitHub (não deveria linkar avatar/perfil), só carrega o
// nome mesmo pra aparecer no histórico de commits.
function committerEmailFor(name: string): string {
  const local = name.toLowerCase().replace(/[^a-z0-9._-]/g, ".") || "user";
  return `${local}@devflow.local`;
}

async function buildCommitIdentity(): Promise<{ name: string; email: string } | null> {
  const name = await getCommitterName();
  if (!name) return null;
  return { name, email: committerEmailFor(name) };
}

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

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

const PullIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7M3 13.5h10" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const PushIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M8 13.5v-8M4.5 9l3.5-3.5L11.5 9M3 2.5h10" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const FolderIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.85 }}>
    <path d="M2 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3z" />
  </svg>
);

interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

interface SyncStatus {
  type: "success" | "error" | "info" | null;
  message: string;
}

interface RepoItem {
  name: string;
  path: string;
  type: "dir" | "file" | string;
  /** sha do blob — a Contents API manda em toda entrada da listagem. */
  sha?: string;
}

// Um commit do histórico da pasta de um workspace — ver listCommits.
export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  date: string;
}

export interface PushOptions {
  silent?: boolean;
  /** Vem da tela de revisão: não compara de novo, grava com o sha revisado. */
  reviewed?: boolean;
  /** Sobrescreve o GitHub sem comparar nem checar versão. */
  force?: boolean;
}

export interface GitHubSyncHandle {
  push: (collectionsOverride?: any, environmentsOverride?: any, options?: PushOptions) => Promise<void>;
  pushEnvironment: (env: any) => Promise<void>; // ✅ novo
  // Envia só uma collection, sem tocar nas demais nem propor exclusões.
  // `partOf`: o envio é de UM item (pasta ou request) dessa collection — o
  // arquivo leva o GitHub de agora com só esse item trocado (AppLayout
  // .handlePushItem). Não apaga arquivos obsoletos nem avisa onCollectionPushed:
  // o resto das suas mudanças na collection continua pendente.
  pushCollection: (collection: CollectionItem, options?: { partOf?: string }) => Promise<void>;
  // Traz o remoto decriptado SEM aplicar nada. É o que permite comparar
  // antes de sobrescrever (etapas 4-6).
  // `statusLabel` acende a pílula de operação pontual enquanto baixa. É
  // opcional porque quem chama de dentro do painel já tem o próprio aviso;
  // quem chama da árvore não tem nada, e a busca pode levar segundos.
  fetchWorkspace: (
    workspaceName: string,
    ref?: string,
    statusLabel?: string
  ) => Promise<RemoteWorkspaceData>;
  pullWorkspace: (workspaceName: string) => Promise<void>; // ✅ novo — pull de só um workspace
  pushWorkspace: (workspaceName: string, options?: PushOptions) => Promise<void>; // ✅ novo — push de só um workspace
  // Renomeia a pasta remota do workspace (ver renameRemoteWorkspace) — no-op
  // silencioso se o workspace nunca foi sincronizado.
  renameWorkspace: (oldName: string, newName: string) => Promise<void>;
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
  // Chamado após enviar UMA collection com sucesso, pra limpar a pendência
  // só dela — o onPushCompleted zera o workspace inteiro e aqui mentiria.
  // `pushed`: a collection como subiu (pode diferir da tela, se mudou no meio).
  onCollectionPushed?: (collectionId: string, pushed?: CollectionItem) => void;
  // Catalogo de marcadores do workspace ativo — sobe junto no push.
  currentMarkers?: Marker[];
  // Catalogo que veio do repositorio. Quem funde com o local e o AppLayout
  // (ver mergeCatalogs): aqui so se sabe baixar.
  onPullMarkers?: (workspaceName: string, markers: Marker[]) => void | Promise<void>;
  // Compara o remoto recém-buscado com o local e devolve o resumo. Mora no
  // AppLayout porque é lá que o formato remoto vira árvore (importData) e
  // que a árvore local existe — aqui só se sabe baixar.
  // `isPushConflict`: a comparação foi aberta por um push que esbarrou em
  // conflito (não pelo "Check remote updates" manual) — o AppLayout usa isso
  // pra, depois de aplicada a mescla, reenviar o push inteiro sozinho.
  // `hasChanges` no retorno: diz se encontrou diferença (e portanto abriu a
  // tela) — a checagem PROATIVA antes de um push (handlePushEverything) usa
  // isso pra decidir se segue com o push normal ou se para e espera a mescla.
  onCompareRemote?: (
    workspaceName: string,
    collections: unknown[],
    environments: unknown[],
    isPushConflict?: boolean
  ) => { summary: string; hasChanges: boolean };
  // Pull do workspace ATUAL passando pela tela de revisão. Quando existe, é
  // o que o botão Pull faz; o pull de todos os workspaces (que substitui o
  // local sem mescla) fica numa ação à parte.
  onPullWithReview?: () => Promise<void>;
  // Restaurar um commit do workspace ATUAL passa pela revisão: a versão
  // daquele commit é comparada com a daqui, e a pessoa escolhe o que volta.
  onReviewSnapshot?: (workspaceName: string, collections: unknown[], environments: unknown[], commitSha: string) => void;
  // Push de um workspace terminou com sucesso (local == remoto de novo).
  // `pushed`: o que subiu de fato — é dele que sai a base da sincronização.
  onPushCompleted?: (workspaceName: string, pushed?: { collections: unknown[]; environments: unknown[] }) => void;
  // Conflito ao enviar UM workspace pelo menu (pushSingleWorkspace) — esse
  // workspace pode não ser o selecionado agora, então vai junto o que foi
  // lido do disco pra tentar o push (local) e o que tem no repositório
  // (remoto): só quem chamou sabe qual dos dois usar como base do merge.
  // Retorna se achou diferença (e abriu a tela) — mesmo motivo do
  // `hasChanges` acima, pra pushSingleWorkspace decidir se para ou segue.
  onWorkspacePushConflict?: (
    workspaceName: string,
    localCollections: unknown[],
    localEnvironments: unknown[],
    remoteCollections: unknown[],
    remoteEnvironments: unknown[]
  ) => boolean;
  // Aviso em segundo plano: o GitHub mudou um arquivo do workspace — roda o
  // merge "de teste" (nada é aplicado) e diz QUAIS itens mudaram dos dois
  // lados e, de cada item que veio de lá, o antes/depois (`preview`, pro
  // mini-diff do aviso). `null` = não deu pra checar.
  // changedRootIds: collections cujos arquivos mudaram no GitHub — sem item a
  // trazer, a prévia mostra o que o último commit delas mudou.
  onConflictPreview?: (workspaceName: string, changedRootIds?: string[]) => Promise<{ conflicts: string[]; incoming: number; preview?: RemoteChangePreview } | null>;
  // "Preview push…": o que o push faria, sem enviar nada.
  onPushPreview?: () => void;
  // "Conflict history…": as decisões de conflito tomadas nesta máquina.
  onShowConflictHistory?: () => void;
  // Merge automático por item antes do push (e de novo se alguém enviar no
  // meio): leva só o que mudou aqui por cima da versão do GitHub. Quando
  // existe, substitui a checagem que abria a revisão a cada diferença.
  onRebasePush?: (
    workspaceName: string,
    localCollections: unknown[],
    localEnvironments: unknown[],
    remoteCollections: unknown[],
    remoteEnvironments: unknown[],
    // Só os environments: as collections já foram decididas numa revisão.
    options?: { environmentsOnly?: boolean }
  ) => Promise<RebaseOutcome>;
}

/**
 * Resultado do merge automático do push (AppLayout → lib/sync/rebase):
 * `push` traz a árvore a enviar — a do GitHub com as mudanças daqui por
 * cima —; `review` quer dizer que sobrou conflito e a revisão já abriu.
 */
export type RebaseOutcome =
  | {
      status: 'push';
      collections: unknown[];
      environments: unknown[];
      incoming: number;
      /** Mudou dos dois lados e ficou a versão daqui sem perguntar. */
      keptMine?: string[];
    }
  | { status: 'review'; conflicts: number };

const GH_TOKEN_KEY = 'gh_sync_token'
// Senha de sincronização: deriva a chave que cifra o conteúdo enviado ao
// GitHub. Fica no armazenamento seguro do SO, junto do token.
const GH_PASSPHRASE_KEY = 'gh_sync_passphrase'

export class GitHubConflictError extends Error {
  constructor(public path: string) {
    super(`Conflict: "${path}" was changed by someone else since your last pull.`);
    this.name = "GitHubConflictError";
  }
}

export class GitHubRateLimitError extends Error {
  constructor(public retryAfterMs: number | null) {
    super(
      retryAfterMs
        ? `GitHub rate limit reached — try again in about ${Math.max(1, Math.ceil(retryAfterMs / 60000))} minute(s).`
        : "GitHub rate limit reached — try again later."
    );
    this.name = "GitHubRateLimitError";
  }
}

/**
 * 403/429 por limite de taxa caía no "HTTP 403" genérico, indistinguível de
 * um 403 de permissão de verdade (token sem escopo, repo privado sem
 * acesso). O GitHub manda `Retry-After` (segundos) ou, quando o limite é o
 * de requisições por hora, `X-RateLimit-Remaining: 0` + `X-RateLimit-Reset`
 * (epoch) — detecta os dois e já devolve quanto falta esperar, em vez de
 * deixar quem vê o toast adivinhar. `null` quando não é isso.
 */
function rateLimitErrorFrom(res: Response): GitHubRateLimitError | null {
  if (res.status !== 403 && res.status !== 429) return null;
  if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") !== "0") return null;

  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter && !Number.isNaN(Number(retryAfter))) {
    return new GitHubRateLimitError(Number(retryAfter) * 1000);
  }

  const reset = res.headers.get("X-RateLimit-Reset");
  if (reset && !Number.isNaN(Number(reset))) {
    const resetMs = Number(reset) * 1000 - Date.now();
    return new GitHubRateLimitError(resetMs > 0 ? resetMs : null);
  }

  return new GitHubRateLimitError(null);
}

// ─── Versão de cada arquivo que este app viu por último ──────────────────
//
// O GitHub só recusa uma gravação (409) quando o `sha` enviado não é o atual.
// O putFile buscava o sha atual logo antes de gravar — então o 409 nunca
// acontecia de verdade: quem enviasse entre a comparação (a checagem antes do
// push, ou a tela de revisão) e a gravação era sobrescrito sem aviso.
//
// Aqui fica o sha da versão que foi LIDA (comparada, revisada ou baixada).
// Gravar com ele é o equivalente ao `git push` sem `--force`: se o arquivo
// mudou desde então, o GitHub recusa e a revisão abre de novo.
//
// Em memória, de propósito: todo push começa com uma leitura do remoto (a
// checagem proativa), que renova estes valores. Sem leitura nenhuma (a
// checagem falhou), cai no comportamento antigo — sha atual na hora.
const seenShas = new Map<string, string>();

class GitHubStorageClient {
  private baseUrl = "https://api.github.com";
  /**
   * `force`: ignora a versão vista e grava por cima do que estiver lá. Só pra
   * ação explícita "Overwrite GitHub with mine".
   */
  constructor(
    private config: GitHubConfig,
    private passphrase: string | null,
    private options: { force?: boolean } = {}
  ) {}

  get repoKey(): string {
    return repoKeyOf(this.config);
  }

  private seenKey(path: string) {
    return `${this.config.owner}/${this.config.repo}@${this.config.branch}:${path}`;
  }

  private rememberSha(path: string, sha: string | undefined) {
    if (sha) seenShas.set(this.seenKey(path), sha);
    else seenShas.delete(this.seenKey(path));
  }

  /** sha com que gravar: o visto por último, ou o atual se nunca foi lido. */
  private async shaForWrite(path: string, force?: boolean): Promise<{ sha: string | undefined; expected: boolean }> {
    if (!this.options.force && !force) {
      const seen = seenShas.get(this.seenKey(path));
      if (seen) return { sha: seen, expected: true };
    }
    return { sha: await this.getFileSha(path), expected: false };
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private repoUrl(path: string = "") {
    const cleanPath = path
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    return `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/contents${
      cleanPath ? `/${cleanPath}` : ""
    }`;
  }

  async listFolders(basePath: string = ""): Promise<RepoItem[]> {
  const items = await this.listDirectory(basePath);
  return items.filter((item) => item.type === "dir");
}

  // Mesma lógica usada por resolveWorkspaceFiles (arquivos de collection na
  // raiz + arquivos de environment na subpasta "environments"), mas
  // parametrizada por path — usada tanto pro workspace atual quanto pelo
  // Pull de TODOS os workspaces do repositório.
  // `ref` opcional: quando informado (um SHA de commit), lê o estado dos
  // arquivos NAQUELE commit em vez do topo da branch — usado pelo histórico
  // de commits do workspace ("baixar esta versão").
  async resolveWorkspaceFilePaths(remotePathForWs: string, ref?: string): Promise<{ collectionPaths: string[]; envPaths: string[] }> {
    // Strict: daqui saem as decisões de sync — falha não pode parecer "vazio".
    const rootFiles = await this.listDirectoryStrict(remotePathForWs, ref);

    const collectionFiles = rootFiles.filter(
      (f) =>
        f.type === "file" &&
        /(\.postman_collection\.json|collection.*\.json)$/i.test(f.name)
    );

    const envDirItem = rootFiles.find(
      (f) => f.type === "dir" && f.name.toLowerCase() === "environments"
    );

    let envPaths: string[] = [];
    if (envDirItem) {
      const envFolderFiles = await this.listDirectoryStrict(envDirItem.path, ref);
      envPaths = envFolderFiles
        .filter(
          (f) =>
            f.type === "file" &&
            /(\.postman_environment\.json|\.json)$/i.test(f.name)
        )
        .map((f) => f.path);
    }

    return { collectionPaths: collectionFiles.map((f) => f.path), envPaths };
  }

// Lista recursivamente todos os arquivos (não diretórios) dentro de um path,
// descendo em subpastas. Usado para descobrir tudo que precisa ser apagado
// ao excluir um workspace remoto inteiro.
async listAllFilesRecursive(path: string): Promise<RepoItem[]> {
  // Strict: rename e exclusão decidem o que mover/apagar por esta lista — uma
  // falha de rede não pode parecer "a pasta está vazia" (rename que não faz
  // nada sem avisar, exclusão que apaga só parte e diz que terminou).
  const items = await this.listDirectoryStrict(path);
  const files: RepoItem[] = [];

  for (const item of items) {
    if (item.type === "file") {
      files.push(item);
    } else if (item.type === "dir") {
      const nested = await this.listAllFilesRecursive(item.path);
      files.push(...nested);
    }
  }

  return files;
}

  /**
   * Igual ao listDirectory, mas FALHA quando a leitura falha — só "não
   * existe" (404) vira lista vazia. É a que as decisões de sincronização
   * usam: com o listDirectory, um erro de rede ou de rate limit parecia "o
   * GitHub não tem nada", e o merge do push/pull apagava daqui tudo o que
   * "tinha sumido de lá".
   */
  async listDirectoryStrict(path: string = "", ref?: string): Promise<RepoItem[]> {
    const targetUrl = `${this.repoUrl(path)}?ref=${encodeURIComponent(ref || this.config.branch)}`;
    const res = await tauriFetch(targetUrl, { method: "GET", headers: this.headers() });
    if (res.status === 404) return [];
    if (!res.ok) throw rateLimitErrorFrom(res) ?? new Error(`HTTP ${res.status} while listing ${path || "/"} on GitHub`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(`Unexpected answer while listing ${path || "/"} on GitHub`);
    return data as RepoItem[];
  }

  async listDirectory(path: string = "", ref?: string): Promise<RepoItem[]> {
    const targetUrl = `${this.repoUrl(path)}?ref=${encodeURIComponent(ref || this.config.branch)}`;
    try {
      const res = await tauriFetch(targetUrl, { method: "GET", headers: this.headers() });
      if (res.status === 404) return [];
      if (!res.ok) throw rateLimitErrorFrom(res) ?? new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data) ? (data as RepoItem[]) : [];
    } catch (err: any) {
      console.log(`Erro ao listar ${path || "/"}: ${err.message}`);
      return [];
    }
  }

  // A API de Contents do GitHub só devolve o campo "content" inline pra
  // arquivos até 1MB. Pra arquivos maiores ela devolve "content": "" com
  // "encoding": "none" (mas mantém o "sha"), e o pull descartava esse
  // arquivo em silêncio — colections grandes simplesmente não baixavam.
  // Usamos a API de Git Blobs (que aceita até 100MB) como fallback.
  private async fetchBlobContent(sha: string): Promise<string> {
    const targetUrl = `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/git/blobs/${sha}`;
    const res = await tauriFetch(targetUrl, { method: "GET", headers: this.headers() });
    if (!res.ok) throw rateLimitErrorFrom(res) ?? new Error(`HTTP ${res.status} while downloading blob ${sha}`);
    const data = (await res.json()) as any;
    if (!data.content || data.encoding !== "base64") return "";
    return data.content as string;
  }

  /**
   * Conteúdo (decifrado) de uma versão de arquivo pelo sha do blob — é como
   * se lê "o arquivo como estava na última sincronização", que pode já não
   * existir no topo da branch.
   */
  async readBlob(sha: string): Promise<unknown> {
    const base64 = await this.fetchBlobContent(sha);
    if (!base64) throw new Error(`Empty blob ${sha}`);
    const raw = this.decodeBase64ToUtf8(base64);
    try {
      return await decryptData(raw, this.passphrase);
    } catch (e) {
      try {
        return JSON.parse(raw);
      } catch {
        throw e;
      }
    }
  }

  private decodeBase64ToUtf8(base64: string): string {
    const cleanBase64 = base64.replace(/\s/g, "");
    const binary = atob(cleanBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  // Só busca o "sha" atual de um arquivo (sem baixar/descriptografar o
  // conteúdo) — usado pelo putFile só pra saber se é create ou update.
  // Silencioso de propósito (sem console.error/warn): qualquer falha aqui
  // (404, 401, rede) é tratada como "não existe ainda" e o próprio PUT vai
  // reportar o erro de verdade (ex: token inválido) se for o caso. Antes
  // isso reusava getFile() só pelo sha, o que já logava um console.error
  // "fantasma" (relatado como bug) mesmo quando o erro era esperado/inofensivo.
  private async getFileSha(path: string): Promise<string | undefined> {
    const targetUrl = `${this.repoUrl(path)}?ref=${encodeURIComponent(this.config.branch)}`;
    try {
      const metaRes = await tauriFetch(targetUrl, { method: "GET", headers: this.headers() });
      if (!metaRes.ok) return undefined;
      const metaData = (await metaRes.json()) as any;
      return metaData?.sha;
    } catch {
      return undefined;
    }
  }

  // `ref` opcional: SHA de commit pra ler a versão do arquivo naquele ponto
  // do histórico em vez do topo da branch.
  async getFile(path: string, ref?: string): Promise<{ content: any; sha: string } | null> {
    const targetUrl = `${this.repoUrl(path)}?ref=${encodeURIComponent(ref || this.config.branch)}`;

    try {
      const metaRes = await tauriFetch(targetUrl, { method: "GET", headers: this.headers() });

      if (metaRes.status === 404) {
        console.warn(`⚠️ Arquivo não encontrado (404): ${path}`);
        // Sumiu do remoto: a próxima gravação é uma criação, não uma
        // atualização da versão que se tinha visto antes.
        if (!ref) this.rememberSha(path, undefined);
        return null;
      }

      if (!metaRes.ok) throw rateLimitErrorFrom(metaRes) ?? new Error(`HTTP ${metaRes.status}`);

      const metaData = (await metaRes.json()) as any;
      // Só a versão do topo da branch conta como "vista": ler um commit
      // antigo (histórico) não diz nada sobre o que está lá agora.
      if (!ref) this.rememberSha(path, metaData?.sha);
      let rawStringContent = "";

      if (metaData.content && metaData.encoding === "base64") {
        rawStringContent = this.decodeBase64ToUtf8(metaData.content);
      } else if (metaData.sha) {
        // Arquivo grande (>1MB) — a Contents API não trouxe o conteúdo inline.
        const blobBase64 = await this.fetchBlobContent(metaData.sha);
        if (blobBase64) rawStringContent = this.decodeBase64ToUtf8(blobBase64);
      }

      if (!rawStringContent) {
        console.warn(`⚠️ Não foi possível ler o conteúdo de: ${path}`);
        return null;
      }

      try {
        const decryptedContent = await decryptData(rawStringContent, this.passphrase);
        return { content: decryptedContent, sha: metaData.sha };
      } catch (decErr: any) {
        try {
          const parsed = JSON.parse(rawStringContent);
          return { content: parsed, sha: metaData.sha };
        } catch (e) {
          throw new Error(`Failed to read ${path}: ${decErr.message}`);
        }
      }
    } catch (err: any) {
      console.error(`❌ Erro ao baixar ${path}:`, err);
      throw new Error(`Error downloading ${path}: ${err.message}`);
    }
  }

  // Histórico de commits que tocaram um path específico (a pasta do
  // workspace) — usado pela janela "Commit history" do menu de workspaces,
  // onde dá pra escolher qual versão baixar.
  async listCommits(path: string, perPage = 30): Promise<CommitInfo[]> {
    const url =
      `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/commits` +
      `?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(this.config.branch)}&per_page=${perPage}`;

    const res = await tauriFetch(url, { method: "GET", headers: this.headers() });

    if (res.status === 404) return [];
    if (!res.ok) {
      const rateLimit = rateLimitErrorFrom(res);
      if (rateLimit) throw rateLimit;
      const errBody = await res.json().catch(() => ({} as any));
      throw new Error(`HTTP ${res.status}${errBody?.message ? `: ${errBody.message}` : ""}`);
    }

    const data = (await res.json()) as any[];
    if (!Array.isArray(data)) return [];

    return data.map((c) => ({
      sha: c?.sha ?? "",
      message: c?.commit?.message ?? "",
      // `commit.author.name` é o nome gravado no git (é o que o DevFlow
      // preenche com o usuário do Windows — ver buildCommitIdentity); o
      // `author.login` só existe quando o e-mail bate com uma conta GitHub.
      authorName: c?.commit?.author?.name ?? c?.author?.login ?? "unknown",
      date: c?.commit?.author?.date ?? "",
    }));
  }

  // O que um commit mudou dentro da pasta de um workspace. O patch do GitHub
  // não serve (o conteúdo é cifrado), então baixa a versão de cada arquivo
  // no commit e no pai dele, descriptografa as duas e compara a estrutura
  // (ver lib/commitDiff).
  async getCommitChanges(sha: string, workspacePath: string): Promise<FileChange[]> {
    const url = `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/commits/${encodeURIComponent(sha)}`;
    const res = await tauriFetch(url, { method: "GET", headers: this.headers() });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({} as any));
      throw new Error(`HTTP ${res.status}${errBody?.message ? `: ${errBody.message}` : ""}`);
    }

    const data = (await res.json()) as any;
    const parentSha: string | undefined = data?.parents?.[0]?.sha;
    const prefix = `${workspacePath.replace(/\/+$/, "")}/`;
    const files = (Array.isArray(data?.files) ? data.files : []).filter(
      (f: any) => String(f?.filename ?? "").startsWith(prefix) || String(f?.previous_filename ?? "").startsWith(prefix)
    );

    // getFile devolve null pra 404 e lança pra erro de rede/senha.
    const read = async (path: string | undefined, ref: string | undefined) =>
      path && ref ? (await this.getFile(path, ref))?.content ?? null : null;

    return Promise.all(
      files.map(async (f: any): Promise<FileChange> => {
        const filename = String(f.filename);
        const status: FileChange["status"] =
          f.status === "added" || f.status === "removed" || f.status === "renamed" ? f.status : "modified";
        const kind: FileChange["kind"] = /\/environments\//i.test(filename)
          ? "environment"
          : /\.json$/i.test(filename)
            ? "collection"
            : "other";

        if (kind === "other") {
          return { file: filename, status, kind, title: filename.split("/").pop() ?? filename, changes: [] };
        }

        try {
          const [before, after] = await Promise.all([
            status === "added" ? null : read(f.previous_filename ?? filename, parentSha),
            status === "removed" ? null : read(filename, sha),
          ]);
          return {
            file: filename,
            status,
            kind,
            title: fileTitle(filename, after ?? before),
            changes: kind === "environment" ? diffEnvironment(before, after) : diffCollection(before, after),
            beforeText: prettyContent(before),
            afterText: prettyContent(after),
          };
        } catch (e: any) {
          return {
            file: filename,
            status,
            kind,
            title: fileTitle(filename, null),
            changes: [],
            error: e?.message ?? String(e),
          };
        }
      })
    );
  }

  async putFile(path: string, content: any, message: string, opts?: { force?: boolean }): Promise<void> {
    const targetUrl = this.repoUrl(path);
    try {
      const { sha, expected } = await this.shaForWrite(path, opts?.force);

      const encryptedString = await encryptData(content, this.passphrase ?? '');

      const encoded = btoa(
        encodeURIComponent(encryptedString).replace(/%([0-9A-F]{2})/g, (_, p1) =>
          String.fromCharCode(parseInt(p1, 16))
        )
      );

      const body: Record<string, unknown> = {
        message,
        content: encoded,
        branch: this.config.branch,
      };
      if (sha) body.sha = sha;

      const identity = await buildCommitIdentity();
      if (identity) {
        // GitHub aceita author/committer separados, mas aqui os dois são a
        // mesma pessoa — quem de fato clicou em Save/Push nesta máquina.
        body.author = identity;
        body.committer = identity;
      }

      const res = await tauriFetch(targetUrl, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // 409 = o sha não é mais o atual. 422 com um sha esperado é a mesma
        // coisa por outro caminho (o arquivo foi apagado ou recriado lá).
        if (res.status === 409 || (res.status === 422 && expected)) {
          throw new GitHubConflictError(path);
        }
        const rateLimit = rateLimitErrorFrom(res);
        if (rateLimit) throw rateLimit;
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`HTTP ${res.status}${errBody.message ? `: ${errBody.message}` : ''}`);
      }

      // A versão que acabou de ser gravada é a nova "vista" — senão uma
      // segunda gravação do mesmo arquivo nesta sessão esbarraria no sha
      // antigo e acusaria conflito consigo mesma.
      const written = (await res.json().catch(() => null)) as any;
      this.rememberSha(path, written?.content?.sha);
      // Gravado = local e remoto iguais neste arquivo (ver lib/remoteVersions).
      void recordSyncedShas(this.repoKey, { [path]: written?.content?.sha ?? null });
    } catch (err: any) {
      throw err;
    }
  }

  // ─── Vários arquivos num commit só (Git Data API) ────────────────────────
  //
  // A Contents API (putFile/deleteFile) cria UM commit por arquivo: um push
  // de 12 collections virava 12 commits, o histórico ficava ilegível, e uma
  // falha no meio deixava o GitHub com metade do push — cada laço de envio
  // carregava código só pra lembrar o que já tinha subido.
  //
  // Aqui o push inteiro vira uma árvore nova sobre o topo da branch e um
  // commit só. A ref só avança se ninguém tiver enviado no meio (sem force):
  // se alguém enviou, refaz em cima do novo topo — e se mexeram justamente
  // num arquivo deste push, para e devolve o conflito sem gravar NADA.

  private gitUrl(path: string) {
    return `${this.baseUrl}/repos/${this.config.owner}/${this.config.repo}/git${path}`;
  }

  private async gitJson<T>(path: string, init?: { method: string; body: unknown }): Promise<{ status: number; data: T | null }> {
    const res = await tauriFetch(this.gitUrl(path), {
      method: init?.method ?? "GET",
      headers: this.headers(),
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) {
      const rateLimit = rateLimitErrorFrom(res);
      if (rateLimit) throw rateLimit;
      // Quem chama decide o que fazer com 404/409/422 (branch vazia, ref
      // que andou); o resto vira erro com o status no texto (isAuthError).
      if ([404, 409, 422].includes(res.status)) return { status: res.status, data: null };
      const errBody = (await res.json().catch(() => ({}))) as any;
      throw new Error(`HTTP ${res.status}${errBody?.message ? `: ${errBody.message}` : ""}`);
    }
    return { status: res.status, data: (await res.json()) as T };
  }

  /**
   * Grava e apaga arquivos num commit só.
   *
   * `noCheck`: o arquivo não passa pela checagem de versão (o catálogo de
   * marcadores, que o pull mescla em vez de revisar). Com `force` no
   * cliente, nada passa.
   *
   * Devolve os paths em conflito sem gravar nada, ou o sha de cada arquivo
   * gravado. Repositório sem nenhum commit ainda: cai na Contents API, um
   * arquivo por vez, que é a única que cria o primeiro commit.
   */
  async commitFiles(
    changes: { path: string; content?: unknown; delete?: boolean; noCheck?: boolean }[],
    message: string
  ): Promise<{ ok: true; written: FileShas } | { ok: false; conflicts: string[] }> {
    const branch = encodeURIComponent(this.config.branch);
    const writes = changes.filter((c) => !c.delete);
    const deletes = changes.filter((c) => c.delete);

    const head0 = await this.gitJson<{ object: { sha: string } }>(`/ref/heads/${branch}`);
    if (!head0.data) return this.commitFilesOneByOne(changes, message);

    // Cifra e cria os blobs UMA vez: o retry só refaz árvore e commit.
    const blobs = new Map<string, string>();
    for (const w of writes) {
      const encrypted = await encryptData(w.content, this.passphrase ?? "");
      const blob = await this.gitJson<{ sha: string }>("/blobs", {
        method: "POST",
        body: { content: encrypted, encoding: "utf-8" },
      });
      if (!blob.data) throw new Error(`HTTP ${blob.status} while uploading ${w.path}`);
      blobs.set(w.path, blob.data.sha);
    }

    const identity = await buildCommitIdentity();
    let headSha = head0.data.object.sha;

    for (let attempt = 0; attempt < 3; attempt++) {
      const commit = await this.gitJson<{ tree: { sha: string } }>(`/commits/${headSha}`);
      if (!commit.data) throw new Error(`HTTP ${commit.status} while reading ${this.config.branch}`);
      const baseTree = commit.data.tree.sha;

      // Versão de cada arquivo NESTE topo — uma listagem por pasta.
      const current: FileShas = {};
      const dirs = new Set(changes.map((c) => c.path.slice(0, c.path.lastIndexOf("/"))));
      for (const dir of dirs) {
        // Strict: com a listagem falhando, todo arquivo parecia "mudado lá"
        // (conflito falso) e as exclusões eram puladas em silêncio.
        for (const item of await this.listDirectoryStrict(dir, headSha)) {
          if (item.type === "file" && item.sha) current[item.path] = item.sha;
        }
      }

      const conflicts: string[] = [];
      if (!this.options.force) {
        for (const c of changes) {
          if (c.noCheck) continue;
          const seen = seenShas.get(this.seenKey(c.path));
          if (seen !== undefined) {
            if (current[c.path] !== seen) conflicts.push(c.path);
          } else if (!c.delete && current[c.path] !== undefined) {
            // Nunca lido NESTA sessão, mas existe lá: alguém o criou depois
            // da última leitura (ex.: duas pessoas criando a mesma collection).
            // Gravar por cima apagaria o dele — vira conflito, e o merge do
            // push relê e decide (na segunda volta ele já foi lido).
            conflicts.push(c.path);
          }
        }
      }
      if (conflicts.length > 0) return { ok: false, conflicts };

      const tree = [
        ...writes.map((w) => ({ path: w.path, mode: "100644", type: "blob", sha: blobs.get(w.path)! })),
        // Apagar o que já não existe lá daria erro na árvore — e o efeito
        // desejado já está feito.
        ...deletes
          .filter((d) => current[d.path])
          .map((d) => ({ path: d.path, mode: "100644", type: "blob", sha: null })),
      ];
      if (tree.length === 0) return { ok: true, written: {} };

      const newTree = await this.gitJson<{ sha: string }>("/trees", {
        method: "POST",
        body: { base_tree: baseTree, tree },
      });
      if (!newTree.data) throw new Error(`HTTP ${newTree.status} while building the commit`);

      const newCommit = await this.gitJson<{ sha: string }>("/commits", {
        method: "POST",
        body: {
          message,
          tree: newTree.data.sha,
          parents: [headSha],
          ...(identity ? { author: identity, committer: identity } : {}),
        },
      });
      if (!newCommit.data) throw new Error(`HTTP ${newCommit.status} while creating the commit`);

      const moved = await this.gitJson<unknown>(`/refs/heads/${branch}`, {
        method: "PATCH",
        body: { sha: newCommit.data.sha, force: false },
      });
      if (moved.data) {
        const written: FileShas = {};
        const recorded: Record<string, string | null> = {};
        for (const w of writes) {
          const sha = blobs.get(w.path)!;
          written[w.path] = sha;
          recorded[w.path] = sha;
          this.rememberSha(w.path, sha);
        }
        for (const d of deletes) {
          recorded[d.path] = null;
          this.rememberSha(d.path, undefined);
        }
        await recordSyncedShas(this.repoKey, recorded);
        return { ok: true, written };
      }

      // 422 = não é fast-forward: alguém enviou entre ler o topo e mover a
      // ref. Relê o topo e tenta de novo — a checagem acima pega o caso em
      // que essa pessoa mexeu num arquivo deste push.
      const head = await this.gitJson<{ object: { sha: string } }>(`/ref/heads/${branch}`);
      if (!head.data) throw new Error(`HTTP ${head.status} while reading ${this.config.branch}`);
      headSha = head.data.object.sha;
    }

    throw new Error("GitHub kept changing while pushing — try again in a moment.");
  }

  /** Caminho antigo, arquivo por arquivo — só pra repositório sem commit. */
  private async commitFilesOneByOne(
    changes: { path: string; content?: unknown; delete?: boolean; noCheck?: boolean }[],
    message: string
  ): Promise<{ ok: true; written: FileShas } | { ok: false; conflicts: string[] }> {
    const conflicts: string[] = [];
    for (const c of changes) {
      try {
        if (c.delete) await this.deleteFile(c.path, message);
        else await this.putFile(c.path, c.content, message, { force: c.noCheck });
      } catch (e) {
        if (e instanceof GitHubConflictError) conflicts.push(c.path);
        else throw e;
      }
    }
    return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, written: {} };
  }

  async deleteFile(path: string, message: string): Promise<void> {
    const targetUrl = this.repoUrl(path);
    try {
      const metaRes = await tauriFetch(
        `${targetUrl}?ref=${encodeURIComponent(this.config.branch)}`,
        { method: "GET", headers: this.headers() }
      );

      if (metaRes.status === 404) {
        // Já não existia: o efeito é o mesmo de ter apagado.
        void recordSyncedShas(this.repoKey, { [path]: null });
        return;
      }

      if (!metaRes.ok) throw rateLimitErrorFrom(metaRes) ?? new Error(`HTTP ${metaRes.status}`);

      const metaData = (await metaRes.json()) as any;
      const sha = metaData.sha;
      if (!sha) return;

      const deleteBody: Record<string, unknown> = { message, sha, branch: this.config.branch };
      const identity = await buildCommitIdentity();
      if (identity) {
        deleteBody.author = identity;
        deleteBody.committer = identity;
      }

      const res = await tauriFetch(targetUrl, {
        method: "DELETE",
        headers: this.headers(),
        body: JSON.stringify(deleteBody),
      });

      if (!res.ok) {
        const rateLimit = rateLimitErrorFrom(res);
        if (rateLimit) throw rateLimit;
        const errJson = (await res.json().catch(() => ({}))) as any;
        throw new Error(errJson.message || `HTTP ${res.status}`);
      }
      this.rememberSha(path, undefined);
      void recordSyncedShas(this.repoKey, { [path]: null });
    } catch (err: any) {
      throw err;
    }
  }
  
}

const WORKSPACES_ROOT = "Postman";

// Catálogo de marcadores, nomes de arquivo e nomes que colidem: ver
// lib/sync/pushPlan.ts — a regra é uma só pra todos os caminhos de push.

// Baixa e descriptografa os arquivos de UM workspace (dado seus paths já
// resolvidos), sem depender de estado de componente — usado tanto pelo Pull
// de um workspace só quanto pelo Pull de todos os workspaces do repositório.
// Cada arquivo é baixado individualmente (allSettled) pra que a falha de um
// não derrube os outros; retorna também quais paths falharam.
async function downloadWorkspaceFilesData(
  storage: GitHubStorageClient,
  cPaths: string[],
  ePaths: string[],
  // SHA de commit opcional — quando informado, baixa a versão dos arquivos
  // naquele commit (histórico) em vez da versão atual da branch.
  ref?: string
): Promise<{
  collections: any[];
  environments: any[];
  failedPaths: string[];
  /** sha de cada arquivo lido (os que falharam ficam de fora). */
  shas: FileShas;
  /** Ids das collections raiz em cada arquivo — pra saber qual arquivo uma revisão de UMA collection cobriu. */
  idsByPath: Record<string, string[]>;
}> {
  const failedPaths: string[] = [];
  const shas: FileShas = {};
  const idsByPath: Record<string, string[]> = {};

  const collectionSettled = await Promise.allSettled(cPaths.map((p) => storage.getFile(p, ref)));
  const collections = collectionSettled
    .map((settled, i) => {
      if (settled.status === "rejected" || !settled.value || !settled.value.content) {
        failedPaths.push(cPaths[i]);
        return null;
      }
      if (settled.value.sha) shas[cPaths[i]] = settled.value.sha;
      const content = settled.value.content;
      idsByPath[cPaths[i]] = (Array.isArray(content) ? content : [content])
        .map((c: any) => c?.id ?? c?.info?._postman_id)
        .filter((id: unknown): id is string => typeof id === "string");
      return content;
    })
    .filter((content) => content !== null)
    .flat();

  const envSettled = await Promise.allSettled(ePaths.map((p) => storage.getFile(p, ref)));
  const rawEnvironments = envSettled
    .map((settled, i) => {
      if (settled.status === "rejected" || !settled.value || !settled.value.content) {
        failedPaths.push(ePaths[i]);
        return null;
      }
      if (settled.value.sha) shas[ePaths[i]] = settled.value.sha;
      let content = settled.value.content;
      if (typeof content === "string") {
        try { content = JSON.parse(content); } catch (e) {}
      }
      const list = Array.isArray(content) ? content : [content];
      idsByPath[ePaths[i]] = list
        .map((env: any) => env?.id)
        .filter((id: unknown): id is string => typeof id === "string");
      return list;
    })
    .filter((content) => content !== null)
    .flat();

  const environments = Array.from(
    new Map(rawEnvironments.map((env: any) => [env.id, env])).values()
  );

  return { collections, environments, failedPaths, shas, idsByPath };
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
}
const lastFetched = new Map<string, FetchedVersions>();

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
    const file = await storage.getFile(markersFilePath(remotePath), ref);
    if (!file?.content) return null;
    let content = file.content;
    if (typeof content === "string") content = JSON.parse(content);
    const list = Array.isArray(content) ? content : (content as { markers?: unknown })?.markers;
    if (!Array.isArray(list)) return null;
    // Valida entrada a entrada: o arquivo é editável à mão no repositório, e
    // um marcador sem id derrubaria o Map do catálogo inteiro.
    return list.filter(
      (m): m is Marker =>
        !!m &&
        typeof (m as Marker).id === "string" &&
        typeof (m as Marker).name === "string" &&
        typeof (m as Marker).color === "string"
    );
  } catch {
    return null;
  }
}

async function fetchRemoteWorkspace(
  storage: GitHubStorageClient,
  workspaceName: string,
  ref?: string
): Promise<RemoteWorkspaceData> {
  const wsRemotePath = `${WORKSPACES_ROOT}/${workspaceName}`;
  const { collectionPaths, envPaths } = await storage.resolveWorkspaceFilePaths(wsRemotePath, ref);

  const [{ collections, environments, failedPaths, shas, idsByPath }, markers] = await Promise.all([
    downloadWorkspaceFilesData(storage, collectionPaths, envPaths, ref),
    fetchRemoteMarkers(storage, wsRemotePath, ref),
  ]);

  if (!ref) rememberFetched(storage, workspaceName, { wsRemotePath, shas, idsByPath });
  return { collections, environments, collectionPaths, envPaths, failedPaths, shas, idsByPath, markers };
}

// ─── Mensagens do push, iguais nos dois caminhos ─────────────────────────
function conflictMessage(paths: string[]): string {
  return paths.length === 1
    ? `"${paths[0].split("/").pop()}" was changed on GitHub by someone else. Nothing was pushed — review the changes to merge them.`
    : `${paths.length} files were changed on GitHub by someone else. Nothing was pushed — review the changes to merge them.`;
}

function keptStaleMessage(workspaceName: string, count: number): string {
  return `"${workspaceName}" pushed. ${count} file(s) you removed here were kept on GitHub.`;
}

function pushedMessage(workspaceName: string, removed: number, incoming = 0, keptMine: string[] = []): string {
  let message = removed > 0
    ? `"${workspaceName}" pushed to GitHub — ${removed} file(s) removed there.`
    : `"${workspaceName}" pushed to GitHub.`;
  if (incoming > 0) message += ` ${incoming} change(s) made by others on GitHub were merged in automatically.`;
  // O que mudou dos dois lados e ficou com a versão daqui SEM revisão
  // (variáveis de environment, itens movidos): diz, em vez de calar.
  if (keptMine.length > 0) {
    const listed = keptMine.slice(0, 5).join(', ') + (keptMine.length > 5 ? `, +${keptMine.length - 5}` : '');
    message += ` Changed on both sides — your version replaced GitHub's: ${listed}.`;
  }
  return message;
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

function rebaseReviewMessage(workspaceName: string, conflicts: number): string {
  return `${conflicts} item(s) in "${workspaceName}" were changed both here and on GitHub. Everything else was merged — decide these and the push continues.`;
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
  onCollectionPushed,
  onCompareRemote,
  onPullWithReview,
  onReviewSnapshot,
  onPushCompleted,
  onWorkspacePushConflict,
  onRebasePush,
  onConflictPreview,
  onPushPreview,
  onShowConflictHistory,
  currentMarkers,
  onPullMarkers,
}, ref) {
  const [config, setConfig] = useState<GitHubConfig>({
    token: "",
    owner: "barramentob2b",
    repo: "Postman",
    branch: "main",
  });
  const [configDraft, setConfigDraft] = useState<GitHubConfig>(config);
  const configDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isOpen, setIsOpen] = useState(false);
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

const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<{ files: RepoItem[] } | null>(null);
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
    setPendingDeleteWorkspace({ files });
  } catch (e: any) {
    console.error("❌ Erro ao listar arquivos para exclusão:", e);
    showStatus("error", `✗ Failed to check files: ${e.message}`);
  } finally {
    setDeletingWorkspace(false);
  }
}, [isConfigValid, remotePath, client]);

const handleConfirmDeleteRemoteWorkspace = useCallback(async () => {
  if (!pendingDeleteWorkspace) return;

  setDeletingWorkspace(true);
  showStatus("info", "Deleting workspace from GitHub...");
  try {
    // Um commit só, e sem checagem de versão: a pessoa confirmou apagar a
    // pasta inteira, seja qual for a versão que está lá.
    const storage = client();
    await storage.commitFiles(
      pendingDeleteWorkspace.files.map((file) => ({ path: file.path, delete: true, noCheck: true })),
      `sync: remove workspace "${workspace}"`
    );
    setPendingDeleteWorkspace(null);
    setCollectionPaths([]);
    setEnvPaths([]);
    showStatus("success", `Workspace "${workspace}" removed from GitHub.`);
  } catch (e: any) {
    console.error("❌ Erro ao excluir workspace remoto:", e);
    showStatus("error", `✗ Delete failed: ${e.message}`);
  } finally {
    setDeletingWorkspace(false);
  }
}, [pendingDeleteWorkspace, client, workspace]);

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
    if (!quiet) setResolvingFiles(true);
    try {
      // Estrita (falha em vez de devolver []): com a pasta environments
      // vazia por um erro de rede, todo environment aparecia como "removido
      // no GitHub" no aviso e no contador. Na falha fica o que se sabia.
      const rootFiles = await client().listDirectoryStrict(remotePath);

      const collectionFiles = rootFiles.filter(
        (f) =>
          f.type === "file" &&
          /(\.postman_collection\.json|collection.*\.json)$/i.test(f.name)
      );

      const envDirItem = rootFiles.find(
        (f) => f.type === "dir" && f.name.toLowerCase() === "environments"
      );

      let foundEnvPaths: string[] = [];
      const shas: FileShas = {};
      for (const f of collectionFiles) if (f.sha) shas[f.path] = f.sha;
      if (envDirItem) {
        const envFolderFiles = await client().listDirectoryStrict(envDirItem.path);
        const envFiles = envFolderFiles.filter(
          (f) =>
            f.type === "file" &&
            /(\.postman_environment\.json|\.json)$/i.test(f.name)
        );
        for (const f of envFiles) if (f.sha) shas[f.path] = f.sha;
        foundEnvPaths = envFiles.map((f) => f.path);
      }

      // Um push/pull registrou versões no meio: esta listagem já nasceu velha.
      // A próxima checagem (ou a abertura do painel) traz a atual.
      if (shaGenerationRef.current !== generation) return;
      setCollectionPaths(collectionFiles.map((f) => f.path));
      setEnvPaths(foundEnvPaths);
      // Pasta do workspace que não existe lá (404): nada pra comparar.
      setRemoteShas(rootFiles.length > 0 ? shas : null);
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
    const fetched = lastFetched.get(`${storage.repoKey}|${workspaceName}`);
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
    const fetched = lastFetched.get(`${storage.repoKey}|${workspaceName}`);
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
      if (document.visibilityState !== "visible" || busyRef.current) return;
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
    if (!remoteShas || !remotePath || busyRef.current) return;
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
    for (const p of fresh) seen[p] = remoteShas[p];
    for (const p of gone) seen[p] = NOTIFIED_DELETED;
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
        { duration: conflicts > 0 ? 60000 : 30000 }
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
              return Array.isArray(content) ? content : [content];
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
        setLoading(false);
      }
    },
    [client, onPullCollections, onPullEnvironments]
  );

  const [pendingDelete, setPendingDelete] = useState<{ paths: string[] } | null>(null);
  const deleteConfirmResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [pushConflict, setPushConflict] = useState<string[] | null>(null);

  function askDeleteConfirmation(paths: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      deleteConfirmResolveRef.current = resolve;
      setPendingDelete({ paths });
    });
  }

  function resolvePendingDelete(confirmed: boolean) {
    deleteConfirmResolveRef.current?.(confirmed);
    deleteConfirmResolveRef.current = null;
    setPendingDelete(null);
  }

  // ── Confirmação antes do Pull, quando há alterações locais não
  // sincronizadas — Pull sempre sobrescreve o local com o que está no
  // GitHub, sem merge, então avisa antes de descartar trabalho não salvo.
  const [pendingPullConfirm, setPendingPullConfirm] = useState(false);
  const pullConfirmResolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  function askPullConfirmation(): Promise<boolean> {
    return new Promise((resolve) => {
      pullConfirmResolveRef.current = resolve;
      setPendingPullConfirm(true);
    });
  }

  function resolvePendingPullConfirm(confirmed: boolean) {
    pullConfirmResolveRef.current?.(confirmed);
    pullConfirmResolveRef.current = null;
    setPendingPullConfirm(false);
  }

  const handlePullAllWorkspacesClick = useCallback(async () => {
    if (hasUnsyncedChanges) {
      const confirmed = await askPullConfirmation();
      if (!confirmed) return;
    }
    await handlePullAllWorkspaces();
  }, [hasUnsyncedChanges, handlePullAllWorkspaces]);

  // ── Confirmação antes do Pull de UM workspace só, quando é o workspace
  // ativo agora e tem alterações locais não salvas (é o único cujo estado
  // "dirty" a gente enxerga daqui — de outro workspace não sabemos).
  const [pendingSinglePullConfirm, setPendingSinglePullConfirm] = useState<string | null>(null);

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
  const singlePullConfirmResolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  function askSinglePullConfirmation(workspaceName: string): Promise<boolean> {
    return new Promise((resolve) => {
      singlePullConfirmResolveRef.current = resolve;
      setPendingSinglePullConfirm(workspaceName);
    });
  }

  function resolvePendingSinglePullConfirm(confirmed: boolean) {
    singlePullConfirmResolveRef.current?.(confirmed);
    singlePullConfirmResolveRef.current = null;
    setPendingSinglePullConfirm(null);
  }

  // Pull de um único workspace remoto (por nome) — usado pelo ícone de
  // atualizar no menu de workspaces, sem precisar trocar pro workspace nem
  // baixar todos os outros junto.
  const pullSingleWorkspace = useCallback(async (workspaceName: string) => {
    if (!isConfigValid) {
      showStatus("error", "✗ Configure GitHub sync before pulling.");
      return;
    }

    // Não usa `loading` (que travaria a tela inteira via isBlocking) — só
    // impede que outro save/pull pontual comece em paralelo.
    if (singleOpBusy) {
      showStatus("error", "✗ Another save/download is already in progress. Wait for it to finish.");
      return;
    }

    if (workspaceName === workspace && hasUnsyncedChanges) {
      const confirmed = await askSinglePullConfirmation(workspaceName);
      if (!confirmed) return;
    }

    setSingleOp(`Updating "${workspaceName}"...`);
    showStatus("info", `Downloading workspace "${workspaceName}"...`);

    try {
      const storage = client();
      const remote = await fetchRemoteWorkspace(storage, workspaceName);
      const { collections, environments, failedPaths } = remote;
      const cPaths = remote.collectionPaths;
      const ePaths = remote.envPaths;

      if (cPaths.length === 0 && ePaths.length === 0) {
        showStatus("info", `No files found for workspace "${workspaceName}" on GitHub.`);
        return;
      }
      // Substituir sem um arquivo que não baixou apagaria aquela collection daqui.
      if (failedPaths.length > 0) {
        showStatus(
          "error",
          `Pull cancelled — ${failedPaths.length} file(s) could not be downloaded: ${failedPaths.map((p) => p.split("/").pop()).join(", ")}. Nothing was changed here.`
        );
        return;
      }

      // Buscar e aplicar agora são duas chamadas: a de cima só traz, esta
      // substitui o local. É a separação que a tela de comparação vai usar
      // pra se intrometer entre as duas.
      await onPullWorkspaceData?.(workspaceName, collections, environments);
      await recordPulledWorkspace(storage, `${WORKSPACES_ROOT}/${workspaceName}`, remote.shas);

      if (onPullMarkers) {
        const remoteMarkers = await fetchRemoteMarkers(
          client(),
          `${WORKSPACES_ROOT}/${workspaceName}`
        );
        if (remoteMarkers) await onPullMarkers(workspaceName, remoteMarkers);
      }

      // Se for o workspace ativo agora, mantém o painel de sync coerente.
      if (workspaceName === workspace) {
        setCollectionPaths(cPaths);
        setEnvPaths(ePaths);
      }

      if (failedPaths.length > 0) {
        showStatus(
          "error",
          `⚠ ${failedPaths.length} file(s) could not be downloaded for "${workspaceName}".`
        );
      } else {
        showStatus(
          "success",
          `✓ "${workspaceName}" updated (${collections.length} collection(s), ${environments.length} environment(s))!`
        );
      }
    } catch (e: any) {
      console.error(`❌ Erro ao baixar workspace "${workspaceName}":`, e);
      showStatus("error", `✗ Pull failed: ${e.message}`);
    } finally {
      setSingleOp(null);
    }
  }, [isConfigValid, workspace, hasUnsyncedChanges, client, onPullWorkspaceData, showStatus, singleOpBusy]);

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
      setRestoringCommit(false);
    }
  }, [isConfigValid, workspace, client, onPullWorkspaceData, onReviewSnapshot, showStatus]);

  // Busca o GitHub e reaplica por cima as mudanças daqui (AppLayout →
  // lib/sync/rebase). `null` = sem merge automático disponível.
  async function rebaseOnRemote(
    storage: GitHubStorageClient,
    workspaceName: string,
    collections: unknown[],
    environments: unknown[],
    options?: { environmentsOnly?: boolean }
  ): Promise<RebaseOutcome | null> {
    if (!onRebasePush) return null;
    const remote = await fetchRemoteWorkspace(storage, workspaceName);
    // Arquivo que não baixou some da versão "de lá" — o merge leria isso
    // como "apagaram no GitHub" e apagaria daqui. Melhor não enviar nada.
    if (remote.failedPaths.length > 0) {
      throw new Error(
        `Could not read ${remote.failedPaths.length} file(s) from GitHub (${remote.failedPaths
          .map((p) => p.split("/").pop())
          .join(", ")}). Nothing was pushed — try again.`
      );
    }
    return onRebasePush(workspaceName, collections, environments, remote.collections, remote.environments, options);
  }

  // ── Núcleo dos dois pushes de workspace inteiro ──────────────────────────
  // Plano (lib/sync/pushPlan) → confirmação do que apagar → UM commit
  // (commitFiles). Atômico: ou o push inteiro entra, ou nada entra — não
  // existe mais "metade enviada" pra lembrar depois de uma falha de rede.
  async function runWorkspacePush(
    storage: GitHubStorageClient,
    input: {
      workspaceName: string;
      collections: unknown[];
      environments: unknown[];
      markers: Marker[];
      allowDeletes: boolean;
    }
  ): Promise<
    | { status: "collision"; message: string }
    | { status: "conflict"; paths: string[] }
    | { status: "pushed"; collectionPaths: string[]; envPaths: string[]; removed: string[]; keptStale: string[] }
  > {
    const wsRemotePath = `${WORKSPACES_ROOT}/${input.workspaceName}`;
    const existing = await storage.resolveWorkspaceFilePaths(wsRemotePath);
    // O catálogo de lá entra junto (catalogForPush): gravar só o daqui
    // apagava os marcadores que outra pessoa criou desde o último pull.
    const remoteMarkers = await fetchRemoteMarkers(storage, wsRemotePath);
    // Com a base: marcador apagado aqui não volta, apagado lá não é reenviado,
    // e o que o colega renomeou não é desfeito (lib/markers).
    const markersToSend = catalogForPush(input.markers, remoteMarkers, await loadSyncBase(input.workspaceName));
    const plan = buildPushPlan({
      wsRemotePath,
      collections: input.collections,
      // Token de sessão (OAuth2) não sobe: é de cada pessoa e expira (lib/jwt).
      environments: withoutSessionTokens(input.environments),
      markers: markersToSend,
      existingPaths: [...existing.collectionPaths, ...existing.envPaths],
    });

    if (plan.collisions.length > 0) return { status: "collision", message: collisionMessage(plan.collisions) };

    // Pergunta ANTES de gravar: assim a exclusão entra no mesmo commit.
    let removed: string[] = [];
    let keptStale: string[] = [];
    if (input.allowDeletes && plan.stalePaths.length > 0) {
      if (await askDeleteConfirmation(plan.stalePaths)) removed = plan.stalePaths;
      else keptStale = plan.stalePaths;
    }

    const result = await storage.commitFiles(
      [
        // O catálogo é mesclado no pull, não revisado: sem checagem de versão.
        ...plan.files.map((f) => ({ path: f.path, content: f.content, noCheck: f.kind === "markers" })),
        ...removed.map((path) => ({ path, delete: true })),
      ],
      pushCommitMessage(input.workspaceName, plan, removed.length)
    );
    if (!result.ok) return { status: "conflict", paths: result.conflicts };
    // O catálogo que subiu vira a base dele.
    await recordSyncBase(input.workspaceName, markerBaseHashes(markersToSend), [MARKER_BASE_PREFIX]);

    const isEnv = (path: string) => path.startsWith(`${wsRemotePath}/environments/`);
    const kept = new Set(keptStale);
    return {
      status: "pushed",
      collectionPaths: [
        ...plan.files.filter((f) => f.kind === "collection").map((f) => f.path),
        ...[...kept].filter((p) => !isEnv(p)),
      ],
      envPaths: [
        ...plan.files.filter((f) => f.kind === "environment").map((f) => f.path),
        ...[...kept].filter(isEnv),
      ],
      removed,
      keptStale,
    };
  }

  // Push de um único workspace (por nome) — usado pelo ícone de push no menu
  // de workspaces (ao lado do Pull), sem precisar trocar pro workspace nem
  // enviar todos os outros junto. Carrega os dados locais do workspace ALVO
  // direto do storage (não de currentCollections/currentEnvironments, que só
  // refletem o workspace selecionado agora) e resolve os arquivos remotos
  // desse workspace pra saber o que é create/update e o que ficou obsoleto.
  const pushSingleWorkspace = useCallback(async (workspaceName: string, options?: PushOptions) => {
    if (!isConfigValid) {
      showStatus("error", "Configure GitHub sync before pushing.");
      return;
    }

    if (!requirePassphrase()) return;

    if (singleOpBusy) {
      showStatus("error", "Another save/download is already in progress. Wait for it to finish.");
      return;
    }

    setSingleOp(`Sending "${workspaceName}"...`);
    showStatus("info", `Encrypting and sending "${workspaceName}"...`);

    try {
      const storage = client({ force: options?.force });
      const { collections, environments } = await loadWorkspaceLocalData(workspaceName);
      // O catálogo de marcadores é POR WORKSPACE — ler `currentMarkers` (o
      // catálogo do workspace SELECIONADO agora) enviaria o catálogo errado
      // sempre que `workspaceName` não for o workspace ativo.
      const markersToPush = (await loadWorkspaceMarkers(workspaceName)) as Marker[];

      let collectionsToPush: any[] = Array.isArray(collections) ? collections : [];
      let envsToPush: any[] = Array.isArray(environments) ? environments : [];

      if (collectionsToPush.length === 0 && envsToPush.length === 0) {
        showStatus("info", `Nothing to push — "${workspaceName}" has no local collections or environments.`);
        return;
      }

      // Checagem PROATIVA: igual à de handlePushEverything, mas pra um
      // workspace que pode não ser o selecionado — por isso o callback recebe
      // o que foi lido do disco como "local". Pulada com `reviewed`/`force`.
      const openReview = async () => {
        if (!onWorkspacePushConflict) return false;
        const remote = await fetchRemoteWorkspace(storage, workspaceName);
        return onWorkspacePushConflict(workspaceName, collectionsToPush, envsToPush, remote.collections, remote.environments);
      };
      // Mesmo merge automático do push do workspace aberto (onRebasePush).
      const canRebase = !options?.force && !!onRebasePush;
      let incoming = 0;
      let keptMine: string[] = [];
      if (canRebase && !options?.reviewed) {
        try {
          const outcome = await rebaseOnRemote(storage, workspaceName, collectionsToPush, envsToPush);
          if (outcome?.status === "review") {
            showStatus("info", rebaseReviewMessage(workspaceName, outcome.conflicts));
            return;
          }
          if (outcome) {
            collectionsToPush = outcome.collections as any[];
            envsToPush = outcome.environments as any[];
            incoming = outcome.incoming;
            keptMine = outcome.keptMine ?? [];
          }
        } catch (e: any) {
          console.error(`❌ Erro no merge automático de "${workspaceName}" antes do push:`, e);
          showStatus("error", `Push cancelled: ${e?.message ?? String(e)}`);
          return;
        }
      } else if (!options?.reviewed && !options?.force) {
        try {
          if (await openReview()) {
            showStatus("info", `Found changes on GitHub for "${workspaceName}" — review before sending.`);
            return;
          }
        } catch (e) {
          console.error(`❌ Erro ao checar o remoto de "${workspaceName}" antes do push:`, e);
          // Não trava o push: a checagem de versão no commit é a rede.
        }
      }

      let result: Awaited<ReturnType<typeof runWorkspacePush>>;
      for (let attempt = 0; ; attempt++) {
        result = await runWorkspacePush(storage, {
          workspaceName,
          collections: collectionsToPush,
          environments: envsToPush,
          markers: markersToPush ?? [],
          allowDeletes: true,
        });
        if (result.status !== "conflict" || !canRebase || attempt >= 2) break;
        const outcome = await rebaseOnRemote(storage, workspaceName, collectionsToPush, envsToPush);
        if (!outcome) break;
        if (outcome.status === "review") {
          showStatus("info", rebaseReviewMessage(workspaceName, outcome.conflicts));
          return;
        }
        collectionsToPush = outcome.collections as any[];
        envsToPush = outcome.environments as any[];
        incoming += outcome.incoming;
        keptMine = outcome.keptMine ?? keptMine;
      }

      if (result.status === "collision") {
        showStatus("error", result.message);
        return;
      }
      if (result.status === "conflict") {
        showStatus("error", conflictMessage(result.paths));
        try {
          await openReview();
        } catch (e) {
          console.error(`❌ Erro ao buscar o remoto de "${workspaceName}" pra revisão do conflito:`, e);
        }
        return;
      }

      // Só o workspace SELECIONADO tem os paths no painel.
      if (workspaceName === workspace) {
        setCollectionPaths(result.collectionPaths);
        setEnvPaths(result.envPaths);
      }
      if (result.keptStale.length > 0) {
        showStatus("info", keptStaleMessage(workspaceName, result.keptStale.length));
        return;
      }
      onPushCompleted?.(workspaceName, { collections: collectionsToPush, environments: withoutSessionTokens(envsToPush) });
      showStatus("success", pushedMessage(workspaceName, result.removed.length, incoming, keptMine));
    } catch (e: any) {
      if (e instanceof MissingPassphraseError) {
        // A senha sumiu no meio (apagada nas settings): só avisa.
        requirePassphrase();
      } else {
        console.error(`❌ Erro ao enviar workspace "${workspaceName}":`, e);
        showStatus("error", `Push failed: ${e.message}`);
      }
    } finally {
      setSingleOp(null);
    }
  }, [isConfigValid, workspace, client, showStatus, singleOpBusy, requirePassphrase, onWorkspacePushConflict, onRebasePush]);

  // Renomeia a pasta remota de um workspace ("Postman/<nome>") — copia cada
  // arquivo pro novo nome e só então apaga os antigos. Sem isso, renomear só
  // localmente deixa a pasta velha intacta no GitHub, e um Pull de todos os
  // workspaces mais tarde a redescobre como se fosse um workspace à parte,
  // recriando localmente o que já tinha sido renomeado.
  //
  // Silencioso quando não há nada pra fazer (sync não configurado, ou o
  // workspace nunca foi enviado pro GitHub) — não é um erro, é o caso comum
  // de quem não usa sync nenhum.
  const renameRemoteWorkspace = useCallback(async (oldName: string, newName: string) => {
    if (!isConfigValid) return;

    const storage = client();
    const oldRemotePath = `${WORKSPACES_ROOT}/${oldName}`;
    const newRemotePath = `${WORKSPACES_ROOT}/${newName}`;

    const files = await storage.listAllFilesRecursive(oldRemotePath);
    if (files.length === 0) return;

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
      return;
    }

    if (singleOpBusy) {
      showStatus("error", "✗ Another save/download is already in progress. Wait for it to finish.");
      return;
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
        if (!data) continue;
        changes.push({ path: `${newRemotePath}${file.path.slice(oldRemotePath.length)}`, content: data.content, noCheck: true });
        changes.push({ path: file.path, delete: true, noCheck: true });
      }
      const result = await storage.commitFiles(changes, `sync: rename workspace "${oldName}" to "${newName}"`);
      if (!result.ok) throw new Error(`"${oldName}" changed on GitHub while renaming — try again.`);
      showStatus("success", `"${oldName}" renamed to "${newName}" on GitHub.`);
    } catch (e) {
      console.error(`❌ Erro ao renomear a pasta remota de "${oldName}" para "${newName}":`, e);
      throw e;
    } finally {
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
        owner: parsed.owner || "barramentob2b",
        repo: parsed.repo || "Postman",
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

  // `reviewed`: o push vem logo depois da tela de revisão (handleApplyDiff no
  // AppLayout). Não compara de novo — a pessoa acabou de decidir, e comparar
  // o resultado da mescla com o remoto reabriria a mesma tela sempre que algo
  // do GitHub tivesse sido recusado. A proteção continua: grava com o sha da
  // versão revisada, então se alguém enviou nesse meio tempo, dá 409.
  // `force`: "Overwrite GitHub with mine" — nem compara, nem respeita o sha
  // visto; o conteúdo daqui vence.
  async function handlePushEverything(collectionsOverride?: any, environmentsOverride?: any, options?: PushOptions) {
    if (!isConfigValid || !workspace) return;
    if (!requirePassphrase()) return;

    // `silent` é usado pelo auto-push disparado ao salvar uma única aba
    // (Ctrl+S / botão Save do request) — nesse caso não queremos travar a
    // tela inteira via `loading`/isBlocking, só impedir que outro
    // save/download pontual comece em paralelo. O botão "Push" explícito
    // do painel de sync continua usando `loading` normalmente.
    const silent = options?.silent ?? false;

    if (silent && singleOpBusy) {
      showStatus("error", "✗ Another save/download is already in progress. Wait for it to finish.");
      return;
    }

    const collectionsData = collectionsOverride !== undefined ? collectionsOverride : currentCollections;
    const environmentsData = environmentsOverride !== undefined ? environmentsOverride : currentEnvironments;

    if (silent) setSingleOp("Saving to GitHub..."); else setLoading(true);
    setPushConflict(null);

    try {
      const storage = client({ force: options?.force });

      const toArray = (data: any): any[] => (Array.isArray(data) ? data : data ? [data] : []);
      let collectionsToSend = toArray(collectionsData);
      let environmentsToSend = toArray(environmentsData);
      let incoming = 0;
      let keptMine: string[] = [];

      // Merge automático por item (onRebasePush): quem mexeu em OUTRAS
      // requests da mesma collection não trava mais o push — o que mudou lá
      // entra aqui, o que mudou aqui vai por cima, e só o que mudou dos dois
      // lados pede revisão. Pulado no push silencioso (vê só uma aba) e no
      // `force` (o conteúdo daqui vence por definição).
      const canRebase = !silent && !options?.force && !!onRebasePush;
      // Depois de uma revisão (`reviewed`) as collections já estão decididas
      // e não passam de novo pelo merge — mas os environments sim: sem isto,
      // o envio que segue a revisão gravava os environments daqui por cima
      // das variáveis que mudaram lá.
      if (canRebase && options?.reviewed) {
        try {
          const outcome = await rebaseOnRemote(storage, workspace, collectionsToSend, environmentsToSend, { environmentsOnly: true });
          if (outcome?.status === "push") {
            environmentsToSend = outcome.environments as any[];
            keptMine = outcome.keptMine ?? [];
          }
        } catch (e: any) {
          showStatus("error", `Push cancelled: ${e?.message ?? String(e)}`);
          return;
        }
      }
      if (canRebase && !options?.reviewed) {
        showStatus("info", "Checking GitHub for changes before sending...");
        try {
          const outcome = await rebaseOnRemote(storage, workspace, collectionsToSend, environmentsToSend);
          if (outcome?.status === "review") {
            showStatus("info", rebaseReviewMessage(workspace, outcome.conflicts));
            return;
          }
          if (outcome) {
            collectionsToSend = outcome.collections as any[];
            environmentsToSend = outcome.environments as any[];
            incoming = outcome.incoming;
            keptMine = outcome.keptMine ?? [];
          }
        } catch (e: any) {
          // Sem a leitura do GitHub não há merge — e enviar mesmo assim
          // gravaria a versão daqui por cima do que não deu pra ler.
          console.error("❌ Erro no merge automático antes do push:", e);
          showStatus("error", `Push cancelled: ${e?.message ?? String(e)}`);
          return;
        }
      } else if (!silent && !options?.reviewed && !options?.force && onCompareRemote) {
        // Sem merge automático: a checagem antiga, que abre a revisão.
        showStatus("info", "Checking GitHub for changes before sending...");
        try {
          const remote = await fetchRemoteWorkspace(storage, workspace);
          const { hasChanges } = onCompareRemote(workspace, remote.collections, remote.environments, true);
          if (hasChanges) {
            showStatus("info", "Found changes on GitHub — review before sending.");
            return;
          }
        } catch (e) {
          console.error("❌ Erro ao checar o remoto antes do push:", e);
          // Não trava o push: a checagem de versão no commit é a rede.
        }
      }

      showStatus("info", "Encrypting and sending files...");

      let result: Awaited<ReturnType<typeof runWorkspacePush>>;
      for (let attempt = 0; ; attempt++) {
        result = await runWorkspacePush(storage, {
          workspaceName: workspace,
          collections: collectionsToSend,
          environments: environmentsToSend,
          markers: currentMarkers ?? [],
          // Push silencioso (de UMA aba) não vê o workspace inteiro: calcular
          // "o que sobrou lá" com ele acusaria todo o resto como apagado.
          allowDeletes: !silent,
        });
        // Alguém enviou entre a checagem e o commit: refaz o merge (de
        // collections e environments) em cima da versão nova.
        if (result.status !== "conflict" || !canRebase || attempt >= 2) break;
        const outcome = await rebaseOnRemote(storage, workspace, collectionsToSend, environmentsToSend);
        if (!outcome) break;
        if (outcome.status === "review") {
          showStatus("info", rebaseReviewMessage(workspace, outcome.conflicts));
          return;
        }
        collectionsToSend = outcome.collections as any[];
        environmentsToSend = outcome.environments as any[];
        incoming += outcome.incoming;
        keptMine = outcome.keptMine ?? keptMine;
      }

      if (result.status === "collision") {
        showStatus("error", result.message);
        return;
      }
      if (result.status === "conflict") {
        setPushConflict(result.paths);
        showStatus("error", conflictMessage(result.paths));
        // Abre a mesma revisão do Pull, marcada como parte do push — depois
        // de mesclar, o AppLayout reenvia sozinho (handleApplyDiff).
        if (onCompareRemote) {
          try {
            const remote = await fetchRemoteWorkspace(storage, workspace);
            onCompareRemote(workspace, remote.collections, remote.environments, true);
          } catch (e) {
            console.error("❌ Erro ao buscar o remoto pra revisão do conflito:", e);
          }
        }
        return;
      }

      if (silent) {
        // Só ADICIONA: o push de uma aba não diz nada sobre os outros arquivos.
        setCollectionPaths((prev) => Array.from(new Set([...prev, ...result.collectionPaths])));
        setEnvPaths((prev) => Array.from(new Set([...prev, ...result.envPaths])));
        showStatus("success", "Saved and sent to GitHub.");
        return;
      }

      setCollectionPaths(result.collectionPaths);
      setEnvPaths(result.envPaths);
      if (result.keptStale.length > 0) {
        showStatus("info", keptStaleMessage(workspace, result.keptStale.length));
        return;
      }
      onPushCompleted?.(workspace, { collections: collectionsToSend, environments: withoutSessionTokens(environmentsToSend) });
      showStatus("success", pushedMessage(workspace, result.removed.length, incoming, keptMine));
    } catch (e: any) {
      console.error("❌ Erro no Push:", e);
      showStatus("error", `Push failed: ${e.message}`);
    } finally {
      if (silent) setSingleOp(null); else setLoading(false);
    }
  }

  async function handlePushSingleEnvironment(env: any) {
  if (!isConfigValid || !workspace) {
    showStatus("error", "✗ Configure GitHub and select a workspace before syncing.");
    throw new Error("GitHub not configured or no workspace selected.");
  }
  if (!requirePassphrase()) {
    throw new MissingPassphraseError();
  }

  // Não usa `loading` (que travaria a tela inteira via isBlocking) — só
  // impede que outro save/pull pontual comece em paralelo.
  if (singleOpBusy) {
    showStatus("error", "✗ Another save/download is already in progress. Wait for it to finish.");
    throw new Error("Another sync is already in progress.");
  }

  setSingleOp(`Sending environment "${env.name}"...`);
  showStatus("info", `Sending environment "${env.name}"...`);

  try {
    const storage = client();
    const targetEnvPath = environmentFilePath(remotePath, env);

    // Nome do arquivo sai do nome em minúsculas: "TST" e "tst" (ou "env tst"
    // e "env-tst") viram o MESMO arquivo, e um sobrescreveria o outro. O push
    // do workspace já barrava isso; o de um environment não.
    const allEnvironments: any[] = Array.isArray(currentEnvironments) ? currentEnvironments : [];
    const twin = allEnvironments.find(
      (other) => other?.id && other.id !== env?.id && environmentFilePath(remotePath, other) === targetEnvPath
    );
    if (twin) {
      throw new Error(
        `"${env.name}" and "${twin.name}" are too similar and would overwrite each other on GitHub. Rename one of them first.`
      );
    }

    // Renomear o environment e enviar só ele deixava o arquivo do nome antigo
    // no GitHub — e ele voltava no próximo pull. Pergunta antes, pra a
    // exclusão entrar no mesmo commit.
    const expected = new Set(allEnvironments.map((other) => environmentFilePath(remotePath, other)));
    const stale = envPaths.filter((path) => path !== targetEnvPath && !expected.has(path));
    const removed = stale.length > 0 && (await askDeleteConfirmation(stale)) ? stale : [];

    const result = await storage.commitFiles(
      // Token de sessão (OAuth2) não sobe: é de cada pessoa e expira (lib/jwt).
      [{ path: targetEnvPath, content: withoutSessionTokens([env])[0] }, ...removed.map((path) => ({ path, delete: true }))],
      `sync(${workspace}): environment "${env.name || "environment"}"${removed.length > 0 ? `, ${removed.length} file(s) removed` : ""}`
    );
    if (!result.ok) throw new GitHubConflictError(result.conflicts[0]);

    setEnvPaths(prev => [...prev.filter((p) => !removed.includes(p)), ...(prev.includes(targetEnvPath) ? [] : [targetEnvPath])]);
    showStatus("success", `Environment "${env.name}" pushed to GitHub.`);
  } catch (e: any) {
    if (e instanceof GitHubConflictError) {
      showStatus("error", `"${env.name}" was changed on GitHub by someone else. Nothing was pushed — review the changes to merge them.`);
    } else {
      showStatus("error", `Push failed: ${e.message}`);
    }
    throw e;
  } finally {
    setSingleOp(null);
  }
}

  // Envia UMA collection. Espelha o handlePushSingleEnvironment logo acima —
  // o layout remoto já é um arquivo por collection, então o seletivo é só
  // escolher qual arquivo escrever, sem mudança de formato.
  //
  // O que este caminho deliberadamente NÃO faz é o cálculo de arquivos
  // "órfãos" do handlePushEverything, que compara o remoto com a lista local
  // inteira e propõe apagar o que sobra. Aqui a lista local em jogo é de UMA
  // collection, então esse cálculo concluiria que todas as outras precisam
  // ser apagadas. É o mesmo motivo pelo qual o push silencioso do Ctrl+S
  // pula essa etapa.
  async function handlePushSingleCollection(col: CollectionItem, options?: { partOf?: string }) {
    const partOf = options?.partOf;
    if (!isConfigValid || !workspace) {
      showStatus("error", "✗ Configure GitHub and select a workspace before syncing.");
      throw new Error("GitHub not configured or no workspace selected.");
    }
    if (!requirePassphrase()) {
      throw new MissingPassphraseError();
    }

    if (singleOpBusy) {
      showStatus("error", "✗ Another save/download is already in progress. Wait for it to finish.");
      throw new Error("Another sync is already in progress.");
    }

    // Só `name`: aqui a collection vem da árvore, que é CollectionItem. O
    // `info.name` que o handlePushEverything também aceita é do formato
    // Postman, que não chega por este caminho.
    //
    // O nome do arquivo sai do nome da collection, igual ao push completo —
    // tem que ser exatamente a mesma regra, senão renomear e enviar pelo menu
    // criaria um arquivo novo no remoto em vez de atualizar o existente.
    const rawName = col?.name || "collection";
    const targetPath = collectionFilePath(remotePath, col);

    // Mesmo risco do push completo: duas collections com nomes parecidos
    // (ex. "API's Tests" e "API S Tests") viram o MESMO arquivo — e como os
    // ids são diferentes, o GitHub nunca vê isso como conflito.
    const allCollections: CollectionItem[] = Array.isArray(currentCollections) ? currentCollections : [];
    const siblingCollision = allCollections.find(
      (c) => c?.id && c.id !== col?.id && collectionFilePath(remotePath, c) === targetPath
    );
    if (siblingCollision) {
      showStatus(
        "error",
        `Push cancelled: "${rawName}" and "${siblingCollision.name}" are too similar and would overwrite each other on GitHub. Rename one of them first.`
      );
      throw new Error("Collection name collides with another collection in this workspace.");
    }

    const what = partOf ? `"${partOf}" (in "${rawName}")` : `"${rawName}"`;
    setSingleOp(`Sending ${what}...`);
    showStatus("info", `Sending ${what}...`);

    try {
      const storage = client();

      // Renomear esta collection e enviar só ela deixava o arquivo do nome
      // ANTIGO órfão no remoto. Path conhecido que não corresponde a NENHUMA
      // collection local é candidato; pergunta ANTES, pra a exclusão entrar
      // no mesmo commit do envio.
      const expectedPaths = new Set(allCollections.map((c) => collectionFilePath(remotePath, c)));
      // Envio de um item só não mexe em outros arquivos.
      const stalePaths = partOf ? [] : collectionPaths.filter((p) => p !== targetPath && !expectedPaths.has(p));
      const removed = stalePaths.length > 0 && (await askDeleteConfirmation(stalePaths)) ? stalePaths : [];

      // O catálogo de marcadores é do workspace, não da collection — sobe
      // junto, no mesmo commit, senão renomear/recolorir um marcador só
      // chegaria ao GitHub num push do workspace inteiro.
      const markersToSend = catalogForPush(currentMarkers ?? [], await fetchRemoteMarkers(storage, remotePath), await loadSyncBase(workspace));
      const result = await storage.commitFiles(
        [
          { path: targetPath, content: stripStarredFlags(col) },
          {
            path: markersFilePath(remotePath),
            content: { markers: markersToSend },
            noCheck: true,
          },
          ...removed.map((path) => ({ path, delete: true })),
        ],
        partOf
          ? `sync(${workspace}): "${partOf}" in collection "${rawName}"`
          : `sync(${workspace}): collection "${rawName}"${removed.length > 0 ? `, ${removed.length} file(s) removed` : ""}`
      );
      // Quem chamou (AppLayout) abre a revisão ao ver o conflito.
      if (!result.ok) throw new GitHubConflictError(result.conflicts[0]);
      await recordSyncBase(workspace, markerBaseHashes(markersToSend), [MARKER_BASE_PREFIX]);

      setCollectionPaths(prev =>
        [...prev.filter((p) => !removed.includes(p)), ...(prev.includes(targetPath) ? [] : [targetPath])]
      );
      if (partOf) {
        showStatus("success", `"${partOf}" pushed to GitHub. Your other changes in "${rawName}" are still waiting to be pushed.`);
      } else {
        onCollectionPushed?.(col?.id, col);
        showStatus("success", `Collection "${rawName}" pushed to GitHub.`);
      }
    } catch (e) {
      if (e instanceof GitHubConflictError) {
        // Sem setPushConflict: aquele aviso oferece trocar o workspace
        // inteiro, desproporcional pra quem enviou UMA collection. A
        // revisão abre em seguida (AppLayout.handlePushCollection).
        showStatus("error", `"${rawName}" was changed on GitHub by someone else. Nothing was pushed — review the changes first.`);
      } else {
        showStatus("error", `Push failed: ${(e as Error)?.message ?? String(e)}`);
      }
      throw e;
    } finally {
      setSingleOp(null);
    }
  }

  // Busca o remoto e manda comparar — sem aplicar nada. A interpretação é do
  // AppLayout (só lá o formato remoto vira árvore, via importData), aqui só
  // se sabe baixar.
  async function handleCheckRemoteUpdates() {
    if (!isConfigValid || !workspace || !onCompareRemote) return;
    if (!requirePassphrase()) return;

    if (singleOpBusy) {
      showStatus("error", "✗ Another save/download is already in progress. Wait for it to finish.");
      return;
    }

    setSingleOp("Checking GitHub...");
    try {
      const remote = await fetchRemoteWorkspace(client(), workspace);
      if (remote.collectionPaths.length === 0 && remote.envPaths.length === 0) {
        showStatus("info", `Nothing found for "${workspace}" on GitHub yet.`);
        return;
      }
      const { summary } = onCompareRemote(workspace, remote.collections, remote.environments);
      // Arquivo que não baixou não pode passar por "igual ao local": seria
      // dizer que não há novidade justamente onde não se conseguiu olhar.
      showStatus(
        remote.failedPaths.length > 0 ? "error" : "info",
        remote.failedPaths.length > 0
          ? `${summary} — ${remote.failedPaths.length} file(s) could not be read.`
          : summary
      );
    } catch (e) {
      showStatus("error", `✗ Could not check GitHub: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setSingleOp(null);
    }
  }

  async function handleReloadAfterConflict() {
    setPushConflict(null);
    await handlePullEverything();
  }

  // "Sobrescrever": tenta o MESMO push de novo. putFile busca o sha atual a
  // cada chamada (getFileSha), então o reenvio pega o sha de quem escreveu
  // por cima e o 409 não se repete — o conteúdo daqui vence, descartando o
  // que a outra pessoa gravou. Mesmos dados de antes (currentCollections/
  // currentEnvironments, sem override), já que nada local mudou desde a
  // tentativa que esbarrou no conflito.
  async function handleOverwriteAfterConflict() {
    setPushConflict(null);
    await handlePushEverything(undefined, undefined, { force: true });
  }

  // Reabre a tela de revisão — pro caso de o conflito já ter aberto ela
  // automaticamente (handlePushEverything chama onCompareRemote na hora) e a
  // pessoa ter fechado sem decidir nada. Mesma busca, só que manual.
  async function handleReviewConflict() {
    if (!onCompareRemote) return;
    try {
      const storage = client();
      const remote = await fetchRemoteWorkspace(storage, workspace);
      onCompareRemote(workspace, remote.collections, remote.environments, true);
    } catch (e) {
      showStatus("error", `✗ Could not read GitHub: ${(e as Error)?.message ?? String(e)}`);
    }
  }

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

      for (let i = 0; i < folders.length; i++) {
        const folder = folders[i];
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

      if (failedWorkspaces.length > 0) {
        showStatus(
          "error",
          `⚠ ${folders.length - failedWorkspaces.length}/${folders.length} workspaces downloaded successfully. Failed: ${failedWorkspaces.join(", ")}`
        );
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
      setLoading(false);
    }
  }

useImperativeHandle(ref, () => ({
  push: (collectionsOverride?: any, environmentsOverride?: any, options?: PushOptions) =>
  handlePushEverything(collectionsOverride, environmentsOverride, options),
  pushEnvironment: (env: any) => handlePushSingleEnvironment(env),
  pushCollection: (collection: CollectionItem, options?: { partOf?: string }) =>
    handlePushSingleCollection(collection, options),
  fetchWorkspace: async (workspaceName: string, ref?: string, statusLabel?: string) => {
    if (!statusLabel) return fetchRemoteWorkspace(client(), workspaceName, ref);
    setSingleOp(statusLabel);
    try {
      return await fetchRemoteWorkspace(client(), workspaceName, ref);
    } finally {
      setSingleOp(null);
    }
  },
  isSynced: () => collectionPaths.length > 0 || envPaths.length > 0,
  pullWorkspace: (workspaceName: string) => pullSingleWorkspace(workspaceName),
  pushWorkspace: (workspaceName: string, options?: PushOptions) => pushSingleWorkspace(workspaceName, options),
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
    const fetched = lastFetched.get(`${storage.repoKey}|${workspaceName}`);
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

  return (
    <>
      {/* As duas pílulas vão por portal pro <body>: dentro do painel, um
          ancestral com transform vira a referência do `fixed`, e o aviso
          aparecia deslocado em vez de no centro da janela. */}
      {isBlocking && typeof document !== "undefined" && createPortal(
        // No topo ela dividia espaço com a barra de abas e ficava fácil de
        // não notar — bloqueante merece ocupar o centro, igual um diálogo,
        // com o fundo escurecido deixando claro que o app pausou pra isso.
        <div className="fixed inset-0 z-[9999] select-none flex items-center justify-center bg-black/20 backdrop-blur-[2px]">
          <div className="flex items-center gap-3 pl-3.5 pr-6 py-3.5 bg-pm-surface/95 border border-pm-border rounded-full ring-1 ring-pm-border/40 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="relative w-5 h-5 flex-shrink-0">
              <div className="absolute inset-0 border-2 border-pm-border rounded-full" />
              <div className="absolute inset-0 border-2 border-transparent border-t-[#007acc] rounded-full animate-spin" />
            </div>
            <span className="text-[13px] font-medium text-pm-text whitespace-nowrap">
              {resolvingFiles ? "Syncing workspace..." : "Processing..."}
            </span>
          </div>
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
          <div className="flex items-center gap-3 pl-3.5 pr-6 py-3.5 bg-pm-surface/95 border border-pm-border rounded-full shadow-[0_8px_28px_-6px_rgba(0,0,0,0.55)] ring-1 ring-pm-border/40 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150">
            <div className="relative w-5 h-5 flex-shrink-0">
              <div className="absolute inset-0 border-2 border-pm-border rounded-full" />
              <div className="absolute inset-0 border-2 border-transparent border-t-[#007acc] rounded-full animate-spin" />
            </div>
            <span className="text-[13px] font-medium text-pm-text whitespace-nowrap">
              {singleOp}
            </span>
          </div>
        </div>,
        document.body
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
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
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
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
                  ? `1 file will be permanently removed from "${remotePath}" in the repository:`
                  : `${pendingDeleteWorkspace.files.length} files will be permanently removed from "${remotePath}" in the repository:`}
              </p>
              <ul className="max-h-[140px] overflow-y-auto text-[11.5px] text-pm-text-secondary bg-pm-hover/60 border border-pm-border rounded-md p-2 list-disc list-inside">
                {pendingDeleteWorkspace.files.map((f) => (
                  <li key={f.path} className="truncate">{f.path.replace(`${remotePath}/`, "")}</li>
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

      {pendingPullConfirm && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <ModalCard className="w-[380px]" onClose={() => resolvePendingPullConfirm(false)} closeLabel="Cancel">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-pm-border">
              <span className="w-[22px] h-[22px] rounded-md bg-amber-500/15 text-amber-400 flex items-center justify-center">
                <MissingDotIcon />
              </span>
              <span className="text-[13px] font-semibold text-pm-text">
                Overwrite local changes?
              </span>
            </div>

            <div className="px-4 py-3 flex flex-col gap-2">
              <p className="text-[12px] text-pm-text-muted leading-relaxed">
                You have local changes that haven&apos;t been pushed to GitHub yet.
                This downloads every workspace in the repository and replaces your
                local collections and environments — there is no merge.
              </p>
              <p className="text-[11px] text-amber-400/90">
                Unsaved/unpushed local changes will be lost.
              </p>
              {/* Esta ação cobre TODOS os workspaces, e a tela de comparação
                  trabalha sobre o que está aberto — daí apontar o caminho em
                  vez de oferecer o botão aqui. */}
              {(onPullWithReview || onCompareRemote) && (
                <p className="text-[11px] text-pm-text-muted">
                  To pick what changes instead, cancel and use{' '}
                  <strong className="font-semibold">Pull</strong> — it shows
                  GitHub&apos;s changes to this workspace before applying anything.
                </p>
              )}
            </div>

            <div className="flex gap-2 px-4 py-3 border-t border-pm-border bg-pm-hover/20">
              <button
                className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text hover:bg-pm-row-active hover:text-pm-text transition-colors"
                onClick={() => resolvePendingPullConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border-none bg-rose-600 text-white hover:bg-rose-500 transition-colors"
                onClick={() => resolvePendingPullConfirm(true)}
              >
                Overwrite and pull
              </button>
            </div>
          </ModalCard>
        </div>
      )}

      {pendingSinglePullConfirm && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <ModalCard className="w-[380px]" onClose={() => resolvePendingSinglePullConfirm(false)} closeLabel="Cancel">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-pm-border">
              <span className="w-[22px] h-[22px] rounded-md bg-amber-500/15 text-amber-400 flex items-center justify-center">
                <MissingDotIcon />
              </span>
              <span className="text-[13px] font-semibold text-pm-text">
                Overwrite local changes?
              </span>
            </div>

            <div className="px-4 py-3 flex flex-col gap-2">
              <p className="text-[12px] text-pm-text-muted leading-relaxed">
                &quot;{pendingSinglePullConfirm}&quot; has local changes that haven&apos;t
                been pushed to GitHub yet. Pull replaces this workspace&apos;s local
                data with the remote version, all at once.
              </p>
              <p className="text-[11px] text-amber-400/90">
                Unsaved/unpushed local changes will be lost.
              </p>
            </div>

            <div className="flex flex-col gap-2 px-4 py-3 border-t border-pm-border bg-pm-hover/20">
              {/* Primário de propósito: comparar antes é estritamente mais
                  seguro que substituir, e até existir essa tela o usuário não
                  tinha escolha a não ser aceitar a perda. */}
              {onCompareRemote && (
                <button
                  className="h-[32px] rounded-md text-xs font-semibold cursor-pointer border-none bg-[#007acc] text-white hover:bg-[#1a8ad4] transition-colors"
                  onClick={() => {
                    resolvePendingSinglePullConfirm(false);
                    void handleCheckRemoteUpdates();
                  }}
                >
                  Review changes first
                </button>
              )}
              <div className="flex gap-2">
                <button
                  className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text hover:bg-pm-row-active hover:text-pm-text transition-colors"
                  onClick={() => resolvePendingSinglePullConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border-none bg-rose-600 text-white hover:bg-rose-500 transition-colors"
                  onClick={() => resolvePendingSinglePullConfirm(true)}
                >
                  Overwrite and pull
                </button>
              </div>
            </div>
          </ModalCard>
        </div>
      )}

      {/* Histórico de commits do workspace — escolher qual versão baixar */}
      {commitHistoryWorkspace && (
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm"
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
          <FolderGit2 size={17} className="text-pm-text-muted" />
          {/* Salvar é local: esse ponto é o que avisa que existe conteúdo
              gravado aqui que ainda não subiu pro GitHub. */}
          {hasPendingPush && (
            <span className="absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full bg-amber-400 ring-2 ring-pm-bg" />
          )}
          {/* Embaixo, em azul: novidade no GitHub (visto na última abertura
              do painel). Ponto separado do de cima pra os dois não se
              confundirem — um é "envie", o outro é "baixe". */}
          {!!behindCount && (
            <span className="absolute -bottom-0.5 -right-0.5 w-[7px] h-[7px] rounded-full bg-sky-400 ring-2 ring-pm-bg" />
          )}
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
                    placeholder="voeazul"
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
                    placeholder="middleware-b2b"
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
                        setPushConflict(null);
                      }}
                      className="shrink-0 -mr-0.5 -mt-0.5 h-5 w-5 flex items-center justify-center rounded opacity-70 hover:opacity-100 hover:bg-black/20 cursor-pointer border-none bg-transparent text-current"
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                      </svg>
                    </button>
                  </span>

                  {pushConflict && (
                    <div className="flex flex-col gap-1.5">
                      <ul className="max-h-[100px] overflow-y-auto text-[11px] text-rose-300/90 bg-black/20 border border-rose-500/20 rounded-md p-1.5 list-disc list-inside">
                        {pushConflict.map((p) => (
                          <li key={p} className="truncate">{p.split("/").pop()}</li>
                        ))}
                      </ul>
                      {/* A revisão já abriu sozinha quando o conflito aconteceu
                          (ver handlePushEverything); este botão é só pra
                          reabrir se ela tiver sido fechada sem decidir. */}
                      {/* Três saídas, e só uma não perde nada: ela vem primeiro e
                          com destaque. As outras duas apagam o trabalho de
                          alguém — cada uma diz de QUEM, logo abaixo do botão. */}
                      <div className="flex flex-col gap-1.5">
                        <button
                          type="button"
                          className="inline-flex items-center justify-center gap-1.5 h-[28px] px-2.5 rounded-md text-[11px] font-semibold cursor-pointer border-none bg-[#007acc] text-white hover:bg-[#1a8ad4] transition-colors"
                          onClick={handleReviewConflict}
                        >
                          Review &amp; merge
                        </button>
                        <p className="-mt-0.5 text-[10px] text-pm-text-muted leading-snug">
                          Recommended — see both versions, pick per item, then push. Nothing is lost.
                        </p>

                        <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                          <div className="flex flex-col gap-0.5">
                            <button
                              type="button"
                              className="inline-flex items-center justify-center gap-1 h-[26px] px-2 rounded-md text-[10.5px] font-semibold cursor-pointer border border-rose-500/40 bg-transparent text-rose-300 hover:bg-rose-500/15 transition-colors"
                              onClick={handleOverwriteAfterConflict}
                            >
                              Overwrite GitHub
                            </button>
                            <span className="text-[9.5px] text-rose-300/70 leading-snug">
                              Pushes yours as is. <strong className="font-semibold">Their</strong> changes are lost.
                            </span>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <button
                              type="button"
                              className="inline-flex items-center justify-center gap-1 h-[26px] px-2 rounded-md text-[10.5px] font-semibold cursor-pointer border border-rose-500/40 bg-transparent text-rose-300 hover:bg-rose-500/15 transition-colors"
                              onClick={handleReloadAfterConflict}
                            >
                              <RefreshIcon /> Discard mine
                            </button>
                            <span className="text-[9.5px] text-rose-300/70 leading-snug">
                              Replaces this workspace with GitHub&apos;s. <strong className="font-semibold">Your</strong> unpushed changes are lost.
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* O antigo Pull: todos os workspaces, substituindo o local sem
                  mescla. Continua existindo (é o jeito de trazer workspaces
                  que ainda não existem aqui), mas como ação à parte e com
                  nome que diz o que faz. */}
              {onPullWithReview && (
                <button
                  type="button"
                  onClick={handlePullAllWorkspacesClick}
                  disabled={loading || singleOpBusy || !isConfigValid}
                  title="Downloads every workspace in the repository and replaces the local copies — no review, no merge"
                  className="self-start text-[11px] text-pm-text-muted hover:text-pm-text hover:underline cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline -mt-0.5"
                >
                  Replace all local workspaces with GitHub…
                </button>
              )}

              {onPushPreview && (
                <button
                  type="button"
                  onClick={onPushPreview}
                  disabled={loading || singleOpBusy || !canSync}
                  title="What the push would send and bring in — nothing is sent"
                  className="self-start text-[11px] text-pm-text-muted hover:text-pm-text hover:underline cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline -mt-0.5"
                >
                  Preview push…
                </button>
              )}

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
                <span className={resolvingFiles ? "animate-spin" : ""}>
                  <RefreshIcon />
                </span>
              </button>

              {/* Buscar sem aplicar. Antes só existia o Pull, que substitui a
                  árvore — pra saber se havia novidade era preciso aceitá-la.
                  Com o Pull revisado, os dois fariam a mesma coisa: some. */}
              {onCompareRemote && !onPullWithReview && (
                <button
                  className="inline-flex items-center justify-center h-[32px] px-2.5 rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text transition-colors hover:bg-pm-row-active disabled:opacity-35 disabled:cursor-not-allowed"
                  disabled={loading || singleOpBusy || !isConfigValid || !workspace}
                  title="Check what changed on GitHub without applying anything"
                  onClick={handleCheckRemoteUpdates}
                >
                  <SearchIcon />
                </button>
              )}

              {onPullWithReview ? (
                <button
                  className="flex-1 inline-flex items-center justify-center gap-1.5 h-[32px] px-3 rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text transition-colors hover:bg-pm-row-active hover:text-pm-text hover:border-pm-border disabled:opacity-35 disabled:cursor-not-allowed"
                  disabled={loading || singleOpBusy || !canSync}
                  title={`Get GitHub's changes to "${workspace}" — you review them before anything changes here`}
                  onClick={() => { void onPullWithReview(); }}
                >
                  <PullIcon /> Pull{!!behindCount && <span className="text-sky-300 tabular-nums">({behindCount})</span>}
                </button>
              ) : (
                <button
                  className="flex-1 inline-flex items-center justify-center gap-1.5 h-[32px] px-3 rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text transition-colors hover:bg-pm-row-active hover:text-pm-text hover:border-pm-border disabled:opacity-35 disabled:cursor-not-allowed"
                  disabled={loading || !isConfigValid}
                  title="Downloads every workspace found in the repository"
                  onClick={handlePullAllWorkspacesClick}
                >
                  <PullIcon /> Pull
                </button>
              )}

              <button
                className="flex-1 inline-flex items-center justify-center gap-1.5 h-[32px] px-3 rounded-md text-xs font-semibold cursor-pointer border-none bg-[#007acc] text-white transition-colors hover:bg-[#1a8ad4] disabled:opacity-35 disabled:cursor-not-allowed"
                disabled={loading || !canSync}
                title={workspace ? `Send "${workspace}" to GitHub — if GitHub has changes you don't have, you review them first` : undefined}
                onClick={() => handlePushEverything()}
              >
                <PushIcon /> Push{aheadCount > 0 && <span className="text-white/80 tabular-nums">({aheadCount})</span>}
              </button>

              
            </div>
          </div>
        )}
      </div>
    </>
  );
});

export default GitHubSync;
