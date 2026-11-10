// Formato de um JWT compacto (header.payload.assinatura, base64url). O header
// sempre começa com '{"' — "eyJ" em base64url.
//
// Módulo sem dependências de propósito: é usado tanto pela redação do MCP
// (que roda em teste, fora do Tauri) quanto pelo AppLayout.
const JWT_REGEX = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;

export function looksLikeJwt(value: string | undefined | null): boolean {
  return JWT_REGEX.test(String(value ?? '').trim());
}

// ─── Token de sessão em variável de environment ──────────────────────────
//
// O access token que um fluxo OAuth2 grava sozinho (get_oauth2_token do MCP,
// passo de token do Runner, "Get new access token") é de cada pessoa e
// expira em uma hora. Ele não marca pendência de push (AppLayout) e não sobe
// pro GitHub (withoutSessionTokens): antes, bastava um push por outro motivo
// pra levá-lo junto, cifrado mas visível a quem tem a passphrase.
//
// Só conta como token de sessão o JWT numa variável com nome de token: uma
// chave de serviço JWT fixa ("serviceKey") editada de propósito continua
// marcando pendência e subindo, como qualquer outra variável.
const SESSION_TOKEN_KEY = /token|jwt|bearer|access|session|auth/i;

export function isSessionToken(key: string | undefined | null, value: string | undefined | null): boolean {
  return SESSION_TOKEN_KEY.test(String(key ?? '')) && looksLikeJwt(value);
}

/**
 * Os environments como vão pro GitHub: o valor dos tokens de sessão sai
 * vazio (a variável continua, pra quem puxa saber que ela existe). Genérico
 * no formato pra servir tanto ao push (dados crus) quanto aos tipos do app.
 */
export function withoutSessionTokens<T>(environments: T[]): T[] {
  return environments.map(env => {
    const values = (env as { values?: unknown })?.values;
    if (!Array.isArray(values)) return env;
    let changed = false;
    const next = values.map(v => {
      const entry = v as { key?: string; value?: string };
      if (!isSessionToken(entry?.key, entry?.value)) return v;
      changed = true;
      return { ...entry, value: '' };
    });
    return changed ? ({ ...env, values: next } as T) : env;
  });
}
