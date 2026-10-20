'use client';

/**
 * usePostmanImport
 * ─────────────────────────────────────────────────────────────────────────────
 * Normaliza qualquer payload vindo do GitHub para o formato interno
 * CollectionItem[] / EnvironmentItem[].
 *
 * Suporta:
 *   • Postman Collection v2.0 e v2.1  ({ info: { schema }, item: [...] })
 *   • Postman Environment Export       ({ id, name, values: [...] })
 *   • Array puro de CollectionItem[]   (formato interno do app)
 *   • Array puro de EnvironmentItem[]  (formato interno do app)
 *   • Wrapper { collections, environments } salvo pelo GitHubSync
 */

import { useCallback, useState } from 'react';
import { CollectionItem }        from '@/app/types/CollectionItem';
import { QueryParam }            from '@/app/types/QueryParam';
import { normalizeAuthType }     from '@/app/types/AuthorizationDetails';
import { normalizeExampleLanguage } from '@/lib/exampleLanguage';

// ─── Tipos auxiliares ─────────────────────────────────────────────────────────

export interface EnvVariable {
  key:     string;
  value:   string;
  enabled: boolean;
  type:    'default' | 'secret';
}

export interface EnvironmentItem {
  id:     string;
  name:   string;
  values: EnvVariable[];
}

export interface ImportResult {
  collections:  CollectionItem[] | null;
  environments: EnvironmentItem[] | null;
  summary:      string;
  warnings:     string[];
}

// ─── Tipo local para o campo request (evita depender de RequestDetails) ───────
// Espelha o que CollectionItem.request precisa ter — ajuste se seu tipo divergir.

interface NormalizedRequest {
  url:       string;
  urlexport: {
    raw:      string;
    host:     string[];
    path:     string[];
    variable: QueryParam[];
  };
  headers:  Array<{ key: string; value: string; enabled: boolean }>;
  body:     string;
  bodyType: 'none' | 'raw' | 'graphql';
  auth:     {
    type:     'none' | 'bearer' | 'basic' | 'oauth2' | 'apikey';
    token?:   string;
    username?: string;
    password?: string;
    key?:     string;
    value?:   string;
    oauth2?:  Array<{ key: string; value: string; enabled: boolean }>;
  };
  scripts: {
    preRequest:   string;
    postResponse: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function uid(): string {
  return typeof crypto !== 'undefined'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function isPostmanSchema(schema: string): boolean {
  return (
    schema.includes('schema.getpostman.com') ||
    schema.includes('v2.0.0') ||
    schema.includes('v2.1.0')
  );
}

function normalizeUrl(urlField: unknown): string {
  if (!urlField) return '';
  if (typeof urlField === 'string') return urlField;
  const u = urlField as Record<string, unknown>;
  if (typeof u['raw'] === 'string') return u['raw'];
  const host = Array.isArray(u['host']) ? (u['host'] as string[]).join('.') : '';
  const path = Array.isArray(u['path']) ? '/' + (u['path'] as string[]).join('/') : '';
  return host ? `https://${host}${path}` : path;
}

function normalizeHeaders(
  headersField: unknown
): Array<{ key: string; value: string; enabled: boolean }> {
  // Exports antigos guardam os headers de resposta como texto cru
  // ("Content-Type: application/json\nX-Id: 1").
  if (typeof headersField === 'string') {
    return headersField
      .split(/\r?\n/)
      .map(line => line.match(/^([^:]+):\s*(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => ({ key: m[1].trim(), value: m[2].trim(), enabled: true }));
  }
  if (!Array.isArray(headersField)) return [];
  return headersField.map((h: any) => ({
    key:     String(h.key   ?? h.name  ?? ''),
    value:   String(h.value ?? ''),
    enabled: h.disabled !== true && h.enabled !== false,
  }));
}

function normalizePathParams(urlField: unknown): QueryParam[] {
  if (!urlField || typeof urlField === 'string') return [];
  const u    = urlField as Record<string, unknown>;
  const vars = Array.isArray(u['variable']) ? (u['variable'] as any[]) : [];

  // Algumas collections trazem a chave com ":" grudado (typo de quem criou
  // a request original, ex: "journeyKey:"), o que cria uma segunda linha
  // duplicada pro mesmo path variable ("journeyKey:" vs "journeyKey").
  // Limpa e deduplica por chave normalizada aqui, na origem do import.
  const seen = new Map<string, QueryParam>();
  const order: string[] = [];

  for (const v of vars) {
    const key = String(v.key ?? v.id ?? '').replace(/^:+|:+$/g, '').trim();
    const value = String(v.value ?? '');
    const enabled = v.disabled !== true;

    const existing = seen.get(key);
    if (!existing) {
      order.push(key);
      seen.set(key, { id: uid(), key, value, enabled });
    } else if (!existing.value && value) {
      seen.set(key, { ...existing, value });
    }
  }

  return order.map((k) => seen.get(k)!);
}

const OAUTH2_KEY_ALIASES: Record<string, string> = {
  redirect_uri: 'callbackUrl',
  grant_type: 'grantType',
  client_authentication: 'clientAuthentication',
  addTokenTo: 'addTokenTo',
};

function normalizeAuth(authField: unknown): NormalizedRequest['auth'] {
  if (!authField || typeof authField !== 'object') return { type: 'none' };
  const a    = authField as Record<string, unknown>;
  // O Postman usa 'noauth'; o app usa 'none' — sem essa normalização o valor
  // 'noauth' vazava pro seletor de Auth da UI, que não reconhece esse tipo.
  const type = normalizeAuthType(a['type']) as NormalizedRequest['auth']['type'];

  if (type === 'bearer') {
    const bearerArr = Array.isArray(a['bearer']) ? (a['bearer'] as any[]) : [];
    const token     = bearerArr.find((b: any) => b.key === 'token')?.value
                    ?? String(a['token'] ?? '');
    return { type: 'bearer', token };
  }

  if (type === 'oauth2') {
    const raw  = a['oauth2'];
    const list: Array<{ key: string; value: string; enabled: boolean }> = Array.isArray(raw)
      ? (raw as any[]).map((item: any) => ({
          key:     OAUTH2_KEY_ALIASES[String(item.key ?? '')] ?? String(item.key ?? ''),
          value:   String(item.value ?? ''),
          enabled: item.disabled !== true,
        }))
      : raw && typeof raw === 'object'
        ? Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
            key: OAUTH2_KEY_ALIASES[key] ?? key,
            value: String(value ?? ''),
            enabled: true,
          }))
        : [];
    return { type: 'oauth2', oauth2: list };
  }

  if (type === 'basic') {
    const basicArr  = Array.isArray(a['basic']) ? (a['basic'] as any[]) : [];
    const findVal   = (k: string) => basicArr.find((i: any) => i.key === k)?.value ?? '';
    return {
      type:     'basic',
      username: findVal('username') || String(a['username'] ?? ''),
      password: findVal('password') || String(a['password'] ?? ''),
    };
  }

  if (type === 'apikey') {
    // O Postman guarda key/value dentro do array `apikey` (mesmo padrão de
    // basic/bearer) — key/value soltos em `a` não existem no formato real,
    // então a leitura direta sempre voltava vazia.
    const apikeyArr = Array.isArray(a['apikey']) ? (a['apikey'] as any[]) : [];
    const findVal    = (k: string) => apikeyArr.find((i: any) => i.key === k)?.value ?? '';
    return {
      type:  'apikey',
      key:   findVal('key')   || String(a['key']   ?? ''),
      value: findVal('value') || String(a['value'] ?? ''),
    };
  }

  return { type: 'none' };
}

function normalizeBody(bodyField: unknown): { body: string; bodyType: 'none' | 'raw' | 'graphql' } {
  if (!bodyField || typeof bodyField !== 'object') return { body: '', bodyType: 'none' };
  const b    = bodyField as Record<string, unknown>;
  const mode = String(b['mode'] ?? 'none');

  if (mode === 'raw') {
    return { body: String(b['raw'] ?? ''), bodyType: 'raw' };
  }

  // Remonta no MESMO formato JSON.stringify({query, variables}) que o
  // RequestBodySelector grava (ver serializeGraphQLBody), pra reabrir a
  // request já preenchida na aba GraphQL em vez de cair em "raw".
  if (mode === 'graphql') {
    const gql = (b['graphql'] ?? {}) as Record<string, unknown>;
    const query = String(gql['query'] ?? '');
    const rawVariables = gql['variables'];
    const variables = typeof rawVariables === 'string'
      ? rawVariables
      : JSON.stringify(rawVariables ?? {}, null, 2);
    return { body: JSON.stringify({ query, variables }), bodyType: 'graphql' };
  }

  if (mode === 'formdata' || mode === 'urlencoded') {
    const fields = b[mode];
    try {
      return { body: JSON.stringify(fields, null, 2), bodyType: 'raw' };
    } catch {
      return { body: '', bodyType: 'none' };
    }
  }

  return { body: '', bodyType: 'none' };
}

function normalizeScripts(
  eventField: unknown,
  fallbackEvents?: unknown
): NormalizedRequest['scripts'] {
  const result = { preRequest: '', postResponse: '' };
  const events: any[] = Array.isArray(eventField)
    ? (eventField as any[])
    : Array.isArray(fallbackEvents) ? (fallbackEvents as any[]) : [];

  for (const evt of events) {
    const exec = Array.isArray(evt.script?.exec)
      ? (evt.script.exec as string[]).join('\n')
      : String(evt.script?.exec ?? '');

    if (evt.listen === 'prerequest') result.preRequest  = exec;
    if (evt.listen === 'test')       result.postResponse = exec;
  }

  return result;
}

// Monta o NormalizedRequest a partir de um objeto `request` (ou
// `originalRequest`, mesmo formato) do Postman — reaproveitado tanto pela
// request "de verdade" de um item quanto pelo `originalRequest` de cada
// Saved Example dela (ambos guardam o snapshot no mesmo formato).
function normalizeRequestObject(
  req: Record<string, unknown>,
  eventField?: unknown,
  fallbackEvents?: unknown,
  // Auth da pasta/collection mais próxima — usada quando a request não tem
  // a sua (no Postman, "Inherit auth from parent" = sem campo auth).
  inheritedAuth?: unknown
): NormalizedRequest {
  const rawUrl             = req['url']
  const url                = normalizeUrl(rawUrl)
  const { body, bodyType } = normalizeBody(req['body'])
  const scripts             = normalizeScripts(eventField ?? req['event'], fallbackEvents)

  return {
    url,
    urlexport: {
      raw:      url,
      host:     Array.isArray((rawUrl as any)?.host) ? (rawUrl as any).host : [],
      path:     Array.isArray((rawUrl as any)?.path) ? (rawUrl as any).path : [],
      variable: normalizePathParams(rawUrl),
    },
    headers:  normalizeHeaders(req['header'] ?? req['headers']),
    body,
    bodyType,
    auth:     normalizeAuth(ownAuth(req['auth']) ?? inheritedAuth),
    scripts,
  }
}

// Auth definida no próprio nível, ou undefined se ele herda do pai.
// "noauth" é explícito (sem auth, sem herdar); "inherit" e ausência herdam.
function ownAuth(authField: unknown): unknown {
  if (!authField || typeof authField !== 'object') return undefined;
  const type = String((authField as Record<string, unknown>)['type'] ?? '').toLowerCase();
  return type === '' || type === 'inherit' ? undefined : authField;
}

function normalizeMethod(req: Record<string, unknown>): string {
  return typeof req['method'] === 'string' ? (req['method'] as string).toUpperCase() : 'GET'
}

// ─── Conversor: response[] do Postman (Saved Examples) → CollectionItem[] ─────
// item.response[] no schema Postman: { id, name, originalRequest, status,
// code, header: [{key,value}], cookie, body, _postman_previewlanguage }.
// Viram filhos type:'example' do request, pra aparecer na árvore igual ao
// Postman de verdade (request > exemplos nomeados). `originalRequest` é o
// snapshot completo da request (method/url/headers/body/auth) — sem
// convertê-lo, o body/URL da request não carregava ao abrir o example.
function convertPostmanExample(
  raw: any,
  parent: { method: string; request: NormalizedRequest; auth: unknown }
): CollectionItem {
  const bodyField = raw?.body;
  const body = typeof bodyField === 'string'
    ? bodyField
    : bodyField !== undefined && bodyField !== null
      ? JSON.stringify(bodyField, null, 2)
      : '';

  const original = raw?.originalRequest;
  const hasOriginal = original && typeof original === 'object' && Object.keys(original).length > 0;
  const headers = normalizeHeaders(raw?.header ?? raw?.headers);
  const code = Number(raw?.code) || 200;

  // Sem originalRequest (exports antigos/feitos à mão) o example documenta a
  // própria request dona — antes virava um GET com URL vazia. O snapshot não
  // costuma trazer auth: herda a da request (que já resolveu a herança da
  // pasta/collection), igual o Postman faz no Try.
  const request = hasOriginal
    ? normalizeRequestObject(original as Record<string, unknown>, undefined, undefined, parent.auth)
    : { ...parent.request, headers: parent.request.headers.map(h => ({ ...h })) };

  return {
    id:      raw?.id ?? uid(),
    name:    raw?.name ?? 'Example',
    type:    'example',
    method:  hasOriginal ? normalizeMethod(original as Record<string, unknown>) : parent.method,
    request,
    example: {
      status:          String(raw?.status ?? '') || 'OK',
      code,
      headers,
      body,
      previewLanguage: normalizeExampleLanguage(raw?._postman_previewlanguage, headers, body),
    },
  } as unknown as CollectionItem;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversor: item Postman raw → CollectionItem interno
// ─────────────────────────────────────────────────────────────────────────────

function convertPostmanItem(raw: any, warnings: string[], inheritedAuth?: unknown): CollectionItem {
  // Pasta = tem "item" (mesmo vazio) e não tem "request". Antes só contava
  // como pasta se tivesse filhos, e uma pasta vazia virava request sem URL.
  const isFolder = Array.isArray(raw.item) && !raw.request;

  if (isFolder) {
    const folderAuth = ownAuth(raw.auth) ?? inheritedAuth;
    return {
      id:      raw.id   ?? uid(),
      name:    raw.name ?? 'Unnamed Folder',
      type:    'folder',
      item:    (raw.item as any[]).map(child => convertPostmanItem(child, warnings, folderAuth)),
      method:  undefined,
      request: undefined,
    } as unknown as CollectionItem;
  }

  const req              = (raw.request ?? {}) as Record<string, unknown>;
  // Auth efetiva da request: a própria, senão a da pasta/collection.
  const effectiveAuth     = ownAuth(req['auth']) ?? inheritedAuth;
  const normalizedRequest = normalizeRequestObject(req, raw.event, raw.events, effectiveAuth);
  const method            = normalizeMethod(req);

  if (!normalizedRequest.url) warnings.push(`Item "${raw.name ?? '?'}" has no URL defined.`);

  const examples = Array.isArray(raw.response)
    ? (raw.response as any[]).map(example =>
        convertPostmanExample(example, { method, request: normalizedRequest, auth: effectiveAuth })
      )
    : [];

  return {
    id:      raw.id   ?? uid(),
    name:    raw.name ?? 'Unnamed Request',
    type:    'request',
    method,
    request: normalizedRequest,
    item:    examples.length ? examples : undefined,
  } as unknown as CollectionItem;
}

// ─── Conversor: ambiente Postman → EnvironmentItem ────────────────────────────

function convertPostmanEnvironment(raw: any): EnvironmentItem {
  const values: EnvVariable[] = ((raw.values ?? raw.variables ?? []) as any[]).map(
    (v: any) => ({
      key:     String(v.key   ?? v.name  ?? ''),
      value:   String(v.value ?? ''),
      enabled: v.enabled !== false && v.disabled !== true,
      type:    v.type === 'secret' ? 'secret' : 'default',
    })
  );
  return {
    id:     raw.id ?? raw._postman_id ?? uid(),
    name:   raw.name ?? 'Unnamed Environment',
    values,
  };
}

// ─── Decide se o item já é CollectionItem interno ou precisa conversão ─────────

function parseCollectionsArray(arr: any[], warnings: string[]): CollectionItem[] {
  return arr.map(item =>
    item.type === 'folder' || item.type === 'request'
      ? (item as CollectionItem)
      : convertPostmanItem(item, warnings)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser principal — detecta formato e roteia
// ─────────────────────────────────────────────────────────────────────────────

export function parsePostmanImport(raw: unknown): ImportResult {
  const warnings: string[]                   = [];
  let collections:  CollectionItem[]  | null = null;
  let environments: EnvironmentItem[] | null = null;
  let summary                                = '';

  try {
    if (raw === null || raw === undefined) {
      return { collections: null, environments: null, summary: 'Empty payload.', warnings: ['No data received.'] };
    }

    // ── 1. Wrapper { collections?, environments? } (GitHubSync) ───────────────
    if (
      !Array.isArray(raw) &&
      typeof raw === 'object' &&
      ('collections' in (raw as object) || 'environments' in (raw as object))
    ) {
      const w = raw as Record<string, unknown>;
      if (Array.isArray(w['collections'])) {
        collections = parseCollectionsArray(w['collections'] as any[], warnings);
      }
      if (Array.isArray(w['environments'])) {
        environments = (w['environments'] as any[]).map(convertPostmanEnvironment);
      }
      const parts: string[] = [];
      if (collections)  parts.push(`${collections.length} collection(s)`);
      if (environments) parts.push(`${environments.length} environment(s)`);
      summary = parts.length ? `Imported: ${parts.join(' and ')}.` : 'No data found in the wrapper.';
      return { collections, environments, summary, warnings };
    }

    // ── 2. Postman Collection Export { info: { schema }, item: [...] } ─────────
    if (
      !Array.isArray(raw) &&
      typeof raw === 'object' &&
      (raw as Record<string, unknown>)['info'] !== undefined
    ) {
      const col    = raw as Record<string, unknown>;
      const info   = col['info'] as Record<string, unknown>;
      const schema = String(info['schema'] ?? '');

      if (schema && !isPostmanSchema(schema)) {
        warnings.push(`Unknown schema: ${schema}. Trying to import anyway.`);
      }

      const items = Array.isArray(col['item']) ? (col['item'] as any[]) : [];
      // Auth definida na collection vale pra toda request que herda.
      const collectionAuth = ownAuth(col['auth']);
      collections = items.map(item => convertPostmanItem(item, warnings, collectionAuth));
      summary     = `Collection "${String(info['name'] ?? 'unnamed')}" — ${collections.length} item(s).`;
      return { collections, environments: null, summary, warnings };
    }

    // ── 3. Postman Environment Export { name, values } ────────────────────────
    if (
      !Array.isArray(raw) &&
      typeof raw === 'object' &&
      'values' in (raw as object) &&
      'name'   in (raw as object)
    ) {
      environments = [convertPostmanEnvironment(raw)];
      summary = `Environment "${(raw as any).name}" — ${environments[0].values.length} variable(s).`;
      return { collections: null, environments, summary, warnings };
    }

    // ── 4. Array puro ─────────────────────────────────────────────────────────
    if (Array.isArray(raw)) {
      const first = (raw as any[])[0];
      if (first !== undefined && 'values' in first && 'name' in first) {
        environments = (raw as any[]).map(convertPostmanEnvironment);
        summary      = `${environments.length} environment(s) imported.`;
      } else {
        collections = parseCollectionsArray(raw as any[], warnings);
        summary     = `${collections.length} item(s) imported.`;
      }
      return { collections, environments, summary, warnings };
    }

    // ── 5. Unrecognized format ─────────────────────────────────────────────
    warnings.push('Unrecognized JSON structure.');
    return { collections: null, environments: null, summary: 'No data imported.', warnings };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      collections:  null,
      environments: null,
      summary:      'Error processing the file.',
      warnings:     [`Internal error: ${msg}`],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook React
// ─────────────────────────────────────────────────────────────────────────────

export interface UsePostmanImportReturn {
  importData: (raw: unknown) => ImportResult;
  lastResult: ImportResult | null;
  reset:      () => void;
}

export function usePostmanImport(): UsePostmanImportReturn {
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);

  const importData = useCallback((raw: unknown): ImportResult => {
    const result = parsePostmanImport(raw);
    setLastResult(result);
    return result;
  }, []);

  const reset = useCallback(() => setLastResult(null), []);

  return { importData, lastResult, reset };
}