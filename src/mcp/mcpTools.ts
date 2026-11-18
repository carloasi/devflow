'use client';

import { CollectionItem } from '@/app/types/CollectionItem';
import {
  createSecretRedactor,
  HIDDEN_VALUE,
  isSecretVariable,
  redactHeaders,
  redactRequestDetails,
  SecretRedactor,
} from './redactSecrets';
import { Environment } from '@/app/types/Environment';
import { Tab } from '@/app/types/Tab';
import { PM_API_TYPES } from '@/lib/pmApiTypes';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { buildFlowSteps } from '@/components/LoadTest/buildFlowSteps';
import { resolveTokenSteps } from '@/components/LoadTest/resolveTokenSteps';
import { loadLoadTestHistory } from '@/components/LoadTest/loadTestHistory';
import { LoadTestConfig, LoadTestSnapshot } from '@/components/LoadTest/types';
import {
  flattenRequests,
  runCollectionRequest,
  RunItemOutcome,
  VariableChange,
} from '@/components/CollectionRunner/runCollectionRequest';
import { findNodeById } from '@/components/collection-tree/utils/tree.utils';
import { cloneRequestNode, copyName } from './duplicateRequest';
import { validateFlow } from './flowValidation';
import { applyRequestPatch, moveItem } from './treeEdit';
import { AUTH_BLOCKS, getFlowRecipe, getRawRecipe, listFlowRecipes, RECIPE_RULES } from './flowRecipes';
import { numberedFlowName, planRecipe } from './flowRecipes/applyRecipe';
import { buildFlowStep, type BuiltStep } from './flowSources';
import { caseIdOf } from './suiteCase';
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
  // update_request / move_item / delete_item. Só local, como o resto: o push
  // continua manual. As mudanças passam por updater (setCollections(prev => …)),
  // nunca por um snapshot da árvore — duas chamadas seguidas não se atropelam.
  updateCollectionItem: (id: string, item: CollectionItem) => Promise<void>;
  moveCollectionItem: (id: string, targetFolderId: string | null, position?: number) => Promise<void>;
  removeCollectionItem: (id: string) => Promise<void>;
  // Leva pro environment o que os scripts de uma execução gravaram — o mesmo
  // que o botão Send e o Collection Runner fazem. `before` é o mapa com que a
  // execução começou; só as keys que mudaram em relação a ele são escritas.
  applyEnvironmentChanges: (
    environmentId: string,
    before: Record<string, string>,
    after: Record<string, string>,
    requestName: string
  ) => Promise<void>;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Dicas do protocolo MCP: só leitura, destrutiva, idempotente, fala com
   * sistemas de fora. Um cliente pode, por exemplo, liberar sem perguntar só as
   * de leitura pra uma IA menos confiável.
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
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
      'Get an OAuth 2.0 / MSAL access token for a token step (a request with OAuth 2.0 auth and NO URL — the empty URL is correct, never "fix" it) and store it in the variable its Access Token field names. Never send a token step with run_request. Reuses a token still valid for minValiditySeconds; otherwise signs in like "Get New Access Token" (a Microsoft login may open in DevFlow: ask the user to finish it). The token is NEVER returned — only expiry, user, audience and scopes. run_collection/run_request/run_load_test already do this for token steps; call it only to check validity or force a new one.',
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
      'Run one SAVED request with the app\'s engine, exactly like Send (variables, auth, scripts). Variables the scripts set are saved to the environment (savedToEnvironment), so step 1 then step 2 of a flow works. Returns status, timing, response body, pm.test results, console.log and variables set. Secrets (by variable name, or JWT-shaped) never come back: they show as "{{variable}}" — on purpose; do not ask the user for them.',
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
      'Run every request inside a folder (subfolders included), in order, carrying environment variables from one step to the next (so a login step can feed the next request). Returns the per-step result (tests, logs, variables set) and a summary. Each step gets a verdict: when the request has pm.test assertions, THE TESTS decide — a 400 that a test expects is a pass (negative test cases). Without tests, a 4xx/5xx counts as a failure. Read summary.tests and summary.failedSteps, not the HTTP statuses, to judge a test suite. For a whole test suite run the suite folder ONCE with detail: "failures" — full detail only for failed steps, one line for the rest, a per-subfolder summary ("groups") and a ready case matrix ("matrix"). Secret values are hidden the same way as in run_request (shown as "{{variable}}").',
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
        detail: {
          type: 'string',
          enum: ['full', 'failures'],
          description: '"full" (default): every step with tests, logs and body. "failures": full detail only for failed steps, plus "groups" and "matrix" — use it for test suites and long flows.',
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
      'Run a load test against a request or a whole folder (flow), using the same Rust engine as the Load Test panel. Blocks until the run finishes and returns the final metrics: RPS, latency percentiles, error rate, status code breakdown, script errors and threshold results. OAuth 2.0 token steps (no URL) are handled before the load starts: the token is obtained once (or reused while valid), stored in the environment, and shared by every virtual user — the token step itself is not put under load.',
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

// Os campos de um passo do create_flow (e do update_request) são os do
// create_request, menos a pasta. Mesmas chaves e tipos, tirados da própria
// definição pra nunca divergirem — mas SEM as descrições longas, que já estão
// no create_request: repetidas em três ferramentas eram ~7 KB a mais em todo
// tools/list, e modelo pequeno paga isso em todo passo.
const KEY_VALUE_LIST = {
  type: 'array',
  items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
};
const REQUEST_STEP_PROPERTIES = (() => {
  const full = (MCP_TOOLS.find(t => t.name === 'create_request')!.inputSchema.properties ?? {}) as Record<string, any>;
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) {
    if (key === 'folderId') continue;
    if (key === 'auth') {
      compact.auth = {
        type: 'object',
        description: 'As in create_request, e.g. {"type": "bearer", "token": "{{bearerToken}}"}.',
        properties: {
          type: { type: 'string', enum: ['none', 'bearer', 'basic', 'apikey', 'oauth2'] },
          token: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' },
          key: { type: 'string' }, value: { type: 'string' }, oauth2: KEY_VALUE_LIST,
        },
      };
      continue;
    }
    if (key === 'headers') {
      compact.headers = { ...KEY_VALUE_LIST, description: 'The WHOLE header list.' };
      continue;
    }
    const { description: _description, ...rest } = value;
    compact[key] = rest;
  }
  return compact;
})();

MCP_TOOLS.push(
  {
    name: 'validate_flow',
    description:
      'Check a flow (a folder) WITHOUT running it: per step, the {{variables}} it uses and sets, and problems — missing-variable, produced-later, empty URL (outside a token step), script syntax, literal secret, JSON body without Content-Type. Only variable NAMES are read. create_flow already returns this as "check"; call it after editing a flow and fix every error before delivering. Example: {"folderId": "Method Flows Barramento B2B - Claude / Flow 08 - Reserva partida < 24h", "environment": "5by5"}',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Folder id or full path (as in list_folders).' },
        environment: {
          type: 'string',
          description: 'Environment whose variable NAMES count as available. Defaults to the one selected in the app.',
        },
      },
      required: ['folderId'],
    },
  },
  {
    name: 'create_flow',
    description:
      'Create a flow or a test suite in ONE call: a new folder with all its steps, in run order, plus the validate_flow check ("check"). Nothing is created if any step is invalid. With a recipe, prefer create_flow_from_recipe. A step is: (a) {"copyFrom": <id, path or recipe object>} — the app copies method, url, headers, auth and body (secrets included) without the source scripts; do NOT get_request just to retype it; fields you add replace the copied ones; (b) {"duplicateFrom": <id or path>} — faithful copy with scripts (OAuth 2.0 token step); (c) a new request (create_request fields). "scriptsFrom" copies a reference step\'s scripts. TEST CASE: copy the base request and send only what changes — "bodyPatch" {"path": value}, "bodyRemove" ["path"] — and "expect" {"status", "codes", "fields"}: the app generates the pm.test asserts. Steps are numbered "01 - "… unless the name starts with a number. Saves locally only. Example: {"name": "Flow 08 - Reserva", "parentFolderId": "Method Flows Barramento B2B - Claude", "environment": "5by5", "steps": [{"duplicateFrom": "Portal De Grupos - APIs / Gerar token MSAL"}, {"copyFrom": {"folder": "Order / v2", "request": "Order v2"}, "scriptsFrom": {"folder": "Method Flows Barramento B2B - Claude / Flow 01 - Fluxo Cancelamento com Reembolso", "step": "Order v1"}, "preRequestScript": "pm.environment.set(\\"recordLocator\\", \\"\\");"}, {"name": "Token Groups v1", "method": "POST", "url": "{{urlAuthorization}}/api/v1/token/groups", "headers": [{"key": "Ocp-Apim-Subscription-Key", "value": "{{apiKey}}"}], "auth": {"type": "bearer", "token": "{{msal}}"}, "postResponseScript": "pm.environment.set(\\"bearerToken\\", pm.response.json().data.token);"}]}',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name, e.g. "Flow 08 - Reserva partida < 24h".' },
        parentFolderId: {
          type: 'string',
          description: 'Parent folder id or full path (as in list_folders). Omit to create a top-level collection.',
        },
        environment: {
          type: 'string',
          description: 'Environment used by the check (variable names only). Defaults to the one selected in the app.',
        },
        numberSteps: { type: 'boolean', description: 'Prefix "01 - ", "02 - "… to step names. Default true.' },
        steps: {
          type: 'array',
          description: 'The steps, in run order (1 to 60).',
          items: {
            type: 'object',
            properties: {
              copyFrom: {
                description:
                  'Copy this source request (id, path "Collection / Folder / Request", or {"collection", "folder", "request", "version", "search"} as in a recipe) without its scripts. Fields you send replace the copied ones.',
              },
              duplicateFrom: {
                description: 'Faithful copy of this request (id or path), scripts and examples included. Fields you send replace the copied ones.',
              },
              scriptsFrom: {
                description:
                  'Copy the scripts of a reference flow step: {"folder": "<flow folder path>", "step": "<step name, without the number>"} or a request id. Scripts you send win.',
              },
              bodyPatch: {
                type: 'object',
                description: 'Test case: fields to set in the copied JSON body, by path — {"eventName": "Comemora-ção", "contact.phones[0].number": null}. Values are literal JSON (null = null).',
              },
              bodyRemove: {
                type: 'array',
                items: { type: 'string' },
                description: 'Test case: paths to delete from the body ("field absent"), e.g. ["contact.email"].',
              },
              expect: {
                type: 'object',
                description:
                  'Test case: the asserts to generate — {"status": 400, "codes": ["EventName.Invalid"], "notificationsPath": "notifications", "fields": {"data.status": "Confirmed"}}. Test names start with the case id (the name prefix, e.g. "C-11"; or "caseId").',
              },
              caseId: { type: 'string', description: 'Case id for the test names. Default: the name prefix ("C-11 - Hífen" → "C-11").' },
              ...REQUEST_STEP_PROPERTIES,
            },
          },
        },
      },
      required: ['name', 'steps'],
    },
  }
);

MCP_TOOLS.push(
  {
    name: 'list_flow_recipes',
    description:
      'List the ready-made flow recipes this DevFlow ships: id, title, context (b2b, grupos), status (confirmed, or partial = some steps still need their details confirmed) and the words in a request that point to each. Start here when asked to create a flow; then call get_flow_recipe. Example: {}',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_flow_recipe',
    description:
      'One flow recipe, complete: the questions to ask the user ("ask"), the authentication block already as create_flow steps ("include"), the steps in order (where to copy each request from, what it consumes and produces, the exact scripts) and the rules to apply it ("rules"). Follow the rules, then create everything with one create_flow call. Example: {"id": "b2b-reserva-partida-24h"}',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Recipe id from list_flow_recipes.' } },
      required: ['id'],
    },
  },
  {
    name: 'create_flow_from_recipe',
    description:
      'The fastest way to build a flow from a recipe: send the recipe id and the user\'s answers to its "ask" questions; the app picks the auth block, drops the steps whose "when" does not match, fills route/pax/etc. in the scripts, copies every source request ("copyFrom") and the reference scripts ("scriptsFrom"), names the folder "Flow NN - …" with the next free number, creates everything and validates it. Nothing is created if a step cannot be resolved, an answer is missing, or a step has an unconfirmed CONFIRMAR block — the error says what to send. dryRun: true returns the plan (each step with its source) without creating. The result has a ready delivery table. Saves locally only, does not run. Example: {"id": "b2b-reserva-paga", "answers": {"route": "VCP → SDU", "pax": "1"}}',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Recipe id from list_flow_recipes.' },
        answers: {
          type: 'object',
          description: 'Answer to each "ask" question, by its id — the option text or the user\'s words, e.g. {"payment": "hold", "route": "VCP → SDU", "pax": "1"}.',
        },
        overrides: {
          type: 'object',
          description:
            'Per recipe step (by its name in the recipe, or its 1-based position): fields that replace the recipe ones — copyFrom (id/path, when the source is ambiguous), body, url, headers, preRequestScript, postResponseScript, scriptsFrom (null = none) or {"skip": true}.',
        },
        confirmed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Recipe step names whose CONFIRMAR block (JSON paths) you have checked (get_example, get_last_run or the reference flow) and that are right as written.',
        },
        name: { type: 'string', description: 'Folder name. Default: the recipe folderName with the next free "Flow NN".' },
        parentFolderId: { type: 'string', description: 'Where to create it. Default: the recipe parentFolder.' },
        environment: { type: 'string', description: 'Environment for the check (names only). Default: the recipe one.' },
        dryRun: { type: 'boolean', description: 'Only show the plan; create nothing.' },
      },
      required: ['id', 'answers'],
    },
  },
  {
    name: 'update_request',
    description:
      'Change fields of an existing request: method, url, pathParams, headers, body, bodyType, auth, preRequestScript, postResponseScript. Only the fields you send change; headers, pathParams and auth.oauth2, when sent, are the WHOLE list. A value equal to "[redacted — set in DevFlow]" (what get_request shows for a secret) KEEPS the real secret — so you can send back what you read. Changing auth.type starts that auth from scratch. Saves locally only — push to GitHub stays a manual action. Only edit requests you created in this task unless the user asks. Example: {"requestId": "<id>", "url": "{{urlOrderGroups}}/api/v1/order", "headers": [{"key": "Ocp-Apim-Subscription-Key", "value": "[redacted — set in DevFlow]"}, {"key": "Content-Type", "value": "application/json"}]}',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request id (from list_requests or create_flow).' },
        ...REQUEST_STEP_PROPERTIES,
      },
      required: ['requestId'],
    },
  },
  {
    name: 'move_item',
    description:
      'Move a request or folder into a folder, at a position — inside the same folder this reorders it, which is how you insert a step in the middle of a flow. position 1 = first; omit to put it last. Only folders can go to the top level (targetFolderId omitted). Saved Examples move with their request. Saves locally only. Example: {"itemId": "<id of the new step>", "targetFolderId": "<flow folder id>", "position": 3}',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Request or folder id.' },
        targetFolderId: {
          type: 'string',
          description: 'Destination folder id or full path (as in list_folders). Omit to move a folder to the top level.',
        },
        position: { type: 'number', description: '1 = first. Omit to put it last.' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'delete_item',
    description:
      'Delete a request or folder (with everything inside it) from the local tree. To avoid deleting the wrong thing, confirmName must be EXACTLY the item name. It disappears from GitHub only on the next push of the workspace (manual). Only delete what you created in this task, or what the user explicitly asked to delete. Example: {"itemId": "<id>", "confirmName": "04 - POST Quote"}',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Request or folder id.' },
        confirmName: { type: 'string', description: 'The exact current name of the item.' },
      },
      required: ['itemId', 'confirmName'],
    },
  }
);

// Exemplos de chamada nas ferramentas mais usadas: modelos menores acertam
// muito mais os parâmetros com um exemplo do que só com o schema.
const TOOL_EXAMPLES: Record<string, string> = {
  list_requests: '{"folderId": "Method Flows Grupos - Claude / Flow 07 - Cotação até checkout", "search": "Quote"}',
  list_folders: '{"search": "Method Flows"}',
  get_request: '{"requestId": "<id from list_requests>"}',
  search_requests: '{"query": "\\"contact\\"", "folderId": "Portal De Grupos - APIs / Quote.Groups / v1", "fields": ["body"]}',
  run_request: '{"requestId": "<id>", "environment": "5by5"}',
  run_collection: '{"folderId": "<flow folder id>", "environment": "5by5", "stopOnFailure": true}',
  set_request_script: '{"requestId": "<id>", "phase": "postResponse", "code": "var data = pm.response.json().data;\\npm.environment.set(\\"quoteNumber\\", data.number);"}',
  create_folder: '{"name": "Flow 08 - Reserva", "parentFolderId": "Method Flows Barramento B2B - Claude"}',
  duplicate_request: '{"requestId": "<id of Gerar token MSAL>", "folderId": "<flow folder id>", "name": "01 - Gerar token MSAL"}',
  create_request: '{"folderId": "<flow folder id>", "name": "04 - POST Quote", "method": "POST", "url": "{{urlGroupsQuoteApi}}/api/v1/quote", "headers": [{"key": "Ocp-Apim-Subscription-Key", "value": "{{apiKey}}"}, {"key": "Content-Type", "value": "application/json"}], "auth": {"type": "bearer", "token": "{{bearerToken}}"}, "body": "{\\"paxCount\\": 10}", "postResponseScript": "var data = pm.response.json().data;\\npm.environment.set(\\"quoteNumber\\", data.number);"}',
  rename_item: '{"itemId": "<id>", "name": "05 - GET Quote"}',
  get_oauth2_token: '{"requestId": "<id of Gerar token MSAL>", "environment": "5by5"}',
  get_last_run: '{"folderId": "<flow folder id>", "onlyFailures": true}',
};

// Anotações MCP de cada ferramenta.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const TOOL_ANNOTATIONS: Record<string, McpToolDefinition['annotations']> = {
  list_requests: READ_ONLY, list_folders: READ_ONLY, get_request: READ_ONLY, list_examples: READ_ONLY,
  get_example: READ_ONLY, search_requests: READ_ONLY, get_active_request: READ_ONLY, get_response: READ_ONLY,
  list_environments: READ_ONLY, get_script_api: READ_ONLY, list_load_tests: READ_ONLY, get_console_logs: READ_ONLY,
  get_last_run: READ_ONLY, validate_flow: READ_ONLY, list_flow_recipes: READ_ONLY, get_flow_recipe: READ_ONLY,
  create_flow_from_recipe: LOCAL_WRITE,
  // Chamam APIs de verdade, com as credenciais do usuário (e criam dados lá).
  run_request: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  run_collection: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  run_load_test: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  get_oauth2_token: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Mexem só na árvore local.
  create_folder: LOCAL_WRITE, create_request: LOCAL_WRITE, create_flow: LOCAL_WRITE, duplicate_request: LOCAL_WRITE,
  move_item: LOCAL_WRITE,
  rename_item: { ...LOCAL_WRITE, idempotentHint: true },
  set_request_script: { ...LOCAL_WRITE, destructiveHint: true, idempotentHint: true },
  update_request: { ...LOCAL_WRITE, destructiveHint: true, idempotentHint: true },
  delete_item: { ...LOCAL_WRITE, destructiveHint: true },
};
for (const tool of MCP_TOOLS) {
  tool.annotations = TOOL_ANNOTATIONS[tool.name];
  const example = TOOL_EXAMPLES[tool.name];
  // "Example: {" — não basta "Example:" (a descrição do get_example fala em "Saved Example: …").
  if (example && !/Example: \{/.test(tool.description)) tool.description += ` Example: ${example}`;
}

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

  // Final do caminho só vale em fronteira de segmento: "Flow" é a pasta
  // "Flow", não "Booking Flow". Sem isso a referência casava com a pasta
  // errada e o run_collection a executava sem avisar.
  const normalized = wanted.toLowerCase().replace(/\s*\/\s*/g, ' / ');
  const exact = folders.filter(f => f.path.toLowerCase() === normalized);
  const matches =
    exact.length > 0
      ? exact
      : folders.filter(
          f =>
            f.path.toLowerCase().endsWith(` / ${normalized}`) ||
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

// Variável gravada por um passo, como o agente pode vê-la: o nome sempre, o
// valor só quando não é credencial. De um JWT sai o que o get_oauth2_token já
// mostra (validade, usuário, audience), que é o que serve pra diagnosticar.
function maskVariableChange(change: VariableChange, redact: SecretRedactor) {
  if (!isSecretVariable(change.key, change.value)) {
    return { ...change, value: redact(change.value) };
  }
  const info = describeToken(change.value);
  return { ...change, value: HIDDEN_VALUE, ...(info.readable ? { token: info } : {}) };
}

// Todo texto livre que sai de uma execução passa pelo redator: um script que
// faz console.log(pm.environment.get('token')), uma URL com ?api_key= ou o body
// do login devolvendo o access_token entregariam o segredo do mesmo jeito.
function summarizeOutcome(name: string, outcome: RunItemOutcome, redact: SecretRedactor) {
  const verdict = stepVerdict(outcome);
  return {
    request: name,
    verdict: verdict.verdict,
    ...(verdict.failureReason ? { failureReason: redact(verdict.failureReason) } : {}),
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    responseTimeMs: outcome.responseTime,
    error: outcome.errorMessage === undefined ? undefined : redact(outcome.errorMessage),
    scriptError: outcome.scriptError === undefined ? undefined : redact(outcome.scriptError),
    resolvedUrl: outcome.resolvedUrl === undefined ? undefined : redact(outcome.resolvedUrl),
    tests: redactTests(outcome.tests, redact),
    logs: (outcome.logs ?? []).map(log => ({ ...log, message: redact(log.message) })),
    variablesSet: (outcome.variablesSet ?? []).map(change => maskVariableChange(change, redact)),
    bodySnippet: outcome.responseBodySnippet === undefined ? undefined : redact(outcome.responseBodySnippet),
  };
}

function redactTests(tests: RunItemOutcome['tests'] | undefined, redact: SecretRedactor) {
  return (tests ?? []).map(test => ({ ...test, name: redact(test.name), message: redact(test.message) }));
}

// Redator de uma execução: env de entrada, env de saída e tudo que os scripts
// gravaram no caminho (inclusive o que um passo seguinte apagou).
function redactorFor(envBefore: Record<string, string>, outcomes: RunItemOutcome[]): SecretRedactor {
  return createSecretRedactor(
    [envBefore, ...outcomes.map(o => o.envAfter)],
    outcomes.flatMap(o => o.variablesSet ?? [])
  );
}

// Nomes das variáveis do environment — o que o validate_flow conta como
// disponível. Só nomes: o valor nunca é lido.
// Mesma regra do buildEnvMap (lib/envMap): só vale variável habilitada de
// verdade. Com `enabled !== false`, uma entrada sem o campo (import de fora)
// passava no validate e sumia na execução.
// Alguns clientes (e modelos menores) mandam um objeto/lista como TEXTO JSON.
// Sem isto, "answers": "{\"route\": …}" virava "todas as respostas faltando"
// e "steps": "[…]" virava "steps is required".
function jsonArg<T>(value: unknown, what: string): T | undefined {
  if (typeof value !== 'string') return value as T | undefined;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`"${what}" must be a JSON object/array, not text. Send it as JSON (e.g. {"route": "VCP → SDU"}).`);
  }
}

function envVariableNames(env: Environment | undefined): string[] | null {
  return env ? env.values.filter(v => !!v.enabled && !!v.key).map(v => v.key) : null;
}

// O que dizer sobre o check de um flow. Variável faltando no environment
// (credencial, URL) é tarefa do USUÁRIO: antes ela entrava em "fix them
// before delivering", e um agente menor tentava "consertar" com script ou
// recriando o passo — ou ficava em loop. Só o resto é erro do agente.
function checkNote(check: { steps: { problems: { level: string; code: string }[] }[]; missingVariables: string[] }): string {
  const agentErrors = check.steps.reduce(
    (n, s) => n + s.problems.filter(p => p.level === 'error' && p.code !== 'missing-variable').length,
    0
  );
  return (
    (agentErrors ? ` The check found ${agentErrors} error(s) in the steps: fix them (set_request_script, update_request, move_item) before delivering.` : '') +
    (check.missingVariables.length
      ? ` Variables to create in the app: ${check.missingVariables.join(', ')} — the user creates them; list them in the delivery and do NOT try to fix them.`
      : '')
  );
}

const NO_ENV_CHECK_NOTE =
  'No environment selected: every variable that no step produces is reported as missing. Pass environment to check against it.';

const ENV_NOT_SAVED_NOTE =
  'No environment is selected in DevFlow, so variables set by scripts were used only inside this call and not saved. Pass environment to keep them.';

// Keys cujo valor mudou (ou que sumiram) entre dois mapas de env.
function changedKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => before[key] !== after[key]);
}

// Grava no environment o que a execução mudou. Antes o MCP descartava o
// envAfter: o passo 1 rodado por run_request não alimentava o passo 2, e cada
// run_request de um passo de token abria o login de novo.
async function persistEnvironment(
  ctx: McpContext,
  env: Environment | undefined,
  before: Record<string, string>,
  after: Record<string, string>,
  requestName: string
): Promise<{ savedToEnvironment?: string[]; note?: string }> {
  const keys = changedKeys(before, after);
  if (keys.length === 0) return env ? { savedToEnvironment: [] } : {};
  if (!env) return { note: ENV_NOT_SAVED_NOTE };
  await ctx.applyEnvironmentChanges(env.id, before, after, requestName);
  return { savedToEnvironment: keys };
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

      const envBefore = envMapOf(env);
      const outcome = await runCollectionRequest(item, envBefore);
      const saved = await persistEnvironment(ctx, env, envBefore, outcome.envAfter, item.name);
      const redact = redactorFor(envBefore, [outcome]);
      const summary = summarizeOutcome(item.name, outcome, redact);

      // O snippet de 2000 chars do Runner serve pra UI; aqui o agente
      // precisa do corpo inteiro pra escrever assertion contra o shape real.
      const { bodySnippet, ...rest } = summary;
      return {
        environment: env?.name ?? null,
        ...saved,
        ...rest,
        ...truncate(
          outcome.fullResponseBody !== undefined ? redact(outcome.fullResponseBody) : bodySnippet ?? '',
          args.maxBodyBytes
        ),
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
      const envBefore = envMapOf(env);
      let envMap = envBefore;
      const outcomes: { name: string; outcome: RunItemOutcome }[] = [];

      const savedKeys = new Set<string>();
      for (const req of requests) {
        const outcome = await runCollectionRequest(req, envMap);
        // Passo a passo, como o Runner: se o fluxo parar no meio, o que os
        // passos anteriores gravaram (o token, um id) já está no environment.
        const saved = await persistEnvironment(ctx, env, envMap, outcome.envAfter, req.name);
        saved.savedToEnvironment?.forEach(key => savedKeys.add(key));
        envMap = outcome.envAfter;
        outcomes.push({ name: req.name, outcome });
        if (args.stopOnFailure && failed(outcome)) break;
      }

      // Resume só no fim: o token que o passo 1 obtém aparece nos logs e
      // bodies dos passos seguintes, então o redator precisa conhecer TODOS
      // os segredos do run antes de mascarar qualquer passo.
      const redact = redactorFor(envBefore, outcomes.map(o => o.outcome));
      const fullSteps = outcomes.map(({ name, outcome }) => summarizeOutcome(name, outcome, redact));
      const compact = args.detail === 'failures';
      // Subpasta (grupo da suíte) de cada request, pelo id.
      const groupOf = new Map<string, string>();
      {
        const found: { item: CollectionItem; path: FolderRef[] }[] = [];
        walkWithPath(folder.item ?? [], [], found);
        for (const entry of found) groupOf.set(entry.item.id, entry.path[0]?.name ?? '');
      }
      const groupNames = outcomes.map((_, index) => groupOf.get(requests[index].id) ?? '');
      const steps = compact
        ? fullSteps.map((st, index) =>
            st.verdict === 'failed'
              ? { ...st, ...(groupNames[index] ? { group: groupNames[index] } : {}) }
              : {
                  request: st.request,
                  ...(groupNames[index] ? { group: groupNames[index] } : {}),
                  verdict: st.verdict,
                  httpStatus: st.httpStatus,
                  tests: `${(st.tests ?? []).filter(x => x.passed).length}/${(st.tests ?? []).length}`,
                }
          )
        : fullSteps;

      const allTests = fullSteps.flatMap(st => st.tests ?? []);
      const failedSteps = fullSteps.filter(st => st.verdict === 'failed');
      const distinctGroups = [...new Set(groupNames)];
      const groups =
        distinctGroups.length > 1 || (distinctGroups.length === 1 && distinctGroups[0] !== '')
          ? distinctGroups.map(group => {
              const inGroup = fullSteps.filter((_, index) => groupNames[index] === group);
              const failedInGroup = inGroup.filter(st => st.verdict === 'failed').length;
              return { group: group || '(folder root)', steps: inGroup.length, passed: inGroup.length - failedInGroup, failed: failedInGroup };
            })
          : undefined;
      // Matriz por caso: o id vem do nome ("C-11 - Hífen"); o esperado, dos nomes dos testes.
      const matrix = compact
        ? fullSteps
            .map((st, index) => ({ st, group: groupNames[index] }))
            .filter(({ st }) => (st.tests ?? []).length > 0)
            .map(({ st, group }) => ({
              case: caseIdOf(st.request),
              request: st.request,
              ...(group ? { group } : {}),
              expected: (st.tests ?? []).map(x => x.name.replace(/^[^:]+:\s*/, '')).join('; '),
              httpStatus: st.httpStatus,
              result: st.verdict === 'passed' ? 'passou' : 'falhou',
              ...((st.tests ?? []).some(x => !x.passed)
                ? { failedTests: (st.tests ?? []).filter(x => !x.passed).map(x => `${x.name}: ${x.message ?? ''}`.trim()) }
                : {}),
            }))
            // Parou antes (stopOnFailure): o resto entra como não executado —
            // sumir da matriz fazia o relatório parecer completo.
            .concat(
              requests.slice(outcomes.length).map(item => ({
                case: caseIdOf(item.name),
                request: item.name,
                ...(groupOf.get(item.id) ? { group: groupOf.get(item.id) } : {}),
                expected: '',
                httpStatus: undefined,
                result: 'não executado',
              }))
            )
        : undefined;
      return {
        folder: folder.name,
        environment: env?.name ?? null,
        ...(env
          ? { savedToEnvironment: [...savedKeys] }
          : { note: ENV_NOT_SAVED_NOTE }),
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
        ...(groups ? { groups } : {}),
        ...(matrix ? { matrix } : {}),
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
      const allRequests = item.type === 'request' ? [item] : flattenRequests(item.item ?? []);
      if (allRequests.length === 0) throw new Error(`"${item.name}" has no requests to run.`);

      // Passo de token sai do flow: o token é obtido uma vez antes da carga
      // (ver resolveTokenSteps) e gravado no environment, como no run_collection.
      const envBefore = envMapOf(env);
      const prepared = await resolveTokenSteps(allRequests, envBefore);
      await persistEnvironment(ctx, env, envBefore, prepared.envMap, item.name);
      if (prepared.requests.length === 0) {
        throw new Error(`"${item.name}" only has token steps — there is no request to put under load.`);
      }

      const flow = buildFlowSteps(prepared.requests);
      // Mesmo filtro do buildFlowSteps: gRPC e item sem request não entram.
      const emptyUrl = prepared.requests.find(
        r => !!r.request && r.protocol !== 'grpc' && !r.request.url?.trim()
      );
      if (emptyUrl) {
        throw new Error(`"${emptyUrl.name}" has an empty URL.`);
      }

      const iterationsPerVu = Number(args.iterationsPerVu) || undefined;
      const config: LoadTestConfig = {
        flow,
        environment: prepared.envMap,
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
        ...(prepared.tokenSteps.length > 0
          ? {
              tokenSteps: prepared.tokenSteps.map(({ item: step, outcome }) => ({
                request: step.name,
                // "Reused…" ou "New token stored in {{x}}…" — nunca o token.
                result: outcome.responseBodySnippet ?? null,
              })),
            }
          : {}),
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
      // Sem isto, um id de pasta gravava `request.scripts` dentro da pasta —
      // um campo estranho que ia junto pro GitHub.
      if (item.type !== 'request') {
        throw new Error(`"${item.name}" is a ${item.type}, not a request: scripts go on requests. Nothing was changed.`);
      }

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

      // O run guardado não tem o env de entrada; o environment selecionado
      // agora é a melhor aproximação, e o que os passos gravaram vem junto.
      const redact = redactorFor(
        envMapOf(resolveEnvironment(ctx)),
        entries.map(e => e.outcome!)
      );

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
            error: o.errorMessage != null ? redact(o.errorMessage) : null,
            scriptError: o.scriptError != null ? redact(o.scriptError) : null,
            resolvedUrl: o.resolvedUrl != null ? redact(o.resolvedUrl) : null,
            tests: redactTests(o.tests, redact),
            // É o campo que resolve a pergunta "qual resposta eu devo
            // asseverar?" sem precisar reexecutar nada.
            responseBody: (() => {
              const body = o.fullResponseBody ?? o.responseBodySnippet;
              return body != null ? redact(body) : null;
            })(),
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
        // Entra no fim da pasta: depois dos itens DIRETOS dela (subpastas
        // contam como um item; as requests dentro delas, não).
        position: (folder.item ?? []).length + 1,
        note: 'Saved locally. Push to GitHub is still a manual action in the app.',
      };
    }

    case 'list_flow_recipes':
      return { recipes: listFlowRecipes(), rules: RECIPE_RULES };

    case 'get_flow_recipe':
      return getFlowRecipe(String(args?.id ?? ''));

    case 'update_request': {
      const item = findNodeById(ctx.collections, String(args?.requestId ?? ''));
      if (!item) throw new Error(`Request "${args?.requestId}" not found.`);
      const patch = { ...(args ?? {}) };
      delete patch.requestId;
      const { item: updated, changed } = applyRequestPatch(item, patch);
      await ctx.updateCollectionItem(item.id, updated);
      return {
        ok: true,
        requestId: item.id,
        name: item.name,
        changed,
        // O que ficou, como o get_request mostraria (segredos mascarados).
        request: redactRequestDetails(updated.request),
        note: 'Saved locally. Push to GitHub is still a manual action in the app. Run validate_flow on the flow folder to re-check the chain.',
      };
    }

    case 'move_item': {
      const item = findNodeById(ctx.collections, String(args?.itemId ?? ''));
      if (!item) throw new Error(`Item "${args?.itemId}" not found.`);
      const target = args?.targetFolderId ? resolveTargetFolder(ctx, String(args.targetFolderId)) : null;
      const position = args?.position === undefined ? undefined : Number(args.position);
      // Confere tudo na árvore de agora antes de gravar.
      const { index } = moveItem(ctx.collections, item.id, target?.id ?? null, position);
      await ctx.moveCollectionItem(item.id, target?.id ?? null, position);
      return {
        ok: true,
        itemId: item.id,
        name: item.name,
        folder: target?.name ?? null,
        position: index + 1,
        note: 'Saved locally. Push to GitHub is still a manual action in the app. In a flow, run order = tree order.',
      };
    }

    case 'delete_item': {
      const item = findNodeById(ctx.collections, String(args?.itemId ?? ''));
      if (!item) throw new Error(`Item "${args?.itemId}" not found.`);
      if (String(args?.confirmName ?? '') !== item.name) {
        throw new Error(`confirmName must be exactly the item name ("${item.name}"). Nothing was deleted.`);
      }
      const requests = item.type === 'request' ? 1 : flattenRequests(item.item ?? []).length;
      await ctx.removeCollectionItem(item.id);
      return {
        ok: true,
        deleted: { id: item.id, name: item.name, type: item.type, requests },
        note: 'Deleted locally. It is removed from GitHub only on the next push of the workspace (manual). The user can restore it from the GitHub history until then.',
      };
    }

    case 'validate_flow': {
      const folder = resolveTargetFolder(ctx, String(args?.folderId ?? ''));
      const env = resolveEnvironment(ctx, args?.environment);
      if (args?.environment && !env) throw new Error(`Environment "${args.environment}" not found.`);
      const report = validateFlow(flattenRequests(folder.item ?? []), envVariableNames(env));
      const note = (checkNote(report) + (env ? '' : ` ${NO_ENV_CHECK_NOTE}`)).trim();
      return {
        folder: folder.name,
        environment: env?.name ?? null,
        ...(note ? { note } : {}),
        ...report,
      };
    }

    case 'create_flow': {
      const folderName = String(args?.name ?? '').trim();
      if (!folderName) throw new Error('name is required.');
      const stepsArg = jsonArg<unknown>(args?.steps, 'steps');
      const specs: Record<string, unknown>[] = Array.isArray(stepsArg) ? (stepsArg as Record<string, unknown>[]) : [];
      if (specs.length === 0) throw new Error('steps is required: at least one step.');
      if (specs.length > 60) throw new Error(`Too many steps (${specs.length}). Split the flow: at most 60 steps per call.`);

      const parent = args?.parentFolderId ? resolveTargetFolder(ctx, String(args.parentFolderId)) : null;
      const env = resolveEnvironment(ctx, args?.environment);
      if (args?.environment && !env) throw new Error(`Environment "${args.environment}" not found.`);
      const numberSteps = args?.numberSteps !== false;
      const numbered = (base: string, index: number) =>
        numberSteps && !/^\d+\s*-/.test(base) ? `${String(index + 1).padStart(2, '0')} - ${base}` : base;

      // Tudo montado e conferido ANTES de gravar: um passo inválido não deixa
      // um flow pela metade na árvore.
      const built = buildSteps(ctx, specs, numbered);
      const nodes = built.map(step => step.node);

      const folderNode: CollectionItem = { id: crypto.randomUUID(), name: folderName, type: 'folder', item: nodes };
      await ctx.addCollectionItem(parent?.id ?? null, folderNode);

      const check = validateFlow(nodes, envVariableNames(env));
      const warnings = built.flatMap((step, index) => step.warnings.map(w => `Step ${index + 1}: ${w}`));
      return {
        ok: true,
        folderId: folderNode.id,
        name: folderName,
        parent: parent?.name ?? null,
        steps: built.map((step, index) => ({
          position: index + 1,
          id: step.node.id,
          name: step.node.name,
          ...(step.source ? { source: step.source } : {}),
          ...(step.scriptsSource ? { scriptsFrom: step.scriptsSource } : {}),
        })),
        environment: env?.name ?? null,
        check,
        ...(check.missingVariables.length ? { variablesToCreate: check.missingVariables } : {}),
        ...(warnings.length ? { warnings } : {}),
        note:
          'Saved locally. Push to GitHub is still a manual action in the app. Not executed.' +
          checkNote(check) +
          (env ? '' : ` ${NO_ENV_CHECK_NOTE}`),
      };
    }

    case 'create_flow_from_recipe': {
      const recipe = getRawRecipe(String(args?.id ?? ''));
      const answers = Object.fromEntries(
        Object.entries(jsonArg<Record<string, unknown>>(args?.answers, 'answers') ?? {}).map(([k, v]) => [k, String(v ?? '')])
      );
      const confirmedArg = jsonArg<unknown>(args?.confirmed, 'confirmed');
      const plan = planRecipe(recipe, AUTH_BLOCKS, answers, {
        overrides: jsonArg<Record<string, Record<string, unknown>>>(args?.overrides, 'overrides') ?? {},
        confirmed: Array.isArray(confirmedArg) ? confirmedArg.map(String) : [],
      });
      const dryRun = args?.dryRun === true;

      const blockers: string[] = [];
      if (plan.missingAnswers.length) {
        blockers.push(
          'Missing answers — ask the user (ONE round) and send them in "answers": ' +
            plan.missingAnswers
              .map(q => `${q.id}: ${q.question}${q.options.length ? ` [${q.options.join(' | ')}]` : ''}`)
              .join('; ')
        );
      }
      if (plan.unresolved.length) {
        blockers.push(
          `The source of ${plan.unresolved.map(s => `"${s}"`).join(', ')} depends on a choice the recipe does not resolve: send overrides {"<step name>": {"copyFrom": "<id or path>"}} (list_requests / search_requests), or {"skip": true}.`
        );
      }
      if (plan.needsConfirmation.length) {
        blockers.push(
          `Confirm the CONFIRMAR block (JSON paths) of ${plan.needsConfirmation.map(s => `"${s}"`).join(', ')} with get_example / get_last_run / the reference flow, then send them in "confirmed" (or a corrected postResponseScript in overrides). "Use the recommended" does not confirm a JSON path.`
        );
      }

      const parentRef = String(args?.parentFolderId ?? recipe.parentFolder ?? '');
      let parent: CollectionItem | null = null;
      if (parentRef) {
        try {
          parent = resolveTargetFolder(ctx, parentRef);
        } catch (e) {
          blockers.push(
            `Where to create it: ${(e as Error).message} Create that folder in the app, or send "parentFolderId" with another one (ask the user which).`
          );
        }
      }
      const env = resolveEnvironment(ctx, String(args?.environment ?? recipe.environment ?? '') || undefined);
      const folderName = String(args?.name ?? '').trim() ||
        numberedFlowName(String(recipe.folderName ?? recipe.title ?? 'Flow NN'), (parent?.item ?? []).map(i => i.name));
      const numbered = (base: string, index: number) =>
        /^\d+\s*-/.test(base) ? base : `${String(index + 1).padStart(2, '0')} - ${base}`;

      // Resolve cada origem mesmo no dryRun: o plano mostra de onde cada passo vem.
      const resolved = plan.steps.map((planned, index) => {
        try {
          return { planned, step: buildSteps(ctx, [planned.spec], base => numbered(base, index), true)[0] };
        } catch (e) {
          return { planned, error: (e as Error).message.replace(/^Step 1: /, '').replace(/ Nothing was created\.$/, '') };
        }
      });
      const failures = resolved.filter(r => 'error' in r && r.error);
      const recipeWorkspace = String(recipe.workspace ?? '').trim();
      if (failures.length && recipeWorkspace && recipeWorkspace.toLowerCase() !== String(ctx.workspace ?? '').trim().toLowerCase()) {
        blockers.unshift(
          `This recipe is for the workspace "${recipeWorkspace}", but "${ctx.workspace}" is open in DevFlow: its source requests are not here. Ask the user to open "${recipeWorkspace}" in the app and call again.`
        );
      }
      for (const f of failures) {
        blockers.push(
          `Step "${f.planned.recipeName}": ${(f as { error: string }).error} Fix it with overrides {"${f.planned.recipeName}": {...}} — copyFrom (id or path), or scriptsFrom: null plus the scripts — or {"skip": true}.`
        );
      }

      const review = plan.steps
        .filter(s => s.status && !/^confirmad/i.test(s.status) && s.notes)
        .map(s => ({ step: s.recipeName, notes: s.notes }));
      if (plan.unusedAnswers.length) {
        review.push({
          step: '(answers)',
          notes:
            `Not applied automatically: ${plan.unusedAnswers.map(id => `${id} = "${answers[id]}"`).join(', ')}. ` +
            'Put them where the step notes say (e.g. route and passengers in the search body) with update_request on the created step.',
        });
      }
      const planRows = resolved.map((r, index) => ({
        position: index + 1,
        name: r.step?.node.name ?? numbered(r.planned.recipeName, index),
        source: r.step?.source ?? (r.step ? 'new request' : null),
        scriptsFrom: r.step?.scriptsSource,
        status: r.planned.status,
        ...('error' in r && r.error ? { error: r.error } : {}),
      }));

      if (dryRun || blockers.length) {
        return {
          ok: false,
          created: false,
          ...(dryRun ? { dryRun: true } : {}),
          folderName,
          parent: parent?.name ?? null,
          plan: planRows,
          ...(blockers.length ? { blockers } : {}),
          ...(review.length ? { review } : {}),
          note: blockers.length
            ? 'Nothing was created. Resolve the blockers and call again.'
            : 'Dry run: nothing was created. Call again without dryRun to create it.',
        };
      }

      const built = resolved.map(r => r.step as BuiltStep);
      const nodes = built.map(b => b.node);
      const folderNode: CollectionItem = { id: crypto.randomUUID(), name: folderName, type: 'folder', item: nodes };
      await ctx.addCollectionItem(parent?.id ?? null, folderNode);
      const check = validateFlow(nodes, envVariableNames(env));
      const warnings = built.flatMap((b, index) => b.warnings.map(w => `Step ${index + 1}: ${w}`));
      const table = [
        '| Passo | Origem | Consome | Produz |',
        '|---|---|---|---|',
        ...check.steps.map((s, index) =>
          `| ${s.name} | ${built[index].source ?? 'nova'} | ${s.consumes.join(', ') || '—'} | ${s.produces.join(', ') || '—'} |`
        ),
      ].join('\n');
      return {
        ok: true,
        folderId: folderNode.id,
        name: folderName,
        parent: parent?.name ?? null,
        environment: env?.name ?? null,
        recipe: String(recipe.id ?? ''),
        answers,
        steps: planRows.map((row, index) => ({ ...row, id: nodes[index].id })),
        check,
        deliveryTable: table,
        ...(check.missingVariables.length ? { variablesToCreate: check.missingVariables } : {}),
        ...(review.length ? { review } : {}),
        ...(warnings.length ? { warnings } : {}),
        note:
          'Created locally, NOT executed. Push to GitHub is still a manual action in the app.' +
          checkNote(check) +
          (review.length ? ' Steps in "review" are not confirmed yet: check them with get_request on the created step.' : '') +
          (env ? '' : ` ${NO_ENV_CHECK_NOTE}`),
      };
    }

    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

// Passos do create_flow montados (ainda fora da árvore). Erro em qualquer um
// = nada é criado, e a mensagem diz qual passo.
function buildSteps(
  ctx: McpContext,
  specs: Record<string, unknown>[],
  numbered: (base: string, index: number) => string,
  fromRecipe = false
): BuiltStep[] {
  return specs.map((spec, index) => {
    try {
      return buildFlowStep(ctx.collections, spec ?? {}, base => numbered(base, index), {
        buildNew: buildRequestNode,
        mergeReferencePreRequest: fromRecipe,
      });
    } catch (e) {
      throw new Error(`Step ${index + 1}: ${(e as Error).message} Nothing was created.`);
    }
  });
}
