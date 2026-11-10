import { RequestDetails } from '@/app/types/CollectionItem';
import { AuthorizationDetails } from '@/app/types/AuthorizationDetails';
import { looksLikeJwt } from '@/lib/jwt';

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

// ─────────────────────────────────────────────────────────────────────────
// Segredos no RESULTADO de uma execução (run_request, run_collection,
// get_last_run).
//
// Esconder a definição da request não basta: o token que um passo OAuth2
// obtém, ou que um post-response grava com pm.environment.set, voltava inteiro
// em variablesSet — e aparecia de novo nos console.log dos scripts, na URL
// resolvida (?api_key=...) e no body de resposta do login. Daí ia pro modelo
// e pra transcrição da sessão do Claude em disco.
//
// A regra: uma variável é segredo quando o NOME sugere credencial (mesma regex
// dos headers) ou quando o VALOR tem cara de JWT. Toda ocorrência desses
// valores em texto livre vira "{{nome}}" — o agente continua vendo de onde o
// valor sai, só não o valor.
// ─────────────────────────────────────────────────────────────────────────

// Valores curtos ("true", "1", "pt-BR") num nome como "useAuth" não são
// credencial, e trocá-los em todo texto destruiria o resultado.
const MIN_SECRET_LENGTH = 6;
// URL sem query string em variável como "authUrl" é endereço, não credencial.
const PLAIN_URL_REGEX = /^https?:\/\/[^?#\s]*$/i;

export const HIDDEN_VALUE = '[hidden — secret value, not shown on purpose]';

export function isSecretVariable(key: string, value: string | undefined | null): boolean {
  const text = String(value ?? '').trim();
  if (text.length < MIN_SECRET_LENGTH || isVarReference(text)) return false;
  if (looksLikeJwt(text)) return true;
  return SECRET_KEY_REGEX.test(key) && !PLAIN_URL_REGEX.test(text);
}

export type SecretRedactor = (text: string | undefined | null) => string;

/**
 * Monta um redator a partir dos environments envolvidos na execução (antes e
 * depois) e das variáveis que os scripts gravaram no meio do caminho.
 */
export function createSecretRedactor(
  envs: Array<Record<string, string> | undefined | null>,
  changes: Array<{ key: string; value: string }> = []
): SecretRedactor {
  const secrets = new Map<string, string>();
  const add = (key: string, value: unknown) => {
    const text = String(value ?? '');
    if (isSecretVariable(key, text) && !secrets.has(text)) secrets.set(text, key);
  };
  for (const env of envs) for (const [key, value] of Object.entries(env ?? {})) add(key, value);
  for (const change of changes) add(change.key, change.value);

  // Maiores primeiro: um segredo que contém outro tem que ser trocado inteiro.
  const ordered = [...secrets.entries()].sort((a, b) => b[0].length - a[0].length);
  return text => {
    let out = String(text ?? '');
    if (!out) return out;
    for (const [value, key] of ordered) {
      if (out.includes(value)) out = out.split(value).join(`{{${key}}}`);
    }
    return out;
  };
}
