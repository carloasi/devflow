import type { CollectionItem } from '@/app/types/CollectionItem';
import { normalizeExampleLanguage } from '@/lib/exampleLanguage';

// ─────────────────────────────────────────────────────────────────────────
// HAR (HTTP Archive 1.2) → collection: uma request por entrada de
// `log.entries`, na ordem do arquivo, com a resposta gravada (quando há)
// como Saved Example da request. É o caminho inverso de
// lib/flowHtml/buildFlowHar.ts — mesmo mapeamento de campos (método, URL,
// headers, postData), só que lendo.
//
// HAR do Chrome DevTools traz a página inteira (imagens, CSS, scripts,
// fontes): essas entradas ficam de fora, só o que é chamada de API vira
// request. Pseudo-headers do HTTP/2 (`:authority`, `:path`...) e os que o
// cliente HTTP calcula sozinho (content-length, host) também.
// ─────────────────────────────────────────────────────────────────────────

export interface HarImportResult {
  collection: CollectionItem | null;
  warnings: string[];
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** O conteúdo tem cara de HAR (`log.entries` é uma lista)? */
export function isHar(doc: unknown): boolean {
  return isRecord(doc) && isRecord(doc.log) && Array.isArray(doc.log.entries);
}

// Tipos de recurso do Chrome (`_resourceType`) que não são chamada de API.
const STATIC_RESOURCE_TYPES = new Set([
  'image', 'stylesheet', 'script', 'font', 'media', 'manifest', 'texttrack', 'websocket', 'ping', 'cspviolationreport', 'preflight',
]);

// Calculados pelo próprio cliente HTTP na hora de enviar — copiá-los só
// atrapalha (um content-length velho quebra o body editado).
const DROPPED_HEADERS = new Set(['content-length', 'host', 'transfer-encoding']);

function headersOf(raw: unknown): Array<{ key: string; value: string; enabled: boolean }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map(h => ({ key: str(h.name), value: str(h.value) }))
    .filter(h => h.key && !h.key.startsWith(':') && !DROPPED_HEADERS.has(h.key.toLowerCase()))
    .map(h => ({ ...h, enabled: true }));
}

function headerValue(headers: Array<{ key: string; value: string }>, name: string): string {
  return headers.find(h => h.key.toLowerCase() === name)?.value ?? '';
}

/** Junta `queryString` na URL quando a URL do HAR veio sem eles. */
function urlOf(request: Json): string {
  const url = str(request.url);
  if (url.includes('?') || !Array.isArray(request.queryString) || request.queryString.length === 0) return url;
  const query = request.queryString
    .filter(isRecord)
    .map(q => `${encodeURIComponent(str(q.name))}=${encodeURIComponent(str(q.value))}`)
    .join('&');
  return query ? `${url}?${query}` : url;
}

function bodyOf(
  postData: unknown,
  headers: Array<{ key: string; value: string; enabled: boolean }>,
  warn: (msg: string) => void,
): string {
  if (!isRecord(postData)) return '';
  const text = str(postData.text);
  if (text) return text;

  // Sem `text`, o corpo só existe nos `params` (form-urlencoded ou multipart).
  const params = Array.isArray(postData.params) ? postData.params.filter(isRecord) : [];
  if (params.length === 0) return '';
  const mimeType = (str(postData.mimeType) || headerValue(headers, 'content-type')).toLowerCase();

  if (mimeType.startsWith('multipart/form-data')) {
    // Reconstrói o corpo cru com o boundary do Content-Type (ou um novo,
    // ajustando o header pra combinar).
    let boundary = /boundary=("?)([^";]+)\1/i.exec(headerValue(headers, 'content-type') || str(postData.mimeType))?.[2];
    if (!boundary) {
      boundary = `----DevFlowBoundary${Math.random().toString(16).slice(2)}`;
      const contentType = `multipart/form-data; boundary=${boundary}`;
      const existing = headers.find(h => h.key.toLowerCase() === 'content-type');
      if (existing) existing.value = contentType;
      else headers.push({ key: 'Content-Type', value: contentType, enabled: true });
    }
    const parts = params.map(p => {
      const fileName = str(p.fileName);
      const disposition = `Content-Disposition: form-data; name="${str(p.name)}"${fileName ? `; filename="${fileName}"` : ''}`;
      const type = str(p.contentType);
      if (fileName && !str(p.value)) warn(`File "${fileName}" in field "${str(p.name)}" has no content in the HAR — sent empty.`);
      return `--${boundary}\r\n${disposition}\r\n${type ? `Content-Type: ${type}\r\n` : ''}\r\n${str(p.value)}\r\n`;
    });
    return `${parts.join('')}--${boundary}--\r\n`;
  }

  // form-urlencoded (e qualquer outro tipo que só veio com params).
  return params.map(p => `${encodeURIComponent(str(p.name))}=${encodeURIComponent(str(p.value))}`).join('&');
}

const BINARY_MIME = /^(image|audio|video|font)\/|octet-stream|zip|pdf|wasm|protobuf/i;

/** Corpo da resposta como texto; base64 é decodificado como UTF-8. */
function responseBodyOf(content: unknown): string {
  if (!isRecord(content)) return '';
  const text = str(content.text);
  if (!text) return '';
  if (BINARY_MIME.test(str(content.mimeType))) return '';
  if (str(content.encoding).toLowerCase() !== 'base64') return text;
  try {
    const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return ''; // base64 inválido ou bytes que não são texto
  }
}

/**
 * A resposta gravada no HAR vira um Saved Example da request (mesma forma
 * que o import do Postman usa pra `item.response[]`). Sem resposta real
 * (status 0 — ex.: HAR do buildFlowHar, ou request cancelada) não há example.
 */
function exampleOf(entry: Json, method: string, request: CollectionItem['request']): CollectionItem | null {
  const response = entry.response;
  if (!isRecord(response)) return null;
  const code = Number(response.status) || 0;
  if (code <= 0) return null;

  const headers = Array.isArray(response.headers)
    ? response.headers
        .filter(isRecord)
        .map(h => ({ key: str(h.name), value: str(h.value), enabled: true }))
        .filter(h => h.key && !h.key.startsWith(':'))
    : [];
  const body = responseBodyOf(response.content);
  const status = str(response.statusText) || (code >= 200 && code < 300 ? 'OK' : String(code));

  return {
    id: crypto.randomUUID(),
    name: `${code} ${status}`,
    type: 'example',
    method: method as CollectionItem['method'],
    request: { ...request!, headers: request!.headers.map(h => ({ ...h })) },
    example: { status, code, headers, body, previewLanguage: normalizeExampleLanguage(undefined, headers, body) },
  };
}

/** "GET /api/v1/users" — método + path, sem query. */
function requestName(method: string, url: string): string {
  try {
    const { pathname } = new URL(url);
    return `${method} ${decodeURIComponent(pathname) || '/'}`;
  } catch {
    return `${method} ${url.split('?')[0] || '/'}`;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'other';
  } catch {
    return 'other';
  }
}

/**
 * Converte um HAR numa collection (pasta raiz com o nome `name`). Se as
 * requests vêm de mais de um host, cada host vira uma subpasta.
 */
export function parseHar(doc: unknown, name = 'HAR import'): HarImportResult {
  const warnings: string[] = [];
  if (!isHar(doc)) return { collection: null, warnings: ['File is not a HAR (missing log.entries).'] };

  const entries = ((doc as { log: { entries: unknown[] } }).log.entries).filter(isRecord);
  const requests: Array<{ host: string; item: CollectionItem }> = [];
  let skippedStatic = 0;

  for (const entry of entries) {
    const request = entry.request;
    if (!isRecord(request)) continue;
    const url = urlOf(request);
    if (!/^https?:/i.test(url) && !/^\{\{/.test(url)) {
      skippedStatic++; // data:, blob:, chrome-extension:, ws:...
      continue;
    }
    if (STATIC_RESOURCE_TYPES.has(str(entry._resourceType).toLowerCase())) {
      skippedStatic++;
      continue;
    }

    const method = (str(request.method) || 'GET').toUpperCase();
    const headers = headersOf(request.headers);
    const body = bodyOf(request.postData, headers, msg => warnings.push(msg));
    const details: CollectionItem['request'] = {
      url,
      urlexport: { raw: url, host: [], path: [], variable: [] },
      headers,
      body,
      bodyType: body ? 'raw' : 'none',
      auth: { type: 'none' },
      scripts: { preRequest: '', postResponse: '' },
    };
    const example = exampleOf(entry, method, details);

    requests.push({
      host: hostOf(url),
      item: {
        id: crypto.randomUUID(),
        name: requestName(method, url),
        type: 'request',
        // HEAD/OPTIONS também chegam aqui — o tipo só lista os 5 comuns,
        // mesmo cast do import de OpenAPI.
        method: method as CollectionItem['method'],
        request: details,
        ...(example ? { item: [example] } : {}),
        ...(str(entry.comment) ? { description: str(entry.comment) } : {}),
      } as CollectionItem,
    });
  }

  if (skippedStatic > 0) {
    warnings.push(`${skippedStatic} entr${skippedStatic === 1 ? 'y' : 'ies'} left out (images, scripts, styles, fonts and other non-API resources).`);
  }
  if (requests.length === 0) {
    return { collection: null, warnings: [...warnings, 'No HTTP request found in this HAR.'] };
  }

  const hosts = [...new Set(requests.map(r => r.host))];
  const children: CollectionItem[] =
    hosts.length > 1
      ? hosts.map(host => ({
          id: crypto.randomUUID(),
          name: host,
          type: 'folder',
          item: requests.filter(r => r.host === host).map(r => r.item),
        }))
      : requests.map(r => r.item);

  return {
    collection: { id: crypto.randomUUID(), name, type: 'folder', item: children },
    warnings,
  };
}
