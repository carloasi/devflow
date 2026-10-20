import { RequestDetails } from '@/app/types/CollectionItem';
import { AuthorizationDetails } from '@/app/types/AuthorizationDetails';

// ─────────────────────────────────────────────────────────────────────────
// Redação de credenciais no que o servidor MCP entrega ao modelo.
//
// `list_environments` já devolve só os NOMES das variáveis, pra não vazar
// token. O mesmo cuidado precisa valer pra definição de uma request: `auth` e
// alguns headers guardam credencial escrita direto, quando o usuário não usou
// "{{variavel}}".
//
// Referência a variável é preservada de propósito: "{{token}}" não é segredo,
// é justamente o que o agente precisa ver pra entender de onde o valor sai — e
// o valor em si continua inacessível por ele.
//
// Mora num módulo à parte (sem importar Tauri) pra ser testável fora do app:
// é a camada que decide o que sai daqui, e errar nela é vazar credencial.
// ─────────────────────────────────────────────────────────────────────────

const SECRET_KEY_REGEX = /auth|token|key|secret|password|senha|cookie|session/i;

export const REDACTED = '[redacted — set in DevFlow]';

function isVarReference(value: string): boolean {
  return /^\s*\{\{[^{}]+\}\}\s*$/.test(value);
}

function redactValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === '' || isVarReference(value)) return value;
  return REDACTED;
}

function redactAuth(auth: AuthorizationDetails | undefined): AuthorizationDetails | undefined {
  if (!auth) return auth;
  return {
    ...auth,
    token: redactValue(auth.token),
    password: redactValue(auth.password),
    // Em auth do tipo apikey o par é key/value: o nome do header é útil, o
    // valor é a credencial.
    value: redactValue(auth.value),
    // OAuth2 carrega client_secret, senha e o próprio access token no meio de
    // campos inofensivos (grant_type, scope), então vai pela mesma regra de
    // nome usada nos headers.
    oauth2: auth.oauth2?.map(entry =>
      SECRET_KEY_REGEX.test(entry.key)
        ? { ...entry, value: redactValue(entry.value) ?? '' }
        : entry
    ),
  };
}

// Só os headers cujo NOME sugere credencial. Redigir todos tiraria
// Content-Type, Accept e afins, que o agente precisa pra raciocinar sobre a
// request sem ganhar nada em segurança.
export function redactHeaders<T extends { key: string; value: string }>(headers: T[] | undefined): T[] | undefined {
  if (!headers) return headers;
  return headers.map(h =>
    SECRET_KEY_REGEX.test(h.key) ? { ...h, value: redactValue(h.value) ?? '' } : h
  );
}

export function redactRequestDetails(request: RequestDetails | undefined): RequestDetails | null {
  if (!request) return null;
  return {
    ...request,
    headers: redactHeaders(request.headers) ?? request.headers,
    auth: redactAuth(request.auth),
  };
}
