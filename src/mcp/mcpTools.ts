'use client';

import { CollectionItem } from '@/app/types/CollectionItem';
import { redactRequestDetails, redactHeaders } from './redactSecrets';
import { Environment } from '@/app/types/Environment';
import { Tab } from '@/app/types/Tab';
import { PM_API_TYPES } from '@/lib/pmApiTypes';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { buildFlowSteps } from '@/components/LoadTest/buildFlowSteps';
import { loadLoadTestHistory } from '@/components/LoadTest/loadTestHistory';
import { LoadTestConfig, LoadTestSnapshot } from '@/components/LoadTest/types';
import { flattenRequests, runCollectionRequest, RunItemOutcome } from '@/components/CollectionRunner/runCollectionRequest';
import { findNodeById } from '@/components/collection-tree/utils/tree.utils';
import { cloneRequestNode, copyName } from './duplicateRequest';
import { loadLastRun, loadAllLastRuns } from '@/components/CollectionRunner/runHistory';
import { buildEnvMap } from '@/lib/envMap';
import { describeToken, isTokenStep, readOAuth2Config, requestOAuth2AccessToken } from '@/lib/oauth2Token';

// ─────────────────────────────────────────────────────────────────────────
// Ferramentas expostas pelo servidor MCP (ver mcp_server.rs pro transporte).
//
// Tudo aqui roda no frontend de propósito: executar uma request reaproveita
// exatamente o mesmo caminho do Collection Runner (runCollectionRequest),
// então o que o Claude Code dispara passa pela mesma resolução de variáveis,
// auth, sanitização de body e scripts que o botão Send usa.
// ─────────────────────────────────────────────────────────────────────────

// Dados que o app injeta a cada chamada — sempre lidos na hora, pra refletir
// o estado atual (workspace, collections e environments podem ter mudado).
export interface McpContext {
  workspace: string;
  collections: CollectionItem[];
  environments: Environment[];
  activeEnvironmentName?: string;
  // Abas abertas e qual está em foco — é o que permite responder sobre "a
  // resposta que está na tela" sem precisar reexecutar a request.
  tabs: Tab[];
  activeTabId: string | null;
  // Console do app (response/script/system) — o mesmo painel que o botão
  // "Console" abre no rodapé.
  consoleLogs: {
    level: string;
    message: string;
    timestamp: number;
    source?: string;
    requestName?: string;
    status?: number;
    detail?: string;
  }[];
  // Grava um script numa request. Só local — o push segue sendo explícito
  // (ver pendingPushStore); um agente iterando não deve gerar commits.
  setRequestScript: (requestId: string, phase: 'preRequest' | 'postResponse', code: string) => Promise<void>;
  // Insere um nó na árvore (no fim da pasta `parentId`, ou como collection
  // nova na raiz quando `parentId` é null). Mesma regra do script: só local.
  addCollectionItem: (parentId: string | null, node: CollectionItem) => Promise<void>;
  // Renomeia um nó da árvore (e a aba aberta dele). Só local, como o resto.
  renameCollectionItem: (id: string, name: string) => Promise<void>;
  // Grava uma variável num environment (token OAuth do get_oauth2_token).
  // Só local, e sem marcar o environment pra push: token não vai pro GitHub.
  setEnvironmentVariable: (environmentName: string, key: string, value: string) => Promise<void>;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}


export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_requests',
    description:
      'List the saved requests in the current DevFlow workspace, with id, method, URL and folder path. Workspaces can be large: call list_folders first and pass folderId to list only one folder, instead of listing everything.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Optional case-insensitive filter applied to the request name and URL.',
        },
        folderId: {
          type: 'string',
          description:
            'Only requests inside this folder (subfolders included), in flow order. Folder id or full path, as in list_folders.',
        },
      },
    },
  },
  {
    name: 'list_folders',
    description:
      'List the folders in the current workspace with their ids, full path and how many requests each contains. Use this to get the folderId that run_collection needs.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional case-insensitive filter on the folder path.' },
      },
    },
  },
  {
    name: 'get_request',
    description:
      'Get the full definition of one request: method, URL, headers, auth type, body and the pre-request / post-response scripts. Credentials are hidden: auth secrets and the value of headers that look credential-bearing come back as "[redacted — set in DevFlow]". A "{{variable}}" reference is shown as-is, since it is a pointer and not the secret itself. Never present a redacted placeholder as if it were the real value, and ask the user to edit it in the app when it needs changing.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request id from list_requests.' },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'list_examples',
    description:
      'List Saved Examples: documented request/response pairs stored under a request (like Postman examples). Each one shows the status code it documents. Use them to learn the expected response shape — including error responses — without calling the API. Pass requestId to list the examples of one request, or search to filter by name.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Only examples of this request (id from list_requests).' },
        search: { type: 'string', description: 'Optional case-insensitive filter on the example or request name.' },
      },
    },
  },
  {
    name: 'get_example',
    description:
      'Get one Saved Example: the request snapshot it documents (credentials hidden, same as get_request) and the saved response — status, headers and body. The saved response is written by hand or saved from a real call, so it shows the documented shape, not necessarily what the API returns today; use run_request when the live answer matters.',
    inputSchema: {
      type: 'object',
      properties: {
        exampleId: { type: 'string', description: 'Example id from list_examples or get_request.' },
        maxBytes: { type: 'number', description: 'Truncate the body at this many characters. Default 100000.' },
      },
      required: ['exampleId'],
    },
  },
  {
    name: 'search_requests',
    description:
      'Search INSIDE saved requests and examples — body, URL, headers, query/path params and scripts — for a text (case-insensitive). Use it to find a JSON field or value you need to reuse (e.g. a "contact" object in some request body), a header, or which requests call an endpoint. list_requests only matches names and URLs. Returns each match with the field it was found in and a snippet around it; credential-like header values and auth secrets are never searched or shown. Narrow it with folderId on large workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for, e.g. "contact" or "\"type\": \"Mobile\"".' },
        folderId: { type: 'string', description: 'Only search inside this folder (id or full path, as in list_folders).' },
        fields: {
          type: 'array',
          items: { type: 'string', enum: ['body', 'url', 'headers', 'params', 'scripts', 'name'] },
          description: 'Where to look. Default: all of them.',
        },
        includeExamples: {
          type: 'boolean',
          description: 'Also search the request and saved response of Saved Examples. Default true.',
        },
        maxResults: { type: 'number', description: 'Maximum matches to return. Default 30.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'rename_item',
    description:
      'Rename a folder, request or Saved Example. Saves locally only — push to GitHub stays a manual action in the app. Renaming does not change the order of a flow.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Id of the folder, request or example (from list_folders, list_requests or list_examples).' },
        name: { type: 'string', description: 'New name.' },
      },
      required: ['itemId', 'name'],
    },
  },
  {
    name: 'get_oauth2_token',
    description:
      'Get a fresh OAuth 2.0 / MSAL (Azure AD) access token for a request whose Authorization is OAuth 2.0 — e.g. the first step of a group-booking flow — and store it in the environment variable that request\'s Access Token field points to ({{variable}}). These token steps normally have NO URL and NO body: they exist only to hold the OAuth 2.0 settings, so an empty URL there is correct and must not be "fixed" or deleted. This is how the token is obtained — never by sending the request with run_request. Reuses the current token when it is still valid for minValiditySeconds; otherwise runs the same sign-in as "Get New Access Token" (a Microsoft login window may open in DevFlow: tell the user to finish it if it does not sign in by itself). The token itself is NEVER returned — only expiry, user, audience and scopes. After this, requests and flows use {{variable}} as usual.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'Request with the OAuth 2.0 settings (auth URL, client id, scope...). Use list_requests/get_request to find it.',
        },
        environment: { type: 'string', description: 'Environment to store the token in. Defaults to the one selected in the app.' },
        forceNew: { type: 'boolean', description: 'Always sign in again, even if the stored token is still valid. Default false.' },
        minValiditySeconds: {
          type: 'number',
          description: 'Reuse the stored token only if it is valid for at least this long. Default 300 (5 minutes).',
        },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'get_active_request',
    description:
      'What the user is looking at right now: the request open in the focused tab, and whether it already has a response. Start here when the user says "this request" or "the response on screen".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_response',
    description:
      'Read the response body already on screen, without re-running anything. Returns the full body (up to maxBytes), plus status, headers and timing. Use this instead of trying to read files — you have no filesystem access here.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'Tab/request id. Defaults to the focused tab.',
        },
        maxBytes: {
          type: 'number',
          description: 'Truncate the body at this many characters. Default 100000.',
        },
      },
    },
  },
  {
    name: 'run_request',
    description:
      'Execute one saved request through DevFlow, using the app\'s own engine (variable resolution, auth, and pre/post-response scripts all run exactly as they do when the user clicks Send). Returns the HTTP status, timing, the response body, the pm.test results, console.log output and any variables the scripts set.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request id from list_requests.' },
        environment: {
          type: 'string',
          description: 'Environment name to run with. Defaults to the one selected in the app.',
        },
        maxBodyBytes: {
          type: 'number',
          description: 'Truncate the returned body at this many characters. Default 100000.',
        },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'run_collection',
    description:
      'Run every request inside a folder (subfolders included), in order, carrying environment variables from one step to the next (so a login step can feed the next request). Returns the per-step result (tests, logs, variables set) and a summary. Each step gets a verdict: when the request has pm.test assertions, THE TESTS decide — a 400 that a test expects is a pass (negative test cases). Without tests, a 4xx/5xx counts as a failure. Read summary.tests and summary.failedSteps, not the HTTP statuses, to judge a test suite.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: {
          type: 'string',
          description:
            'Folder id (from list_folders or the folderId field of list_requests). The full folderPath string also works, e.g. "Barramento B2B - Dev / Flows / Booking Flow".',
        },
        environment: { type: 'string', description: 'Environment name. Defaults to the app selection.' },
        stopOnFailure: {
          type: 'boolean',
          description: 'Stop at the first step whose verdict is "failed" (request/script error, a failing test, or 4xx/5xx in a step without tests). Defaults to false.',
        },
      },
      required: ['folderId'],
    },
  },
  {
    name: 'list_environments',
    description:
      'List the environments and the variable names each one defines. Values are masked on purpose — use run_request if you need the value to actually reach an API.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_script_api',
    description:
      'Return the TypeScript declarations of the pm.* API available inside DevFlow scripts. Read this BEFORE writing any pre-request or post-response script: the runtime is a sandboxed QuickJS with a hand-written pm object, not Node and not the full Postman API (there is no pm.sendRequest, no setTimeout, no fetch, and require() only accepts "moment").',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_load_test',
    description:
      'Run a load test against a request or a whole folder (flow), using the same Rust engine as the Load Test panel. Blocks until the run finishes and returns the final metrics: RPS, latency percentiles, error rate, status code breakdown, script errors and threshold results.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Request or folder id. A folder runs as a sequential flow per virtual user.' },
        environment: { type: 'string', description: 'Environment name. Defaults to the app selection.' },
        vus: { type: 'number', description: 'Virtual users. Default 5.' },
        durationSecs: { type: 'number', description: 'How long to run. Default 15. Ignored when iterationsPerVu is set.' },
        iterationsPerVu: { type: 'number', description: 'Run a fixed number of iterations per VU instead of a duration.' },
        thresholds: {
          type: 'array',
          description: 'Pass/fail criteria, e.g. [{"metric":"p95","operator":"<","value":800}].',
          items: {
            type: 'object',
            properties: {
              metric: { type: 'string', enum: ['p50', 'p90', 'p95', 'p99', 'avg', 'min', 'max', 'errorRate', 'rps'] },
              operator: { type: 'string', enum: ['<', '<=', '>', '>='] },
              value: { type: 'number' },
            },
            required: ['metric', 'operator', 'value'],
          },
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'list_load_tests',
    description:
      'Past load test runs recorded for a request or folder, most recent first — use it to analyse or compare runs without executing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Request or folder id.' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'get_console_logs',
    description:
      "Read the app's console: request/response entries, script console.log output and system messages, newest last. Useful to debug why something failed after the fact.",
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['log', 'info', 'warn', 'error'], description: 'Filter by level.' },
        search: { type: 'string', description: 'Case-insensitive text filter.' },
        limit: { type: 'number', description: 'How many entries to return. Default 50.' },
      },
    },
  },
  {
    name: 'set_request_script',
    description:
      'Write the pre-request or post-response script of a request. Saves locally only — it never pushes to GitHub, so iterating on a script does not create commits. Call get_script_api first, and prefer running the request once before writing assertions so you know the real response shape.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        phase: { type: 'string', enum: ['preRequest', 'postResponse'] },
        code: { type: 'string', description: 'Full script body. Replaces whatever was there.' },
      },
      required: ['requestId', 'phase', 'code'],
    },
  },
  {
    name: 'create_folder',
    description:
      'Create a folder. Without parentFolderId it becomes a new top-level collection. A folder is also a flow: run_collection and run_load_test run its requests in tree order. Saves locally only — push to GitHub stays a manual action in the app. Returns the new folder id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name, e.g. "Booking Flow".' },
        parentFolderId: {
          type: 'string',
          description: 'Parent folder id or full path (as in list_folders). Omit to create a top-level collection.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_last_run',
    description:
      'Result of the most recent Collection Runner execution: for every request, the HTTP status, timing, the assertions that ran and the RESPONSE BODY — including the ones that failed. Use this before asking the user to run anything: a run they already did is usually sitting here, and it is the fastest way to learn what an endpoint actually returns. Unlike get_response, it does not need a tab open, and it covers the whole flow rather than one request.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: {
          type: 'string',
          description: 'Folder/collection id. Omit to get the most recent run of any folder.',
        },
        onlyFailures: {
          type: 'boolean',
          description: 'Return only the requests that failed. Useful when the flow is long.',
        },
      },
    },
  },
  {
    name: 'duplicate_request',
    description:
      'Copy a saved request, with its auth, headers, body, scripts and saved examples intact. Prefer this over reading a request and recreating it: get_request redacts secrets (OAuth2 client secret, passwords, token headers), so a rebuilt copy would silently lose them — duplicating happens inside the app, where the real values are. The copy goes to the end of the folder. Saves locally only. Returns the new request id.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Id of the request to copy (as in list_requests).' },
        name: { type: 'string', description: 'Name for the copy. Defaults to "<original> copy".' },
        folderId: {
          type: 'string',
          description: 'Folder id or full path to put the copy in. Defaults to the folder the original is in.',
        },
      },
      required: ['requestId'],
    },
  },
  {
    name: 'create_request',
    description:
      'Create a saved request at the end of a folder, so requests created one after another keep that order when the folder runs as a flow. Saves locally only — push to GitHub stays a manual action in the app. Never put real secrets in headers, body or auth: reference environment variables like "{{token}}" instead (see list_environments), since the collection is synced to GitHub. Call get_script_api before passing scripts. Returns the new request id.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder id or full path (as in list_folders).' },
        name: { type: 'string', description: 'Request name, e.g. "1 - Login".' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'Default GET.' },
        url: {
          type: 'string',
          description: 'Full URL, may use {{variables}}, query string and :pathParams, e.g. "{{baseUrl}}/bookings/:id?lang=pt".',
        },
        pathParams: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Values for :pathParams in the URL, e.g. {"id": "{{bookingId}}"}.',
        },
        headers: {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
        },
        body: { type: 'string', description: 'Raw body (usually JSON text). For GraphQL, set bodyType to "graphql".' },
        bodyType: { type: 'string', enum: ['none', 'raw', 'graphql'], description: 'Default "raw" when body is given, otherwise "none".' },
        auth: {
          type: 'object',
          description:
            'e.g. {"type":"bearer","token":"{{token}}"}, {"type":"basic","username":"...","password":"{{pwd}}"}, {"type":"apikey","key":"x-api-key","value":"{{apiKey}}"}. For "oauth2", pass the fields in oauth2[] — and prefer duplicate_request when a similar OAuth2 request already exists, since reading one gives you its secrets redacted.',
          properties: {
            type: { type: 'string', enum: ['none', 'bearer', 'basic', 'apikey', 'oauth2'] },
            token: { type: 'string' },
            username: { type: 'string' },
            password: { type: 'string' },
            key: { type: 'string' },
            value: { type: 'string' },
            oauth2: {
              type: 'array',
              description:
                'OAuth2 fields as key/value, e.g. [{"key":"grantType","value":"client_credentials"},{"key":"tokenUrl","value":"{{tokenUrl}}"},{"key":"clientId","value":"{{clientId}}"},{"key":"clientSecret","value":"{{clientSecret}}"}]. Use {{variables}} for the secrets.',
              items: {
                type: 'object',
                properties: { key: { type: 'string' }, value: { type: 'string' } },
                required: ['key', 'value'],
              },
            },
          },
          required: ['type'],
        },
        preRequestScript: { type: 'string' },
        postResponseScript: {
          type: 'string',
          description: 'Runs after the response — use it to pass data to the next step, e.g. pm.environment.set("token", pm.response.json().token).',
        },
      },
      required: ['folderId', 'name', 'url'],
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────

// Envelope sobre o buildEnvMap compartilhado (lib/envMap): o que o agente
// dispara precisa resolver variável exatamente como o botão Send.
function envMapOf(env: Environment | undefined): Record<string, string> {
  return buildEnvMap(env?.values);
}

function resolveEnvironment(ctx: McpContext, name?: string): Environment | undefined {
  const target = name ?? ctx.activeEnvironmentName;
  if (!target) return undefined;
  return ctx.environments.find(e => e.name === target);
}

// Caminho da pasta até cada request, pra dar contexto ao agente ("Booking
// Flow / 3 - AirSearch v1" é bem mais útil que só o nome solto). Carrega o
// id das pastas junto: sem isso o agente via o folderPath em texto mas não
// tinha como descobrir o folderId que o run_collection exige.
type FolderRef = { id: string; name: string };

function walkWithPath(
  items: CollectionItem[],
  parents: FolderRef[],
  out: { item: CollectionItem; path: FolderRef[] }[]
) {
  for (const item of items) {
    if (item.type === 'request') {
      out.push({ item, path: parents });
    } else if (item.item?.length) {
      walkWithPath(item.item, [...parents, { id: item.id, name: item.name }], out);
    }
  }
}

// Todas as pastas com caminho completo e quantas requests têm dentro
// (contando subpastas).
function collectFolders(
  items: CollectionItem[],
  parents: string[],
  out: { id: string; name: string; path: string; requestCount: number }[]
) {
  for (const item of items) {
    if (item.type === 'request' || !item.item) continue;
    const path = [...parents, item.name];
    out.push({
      id: item.id,
      name: item.name,
      path: path.join(' / '),
      requestCount: flattenRequests(item.item).length,
    });
    collectFolders(item.item, path, out);
  }
}

// Aceita id, caminho completo ("A / B / C"), final do caminho ou só o nome
// da pasta — o agente costuma ter em mãos o que veio no folderPath, não o id.
function resolveFolder(ctx: McpContext, reference: string): CollectionItem {
  const wanted = reference.trim();
  const byId = findNodeById(ctx.collections, wanted);
  if (byId && byId.type !== 'request') return byId;

  const folders: { id: string; name: string; path: string; requestCount: number }[] = [];
  collectFolders(ctx.collections, [], folders);

  const normalized = wanted.toLowerCase();
  const matches =
    folders.filter(f => f.path.toLowerCase() === normalized).length > 0
      ? folders.filter(f => f.path.toLowerCase() === normalized)
      : folders.filter(
          f =>
            f.path.toLowerCase().endsWith(normalized) ||
            f.name.toLowerCase() === normalized
        );

  if (matches.length === 1) {
    const found = findNodeById(ctx.collections, matches[0].id);
    if (found) return found;
  }

  if (matches.length > 1) {
    throw new Error(
      `"${wanted}" matches ${matches.length} folders. Use the folderId of the one you want: ` +
        matches.map(m => `${m.path} (id: ${m.id})`).join('; ')
    );
  }

  throw new Error(
    `Folder "${wanted}" not found. Call list_folders to see the available folders and their ids.`
  );
}

// Destino de uma criação: tem que ser pasta de verdade — resolveFolder por id
// também devolveria um example, e pendurar nó embaixo dele quebra a árvore.
function resolveTargetFolder(ctx: McpContext, reference: string): CollectionItem {
  const folder = resolveFolder(ctx, reference);
  if (folder.type !== 'folder') {
    throw new Error(`"${folder.name}" is not a folder. Call list_folders to pick one.`);
  }
  return folder;
}

// Pasta que contém a request, ou null quando ela está direto na raiz. É o
// destino padrão de uma cópia: duplicar quase sempre quer dizer "ao lado".
function findParentFolder(ctx: McpContext, requestId: string): CollectionItem | null {
  const found: { item: CollectionItem; path: FolderRef[] }[] = [];
  walkWithPath(ctx.collections, [], found);
  const entry = found.find(f => f.item.id === requestId);
  const parentId = entry?.path[entry.path.length - 1]?.id;
  return parentId ? findNodeById(ctx.collections, parentId) ?? null : null;
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
const AUTH_TYPES = ['none', 'bearer', 'basic', 'apikey', 'oauth2'] as const;

// Mesmo formato que o "New Request" da árvore (useCollectionTree) grava, já
// preenchido com o que o agente mandou.
function buildRequestNode(args: Record<string, any>): CollectionItem {
  const method = String(args.method ?? 'GET').toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    throw new Error(`Invalid method "${args.method}". Use one of ${HTTP_METHODS.join(', ')}.`);
  }

  const auth = args.auth ?? { type: 'none' };
  if (!(AUTH_TYPES as readonly string[]).includes(auth.type)) {
    throw new Error(`Invalid auth type "${auth.type}". Use one of ${AUTH_TYPES.join(', ')}.`);
  }

  const url = String(args.url ?? '').trim();
  if (!url) throw new Error('url is required.');

  const body = args.body == null ? '' : String(args.body);
  const pathParams = args.pathParams && typeof args.pathParams === 'object' ? args.pathParams : {};
  const headers = Array.isArray(args.headers) ? args.headers : [];

  return {
    id: crypto.randomUUID(),
    name: String(args.name ?? '').trim() || 'New Request',
    type: 'request',
    method: method as CollectionItem['method'],
    request: {
      url,
      urlexport: {
        host: [],
        path: [],
        raw: url,
        variable: Object.entries(pathParams).map(([key, value]) => ({
          id: crypto.randomUUID(),
          key,
          value: String(value ?? ''),
          enabled: true,
        })),
      },
      headers: headers
        .filter((h: any) => h?.key)
        .map((h: any) => ({ key: String(h.key), value: String(h.value ?? ''), enabled: true })),
      body,
      bodyType: args.bodyType ?? (body ? 'raw' : 'none'),
      auth: {
        type: auth.type,
        token: auth.token ?? '',
        ...(auth.username !== undefined ? { username: String(auth.username) } : {}),
        ...(auth.password !== undefined ? { password: String(auth.password) } : {}),
        ...(auth.key !== undefined ? { key: String(auth.key) } : {}),
        ...(auth.value !== undefined ? { value: String(auth.value) } : {}),
        // `enabled` não vem do agente: o schema expõe só key/value, porque um
        // campo desligado numa request recém-criada seria sempre engano.
        ...(Array.isArray(auth.oauth2)
          ? {
              oauth2: auth.oauth2
                .filter((e: any) => e?.key)
                .map((e: any) => ({ key: String(e.key), value: String(e.value ?? ''), enabled: true })),
            }
          : {}),
      },
      scripts: {
        preRequest: String(args.preRequestScript ?? ''),
        postResponse: String(args.postResponseScript ?? ''),
      },
    },
  };
}

// Textos pesquisáveis de uma request/example, por campo. Valores de header
// que parecem credencial e segredos de auth ficam de fora — pela mesma regra
// do get_request (redactSecrets): a busca não pode virar um jeito de ler token.
function searchableTexts(item: CollectionItem, wanted: Set<string>): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  const add = (field: string, text: string | undefined | null) => {
    if (wanted.has(field.split(':')[0]) && text) out.push({ field, text });
  };

  add('name', item.name);

  if (item.protocol === 'grpc' && item.grpc) {
    add('url', `${item.grpc.target} ${item.grpc.method}`);
    add('body', item.grpc.message);
    for (const m of redactHeaders(item.grpc.metadata) ?? []) add(`headers:${m.key}`, `${m.key}: ${m.value}`);
  }

  const req = item.request;
  if (req) {
    add('url', req.url);
    add('body', req.body);
    for (const h of redactHeaders(req.headers) ?? []) add(`headers:${h.key}`, `${h.key}: ${h.value}`);
    for (const p of req.urlexport?.variable ?? []) add(`params:${p.key}`, `${p.key}=${p.value ?? ''}`);
    add('scripts:preRequest', req.scripts?.preRequest);
    add('scripts:postResponse', req.scripts?.postResponse);
  }

  // Resposta salva de um Saved Example: conta como body.
  if (item.type === 'example' && item.example) add('body:savedResponse', item.example.body);

  return out;
}

// Trecho em volta da ocorrência — o suficiente pra ver a estrutura (ex. o
// objeto "contact" inteiro) sem despejar o body todo.
const SNIPPET_BEFORE = 120;
const SNIPPET_AFTER = 400;

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_BEFORE);
  const end = Math.min(text.length, index + length + SNIPPET_AFTER);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// Tempo pra concluir o login da Microsoft (janela do DevFlow) — com SSO
// costuma ser instantâneo; o resto é o usuário digitando/aprovando o MFA.
const OAUTH_SIGN_IN_TIMEOUT_MS = 120_000;

// Saved Examples ficam como filhos type 'example' da própria request.
/**
 * Marca as requests que são "passo de token" — auth OAuth 2.0 e URL vazia.
 *
 * Elas não são requests quebradas, e sim o jeito como o app guarda uma
 * configuração OAuth2: o token vem do fluxo de autorização (botão "Get new
 * access token", ou get_oauth2_token aqui), nunca de um Send. A URL fica
 * vazia justamente porque não há o que enviar.
 *
 * Sem esta dica o agente lê "URL vazia" e conclui que a request está
 * defeituosa — chegou a sugerir preencher a URL ou apagar o passo, que é o
 * oposto do certo. No Collection Runner elas aparecem como falha pelo mesmo
 * motivo: o runner tenta enviá-las.
 */
function tokenStepHint(item: CollectionItem): Record<string, unknown> {
  if (!isTokenStep(item.request)) return {};

  const target = item.request?.auth?.oauth2?.find(e => e.key === 'accessToken')?.value?.trim();
  return {
    tokenStep: true,
    tokenStepHint:
      'This request holds an OAuth 2.0 configuration; it is not meant to be sent, which is why it has no URL. ' +
      'The Collection Runner and run_request handle it automatically (reusing the current token while it is still valid); call get_oauth2_token when you want the details — expiry, audience, scopes — or to force a new one. The token is stored' +
      (target ? ` in ${target}.` : '.') +
      ' Do not fill in a URL and do not delete it — the rest of the flow depends on the variable it fills.',
  };
}

function examplesOf(item: CollectionItem): CollectionItem[] {
  return (item.item ?? []).filter(child => child.type === 'example');
}

// Corpo de resposta como texto, do mesmo jeito que o editor mostra.
function responseBodyText(response: any): string {
  const body = response?.parsedBody;
  if (body == null) return '';
  return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
}

// Bodies podem ter megabytes; o resultado de uma ferramenta vai inteiro pro
// contexto do modelo. Corta com aviso explícito em vez de estourar.
const DEFAULT_MAX_BODY = 100_000;

function truncate(text: string, maxBytes?: number) {
  const limit = Math.max(500, Number(maxBytes) || DEFAULT_MAX_BODY);
  if (text.length <= limit) return { body: text, truncated: false, totalLength: text.length };
  return {
    body: text.slice(0, limit),
    truncated: true,
    totalLength: text.length,
    note: `Body truncated at ${limit} of ${text.length} characters. Ask again with a larger maxBytes if you need more.`,
  };
}

function findTab(ctx: McpContext, requestId?: string): Tab | undefined {
  if (requestId) return ctx.tabs.find(t => t.id === requestId);
  return ctx.tabs.find(t => t.id === ctx.activeTabId);
}

// Veredito de um passo. Com pm.test, quem decide são os testes: num caso de
// teste negativo o 400 É o resultado esperado, e contá-lo como falha (como
// antes) fazia uma suíte correta aparecer com dezenas de falhas. Sem testes,
// 4xx/5xx continua sendo falha — não há como saber se era esperado.
function stepVerdict(outcome: RunItemOutcome): { verdict: 'passed' | 'failed'; failureReason?: string } {
  if (outcome.status === 'error') {
    return { verdict: 'failed', failureReason: `Request error: ${outcome.errorMessage ?? 'unknown error'}` };
  }
  if (outcome.scriptError) {
    return { verdict: 'failed', failureReason: `Script error: ${outcome.scriptError}` };
  }
  const tests = outcome.tests ?? [];
  if (tests.length > 0) {
    const failing = tests.filter(t => !t.passed);
    return failing.length > 0
      ? {
          verdict: 'failed',
          failureReason: `${failing.length} of ${tests.length} test(s) failed: ${failing.map(t => t.name).join('; ')}`,
        }
      : { verdict: 'passed' };
  }
  if (outcome.httpStatus !== undefined && outcome.httpStatus >= 400) {
    return {
      verdict: 'failed',
      failureReason: `HTTP ${outcome.httpStatus} and no pm.test to say it was expected`,
    };
  }
  return { verdict: 'passed' };
}

function summarizeOutcome(name: string, outcome: RunItemOutcome) {
  return {
    request: name,
    ...stepVerdict(outcome),
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    responseTimeMs: outcome.responseTime,
    error: outcome.errorMessage,
    scriptError: outcome.scriptError,
    resolvedUrl: outcome.resolvedUrl,
    tests: outcome.tests,
    logs: outcome.logs,
    variablesSet: outcome.variablesSet,
    bodySnippet: outcome.responseBodySnippet,
  };
}

function failed(outcome: RunItemOutcome): boolean {
  return stepVerdict(outcome).verdict === 'failed';
}

// ── Execução ─────────────────────────────────────────────────────────────

export async function executeMcpTool(
  name: string,
  args: Record<string, any>,
  ctx: McpContext
): Promise<unknown> {
  switch (name) {
    case 'list_requests': {
      const found: { item: CollectionItem; path: FolderRef[] }[] = [];
      walkWithPath(ctx.collections, [], found);

      // Filtra pelo caminho em vez de caminhar só a pasta: assim o folderPath
      // devolvido continua completo desde a raiz.
      const folder = args?.folderId ? resolveFolder(ctx, String(args.folderId)) : null;
      const inFolder = folder ? found.filter(({ path }) => path.some(f => f.id === folder.id)) : found;

      const search = String(args?.search ?? '').trim().toLowerCase();
      const filtered = search
        ? inFolder.filter(
            ({ item }) =>
              item.name.toLowerCase().includes(search) ||
              (item.request?.url ?? '').toLowerCase().includes(search)
          )
        : inFolder;

      return {
        workspace: ctx.workspace,
        activeEnvironment: ctx.activeEnvironmentName ?? null,
        requests: filtered.map(({ item, path }) => ({
          id: item.id,
          name: item.name,
          method: item.protocol === 'grpc' ? 'gRPC' : item.method ?? 'GET',
          url: item.protocol === 'grpc' ? `${item.grpc?.target ?? ''} ${item.grpc?.method ?? ''}`.trim() : item.request?.url ?? '',
          // gRPC: run_request/run_collection ainda não executam (só a aba do app).
          protocol: item.protocol ?? 'http',
          folderPath: path.map(f => f.name).join(' / '),
          // Id da pasta imediata — é o que run_collection espera.
          folderId: path.length > 0 ? path[path.length - 1].id : null,
          hasPreRequestScript: !!item.request?.scripts?.preRequest?.trim(),
          hasPostResponseScript: !!item.request?.scripts?.postResponse?.trim(),
          // Saved Examples dessa request (ver list_examples / get_example).
          exampleCount: examplesOf(item).length,
        })),
      };
    }

    case 'list_folders': {
      const folders: { id: string; name: string; path: string; requestCount: number }[] = [];
      collectFolders(ctx.collections, [], folders);

      const search = String(args?.search ?? '').trim().toLowerCase();
      const filtered = search
        ? folders.filter(f => f.path.toLowerCase().includes(search))
        : folders;

      return { workspace: ctx.workspace, folders: filtered };
    }

    case 'get_request': {
      const item = findNodeById(ctx.collections, String(args.requestId));
      if (!item) throw new Error(`Request "${args.requestId}" not found.`);
      return {
        id: item.id,
        name: item.name,
        method: item.method ?? 'GET',
        ...tokenStepHint(item),
        request: redactRequestDetails(item.request),
        examples: examplesOf(item).map(ex => ({
          id: ex.id,
          name: ex.name,
          statusCode: ex.example?.code ?? null,
        })),
      };
    }

    case 'list_examples': {
      const found: { item: CollectionItem; path: FolderRef[] }[] = [];
      walkWithPath(ctx.collections, [], found);

      const requestId = args?.requestId ? String(args.requestId) : null;
      if (requestId && !found.some(({ item }) => item.id === requestId)) {
        throw new Error(`Request "${requestId}" not found. Call list_requests to get its id.`);
      }

      const search = String(args?.search ?? '').trim().toLowerCase();
      const examples = found
        .filter(({ item }) => !requestId || item.id === requestId)
        .flatMap(({ item, path }) =>
          examplesOf(item).map(ex => ({
            id: ex.id,
            name: ex.name,
            statusCode: ex.example?.code ?? null,
            status: ex.example?.status ?? null,
            requestId: item.id,
            requestName: item.name,
            method: ex.method ?? item.method ?? 'GET',
            folderPath: path.map(f => f.name).join(' / '),
          }))
        )
        .filter(
          ex => !search || ex.name.toLowerCase().includes(search) || ex.requestName.toLowerCase().includes(search)
        );

      return { workspace: ctx.workspace, examples };
    }

    case 'get_example': {
      const item = findNodeById(ctx.collections, String(args.exampleId));
      if (!item || item.type !== 'example') {
        throw new Error(`Example "${args.exampleId}" not found. Call list_examples to get its id.`);
      }
      const example = item.example;
      return {
        id: item.id,
        name: item.name,
        method: item.method ?? 'GET',
        request: redactRequestDetails(item.request),
        response: {
          statusCode: example?.code ?? null,
          status: example?.status ?? null,
          // Set-Cookie e afins: mesma regra dos headers da request.
          headers: redactHeaders((example?.headers ?? []).filter(h => h.enabled !== false)) ?? [],
          language: example?.previewLanguage ?? 'json',
          ...truncate(example?.body ?? '', args.maxBytes),
        },
      };
    }

    case 'list_environments': {
      return {
        activeEnvironment: ctx.activeEnvironmentName ?? null,
        environments: ctx.environments.map(env => ({
          name: env.name,
          // Só os nomes: entregar valores aqui vazaria tokens pro modelo.
          variables: env.values.filter(v => v.enabled).map(v => v.key),
        })),
      };
    }

    case 'get_script_api': {
      return { language: 'typescript', declarations: PM_API_TYPES };
    }

    case 'search_requests': {
      const query = String(args?.query ?? '').trim();
      if (!query) throw new Error('query is required.');
      const needle = query.toLowerCase();
      const wanted = new Set<string>(
        Array.isArray(args?.fields) && args.fields.length > 0
          ? args.fields.map((f: unknown) => String(f))
          : ['body', 'url', 'headers', 'params', 'scripts', 'name']
      );
      const includeExamples = args?.includeExamples !== false;
      const maxResults = Math.max(1, Math.min(200, Number(args?.maxResults) || 30));

      const found: { item: CollectionItem; path: FolderRef[] }[] = [];
      walkWithPath(ctx.collections, [], found);
      const folder = args?.folderId ? resolveFolder(ctx, String(args.folderId)) : null;
      const scope = folder ? found.filter(({ path }) => path.some(f => f.id === folder.id)) : found;

      const matches: Record<string, unknown>[] = [];
      let totalMatches = 0;

      const searchItem = (item: CollectionItem, path: FolderRef[], exampleOf?: CollectionItem) => {
        for (const { field, text } of searchableTexts(item, wanted)) {
          const lower = text.toLowerCase();
          let from = 0;
          let index = lower.indexOf(needle, from);
          // Várias ocorrências no mesmo campo: só a primeira vira resultado,
          // mas todas contam no total.
          let first = true;
          while (index !== -1) {
            totalMatches++;
            if (first && matches.length < maxResults) {
              matches.push({
                id: item.id,
                name: item.name,
                type: exampleOf ? 'example' : 'request',
                ...(exampleOf ? { requestId: exampleOf.id, requestName: exampleOf.name } : {}),
                method: item.protocol === 'grpc' ? 'gRPC' : item.method ?? 'GET',
                folderPath: path.map(f => f.name).join(' / '),
                field,
                snippet: snippetAround(text, index, needle.length),
              });
            }
            first = false;
            from = index + needle.length;
            index = lower.indexOf(needle, from);
          }
        }
      };

      for (const { item, path } of scope) {
        searchItem(item, path);
        if (includeExamples) {
          for (const example of examplesOf(item)) searchItem(example, path, item);
        }
      }

      return {
        query,
        totalMatches,
        returned: matches.length,
        ...(totalMatches > matches.length
          ? { note: `Showing the first ${matches.length} of ${totalMatches} matches. Narrow it with folderId or fields, or raise maxResults.` }
          : {}),
        matches,
      };
    }

    case 'rename_item': {
      const item = findNodeById(ctx.collections, String(args?.itemId ?? ''));
      if (!item) throw new Error(`Item "${args?.itemId}" not found. Use list_folders, list_requests or list_examples to get its id.`);
      const name = String(args?.name ?? '').trim();
      if (!name) throw new Error('name cannot be empty.');
      const previous = item.name;
      if (previous === name) return { ok: true, id: item.id, name, note: 'The item already had this name.' };

      await ctx.renameCollectionItem(item.id, name);
      return {
        ok: true,
        id: item.id,
        type: item.type,
        previousName: previous,
        name,
        note: 'Saved locally. Push to GitHub is still a manual action in the app.',
      };
    }

    case 'get_oauth2_token': {
      const item = findNodeById(ctx.collections, String(args?.requestId ?? ''));
      if (!item?.request) throw new Error(`Request "${args?.requestId}" not found.`);
      if (item.request.auth?.type !== 'oauth2') {
        throw new Error(`"${item.name}" does not use OAuth 2.0 authorization (it uses "${item.request.auth?.type ?? 'none'}").`);
      }

      const env = resolveEnvironment(ctx, args?.environment);
      if (!env) {
        throw new Error(
          args?.environment
            ? `Environment "${args.environment}" not found.`
            : 'No environment is selected in DevFlow. Pass environment or ask the user to select one.'
        );
      }
      const envMap = envMapOf(env);
      const resolve = (text: string) => text.replace(/\{\{(.*?)\}\}/g, (_, key) => envMap[key.trim()] ?? `{{${key.trim()}}}`);

      const { config, accessTokenField, missing } = readOAuth2Config(item.request.auth, resolve);
      if (missing.length > 0) {
        throw new Error(`"${item.name}" is missing OAuth 2.0 settings: ${missing.join(', ')}.`);
      }

      // O token precisa ir pra uma VARIÁVEL: gravado no campo da request ele
      // iria pra collection e, no push, pro GitHub.
      const variable = accessTokenField.match(/^\{\{\s*([\w.-]+)\s*\}\}$/)?.[1];
      if (!variable) {
        throw new Error(
          `The Access Token field of "${item.name}" is not a variable. Ask the user to set it to {{variableName}} in the Authorization tab, so the token is stored in the environment and not in the collection.`
        );
      }

      const minValidity = Math.max(0, Number(args?.minValiditySeconds ?? 300));
      const current = envMap[variable];
      if (current && !args?.forceNew) {
        const info = describeToken(current);
        if (info.readable && (info.expiresInSeconds ?? 0) > minValidity) {
          return { status: 'reused', variable, environment: env.name, ...info };
        }
      }

      // Login interativo: se a janela pedir algo, quem completa é o usuário.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OAUTH_SIGN_IN_TIMEOUT_MS);
      let token: string;
      try {
        token = await requestOAuth2AccessToken(config, controller.signal);
      } catch (e) {
        if (controller.signal.aborted) {
          throw new Error(
            `Sign-in was not completed within ${OAUTH_SIGN_IN_TIMEOUT_MS / 1000}s. Ask the user to finish the Microsoft login window in DevFlow and call get_oauth2_token again.`
          );
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }

      await ctx.setEnvironmentVariable(env.name, variable, token);
      return {
        status: 'renewed',
        variable,
        environment: env.name,
        ...describeToken(token),
        note: `Stored in {{${variable}}} (${env.name}). The token value is not shown on purpose.`,
      };
    }

    case 'get_active_request': {
      const tab = findTab(ctx);
      if (!tab) return { open: false, note: 'No request tab is open right now.' };
      return {
        open: true,
        id: tab.id,
        name: tab.name,
        method: tab.method,
        url: tab.urlInput,
        bodyType: tab.bodyType,
        hasResponse: !!tab.response,
        responseStatus: tab.response?.status ?? null,
        hasUnsavedChanges: !!tab.isDirty,
        scripts: tab.scripts ?? null,
      };
    }

    case 'get_response': {
      const tab = findTab(ctx, args.requestId ? String(args.requestId) : undefined);
      // As duas mensagens apontam pro get_last_run: uma request executada pelo
      // Collection Runner não abre aba, então "sem resposta" aqui quase nunca
      // significa que ela nunca rodou.
      if (!tab) {
        throw new Error(
          'No request tab is open right now. If the request was executed by the Collection Runner, call get_last_run — the result is stored there.'
        );
      }
      if (!tab.response) {
        throw new Error(
          `"${tab.name}" has no response in this tab. Check get_last_run first (the Collection Runner may have run it); only then run it with run_request.`
        );
      }

      const text = responseBodyText(tab.response);
      return {
        request: tab.name,
        status: tab.response.status,
        responseTimeMs: tab.responseTime ?? null,
        headers: tab.response.headers ?? {},
        testResults: tab.testResults ?? [],
        ...truncate(text, args.maxBytes),
      };
    }

    case 'run_request': {
      const item = findNodeById(ctx.collections, String(args.requestId));
      if (!item) throw new Error(`Request "${args.requestId}" not found.`);

      // Passo de token não é recusado aqui: o runCollectionRequest abaixo o
      // reconhece e executa o fluxo OAuth2. Recusar seria incoerente com o
      // run_collection, que roda a mesma request dentro do fluxo sem reclamar.
      // Quem quiser detalhe (validade, audience, escopos) usa
      // get_oauth2_token; aqui o resultado é só "deu certo".

      const env = resolveEnvironment(ctx, args.environment);
      if (args.environment && !env) {
        throw new Error(`Environment "${args.environment}" not found.`);
      }

      const outcome = await runCollectionRequest(item, envMapOf(env));
      const summary = summarizeOutcome(item.name, outcome);

      // O snippet de 2000 chars do Runner serve pra UI; aqui o agente
      // precisa do corpo inteiro pra escrever assertion contra o shape real.
      const { bodySnippet, ...rest } = summary;
      return {
        environment: env?.name ?? null,
        ...rest,
        ...truncate(outcome.fullResponseBody ?? bodySnippet ?? '', args.maxBodyBytes),
      };
    }

    case 'run_collection': {
      // Aceita id ou caminho: o agente normalmente tem em mãos o folderPath
      // que veio do list_requests, não o id.
      const folder = resolveFolder(ctx, String(args.folderId ?? ''));

      const requests = flattenRequests(folder.item ?? []);
      if (requests.length === 0) {
        throw new Error(`Folder "${folder.name}" has no requests.`);
      }

      const env = resolveEnvironment(ctx, args.environment);
      if (args.environment && !env) {
        throw new Error(`Environment "${args.environment}" not found.`);
      }

      // O env vai sendo repassado entre as etapas — é o que permite a
      // request 1 gravar um token e a request 2 já usar {{token}}.
      let envMap = envMapOf(env);
      const steps: ReturnType<typeof summarizeOutcome>[] = [];

      for (const req of requests) {
        const outcome = await runCollectionRequest(req, envMap);
        envMap = outcome.envAfter;
        steps.push(summarizeOutcome(req.name, outcome));
        if (args.stopOnFailure && failed(outcome)) break;
      }

      const allTests = steps.flatMap(st => st.tests ?? []);
      const failedSteps = steps.filter(st => st.verdict === 'failed');
      return {
        folder: folder.name,
        environment: env?.name ?? null,
        completed: steps.length,
        total: requests.length,
        // Passos com veredito "failed" (ver stepVerdict) — não é a contagem
        // de respostas 4xx/5xx, que podem ser o esperado.
        passed: steps.length - failedSteps.length,
        failed: failedSteps.length,
        tests: {
          total: allTests.length,
          passed: allTests.filter(t => t.passed).length,
          failed: allTests.filter(t => !t.passed).length,
        },
        // Só informativo: inclui os 4xx esperados dos testes negativos.
        httpErrorResponses: steps.filter(st => (st.httpStatus ?? 0) >= 400).length,
        stepsWithoutTests: steps.filter(st => (st.tests ?? []).length === 0).length,
        failedSteps: failedSteps.map(st => ({ request: st.request, reason: st.failureReason })),
        steps,
      };
    }

    case 'get_console_logs': {
      const level = args.level ? String(args.level) : null;
      const search = String(args.search ?? '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));

      const filtered = ctx.consoleLogs.filter(entry => {
        if (level && entry.level !== level) return false;
        if (search) {
          const haystack = `${entry.message} ${entry.detail ?? ''} ${entry.requestName ?? ''}`.toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      });

      return {
        total: filtered.length,
        // Os mais recentes são os que interessam pra diagnosticar.
        entries: filtered.slice(-limit).map(entry => ({
          level: entry.level,
          source: entry.source ?? null,
          request: entry.requestName ?? null,
          status: entry.status ?? null,
          at: new Date(entry.timestamp).toISOString(),
          message: entry.message,
          detail: entry.detail ?? null,
        })),
      };
    }

    case 'list_load_tests': {
      const itemId = String(args.itemId);
      const item = findNodeById(ctx.collections, itemId);
      const records = await loadLoadTestHistory(itemId);

      return {
        item: item?.name ?? itemId,
        runs: records.map(record => ({
          id: record.id,
          startedAt: record.startedAt,
          mode: record.mode,
          vus: record.config.vus ?? null,
          durationSecs: record.config.durationSecs ?? null,
          iterationsPerVu: record.config.iterationsPerVu ?? null,
          summary: record.summary,
        })),
      };
    }

    case 'run_load_test': {
      const item = findNodeById(ctx.collections, String(args.itemId));
      if (!item) throw new Error(`Item "${args.itemId}" not found.`);

      const env = resolveEnvironment(ctx, args.environment);
      if (args.environment && !env) {
        throw new Error(`Environment "${args.environment}" not found.`);
      }

      // Request única roda como um fluxo de um passo só — mesma coisa que o
      // painel de Load Test faz.
      const requests = item.type === 'request' ? [item] : flattenRequests(item.item ?? []);
      if (requests.length === 0) throw new Error(`"${item.name}" has no requests to run.`);

      const flow = buildFlowSteps(requests);
      if (flow.some(step => !step.url.trim())) {
        throw new Error('One of the requests in the flow has an empty URL.');
      }

      const iterationsPerVu = Number(args.iterationsPerVu) || undefined;
      const config: LoadTestConfig = {
        flow,
        environment: envMapOf(env),
        vus: Math.max(1, Number(args.vus) || 5),
        ...(iterationsPerVu
          ? { iterationsPerVu }
          : { durationSecs: Math.max(1, Number(args.durationSecs) || 15) }),
        ...(Array.isArray(args.thresholds) && args.thresholds.length > 0
          ? { thresholds: args.thresholds }
          : {}),
      };

      // O motor Rust reporta por evento; aqui a ferramenta só devolve o
      // resultado final. O listener é registrado ANTES do start: com poucas
      // iterações o teste termina em milissegundos, e registrar depois
      // perderia o `load-test-done` — a ferramenta ficaria pendurada até o
      // timeout. Os eventos recebidos vão pra um buffer porque o testId só
      // é conhecido depois que o start responde.
      const received: LoadTestSnapshot[] = [];
      let onDone: ((snapshot: LoadTestSnapshot) => void) | null = null;

      const unlisten = await listen<LoadTestSnapshot>('load-test-done', event => {
        received.push(event.payload);
        onDone?.(event.payload);
      });

      let summary: LoadTestSnapshot;
      try {
        const testId = await invoke<string>('start_load_test', { config });
        const timeoutMs = ((config.durationSecs ?? 60) + 120) * 1000;

        summary =
          received.find(s => s.testId === testId) ??
          (await new Promise<LoadTestSnapshot>((resolve, reject) => {
            const timer = setTimeout(() => {
              invoke('stop_load_test', { testId }).catch(() => {});
              reject(new Error('Load test timed out waiting for the final result.'));
            }, timeoutMs);

            onDone = snapshot => {
              // Filtra runs concorrentes (ex: o painel rodando outro teste).
              if (snapshot.testId !== testId) return;
              clearTimeout(timer);
              resolve(snapshot);
            };
          }));
      } finally {
        unlisten();
      }

      return {
        item: item.name,
        environment: env?.name ?? null,
        steps: flow.length,
        config: {
          vus: config.vus,
          durationSecs: config.durationSecs ?? null,
          iterationsPerVu: config.iterationsPerVu ?? null,
        },
        summary,
      };
    }

    case 'set_request_script': {
      const phase = String(args.phase);
      if (phase !== 'preRequest' && phase !== 'postResponse') {
        throw new Error(`Invalid phase "${phase}". Use "preRequest" or "postResponse".`);
      }
      const item = findNodeById(ctx.collections, String(args.requestId));
      if (!item) throw new Error(`Request "${args.requestId}" not found.`);

      // Sem "code" (ex.: o agente mandou "script"), antes isto gravava um
      // script VAZIO e respondia ok — apagando o que havia. Agora recusa; pra
      // limpar de propósito, mande code: "".
      if (typeof args.code !== 'string') {
        const sent = Object.keys(args ?? {}).filter(k => !['requestId', 'phase'].includes(k));
        throw new Error(
          `Missing "code" (the full script body).${sent.length ? ` Received: ${sent.join(', ')}.` : ''} Nothing was changed. To clear the script on purpose, send code: "".`
        );
      }

      await ctx.setRequestScript(item.id, phase, args.code);
      return {
        ok: true,
        request: item.name,
        phase,
        note: 'Saved locally. Push to GitHub is still a manual action in the app.',
      };
    }

    case 'create_folder': {
      const name = String(args.name ?? '').trim();
      if (!name) throw new Error('name is required.');

      const parent = args.parentFolderId ? resolveTargetFolder(ctx, String(args.parentFolderId)) : null;
      const node: CollectionItem = { id: crypto.randomUUID(), name, type: 'folder', item: [] };

      await ctx.addCollectionItem(parent?.id ?? null, node);
      return {
        ok: true,
        folderId: node.id,
        name,
        parent: parent?.name ?? null,
        note: 'Saved locally. Push to GitHub is still a manual action in the app.',
      };
    }

    case 'get_last_run': {
      const folderId = args.folderId ? String(args.folderId) : null;
      const run = folderId ? await loadLastRun(folderId) : (await loadAllLastRuns())[0] ?? null;

      if (!run) {
        throw new Error(
          folderId
            ? `No stored run for "${folderId}". Run the folder with run_collection, or ask the user to run it in the app.`
            : 'No Collection Runner execution stored yet. Use run_collection, or ask the user to run a flow in the app.'
        );
      }

      const entries = run.entries.filter(e => e.outcome);
      const failed = entries.filter(
        e => e.outcome!.status === 'error'
          || !!e.outcome!.scriptError
          || (e.outcome!.tests.length > 0
                ? e.outcome!.tests.some(t => !t.passed)
                : (e.outcome!.httpStatus ?? 0) >= 400)
      );

      const shown = args.onlyFailures ? failed : entries;

      return {
        collection: run.collectionName,
        finishedAt: run.finishedAt,
        total: run.entries.length,
        completed: entries.length,
        failed: failed.length,
        // Avisa quando o histórico foi cortado pra caber na cota: sem isso o
        // agente concluiria que o fluxo tem menos passos do que tem.
        ...(run.truncated ? { note: 'This stored run was truncated; some rows are missing.' } : {}),
        requests: shown.map(entry => {
          const o = entry.outcome!;
          return {
            name: entry.name,
            method: entry.method ?? null,
            iteration: entry.iteration,
            status: o.httpStatus ?? null,
            responseTimeMs: o.responseTime,
            error: o.errorMessage ?? null,
            scriptError: o.scriptError ?? null,
            resolvedUrl: o.resolvedUrl ?? null,
            tests: o.tests,
            // É o campo que resolve a pergunta "qual resposta eu devo
            // asseverar?" sem precisar reexecutar nada.
            responseBody: o.fullResponseBody ?? o.responseBodySnippet ?? null,
          };
        }),
      };
    }

    case 'duplicate_request': {
      const source = findNodeById(ctx.collections, String(args.requestId));
      if (!source) throw new Error(`Request "${args.requestId}" not found.`);
      if (source.type !== 'request') {
        throw new Error(`"${source.name}" is a ${source.type}, not a request. duplicate_request only copies requests.`);
      }

      const targetFolder = args.folderId
        ? resolveTargetFolder(ctx, String(args.folderId))
        : findParentFolder(ctx, source.id);

      const siblings = (targetFolder ? targetFolder.item ?? [] : ctx.collections).map(i => i.name);
      const name = String(args.name ?? '').trim() || copyName(source.name, siblings);
      const node = cloneRequestNode(source, name);

      await ctx.addCollectionItem(targetFolder?.id ?? null, node);
      return {
        ok: true,
        requestId: node.id,
        name: node.name,
        method: node.method,
        folder: targetFolder?.name ?? null,
        copiedFrom: { id: source.id, name: source.name },
        // O agente não vê o que foi copiado, e é essa a intenção: dizer isso
        // evita que ele conclua que a cópia saiu incompleta e tente "consertar"
        // sobrescrevendo o auth com os valores mascarados que leu antes.
        note: 'Saved locally, with auth and secrets copied inside the app — they are not shown here. Push to GitHub is still a manual action.',
      };
    }

    case 'create_request': {
      const folder = resolveTargetFolder(ctx, String(args.folderId ?? ''));
      const node = buildRequestNode(args);

      await ctx.addCollectionItem(folder.id, node);
      return {
        ok: true,
        requestId: node.id,
        name: node.name,
        method: node.method,
        folder: folder.name,
        // Posição no fluxo: é a ordem em que run_collection vai executar.
        position: flattenRequests(folder.item ?? []).length + 1,
        note: 'Saved locally. Push to GitHub is still a manual action in the app.',
      };
    }

    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}
