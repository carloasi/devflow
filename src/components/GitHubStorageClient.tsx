"use client";

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { saveSecret, getSecret, deleteSecret } from '@/lib/secureStorage'
import { FolderGit2 } from "lucide-react";
import { storeGet, storeSet } from "@/lib/tauriStore";
import { toast } from "sonner";
import { loadWorkspaceLocalData } from "@/storage/localSyncStore";
import type { CollectionItem } from '@/app/types/CollectionItem';
import { stripStarredFlags } from "@/components/collection-tree/utils/tree.utils";
import { encryptData, decryptData, clearDerivedKeyCache, MissingPassphraseError } from "@/lib/syncCrypto";
import { diffCollection, diffEnvironment, fileTitle, prettyContent, FileChange } from "@/lib/commitDiff";
import { CommitChangesView } from "@/components/CommitChangesView";

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
}

// Um commit do histórico da pasta de um workspace — ver listCommits.
interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  date: string;
}

export interface GitHubSyncHandle {
  push: (collectionsOverride?: any, environmentsOverride?: any, options?: { silent?: boolean }) => Promise<void>;
  pushEnvironment: (env: any) => Promise<void>; // ✅ novo
  // Envia só uma collection, sem tocar nas demais nem propor exclusões.
  pushCollection: (collection: CollectionItem) => Promise<void>;
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
  pushWorkspace: (workspaceName: string) => Promise<void>; // ✅ novo — push de só um workspace
  // Abre a janela de histórico de commits do workspace, onde dá pra escolher
  // qual versão baixar (em vez de sempre pegar a mais recente).
  openCommitHistory: (workspaceName: string) => void;
}

interface GitHubSyncProps {
  workspace: string; // path local do workspace (ex: "MeuWorkspace"), dono é o AppLayout
  currentCollections: any;
  currentEnvironments: any;
  onPullCollections: (data: any) => void;
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
    rawEnvironments: any[]
  ) => void | Promise<void>;
  // Se true, existem abas com alterações não salvas (ou dados locais ainda
  // não enviados pro GitHub) — o Pull pergunta antes de sobrescrever.
  hasUnsyncedChanges?: boolean;
  // Se true, há conteúdo salvo localmente esperando push — mostra um ponto
  // no botão do sync pra isso não passar despercebido.
  hasPendingPush?: boolean;
  // Chamado após enviar UMA collection com sucesso, pra limpar a pendência
  // só dela — o onPushCompleted zera o workspace inteiro e aqui mentiria.
  onCollectionPushed?: (collectionId: string) => void;
  // Compara o remoto recém-buscado com o local e devolve o resumo. Mora no
  // AppLayout porque é lá que o formato remoto vira árvore (importData) e
  // que a árvore local existe — aqui só se sabe baixar.
  onCompareRemote?: (workspaceName: string, collections: unknown[], environments: unknown[]) => string;
  // Push de um workspace terminou com sucesso (local == remoto de novo).
  onPushCompleted?: (workspaceName: string) => void;
}

const GH_TOKEN_KEY = 'gh_sync_token'
// Senha de sincronização: deriva a chave que cifra o conteúdo enviado ao
// GitHub. Fica no armazenamento seguro do SO, junto do token.
const GH_PASSPHRASE_KEY = 'gh_sync_passphrase'

class GitHubConflictError extends Error {
  constructor(public path: string) {
    super(`Conflict: "${path}" was changed by someone else since your last pull.`);
    this.name = "GitHubConflictError";
  }
}

class GitHubStorageClient {
  private baseUrl = "https://api.github.com";
  constructor(private config: GitHubConfig, private passphrase: string | null) {}

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
    const rootFiles = await this.listDirectory(remotePathForWs, ref);

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
      const envFolderFiles = await this.listDirectory(envDirItem.path, ref);
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
  const items = await this.listDirectory(path);
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

  async listDirectory(path: string = "", ref?: string): Promise<RepoItem[]> {
    const targetUrl = `${this.repoUrl(path)}?ref=${encodeURIComponent(ref || this.config.branch)}`;
    try {
      const res = await tauriFetch(targetUrl, { method: "GET", headers: this.headers() });
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    if (!res.ok) throw new Error(`HTTP ${res.status} while downloading blob ${sha}`);
    const data = (await res.json()) as any;
    if (!data.content || data.encoding !== "base64") return "";
    return data.content as string;
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
        return null;
      }

      if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status}`);

      const metaData = (await metaRes.json()) as any;
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

  async putFile(path: string, content: any, message: string): Promise<void> {
    const targetUrl = this.repoUrl(path);
    try {
      const sha = await this.getFileSha(path);

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
        if (res.status === 409) {
          throw new GitHubConflictError(path);
        }
        const errBody = await res.json().catch(() => ({}));
        throw new Error(`HTTP ${res.status}${errBody.message ? `: ${errBody.message}` : ''}`);
      }
    } catch (err: any) {
      throw err;
    }
  }

  async deleteFile(path: string, message: string): Promise<void> {
    const targetUrl = this.repoUrl(path);
    try {
      const metaRes = await tauriFetch(
        `${targetUrl}?ref=${encodeURIComponent(this.config.branch)}`,
        { method: "GET", headers: this.headers() }
      );

      if (metaRes.status === 404) return;

      if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status}`);

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
        const errJson = (await res.json().catch(() => ({}))) as any;
        throw new Error(errJson.message || `HTTP ${res.status}`);
      }
    } catch (err: any) {
      throw err;
    }
  }
  
}

const WORKSPACES_ROOT = "Postman";

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
): Promise<{ collections: any[]; environments: any[]; failedPaths: string[] }> {
  const failedPaths: string[] = [];

  const collectionSettled = await Promise.allSettled(cPaths.map((p) => storage.getFile(p, ref)));
  const collections = collectionSettled
    .map((settled, i) => {
      if (settled.status === "rejected" || !settled.value || !settled.value.content) {
        failedPaths.push(cPaths[i]);
        return null;
      }
      return settled.value.content;
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
      let content = settled.value.content;
      if (typeof content === "string") {
        try { content = JSON.parse(content); } catch (e) {}
      }
      return Array.isArray(content) ? content : [content];
    })
    .filter((content) => content !== null)
    .flat();

  const environments = Array.from(
    new Map(rawEnvironments.map((env: any) => [env.id, env])).values()
  );

  return { collections, environments, failedPaths };
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
async function fetchRemoteWorkspace(
  storage: GitHubStorageClient,
  workspaceName: string,
  ref?: string
): Promise<RemoteWorkspaceData> {
  const wsRemotePath = `${WORKSPACES_ROOT}/${workspaceName}`;
  const { collectionPaths, envPaths } = await storage.resolveWorkspaceFilePaths(wsRemotePath, ref);

  const { collections, environments, failedPaths } = await downloadWorkspaceFilesData(
    storage,
    collectionPaths,
    envPaths,
    ref
  );

  return { collections, environments, collectionPaths, envPaths, failedPaths };
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
  onCollectionPushed,
  onCompareRemote,
  onPushCompleted,
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
    () => new GitHubStorageClient(config, passphrase || null),
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

  const AUTH_ERROR_MESSAGE = "✗ Your GitHub token is invalid or has expired. Update it in GitHub Sync settings to keep syncing.";

  const showStatus = (type: SyncStatus["type"], message: string) => {
    const isAuth = type === "error" && /HTTP 401\b/.test(message);
    const finalMessage = isAuth ? AUTH_ERROR_MESSAGE : message;

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
    const storage = client();
    for (const file of pendingDeleteWorkspace.files) {
      try {
        await storage.deleteFile(file.path, `sync: remove workspace remoto (${workspace})`);
      } catch (e: any) {
        console.warn(`⚠️ Falha ao remover ${file.path}:`, e.message);
      }
    }
    setPendingDeleteWorkspace(null);
    setCollectionPaths([]);
    setEnvPaths([]);
    showStatus("success", `✓ Workspace "${workspace}" removed from GitHub.`);
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

  // ── Resolve os arquivos remotos do workspace atual sempre que o
  //    workspace (prop, controlado pelo AppLayout) ou a config mudam.
  const resolveWorkspaceFiles = useCallback(async () => {
    if (!isConfigValid || !remotePath) {
      setCollectionPaths([]);
      setEnvPaths([]);
      return;
    }

    setResolvingFiles(true);
    try {
      const rootFiles = await client().listDirectory(remotePath);

      const collectionFiles = rootFiles.filter(
        (f) =>
          f.type === "file" &&
          /(\.postman_collection\.json|collection.*\.json)$/i.test(f.name)
      );

      const envDirItem = rootFiles.find(
        (f) => f.type === "dir" && f.name.toLowerCase() === "environments"
      );

      let foundEnvPaths: string[] = [];
      if (envDirItem) {
        const envFolderFiles = await client().listDirectory(envDirItem.path);
        foundEnvPaths = envFolderFiles
          .filter(
            (f) =>
              f.type === "file" &&
              /(\.postman_environment\.json|\.json)$/i.test(f.name)
          )
          .map((f) => f.path);
      }

      setCollectionPaths(collectionFiles.map((f) => f.path));
      setEnvPaths(foundEnvPaths);
    } catch (e: any) {
      console.error("❌ Erro ao resolver arquivos do workspace:", e);
      showStatus("error", `✗ Failed to fetch files: ${e.message}`);
    } finally {
      setResolvingFiles(false);
    }
  }, [isConfigValid, remotePath, client]);

  useEffect(() => {
    resolveWorkspaceFiles();
  }, [resolveWorkspaceFiles]);

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
              return settled.value.content;
            })
            .filter((content) => content !== null)
            .flat();

          if (loadedCollections.length > 0) {
            onPullCollections(loadedCollections);
          }
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
              let content = settled.value.content;
              if (typeof content === "string") {
                try { content = JSON.parse(content); } catch (e) {}
              }
              return Array.isArray(content) ? content : [content];
            })
            .filter((content) => content !== null)
            .flat();

          if (loadedEnvironments.length > 0) {
            const dedupedEnvironments = Array.from(
              new Map(loadedEnvironments.map((env: any) => [env.id, env])).values()
            );
            onPullEnvironments(dedupedEnvironments);
          } else {
            onPullEnvironments([]);
          }
        }

        if (failedPaths.length > 0) {
          showStatus(
            "error",
            `⚠ ${failedPaths.length} file(s) could not be downloaded: ${failedPaths.map((p) => p.split("/").pop()).join(", ")}`
          );
        } else {
          showStatus("success", "✓ Data updated and decrypted!");
        }
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

      // Buscar e aplicar agora são duas chamadas: a de cima só traz, esta
      // substitui o local. É a separação que a tela de comparação vai usar
      // pra se intrometer entre as duas.
      await onPullWorkspaceData?.(workspaceName, collections, environments);

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

      const { collections, environments, failedPaths } =
        await downloadWorkspaceFilesData(storage, cPaths, ePaths, sha);

      await onPullWorkspaceData?.(workspaceName, collections, environments);

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
  }, [isConfigValid, workspace, client, onPullWorkspaceData, showStatus]);

  // Push de um único workspace (por nome) — usado pelo ícone de push no menu
  // de workspaces (ao lado do Pull), sem precisar trocar pro workspace nem
  // enviar todos os outros junto. Carrega os dados locais do workspace ALVO
  // direto do storage (não de currentCollections/currentEnvironments, que só
  // refletem o workspace selecionado agora) e resolve os arquivos remotos
  // desse workspace pra saber o que é create/update e o que ficou obsoleto.
  const pushSingleWorkspace = useCallback(async (workspaceName: string) => {
    if (!isConfigValid) {
      showStatus("error", "✗ Configure GitHub sync before pushing.");
      return;
    }

    if (!requirePassphrase()) return;

    if (singleOpBusy) {
      showStatus("error", "✗ Another save/download is already in progress. Wait for it to finish.");
      return;
    }

    setSingleOp(`Sending "${workspaceName}"...`);
    showStatus("info", `Encrypting and sending "${workspaceName}"...`);

    try {
      const storage = client();
      const wsRemotePath = `${WORKSPACES_ROOT}/${workspaceName}`;
      const { collections, environments } = await loadWorkspaceLocalData(workspaceName);

      const collectionsToPush: any[] = Array.isArray(collections) ? collections : [];
      const envsToPush: any[] = Array.isArray(environments) ? environments : [];

      if (collectionsToPush.length === 0 && envsToPush.length === 0) {
        showStatus("info", `Nothing to push — "${workspaceName}" has no local collections or environments.`);
        return;
      }

      const { collectionPaths: existingCPaths, envPaths: existingEPaths } =
        await storage.resolveWorkspaceFilePaths(wsRemotePath);

      const newCollectionPaths: string[] = [];
      const newEnvPaths: string[] = [];
      const conflictPaths: string[] = [];

      for (const col of collectionsToPush) {
        if (!col) continue;
        const rawName = col?.name || "collection";
        const sanitized = rawName.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
        const targetPath = `${wsRemotePath}/${sanitized}.postman_collection.json`;
        try {
          await storage.putFile(targetPath, stripStarredFlags(col), `sync: update encrypted collection ${rawName} (${workspaceName})`);
          newCollectionPaths.push(targetPath);
        } catch (e: any) {
          if (e instanceof GitHubConflictError) {
            conflictPaths.push(targetPath);
            if (existingCPaths.includes(targetPath)) newCollectionPaths.push(targetPath);
          } else {
            throw e;
          }
        }
      }

      for (const env of envsToPush) {
        if (!env) continue;
        const envFileName = env.name
          ? `${env.name.toLowerCase().replace(/[^a-z0-9-_]/g, "-")}.postman_environment.json`
          : "environment.postman_environment.json";
        const targetEnvPath = `${wsRemotePath}/environments/${envFileName}`;
        try {
          await storage.putFile(targetEnvPath, env, `sync: update encrypted environment ${env.name || ""} (${workspaceName})`);
          newEnvPaths.push(targetEnvPath);
        } catch (e: any) {
          if (e instanceof GitHubConflictError) {
            conflictPaths.push(targetEnvPath);
            if (existingEPaths.includes(targetEnvPath)) newEnvPaths.push(targetEnvPath);
          } else {
            throw e;
          }
        }
      }

      if (workspaceName === workspace) {
        setCollectionPaths(newCollectionPaths);
        setEnvPaths(newEnvPaths);
      }

      if (conflictPaths.length > 0) {
        showStatus(
          "error",
          conflictPaths.length === 1
            ? `"${conflictPaths[0].split("/").pop()}" was updated by someone else on GitHub. Push again to overwrite, or pull first to merge manually.`
            : `${conflictPaths.length} files were updated by someone else on GitHub. Push again to overwrite, or pull first to merge manually.`
        );
        return;
      }

      const staleCollectionPaths = existingCPaths.filter((p) => !newCollectionPaths.includes(p));
      const staleEnvPaths = existingEPaths.filter((p) => !newEnvPaths.includes(p));
      const staleAll = [...staleCollectionPaths, ...staleEnvPaths];

      if (staleAll.length > 0) {
        const confirmed = await askDeleteConfirmation(staleAll);
        if (confirmed) {
          for (const staleCol of staleCollectionPaths) {
            try {
              await storage.deleteFile(staleCol, `sync: remove collection removida localmente (${workspaceName})`);
            } catch (e: any) {
              console.warn(`⚠️ Falha ao remover collection obsoleta ${staleCol}:`, e.message);
            }
          }
          for (const staleEnv of staleEnvPaths) {
            try {
              await storage.deleteFile(staleEnv, `sync: remove environment removido localmente (${workspaceName})`);
            } catch (e: any) {
              console.warn(`⚠️ Falha ao remover environment obsoleto ${staleEnv}:`, e.message);
            }
          }
        } else {
          showStatus("info", `"${workspaceName}" pushed — stale files were not removed.`);
          return;
        }
      }

      onPushCompleted?.(workspaceName);
      showStatus("success", `✓ "${workspaceName}" pushed to GitHub!`);
    } catch (e: any) {
      if (e instanceof MissingPassphraseError) {
        // A senha sumiu no meio (apagada nas settings): só avisa.
        requirePassphrase();
      } else {
        console.error(`❌ Erro ao enviar workspace "${workspaceName}":`, e);
        showStatus("error", `✗ Push failed: ${e.message}`);
      }
    } finally {
      setSingleOp(null);
    }
  }, [isConfigValid, workspace, client, showStatus, singleOpBusy, requirePassphrase]);

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

  async function handlePushEverything(collectionsOverride?: any, environmentsOverride?: any, options?: { silent?: boolean }) {
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
    showStatus("info", `Encrypting and sending files...`);

    try {
      const storage = client();

      const collectionsToPush: any[] = Array.isArray(collectionsData)
        ? collectionsData
        : collectionsData ? [collectionsData] : [];

      const newCollectionPaths: string[] = [];
      const conflictPaths: string[] = [];

      for (const col of collectionsToPush) {
        if (!col) continue;
        const rawName = col?.info?.name || col?.name || "collection";
        const sanitized = rawName.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
        const targetPath = `${remotePath}/${sanitized}.postman_collection.json`;

        try {
          await storage.putFile(
            targetPath, stripStarredFlags(col),
            `sync: update encrypted collection ${rawName} (${workspace})`
          );
          newCollectionPaths.push(targetPath);
        } catch (e: any) {
          if (e instanceof GitHubConflictError) {
            conflictPaths.push(targetPath);
            if (collectionPaths.includes(targetPath)) newCollectionPaths.push(targetPath);
          } else {
            throw e;
          }
        }
      }

      const envsToPush = Array.isArray(environmentsData)
        ? environmentsData
        : environmentsData ? [environmentsData] : [];

      const newEnvPaths: string[] = [];

      for (const env of envsToPush) {
        if (!env) continue;
        const envFileName = env.name
          ? `${env.name.toLowerCase().replace(/[^a-z0-9-_]/g, "-")}.postman_environment.json`
          : "environment.postman_environment.json";

        const targetEnvPath = `${remotePath}/environments/${envFileName}`;
        try {
          await storage.putFile(
            targetEnvPath, env,
            `sync: update encrypted environment ${env.name || ""} (${workspace})`
          );
          newEnvPaths.push(targetEnvPath);
        } catch (e: any) {
          if (e instanceof GitHubConflictError) {
            conflictPaths.push(targetEnvPath);
            if (envPaths.includes(targetEnvPath)) newEnvPaths.push(targetEnvPath);
          } else {
            throw e;
          }
        }
      }

      if (conflictPaths.length > 0) {
        setCollectionPaths(newCollectionPaths);
        setEnvPaths(newEnvPaths);
        setPushConflict(conflictPaths);
        showStatus(
          "error",
          conflictPaths.length === 1
            ? `"${conflictPaths[0].split("/").pop()}" was updated by someone else. Reload the latest version before saving again.`
            : `${conflictPaths.length} files were updated by someone else. Reload the latest version before saving again.`
        );
        return;
      }

      // Push silencioso (Ctrl+S / Save de UMA aba) NUNCA propõe apagar
      // arquivos remotos — nem sequer calcula "staleness" pra comparar. Bug
      // relatado: o modal "Remove files from the workspace?" (bloqueante,
      // full-screen) aparecia do nada pro usuário só porque ele salvou um
      // request, sem ele ter pedido nenhuma limpeza de workspace. A causa
      // raiz é que esse push silencioso só recebe os dados da(s) aba(s)
      // salva(s) — não necessariamente TODAS as collections/environments do
      // workspace — então comparar contra `collectionPaths`/`envPaths`
      // (a listagem completa do remoto) gera falsos positivos de "arquivo
      // removido localmente". A limpeza de arquivos obsoletos (com
      // confirmação) fica reservada ao botão "Push" explícito do painel de
      // sync, onde o usuário está deliberadamente revisando o workspace
      // inteiro.
      if (silent) {
        // Só ADICIONA aos paths conhecidos (pra badge/contagem "Synchronized
        // with GitHub" ficar correta se essa aba criou uma collection/env
        // nova) — nunca remove nada daqui, mesmo que essa aba não cubra
        // todos os arquivos que existem no workspace.
        setCollectionPaths(prev => Array.from(new Set([...prev, ...newCollectionPaths])));
        setEnvPaths(prev => Array.from(new Set([...prev, ...newEnvPaths])));
        showStatus("success", "✓ Saved and sent to GitHub!");
        return;
      }

      const staleCollectionPaths = collectionPaths.filter((p) => !newCollectionPaths.includes(p));
      const staleEnvPaths = envPaths.filter((p) => !newEnvPaths.includes(p));
      const staleAll = [...staleCollectionPaths, ...staleEnvPaths];

      if (staleAll.length > 0) {
        const confirmed = await askDeleteConfirmation(staleAll);
        if (!confirmed) {
          setCollectionPaths(newCollectionPaths);
          setEnvPaths(envPaths);
          showStatus("info", "Push complete — stale files were not removed.");
          return;
        }
      }

      for (const staleCol of staleCollectionPaths) {
        try {
          await storage.deleteFile(staleCol, `sync: remove collection removida localmente (${workspace})`);
        } catch (e: any) {
          console.warn(`⚠️ Falha ao remover collection obsoleta ${staleCol}:`, e.message);
        }
      }

      for (const staleEnv of staleEnvPaths) {
        try {
          await storage.deleteFile(staleEnv, `sync: remove environment removido localmente (${workspace})`);
        } catch (e: any) {
          console.warn(`⚠️ Falha ao remover environment obsoleto ${staleEnv}:`, e.message);
        }
      }

      setCollectionPaths(newCollectionPaths);
      setEnvPaths(newEnvPaths);
      onPushCompleted?.(workspace);

      const removedCount = staleCollectionPaths.length + staleEnvPaths.length;
      showStatus(
        "success",
        removedCount > 0
          ? `✓ Sent! ${removedCount} file(s) removed from the workspace.`
          : "✓ Files encrypted and sent to GitHub!"
      );
    } catch (e: any) {
      console.error("❌ Erro no Push:", e);
      showStatus("error", `✗ Push failed: ${e.message}`);
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
    const envFileName = env.name
      ? `${env.name.toLowerCase().replace(/[^a-z0-9-_]/g, "-")}.postman_environment.json`
      : "environment.postman_environment.json";
    const targetEnvPath = `${remotePath}/environments/${envFileName}`;

    await storage.putFile(
      targetEnvPath,
      env,
      `sync: update encrypted environment ${env.name || ""} (${workspace})`
    );

    setEnvPaths(prev => prev.includes(targetEnvPath) ? prev : [...prev, targetEnvPath]);
    showStatus("success", `✓ Environment "${env.name}" synced!`);
  } catch (e: any) {
    if (e instanceof GitHubConflictError) {
      showStatus("error", `"${env.name}" was updated by someone else. Reload before trying again.`);
    } else {
      showStatus("error", `✗ Sync failed: ${e.message}`);
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
  async function handlePushSingleCollection(col: CollectionItem) {
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
    const sanitized = rawName.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const targetPath = `${remotePath}/${sanitized}.postman_collection.json`;

    setSingleOp(`Sending "${rawName}"...`);
    showStatus("info", `Sending collection "${rawName}"...`);

    try {
      const storage = client();
      await storage.putFile(
        targetPath,
        stripStarredFlags(col),
        `sync: update encrypted collection ${rawName} (${workspace})`
      );

      setCollectionPaths(prev => (prev.includes(targetPath) ? prev : [...prev, targetPath]));
      onCollectionPushed?.(col?.id);
      showStatus("success", `✓ Collection "${rawName}" synced!`);
    } catch (e) {
      if (e instanceof GitHubConflictError) {
        // Sem setPushConflict aqui: aquele estado abre o aviso de "recarregue
        // antes de salvar" do push completo, que ofereceria um pull de tudo.
        // Num envio pontual isso é desproporcional — quem mandou uma
        // collection não pediu para substituir o workspace inteiro.
        showStatus("error", `"${rawName}" was updated by someone else. Pull the latest version before sending it again.`);
      } else {
        showStatus("error", `✗ Sync failed: ${(e as Error)?.message ?? String(e)}`);
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
      const summary = onCompareRemote(workspace, remote.collections, remote.environments);
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

  async function handlePullEverything() {
    if (!isConfigValid || !workspace) return;
    if (collectionPaths.length === 0 && envPaths.length === 0) {
      showStatus("error", `✗ No file found in the remote workspace.`);
      return;
    }
    await performPull(collectionPaths, envPaths);
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

          const { collections, environments, failedPaths } =
            await downloadWorkspaceFilesData(storage, cPaths, ePaths);

          await onPullWorkspaceData(folder.name, collections, environments);

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
  push: (collectionsOverride?: any, environmentsOverride?: any, options?: { silent?: boolean }) =>
  handlePushEverything(collectionsOverride, environmentsOverride, options),
  pushEnvironment: (env: any) => handlePushSingleEnvironment(env),
  pushCollection: (collection: CollectionItem) => handlePushSingleCollection(collection),
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
  pushWorkspace: (workspaceName: string) => pushSingleWorkspace(workspaceName),
  openCommitHistory: (workspaceName: string) => openCommitHistory(workspaceName),
}));

  const isBlocking = loading || resolvingFiles;

  return (
    <>
      {isBlocking && (
        <div className="fixed inset-0 z-[9999] select-none">
          <div className="fixed top-4 left-1/2 -translate-x-1/2 flex items-center gap-2.5 pl-2.5 pr-4 py-2 bg-pm-surface/95 border border-pm-border rounded-full shadow-[0_8px_28px_-6px_rgba(0,0,0,0.55)] ring-1 ring-pm-border/40 backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-150">
            <div className="relative w-4 h-4 flex-shrink-0">
              <div className="absolute inset-0 border-[1.5px] border-pm-border rounded-full" />
              <div className="absolute inset-0 border-[1.5px] border-transparent border-t-[#007acc] rounded-full animate-spin" />
            </div>
            <span className="text-[11.5px] font-medium text-pm-text whitespace-nowrap">
              {resolvingFiles ? "Syncing workspace..." : "Processing..."}
            </span>
          </div>
        </div>
      )}

      {/* Mesma pílula, para operações PONTUAIS (pull/push de um workspace,
          save silencioso, envio de um environment). Sem o `inset-0` da de
          cima de propósito: essas operações não travam o app, então o aviso
          não pode capturar cliques. Só aparece quando a bloqueante não está
          na tela, pra as duas nunca se sobreporem. */}
      {singleOp && !isBlocking && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] pointer-events-none select-none flex items-center gap-2.5 pl-2.5 pr-4 py-2 bg-pm-surface/95 border border-pm-border rounded-full shadow-[0_8px_28px_-6px_rgba(0,0,0,0.55)] ring-1 ring-pm-border/40 backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-150">
          <div className="relative w-4 h-4 flex-shrink-0">
            <div className="absolute inset-0 border-[1.5px] border-pm-border rounded-full" />
            <div className="absolute inset-0 border-[1.5px] border-transparent border-t-[#007acc] rounded-full animate-spin" />
          </div>
          <span className="text-[11.5px] font-medium text-pm-text whitespace-nowrap">
            {singleOp}
          </span>
        </div>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[380px] bg-pm-surface border border-pm-border rounded-xl shadow-2xl overflow-hidden font-sans">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-pm-border">
              <span className="w-[22px] h-[22px] rounded-md bg-rose-500/15 text-rose-400 flex items-center justify-center">
                <MissingDotIcon />
              </span>
              <span className="text-[13px] font-semibold text-pm-text">
                Remove files from the workspace?
              </span>
            </div>

            <div className="px-4 py-3 flex flex-col gap-2">
              <p className="text-[12px] text-pm-text-muted leading-relaxed">
                {pendingDelete.paths.length === 1
                  ? "1 file no longer exists locally and will be removed from the remote repository:"
                  : `${pendingDelete.paths.length} files no longer exist locally and will be removed from the remote repository:`}
              </p>
              <ul className="max-h-[140px] overflow-y-auto text-[11.5px] text-pm-text-secondary bg-pm-hover/60 border border-pm-border rounded-md p-2 list-disc list-inside">
                {pendingDelete.paths.map((p) => (
                  <li key={p} className="truncate">{p.split("/").pop()}</li>
                ))}
              </ul>
              <p className="text-[11px] text-amber-400/90">
                This action cannot be undone from the app.
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
          </div>
        </div>
      )}

      {pendingDeleteWorkspace && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[380px] bg-pm-surface border border-pm-border rounded-xl shadow-2xl overflow-hidden font-sans">
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
          </div>
        </div>
      )}

      {pendingPullConfirm && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[380px] bg-pm-surface border border-pm-border rounded-xl shadow-2xl overflow-hidden font-sans">
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
                Pull will download the remote version and replace your local
                collections and environments — there is no merge.
              </p>
              <p className="text-[11px] text-amber-400/90">
                Unsaved/unpushed local changes will be lost.
              </p>
              {/* Esta ação cobre TODOS os workspaces, e a tela de comparação
                  trabalha sobre o que está aberto — daí apontar o caminho em
                  vez de oferecer o botão aqui. */}
              {onCompareRemote && (
                <p className="text-[11px] text-pm-text-muted">
                  To pick what changes, pull one workspace at a time and choose
                  &quot;Review changes first&quot;.
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
          </div>
        </div>
      )}

      {pendingSinglePullConfirm && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[380px] bg-pm-surface border border-pm-border rounded-xl shadow-2xl overflow-hidden font-sans">
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
          </div>
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
            hasPendingPush
              ? "GitHub Sync — local changes waiting to be pushed"
              : "GitHub Sync"
          }
        >
          <FolderGit2 size={17} className="text-pm-text-muted" />
          {/* Salvar é local: esse ponto é o que avisa que existe conteúdo
              gravado aqui que ainda não subiu pro GitHub. */}
          {hasPendingPush && (
            <span className="absolute -top-0.5 -right-0.5 w-[7px] h-[7px] rounded-full bg-amber-400 ring-2 ring-pm-bg" />
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

                      {/* ✅ novo — badge de status */}
                      {!resolvingFiles && (
                        <div className="flex items-center gap-1.5">
                          {(collectionPaths.length > 0 || envPaths.length > 0) ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                              <CheckDotIcon /> Synchronized with GitHub
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-pm-hover text-pm-text-muted border border-pm-border">
                              only local
                            </span>
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
                  <span>{status.message}</span>

                  {pushConflict && (
                    <div className="flex flex-col gap-1.5">
                      <ul className="max-h-[100px] overflow-y-auto text-[11px] text-rose-300/90 bg-black/20 border border-rose-500/20 rounded-md p-1.5 list-disc list-inside">
                        {pushConflict.map((p) => (
                          <li key={p} className="truncate">{p.split("/").pop()}</li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        className="self-start inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-md text-[11px] font-semibold cursor-pointer border-none bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 transition-colors"
                        onClick={handleReloadAfterConflict}
                      >
                        <RefreshIcon /> Reload latest version
                      </button>
                    </div>
                  )}
                </div>
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
                onClick={resolveWorkspaceFiles}
              >
                <span className={resolvingFiles ? "animate-spin" : ""}>
                  <RefreshIcon />
                </span>
              </button>

              {/* Buscar sem aplicar. Antes só existia o Pull, que substitui a
                  árvore — pra saber se havia novidade era preciso aceitá-la. */}
              {onCompareRemote && (
                <button
                  className="inline-flex items-center justify-center h-[32px] px-2.5 rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text transition-colors hover:bg-pm-row-active disabled:opacity-35 disabled:cursor-not-allowed"
                  disabled={loading || singleOpBusy || !isConfigValid || !workspace}
                  title="Check what changed on GitHub without applying anything"
                  onClick={handleCheckRemoteUpdates}
                >
                  <SearchIcon />
                </button>
              )}

              <button
                className="flex-1 inline-flex items-center justify-center gap-1.5 h-[32px] px-3 rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text transition-colors hover:bg-pm-row-active hover:text-pm-text hover:border-pm-border disabled:opacity-35 disabled:cursor-not-allowed"
                disabled={loading || !isConfigValid}
                title="Downloads every workspace found in the repository"
                onClick={handlePullAllWorkspacesClick}
              >
                <PullIcon /> Pull
              </button>

              <button
                className="flex-1 inline-flex items-center justify-center gap-1.5 h-[32px] px-3 rounded-md text-xs font-semibold cursor-pointer border-none bg-[#007acc] text-white transition-colors hover:bg-[#1a8ad4] disabled:opacity-35 disabled:cursor-not-allowed"
                disabled={loading || !canSync}
                onClick={() => handlePushEverything()}
              >
                <PushIcon /> Push
              </button>

              
            </div>
          </div>
        )}
      </div>
    </>
  );
});

export default GitHubSync;
