import type { CollectionItem, RequestDetails } from '@/app/types/CollectionItem';
import { buildRequestHeaders, requestHasBody } from '@/lib/defaultHeaders';
import { sanitizeJsonBodyForSend } from '@/lib/sanitizeJsonBody';
import { isLikelySecretValue, suggestVariableName } from '@/lib/secretScan';

// ─────────────────────────────────────────────────────────────────────────
// "Export as HTML runner": um flow (pasta) vira UM arquivo .html que abre no
// navegador, mostra os passos em ordem e os executa como o Runner do DevFlow
// — no estilo de uma página do Swagger, mas montada a partir do flow.
//
// Aqui é só a parte pura: monta os dados do flow e o HTML. O motor que roda
// no navegador é public/runtime/flow-runner.js; os scripts usam o mesmo
// runtime do pm.* do DevFlow (public/runtime/pm-bootstrap.js).
//
// Cada passo sai PRONTO pra executar, com as mesmas regras do Runner
// (runCollectionRequest): headers padrão + auth montados por
// buildRequestHeaders, :params da URL resolvidos, body limpo de comentários
// — mas com os {{placeholders}} mantidos, que o navegador troca na hora de
// rodar, com os valores do painel de variáveis.
//
// Segredos: variável sensível do environment e credencial escrita direto
// num header/auth viram variáveis "secret". Por padrão saem SEM valor, pra
// quem abrir o HTML colar; com `includeSecrets` (a pessoa confirma no
// export — pensado pra ambiente de teste) os valores vão no arquivo.
// ─────────────────────────────────────────────────────────────────────────

export interface FlowStep {
  id: string;
  name: string;
  /** Pastas entre o flow e o passo. */
  path: string[];
  kind: 'http' | 'token' | 'grpc';
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  description: string;
  preRequest: string;
  postResponse: string;
  /** Só em `token`: a variável onde o token mora. */
  tokenVariable?: string;
  /**
   * Auth Basic, com os {{placeholders}} ainda no texto: o base64 só pode ser
   * montado depois de trocá-los (o runner e o HAR fazem isso). Montado no
   * export, ele codificava o literal "{{user}}:{{pass}}" e o passo dava 401.
   */
  basicAuth?: { username: string; password: string };
}

export interface FlowVariable {
  key: string;
  value: string;
  secret: boolean;
}

/** Um environment levado no arquivo: as variáveis do flow com os valores dele. */
export interface FlowEnvironment {
  name: string;
  variables: FlowVariable[];
}

export interface FlowData {
  format: 1;
  id: string;
  name: string;
  description: string;
  /** Caminho do flow na árvore (collection → … → pasta). */
  path: string[];
  generatedAt: string;
  /**
   * Environments escolhidos no export — o HTML troca entre eles num seletor.
   * Sempre ao menos um (sem environment nenhum, um "No environment" vazio).
   */
  environments: FlowEnvironment[];
  /** O que abre selecionado. */
  defaultEnvironment: string;
  steps: FlowStep[];
  /** Algum script usa moment? Só então ele é embutido (~180 KB). */
  usesMoment: boolean;
  /** Os valores secretos foram incluídos no arquivo (o HTML avisa). */
  includesSecrets: boolean;
}

export interface FlowRuntimeAssets {
  /** public/runtime/pm-bootstrap.js */
  bootstrap: string;
  /** public/runtime/moment.min.js */
  moment: string;
  /** public/runtime/flow-runner.js */
  runner: string;
}

// Mesma regra de lib/oauth2Token (isTokenStep/tokenVariableName) — repetida
// aqui porque aquele módulo importa o Tauri, e este precisa rodar puro.
function isTokenStep(request: RequestDetails | undefined): boolean {
  return request?.auth?.type === 'oauth2' && !request?.url?.trim();
}
function tokenVariableName(request: RequestDetails | undefined): string | null {
  const field = request?.auth?.oauth2?.find(e => e.key === 'accessToken' && e.enabled !== false)?.value ?? '';
  return field.trim().match(/^\{\{\s*([\w.-]+)\s*\}\}$/)?.[1] ?? null;
}

// Mesmo replaceUrlParams do Runner.
function replaceUrlParams(url: string, params: Array<{ key: string; value: string; enabled?: boolean }>): string {
  if (!url) return '';
  return url.replace(/:([a-zA-Z0-9_]+)/g, (match, name) => {
    const found = params.find(p => p.key === name && p.enabled !== false);
    return found ? found.value : match;
  });
}

/** Passos na ordem da árvore, com as pastas entre o flow e cada um. */
function collectSteps(folder: CollectionItem): { item: CollectionItem; path: string[] }[] {
  const out: { item: CollectionItem; path: string[] }[] = [];
  const walk = (items: CollectionItem[], path: string[]) => {
    for (const it of items) {
      if (it.type === 'request') out.push({ item: it, path });
      else if (it.type === 'folder' && it.item?.length) walk(it.item, [...path, it.name]);
    }
  };
  if (folder.type === 'request') out.push({ item: folder, path: [] });
  else walk(folder.item ?? [], []);
  return out;
}

/** Endereço (http/https), e não credencial — mesmo com nome que pareça. */
function looksLikeUrl(value: string): boolean {
  return /^\s*https?:\/\/[^\s]+$/i.test(value);
}

// Qualquer nome entre chaves — o mesmo que o envio troca ({{base url}} também).
const VAR_IN_TEXT = /\{\{\s*([^{}]+?)\s*\}\}/g;
// Só leituras de VARIÁVEL: pm.environment.get('x'), pm.variables.get("x"),
// postman.getEnvironmentVariable('x')… Um `.get(` qualquer pegava também
// pm.response.headers.get('Content-Type'), que aparecia no painel.
const VAR_IN_SCRIPT =
  /(?:pm\.(?:environment|variables|globals|collectionVariables|iterationData)\.get|postman\.get(?:Environment|Global)Variable)\(\s*['"]([^'"]+)['"]\s*\)/g;
// Variáveis que um script GRAVA (pm.environment.set('x', …)): entram no
// painel desde o início, pra quem roda o flow ver o que cada passo produz.
const VAR_SET_IN_SCRIPT =
  /(?:pm\.(?:environment|variables|globals|collectionVariables)\.set|postman\.set(?:Environment|Global)Variable)\(\s*['"]([^'"]+)['"]/g;

/** Script sem as linhas comentadas — um `pm.environment.set` comentado não grava nada. */
function activeScript(script: string | undefined): string {
  return String(script ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

/**
 * Nome de campo de body ou de query que guarda credencial. Mais estrito que
 * o do header (secretScan): lá "key" basta, mas num body isso pegaria
 * journeyKey, fareKey, bookingKey — ids, não segredos.
 */
const PAYLOAD_SECRET_KEY =
  /pass(?:word|wd)?$|^pwd$|senha|secret|api[-_]?key|subscription[-_]?key|credential|authorization|(?:^|[-_])token$|[a-z]token$/i;

/**
 * Nome de VARIÁVEL que é credencial pelo nome, com qualquer valor (vazio ou
 * curto). Ancorado no fim: `password`, `b2bPassword`, `apiKey`,
 * `bearerToken` — e não `urlAuthorization` nem `passwordResetUrl`.
 */
const CREDENTIAL_NAME = /(?:pass(?:word|wd)?|pwd|senha|secret|api[-_]?key|subscription[-_]?key|credentials?|token)$/i;

/** "Basic <base64>" de usuário e senha já resolvidos (UTF-8, como o navegador manda). */
export function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function scanInto(names: Set<string>, text: string | undefined, pattern: RegExp) {
  for (const match of String(text ?? '').matchAll(pattern)) names.add(match[1]);
}

/**
 * Credencial literal num header (Authorization, chave de API…) vira uma
 * variável "secret" sem valor. `Bearer <token>` mantém o "Bearer ".
 */
/**
 * Guarda `credential` como variável secreta e devolve o nome dela. O mesmo
 * campo com valores diferentes (em passos diferentes) ganha nomes distintos,
 * e um nome que o flow já usa como variável não é reaproveitado.
 */
type PlaceSecret = (label: string, credential: string) => string;

function secretPlacer(secrets: Map<string, string>, used: ReadonlySet<string>): PlaceSecret {
  return (label, credential) => {
    const base = suggestVariableName(label);
    let name = base;
    for (let i = 2; secrets.has(name) ? secrets.get(name) !== credential : used.has(name); i++) name = `${base}${i}`;
    secrets.set(name, credential);
    return name;
  };
}

function stripLiteralSecrets(headers: Record<string, string>, place: PlaceSecret): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const scheme = value.match(/^(Bearer|Basic)\s+(.+)$/i);
    const credential = scheme ? scheme[2] : value;
    if (isLikelySecretValue(key, credential) || (scheme && isLikelySecretValue('authorization', credential))) {
      const name = place(key, credential);
      out[key] = scheme ? `${scheme[1]} {{${name}}}` : `{{${name}}}`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Valor escrito à mão (não uma {{variável}}) — vazio não é segredo. */
const isLiteralValue = (value: string) => value.trim() !== '' && !value.includes('{{');

/**
 * `a=1&password=x` → `a=1&password={{password}}`. O valor guardado é o texto
 * como está (ainda codificado), pra a troca reproduzir o original.
 */
function stripPairSecrets(text: string, place: PlaceSecret): string {
  return text
    .split('&')
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq <= 0) return pair;
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let decodedKey = key;
      try {
        decodedKey = decodeURIComponent(key.replace(/\+/g, ' '));
      } catch {
        /* fica como está */
      }
      if (!PAYLOAD_SECRET_KEY.test(decodedKey) || !isLiteralValue(value)) return pair;
      return `${key}={{${place(decodedKey, value)}}}`;
    })
    .join('&');
}

/**
 * Credencial escrita no body (JSON ou form) vira variável secreta — antes só
 * os headers passavam por isso, e um login com "password" no body saía em
 * claro no HTML mesmo com os segredos de fora. O JSON é tratado no texto
 * (não por parse/stringify) pra não mudar a formatação nem quebrar um body
 * com {{variáveis}} fora de aspas. O valor guardado é o trecho escapado, que
 * volta idêntico no lugar.
 */
function stripBodySecrets(body: string, place: PlaceSecret): string {
  if (!body) return body;
  const json = body.replace(
    /("((?:[^"\\]|\\.)+)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
    (match, prefix: string, key: string, raw: string) =>
      PAYLOAD_SECRET_KEY.test(key) && isLiteralValue(raw) ? `${prefix}"{{${place(key, raw)}}}"` : match
  );
  if (json !== body) return json;
  // Form (x-www-form-urlencoded): pares chave=valor, sem espaço nem chaves.
  return /^[^=&\s{}[\]"]+=[^&\s]*(?:&[^=&\s]+=[^&\s]*)*$/.test(body.trim()) ? stripPairSecrets(body, place) : body;
}

/** Credencial na query string (`?apikey=...`) vira variável secreta. */
function stripQuerySecrets(url: string, place: PlaceSecret): string {
  const at = url.indexOf('?');
  if (at < 0) return url;
  const hash = url.indexOf('#', at);
  const query = hash < 0 ? url.slice(at + 1) : url.slice(at + 1, hash);
  return url.slice(0, at + 1) + stripPairSecrets(query, place) + (hash < 0 ? '' : url.slice(hash));
}

export function buildFlowData(
  folder: CollectionItem,
  options: {
    /** Caminho da pasta na árvore, da collection até ela. */
    path: string[];
    /** Environments a levar (nome + variáveis). Vazio = um "No environment". */
    environments: { name: string; envMap: Record<string, string> }[];
    /** Qual abre selecionado; padrão, o primeiro. */
    defaultEnvironment?: string;
    /** Leva os valores das variáveis "secret" no arquivo. */
    includeSecrets?: boolean;
    now?: Date;
  }
): FlowData {
  const includeSecrets = options.includeSecrets === true;
  const secrets = new Map<string, string>();
  const used = new Set<string>();
  // Nomes que o flow já usa como variável: uma credencial escrita no texto
  // não ganha o mesmo nome (senão tomaria o lugar da do environment).
  const taken = new Set<string>();
  for (const { item } of collectSteps(folder)) {
    const r = item.request;
    // O body como vai ser enviado (sem os comentários): um {{password}} só
    // num trecho comentado não reserva o nome — a senha escrita no body
    // ganhava "password2" à toa.
    const sentBody = r && requestHasBody(r.bodyType, r.body) ? sanitizeJsonBodyForSend(r.body!) : '';
    for (const text of [r?.url, sentBody, r?.auth?.username, r?.auth?.password, r?.auth?.token, r?.auth?.value,
      ...(r?.headers ?? []).filter(h => h.enabled !== false).flatMap(h => [h.key, h.value])]) scanInto(taken, text, VAR_IN_TEXT);
    for (const script of [r?.scripts?.preRequest, r?.scripts?.postResponse]) {
      scanInto(taken, activeScript(script), VAR_IN_SCRIPT);
      scanInto(taken, activeScript(script), VAR_SET_IN_SCRIPT);
    }
  }
  const place = secretPlacer(secrets, taken);

  const steps: FlowStep[] = collectSteps(folder).map(({ item, path }) => {
    const req = item.request;
    const base = {
      id: item.id,
      name: item.name,
      path,
      description: item.description ?? '',
      preRequest: req?.scripts?.preRequest ?? '',
      postResponse: req?.scripts?.postResponse ?? '',
    };
    for (const script of [base.preRequest, base.postResponse]) {
      scanInto(used, activeScript(script), VAR_IN_SCRIPT);
      scanInto(used, activeScript(script), VAR_SET_IN_SCRIPT);
    }

    if (item.protocol === 'grpc' || !req) {
      return { ...base, kind: 'grpc' as const, method: 'gRPC', url: '', headers: {}, body: '' };
    }
    if (isTokenStep(req)) {
      const tokenVariable = tokenVariableName(req) ?? 'accessToken';
      used.add(tokenVariable);
      return { ...base, kind: 'token' as const, method: 'TOKEN', url: '', headers: {}, body: '', tokenVariable };
    }

    const hasBody = requestHasBody(req.bodyType, req.body);
    const isBasic = req.auth?.type === 'basic';
    // identidade no resolve: os {{placeholders}} ficam pro navegador. A
    // Basic sai à parte (basicAuth): o base64 só existe depois da troca.
    const headers = stripLiteralSecrets(
      buildRequestHeaders({
        userHeaders: (req.headers || []).map(h => ({ key: h.key ?? '', value: h.value ?? '', enabled: h.enabled })),
        disabledDefaults: req.disabledDefaultHeaders,
        hasBody,
        auth: isBasic ? undefined : req.auth,
        resolve: value => value,
      }),
      place
    );
    let basicAuth: FlowStep['basicAuth'];
    if (isBasic) {
      const password = req.auth?.password ?? '';
      basicAuth = {
        username: req.auth?.username ?? '',
        // Senha escrita à mão vira variável secreta, como num header.
        password: isLiteralValue(password) ? `{{${place('password', password)}}}` : password,
      };
      scanInto(used, basicAuth.username, VAR_IN_TEXT);
      scanInto(used, basicAuth.password, VAR_IN_TEXT);
    }
    const url = stripQuerySecrets(replaceUrlParams(req.url || '', req.urlexport?.variable || []), place);
    const body = hasBody ? stripBodySecrets(sanitizeJsonBodyForSend(req.body!), place) : '';

    scanInto(used, url, VAR_IN_TEXT);
    scanInto(used, body, VAR_IN_TEXT);
    for (const [k, v] of Object.entries(headers)) {
      scanInto(used, k, VAR_IN_TEXT);
      scanInto(used, v, VAR_IN_TEXT);
    }

    return {
      ...base, kind: 'http' as const, method: item.method || 'GET', url, headers, body,
      ...(basicAuth ? { basicAuth } : {}),
    };
  });

  const sources = options.environments.length > 0
    ? options.environments
    : [{ name: 'No environment', envMap: {} as Record<string, string> }];
  const keys = [...used].filter(key => !secrets.has(key)).sort((a, b) => a.localeCompare(b));

  // O detector olha o NOME ("auth", "token", "key"…), e `urlAuthorization`
  // casava — a URL base saía vazia e o passo ia pra "/api/v1/token". Valor
  // que é uma URL não é credencial. Secreta em QUALQUER environment = secreta
  // em todos, pra o campo se comportar igual ao trocar de environment.
  // Nome de credencial clara (password, senha, apiKey, bearerToken…) é
  // secreta mesmo vazia ou curta — antes uma senha de 6 dígitos, ou ainda
  // sem valor, aparecia como campo comum e saía em claro no arquivo.
  // Uma URL em qualquer environment decide: não é credencial — senão um
  // urlAuthorization vazio num environment esvaziava a URL de todos.
  const secretKeys = new Set(
    keys.filter(key => {
      const values = sources.map(src => src.envMap[key] ?? '');
      if (values.some(looksLikeUrl)) return false;
      return CREDENTIAL_NAME.test(key) || values.some(value => isLikelySecretValue(key, value));
    })
  );

  const environments: FlowEnvironment[] = sources.map(src => ({
    name: src.name,
    variables: [
      ...keys.map(key => {
        const secret = secretKeys.has(key);
        const value = src.envMap[key] ?? '';
        return { key, value: secret && !includeSecrets ? '' : value, secret };
      }),
      // Credencial escrita direto no header vale igual em todo environment.
      ...[...secrets].map(([key, credential]) => ({ key, value: includeSecrets ? credential : '', secret: true })),
    ],
  }));
  const hasSecretValues = environments.some(env => env.variables.some(v => v.secret && v.value !== ''));
  const defaultEnvironment = environments.some(env => env.name === options.defaultEnvironment)
    ? options.defaultEnvironment!
    : environments[0].name;

  return {
    format: 1,
    id: folder.id,
    name: folder.name,
    description: folder.description ?? '',
    path: options.path,
    generatedAt: (options.now ?? new Date()).toISOString(),
    environments,
    defaultEnvironment,
    steps,
    usesMoment: steps.some(s => /\bmoment\b/.test(s.preRequest) || /\bmoment\b/.test(s.postResponse)),
    includesSecrets: includeSecrets && hasSecretValues,
  };
}

/** JSON seguro dentro de <script>: nada de "</script" nem "<!--" no texto. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STYLE = `
:root { color-scheme: dark; --bg:#17181b; --card:#1f2125; --line:#2f3238; --text:#e6e6e6; --muted:#9aa0a6; --accent:#f26b3a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; }
#app { max-width:1100px; margin:0 auto; padding:24px 20px 80px; }
h1 { font-size:20px; margin:0; } h2 { font-size:14px; margin:0; }
.muted { color:var(--muted); } .small { font-size:12px; }
.desc { color:#c9ccd1; white-space:pre-wrap; margin:8px 0 0; }
header.top { display:flex; flex-wrap:wrap; justify-content:space-between; gap:12px 16px; align-items:flex-start; position:sticky; top:0; background:var(--bg); padding:12px 0; z-index:2; border-bottom:1px solid var(--line); }
.actions { display:flex; gap:8px; align-items:center; flex-shrink:0; flex-wrap:wrap; }
.env-banner { flex-basis:100%; display:flex; align-items:center; gap:10px; flex-wrap:wrap; border-radius:8px; padding:9px 14px; border:1px solid var(--line); background:#2a2d33; }
.env-banner-kind { font:800 11px system-ui,sans-serif; letter-spacing:.08em; padding:3px 8px; border-radius:4px; background:#3a3d44; color:#e6e6e6; }
.env-banner-name { font:700 15px ui-monospace,Consolas,monospace; }
.env-banner-note { font-size:12px; opacity:.85; }
.env-banner.env-prod { background:#3a1414; border-color:#b91c1c; color:#fecaca; }
.env-banner.env-prod .env-banner-kind { background:#dc2626; color:#fff; }
.env-banner.env-staging { background:#3a2a12; border-color:#b45309; color:#fde68a; }
.env-banner.env-staging .env-banner-kind { background:#d97706; color:#fff; }
.env-banner.env-test { background:#12301f; border-color:#15803d; color:#bbf7d0; }
.env-banner.env-test .env-banner-kind { background:#16a34a; color:#fff; }
select.env-prod { border-color:#dc2626; color:#fecaca; }
select.env-staging { border-color:#d97706; color:#fde68a; }
select.env-test { border-color:#16a34a; color:#bbf7d0; }
.progress { margin:10px 0 16px; font-size:12px; }
button { font:600 12px system-ui,sans-serif; border-radius:6px; padding:7px 12px; cursor:pointer; border:1px solid var(--line); background:#2a2d33; color:var(--text); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.ghost { background:transparent; }
button.tiny { padding:3px 8px; font-size:11px; }
button:disabled { opacity:.45; cursor:not-allowed; }
a.button-link { font:600 12px system-ui,sans-serif; color:#93c5fd; text-decoration:none; border:1px solid #1e3a8a; border-radius:6px; padding:6px 10px; }
a.button-link:hover { background:#16263a; }
.toggle { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:4px; white-space:nowrap; }
.env-picker { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; }
select { background:#141518; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:600 12px system-ui,sans-serif; cursor:pointer; max-width:220px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; margin-bottom:10px; }
.card-head { display:flex; align-items:center; gap:12px; padding:12px 14px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
.card-head .ghost { margin-left:auto; }
.vars .card-head { cursor:pointer; user-select:none; }
.vars .chev { display:inline-block; color:var(--muted); transition:transform .15s; }
.vars.collapsed .chev { transform:rotate(-90deg); }
.vars.collapsed .card-head { border-bottom:0; }
.vars.collapsed .vars-body, .vars.collapsed .vars-note { display:none; }
.vars .alert { margin:10px 14px; }
.vars table { width:100%; border-collapse:collapse; }
.vars td { padding:5px 14px; border-bottom:1px solid #26292e; vertical-align:middle; }
.vars td.key { font:12px ui-monospace,Consolas,monospace; width:30%; white-space:nowrap; }
.vars td.narrow { width:60px; text-align:right; }
input { width:100%; background:#141518; color:var(--text); border:1px solid var(--line); border-radius:5px; padding:5px 8px; font:12px ui-monospace,Consolas,monospace; }
.badge { margin-left:6px; font:600 10px system-ui; padding:1px 5px; border-radius:4px; }
.badge.secret { background:#3a2a12; color:#f5b45b; }
.step-head { display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; user-select:none; }
.step-head .index { font:12px ui-monospace,Consolas,monospace; color:var(--muted); }
.step-head .name { flex:1; display:flex; flex-direction:column; min-width:0; }
.step-head .path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.method { font:700 11px ui-monospace,Consolas,monospace; padding:3px 7px; border-radius:4px; min-width:58px; text-align:center; background:#33363c; }
.m-get { background:#14532d; color:#86efac; } .m-post { background:#7c2d12; color:#fdba74; } .m-put { background:#1e3a8a; color:#93c5fd; }
.m-patch { background:#4c1d95; color:#c4b5fd; } .m-delete { background:#7f1d1d; color:#fca5a5; } .m-token { background:#3a2a12; color:#f5b45b; }
.chip { font-size:11px; padding:2px 8px; border-radius:10px; background:#2a2d33; color:var(--muted); white-space:nowrap; }
.chip.success { background:#12301f; color:#6ee7a1; } .chip.error { background:#3a1616; color:#fca5a5; }
.chip.running { background:#16263a; color:#93c5fd; } .chip.skipped { background:#2a2d33; }
.step-body { display:none; padding:4px 14px 14px; border-top:1px solid var(--line); }
.step.open .step-body { display:block; }
.kv { display:flex; gap:10px; align-items:baseline; margin:10px 0 4px; }
.kv .label { font:600 11px system-ui; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; min-width:70px; }
code, pre { font:12px/1.45 ui-monospace,Consolas,monospace; }
code { word-break:break-all; }
pre { background:#141518; border:1px solid #26292e; border-radius:6px; padding:10px; overflow:auto; max-height:420px; white-space:pre-wrap; word-break:break-word; margin:6px 0; }
details { margin:6px 0; } summary { cursor:pointer; color:#c9ccd1; font-size:12px; }
textarea.body-edit { display:block; width:100%; box-sizing:border-box; resize:vertical; background:#141518; color:var(--text); border:1px solid #26292e; border-radius:6px; padding:10px; margin:6px 0 0; font:12px/1.45 ui-monospace,Consolas,monospace; tab-size:2; }
textarea.body-edit:focus { outline:none; border-color:#3b82f6; }
.badge.edited { background:#16263a; color:#93c5fd; }
.row.body-actions { align-items:center; justify-content:space-between; margin:6px 0 0; }
.row { display:flex; gap:8px; margin:12px 0 4px; flex-wrap:wrap; }
.alert { border-radius:6px; padding:8px 10px; margin:10px 0 4px; font-size:12px; white-space:pre-wrap; }
.alert.error { background:#3a1616; border:1px solid #7f1d1d; } .alert.warn { background:#3a2a12; border:1px solid #92400e; }
.alert.info { background:#16263a; border:1px solid #1e3a8a; }
.alert.friendly { font-size:13px; line-height:1.5; }
.alert .api-said { margin-top:6px; font:12px ui-monospace,Consolas,monospace; opacity:.85; }
details.technical summary { color:var(--muted); }
.tests { margin:8px 0; font-size:12px; } .test.pass { color:#6ee7a1; } .test.fail { color:#fca5a5; }
`;

/** O HTML final: dados do flow + runtime embutidos, nada carregado de fora. */
export function renderFlowHtml(flow: FlowData, assets: FlowRuntimeAssets): string {
  const payload = {
    ...flow,
    runtime: { bootstrap: assets.bootstrap, moment: flow.usesMoment ? assets.moment : null },
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="DevFlow">
<title>${escapeHtml(flow.name)} — DevFlow flow</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app"></div>
<noscript>This page runs the flow with JavaScript — enable it to use the page.</noscript>
<script id="flow-data" type="application/json">${scriptJson(payload)}</script>
<script>${assets.runner.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`;
}
