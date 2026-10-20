// ─────────────────────────────────────────────────────────────────────────
// URL no formato Postman v2.1, derivada SEMPRE do texto cru.
//
// O export guardava duas versões da mesma URL: o `raw` e as partes
// (`host`/`path`), estas últimas preenchidas na importação. Editar a URL no
// app atualizava só o `raw`, então nas requests importadas e depois editadas
// as duas passavam a se contradizer.
//
// Isso não é cosmético porque o Postman IGNORA o `raw`: recebendo um objeto,
// `Url.update()` lê protocol/auth/host/port/path/query e `Url.toString()`
// remonta tudo pelas partes — o `raw` só existe para quem lê o arquivo. Numa
// base real, 296 de 8.279 requests exportavam um endpoint diferente do que a
// tela mostrava, sem erro e sem aviso.
//
// A saída é derivar as partes do `raw` toda vez. Elas passam a concordar por
// construção, em vez de depender de cada editor de URL lembrar de
// ressincronizar — que é a classe de defeito que falha em silêncio.
// ─────────────────────────────────────────────────────────────────────────

export interface PostmanQueryParam {
  key: string;
  value: string;
}

export interface PostmanUrlAuth {
  user: string;
  password?: string;
}

export interface PostmanUrlObject {
  raw: string;
  protocol?: string;
  auth?: PostmanUrlAuth;
  host: string[];
  port?: string;
  path: string[];
  query: PostmanQueryParam[];
  hash?: string;
  variable: unknown[];
}

const PROTOCOL = /^([a-zA-Z][a-zA-Z\d+\-.]*):\/\//;

/**
 * Quebra o host em rótulos, sem cortar dentro de `{{ }}`.
 *
 * Um ponto dentro de uma variável não separa domínio: `{{base.url}}` é um
 * nome só, e dividi-lo produziria `["{{base", "url}}"]` — que o Postman
 * remontaria como um host inexistente.
 */
function splitHost(host: string): string[] {
  if (!host) return [];

  const out: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < host.length; i++) {
    if (host.startsWith('{{', i)) {
      depth++;
      current += '{{';
      i++;
      continue;
    }
    if (host.startsWith('}}', i)) {
      depth = Math.max(0, depth - 1);
      current += '}}';
      i++;
      continue;
    }
    if (host[i] === '.' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += host[i];
  }
  out.push(current);

  return out.filter(part => part !== '');
}

/**
 * Separa a porta do host.
 *
 * Só conta como porta o que vem no fim e é número ou variável — assim
 * `{{host}}:{{port}}` funciona e um `:` no meio de um nome não vira porta por
 * engano.
 */
function splitPort(authority: string): { host: string; port?: string } {
  const match = authority.match(/^(.*):(\d+|\{\{[^{}]+\}\})$/);
  if (!match) return { host: authority };
  return { host: match[1], port: match[2] };
}

function splitAuth(authority: string): { authority: string; auth?: PostmanUrlAuth } {
  const at = authority.lastIndexOf('@');
  if (at < 0) return { authority };

  const credentials = authority.slice(0, at);
  const rest = authority.slice(at + 1);
  const colon = credentials.indexOf(':');

  return {
    authority: rest,
    auth:
      colon < 0
        ? { user: credentials }
        : { user: credentials.slice(0, colon), password: credentials.slice(colon + 1) },
  };
}

function parseQuery(queryString: string): PostmanQueryParam[] {
  if (!queryString) return [];

  // Decodifica para exibir legível; o Postman reencoda ao enviar. Um valor
  // que não decodifica (um `%` solto) fica como está em vez de derrubar o
  // export inteiro.
  const safeDecode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  return queryString
    .split('&')
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      return eq < 0
        ? { key: safeDecode(pair), value: '' }
        : { key: safeDecode(pair.slice(0, eq)), value: safeDecode(pair.slice(eq + 1)) };
    });
}

/**
 * Monta o objeto `url` do formato Postman a partir do texto cru.
 *
 * `variable` entra de fora: os path params são guardados à parte no app e
 * acompanham a edição, diferente de host/path.
 */
export function toPostmanUrl(raw: string, variable: unknown[] = []): PostmanUrlObject {
  const text = raw ?? '';

  const protocolMatch = text.match(PROTOCOL);
  const protocol = protocolMatch ? protocolMatch[1] : undefined;

  // `//host/path` sem esquema também é endereço absoluto.
  let rest = protocolMatch ? text.slice(protocolMatch[0].length) : text.replace(/^\/\//, '');

  let hash: string | undefined;
  const hashAt = rest.indexOf('#');
  if (hashAt >= 0) {
    hash = rest.slice(hashAt + 1);
    rest = rest.slice(0, hashAt);
  }

  let queryString = '';
  const queryAt = rest.indexOf('?');
  if (queryAt >= 0) {
    queryString = rest.slice(queryAt + 1);
    rest = rest.slice(0, queryAt);
  }

  const slash = rest.indexOf('/');
  const authorityRaw = slash < 0 ? rest : rest.slice(0, slash);
  const pathRaw = slash < 0 ? '' : rest.slice(slash + 1);

  const { authority, auth } = splitAuth(authorityRaw);
  const { host, port } = splitPort(authority);

  const url: PostmanUrlObject = {
    raw: text,
    host: splitHost(host),
    // Segmentos `:nome` ficam como estão: é assim que o Postman representa
    // path param, e o valor viaja no `variable`.
    path: pathRaw.split('/').filter(Boolean),
    query: parseQuery(queryString),
    variable,
  };

  // Campos ausentes ficam de FORA do objeto em vez de sair como undefined:
  // `JSON.stringify` os omite de qualquer forma, e declará-los vazios faria
  // o Postman montar `://` ou `:` sem valor.
  if (protocol) url.protocol = protocol;
  if (auth) url.auth = auth;
  if (port) url.port = port;
  if (hash) url.hash = hash;

  return url;
}
