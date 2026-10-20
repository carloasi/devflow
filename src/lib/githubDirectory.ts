import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { storeGet } from '@/lib/tauriStore';
import { getSecret } from '@/lib/secureStorage';

// ─────────────────────────────────────────────────────────────────────────────
// Versão "leve" e somente-leitura da lógica de acesso ao GitHub que já existe
// em GitHubStorageClient.tsx — usada quando a gente só precisa checar se uma
// pasta existe no repositório (ex: status de sync por workspace), sem precisar
// montar o componente inteiro de sync. Reaproveita a mesma config/token salvos
// (gh_sync_config / gh_sync_token) e o mesmo formato de headers/erros (404 e
// qualquer outra falha viram [] silenciosamente, nunca lança exceção).
// ─────────────────────────────────────────────────────────────────────────────

export const GITHUB_WORKSPACES_ROOT = 'Postman';
const GH_TOKEN_KEY = 'gh_sync_token';

export interface GithubDirectoryConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface RepoItem {
  name: string;
  path: string;
  type: 'dir' | 'file' | string;
}

// Retorna null se o GitHub sync não estiver configurado (sem token salvo).
export async function loadGithubConfig(): Promise<GithubDirectoryConfig | null> {
  const parsed = (await storeGet<Partial<GithubDirectoryConfig>>('gh_sync_config')) || {};

  let token = '';
  try {
    token = (await getSecret(GH_TOKEN_KEY)) || '';
  } catch {
    // sem token salvo — trata como não configurado
  }

  if (!token) return null;

  return {
    token,
    owner: parsed.owner || 'barramentob2b',
    repo: parsed.repo || 'Postman',
    branch: parsed.branch || 'main',
  };
}

function repoContentsUrl(config: GithubDirectoryConfig, path: string): string {
  const cleanPath = path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');

  return `https://api.github.com/repos/${config.owner}/${config.repo}/contents${cleanPath ? `/${cleanPath}` : ''}`;
}

export async function listGithubDirectory(config: GithubDirectoryConfig, path: string): Promise<RepoItem[]> {
  const targetUrl = `${repoContentsUrl(config, path)}?ref=${encodeURIComponent(config.branch)}`;

  try {
    const res = await tauriFetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 404) return [];
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? (data as RepoItem[]) : [];
  } catch {
    return [];
  }
}

export function workspaceRemotePath(workspaceName: string): string {
  return `${GITHUB_WORKSPACES_ROOT}/${workspaceName}`;
}
