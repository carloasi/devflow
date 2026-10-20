import { invoke } from '@tauri-apps/api/core';
import { AuthorizationDetails } from '@/app/types/AuthorizationDetails';
import type { RequestDetails } from '@/app/types/CollectionItem';
import { executeOAuth2Flow } from './executeOAuth2Flow';

// ─────────────────────────────────────────────────────────────────────────
// Token OAuth 2.0 (MSAL / Azure AD) fora da aba Authorization — usado pelo
// MCP (get_oauth2_token) e pelo Collection Runner. Mesmo fluxo do botão
// "Get New Access Token":
// janela de login + troca do código pelo token no Rust.
// ─────────────────────────────────────────────────────────────────────────

export interface OAuth2Config {
  authUrl: string;
  accessTokenUrl: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scope: string;
}

// Lê a configuração OAuth 2.0 de uma request (auth.oauth2 é uma lista
// chave/valor, igual o Postman). `accessTokenField` é o campo Access Token
// cru — onde o token vai parar (normalmente "{{variavel}}").
/**
 * "Passo de token": auth OAuth 2.0 e URL vazia.
 *
 * Não é uma request quebrada — é como o app guarda uma configuração OAuth2. O
 * token vem do fluxo de autorização, nunca de um envio, e por isso não há URL.
 * Mora aqui porque três lugares precisam da mesma definição (o Runner, o
 * get_request e o run_request do MCP), e cada um com a sua acabaria
 * divergindo.
 */
export function isTokenStep(request: RequestDetails | undefined): boolean {
  return request?.auth?.type === 'oauth2' && !request?.url?.trim();
}

/**
 * Nome da variável onde o token é guardado, lido do campo Access Token.
 *
 * Só aceita `{{variavel}}`: o token gravado direto no campo iria para a
 * collection e, no push, para o GitHub.
 */
export function tokenVariableName(request: RequestDetails | undefined): string | null {
  const field = request?.auth?.oauth2?.find(e => e.key === 'accessToken' && e.enabled !== false)?.value ?? '';
  return field.trim().match(/^\{\{\s*([\w.-]+)\s*\}\}$/)?.[1] ?? null;
}

export function readOAuth2Config(
  auth: AuthorizationDetails | undefined,
  resolve: (text: string) => string
): { config: OAuth2Config; accessTokenField: string; missing: string[] } {
  const value = (key: string) =>
    String(auth?.oauth2?.find(entry => entry.key === key && entry.enabled !== false)?.value ?? '').trim();

  const config: OAuth2Config = {
    authUrl: resolve(value('authUrl')),
    accessTokenUrl: resolve(value('accessTokenUrl')),
    clientId: resolve(value('clientId')),
    clientSecret: resolve(value('clientSecret')),
    callbackUrl: resolve(value('callbackUrl')),
    scope: resolve(value('scope')),
  };

  const missing = [
    !config.authUrl && 'Auth URL',
    !config.accessTokenUrl && 'Access Token URL',
    !config.clientId && 'Client ID',
    !config.clientSecret && 'Client Secret',
    !config.callbackUrl && 'Callback URL',
  ].filter(Boolean) as string[];

  return { config, accessTokenField: value('accessToken'), missing };
}

// Login + troca do código. Lança em caso de erro/cancelamento.
export async function requestOAuth2AccessToken(config: OAuth2Config, signal?: AbortSignal): Promise<string> {
  const { code, codeVerifier, redirectUri } = await executeOAuth2Flow(config, signal);
  const tokenData = await invoke<{ access_token?: string; error?: string; error_description?: string }>(
    'exchange_code_for_token',
    {
      accessTokenUrl: config.accessTokenUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri,
      codeVerifier,
      scope: config.scope,
    }
  );
  if (!tokenData.access_token) {
    throw new Error(tokenData.error_description || tokenData.error || 'The provider refused the authorization.');
  }
  return tokenData.access_token;
}

export interface TokenInfo {
  // O token não é JWT legível (opaco) — só dá pra dizer que existe.
  readable: boolean;
  expiresAt?: string;
  expiresInSeconds?: number;
  user?: string;
  name?: string;
  audience?: string;
  scopes?: string[];
  roles?: string[];
  tenantId?: string;
  appId?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// Dados do token que ajudam a entender a autenticação (quem, pra qual API,
// até quando) SEM o token em si — é isso que o MCP devolve ao agente.
export function describeToken(token: string, now = Date.now()): TokenInfo {
  const claims = decodeJwtPayload(token);
  if (!claims) return { readable: false };

  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  const scp = str(claims.scp);

  return {
    readable: true,
    ...(exp ? { expiresAt: new Date(exp).toISOString(), expiresInSeconds: Math.round((exp - now) / 1000) } : {}),
    user: str(claims.upn) ?? str(claims.preferred_username) ?? str(claims.unique_name) ?? str(claims.email),
    name: str(claims.name),
    audience: Array.isArray(claims.aud) ? claims.aud.join(', ') : str(claims.aud),
    scopes: scp ? scp.split(' ') : undefined,
    roles: Array.isArray(claims.roles) ? claims.roles.map(String) : undefined,
    tenantId: str(claims.tid),
    appId: str(claims.azp) ?? str(claims.appid),
  };
}
