// ─────────────────────────────────────────────────────────────────────────────
// Checagem remota de status do app (aviso de atualização + bloqueio remoto).
//
// Fonte: um Google Apps Script Web App publicado a partir de uma Google Sheet
// (ver google-apps-script/README.md na raiz do repo pras instruções completas
// de setup). O endpoint devolve um JSON pequeno editável a qualquer momento
// direto na planilha, sem precisar rebuildar/republicar o app:
//
//   {
//     "latestVersion": "1.2.0",
//     "minVersion": "1.0.0",
//     "blocked": false,
//     "blockMessage": "Manutenção em andamento, aguarde.",
//     "updateUrl": "https://.../releases/latest",
//     "updateMessage": "Nova versão com melhorias de load test!",
//     "blockedUsers": "CarlosSilva, joao.pereira",
//     "blockedVersions": "1.1.4, 1.1.7-beta"
//   }
//
// blockedUsers / blockedVersions vêm como string separada por vírgula (uma
// célula só na planilha) e são splitados aqui. blockedUsers casa pelo nome
// de usuário do Windows (case-insensitive) — não é uma conta/login do app,
// só o "USERNAME" da sessão do SO, que já é usado em outros cantos do app
// (ver get_windows_username no lib.rs). blockedVersions bloqueia uma versão
// EXATA, independente de minVersion (útil pra derrubar um release específico
// com bug sem mexer no mínimo exigido pra todo mundo).
//
// Falha de rede/parse NUNCA bloqueia o app (fail-open) — só um "blocked: true"
// explícito, a versão instalada ficar abaixo de minVersion, o usuário atual
// estar em blockedUsers, ou a versão atual estar em blockedVersions, bloqueia.
// ─────────────────────────────────────────────────────────────────────────────

// TODO: cole aqui a URL do Web App depois de publicar o Apps Script
// (Deploy > New deployment > Web app > Execute as: me > Who has access: Anyone).
// Sem isso preenchido, a checagem é pulada silenciosamente.
export const APP_STATUS_URL = 'https://script.google.com/macros/s/AKfycbzEIILx6IF_8fPL_KX4N3MaEVlVI8v_Rtr6uhfy7WplUqjR4Ylv-tVWcV1H8Aznqcaqgw/exec';

export interface AppStatus {
  latestVersion?: string;
  minVersion?: string;
  blocked?: boolean;
  blockMessage?: string;
  updateUrl?: string;
  updateMessage?: string;
  blockedUsers?: string[];
  blockedVersions?: string[];
}

// "CarlosSilva, joao.pereira" -> ["CarlosSilva", "joao.pereira"]
function parseCommaList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

const FETCH_TIMEOUT_MS = 8000;

// Compara versões no formato "1.2.10" — puramente numérico por segmento (sem
// suporte a pre-release tags tipo "-beta"; suficiente pro caso de uso aqui).
// Retorna >0 se a > b, <0 se a < b, 0 se iguais/inválidas.
export function compareVersions(a: string, b: string): number {
  const pa = String(a ?? '').trim().split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b ?? '').trim().split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Usa o comando Rust make_http_request (o mesmo usado pra todas as outras
// requests do app) em vez de fetch() do browser — Web Apps do Apps Script
// nem sempre mandam os headers de CORS certinho, e request feita pelo lado
// Rust não passa pelo CORS do navegador de jeito nenhum.
export async function fetchAppStatus(): Promise<AppStatus | null> {
  if (!APP_STATUS_URL.trim()) return null;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)
    );

    const result = await Promise.race([
      invoke<{ status: number; body: string }>('make_http_request', {
        method: 'GET',
        url: APP_STATUS_URL,
        body: null,
        headersInput: null,
      }),
      timeoutPromise,
    ]);

    if (!result || result.status >= 400) return null;

    const data = JSON.parse(result.body);
    if (!data || typeof data !== 'object') return null;

    return {
      latestVersion: typeof data.latestVersion === 'string' ? data.latestVersion : undefined,
      minVersion: typeof data.minVersion === 'string' ? data.minVersion : undefined,
      blocked: data.blocked === true || data.blocked === 'true' || data.blocked === 'TRUE',
      blockMessage: typeof data.blockMessage === 'string' ? data.blockMessage : undefined,
      updateUrl: typeof data.updateUrl === 'string' ? data.updateUrl : undefined,
      updateMessage: typeof data.updateMessage === 'string' ? data.updateMessage : undefined,
      blockedUsers: parseCommaList(data.blockedUsers),
      blockedVersions: parseCommaList(data.blockedVersions),
    };
  } catch {
    // Rede indisponível, timeout, JSON inválido, etc — fail-open (nunca
    // bloqueia o app por causa de uma falha na PRÓPRIA checagem).
    return null;
  }
}

// "Check-in" de uso — reporta pro Apps Script que este usuário abriu o app
// nesta versão (ele grava/atualiza uma linha na aba "Users" da planilha,
// ver google-apps-script/Code.gs). Chamado UMA VEZ por sessão (na abertura
// do app, não a cada checagem periódica de bloqueio/update). Fire-and-forget:
// nunca lança erro, nunca afeta o funcionamento do app.
//
// Vai como GET com query string (?checkin=1&username=...&version=...), não
// POST — Web Apps do Apps Script respondem com um redirect (302) pra
// executar de fato, e o reqwest (Rust, usado no make_http_request) descarta
// o body de um POST ao seguir esse redirect. Query string sobrevive ao
// redirect normalmente, então GET é o jeito confiável de mandar esses dados.
export async function reportUsage(username: string, version: string): Promise<void> {
  if (!APP_STATUS_URL.trim() || !username.trim()) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)
    );

    const separator = APP_STATUS_URL.includes('?') ? '&' : '?';
    const url = `${APP_STATUS_URL}${separator}checkin=1&username=${encodeURIComponent(username)}&version=${encodeURIComponent(version)}`;

    await Promise.race([
      invoke('make_http_request', {
        method: 'GET',
        url,
        body: null,
        headersInput: null,
      }),
      timeoutPromise,
    ]);
  } catch {
    // Sem rede, sem URL configurada, etc — não é crítico, só não fica
    // registrado desta vez.
  }
}
