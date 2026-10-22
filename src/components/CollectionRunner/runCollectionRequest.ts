import { invoke } from '@tauri-apps/api/core';
import { CollectionItem, RequestDetails } from '@/app/types/CollectionItem';
import { TestResult } from '@/app/types/TestResult';
import { DataResponse } from '@/app/types/DataResponse';
import { sanitizeJsonBodyForSend } from '@/lib/sanitizeJsonBody';
import { buildRequestHeaders, requestHasBody } from '@/lib/defaultHeaders';
import { resolveAfterPreRequest } from '@/lib/preRequestResolution';
import {
  describeToken,
  isTokenStep,
  readOAuth2Config,
  requestOAuth2AccessToken,
  tokenVariableName,
} from '@/lib/oauth2Token';

// ─────────────────────────────────────────────────────────────────────────────
// Execução headless de um item de collection (fora do sistema de tabs) — usado
// pelo Collection Runner. Reimplementa em miniatura a mesma lógica de resolução
// de URL/headers/body/scripts que handleSendRequest usa em AppLayout.tsx,
// mas operando direto sobre um CollectionItem em vez de uma Tab aberta.
// ─────────────────────────────────────────────────────────────────────────────


interface ScriptRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

// Uma linha de console.log/info/warn/error emitida pelo script (pré-request
// ou pós-resposta) durante a execução — ver ScriptLogEntry no lado Rust
// (execute_script_backend), que agora devolve isso no retorno do invoke em
// vez de só emitir via evento "script-log" (que só é útil pro Console global
// ao vivo, não pro Runner headless).
export interface ScriptLogEntry {
  level: 'log' | 'info' | 'warn' | 'error' | string;
  message: string;
  // Adicionado aqui no frontend (não vem do Rust) pra diferenciar de qual
  // fase do script o log veio, já que uma request pode ter os dois.
  phase: 'pre-request' | 'post-response';
}

interface ScriptContext {
  env: Record<string, string>;
  response?: any;
  responseBody?: string;
  request?: ScriptRequest;
  responseTime?: number;
  tests?: TestResult[];
  scriptError?: string;
  logs?: { level: string; message: string }[];
  setVariables?: { key: string; value: string }[];
}

// Uma chamada de pm.environment.set(key, value) (ou pm.globals/variables/
// collectionVariables.set — todas caem no mesmo mapa de env nesse app)
// capturada NO MOMENTO EM QUE ACONTECEU no lado Rust (ver
// ScriptContext.set_variables/VariableSetEntry em execute_script_backend).
//
// Importante: isso NÃO é um diff do env antes/depois — a primeira versão
// era baseada em diff e tinha um bug real: se o script atribuísse um valor
// IGUAL ao que a variável já tinha (ex: um endpoint de sandbox que sempre
// devolve o mesmo token/id em requests subsequentes), o diff não via
// nenhuma mudança e a atribuição sumia do relatório do Runner, mesmo tendo
// rodado de verdade. Registrar a chamada em si resolve isso.
export interface VariableChange {
  key: string;
  value: string;
  phase: 'pre-request' | 'post-response';
}

export interface RunItemOutcome {
  itemId: string;
  status: 'success' | 'error';
  httpStatus?: number;
  responseTime: number;
  responseSize?: number;
  errorMessage?: string;
  tests: TestResult[];
  envAfter: Record<string, string>;
  scriptError?: string;
  // URL já resolvida (com {{vars}}/:pathParams substituídos) que foi
  // efetivamente chamada — ajuda a diagnosticar falha por variável não
  // resolvida sem precisar abrir a request original.
  resolvedUrl?: string;
  // Primeiros ~2000 caracteres do corpo da resposta — sempre que a request
  // chegou a responder (mesmo com status de erro), pra dar contexto real do
  // motivo da falha em vez de só o código HTTP.
  // O que foi efetivamente enviado, já com variáveis resolvidas e o que os
  // scripts alteraram. Sem isto só dava pra ver a resposta: quando ela vem
  // errada, a primeira pergunta é o que entrou.
  sentMethod?: string;
  sentHeaders?: Record<string, string>;
  sentBody?: string;
  /** Variáveis que esta request referencia (nomes, do texto cru). */
  usedVariables?: string[];
  responseBodySnippet?: string;
  // Corpo completo (limitado a FULL_BODY_MAX). O painel do Runner mostra só
  // o snippet, mas o servidor MCP precisa do corpo inteiro pro agente
  // escrever assertion contra o shape real da resposta.
  fullResponseBody?: string;
  // Console.log/info/warn/error dos scripts (pré-request + pós-resposta),
  // na ordem em que rodaram — permite recuperar o que os scripts logaram
  // depois que o Run já terminou, sem precisar abrir o Console global (que
  // fica cheio de entradas de todas as requests misturadas).
  logs: ScriptLogEntry[];
  // Variáveis criadas/alteradas por pm.environment.set(...) (ou
  // globals/variables.set) nos scripts — permite ver "bearerToken: valor"
  // depois que o Run terminou, sem precisar abrir o painel de Environment.
  variablesSet: VariableChange[];
}

/// Uma linha do Runner: a request dentro de uma iteração, com o resultado
/// quando já rodou. Mora aqui, e não no painel, porque o histórico do último
/// run (runHistory.ts) também precisa do tipo — tê-lo no componente criaria
/// um ciclo de import entre os dois.
export interface RunEntry {
  id: string;
  itemId: string;
  iteration: number;
  /** Rótulo da linha da tabela de dados, quando o run usou uma. */
  rowLabel?: string;
  name: string;
  method?: string;
  state: 'pending' | 'running' | 'success' | 'error';
  outcome?: RunItemOutcome;
  /** ISO — quando o passo saiu. Ausente em run antigo ou passo que não rodou. */
  startedAt?: string;
  /** ISO — quando a resposta (ou o erro) voltou. */
  finishedAt?: string;
}

const RESPONSE_SNIPPET_MAX = 2000;
// O corpo enviado é guardado junto do run; 10k cobre o payload típico sem
// inflar o histórico, que compete pela mesma cota do localStorage.
const SENT_BODY_MAX = 10_000;

/**
 * Nomes de variáveis que a request referencia, do texto cru — URL, headers,
 * body e os campos de auth.
 *
 * Lê o cru de propósito: depois da substituição os `{{nome}}` já viraram
 * valores, e o que se quer aqui é justamente saber QUAIS variáveis entraram
 * naquela chamada, pra poder corrigi-las sem sair do Runner.
 */
function collectVariableNames(req: RequestDetails, method?: string): string[] {
  const names = new Set<string>();
  const scan = (text: string | undefined) => {
    for (const match of String(text ?? '').matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
      names.add(match[1]);
    }
  };

  scan(req.url);
  scan(method);
  scan(req.body);
  for (const header of req.headers ?? []) {
    if (header.enabled === false) continue;
    scan(header.key);
    scan(header.value);
  }
  for (const variable of req.urlexport?.variable ?? []) scan(variable.value);

  const auth = req.auth;
  scan(auth?.token);
  scan(auth?.username);
  scan(auth?.password);
  scan(auth?.value);
  for (const entry of auth?.oauth2 ?? []) {
    if (entry.enabled === false) continue;
    scan(entry.value);
  }

  return [...names];
}
const FULL_BODY_MAX = 200_000;

// Mensagem do make_http_request quando cancel_http_request interrompe o envio
// (REQUEST_CANCELLED em lib.rs).
export const REQUEST_CANCELLED = 'Request cancelled by user';

export function replaceWithEnv(text: string, env: Record<string, string>): string {
  if (!text) return '';
  return text.replace(/\{\{(.*?)\}\}/g, (_, key) => env[key.trim()] ?? `{{${key.trim()}}}`);
}

export function replaceUrlParams(url: string, params: Array<{ key: string; value: string; enabled?: boolean }>): string {
  if (!url) return '';
  return url.replace(/:([a-zA-Z0-9_]+)/g, (match, name) => {
    const found = params.find(p => p.key === name && p.enabled !== false);
    return found ? found.value : match;
  });
}

// Mesma regra do envio normal (lib/defaultHeaders.ts).
export function buildHeaders(req: RequestDetails, env: Record<string, string>): Record<string, string> {
  return buildRequestHeaders({
    userHeaders: (req.headers || []).map(h => ({ key: h.key ?? '', value: h.value ?? '', enabled: h.enabled })),
    disabledDefaults: req.disabledDefaultHeaders,
    hasBody: requestHasBody(req.bodyType, req.body),
    auth: req.auth,
    resolve: value => replaceWithEnv(value, env),
  });
}

// Quanto de validade ainda sobrando conta como "token bom". Abaixo disso o
// passo renova, pra não começar um fluxo de dez minutos com um token que
// expira no meio dele.
const TOKEN_MIN_VALIDITY_SECONDS = 300;
const TOKEN_SIGN_IN_TIMEOUT_MS = 180_000;

/**
 * Obtém (ou reaproveita) o token de um passo OAuth2 e o devolve no ambiente,
 * para os passos seguintes usarem — o mesmo efeito de um post-response script
 * que faz `pm.environment.set`.
 *
 * Reaproveitar enquanto vale é o que torna isto viável dentro de um run: o
 * fluxo de autorização abre uma janela de login, e fazer isso a cada execução
 * seria pior que a falha que esta função veio substituir.
 */
async function runTokenStep(
  item: CollectionItem,
  envMap: Record<string, string>
): Promise<RunItemOutcome> {
  const started = performance.now();
  const base = {
    itemId: item.id,
    tests: [] as TestResult[],
    logs: [] as ScriptLogEntry[],
    variablesSet: [] as VariableChange[],
    envAfter: envMap,
  };
  const fail = (message: string): RunItemOutcome => ({
    ...base,
    status: 'error',
    responseTime: Math.round(performance.now() - started),
    errorMessage: message,
  });

  const variable = tokenVariableName(item.request);
  if (!variable) {
    // Campo com o token colado direto é o que o botão "Get new access token"
    // produz quando não há variável — e é um beco sem saída aqui: um token
    // novo não teria onde ser gravado pros passos seguintes lerem, e gravá-lo
    // na request o mandaria pra collection e, no push, pro GitHub.
    return fail(
      'The Access Token field holds a token pasted directly, not a {{variable}} — so a new token would have nowhere to go, ' +
        'and the next requests would keep using the old one. In the Authorization tab of this request, set Access Token to ' +
        '{{msal}}, and set the Bearer token of the request that consumes it to {{msal}} as well. After that this step renews ' +
        'by itself on every run.'
    );
  }

  const resolve = (text: string) =>
    text.replace(/\{\{(.*?)\}\}/g, (_, key) => envMap[String(key).trim()] ?? `{{${String(key).trim()}}}`);
  const { config, missing } = readOAuth2Config(item.request!.auth, resolve);
  if (missing.length > 0) {
    return fail(`Missing OAuth 2.0 settings: ${missing.join(', ')}.`);
  }

  const current = envMap[variable];
  if (current) {
    const info = describeToken(current);
    if (info.readable && (info.expiresInSeconds ?? 0) > TOKEN_MIN_VALIDITY_SECONDS) {
      return {
        ...base,
        status: 'success',
        responseTime: Math.round(performance.now() - started),
        responseBodySnippet: `Reused the token already in {{${variable}}} — valid for ${Math.round((info.expiresInSeconds ?? 0) / 60)} more minute(s).`,
      };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_SIGN_IN_TIMEOUT_MS);
  try {
    const token = await requestOAuth2AccessToken(config, controller.signal);
    const info = describeToken(token);
    return {
      ...base,
      status: 'success',
      responseTime: Math.round(performance.now() - started),
      // No ambiente DESTE run: os passos seguintes leem daqui, e o Runner
      // propaga pro environment real pelo mesmo caminho dos scripts.
      envAfter: { ...envMap, [variable]: token },
      variablesSet: [{ key: variable, value: token, phase: 'post-response' }],
      responseBodySnippet: `New token stored in {{${variable}}}${
        info.expiresInSeconds ? ` — valid for ${Math.round(info.expiresInSeconds / 60)} minute(s).` : '.'
      }`,
    };
  } catch (e) {
    return fail(
      controller.signal.aborted
        ? `Sign-in was not completed within ${TOKEN_SIGN_IN_TIMEOUT_MS / 1000}s — finish the Microsoft login window and run again.`
        : `Could not get the token: ${(e as Error)?.message ?? String(e)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function runCollectionRequest(
  item: CollectionItem,
  envMap: Record<string, string>,
  // requestId: permite interromper o envio com cancel_http_request (Stop do Runner).
  options: { requestId?: string } = {}
): Promise<RunItemOutcome> {
  const req = item.request;

  if (item.protocol === 'grpc') {
    return {
      itemId: item.id,
      status: 'error',
      responseTime: 0,
      tests: [],
      errorMessage: 'gRPC requests are not supported in the Collection Runner yet — invoke them from their tab.',
      envAfter: envMap,
      logs: [],
      variablesSet: [],
    };
  }

  if (!req) {
    return {
      itemId: item.id,
      status: 'error',
      responseTime: 0,
      tests: [],
      errorMessage: 'Request has no definition.',
      envAfter: envMap,
      logs: [],
      variablesSet: [],
    };
  }

  // Passo de token (OAuth2 sem URL) não é um envio: antes o Runner tentava
  // mandá-lo e todo fluxo com MSAL começava com uma falha vermelha, mesmo
  // quando o token estava válido e o resto rodava.
  if (isTokenStep(req)) {
    return runTokenStep(item, envMap);
  }

  let currentEnv = { ...envMap };
  let scriptError: string | undefined;
  const scriptLogs: ScriptLogEntry[] = [];
  const variablesSet: VariableChange[] = [];

  const resolvedUrl = replaceUrlParams(req.url || '', req.urlexport?.variable || []);
  let finalMethod: string = item.method || 'GET';
  let finalUrl = replaceWithEnv(resolvedUrl, currentEnv);
  let finalHeaders = buildHeaders(req, currentEnv);
  // Tira comentários "//"/"/* */" e vírgula sobrando que o editor tolera mas
  // que quebram tanto o servidor de destino quanto
  // JSON.parse(pm.request.body.raw) nos scripts (ver sanitizeJsonBody.ts).
  // bodyType 'none' não manda body — igual o envio normal (antes o Runner
  // mandava o texto guardado no editor mesmo assim).
  let finalBody = requestHasBody(req.bodyType, req.body)
    ? sanitizeJsonBodyForSend(replaceWithEnv(req.body!, currentEnv))
    : '';

  if (req.scripts?.preRequest?.trim()) {
    try {
      const passedToScript = { url: finalUrl, headers: finalHeaders, body: finalBody };
      const preResult = await invoke<ScriptContext>('execute_script_backend', {
        script: req.scripts.preRequest,
        context: {
          env: currentEnv,
          response: null,
          request: { method: finalMethod, ...passedToScript },
        },
      });
      if (preResult?.env) currentEnv = preResult.env;
      if (preResult?.setVariables?.length) {
        variablesSet.push(...preResult.setVariables.map(v => ({ ...v, phase: 'pre-request' as const })));
      }
      finalMethod = preResult?.request?.method || finalMethod;
      // Variáveis do pre-request valem nesta mesma request (como no Postman).
      ({ url: finalUrl, headers: finalHeaders, body: finalBody } = resolveAfterPreRequest({
        before: passedToScript,
        after: preResult?.request,
        rebuild: env => ({
          url: replaceWithEnv(resolvedUrl, env),
          headers: buildHeaders(req, env),
          body: requestHasBody(req.bodyType, req.body)
            ? sanitizeJsonBodyForSend(replaceWithEnv(req.body!, env))
            : '',
        }),
        env: currentEnv,
        resolve: replaceWithEnv,
      }));
      if (preResult?.logs?.length) {
        scriptLogs.push(...preResult.logs.map(l => ({ ...l, phase: 'pre-request' as const })));
      }
      // Script que lançou aborta o passo, como no Postman e como no botão
      // Send. Seguir enviaria justamente o que a guarda tentou impedir, e o
      // passo apareceria verde no relatório.
      if (preResult?.scriptError) {
        return {
          itemId: item.id,
          status: 'error',
          responseTime: 0,
          tests: [],
          errorMessage: `Pre-request script error: ${preResult.scriptError}`,
          envAfter: currentEnv,
          logs: scriptLogs,
          variablesSet,
        };
      }
    } catch (e) {
      // O próprio sandbox falhou (não compilou, travou): o script nem chegou
      // a rodar, então nada garante que a request esteja no estado que ele
      // deixaria. Aborta, como quando o script lança.
      console.log('Runner: erro no pre-request script:', e);
      return {
        itemId: item.id,
        status: 'error',
        responseTime: 0,
        tests: [],
        errorMessage: `Pre-request script error: ${e}`,
        envAfter: currentEnv,
        logs: scriptLogs,
        variablesSet,
      };
    }
  }

  const reqStart = performance.now();
  let result: DataResponse;
  try {
    result = await invoke<DataResponse>('make_http_request', {
      method: finalMethod, url: finalUrl, body: finalBody || null, headersInput: finalHeaders,
      requestId: options.requestId ?? null,
    });
  } catch (err: any) {
    const msg = typeof err === 'string' ? err : err?.message || 'Failed to fetch';
    return {
      itemId: item.id,
      status: 'error',
      responseTime: Math.round(performance.now() - reqStart),
      tests: [],
      errorMessage: msg,
      envAfter: currentEnv,
      resolvedUrl: finalUrl,
      scriptError,
      logs: scriptLogs,
      variablesSet,
    };
  }
  const responseTime = Math.round(performance.now() - reqStart);

  const responseBody = (() => {
    const b = (result as any)?.body ?? (result as any)?.Body;
    return typeof b === 'string' ? b : JSON.stringify(b || {}, null, 2);
  })();

  let tests: TestResult[] = [];
  if (req.scripts?.postResponse?.trim()) {
    try {
      const postResult = await invoke<ScriptContext>('execute_script_backend', {
        script: req.scripts.postResponse,
        context: {
          env: currentEnv,
          response: result,
          responseBody,
          request: { method: finalMethod, url: finalUrl, headers: finalHeaders, body: finalBody },
          responseTime,
        },
      });
      if (postResult?.env) currentEnv = postResult.env;
      if (postResult?.setVariables?.length) {
        variablesSet.push(...postResult.setVariables.map(v => ({ ...v, phase: 'post-response' as const })));
      }
      if (postResult?.tests) tests = postResult.tests;
      if (postResult?.scriptError) scriptError = `Post-response script error: ${postResult.scriptError}`;
      if (postResult?.logs?.length) {
        scriptLogs.push(...postResult.logs.map(l => ({ ...l, phase: 'post-response' as const })));
      }
    } catch (e) {
      console.log('Runner: erro no post-response script:', e);
      scriptError = `Post-response script error: ${e}`;
    }
  }

  return {
    itemId: item.id,
    status: 'success',
    httpStatus: result.status,
    responseTime,
    responseSize: typeof responseBody === 'string' ? new TextEncoder().encode(responseBody).length : undefined,
    tests,
    envAfter: currentEnv,
    scriptError,
    resolvedUrl: finalUrl,
    sentMethod: finalMethod,
    sentHeaders: finalHeaders,
    sentBody: finalBody ? finalBody.slice(0, SENT_BODY_MAX) : '',
    // Nomes das variáveis que ESTA request referencia, lidos do texto cru
    // (antes da substituição). É o que permite editá-las a partir da linha do
    // Runner: as que o passo GRAVOU já apareciam, as que ele LÊ não.
    usedVariables: collectVariableNames(req, item.method),
    responseBodySnippet:
      typeof responseBody === 'string' ? responseBody.slice(0, RESPONSE_SNIPPET_MAX) : undefined,
    fullResponseBody:
      typeof responseBody === 'string' ? responseBody.slice(0, FULL_BODY_MAX) : undefined,
    logs: scriptLogs,
    variablesSet,
  };
}

// Achata recursivamente uma árvore de CollectionItem, retornando só os
// itens do tipo 'request', na ordem em que aparecem (mesma ordem visual da árvore).
export function flattenRequests(items: CollectionItem[]): CollectionItem[] {
  const out: CollectionItem[] = [];
  const walk = (list: CollectionItem[]) => {
    for (const it of list) {
      if (it.type === 'request') out.push(it);
      else if (it.type === 'folder' && it.item?.length) walk(it.item);
    }
  };
  walk(items);
  return out;
}
