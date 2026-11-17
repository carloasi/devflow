import { basicAuthorization, type FlowData } from './buildFlowHtml';

// ─────────────────────────────────────────────────────────────────────────
// Flow → HAR (HTTP Archive 1.2): as requisições do flow, em ordem, num
// arquivo que DevTools do Chrome, Fiddler, Charles, Postman e Insomnia abrem.
//
// Parte do MESMO FlowData do HTML runner (buildFlowData): headers, auth e
// body já montados como no Runner, com os {{placeholders}} trocados pelos
// valores do environment escolhido. HAR não tem lugar pra script nem pra
// "passo de token": os scripts vão no comentário da entrada, e o passo de
// token (login OAuth) fica de fora.
//
// O HAR de uma EXECUÇÃO (com as respostas reais) é gerado pelo próprio HTML
// runner (public/runtime/flow-runner.js, "Download .har").
// ─────────────────────────────────────────────────────────────────────────

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: never[];
    headers: HarHeader[];
    queryString: HarHeader[];
    postData?: { mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: never[];
    headers: HarHeader[];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  comment?: string;
}

export interface Har {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    comment?: string;
    entries: HarEntry[];
  };
}

function substitute(text: string, env: Record<string, string>): string {
  return text.replace(/\{\{(.*?)\}\}/g, (_, raw) => {
    const key = String(raw).trim();
    return env[key] !== undefined && env[key] !== null ? env[key] : `{{${key}}}`;
  });
}

function queryStringOf(url: string): HarHeader[] {
  const at = url.indexOf('?');
  if (at < 0) return [];
  return url
    .slice(at + 1)
    .split('#')[0]
    .split('&')
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? '' : pair.slice(eq + 1);
      const decode = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      return { name: decode(name), value: decode(value) };
    });
}

function mimeTypeOf(headers: HarHeader[]): string {
  return headers.find(h => h.name.toLowerCase() === 'content-type')?.value || 'application/octet-stream';
}

/**
 * HAR das requisições do flow, com os valores do environment `envName`
 * (padrão: o que abriria selecionado no HTML).
 */
export function buildFlowHar(flow: FlowData, options: { envName?: string; now?: Date } = {}): Har {
  const env: Record<string, string> = {};
  const chosen = flow.environments.find(e => e.name === (options.envName ?? flow.defaultEnvironment)) ?? flow.environments[0];
  for (const variable of chosen?.variables ?? []) env[variable.key] = variable.value;

  const startedDateTime = (options.now ?? new Date()).toISOString();
  const entries: HarEntry[] = [];

  for (const step of flow.steps) {
    if (step.kind !== 'http') continue;
    const url = substitute(step.url, env);
    let headers = Object.entries(step.headers).map(([name, value]) => ({
      name: substitute(name, env),
      value: substitute(value, env),
    }));
    // Auth Basic: o base64 de usuário e senha já trocados (como no envio).
    if (step.basicAuth) {
      headers = headers.filter(h => h.name.toLowerCase() !== 'authorization');
      headers.push({
        name: 'Authorization',
        value: basicAuthorization(substitute(step.basicAuth.username, env), substitute(step.basicAuth.password, env)),
      });
    }
    const body = step.body ? substitute(step.body, env) : '';
    const hasBody = !!body && step.method !== 'GET' && step.method !== 'HEAD';

    const notes = [
      [...step.path, step.name].join(' / '),
      step.description,
      step.preRequest.trim() ? `Pre-request script:\n${step.preRequest}` : '',
      step.postResponse.trim() ? `Post-response script:\n${step.postResponse}` : '',
    ].filter(Boolean);

    entries.push({
      startedDateTime,
      time: 0,
      request: {
        method: step.method,
        url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers,
        queryString: queryStringOf(url),
        ...(hasBody ? { postData: { mimeType: mimeTypeOf(headers), text: body } } : {}),
        headersSize: -1,
        bodySize: hasBody ? new TextEncoder().encode(body).length : 0,
      },
      // Exportado da definição, não de uma execução: não há resposta.
      response: {
        status: 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [],
        content: { size: 0, mimeType: 'x-unknown' },
        redirectURL: '',
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
      comment: notes.join('\n\n'),
    });
  }

  const skipped = flow.steps.filter(s => s.kind !== 'http').map(s => s.name);
  return {
    log: {
      version: '1.2',
      creator: { name: 'DevFlow', version: '1' },
      comment:
        `Flow "${[...flow.path].join(' / ') || flow.name}" — environment "${chosen?.name ?? ''}". Requests only (not executed).` +
        (skipped.length ? ` Left out (no HTTP request to describe): ${skipped.join(', ')}.` : ''),
      entries,
    },
  };
}
