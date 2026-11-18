import type { CollectionItem } from '@/app/types/CollectionItem';
import { REDACTED } from './redactSecrets';

// ─────────────────────────────────────────────────────────────────────────
// Edições da árvore pelo MCP: update_request, move_item (delete_item usa o
// removeNode da árvore). Sem Tauri, testável fora do app.
//
// Antes o agente não conseguia corrigir URL, header nem body: tinha de criar
// outra request e pedir ao usuário para apagar a antiga — e uma IA menor se
// perdia nisso. A armadilha de editar é o segredo: o `get_request` devolve
// credencial como "[redacted — set in DevFlow]", e o agente tende a devolver
// esse texto de volta. Aqui ele vale como "mantenha o que estava".
// ─────────────────────────────────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
const AUTH_TYPES = ['none', 'bearer', 'basic', 'apikey', 'oauth2'] as const;

type Header = { key: string; value: string; enabled: boolean };

export interface RequestPatch {
  method?: string;
  url?: string;
  pathParams?: Record<string, string>;
  headers?: { key: string; value?: string; enabled?: boolean }[];
  body?: string;
  bodyType?: 'none' | 'raw' | 'graphql';
  auth?: {
    type?: string;
    token?: string;
    username?: string;
    password?: string;
    key?: string;
    value?: string;
    oauth2?: { key: string; value?: string; enabled?: boolean }[];
  };
  preRequestScript?: string;
  postResponseScript?: string;
}

const PATCH_FIELDS: (keyof RequestPatch)[] = [
  'method', 'url', 'pathParams', 'headers', 'body', 'bodyType', 'auth', 'preRequestScript', 'postResponseScript',
];

/** "[redacted — set in DevFlow]" devolvido pelo agente = mantenha o valor atual. */
function keepIfRedacted(incoming: string | undefined, current: string | undefined, what: string): string | undefined {
  if (incoming === undefined) return current;
  if (incoming.trim() !== REDACTED) return incoming;
  if (current === undefined) {
    throw new Error(`${what} is "${REDACTED}" but there is no current value to keep. Use a {{variable}}.`);
  }
  return current;
}

/**
 * A request com os campos do patch aplicados. Só os campos enviados mudam;
 * `headers`, `pathParams` e `auth.oauth2`, quando enviados, são a lista
 * inteira (o que ficar de fora sai).
 */
export function applyRequestPatch(item: CollectionItem, patch: RequestPatch): { item: CollectionItem; changed: string[] } {
  if (item.type !== 'request') throw new Error(`"${item.name}" is a ${item.type}, not a request.`);
  if (item.protocol === 'grpc') throw new Error(`"${item.name}" is a gRPC request: edit it in the app.`);
  const changed = PATCH_FIELDS.filter(field => patch[field] !== undefined);
  if (changed.length === 0) {
    throw new Error(`Nothing to change. Send at least one of: ${PATCH_FIELDS.join(', ')}.`);
  }

  const req = structuredClone(item.request ?? { url: '', urlexport: { host: [], path: [], raw: '' }, headers: [] });
  let method = item.method;

  if (patch.method !== undefined) {
    const upper = String(patch.method).toUpperCase();
    if (!(HTTP_METHODS as readonly string[]).includes(upper)) {
      throw new Error(`Invalid method "${patch.method}". Use one of ${HTTP_METHODS.join(', ')}.`);
    }
    method = upper as CollectionItem['method'];
  }

  if (patch.url !== undefined) {
    req.url = String(patch.url).trim();
    req.urlexport = { ...(req.urlexport ?? { host: [], path: [] }), raw: req.url };
  }

  if (patch.pathParams !== undefined) {
    const current = req.urlexport?.variable ?? [];
    req.urlexport = {
      ...(req.urlexport ?? { host: [], path: [], raw: req.url }),
      variable: Object.entries(patch.pathParams).map(([key, value]) => {
        const existing = current.find(v => v.key === key);
        return { id: existing?.id ?? crypto.randomUUID(), key, value: String(value ?? ''), enabled: true };
      }),
    };
  }

  if (patch.headers !== undefined) {
    const current = req.headers ?? [];
    req.headers = patch.headers
      .filter(h => h?.key)
      .map((h): Header => {
        const existing = current.find(c => c.key.toLowerCase() === String(h.key).toLowerCase());
        return {
          key: String(h.key),
          value: keepIfRedacted(h.value === undefined ? undefined : String(h.value), existing?.value, `Header "${h.key}"`) ?? '',
          enabled: h.enabled !== false,
        };
      });
  }

  if (patch.body !== undefined) req.body = String(patch.body);
  if (patch.bodyType !== undefined) {
    if (!['none', 'raw', 'graphql'].includes(patch.bodyType)) {
      throw new Error(`Invalid bodyType "${patch.bodyType}". Use none, raw or graphql.`);
    }
    req.bodyType = patch.bodyType;
  }

  if (patch.auth !== undefined) {
    const current = req.auth ?? { type: 'none' };
    const type = patch.auth.type ?? current.type ?? 'none';
    if (!(AUTH_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Invalid auth type "${type}". Use one of ${AUTH_TYPES.join(', ')}.`);
    }
    // Trocar o tipo começa do zero (um token de bearer não vira senha de basic).
    const base = type === current.type ? current : { type };
    const next = { ...base, type } as NonNullable<typeof req.auth>;
    for (const field of ['token', 'username', 'password', 'key', 'value'] as const) {
      if (patch.auth[field] !== undefined) {
        next[field] = keepIfRedacted(String(patch.auth[field]), base[field as keyof typeof base] as string | undefined, `Auth ${field}`);
      }
    }
    if (patch.auth.oauth2 !== undefined) {
      const currentEntries = type === current.type ? current.oauth2 ?? [] : [];
      next.oauth2 = patch.auth.oauth2
        .filter(e => e?.key)
        .map(e => ({
          key: String(e.key),
          value: keepIfRedacted(e.value === undefined ? undefined : String(e.value), currentEntries.find(c => c.key === e.key)?.value, `OAuth2 "${e.key}"`) ?? '',
          enabled: e.enabled !== false,
        }));
    }
    req.auth = next;
  }

  if (patch.preRequestScript !== undefined || patch.postResponseScript !== undefined) {
    req.scripts = {
      preRequest: patch.preRequestScript !== undefined ? String(patch.preRequestScript) : req.scripts?.preRequest ?? '',
      postResponse: patch.postResponseScript !== undefined ? String(patch.postResponseScript) : req.scripts?.postResponse ?? '',
    };
  }

  // URL vazia só num passo de token (OAuth 2.0): em qualquer outra request
  // o envio falharia.
  if (!req.url?.trim() && req.auth?.type !== 'oauth2') {
    throw new Error('url cannot be empty (only an OAuth 2.0 token step has no URL).');
  }

  return { item: { ...item, method, request: req }, changed };
}

// ── Mover ────────────────────────────────────────────────────────────────

function find(tree: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of tree) {
    if (item.id === id) return item;
    const below = item.item ? find(item.item, id) : undefined;
    if (below) return below;
  }
  return undefined;
}

function without(tree: CollectionItem[], id: string): CollectionItem[] {
  return tree.filter(item => item.id !== id).map(item => (item.item ? { ...item, item: without(item.item, id) } : item));
}

function insertInto(tree: CollectionItem[], parentId: string | null, index: number, node: CollectionItem): CollectionItem[] {
  const place = (list: CollectionItem[]) => {
    const next = [...list];
    next.splice(Math.min(Math.max(index, 0), next.length), 0, node);
    return next;
  };
  if (parentId === null) return place(tree);
  return tree.map(item => {
    if (item.id === parentId) return { ...item, item: place(item.item ?? []) };
    return item.item ? { ...item, item: insertInto(item.item, parentId, index, node) } : item;
  });
}

/**
 * Move `id` para dentro de `targetFolderId` (null = raiz, só pra pasta), na
 * posição `position` (1 = primeiro; ausente = último). Dentro da mesma pasta,
 * é reordenar — é assim que se insere um passo no meio de um flow.
 */
export function moveItem(
  tree: CollectionItem[],
  id: string,
  targetFolderId: string | null,
  position?: number
): { tree: CollectionItem[]; from: string | null; index: number } {
  const node = find(tree, id);
  if (!node) throw new Error(`Item "${id}" not found.`);
  if (node.type === 'example') throw new Error(`"${node.name}" is a Saved Example: it moves with its request.`);
  if (targetFolderId === null && node.type !== 'folder') {
    throw new Error(`"${node.name}" is a request: only folders can be at the top level. Pass targetFolderId.`);
  }
  if (targetFolderId !== null) {
    const target = find(tree, targetFolderId);
    if (!target) throw new Error(`Folder "${targetFolderId}" not found.`);
    if (target.type !== 'folder') throw new Error(`"${target.name}" is not a folder.`);
    if (target.id === id || find([node], target.id)) {
      throw new Error(`"${node.name}" cannot be moved into itself.`);
    }
  }
  const fromParent = (function parentOf(list: CollectionItem[], parent: string | null): string | null | undefined {
    for (const item of list) {
      if (item.id === id) return parent;
      const below = item.item ? parentOf(item.item, item.id) : undefined;
      if (below !== undefined) return below;
    }
    return undefined;
  })(tree, null) ?? null;

  const base = without(tree, id);
  const siblings = targetFolderId === null ? base : find(base, targetFolderId)?.item ?? [];
  const index = position === undefined || !Number.isFinite(Number(position)) ? siblings.length : Math.max(1, Math.floor(Number(position))) - 1;
  const clamped = Math.min(index, siblings.length);
  return { tree: insertInto(base, targetFolderId, clamped, node), from: fromParent, index: clamped };
}
