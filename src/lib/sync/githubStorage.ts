import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { throwIfSyncCancelled } from "@/lib/sync/syncCenterStore";
import { encryptData, decryptData } from "@/lib/syncCrypto";
import { diffCollection, diffEnvironment, fileTitle, prettyContent, type FileChange } from "@/lib/commitDiff";
import { recordSyncedShas, repoKeyOf, type FileShas } from "@/lib/remoteVersions";
import { MARKERS_FILE } from "@/lib/sync/pushPlan";

// ─────────────────────────────────────────────────────────────────────────
// Cliente da API do GitHub do sync (leitura, escrita em um commit só, versão
// vista de cada arquivo). Separado do componente (GitHubStorageClient.tsx)
// pra poder ser testado sem React nem Tauri — ver githubStorage.test.ts.
// ─────────────────────────────────────────────────────────────────────────

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

export async function buildCommitIdentity(): Promise<{ name: string; email: string } | null> {
  const name = await getCommitterName();
  if (!name) return null;
  return { name, email: committerEmailFor(name) };
}

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface RepoItem {
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
  /**
   * Quando o commit entrou no GitHub (committer). A data do autor (`date`) é
   * a do relógio de quem criou o commit; pra decidir qual de dois arquivos é
   * o mais novo, vale esta.
   */
  committedAt?: string;
}

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
export function rateLimitErrorFrom(res: Response): GitHubRateLimitError | null {
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
export const seenShas = new Map<string, string>();

export class GitHubStorageClient {
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
  // Estrita: com o token vencido (ou sem acesso), a listagem que engolia o
  // erro dizia "nenhum workspace no repositório" em vez de "token inválido".
  const items = await this.listDirectoryStrict(basePath);
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
  // `peek`: só olhar (prévias, avisos). Não conta como "visto": a versão
  // vista é a que a checagem do push compara, e uma prévia que a
  // atualizasse deixava passar por cima uma mudança que ninguém revisou.
  async getFile(path: string, ref?: string, opts?: { peek?: boolean }): Promise<{ content: any; sha: string } | null> {
    const targetUrl = `${this.repoUrl(path)}?ref=${encodeURIComponent(ref || this.config.branch)}`;
    const remember = !ref && !opts?.peek;

    try {
      // Logo depois de um commit nosso, a Contents API ainda pode devolver a
      // versão anterior por alguns segundos — ou 404, num arquivo que o envio
      // acabou de criar. Numa prévia (Central, aviso de fundo) isso fazia o
      // que acabou de subir aparecer de novo em "Para enviar". Se este
      // arquivo foi gravado daqui há pouco, lê direto a versão gravada (pelo
      // sha do blob, que não muda), sem passar pela Contents API.
      const recent = !ref && opts?.peek ? recentWriteOf(this.repoKey, path) : undefined;
      const metaRes =
        typeof recent === "string" ? null : await tauriFetch(targetUrl, { method: "GET", headers: this.headers() });

      if (metaRes && metaRes.status === 404) {
        console.warn(`⚠️ Arquivo não encontrado (404): ${path}`);
        // Sumiu do remoto: a próxima gravação é uma criação, não uma
        // atualização da versão que se tinha visto antes.
        if (remember) this.rememberSha(path, undefined);
        return null;
      }

      if (metaRes && !metaRes.ok) throw rateLimitErrorFrom(metaRes) ?? new Error(`HTTP ${metaRes.status}`);

      const metaData = metaRes ? ((await metaRes.json()) as any) : { sha: recent };
      // Só a versão do topo da branch conta como "vista": ler um commit
      // antigo (histórico) não diz nada sobre o que está lá agora.
      if (remember) this.rememberSha(path, metaData?.sha);
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
      committedAt: c?.commit?.committer?.date ?? c?.commit?.author?.date ?? "",
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
        // O catálogo de marcadores também é .json, mas não é collection:
        // comparado como uma, o histórico mostrava um diff sem sentido.
        const kind: FileChange["kind"] = /\/environments\//i.test(filename)
          ? "environment"
          : filename.endsWith(`/${MARKERS_FILE}`)
            ? "other"
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
      // Sem o sha novo na resposta, o "visto" não é apagado: apagado, a
      // próxima gravação usava o sha ATUAL (getFileSha) e sobrescrevia sem
      // checar nada. Mantendo o antigo, no pior caso dá um conflito falso.
      if (written?.content?.sha) this.rememberSha(path, written.content.sha);
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
    // Segmento a segmento: uma branch "feature/x" é o caminho heads/feature/x
    // na rota da ref. Codificada inteira ("feature%2Fx"), a rota não acha a
    // branch.
    const branch = this.config.branch.split("/").map(encodeURIComponent).join("/");
    const writes = changes.filter((c) => !c.delete);
    const deletes = changes.filter((c) => c.delete);

    // "Cancelar" da Central: antes de mandar qualquer coisa.
    throwIfSyncCancelled();
    const head0 = await this.gitJson<{ object: { sha: string } }>(`/ref/heads/${branch}`);
    if (!head0.data) {
      // 409 = repositório ainda sem nenhum commit: só a Contents API cria o
      // primeiro. Qualquer outra resposta (404: branch que não existe, ou
      // token sem acesso ao repositório) é erro — cair no envio arquivo por
      // arquivo aqui fazia um commit por arquivo, sem a garantia de tudo ou
      // nada, e no fim falhava do mesmo jeito.
      if (head0.status === 409) return this.commitFilesOneByOne(changes, message);
      throw new Error(
        `HTTP ${head0.status}: branch "${this.config.branch}" not found in ${this.config.owner}/${this.config.repo} (or this token has no access to it).`
      );
    }

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
      // Último ponto seguro: até aqui nada mudou no GitHub (os blobs soltos
      // não aparecem em lugar nenhum). Depois do commit, o envio está feito.
      throwIfSyncCancelled();

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
          rememberRecentWrite(this.repoKey, w.path, sha);
        }
        for (const d of deletes) {
          recorded[d.path] = null;
          this.rememberSha(d.path, undefined);
          rememberRecentWrite(this.repoKey, d.path, null);
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
      throwIfSyncCancelled();
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
        // Com o status no texto: é por ele que o aviso de token inválido
        // (HTTP 401) é reconhecido — só "Bad credentials" passava batido.
        throw new Error(`HTTP ${res.status}${errJson.message ? `: ${errJson.message}` : ""}`);
      }
      this.rememberSha(path, undefined);
      void recordSyncedShas(this.repoKey, { [path]: null });
    } catch (err: any) {
      throw err;
    }
  }
  
}

// O que esta máquina gravou há pouco, por arquivo (ver getFile, modo prévia).
// 2 minutos: bem mais que o atraso da API, e curto o bastante pra não
// esconder por muito tempo a mudança de um colega que viesse logo depois.
export const RECENT_WRITE_MS = 120_000;
// sha = gravado; null = apagado.
export const recentWrites = new Map<string, { sha: string | null; at: number }>();
export function rememberRecentWrite(repoKey: string, path: string, sha: string | null) {
  recentWrites.set(`${repoKey}|${path}`, { sha, at: Date.now() });
}
export function recentWriteOf(repoKey: string, path: string): string | null | undefined {
  const entry = recentWrites.get(`${repoKey}|${path}`);
  return entry && Date.now() - entry.at < RECENT_WRITE_MS ? entry.sha : undefined;
}
