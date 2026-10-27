
'use client';

import { storeGet, storeSet } from '@/lib/tauriStore';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { toast } from 'sonner';
import type { OnMount, Monaco } from '@monaco-editor/react';
import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import {  Globe,  X,  ChevronDown,  ChevronUp,  Download,  Send,  Plus,  Copy,  Check, AlertTriangle, Folder, CheckCircle2, XCircle, Settings, Rows2, Columns2, PanelLeft, Save, Code2, MoreHorizontal, Trash2, Clock, Database, ExternalLink, Info, Terminal, Search, History, ChevronsDownUp, ChevronsUpDown, FilePlus2, Pin, PinOff, Sparkles, CopyCheck,} from 'lucide-react';
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { invoke } from "@tauri-apps/api/core";
import { useEnvironment } from '@/components/EnvironmentContext';
import { useTheme } from '@/components/ThemeContext';
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes';
import {  ResizableHandle,  ResizablePanel,  ResizablePanelGroup} from "@/components/ui/resizable";
import { useGroupRef } from "react-resizable-panels";
import Sidebar from "@/components/collection-tree/Sidebar";
import { addNode, renameNode, findNodeById, findParentId, patchNode, backfillExampleRequests, collectStarMarks, applyStarMarks, findRequestsByName, partitionExisting, type NamedMatch } from "@/components/collection-tree/utils/tree.utils";
import { useAppZoom } from '@/lib/useAppZoom';
import type { SnippetRequest } from '@/lib/codeSnippets';
import { ZoomControl } from '@/components/ZoomControl';
import { useMcpServer } from '@/mcp/useMcpServer';
import { McpContext } from '@/mcp/mcpTools';
import { useClaudeChat } from '@/claude/useClaudeChat';
import { ClaudeChatPanel } from '@/claude/ClaudeChatPanel';
import { useExtensionHost } from '@/extensions/useExtensionHost';
import { ExtensionSlot } from '@/extensions/ExtensionSlot';
import { RequestEditor } from './RequestEditor';
import { ApiResponse, DataResponse } from '@/app/types/DataResponse';
import { AuthorizationDetails, normalizeAuthType } from '@/app/types/AuthorizationDetails';
import { Tab } from '@/app/types/Tab';
import { sanitizeJsonBodyForSend } from '@/lib/sanitizeJsonBody';
import { buildRequestHeaders, requestHasBody } from '@/lib/defaultHeaders';
import { resolveAfterPreRequest } from '@/lib/preRequestResolution';
import { MissingPassphraseError } from '@/lib/syncCrypto';
import { ExampleResponseEditor, STATUS_TEXT } from './ExampleResponseEditor';
import { normalizeExampleLanguage } from '@/lib/exampleLanguage';
import { listen } from '@tauri-apps/api/event';
import { GrpcRequestPanel } from './Grpc/GrpcRequestPanel';
import { GrpcResponsePanel } from './Grpc/GrpcResponsePanel';
import { GrpcCallResult, GrpcMethodKind, GrpcStreamEvent, GrpcStreamState, emptyGrpcRequest } from '@/app/types/Grpc';
import { TestResult } from '@/app/types/TestResult';

// Campos "editáveis" de uma request que participam do undo/redo (Ctrl+Z).
// Deliberadamente excluímos response/testResults/isDirty/activeRequestTab —
// undo deve mexer só no conteúdo da request, não em navegação/resultados.
type TabSnapshot = Pick<Tab,
  'name' | 'method' | 'urlInput' | 'requestBodyValue' | 'bodyType' |
  'requestHeadersValue' | 'auth' | 'queryParams' | 'params' | 'scripts' | 'disabledDefaultHeaders' |
  'exampleDraft' | 'grpc'
>;

const SNAPSHOT_KEYS: (keyof TabSnapshot)[] = [
  'name', 'method', 'urlInput', 'requestBodyValue', 'bodyType',
  'requestHeadersValue', 'auth', 'queryParams', 'params', 'scripts', 'disabledDefaultHeaders',
  'exampleDraft', 'grpc',
];

function extractSnapshot(tab: Tab): TabSnapshot {
  const snap = {} as TabSnapshot;
  for (const key of SNAPSHOT_KEYS) {
    (snap as any)[key] = (tab as any)[key];
  }
  // Clona para não guardar referência que pode ser mutada depois.
  return JSON.parse(JSON.stringify(snap));
}
import { CollectionRunnerPanel } from '@/components/CollectionRunner/CollectionRunnerPanel';
import { LoadTestPanel } from '@/components/LoadTest/LoadTestPanel';
import { CollectionItem, ExampleData } from '@/app/types/CollectionItem';
import { CurlModal } from './SlidePanel/CurlModal';
import { buildFinalUrl } from '@/components/helper/buildFinalUrl';
import { QueryParam } from '@/app/types/QueryParam';
import { UrlInputWithVariables } from '@/components/Url-components/UrlInputWithVariables';
import { TabBar } from './TabBar';
import { MethodDropdown } from './Url-components/MethodDropdown';
import { TitleBar } from './TitleBar';
import GitHubSync, { GitHubSyncHandle } from './GitHubStorageClient';
import { ImportResult, usePostmanImport } from './usePostmanImport';
import { ParsedCurlRequest } from '@/lib/curlParser';
import { ImportCurlDialog } from './SlidePanel/ImportCurlDialog';
import { RequestErrorScreen } from './RequestErrorScreen';
import UserBadge from '@/components/UserBadge'
import { TabSession, TabSessionSelector } from './TabSessionSelector';
import { SettingsModal } from './Settings/SettingsModal';
import { loadCurrentSessionId, loadTabSessions, saveCurrentSessionId, saveTabSessions } from '@/lib/tabSessionsStore';
import { loadTabs, saveTabs, loadTabGroups, saveTabGroups, loadActiveTabId, saveActiveTabId } from '@/lib/tabsStore';
import { getTabDraft, removeTabDraft, removeTabDrafts } from '@/storage/tabDraftsStore';
import { EditableTitle } from './EditableTitle.';
import EnvironmentSelector from './EnvironmentSelector';
import { loadActiveEnvironmentId, saveActiveEnvironmentId } from '@/lib/activeEnvironmentStore';
import { buildEnvMap } from '@/lib/envMap';
import { GitHubConflictError } from './GitHubStorageClient';
import { changedFieldLabels, describeChanges } from '@/lib/unsavedChanges';
import { stripTabsForSession, sameSessionTabs } from '@/lib/tabSessions';
import { safeSetItem, sweepDeadKeys } from '@/lib/safeStorage';
import { loadWorkspaceLocalData, loadWorkspaceMarkers, saveWorkspaceCollections, saveWorkspaceEnvironments, saveWorkspaceMarkers } from '@/storage/localSyncStore';
import { type Marker, mergeCatalogs, purgeOrphans, remapMarkers } from '@/lib/markers';
import {
  markCollectionsPendingPush,
  markEnvironmentsPendingPush,
  markFullPushRequired,
  clearWorkspacePendingPush,
  clearCollectionsPendingPush,
  readPendingPush,
  isPendingEmpty,
  EMPTY_PENDING,
  type PendingPush,
} from '@/storage/pendingPushStore';
import { fingerprintRoots, diffRoots, type RootFingerprints } from '@/lib/collectionFingerprint';
import { compareWorkspaces, describeComparison } from '@/lib/remoteComparison';
import { diffTrees, filterSubtree, type DiffNode } from '@/lib/collectionDiff';
import { pruneEmptyGroups, type TabGroup } from '@/lib/tabGroups';
import { applySelectedChanges } from '@/lib/applyDiff';
import { diffEnvironments, applyEnvironmentChanges } from '@/lib/environmentDiff';
import { nodeHashes, recordSyncBase, loadSyncBase, type NodeHashes } from '@/lib/syncBase';
import type { OverrideMap } from '@/lib/diffFields';
import { SyncDiffDialog } from '@/components/SyncDiff/SyncDiffDialog';
import { pushResponseHistory, getResponseHistory, toApiResponse, enforceHistoryBudget, ResponseHistoryEntry } from '@/storage/responseHistoryStore';
import {
  createWorkspace as createWorkspaceStore,
  deleteWorkspace as deleteWorkspaceStore,
  getSelectedWorkspace,
  setSelectedWorkspace as persistSelectedWorkspace,
  listWorkspaces,
  WorkspaceInfo,
} from '@/storage/workspaceStore';
import WorkspaceSelector from './WorkspaceSelector';
import { Environment } from '@/app/types/Environment';


const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });
// Última posição do cursor no editor de response, por aba. `contentLength`
// guarda o tamanho do corpo que estava em tela quando a posição foi salva —
// serve pra saber se aquela posição ainda faz sentido (se a request foi
// reenviada e veio um response diferente, a posição antiga é descartada e o
// editor começa do topo).
const responsePositions = new Map<
  string,
  { lineNumber: number; column: number; contentLength: number }
>();

// Estado da busca (Ctrl+F) do editor de response, por aba. O widget de find
// é do EDITOR, não do documento — como todas as abas compartilham a mesma
// instância do Monaco, sem guardar isso a pesquisa aberta em uma aba
// "vazava" pra outra ou simplesmente sumia ao voltar.
const responseSearches = new Map<string, { query: string; isRevealed: boolean }>();

interface ScriptRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface ScriptContext {
  env: Record<string, string>;
  response?: any;
  responseBody?: string;
  request?: ScriptRequest;
  responseTime?: number;
  tests?: TestResult[];
  scriptError?: string;
}
type SendMode = 'send' | 'send-and-download';

type ConsoleLogLevel = 'log' | 'info' | 'warn' | 'error';
// 'response' = erro de HTTP (status 4xx/5xx ou falha de rede/transporte)
// 'script'   = exceção ou erro de pre-request/post-response script
// 'system'   = validação local (URL inválida, JSON de variáveis do GraphQL
//              inválido, etc) — não chegou a bater no servidor nem rodar script
type ConsoleLogSource = 'response' | 'script' | 'system';

interface ConsoleLogEntry {
  id: string;
  level: ConsoleLogLevel;
  message: string;
  timestamp: number;
  // Nome da tab/request que gerou o log — sem isso, com várias tabs abertas,
  // não dava pra saber de qual request um erro veio.
  requestName?: string;
  source?: ConsoleLogSource;
  // Status HTTP, quando source === 'response' e a request chegou a responder
  // (não é falha de transporte).
  status?: number;
  // Conteúdo extra (stack trace do script, corpo da resposta de erro, etc) —
  // mostrado colapsado por padrão pra não poluir o console.
  detail?: string;
}

// Reduz uma mensagem de erro (potencialmente multi-linha, ex: stack trace de
// script) pra uma linha só, usada como resumo no console — o texto completo
// continua disponível no campo `detail`, expansível por entrada.
function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() || text.trim();
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

const COLLECTIONS_STORAGE_KEY = 'postman_clone_collections';


const CONTENT_TYPE_MAP = [
  { match: 'application/json',             ext: 'json', label: 'JSON',  binary: false },
  { match: 'text/html',                    ext: 'html', label: 'HTML',  binary: false },
  { match: 'text/xml',                     ext: 'xml',  label: 'XML',   binary: false },
  { match: 'application/xml',              ext: 'xml',  label: 'XML',   binary: false },
  { match: 'text/csv',                     ext: 'csv',  label: 'CSV',   binary: false },
  { match: 'text/plain',                   ext: 'txt',  label: 'Text',  binary: false },
  { match: 'application/zip',              ext: 'zip',  label: 'ZIP',   binary: true  },
  { match: 'application/x-zip',            ext: 'zip',  label: 'ZIP',   binary: true  },
  { match: 'application/x-zip-compressed', ext: 'zip',  label: 'ZIP',   binary: true  },
  { match: 'application/octet-stream',     ext: 'zip',  label: 'ZIP',   binary: true  },
  { match: 'application/pdf',              ext: 'pdf',  label: 'PDF',   binary: true  },
  { match: 'image/png',                    ext: 'png',  label: 'PNG',   binary: true  },
  { match: 'image/jpeg',                   ext: 'jpg',  label: 'JPEG',  binary: true  },
] as const;


async function getSslVerification(): Promise<boolean> {
  return await invoke('get_ssl_verification');
}

async function setSslVerification(value: boolean): Promise<void> {
  await invoke('set_ssl_verification', { value });
}

function replaceWithEnv(text: string, env: Record<string, string>): string {
  if (!text) return '';

  // Várias passadas — cobre variável cujo valor referencia OUTRA variável
  // (ex: {{baseUrl}} = "{{protocol}}://api.exemplo.com"), senão a segunda
  // camada ficava sem traduzir e vazava um "{{protocol}}" literal pra URL
  // final. Limite de passadas evita loop infinito em referência circular
  // (ex: varA = "{{varB}}" e varB = "{{varA}}").
  let result = text;
  const MAX_PASSES = 10;

  for (let i = 0; i < MAX_PASSES; i++) {
    let changed = false;

    result = result.replace(/\{\{(.*?)\}\}/g, (match, key) => {
      const trimmedKey = key.trim();
      if (!(trimmedKey in env)) return match;
      changed = true;
      return env[trimmedKey];
    });

    if (!changed) break;
  }

  return result;
}

function replaceUrlParams(url: string, params: QueryParam[]): string {
  if (!url) return '';
  return url.replace(/:([a-zA-Z0-9_]+)/g, (match, name) => {
    const found = params.find(p => p.key === name);
    return found ? found.value : match;
  });
}

// decodeURIComponent lança URIError em "% malformado" — mesmo fallback usado
// em ParamsTab.tsx.
function safeDecodeURIComponentPL(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Extrai a query string da URL pro array `queryParams` — mesma lógica do
// sync "URL -> QUERY PARAMS" do ParamsTab.tsx, mas usada aqui pra manter
// `queryParams` sempre em dia com a barra de URL principal, que fica
// montada o tempo todo (diferente do ParamsTab, que só existe enquanto a
// aba Params está selecionada). Sem isso, editar a URL com outra sub-aba
// aberta (Headers, Body...) deixava `queryParams` desatualizado, e como
// buildFinalUrl usa esse array como fonte de verdade pra montar a URL
// final, a query string inteira sumia ao copiar/enviar/gerar cURL.
function parseQueryParamsFromUrl(url: string): QueryParam[] {
  const queryString = url.split('?')[1];
  if (!queryString) return [];

  return queryString
    .split('&')
    .filter(Boolean)
    .map((item) => {
      const [rawKey = '', rawValue = ''] = item.split('=');
      return {
        id: crypto.randomUUID(),
        key: safeDecodeURIComponentPL(rawKey),
        value: safeDecodeURIComponentPL(rawValue),
        enabled: true,
      };
    });
}

// Se `queryParams` estiver vazio mas a URL já tiver query string, o array
// provavelmente está desatualizado (ex: aba salva/importada antes de existir
// o sync automático da URL principal — ver parseQueryParamsFromUrl acima),
// e não vazio de propósito. Usada nos pontos que só LEEM o estado pra montar
// a URL final (enviar, copiar, gerar cURL) — nunca em updateQueryParams,
// que reflete uma edição de verdade do usuário na aba Params (aí o array
// tem que mandar, mesmo que fique menor).
function getEffectiveQueryParams(urlInput: string, queryParams: QueryParam[]): QueryParam[] {
  if (queryParams.length > 0) return queryParams;
  return parseQueryParamsFromUrl(urlInput || '');
}

// O RequestBodySelector guarda o body de uma aba GraphQL como um único JSON
// serializado ({ query, variables }), com `variables` em formato de STRING
// bruta (pra preservar o que o usuário digitou). Aqui a gente extrai essas
// duas partes de volta a partir desse texto interno.
function extractGraphQLParts(raw: string): { query: string; variables: string } {
  if (!raw || !raw.trim()) return { query: '', variables: '{}' };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.query === 'string') {
      const variables =
        typeof parsed.variables === 'string'
          ? parsed.variables
          : parsed.variables !== undefined
          ? JSON.stringify(parsed.variables)
          : '{}';
      return { query: parsed.query, variables };
    }
  } catch {
    // não era JSON - cai no fallback abaixo
  }
  return { query: raw, variables: '{}' };
}

// Monta o payload real que vai na rede: resolve variáveis de ambiente na query
// e nas variables, parseia as variables pra um objeto JSON de verdade (o
// protocolo GraphQL-over-HTTP exige `variables` como objeto, não string) e
// serializa tudo em `{ query, variables }`. Lança erro se o JSON de variables
// for inválido, pra quem chama decidir como avisar o usuário.
function buildGraphQLRequestBody(raw: string, envMap: Record<string, string>): string {
  const { query, variables } = extractGraphQLParts(raw);
  const resolvedQuery = replaceWithEnv(query, envMap);
  const resolvedVariablesRaw = replaceWithEnv(variables, envMap).trim();

  let variablesObj: unknown = {};
  if (resolvedVariablesRaw) {
    try {
      variablesObj = JSON.parse(sanitizeJsonBodyForSend(resolvedVariablesRaw));
    } catch {
      throw new Error('GraphQL Variables contains invalid JSON.');
    }
  }

  return JSON.stringify({ query: resolvedQuery, variables: variablesObj });
}

function getFilenameFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return (segments.at(-1) || 'response').replace(/\.[^.]+$/, '');
  } catch { return 'response'; }
}

function detectContentType(headers: Record<string, string> = {}) {
  const ct = (headers['content-type'] || headers['Content-Type'] || '')
    .toLowerCase().split(';')[0].trim();
  return (
    CONTENT_TYPE_MAP.find(({ match }) => ct === match) ??
    CONTENT_TYPE_MAP.find(({ match }) => ct.includes(match))
  );
}

function getStatusText(code: number): string {
  const map: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
    404: 'Not Found', 500: 'Internal Server Error',
  };
  return map[code] || 'Unknown';
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function getResponseSize(response: ApiResponse): number {
  const headers = response.headers || {};
  const contentLength = (headers as any)['content-length'] ?? (headers as any)['Content-Length'];
  if (contentLength && !isNaN(Number(contentLength))) return Number(contentLength);
  const body = response.parsedBody;
  if (body == null) return 0;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new TextEncoder().encode(text).length;
}

function applyTabUpdatesToItem(item: CollectionItem, updates: Partial<Tab>): CollectionItem {
  const currentRequest = item.request ?? {
    url: '',
    urlexport: { host: [], path: [], raw: '', variable: [] },
    headers: [],
    body: '',
    auth: { type: 'none' } as AuthorizationDetails,
    scripts: { preRequest: '', postResponse: '' },
  };

  const nextRequest = { ...currentRequest };

  if (updates.urlInput !== undefined) {
    nextRequest.url = updates.urlInput;
    nextRequest.urlexport = { ...nextRequest.urlexport, raw: updates.urlInput };
  }
  if (updates.params !== undefined) {
    nextRequest.urlexport = { ...nextRequest.urlexport, variable: updates.params };
  }
  if (updates.requestHeadersValue !== undefined) {
    // Preserva o `enabled` de cada header — antes isso reconstruía o array
    // inteiro sempre com enabled:true (perdendo a informação de header
    // desabilitado) a partir de um Record<string,string> que já nem incluía
    // headers desabilitados pra começar (ver Tab.ts).
    nextRequest.headers = updates.requestHeadersValue.map((h) => ({
      key: h.key,
      value: h.value,
      enabled: h.enabled,
    }));
  }
  if (updates.requestBodyValue !== undefined) {
    nextRequest.body = updates.requestBodyValue;
  }
  if (updates.disabledDefaultHeaders !== undefined) {
    nextRequest.disabledDefaultHeaders = updates.disabledDefaultHeaders;
  }
  // gRPC: os dados ficam fora do `request` HTTP (ver CollectionItem.protocol).
  const grpcFields = updates.protocol === 'grpc' || item.protocol === 'grpc'
    ? {
        protocol: 'grpc' as const,
        ...(updates.grpc !== undefined ? { grpc: updates.grpc } : {}),
      }
    : {};
  if (updates.bodyType !== undefined) {
    nextRequest.bodyType = updates.bodyType;
  }
  if (updates.auth !== undefined) {
    nextRequest.auth = updates.auth;
  }
  if (updates.scripts !== undefined) {
    nextRequest.scripts = {
      preRequest: updates.scripts.preRequest ?? nextRequest.scripts?.preRequest ?? '',
      postResponse: updates.scripts.postResponse ?? nextRequest.scripts?.postResponse ?? '',
    };
  }

  // Abas de Saved Example gravam a resposta editada à mão (exampleDraft).
  // Antes o Save gravava ali a ÚLTIMA RESPOSTA recebida — um Send seguido de
  // Ctrl+S (até pra salvar outra edição) trocava a resposta documentada sem
  // aviso. Agora enviar acontece numa aba de Try separada, e atualizar o
  // example com uma resposta real é o botão explícito "Update example".
  const nextExample = item.type === 'example' && updates.exampleDraft
    ? updates.exampleDraft
    : item.example;

  return {
    ...item,
    ...(updates.name !== undefined ? { name: updates.name } : {}),
    ...(updates.method !== undefined
      ? { method: updates.method as CollectionItem['method'] }
      : {}),
    request: nextRequest,
    ...grpcFields,
    ...(item.type === 'example' ? { example: nextExample } : {}),
  };
}

function updateItemInTree(list: CollectionItem[], tabId: string, updates: Partial<Tab>): CollectionItem[] {
  return list.map(item => {
    if (item.id === tabId) return applyTabUpdatesToItem(item, updates);
    if (item.item) return { ...item, item: updateItemInTree(item.item, tabId, updates) };
    return item;
  });
}

// Converte uma aba (Tab) aberta num request salvo de collection — usado pelo
// "Convert to Flow" (Tab Group -> pasta na árvore, ver handlePickFlowFolder).
// Reaproveita applyTabUpdatesToItem (mesma função usada em todo autosave de
// aba) pra não duplicar a lógica de conversão url/headers/auth/body.
function createRequestItemFromTab(tab: Tab): CollectionItem {
  const skeleton: CollectionItem = {
    id: crypto.randomUUID(),
    name: tab.name || 'Untitled Request',
    type: 'request',
    method: (tab.method as CollectionItem['method']) || 'GET',
  };
  return applyTabUpdatesToItem(skeleton, {
    urlInput: tab.urlInput,
    params: tab.params,
    requestHeadersValue: tab.requestHeadersValue,
    disabledDefaultHeaders: tab.disabledDefaultHeaders,
    requestBodyValue: tab.requestBodyValue,
    bodyType: tab.bodyType,
    auth: tab.auth,
    scripts: tab.scripts,
    ...(tab.protocol === 'grpc' ? { protocol: 'grpc' as const, grpc: tab.grpc } : {}),
  });
}

async function saveResponseToFile(response: ApiResponse, urlInput: string) {
  const disposition = response.headers?.['content-disposition'] || response.headers?.['Content-Disposition'] || '';
  const filenameMatch = disposition.match(/filename[^;=\n]*=(['"]?)([^\n"';]+)\1/);
  const dispositionFilename = filenameMatch?.[2]?.trim();
  const dispositionExt = dispositionFilename?.split('.').pop()?.toLowerCase();
  const detected  = detectContentType(response.headers);
  const isZipByName = dispositionExt === 'zip';
  const isBinary  = isZipByName || (detected !== undefined ? detected.binary : (response.isBinary ?? false));
  const ext       = dispositionExt ?? detected?.ext ?? (isBinary ? 'zip' : 'txt');
  const label     = detected?.label ?? 'File';

  const { save }                     = await import('@tauri-apps/plugin-dialog');
  const { writeFile, writeTextFile } = await import('@tauri-apps/plugin-fs');

  const defaultName = dispositionFilename ?? `${getFilenameFromUrl(urlInput)}.${ext}`;
  const filePath = await save({
    title: 'Save response',
    defaultPath: defaultName,
    filters: [{ name: label, extensions: [ext] }, { name: 'All files', extensions: ['*'] }],
  });

  if (!filePath) return;

  if (isBinary) {
    const rawBody = response.parsedBody;
    let bytes: Uint8Array;
    if (typeof rawBody === 'string') {
      const binStr = atob(rawBody);
      bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    } else if (Array.isArray(rawBody)) {
      bytes = new Uint8Array(rawBody);
    } else { return; }
    await writeFile(filePath, bytes);
  } else {
    const body    = response.parsedBody;
    const content = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    await writeTextFile(filePath, content);
  }
}

interface ImportToastProps {
  result: ImportResult;
  onClose: () => void;
  duration?: number; // Tempo de exibição em ms (Padrão: 5000ms)
}

function ResponseTimer({
  isRequesting,
  startTime,
  finalTime,
}: {
  isRequesting: boolean;
  startTime: number | null;
  finalTime: number;
}) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!isRequesting || !startTime) return;
    const id = setInterval(() => forceTick(t => t + 1), 50);
    return () => clearInterval(id);
  }, [isRequesting, startTime]);

  const displayMs = isRequesting && startTime ? Date.now() - startTime : finalTime;

  return (
    <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-pm-hover/50 border border-pm-border text-[11px] font-semibold tabular-nums">
      <Clock size={11} className={isRequesting ? 'text-pm-accent animate-pulse' : 'text-pm-text-muted'} />
      <span className={isRequesting ? 'text-pm-accent' : 'text-pm-text-secondary'}>
        {formatDuration(displayMs)}
      </span>
    </span>
  );
}

export function ImportToast({ result, onClose, duration = 5000 }: ImportToastProps) {
  const hasCollections = Boolean(result.collections && result.collections.length > 0);
  const hasEnvironments = Boolean(result.environments && result.environments.length > 0);
  const hasError = !result.collections && !result.environments;
  const hasWarnings = result.warnings.length > 0;

  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(100);

  // Timer para autoclose e barra de progresso sincronizada
  useEffect(() => {
    if (isPaused) return;

    const intervalTime = 50;
    const step = (intervalTime / duration) * 100;

    const timer = setInterval(() => {
      setProgress((prev) => {
        if (prev <= 0) {
          clearInterval(timer);
          onClose();
          return 0;
        }
        return prev - step;
      });
    }, intervalTime);

    return () => clearInterval(timer);
  }, [isPaused, duration, onClose]);

  return (
    <div
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      className={`
        fixed bottom-5 right-5 z-[9999] w-84 rounded-xl border backdrop-blur-md
        shadow-2xl shadow-black/70 overflow-hidden text-pm-text
        animate-in slide-in-from-bottom-3 fade-in duration-200
        ${
          hasError
            ? 'bg-[#1a0f0f]/95 border-red-500/30'
            : 'bg-[#0f1a12]/95 border-emerald-500/30'
        }
      `}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-pm-border bg-pm-hover/40">
        <div className="flex items-center gap-2">
          {hasError ? (
            <XCircle className="w-4 h-4 text-red-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          <span className="text-[12px] font-semibold tracking-wide text-pm-text">
            {hasError ? 'Import error' : 'Import complete'}
          </span>
        </div>

        <button
          onClick={onClose}
          className="p-1 rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
          aria-label="Close notification"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="p-3.5 flex flex-col gap-3">
        <p className="text-[12px] text-pm-text-secondary leading-relaxed font-normal">
          {result.summary}
        </p>

        {/* Métricas de Coleções / Ambientes */}
        {(hasCollections || hasEnvironments) && (
          <div className="flex items-center gap-2">
            {hasCollections && (
              <div className="flex-1 flex items-center gap-2 bg-pm-hover border border-pm-border rounded-lg px-2.5 py-1.5">
                <Folder className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <div className="flex flex-col">
                  <span className="text-[11px] font-bold text-pm-text leading-none tabular-nums">
                    {result.collections!.length}
                  </span>
                  <span className="text-[9px] text-pm-text-muted font-medium mt-0.5">
                    {result.collections!.length === 1 ? 'collection' : 'collections'}
                  </span>
                </div>
              </div>
            )}

            {hasEnvironments && (
              <div className="flex-1 flex items-center gap-2 bg-pm-hover border border-pm-border rounded-lg px-2.5 py-1.5">
                <Globe className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <div className="flex flex-col">
                  <span className="text-[11px] font-bold text-pm-text leading-none tabular-nums">
                    {result.environments!.length}
                  </span>
                  <span className="text-[9px] text-pm-text-muted font-medium mt-0.5">
                    {result.environments!.length === 1 ? 'environment' : 'environments'}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Lista de Alertas / Warnings */}
        {hasWarnings && (
          <div className="flex flex-col gap-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5 max-h-32 overflow-y-auto">
            {result.warnings.map((warning, index) => (
              <div key={index} className="flex items-start gap-2 text-[11px] text-amber-300/90">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <span className="leading-snug">{warning}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dynamic Progress Bar */}
      <div className="h-[2px] bg-pm-border w-full overflow-hidden">
        <div
          className={`h-full transition-all ease-linear ${
            hasError ? 'bg-red-500' : 'bg-emerald-500'
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );

}

// Monta um Tab novo a partir de um CollectionItem (request ou Saved Example).
// Função pura (sem estado do componente), então pode ser chamada em lote
// sem se preocupar com closures desatualizadas.
function buildTabFromItem(item: CollectionItem): Tab {
  const isExample = item.type === 'example';

  // Mantém TODOS os headers (inclusive os desabilitados) — antes isso
  // filtrava pra um Record<string,string> só com os habilitados, então um
  // header desmarcado "sumia" pra sempre assim que a aba reabria (ver
  // Tab.ts). item.request.headers não tem "id" próprio (schema Postman),
  // então geramos um aqui, na origem.
  const rawHeaders = item.request?.headers || [];
  const normalizedHdr: QueryParam[] = rawHeaders.map(h => ({
    id: crypto.randomUUID(),
    key: h.key,
    value: h.value,
    enabled: h.enabled !== false,
  }));
  // Collections exportadas pelo Postman trazem urlexport.variable sem "id"
  // (ex: {key, value}). Sem id único, editar UM path variable acabava
  // atualizando TODOS ao mesmo tempo (a lógica de update casava por id,
  // e todos batiam em "undefined"). Garantimos um id único aqui na origem.
  const normalizedPathParams = (item.request?.urlexport?.variable || []).map((v: any) => ({
    id: v?.id || crypto.randomUUID(),
    key: v?.key || '',
    value: v?.value || '',
    enabled: v?.enabled !== false,
  }));

  // Saved Example: mesmo RequestEditor de uma request; a resposta salva vai
  // pro exampleDraft (editável no ExampleResponseEditor), não pro painel de
  // resposta normal.
  const exampleDraft = isExample ? toExampleDraft(item.example) : undefined;

  return {
    id:                  item.id,
    name:                item.name,
    method:              item.method || 'GET',
    urlInput:            item.request?.urlexport?.raw || '',
    params:              normalizedPathParams,
    queryParams:         [],
    requestHeadersValue: normalizedHdr,
    disabledDefaultHeaders: item.request?.disabledDefaultHeaders ?? [],
    requestBodyValue:    item.request?.body || '',
    bodyType:            item.request?.bodyType ?? (item.request?.body ? 'raw' : 'none'),
    // Preserva TODOS os campos de auth (username/password de Basic, key/value
    // de API Key, etc) — antes só copiava type/token/oauth2, o que apagava
    // Basic Auth e API Key silenciosamente no próximo autosave da tab (ver
    // applyTabUpdatesToItem, que grava `tab.auth` inteiro de volta no item).
    auth: {
      ...(item.request?.auth ?? {}),
      type: normalizeAuthType(item.request?.auth?.type),
    } as AuthorizationDetails,
    scripts:      item.request?.scripts || { preRequest: '', postResponse: '' },
    response:     null,
    responseTime: 0,
    kind:         isExample ? 'example' : 'request',
    ...(exampleDraft ? { exampleDraft } : {}),
    ...(item.protocol === 'grpc'
      ? {
          protocol: 'grpc' as const,
          // Cópia: editar a aba não pode mexer no item salvo antes do Save.
          grpc: item.grpc
            ? { ...item.grpc, metadata: (item.grpc.metadata ?? []).map(m => ({ ...m })) }
            : undefined,
          grpcResult: null,
        }
      : {}),
  };
}

// Cópia editável da resposta de um example (com defaults pra examples
// antigos/incompletos).
function toExampleDraft(example: ExampleData | undefined): ExampleData {
  return {
    status: example?.status ?? 'OK',
    code: example?.code ?? 200,
    headers: (example?.headers ?? []).map(h => ({ ...h })),
    body: example?.body ?? '',
    previewLanguage: normalizeExampleLanguage(example?.previewLanguage, example?.headers, example?.body),
  };
}

// Resposta recebida → formato de example (Save as example / Update example).
function exampleFromResponse(response: ApiResponse, previewLanguage?: string): ExampleData {
  const parsedBody = response.parsedBody;
  const body = response.isBinary
    ? ''
    : parsedBody == null
      ? ''
      : typeof parsedBody === 'string'
        ? parsedBody
        : JSON.stringify(parsedBody, null, 2);
  return {
    status: STATUS_TEXT[response.status] ?? getStatusText(response.status),
    code: response.status,
    headers: Object.entries(response.headers ?? {}).map(([key, value]) => ({ key, value: String(value), enabled: true })),
    body,
    previewLanguage: normalizeExampleLanguage(
      previewLanguage,
      Object.entries(response.headers ?? {}).map(([key, value]) => ({ key, value: String(value) })),
      body
    ),
  };
}

// Igual buildTabFromItem, mas primeiro checa se existe um rascunho local
// (edição não salva de uma aba fechada silenciosamente — ver
// tabDraftsStore.ts). Se existir, restaura o rascunho (ainda dirty) em vez
// de montar a aba "limpa" a partir do item salvo na collection — o usuário
// decide, agora que reabriu o request, se quer salvar ou descartar.
function buildTabFromItemOrDraft(item: CollectionItem): Tab {
  const draft = getTabDraft(item.id);
  if (draft) {
    removeTabDraft(item.id);
    return draft;
  }
  return buildTabFromItem(item);
}

export default function AppLayout() {
  const { activeEnv, environments, setEnvironments, markEnvironmentSynced, selectedEnvId, setSelectedEnvId } = useEnvironment();
  const { effectiveThemeId } = useTheme();
  const monacoTheme = getMonacoThemeName(effectiveThemeId);
  const handleMonacoBeforeMount = useCallback((monaco: Monaco) => {
    registerDevflowMonacoThemes(monaco);
  }, []);
  const [importOpen, setImportOpen] = useState(false);
  const [hydrated,           setHydrated]           = useState(false);
  const [collections,        setCollections]        = useState<CollectionItem[]>([]);
  // Catalogo de marcadores do workspace (ver lib/markers.ts). Vive aqui, e
  // nao dentro da arvore, porque vale pra TODAS as collections do workspace.
  const [markers, setMarkers] = useState<Marker[]>([]);

  // Grava junto com o estado: o catalogo e pequeno (dezenas de entradas) e
  // perde-lo e pior que reescreve-lo — um marcador criado e aplicado a 200
  // nos deixaria a arvore apontando pra um id que nao existe mais.
  const handleMarkersChange = useCallback((next: Marker[]) => {
    setMarkers(next);
    void saveWorkspaceMarkers(selectedWorkspaceRef.current, next);
  }, []);

  /**
   * Catálogo que veio do repositório, aplicado sobre o local.
   *
   * União, nunca substituição (ver mergeCatalogs): duas pessoas criando
   * marcadores em paralelo é o caso normal, e quem puxa não pode perder os
   * seus só porque ainda não deu push. Quando as duas criaram o MESMO nome
   * em máquinas diferentes, os ids divergem — o merge colapsa no id do time
   * e o remap reescreve a árvore local pra apontar pra ele, senão a marca
   * local continuaria num id que mais ninguém tem.
   */
  const handlePullMarkers = useCallback(async (
    workspaceName: string,
    remoteMarkers: Marker[]
  ) => {
    const { collections: storedCollections } = await loadWorkspaceLocalData(workspaceName);
    const localCatalog = (await loadWorkspaceMarkers(workspaceName)) as Marker[];

    const { catalog, remapped } = mergeCatalogs(localCatalog, remoteMarkers);
    await saveWorkspaceMarkers(workspaceName, catalog);

    // O pull acabou de gravar as collections; aqui elas são relidas e
    // reescritas só se o remap tiver algo a fazer — não há caminho mais
    // curto porque o merge do catálogo só é conhecido agora.
    const tree = Array.isArray(storedCollections) ? (storedCollections as CollectionItem[]) : [];
    const remappedTree = remapMarkers(tree, remapped);
    // purgeOrphans depois do remap, nunca antes: um id que o remap ia
    // converter seria apagado como "órfão" por não estar no catálogo ainda.
    const cleaned = purgeOrphans(remappedTree, catalog);
    if (cleaned !== tree) await saveWorkspaceCollections(workspaceName, cleaned);

    if (selectedWorkspaceRef.current === workspaceName) {
      setMarkers(catalog);
      if (cleaned !== tree) {
        suppressPendingMarkRef.current = true;
        setCollections(cleaned);
      }
    }
  }, []);
  const [tabs,               setTabs]               = useState<Tab[]>([]);
  const [activeTabId,        setActiveTabId]        = useState<string | null>(null);
  const [responseTab, setResponseTab] = useState<'body' | 'headers' | 'tests'>('body')
  const [runnerItem, setRunnerItem] = useState<CollectionItem | null>(null);
  const [loadTestItem, setLoadTestItem] = useState<CollectionItem | null>(null);
  const [consoleOpen,        setConsoleOpen]        = useState(false);

  // Relógio no rodapé — atualiza a cada segundo. Começa null (não `new
  // Date()`) pra evitar mismatch de hidratação SSR/CSR do Next; só passa a
  // renderizar depois do primeiro effect, já rodando no cliente.
  // Zoom da janela: Ctrl + roda do mouse, Ctrl + '+/-' e Ctrl+0 pra voltar.
  const { zoom, setZoom } = useAppZoom();

  // Existe coisa salva localmente que ainda não foi pro GitHub? (ver
  // pendingPushStore — Save é local, push é explícito.)
  // Qual collection/environment está esperando push, não só "existe algo".
  // É o que o push seletivo vai consultar pra saber o que enviar.
  const [pendingPush, setPendingPush] = useState<PendingPush>(EMPTY_PENDING);
  const hasPendingPush = !isPendingEmpty(pendingPush);
  const pendingCollectionIds = useMemo(
    () => new Set(pendingPush.collections),
    [pendingPush]
  );

  // Diff atual entre o local e o GitHub, para a tela de revisão.
  const [tabGroups, setTabGroups] = useState<TabGroup[]>([]);
  const tabGroupsLoadedRef = useRef(false);
  const pullingCollectionRef = useRef(false);
  // Alvos pendentes de confirmação do "salvar em todas com o mesmo nome".
  const [saveAllTargets, setSaveAllTargets] = useState<NamedMatch[] | null>(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  // Fechar a última aba de um grupo tem que apagar o grupo. Derivado, e não
  // corrigido por setState num efeito: um grupo sem aba já não aparece na
  // barra (os segmentos saem das abas), então basta nunca gravá-lo nem
  // oferecê-lo no menu "Add to group".
  const liveTabGroups = useMemo(
    () => pruneEmptyGroups(tabs, tabGroups),
    [tabs, tabGroups]
  );

  /**
   * Collection que deve ser enviada assim que a mescla for aplicada.
   *
   * Preenchida quando o push esbarra em conflito: a tela de comparação abre
   * para resolver, e o envio continua de onde parou em vez de obrigar a
   * clicar em "Push to GitHub" outra vez.
   */
  const [pushAfterDiff, setPushAfterDiff] = useState<CollectionItem | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffNodes, setDiffNodes] = useState<DiffNode[]>([]);
  const [diffNames, setDiffNames] = useState<Map<string, string>>(new Map());
  // Remoto já convertido em árvore — a aplicação precisa dele, não do cru.
  const [diffRemoteTree, setDiffRemoteTree] = useState<CollectionItem[]>([]);
  const [diffRemoteEnvs, setDiffRemoteEnvs] = useState<Environment[]>([]);
  // Qual lado a janela está comparando — a aplicação é diferente pra cada um.
  const [diffTarget, setDiffTarget] = useState<'collections' | 'environments'>('collections');
  // Base da última sincronização, para separar quem mexeu no quê.
  const [diffBase, setDiffBase] = useState<NodeHashes | null>(null);

  // Estado da árvore na última vez em que o pendente foi calculado. Comparar
  // contra isto é o que diz QUAIS collections mudaram — ver
  // lib/collectionFingerprint.
  const rootPrintsRef = useRef<RootFingerprints>(new Map());
  const envPrintsRef = useRef<Map<string, string>>(new Map());
  // Marcado antes de um setCollections vindo de Pull, pra que o efeito que
  // persiste collections não interprete aquilo como alteração local.
  const suppressPendingMarkRef = useRef(false);
  const suppressEnvPendingMarkRef = useRef(false);

  // "Fixar janela sobre as outras" (always on top) — botão no title bar,
  // ao lado do de Settings.
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const handleToggleAlwaysOnTop = useCallback(() => {
    setAlwaysOnTop(prev => {
      const next = !prev;
      getCurrentWindow().setAlwaysOnTop(next).catch(err => console.error('Erro ao fixar janela:', err));
      return next;
    });
  }, []);

  const CONSOLE_HEIGHT_STORAGE_KEY = 'postman_clone_console_height';
  const [consoleHeight,      setConsoleHeight]      = useState(220);
  const isResizingConsole   = useRef(false);
  const [logs,               setLogs]               = useState<ConsoleLogEntry[]>([]);
  const [consoleFilter,      setConsoleFilter]      = useState<'all' | ConsoleLogLevel>('all');
  const [consoleSearch,      setConsoleSearch]      = useState('');
  const consoleLogListRef = useRef<HTMLDivElement>(null);
  const [copiedLogId, setCopiedLogId] = useState<string | null>(null);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set());
  const toggleLogExpanded = useCallback((id: string) => {
    setExpandedLogIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const pushLog = useCallback((
    level: ConsoleLogLevel,
    message: string,
    extra?: { requestName?: string; source?: ConsoleLogSource; status?: number; detail?: string }
  ) => {
    setLogs(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      level,
      message,
      timestamp: Date.now(),
      ...extra,
    }]);
  }, []);

  
  
  //const [timer,              setTimer]              = useState(0);
  //const [isRequesting,       setIsRequesting]       = useState(false);
  const [isCurlModalOpen,    setIsCurlModalOpen]    = useState(false);
  const [isSendDropdownOpen, setIsSendDropdownOpen] = useState(false);
  const [importToast,        setImportToast]        = useState<ImportResult | null>(null);
  const [envVersion, setEnvVersion] = useState(0);
  //const abortControllerRef = useRef<AbortController | null>(null);
  const sendDropdownRef    = useRef<HTMLDivElement>(null);
  const githubSyncRef = useRef<GitHubSyncHandle>(null);
  const tabsHydrated       = useRef(false);
  const requestGroupRef    = useGroupRef();
  const sidebarGroupRef    = useGroupRef();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { importData } = usePostmanImport();
  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  // Estado do botão de colapsar/expandir o JSON do body da response — só
  // controla o ícone/tooltip do botão, quem faz o fold/unfold de verdade é
  // o próprio Monaco (foldAll/unfoldAll) via responseEditorInstanceRef.
  const [isResponseBodyCollapsed, setIsResponseBodyCollapsed] = useState(false);

  // Histórico local das últimas 5 respostas desta request (localStorage,
  // ver src/storage/responseHistoryStore.ts) — recarrega quando troca de
  // aba ou quando o combobox é aberto.
  const [responseHistory, setResponseHistory] = useState<ResponseHistoryEntry[]>([]);
  useEffect(() => {
    setResponseHistory(activeTabId ? getResponseHistory(activeTabId) : []);
  }, [activeTabId]);
  const refreshResponseHistory = useCallback(() => {
    if (activeTabId) setResponseHistory(getResponseHistory(activeTabId));
  }, [activeTabId]);
  const handleCopyUrl = useCallback(async () => {
    if (!activeTab?.urlInput) return;
    // Copia a URL já resolvida — mesma lógica usada pra montar a URL final
    // do request de verdade (buildSnippetRequest usa o mesmo combo) — em vez de
    // colar {{placeholders}} sem sentido fora do app.
    const envMap = buildEnvMap(activeEnv?.values);
    const effectiveQueryParams = getEffectiveQueryParams(activeTab.urlInput || '', activeTab.queryParams || []);
    const resolvedUrl = buildFinalUrl(activeTab.urlInput || '', activeTab.params || [], effectiveQueryParams);
    const finalUrl = replaceWithEnv(replaceUrlParams(resolvedUrl, activeTab.params || []), envMap);
    try {
      await navigator.clipboard.writeText(finalUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 1500);
    } catch (err) {
      console.error('Failed to copy URL:', err);
    }
  }, [activeTab?.urlInput, activeTab?.params, activeTab?.queryParams, activeEnv]);
  //const [requestError, setRequestError] = useState<string | null>(null);
  //const [aiDebugResult, setAiDebugResult] = useState<string | null>(null);
  //const [isDebugging, setIsDebugging] = useState(false);
  const PANEL_SIZES_STORAGE_KEY = 'postman_clone_panel_sizes';
  const [panelSizes, setPanelSizes] = useState<Record<string, number>>({});
  const RESPONSE_LAYOUT_STORAGE_KEY = 'postman_clone_response_layout';
  const [responseLayout, setResponseLayout] = useState<'bottom' | 'side'>('bottom');
  const [tabSessions, setTabSessions] = useState<TabSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // Tab Group -> Flow: enquanto não-null, a sidebar entra em "modo escolher
  // pasta" — a próxima pasta clicada na árvore vira o destino onde criamos
  // a nova pasta com os requests desse grupo (ver handlePickFlowFolder).
  const [flowPickerSession, setFlowPickerSession] = useState<TabSession | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const selectedWorkspaceRef = useRef(selectedWorkspace); 
  const [isToolsMenuOpen, setIsToolsMenuOpen] = useState(false);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  // Mesma razão do tabsRef: os callbacks de sync têm deps vazias e leriam
  // uma árvore congelada na primeira renderização.
  const collectionsRef = useRef<CollectionItem[]>(collections);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  const selectedEnvIdRef = useRef<string | null>(selectedEnvId);
  const isSwitchingWorkspaceRef = useRef(false);
  const responseEditorInstanceRef = useRef<any>(null);

  // ── Undo/Redo (Ctrl+Z / Ctrl+Shift+Z) por aba ──────────────────────────
  // Guarda snapshots dos campos "editáveis" de cada request (não guarda
  // response/testResults/isDirty). Edições consecutivas no mesmo campo
  // dentro de UNDO_COALESCE_MS são agrupadas num único passo de undo,
  // igual a um editor de texto comum.
  const UNDO_COALESCE_MS = 700;
  const undoStackRef = useRef<Map<string, TabSnapshot[]>>(new Map());
  const redoStackRef = useRef<Map<string, TabSnapshot[]>>(new Map());
  const lastHistoryPushRef = useRef<Map<string, { key: string; time: number }>>(new Map());

const defaultRequestState: TabRequestState = {
  isRequesting: false, startTime: null, error: null, isDebugging: false, debugResult: null,
};
const [tabRequestStates, setTabRequestStates] = useState<Record<string, TabRequestState>>({});
const abortControllersRef = useRef<Record<string, AbortController>>({});
// Id do make_http_request em andamento por aba — o que o Cancel manda pro Rust.
const httpRequestIdsRef = useRef<Record<string, string>>({});
const timerIntervalsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

const patchTabRequestState = useCallback((tabId: string, patch: Partial<TabRequestState>) => {
  setTabRequestStates(prev => ({
    ...prev,
    [tabId]: { ...defaultRequestState, ...prev[tabId], ...patch },
  }));
}, []);

// Cancela de verdade o envio em andamento da aba: marca o controller (pro
// resultado que ainda chegar ser descartado) e manda o Rust interromper a
// request, fechando a conexão (ver cancel_http_request em lib.rs).
const cancelHttpForTab = (tabId: string) => {
  abortControllersRef.current[tabId]?.abort();
  const requestId = httpRequestIdsRef.current[tabId];
  if (requestId) {
    delete httpRequestIdsRef.current[tabId];
    invoke('cancel_http_request', { requestId }).catch(() => {});
  }
};

const cleanupTabRequestState = useCallback((tabId: string) => {
  cancelHttpForTab(tabId);
  delete abortControllersRef.current[tabId];

  setTabRequestStates(prev => {
    if (!(tabId in prev)) return prev;
    const { [tabId]: _, ...rest } = prev;
    return rest;
  });
}, []);

const cleanupTabRequestStates = useCallback((tabIds: string[]) => {
  tabIds.forEach(cleanupTabRequestState);
}, [cleanupTabRequestState]);

const activeRequestState = activeTabId ? (tabRequestStates[activeTabId] ?? defaultRequestState) : defaultRequestState;
const isRequesting  = activeRequestState.isRequesting;
const startTime     = activeRequestState.startTime;
const requestError  = activeRequestState.error;
const isDebugging   = activeRequestState.isDebugging;
const aiDebugResult = activeRequestState.debugResult;



  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { collectionsRef.current = collections; }, [collections]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  useEffect(() => { selectedEnvIdRef.current = selectedEnvId; }, [selectedEnvId]);


// Fecha o dropdown se clicar fora dele
useEffect(() => {
  const handleClickOutside = (event: MouseEvent) => {
    if (toolsMenuRef.current && !toolsMenuRef.current.contains(event.target as Node)) {
      setIsToolsMenuOpen(false);
    }
  };
  document.addEventListener('mousedown', handleClickOutside);
  return () => document.removeEventListener('mousedown', handleClickOutside);
}, []);




const handleSaveEnvironmentToGitHub = useCallback(async (env: Environment) => {
  if (!githubSyncRef.current) return;
  try {
    await githubSyncRef.current.pushEnvironment(env);
  } catch (e) {
    // Sem senha de sync: o GitHubSync já avisou (toast com "Open settings").
    // Não é erro do app — não repassa pro console.error de quem chamou.
    if (e instanceof MissingPassphraseError) return;
    throw e;
  }
  markEnvironmentSynced(env.id);
}, [markEnvironmentSynced]);

  useEffect(() => {
  const handleGlobalCopy = async (e: ClipboardEvent) => {
    // Monaco preenche e.clipboardData quando disponível; senão cai pra seleção normal
    const fromClipboardEvent = e.clipboardData?.getData('text/plain');
    const fromSelection = document.getSelection()?.toString();
    const text = fromClipboardEvent || fromSelection;

    if (!text) return;

    try {
      await writeText(text);
    } catch (err) {
      console.log('Falha ao espelhar cópia na API nativa do Tauri:', err);
    }
  };

  document.addEventListener('copy', handleGlobalCopy);
  return () => document.removeEventListener('copy', handleGlobalCopy);
}, []);


  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let isMounted = true;

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const u = await listen<string>('script-log', (event) => {
        if (isMounted) {
          try {
            const parsed = JSON.parse(event.payload) as { level?: string; message?: string };
            const level: ConsoleLogLevel = (['log', 'info', 'warn', 'error'] as const).includes(parsed.level as ConsoleLogLevel)
              ? (parsed.level as ConsoleLogLevel)
              : 'log';
            pushLog(level, parsed.message ?? event.payload, { source: 'script' });
          } catch {
            // Antes um payload não-JSON caía aqui (era o texto bruto da
            // exceção de script, emitido em paralelo ao retorno normal do
            // invoke) e virava um log duplicado com nível errado ('log' em
            // vez de 'error'). O backend não emite mais esse evento nesse
            // caso (ver execute_script_backend em lib.rs) — o erro chega só
            // uma vez, já como 'error', via o retorno do invoke abaixo.
            pushLog('warn', event.payload, { source: 'script' });
          }
        }
      });

      if (!isMounted) {
        u();
      } else {
        unlisten = u;
      }
    })();

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [pushLog]);


useEffect(() => {
  let cancelled = false;

  (async () => {
    try {
      const storedPanelSizes    = localStorage.getItem(PANEL_SIZES_STORAGE_KEY);
      const storedConsoleHeight = localStorage.getItem(CONSOLE_HEIGHT_STORAGE_KEY);

      if (storedPanelSizes)    setPanelSizes(JSON.parse(storedPanelSizes));
      if (storedConsoleHeight) setConsoleHeight(Number(storedConsoleHeight));

      let initialWorkspace = await getSelectedWorkspace();

      // ✅ Se nenhum workspace foi selecionado ainda, mas já existem
      //    workspaces salvos, cai no primeiro da lista em vez de
      //    carregar o bucket vazio ("").
      if (!initialWorkspace) {
        const existing = await listWorkspaces();
        if (existing.length > 0) {
          initialWorkspace = existing[0].path;
          await persistSelectedWorkspace(initialWorkspace);
        }
      }
  const [loadedTabs, loadedActiveId, loadedSessions, loadedSessionId, localData, loadedMarkers] = await Promise.all([
        loadTabs(initialWorkspace),
        loadActiveTabId(initialWorkspace),
        loadTabSessions(),
        loadCurrentSessionId(),
        loadWorkspaceLocalData(initialWorkspace),
        loadWorkspaceMarkers(initialWorkspace),
      ]);

      if (cancelled) return;

      selectedWorkspaceRef.current = initialWorkspace;
      setSelectedWorkspace(initialWorkspace);
      setTabs(loadedTabs);
      setActiveTabId(loadedActiveId);
      setTabSessions(loadedSessions);
      setCurrentSessionId(loadedSessionId);
      setCollections(backfillExampleRequests(localData.collections));
      setEnvironments(localData.environments);
      setMarkers(loadedMarkers as Marker[]);
    } catch (err) {
      // Dados corrompidos do workspace inicial não podem impedir o app de
      // abrir — segue com o estado vazio (o usuário ainda consegue trocar
      // pra outro workspace pelo seletor) em vez de travar na tela de carregamento.
      console.error('Hydration error:', err);
      if (!cancelled) toast.error('Não foi possível carregar o workspace salvo. Selecione outro no menu de workspaces.');
    } finally {
      if (!cancelled) {
        tabsHydrated.current = true;
        setHydrated(true);
      }
    }
  })();

  return () => { cancelled = true; };
}, []);

  // Faxina da cota, uma vez por abertura.
  //
  // O localStorage é ~5 MiB para o app INTEIRO, e quem o enchia não era
  // quem quebrava: o histórico de respostas chegou a 2,2 MB em 257 chaves
  // engolindo a cota em silêncio, e o erro aparecia na gravação seguinte —
  // o tamanho dos painéis. Some a isso ~577 KB de chaves que nada mais lê,
  // restos de quando o histórico de runs vivia aqui.
  //
  // Na partida porque é o único momento sem nada pendente: nenhuma janela
  // de resposta destacada a meio caminho, nenhum run em andamento.
  useEffect(() => {
    const swept = sweepDeadKeys();
    const dropped = enforceHistoryBudget();
    if (swept.removed || dropped) {
      console.log(
        `Storage cleanup: ${swept.removed} dead key(s), ${Math.round(swept.freedBytes / 1024)} KB freed; ` +
          `${dropped} request histor${dropped === 1 ? "y" : "ies"} evicted`
      );
    }
  }, []);

  // safeSetItem, e não setItem: estas são preferências de layout, gravadas a
  // cada arrastada de divisória. Com a cota cheia, o setItem cru jogava um
  // QuotaExceededError pra fora do efeito e derrubava a janela inteira —
  // crash por causa da largura de um painel.
  useEffect(() => {
    if (!tabsHydrated.current) return;
    safeSetItem(PANEL_SIZES_STORAGE_KEY, JSON.stringify(panelSizes));
  }, [panelSizes]);

  useEffect(() => {
    if (!tabsHydrated.current) return;
    safeSetItem(RESPONSE_LAYOUT_STORAGE_KEY, responseLayout);
  }, [responseLayout]);

  useEffect(() => {
    if (!tabsHydrated.current) return;
    safeSetItem(CONSOLE_HEIGHT_STORAGE_KEY, String(consoleHeight));
  }, [consoleHeight]);

  const handleConsoleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingConsole.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingConsole.current) return;
      // altura = distância do rodapé (status bar tem 24px, h-6) até o cursor
      const newHeight = window.innerHeight - moveEvent.clientY - 24;
      const clamped = Math.min(Math.max(newHeight, 100), window.innerHeight - 200);
      setConsoleHeight(clamped);
    };

    const handleMouseUp = () => {
      isResizingConsole.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);


// DEPOIS
useEffect(() => {
  if (!tabsHydrated.current) return;
  saveTabSessions(tabSessions).catch(err => console.error('Erro ao salvar sessões:', err));
}, [tabSessions]);

useEffect(() => {
  if (!tabsHydrated.current) return;
  saveCurrentSessionId(currentSessionId).catch(err => console.error('Erro ao salvar sessão atual:', err));
}, [currentSessionId]);

// DEPOIS — substitua pelo bloco abaixo (mantém getRequestPanelSize igual, troca só o resize handler)
const getRequestPanelSize = useCallback((tabId: string | null): number => {
  if (tabId && panelSizes[tabId] != null) return panelSizes[tabId];
  return 50;
}, [panelSizes]);

// Aplica o tamanho salvo da tab de forma imperativa, sem remontar o Group
useEffect(() => {
  if (!activeTabId) return;
  const size = getRequestPanelSize(activeTabId);
  requestGroupRef.current?.setLayout({
    'request-panel': size,
    'response-panel': 100 - size,
  });
}, [activeTabId, getRequestPanelSize]);

// Só grava no estado quando o layout muda (usuário soltou o handle)
const handleRequestLayoutChanged = useCallback(
  (layout: import('react-resizable-panels').Layout) => {
    if (!activeTabId) return;
    const requestSize = layout['request-panel'];
    if (requestSize == null) return;
    const rounded = Math.round(requestSize);
    setPanelSizes(prev => (prev[activeTabId] === rounded ? prev : { ...prev, [activeTabId]: rounded }));
  },
  [activeTabId]
);


const handleWorkspaceChange = useCallback(async (newWorkspace: string) => {
  if (newWorkspace === selectedWorkspaceRef.current) return;

  isSwitchingWorkspaceRef.current = true;
  try {
    const previousWorkspace = selectedWorkspaceRef.current;

    if (tabsHydrated.current) {
      await saveTabs(previousWorkspace, tabsRef.current);              // ✅
      await saveActiveTabId(previousWorkspace, activeTabIdRef.current); // ✅
    }

    const [workspaceTabs, workspaceActiveId] = await Promise.all([
      loadTabs(newWorkspace),
      loadActiveTabId(newWorkspace),
    ]);

    selectedWorkspaceRef.current = newWorkspace;
    setSelectedWorkspace(newWorkspace);
    await persistSelectedWorkspace(newWorkspace);
    setTabs(workspaceTabs);
    setActiveTabId(workspaceActiveId);
  } finally {
    isSwitchingWorkspaceRef.current = false;
  }
}, []); // ✅ deps vazio agora é seguro, porque só usa refs, não state direto

const handleSelectWorkspace = useCallback(async (path: string) => {
  if (path === selectedWorkspaceRef.current) return;

  isSwitchingWorkspaceRef.current = true;
  try {
    const previousWorkspace = selectedWorkspaceRef.current;

    if (tabsHydrated.current) {
      await saveTabs(previousWorkspace, tabsRef.current);
      await saveActiveTabId(previousWorkspace, activeTabIdRef.current);
      await saveActiveEnvironmentId(previousWorkspace, selectedEnvIdRef.current);
    }

    const [workspaceTabs, workspaceActiveId, localData, savedEnvId, workspaceMarkers] = await Promise.all([
      loadTabs(path),
      loadActiveTabId(path),
      loadWorkspaceLocalData(path),
      loadActiveEnvironmentId(path),
      loadWorkspaceMarkers(path),
    ]);

    selectedWorkspaceRef.current = path;
    setSelectedWorkspace(path);
    await persistSelectedWorkspace(path);

    setTabs(workspaceTabs);
    setActiveTabId(workspaceActiveId);
    // Carregar os dados do workspace não é uma edição do usuário — sem isso
    // o efeito de auto-save marca o workspace recém-aberto como "pendente
    // de push" mesmo sem nenhuma alteração real (isSwitchingWorkspaceRef já
    // volta a false antes desse efeito rodar, então não protege por si só).
    suppressPendingMarkRef.current = true;
        suppressEnvPendingMarkRef.current = true;
    setCollections(backfillExampleRequests(localData.collections));
    setEnvironments(localData.environments);
    setMarkers(workspaceMarkers as Marker[]);
    // Restauração autoritativa: usa o id salvo especificamente pra ESSE
    // workspace, em vez de deixar o id antigo (de outro workspace) parado
    // no estado e confiar numa checagem de "ainda existe na lista?" — que
    // dá falso positivo quando duas envs de workspaces diferentes têm o
    // mesmo id (ex: puxadas do GitHub a partir de uma pasta duplicada).
    const envExists = !!savedEnvId && localData.environments.some(e => e.id === savedEnvId);
    setSelectedEnvId(envExists ? savedEnvId : null);
  } catch (err) {
    // Dados corrompidos de UM workspace (JSON inválido no store, etc.) não
    // podem derrubar o app inteiro — fica no workspace anterior e avisa.
    console.error(`Erro ao carregar o workspace "${path}":`, err);
    toast.error(`Não foi possível abrir o workspace "${path}". Os dados dele podem estar corrompidos.`);
  } finally {
    isSwitchingWorkspaceRef.current = false;
  }
}, [setEnvironments, setSelectedEnvId]);

const handleCreateWorkspace = useCallback(async (workspace: WorkspaceInfo) => {
  isSwitchingWorkspaceRef.current = true;
  try {
    const previousWorkspace = selectedWorkspaceRef.current;

    if (tabsHydrated.current) {
      await saveTabs(previousWorkspace, tabsRef.current);
      await saveActiveTabId(previousWorkspace, activeTabIdRef.current);
      await saveActiveEnvironmentId(previousWorkspace, selectedEnvIdRef.current);
    }

    // Workspace novo nasce sempre vazio.
    selectedWorkspaceRef.current = workspace.path;
    setSelectedWorkspace(workspace.path);
    await persistSelectedWorkspace(workspace.path);

    setTabs([]);
    setActiveTabId(null);
    // Mesmo motivo do handleSelectWorkspace: workspace novo nasce vazio,
    // isso não é uma edição pra marcar como pendente de push.
    suppressPendingMarkRef.current = true;
        suppressEnvPendingMarkRef.current = true;
    setCollections([]);
    setEnvironments([]);
    setSelectedEnvId(null);
  } catch (err) {
    console.error(`Erro ao criar o workspace "${workspace.path}":`, err);
    toast.error(`Não foi possível criar o workspace "${workspace.name}".`);
  } finally {
    isSwitchingWorkspaceRef.current = false;
  }
}, [setEnvironments, setSelectedEnvId]);

const handleImportWorkspaceFromGitHub = useCallback(async (name: string) => {
  try {
    // Tenta criar um workspace local novo com esse nome. Se já existir
    // localmente (createWorkspace retorna null nesse caso), apenas troca
    // para ele — sem apagar nenhum dado local já existente.
    const created = await createWorkspaceStore(name);
    if (created) {
      await handleCreateWorkspace(created);
    } else {
      await handleSelectWorkspace(name);
    }
  } catch (err) {
    console.error(`Erro ao importar o workspace "${name}" do GitHub:`, err);
    toast.error(`Não foi possível importar o workspace "${name}".`);
  }
}, [handleCreateWorkspace, handleSelectWorkspace]);

const handleRenameWorkspaceLocal = useCallback(async (oldPath: string, newWorkspace: WorkspaceInfo) => {
  const newPath = newWorkspace.path;

  try {
    // Migra todos os dados do workspace antigo para o novo path.
    const [oldTabs, oldActiveId, oldLocalData] = await Promise.all([
      loadTabs(oldPath),
      loadActiveTabId(oldPath),
      loadWorkspaceLocalData(oldPath),
    ]);

    await Promise.all([
      saveTabs(newPath, oldTabs),
      saveActiveTabId(newPath, oldActiveId),
      saveWorkspaceCollections(newPath, oldLocalData.collections),
      saveWorkspaceEnvironments(newPath, oldLocalData.environments),
    ]);

    // Limpa as chaves antigas pra não deixar lixo órfão no storage.
    await Promise.all([
      saveTabs(oldPath, []),
      saveActiveTabId(oldPath, null),
      saveWorkspaceCollections(oldPath, []),
      saveWorkspaceEnvironments(oldPath, []),
    ]);

    if (selectedWorkspaceRef.current === oldPath) {
      selectedWorkspaceRef.current = newPath;
      setSelectedWorkspace(newPath);
      await persistSelectedWorkspace(newPath);
    }
  } catch (err) {
    // Se a migração falhar no meio do caminho, o registro do workspace já foi
    // renomeado (WorkspaceSelector chama renameWorkspaceStore antes disso) —
    // não deixa o erro subir e travar a UI, só avisa que os dados podem não
    // ter migrado por completo.
    console.error(`Erro ao renomear o workspace "${oldPath}" para "${newPath}":`, err);
    toast.error(`Workspace renomeado, mas houve um erro ao migrar os dados salvos.`);
  }
}, []);

useEffect(() => {
  if (!tabsHydrated.current || isSwitchingWorkspaceRef.current) return;
  saveTabs(selectedWorkspace, tabs).catch(err => console.error('Erro ao salvar tabs:', err));
}, [tabs, selectedWorkspace]);

// Grupos da barra de abas, por workspace. Efeito próprio (e não junto da
// carga de tabs, que acontece em cinco lugares diferentes) pra não ter que
// mexer na coreografia de troca de workspace.
useEffect(() => {
  tabGroupsLoadedRef.current = false;
  loadTabGroups(selectedWorkspace)
    .then(loaded => setTabGroups(loaded))
    .catch(err => console.error('Erro ao carregar grupos de abas:', err))
    .finally(() => { tabGroupsLoadedRef.current = true; });
}, [selectedWorkspace]);

useEffect(() => {
  if (!tabGroupsLoadedRef.current || isSwitchingWorkspaceRef.current) return;
  saveTabGroups(selectedWorkspace, liveTabGroups).catch(err =>
    console.error('Erro ao salvar grupos de abas:', err)
  );
}, [liveTabGroups, selectedWorkspace]);

useEffect(() => {
  if (!tabsHydrated.current || isSwitchingWorkspaceRef.current) return;
  saveActiveTabId(selectedWorkspace, activeTabId).catch(err => console.error('Erro ao salvar activeTabId:', err));
}, [activeTabId, selectedWorkspace]);

const handleUpdateCurrentSession = useCallback(() => {

  if(tabs.length <=0) return;

  if (!currentSessionId) return;
  setTabSessions(prev => prev.map(s =>
    s.id === currentSessionId
      ? {
          ...s,
          tabs: stripTabsForSession(tabs),
          activeTabId,
          groups: liveTabGroups,
          savedAt: Date.now(),
          workspace: selectedWorkspace,
        }
      : s
  ));
}, [currentSessionId, tabs, activeTabId]);

const handleLoadSession = useCallback((sessionId: string) => {
  const target = tabSessions.find(s => s.id === sessionId);
  if (!target) return;

  // Antes isso "autosalvava" a sessão atual por cima ao trocar de grupo —
  // mas isso sobrescrevia silenciosamente o grupo de origem com as abas que
  // estivessem abertas no momento (ex: uma aba fechada sem querer, ou abas
  // avulsas sem relação com o grupo), apagando itens do grupo sem o usuário
  // pedir. Persistir mudanças num grupo é sempre uma ação explícita (botão
  // "Update", que já existe pra isso e mostra o indicador de "não salvo") —
  // trocar de grupo só deve carregar o alvo, nunca gravar por cima da origem.
  setTabs(target.tabs);
  setActiveTabId(target.activeTabId);
  // Os grupos voltam junto. Sem isto, restaurar uma sessão de doze abas
  // devolvia as doze soltas — a organização montada à mão sumia. Sessão
  // anterior a este campo não tem grupos, e aí a barra fica sem eles, como
  // antes.
  setTabGroups(target.groups ?? []);
  setCurrentSessionId(target.id);
}, [tabSessions]);

// Sair da sessão sem mexer nas abas.
//
// "Não quero usar esta sessão agora" não é "quero fechar meu trabalho": as
// abas continuam abertas, só deixam de pertencer a ela — nada do que for
// feito daqui pra frente aparece como alteração pendente dela, e o botão
// volta a dizer "No group".
//
// A sessão em si fica intacta, com o último estado salvo.
const handleLeaveSession = useCallback(() => {
  setCurrentSessionId(null);
}, []);

// Grava a árvore com os segredos tirados e cria as variáveis extraídas no
// environment ativo.
//
// Só local, como todo save: o push continua sendo ação explícita. Tirar uma
// credencial da request não deve disparar um commit por conta própria.
const handleApplySecrets = useCallback(async (
  roots: CollectionItem[],
  variables: { key: string; value: string }[]
) => {
  setCollections(roots);
  await saveWorkspaceCollections(selectedWorkspaceRef.current, roots);

  if (variables.length === 0) return;

  setEnvironments(prev => prev.map(env => {
    if (env.id !== selectedEnvId) return env;
    const existing = new Set(env.values.map(v => v.key));
    // Variável de mesmo nome já existente não é sobrescrita: o valor que
    // está lá pode ser o certo, e trocá-lo em silêncio quebraria quem o usa.
    const novas = variables
      .filter(v => !existing.has(v.key))
      .map(v => ({ id: crypto.randomUUID(), key: v.key, value: v.value, enabled: true, type: 'default' }));
    return novas.length ? { ...env, values: [...env.values, ...novas], isDirty: true } : env;
  }));
}, [selectedEnvId, setEnvironments]);

const handleDeleteSession = useCallback((sessionId: string) => {
  setTabSessions(prev => prev.filter(s => s.id !== sessionId));
  setCurrentSessionId(prev => (prev === sessionId ? null : prev));
}, []);

const handleRenameSession = useCallback((sessionId: string, newName: string) => {
  const trimmed = newName.trim();
  if (!trimmed) return;
  setTabSessions(prev => prev.map(s => s.id === sessionId ? { ...s, name: trimmed } : s));
}, []);

// Tab Group -> Flow: passo 1, entra em "modo escolher pasta" na sidebar.
const handleConvertSessionToFlow = useCallback((session: TabSession) => {
  if (session.tabs.length === 0) {
    toast.error('This group has no tabs to convert.');
    return;
  }
  setFlowPickerSession(session);
}, []);

const handleCancelFlowPicker = useCallback(() => {
  setFlowPickerSession(null);
}, []);

// Tab Group -> Flow: passo 2, chamado quando o usuário clica numa pasta na
// árvore enquanto o picker está ativo. Cria uma pasta nova (nome do grupo)
// dentro da pasta escolhida, com um request salvo por aba do grupo.
const handlePickFlowFolder = useCallback((folderId: string) => {
  const session = flowPickerSession;
  if (!session) return;

  const newFolder: CollectionItem = {
    id: crypto.randomUUID(),
    name: session.name,
    type: 'folder',
    item: session.tabs.map(createRequestItemFromTab),
  };

  setCollections(prev => addNode(prev, folderId, newFolder));
  setFlowPickerSession(null);
  toast.success(`Flow "${session.name}" created with ${session.tabs.length} request${session.tabs.length === 1 ? '' : 's'}.`);
}, [flowPickerSession]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!sendDropdownRef.current?.contains(e.target as Node)) {
        setIsSendDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function validateResolvedUrl(rawUrl: string, resolvedUrl: string): string | null {
  // variável não resolvida
  const unresolved = resolvedUrl.match(/\{\{([^}]+)\}\}/g);
  if (unresolved) {
    return `Invalid URI "${resolvedUrl}"`;
  }

  if (!resolvedUrl.trim()) {
    return `Invalid URI "${resolvedUrl}"`;
  }

  try {
    const u = new URL(resolvedUrl);
    // host tipo "api" sem ponto e não localhost → variável de base URL quebrada
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') {
      return `Invalid URI "${resolvedUrl}"`;
    }
  } catch {
    return `Invalid URI "${resolvedUrl}"`;
  }

  return null;
  }

  function diagnoseError(rawUrl: string, errorMsg: string, envMap: Record<string, string>): string {
  const varMatch = rawUrl.match(/\{\{(.*?)\}\}/);
  if (varMatch) {
    const varName = varMatch[1].trim();
    if (!(varName in envMap) || !envMap[varName]?.trim()) {
      return `Variable "{{${varName}}}" doesn't exist or is empty in the active environment. Check that you selected the right environment and that the variable is filled in.`;
    }
  }
  if (errorMsg.includes('Invalid URI')) {
    return 'The final URL ended up incomplete or malformed — likely a variable wasn\'t resolved correctly before sending.';
  }
  return 'Could not identify the exact cause. Check the URL, the active environment, and your network connectivity.';
  }

const handleCancelRequest = useCallback(() => {
  if (!activeTabId) return;
  cancelHttpForTab(activeTabId);
  patchTabRequestState(activeTabId, { isRequesting: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [activeTabId, patchTabRequestState]);

const handleDebugWithAI = useCallback(() => {
  if (!activeTab || !requestError) return;
  const tabId = activeTab.id;
  patchTabRequestState(tabId, { isDebugging: true });
  const envMap = buildEnvMap(activeEnv?.values);
  setTimeout(() => {
    const diagnosis = diagnoseError(activeTab.urlInput || '', requestError, envMap);
    patchTabRequestState(tabId, { debugResult: diagnosis, isDebugging: false });
    pushLog('info', `Debug with AI: ${diagnosis}`);
  }, 400);
}, [activeTab, activeEnv, requestError, patchTabRequestState]);

  function handleImportCurl(parsed: ParsedCurlRequest) {
    const requestHeadersValue: QueryParam[] = parsed.headers
      .filter(h => h.key.trim())
      .map(h => ({ id: crypto.randomUUID(), key: h.key, value: h.value, enabled: h.enabled }));

    // auth: mapeia bearer/basic pro teu AuthorizationDetails
    let auth: AuthorizationDetails = { type: 'none' };
    if (parsed.auth?.type === 'bearer') {
      auth = { type: 'bearer', token: parsed.auth.token ?? '' };
    } else if (parsed.auth?.type === 'basic') {
      auth = {
        type: 'basic',
        username: parsed.auth.username ?? '',
        password: parsed.auth.password ?? '',
      } as AuthorizationDetails;
    }

    const newTab: Tab = {
      id: crypto.randomUUID(),
      name: `${parsed.method} ${parsed.baseUrl}`.slice(0, 60) || 'Imported cURL',
      method: parsed.method as Tab['method'],
      urlInput: parsed.baseUrl,
      params: [],
      queryParams: parsed.queryParams.map(qp => ({
        id: crypto.randomUUID(),
        key: qp.key,
        value: qp.value,
        enabled: qp.enabled,
      })),
      requestHeadersValue,
      requestBodyValue: parsed.body ?? '',
      bodyType: parsed.body ? 'raw' : 'none',
      auth,
      scripts: { preRequest: '', postResponse: '' },
      response: null,
      responseTime: 0,
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
    setImportOpen(false);
  }

// Chaves que nunca entram no histórico de undo (não fazem parte do "conteúdo"
// editável da request, ou são derivadas/navegação).
const historyIgnoredKeys = new Set(['response', 'responseTime', 'testResults', 'activeRequestTab', 'isDirty']);

const pushTabHistory = useCallback((tabId: string, updateKeys: string[]) => {
  const prevTab = tabsRef.current.find(t => t.id === tabId);
  if (!prevTab) return;

  const changeKey = updateKeys.slice().sort().join(',');
  const now = Date.now();
  const last = lastHistoryPushRef.current.get(tabId);

  // Edições seguidas no(s) mesmo(s) campo(s) dentro da janela de coalescing
  // (ex: digitando na URL) não criam um novo passo de undo — só estende a janela.
  if (last && last.key === changeKey && now - last.time < UNDO_COALESCE_MS) {
    lastHistoryPushRef.current.set(tabId, { key: changeKey, time: now });
    return;
  }

  const stack = undoStackRef.current.get(tabId) ?? [];
  stack.push(extractSnapshot(prevTab));
  undoStackRef.current.set(tabId, stack);
  redoStackRef.current.delete(tabId);
  lastHistoryPushRef.current.set(tabId, { key: changeKey, time: now });
}, []);

const updateTabById = useCallback((tabId: string, updates: Partial<Tab>) => {
  const silentKeys = new Set(['response', 'responseTime', 'testResults', 'grpcResult', 'grpcStream']);
  const isContentChange = Object.keys(updates).some(k => !silentKeys.has(k));

  const historyKeys = Object.keys(updates).filter(k => !historyIgnoredKeys.has(k));
  if (historyKeys.length > 0) {
    pushTabHistory(tabId, historyKeys);
  }

  setTabs(prev => prev.map(tab =>
    tab.id === tabId ? { ...tab, ...updates, ...(isContentChange ? { isDirty: true } : {}) } : tab
  ));
}, [pushTabHistory]);

// Aplica um snapshot salvo (usado por undo/redo) sem passar pelo histórico,
// pra não gerar um novo passo de undo ao restaurar um estado anterior.
const applyTabSnapshot = useCallback((tabId: string, snapshot: TabSnapshot) => {
  setTabs(prev => prev.map(tab =>
    tab.id === tabId ? { ...tab, ...snapshot, isDirty: true } : tab
  ));
}, []);

const handleUndo = useCallback(() => {
  const tabId = activeTabIdRef.current;
  if (!tabId) return;
  const stack = undoStackRef.current.get(tabId);
  if (!stack || stack.length === 0) return;

  const currentTab = tabsRef.current.find(t => t.id === tabId);
  if (!currentTab) return;

  const previous = stack.pop()!;
  const redoStack = redoStackRef.current.get(tabId) ?? [];
  redoStack.push(extractSnapshot(currentTab));
  redoStackRef.current.set(tabId, redoStack);
  lastHistoryPushRef.current.delete(tabId);

  applyTabSnapshot(tabId, previous);
}, [applyTabSnapshot]);

const handleRedo = useCallback(() => {
  const tabId = activeTabIdRef.current;
  if (!tabId) return;
  const stack = redoStackRef.current.get(tabId);
  if (!stack || stack.length === 0) return;

  const currentTab = tabsRef.current.find(t => t.id === tabId);
  if (!currentTab) return;

  const next = stack.pop()!;
  const undoStack = undoStackRef.current.get(tabId) ?? [];
  undoStack.push(extractSnapshot(currentTab));
  undoStackRef.current.set(tabId, undoStack);
  lastHistoryPushRef.current.delete(tabId);

  applyTabSnapshot(tabId, next);
}, [applyTabSnapshot]);

// Limpa o histórico de undo/redo de abas que não existem mais (fechadas).
const pruneTabHistory = useCallback((keepIds: Set<string>) => {
  for (const key of Array.from(undoStackRef.current.keys())) {
    if (!keepIds.has(key)) undoStackRef.current.delete(key);
  }
  for (const key of Array.from(redoStackRef.current.keys())) {
    if (!keepIds.has(key)) redoStackRef.current.delete(key);
  }
  for (const key of Array.from(lastHistoryPushRef.current.keys())) {
    if (!keepIds.has(key)) lastHistoryPushRef.current.delete(key);
  }
}, []);

// Ctrl+Z / Cmd+Z (undo) e Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y (redo), igual ao Postman.
// Dentro do Monaco (editor de body/scripts) deixamos o undo nativo do próprio
// editor agir — ele já tem histórico próprio e interceptar aqui quebraria isso.
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    const isUndoCombo = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z';
    if (!isUndoCombo) return;

    const target = e.target as HTMLElement | null;
    if (target?.closest('.monaco-editor')) return;

    if (e.shiftKey) {
      e.preventDefault();
      handleRedo();
    } else {
      e.preventDefault();
      handleUndo();
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [handleUndo, handleRedo]);

const updateActiveTab = useCallback((updates: Partial<Tab>) => {
  if (!activeTabId) return;
  updateTabById(activeTabId, updates);
}, [activeTabId, updateTabById]);

const saveTabsList = useCallback(async (tabsToSave: Tab[]) => {
  if (tabsToSave.length === 0) return;

  // Uma aba cujo id não está na árvore deste workspace não tem onde ser
  // gravada: updateItemInTree procura o nó, não acha, e devolve a árvore
  // intacta — sem erro. Antes seguíamos assim mesmo, limpando o "não salvo"
  // e apagando o rascunho: a edição sumia das duas pontas, em silêncio.
  //
  // Não é hipótese. Acontece ao restaurar uma sessão de abas salva noutro
  // workspace (sessões não guardam de qual vieram) e ao excluir da árvore uma
  // request que está aberta.
  const { missing } = partitionExisting(collections, tabsToSave.map(t => t.id));
  const orphanIds = new Set(missing);
  const savable = tabsToSave.filter(t => !orphanIds.has(t.id));

  if (orphanIds.size > 0) {
    const orphans = tabsToSave.filter(t => orphanIds.has(t.id));
    const names = orphans.map(t => `"${t.name}"`).join(', ');
    toast.error(
      orphans.length === 1
        ? `Can't save ${names}`
        : `Can't save ${orphans.length} tabs`,
      {
        description:
          'They no longer exist in this workspace. Your changes are still here — switch to the workspace they belong to, or save them into a new request.',
        duration: 8000,
      }
    );
  }

  if (savable.length === 0) return;

  let updatedCollections = collections;
  savable.forEach(t => {
    updatedCollections = updateItemInTree(updatedCollections, t.id, t);
  });

  setCollections(updatedCollections);
  await saveWorkspaceCollections(selectedWorkspaceRef.current, updatedCollections);

  // Só o que realmente foi gravado perde o "não salvo" e o rascunho.
  const savedIds = new Set(savable.map(t => t.id));
  setTabs(prev => prev.map(t => savedIds.has(t.id) ? { ...t, isDirty: false } : t));
  removeTabDrafts(savable.map(t => t.id));

  // Save agora é SÓ local — o push virou ação explícita (botão de push do
  // workspace ou o Push do painel de sync). Antes cada Ctrl+S disparava um
  // push silencioso, o que gerava um commit por salvamento; com o autor do
  // commit sendo o usuário do Windows isso poluiria o histórico rápido, e
  // um agente iterando sobre scripts pioraria muito. Marca o workspace como
  // pendente pra não perder de vista que existe coisa local não enviada.
  // Não marca nada aqui: o setCollections acima dispara o efeito que compara
  // a árvore e marca exatamente a(s) collection(s) tocada(s). Marcar também
  // neste ponto só repetiria o trabalho, e sem saber qual collection era.
}, [collections, selectedWorkspace]); // ✅

// Salvar a aba em TODAS as requests com o mesmo nome.
//
// Existe porque o mesmo fluxo costuma estar duplicado em várias collections
// (Flow Tests repetido por workspace), e corrigir uma request significava
// repetir a correção à mão em cada cópia.
//
// Sempre passa por confirmação: é a única ação do app que escreve em vários
// itens de uma vez, e o que ela sobrescreve não tem desfazer.
const handleSaveToAllWithName = useCallback(() => {
  if (!activeTab) return;
  const matches = findRequestsByName(collections, activeTab.name, activeTab.id);
  if (matches.length === 0) {
    toast.info(`No other request is named "${activeTab.name}".`);
    return;
  }
  setSaveAllTargets(matches);
}, [activeTab, collections]);

const confirmSaveToAllWithName = useCallback(async () => {
  const targets = saveAllTargets;
  setSaveAllTargets(null);
  if (!activeTab || !targets?.length) return;

  // A aba em si é salva junto: seria estranho propagar para as cópias e
  // deixar a que está aberta ainda marcada como não salva.
  let next = updateItemInTree(collections, activeTab.id, activeTab);
  for (const target of targets) {
    next = updateItemInTree(next, target.id, activeTab);
  }

  setCollections(next);
  await saveWorkspaceCollections(selectedWorkspaceRef.current, next);
  setTabs(prev => prev.map(t => (t.id === activeTab.id ? { ...t, isDirty: false } : t)));
  removeTabDrafts([activeTab.id]);

  toast.success(`Saved to ${targets.length + 1} request${targets.length ? 's' : ''}.`);
}, [activeTab, collections, saveAllTargets]);

// Fecha o menu do Save ao clicar fora ou com Esc. No mousedown, e não no
// click: o clique que escolhe outro controle já fecharia o menu junto, e com
// `click` o alvo poderia ter saído do DOM antes de o handler rodar.
useEffect(() => {
  if (!saveMenuOpen) return;
  const onPointerDown = (e: MouseEvent) => {
    if (!saveMenuRef.current?.contains(e.target as Node)) setSaveMenuOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setSaveMenuOpen(false);
  };
  window.addEventListener('mousedown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('mousedown', onPointerDown);
    window.removeEventListener('keydown', onKeyDown);
  };
}, [saveMenuOpen]);

const handleSaveActiveTab = useCallback(() => {
  if (!activeTab || !activeTab.isDirty) return;
  saveTabsList([activeTab]);
}, [activeTab, saveTabsList]); // ✅

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSaveActiveTab();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSaveActiveTab]);

  // Ctrl+Tab / Ctrl+Shift+Tab (Cmd no macOS) — cicla entre as abas abertas,
  // igual navegador/VSCode. Ctrl+Shift+Tab vai pra trás.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'Tab') return;
      if (tabs.length === 0) return;
      e.preventDefault();

      const currentIndex = tabs.findIndex(t => t.id === activeTabIdRef.current);
      const baseIndex = currentIndex === -1 ? 0 : currentIndex;
      const delta = e.shiftKey ? -1 : 1;
      const nextIndex = (baseIndex + delta + tabs.length) % tabs.length;
      setActiveTabId(tabs[nextIndex].id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs]);

  const handleNewTab = useCallback(() => {
    const newTab: Tab = {
      id:                  crypto.randomUUID(),
      name:                'New Request',
      method:              'GET',
      urlInput:            '',
      params:              [],
      queryParams:         [],
      requestHeadersValue: [],
      requestBodyValue:    '',
      bodyType:            'none',
      auth:                { type: 'none' },
      scripts:             { preRequest: '', postResponse: '' },
      response:            null,
      responseTime:        0,
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  // "New session": limpa a mesa — fecha todas as abas (sem abrir nenhuma no
  // lugar) e desvincula do grupo atual.
  //
  // Com `save`, antes de fechar grava as abas alteradas nas suas requests da
  // collection — exatamente o que o Ctrl+S faz, uma por uma. Nenhum grupo é
  // criado nem atualizado aqui: o grupo carregado fica como estava salvo
  // (gravar num grupo continua sendo só o botão "Update").
  const handleNewSession = useCallback(async (save: boolean, name: string, keepTabs: boolean) => {
    // Levar as abas abertas pro grupo novo não fecha nada, então não há o que
    // salvar antes nem histórico de undo pra descartar.
    if (!keepTabs) {
      if (save) {
        const dirtyTabs = tabs.filter(t => t.isDirty);
        if (dirtyTabs.length > 0) await saveTabsList(dirtyTabs);
      }
      setTabs([]);
      setActiveTabId(null);
      // Undo/redo das abas fechadas não serve mais pra nada e só ocuparia
      // memória.
      pruneTabHistory(new Set());
    }

    // O grupo já entra como o atual: as abas abertas a partir daqui pertencem
    // a ele. Vai na frente da lista pra aparecer no topo mesmo que outro grupo
    // tenha sido salvo depois — a ordenação por data desempata o resto.
    const newSession: TabSession = {
      id: crypto.randomUUID(),
      name: name.trim(),
      // Sem resposta: a sessão guarda o conjunto de trabalho, não o retrato
      // de uma execução (ver lib/tabSessions.ts).
      tabs: keepTabs ? stripTabsForSession(tabs) : [],
      activeTabId: keepTabs ? activeTabId : null,
      groups: keepTabs ? liveTabGroups : [],
      savedAt: Date.now(),
      // De onde a sessão veio. Abas apontam para requests por id, e id só vale
      // dentro de um workspace — sem isto não há como avisar que restaurar
      // noutro lugar abre abas órfãs.
      workspace: selectedWorkspace,
    };
    setTabSessions(prev => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
  }, [tabs, activeTabId, saveTabsList, pruneTabHistory]);



// ── Execução real do fechamento, sem confirmação ──────────────────────────
  const performCloseTab = useCallback((tabIdToClose: string) => {
    setTabs(prev => {
      const idx     = prev.findIndex(t => t.id === tabIdToClose);
      const newTabs = prev.filter(t => t.id !== tabIdToClose);
      if (activeTabId === tabIdToClose && newTabs.length > 0) {
        setActiveTabId(newTabs[Math.max(0, idx - 1)].id);
      } else if (newTabs.length === 0) {
        setActiveTabId(null);
      }
      pruneTabHistory(new Set(newTabs.map(t => t.id)));
      return newTabs;
    });
  }, [activeTabId, pruneTabHistory]);

  const performCloseOthers = useCallback((keepId: string) => {
    setTabs(prev => prev.filter(t => t.id === keepId));
    setActiveTabId(keepId);
    pruneTabHistory(new Set([keepId]));
  }, [pruneTabHistory]);

  const performCloseToRight = useCallback((fromId: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === fromId);
      if (idx === -1) return prev;
      const kept = prev.slice(0, idx + 1);
      setActiveTabId(current => {
        if (current && kept.some(t => t.id === current)) return current;
        return fromId;
      });
      pruneTabHistory(new Set(kept.map(t => t.id)));
      return kept;
    });
  }, [pruneTabHistory]);

  const performCloseAllTabs = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
    pruneTabHistory(new Set());
  }, [pruneTabHistory]);

  // ── Camada de confirmação: se alguma tab a fechar estiver "isDirty",
  //    abre o modal em vez de fechar direto ─────────────────────────────────
  interface PendingCloseState {
    dirtyTabs: Tab[];
     tabIds: string[];  
    onConfirm: () => void;
  }
const [pendingClose, setPendingClose] = useState<PendingCloseState | null>(null);

const requestCloseTabs = useCallback((tabIds: string[], onConfirm: () => void) => {
  const dirty = tabs.filter(t => tabIds.includes(t.id) && t.isDirty);
  if (dirty.length === 0) {
    cleanupTabRequestStates(tabIds);
    onConfirm();
    return;
  }
  setPendingClose({ dirtyTabs: dirty, tabIds, onConfirm });
}, [tabs, cleanupTabRequestStates]);

  /**
   * Quais campos cada aba pendente gravaria.
   *
   * Monta o item que o save produziria (mesma função do autosave) e compara
   * com o que está na árvore — a mesma pergunta que a tela de comparação com
   * o GitHub responde, pela mesma função.
   */
  const pendingChanges = useMemo(() => {
    const out = new Map<string, string[]>();
    if (!pendingClose) return out;

    for (const tab of pendingClose.dirtyTabs) {
      const saved = findNodeById(collections, tab.id);
      out.set(tab.id, saved ? changedFieldLabels(saved, applyTabUpdatesToItem(saved, tab)) : []);
    }
    return out;
  }, [pendingClose, collections]);

  const handleCloseTab = useCallback((tabIdToClose: string, e: React.MouseEvent) => {
    e.stopPropagation();
    requestCloseTabs([tabIdToClose], () => performCloseTab(tabIdToClose));
  }, [requestCloseTabs, performCloseTab]);

  const handleCloseOthers = useCallback((keepId: string) => {
    const idsToClose = tabs.filter(t => t.id !== keepId).map(t => t.id);
    requestCloseTabs(idsToClose, () => performCloseOthers(keepId));
  }, [tabs, requestCloseTabs, performCloseOthers]);

  const handleCloseToRight = useCallback((fromId: string) => {
    const idx = tabs.findIndex(t => t.id === fromId);
    const idsToClose = idx === -1 ? [] : tabs.slice(idx + 1).map(t => t.id);
    requestCloseTabs(idsToClose, () => performCloseToRight(fromId));
  }, [tabs, requestCloseTabs, performCloseToRight]);

  const handleCloseAllTabs = useCallback(() => {
    const idsToClose = tabs.map(t => t.id);
    requestCloseTabs(idsToClose, () => performCloseAllTabs());
  }, [tabs, requestCloseTabs, performCloseAllTabs]);

  // ── Ações do modal ──────────────────────────────────────────────────────
const handlePendingCloseSaveAndClose = useCallback(() => {
  if (!pendingClose) return;
  saveTabsList(pendingClose.dirtyTabs);
  cleanupTabRequestStates(pendingClose.tabIds);
  pendingClose.onConfirm();
  setPendingClose(null);
}, [pendingClose, saveTabsList, cleanupTabRequestStates]);

const handlePendingCloseDiscard = useCallback(() => {
  if (!pendingClose) return;
  cleanupTabRequestStates(pendingClose.tabIds);
  pendingClose.onConfirm();
  setPendingClose(null);
}, [pendingClose, cleanupTabRequestStates]);

  const handlePendingCloseCancel = useCallback(() => {
    setPendingClose(null);
  }, []);



const handleRenameFromTree = (id: string, newName: string) => {
  setTabs(prev =>
    prev.map(tab =>
      tab.id === id ? { ...tab, name: newName } : tab
    )
  )
}

  const handleRequestSelect = useCallback((item: CollectionItem) => {
    if (item.type !== 'request' && item.type !== 'example') return;
    const existing = tabs.find(t => t.id === item.id);
    if (existing) { setActiveTabId(item.id); return; }

    setTabs(prev => [...prev, buildTabFromItemOrDraft(item)]);
    setActiveTabId(item.id);
  }, [tabs]);

  /**
   * Abre uma pasta inteira em abas.
   *
   * Um `setTabs` só, e não `handleRequestSelect` em laço: aquele lê `tabs`
   * do closure, então quinze chamadas seguidas veriam todas a MESMA lista e
   * abririam quinze abas duplicadas das que já estavam abertas.
   */
  const handleOpenAllRequests = useCallback((items: CollectionItem[]) => {
    const requests = items.filter(i => i.type === 'request');
    if (requests.length === 0) return;

    const alreadyOpen = requests.filter(r => tabs.some(t => t.id === r.id)).length;

    setTabs(prev => {
      const known = new Set(prev.map(t => t.id));
      const added = requests
        .filter(r => !known.has(r.id))
        .map(r => buildTabFromItemOrDraft(r));
      return added.length > 0 ? [...prev, ...added] : prev;
    });

    // Foco na PRIMEIRA: quem abre uma pasta vai percorrer o fluxo do começo,
    // e cair na última deixa a pessoa no fim dele.
    setActiveTabId(requests[0].id);

    const opened = requests.length - alreadyOpen;
    toast.success(
      opened === 0
        ? `All ${requests.length} requests were already open`
        : `${opened} request${opened === 1 ? '' : 's'} opened` +
            (alreadyOpen > 0 ? ` · ${alreadyOpen} already open` : '')
    );
  }, [tabs]);

  const handleUrlChange = useCallback((newUrl: string) => {
  if (!activeTab) return;
  // Mantém `queryParams` em dia mesmo editando a URL com outra sub-aba
  // aberta (não só quando a aba Params está montada — ver
  // parseQueryParamsFromUrl) — senão a query string sumia ao copiar/enviar.
  updateActiveTab({ urlInput: newUrl, queryParams: parseQueryParamsFromUrl(newUrl) });
}, [activeTab, updateActiveTab]);

  const handlePathParamsChange = useCallback((params: QueryParam[]) => {
    updateActiveTab({ params });
  }, [updateActiveTab]);

  const updateQueryParams = useCallback((params: QueryParam[]) => {
    if (!activeTab) return;
    const updatedUrl = buildFinalUrl(activeTab.urlInput, activeTab.params, params);
    updateActiveTab({ queryParams: params, urlInput: updatedUrl });
  }, [activeTab, updateActiveTab]);

  const updateRequestAuth = useCallback((auth: AuthorizationDetails) => {
  if (!activeTab) return;
  updateActiveTab({ auth });
}, [activeTab, updateActiveTab]);

  const updateRequestScript = useCallback((type: 'preRequest' | 'postResponse', value: string) => {
  if (!activeTab) return;
  const updated = {
    preRequest: activeTab.scripts?.preRequest ?? '',
    postResponse: activeTab.scripts?.postResponse ?? '',
    ...activeTab.scripts,
    [type]: value,
  };
  updateActiveTab({ scripts: updated });
}, [activeTab, updateActiveTab]);

useEffect(() => {
  if (!tabsHydrated.current || isSwitchingWorkspaceRef.current) return;
  saveWorkspaceEnvironments(selectedWorkspace, environments)
    .catch(err => console.error('Erro ao salvar environments:', err));

  // Environment editado também fica esperando push, e antes nada marcava
  // isso: só a árvore acendia o indicador. Quem só mexia numa variável via
  // painel não recebia aviso nenhum de que havia coisa local não enviada.
  // `isDirty` fica de fora: é controle de sync, não conteúdo. Incluí-lo faria
  // o markEnvironmentSynced do pós-push (que o zera) contar como alteração e
  // remarcar o environment como pendente logo depois de enviá-lo.
  const nextPrints = new Map(
    environments
      .filter(e => e?.id)
      .map(e => {
        const { isDirty: _ignored, ...content } = e;
        return [e.id, JSON.stringify(content)] as const;
      })
  );
  const previous = envPrintsRef.current;
  envPrintsRef.current = nextPrints;

  if (suppressEnvPendingMarkRef.current) {
    suppressEnvPendingMarkRef.current = false;
    return;
  }

  const changed = [...nextPrints.keys()].filter(id => previous.get(id) !== nextPrints.get(id));
  const removed = [...previous.keys()].filter(id => !nextPrints.has(id));
  if (changed.length === 0 && removed.length === 0) return;

  if (changed.length > 0) markEnvironmentsPendingPush(selectedWorkspace, changed);
  if (removed.length > 0) markFullPushRequired(selectedWorkspace);
  setPendingPush(readPendingPush(selectedWorkspace));
}, [environments, selectedWorkspace]);

useEffect(() => {
  if (!tabsHydrated.current || isSwitchingWorkspaceRef.current) return;
  saveWorkspaceCollections(selectedWorkspace, collections)
    .catch(err => console.error('Erro ao salvar collections:', err));

  // Edições na árvore (criar/renomear/excluir/colar/reordenar) e o Save de
  // uma aba passam todos por aqui, porque todos acabam em setCollections.
  // Detectar num ponto só evita ter que passar o id da collection em cada
  // mutação — e evita que uma delas, esquecida, vire alteração que nunca é
  // enviada.
  const nextPrints = fingerprintRoots(collections);

  // Pull acabou de substituir a árvore pelo remoto: não há nada pendente, só
  // a referência a atualizar pra que a PRÓXIMA edição seja medida contra o
  // que veio de lá.
  if (suppressPendingMarkRef.current) {
    suppressPendingMarkRef.current = false;
    rootPrintsRef.current = nextPrints;
    return;
  }

  const { changed, removed } = diffRoots(rootPrintsRef.current, nextPrints);
  rootPrintsRef.current = nextPrints;
  if (changed.length === 0 && removed.length === 0) return;

  if (changed.length > 0) markCollectionsPendingPush(selectedWorkspace, changed);
  // Collection apagada não tem mais id pra marcar; só um push completo
  // reconcilia o arquivo que ficou no remoto.
  if (removed.length > 0) markFullPushRequired(selectedWorkspace);
  setPendingPush(readPendingPush(selectedWorkspace));
}, [collections, selectedWorkspace]);

// useEffect(() => {
//   if (!tabsHydrated.current) return;
//   localStorage.setItem(COLLECTIONS_STORAGE_KEY, JSON.stringify(collections));
// }, [collections]);

// Antes reconstruía env.values do zero a partir de Object.entries(currentEnvMap)
// — um mapa achatado (key -> value), já que é isso que o script Rust recebe/
// devolve. Isso tinha dois problemas sérios: (1) qualquer duplicata
// DESABILITADA de uma key (ver DuplicateVariablePicker) sumia silenciosamente,
// porque só existe UMA entrada por key no mapa achatado; (2) id/description/
// type eram perdidos em TODA execução de script, porque a entrada nova era
// montada do zero em vez de herdar da existente — e o `existing` usado era o
// primeiro match por key (`.find`), não necessariamente o habilitado.
// Agora comparamos o mapa de ANTES do script com o de DEPOIS: só a entrada
// que já estava habilitada para aquela key é alterada (pm.environment.set),
// ou removida (pm.environment.unset) — as duplicatas desabilitadas nunca são
// tocadas. Keys totalmente novas (set de uma variável que não existia) viram
// uma entrada nova habilitada.
const syncEnvToGlobal = useCallback(async (
  previousEnvMap: Record<string, string>,
  currentEnvMap: Record<string, string>
) => {
  const envId = activeEnv?.id;
  if (!envId) return;

  let updatedEnvironments = environments;

  setEnvironments(prev => {
    updatedEnvironments = prev.map(env => {
      if (env.id !== envId) return env;

      const nextValues = [...env.values];

      // pm.environment.unset(key) — a key some do mapa retornado pelo
      // script. Remove só a entrada habilitada dessa key; duplicatas
      // desabilitadas ficam intocadas.
      Object.keys(previousEnvMap).forEach((key) => {
        if (key in currentEnvMap) return;
        const idx = nextValues.findIndex(v => v.key === key && v.enabled);
        if (idx !== -1) nextValues.splice(idx, 1);
      });

      // pm.environment.set(key, value) — atualiza exatamente a entrada
      // selecionada (habilitada) para essa key. Se nenhuma estiver
      // habilitada ainda, cai na primeira com essa key; se a key for
      // totalmente nova, cria uma entrada.
      Object.entries(currentEnvMap).forEach(([key, value]) => {
        if (previousEnvMap[key] === value) return;

        const enabledIdx = nextValues.findIndex(v => v.key === key && v.enabled);
        if (enabledIdx !== -1) {
          nextValues[enabledIdx] = { ...nextValues[enabledIdx], value: String(value) };
          return;
        }

        const anyIdx = nextValues.findIndex(v => v.key === key);
        if (anyIdx !== -1) {
          nextValues[anyIdx] = { ...nextValues[anyIdx], value: String(value), enabled: true };
          return;
        }

        nextValues.push({
          id: crypto.randomUUID(),
          key,
          value: String(value),
          type: 'default',
          enabled: true,
          description: '',
        });
      });

      return { ...env, values: nextValues };
    });
    return updatedEnvironments;
  });

  // ✅ salva o array COMPLETO de environments na chave certa
  await saveWorkspaceEnvironments(selectedWorkspaceRef.current, updatedEnvironments);
}, [activeEnv?.id, environments, setEnvironments]);

  // Padrões + headers da request + auth, com override sem diferenciar
  // maiúsculas/minúsculas — regra única em lib/defaultHeaders.ts.
  const buildFinalHeaders = useCallback((tab: Tab, envMap: Record<string, string>): Record<string, string> => {
    return buildRequestHeaders({
      // Array.isArray (não só `|| []`) porque uma tab com o formato antigo
      // (Record<string,string>, ex. `{}`) é um valor truthy e passaria direto
      // pelo fallback. Só headers HABILITADOS entram na request de verdade.
      userHeaders: Array.isArray(tab.requestHeadersValue) ? tab.requestHeadersValue : [],
      disabledDefaults: tab.disabledDefaultHeaders,
      hasBody: requestHasBody(tab.bodyType, tab.requestBodyValue),
      auth: tab.auth,
      resolve: value => replaceWithEnv(value, envMap),
    });
  }, []);


const handleSendRequest = useCallback(async (mode: SendMode = 'send') => {
  if (!activeTab) return;
  if (activeTab.protocol === 'grpc') return;
  const tab = activeTab;
  const tabId = tab.id;

  patchTabRequestState(tabId, { isRequesting: true, startTime: Date.now(), error: null, debugResult: null });

  // A resposta anterior sai de cena agora, não quando a nova chegar.
  //
  // Sem isto, uma falha de envio deixava o erro novo ao lado do status
  // antigo: a tela mostrava "Could not send request" e, logo acima, um
  // "201 Created · 430 ms" de minutos atrás. Num passo de token é leitura
  // perigosa — o 201 sugere que o token veio, quando a chamada nem saiu.
  updateTabById(tabId, { response: null, responseTime: 0, testResults: [] });



  const controller = new AbortController();
  abortControllersRef.current[tabId] = controller;

  try {
    let envMap: Record<string, string> = buildEnvMap(activeEnv?.values);

    // Base calculada a partir da própria tab (igual antes) — serve como
    // ponto de partida real pro pre-request script poder ler e alterar
    // (pm.request.headers/url/body/method), não só um stub decorativo.
    const effectiveQueryParams = getEffectiveQueryParams(tab.urlInput || '', tab.queryParams || []);
    const resolvedUrl = buildFinalUrl(tab.urlInput || '', tab.params || [], effectiveQueryParams);
    let finalMethod = tab.method;
    let finalUrl = replaceWithEnv(replaceUrlParams(resolvedUrl, tab.params || []), envMap);
    let finalHeaders = buildFinalHeaders(tab, envMap);
    let finalBody = '';
    if (tab.bodyType === 'graphql') {
      try {
        finalBody = buildGraphQLRequestBody(tab.requestBodyValue || '', envMap);
      } catch (e: any) {
        const msg = e?.message || 'GraphQL Variables contains invalid JSON.';
        patchTabRequestState(tabId, { error: msg });
        pushLog('error', msg, { requestName: tab.name, source: 'system' });
        return;
      }
    } else if (tab.bodyType !== 'none') {
      // Tira comentários "//"/"/* */" e vírgula sobrando que o editor
      // tolera mas que quebram tanto o servidor de destino quanto
      // JSON.parse(pm.request.body.raw) nos scripts (ver sanitizeJsonBody.ts).
      finalBody = sanitizeJsonBodyForSend(replaceWithEnv(tab.requestBodyValue || '', envMap));
    }

    // A mesma montagem acima, refeita depois do pre-request com as variáveis
    // que ele criar/alterar (ver resolveAfterPreRequest).
    const rebuildParts = (env: Record<string, string>) => ({
      url: replaceWithEnv(replaceUrlParams(resolvedUrl, tab.params || []), env),
      headers: buildFinalHeaders(tab, env),
      body: tab.bodyType === 'graphql'
        ? buildGraphQLRequestBody(tab.requestBodyValue || '', env)
        : tab.bodyType !== 'none'
          ? sanitizeJsonBodyForSend(replaceWithEnv(tab.requestBodyValue || '', env))
          : '',
    });

    if (tab.scripts?.preRequest?.trim()) {
      try {
        const passedToScript = { url: finalUrl, headers: finalHeaders, body: finalBody };
        const preResult = await invoke<ScriptContext>('execute_script_backend', {
          script: tab.scripts.preRequest,
          context: {
            env: envMap,
            response: null,
            request: { method: finalMethod, ...passedToScript },
          },
        });
        if (preResult?.env) { const prevEnvMap = envMap; envMap = preResult.env; await syncEnvToGlobal(prevEnvMap, envMap); }
        finalMethod = preResult?.request?.method || finalMethod;
        // Variáveis do pre-request valem nesta mesma request (como no Postman).
        ({ url: finalUrl, headers: finalHeaders, body: finalBody } = resolveAfterPreRequest({
          before: passedToScript,
          after: preResult?.request,
          rebuild: rebuildParts,
          env: envMap,
          resolve: replaceWithEnv,
        }));
        // Script que lançou ABORTA o envio, como no Postman.
        //
        // Antes o erro só era registrado e a request saía assim mesmo — o
        // `throw` virava um aviso no console enquanto a chamada seguia com
        // exatamente os dados que o script tentou impedir. Uma guarda que
        // não guarda é pior que nenhuma: dá a impressão de proteção.
        if (preResult?.scriptError) {
          const message = `Pre-request script error: ${preResult.scriptError}`;
          pushLog('error', `Pre-request script error: ${firstLine(preResult.scriptError)}`, {
            requestName: tab.name,
            source: 'script',
            detail: preResult.scriptError,
          });
          patchTabRequestState(tabId, { error: message });
          return;
        }
      } catch (e) {
        // O próprio sandbox falhou (não compilou, travou). Também não envia:
        // o script não chegou a rodar, então nada garante que a request
        // esteja no estado que ele deixaria.
        const message = `Pre-request script error: ${e}`;
        pushLog('error', message, { requestName: tab.name, source: 'script' });
        patchTabRequestState(tabId, { error: message });
        return;
      }
    }

    // Cancel apertado enquanto o pre-request rodava: nem chega a enviar.
    if (controller.signal.aborted) {
      pushLog('info', `${finalMethod} ${finalUrl} — cancelled before sending`, { requestName: tab.name, source: 'system' });
      return;
    }

    const validationError = validateResolvedUrl(tab.urlInput || '', finalUrl);
    if (validationError) {
      patchTabRequestState(tabId, { error: validationError });
      pushLog('error', validationError, { requestName: tab.name, source: 'system' });
      return;
    }

    const reqStart = performance.now();
    let result: DataResponse;
    const requestId = crypto.randomUUID();
    httpRequestIdsRef.current[tabId] = requestId;
    try {
      result = await invoke<DataResponse>('make_http_request', {
        method: finalMethod, url: finalUrl, body: finalBody || null, headersInput: finalHeaders, requestId,
      });
    } catch (err: any) {
      if (controller.signal.aborted) {
        // Cancelar deixa o painel vazio: a resposta anterior já saiu no
        // início do envio, e ressuscitá-la aqui mostraria como atual algo
        // de outra chamada. O cancelamento fica registrado no console.
        pushLog('info', `${finalMethod} ${finalUrl} — cancelled`, { requestName: tab.name, source: 'system' });
        toast.info('Request cancelled');
        return;
      }
      const msg = typeof err === 'string' ? err : err?.message || 'Failed to fetch';
      patchTabRequestState(tabId, { error: msg });
      pushLog('error', `${finalMethod} ${finalUrl} — ${firstLine(msg)}`, {
        requestName: tab.name,
        source: 'response',
        detail: msg,
      });
      return;
    }
    // Resposta que chegou depois do Cancel (corrida entre os dois): descarta
    // inteira — não mostra, não roda post-response, não entra no histórico.
    if (controller.signal.aborted) {
      pushLog('info', `${finalMethod} ${finalUrl} — cancelled`, { requestName: tab.name, source: 'system' });
      return;
    }
    const reqEnd = performance.now();

    // Requests que chegam ao servidor mas voltam com status de erro (4xx/5xx)
    // não geravam NENHUM log antes — só atualizavam o painel de response, o
    // que fazia falhas passarem despercebidas se o usuário não olhasse ali.
    if (result.status >= 400) {
      const bodySnippet = typeof result.body === 'string' ? result.body.slice(0, 500) : '';
      pushLog('error', `${finalMethod} ${finalUrl} — HTTP ${result.status}`, {
        requestName: tab.name,
        source: 'response',
        status: result.status,
        detail: bodySnippet || undefined,
      });
    }
    const responseBody = (() => {
      const b = (result as any)?.body ?? (result as any)?.Body;
      return typeof b === 'string' ? b : JSON.stringify(b || {}, null, 2);
    })();
    let testResults: TestResult[] = [];
    if (tab.scripts?.postResponse?.trim()) {
      try {
        const postResult = await invoke<ScriptContext>('execute_script_backend', {
          script: tab.scripts.postResponse,
          context: {
            env: envMap,
            response: result,
            responseBody,
            request: { method: finalMethod, url: finalUrl, headers: finalHeaders, body: finalBody },
            responseTime: Math.round(reqEnd - reqStart),
          },
        });
        if (postResult?.env) await syncEnvToGlobal(envMap, postResult.env);
        if (postResult?.tests) testResults = postResult.tests;
        if (postResult?.scriptError) {
          pushLog('error', `Post-response script error: ${firstLine(postResult.scriptError)}`, {
            requestName: tab.name,
            source: 'script',
            detail: postResult.scriptError,
          });
        }
      } catch (e) {
        pushLog('error', `Post-response script error: ${e}`, { requestName: tab.name, source: 'script' });
      }
    }
    const finalResponse = new ApiResponse(result);
    const roundedResponseTime = Math.round(reqEnd - reqStart);
    updateTabById(tabId, { response: finalResponse, responseTime: roundedResponseTime, testResults });
    // Snapshot do request tal como estava no editor (não o resolvido/com env
    // já substituído) — assim, ao restaurar do histórico, os {{placeholders}}
    // continuam editáveis, igual o Postman faz no dele.
    pushResponseHistory(tabId, finalResponse, roundedResponseTime, {
      method: tab.method,
      urlInput: tab.urlInput,
      requestBodyValue: tab.requestBodyValue,
      bodyType: tab.bodyType,
      requestHeadersValue: tab.requestHeadersValue,
      auth: tab.auth,
      queryParams: tab.queryParams,
      params: tab.params,
    });
    // pushResponseHistory só grava no localStorage — sem isto, o ícone de
    // histórico só aparecia depois de trocar de aba e voltar (o useEffect
    // que recarrega responseHistory só dispara em mudança de activeTabId).
    if (tabId === activeTabIdRef.current) {
      setResponseHistory(getResponseHistory(tabId));
    }
    if (mode === 'send-and-download') {
      try { await saveResponseToFile(finalResponse, tab.urlInput); }
      catch (e) { console.log('Save error:', e); }
    }
  } catch (error: any) {
    patchTabRequestState(tabId, { error: error?.message || 'Failed to fetch' });
  } finally {
    // Só limpa se ainda for o controller DESTE envio (um Send novo logo após
    // o Cancel já registrou o seu).
    if (abortControllersRef.current[tabId] === controller) {
      delete abortControllersRef.current[tabId];
      delete httpRequestIdsRef.current[tabId];
      patchTabRequestState(tabId, { isRequesting: false });
    }
  }
}, [activeTab, activeEnv, buildFinalHeaders, syncEnvToGlobal, updateTabById, patchTabRequestState]);

  // ── gRPC (fase 1: unário) ───────────────────────────────────────────────
  // A chamada roda no Rust (grpc_invoke). Não dá pra abortar a chamada lá;
  // "Cancel" só descarta o resultado — o id da chamada em andamento por aba
  // diz se a resposta que chegou ainda interessa.
  const grpcCallRef = useRef<Record<string, string>>({});
  const resolveWithActiveEnvRef = useRef<(text: string) => string>(text => text);
  const cancelGrpcStreamRef = useRef<(streamId: string) => void>(() => {});

  const handleGrpcInvoke = useCallback(async () => {
    const tab = activeTab;
    if (!tab || tab.protocol !== 'grpc' || !tab.grpc) return;
    const grpc = tab.grpc;

    const envMap = buildEnvMap(activeEnv?.values);
    const resolve = (text: string) => replaceWithEnv(text, envMap);

    const callId = crypto.randomUUID();
    grpcCallRef.current[tab.id] = callId;
    patchTabRequestState(tab.id, { isRequesting: true, startTime: Date.now(), error: null });

    try {
      const result = await invoke<GrpcCallResult>('grpc_invoke', {
        target: resolve(grpc.target),
        useTls: grpc.useTls,
        insecureTls: !!grpc.insecureTls,
        descriptorSet: grpc.descriptorSet ?? '',
        method: grpc.method,
        message: resolve(grpc.message),
        metadata: grpc.metadata
          .filter(m => m.enabled && m.key.trim())
          .map(m => ({ key: m.key, value: resolve(m.value) })),
        timeoutMs: grpc.timeoutMs ?? null,
      });
      if (grpcCallRef.current[tab.id] !== callId) return;
      updateTabById(tab.id, { grpcResult: result, grpcStream: null });
      pushLog(
        result.statusCode === 0 ? 'info' : 'error',
        `gRPC ${grpc.method} → ${result.statusCode} ${result.statusName} (${result.timeMs} ms)`,
        {
          requestName: tab.name,
          source: 'response',
          ...(result.statusMessage ? { detail: result.statusMessage } : {}),
        }
      );
    } catch (e) {
      if (grpcCallRef.current[tab.id] !== callId) return;
      const message = e instanceof Error ? e.message : String(e);
      updateTabById(tab.id, { grpcResult: null });
      patchTabRequestState(tab.id, { error: message });
      pushLog('error', `gRPC ${grpc.method || '(no method)'} failed`, {
        requestName: tab.name,
        source: 'response',
        detail: message,
      });
    } finally {
      if (grpcCallRef.current[tab.id] === callId) {
        delete grpcCallRef.current[tab.id];
        patchTabRequestState(tab.id, { isRequesting: false });
      }
    }
  }, [activeTab, activeEnv, patchTabRequestState, updateTabById, pushLog]);

  const handleGrpcCancel = useCallback(() => {
    if (!activeTabId) return;
    const stream = tabsRef.current.find(t => t.id === activeTabId)?.grpcStream;
    if (stream?.active) {
      cancelGrpcStreamRef.current(stream.streamId);
      return;
    }
    delete grpcCallRef.current[activeTabId];
    patchTabRequestState(activeTabId, { isRequesting: false });
  }, [activeTabId, patchTabRequestState]);

  // ── gRPC streaming (fase 2) ─────────────────────────────────────────────
  // O Rust emite "grpc-stream-event" pra cada coisa que acontece no stream;
  // aqui cada evento vai pra aba dona do stream (streamId → tabId).
  const grpcStreamTabRef = useRef<Record<string, string>>({});
  const MAX_STREAM_EVENTS = 2000;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<GrpcStreamEvent>('grpc-stream-event', ({ payload }) => {
      const tabId = grpcStreamTabRef.current[payload.streamId];
      if (!tabId) return;
      const finished = payload.kind === 'end' || payload.kind === 'error';
      // setTabs direto (não updateTabById): evento de stream não é edição,
      // não marca a aba como alterada nem entra no undo.
      setTabs(prev =>
        prev.map(t => {
          const current = t.grpcStream;
          if (t.id !== tabId || !current || current.streamId !== payload.streamId) return t;
          const events = [...current.events, payload];
          const overflow = Math.max(0, events.length - MAX_STREAM_EVENTS);
          return {
            ...t,
            grpcStream: {
              ...current,
              events: overflow ? events.slice(overflow) : events,
              droppedEvents: current.droppedEvents + overflow,
              active: finished ? false : current.active,
            },
          };
        })
      );
      if (finished) {
        delete grpcStreamTabRef.current[payload.streamId];
        patchTabRequestState(tabId, { isRequesting: false });
      }
    })
      .then(fn => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(err => console.error('Erro ao escutar grpc-stream-event:', err));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [patchTabRequestState]);

  const handleGrpcStartStream = useCallback(async (kind: GrpcMethodKind) => {
    const tab = activeTab;
    if (!tab || tab.protocol !== 'grpc' || !tab.grpc) return;
    const grpc = tab.grpc;
    const resolve = resolveWithActiveEnvRef.current;

    const streamId = crypto.randomUUID();
    const initial: GrpcStreamState = {
      streamId,
      methodKind: kind,
      active: true,
      sendingClosed: kind === 'server',
      events: [],
      droppedEvents: 0,
    };
    grpcStreamTabRef.current[streamId] = tab.id;
    setTabs(prev => prev.map(t => (t.id === tab.id ? { ...t, grpcStream: initial, grpcResult: null } : t)));
    patchTabRequestState(tab.id, { isRequesting: true, startTime: Date.now(), error: null });

    try {
      await invoke('grpc_stream_start', {
        streamId,
        target: resolve(grpc.target),
        useTls: grpc.useTls,
        insecureTls: !!grpc.insecureTls,
        descriptorSet: grpc.descriptorSet ?? '',
        method: grpc.method,
        metadata: grpc.metadata
          .filter(m => m.enabled && m.key.trim())
          .map(m => ({ key: m.key, value: resolve(m.value) })),
        // Server stream: a mensagem do editor é a única que vai, e o envio
        // fecha logo. Client/bidi: abre vazio e cada "Send" manda uma.
        initialMessage: kind === 'server' ? resolve(grpc.message) : null,
        closeAfterInitial: kind === 'server',
        timeoutMs: grpc.timeoutMs ?? null,
      });
      pushLog('info', `gRPC stream ${grpc.method} opened`, { requestName: tab.name, source: 'response' });
    } catch (e) {
      // Não chegou a abrir (conexão, schema, JSON inválido).
      delete grpcStreamTabRef.current[streamId];
      const message = e instanceof Error ? e.message : String(e);
      setTabs(prev =>
        prev.map(t => (t.id === tab.id ? { ...t, grpcStream: null } : t))
      );
      patchTabRequestState(tab.id, { isRequesting: false, error: message });
      pushLog('error', `gRPC stream ${grpc.method || '(no method)'} failed`, {
        requestName: tab.name,
        source: 'response',
        detail: message,
      });
    }
  }, [activeTab, patchTabRequestState, pushLog]);

  const handleGrpcSendOnStream = useCallback(async () => {
    const tab = activeTab;
    const stream = tab?.grpcStream;
    if (!tab?.grpc || !stream?.active || stream.sendingClosed) return;
    try {
      await invoke('grpc_stream_send', {
        streamId: stream.streamId,
        message: resolveWithActiveEnvRef.current(tab.grpc.message),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [activeTab]);

  const handleGrpcEndStream = useCallback(async () => {
    const tab = activeTab;
    const stream = tab?.grpcStream;
    if (!tab || !stream?.active) return;
    await invoke('grpc_stream_end', { streamId: stream.streamId }).catch(() => {});
    setTabs(prev =>
      prev.map(t =>
        t.id === tab.id && t.grpcStream?.streamId === stream.streamId
          ? { ...t, grpcStream: { ...t.grpcStream, sendingClosed: true } as GrpcStreamState }
          : t
      )
    );
  }, [activeTab]);

  const cancelGrpcStream = useCallback((streamId: string) => {
    const tabId = grpcStreamTabRef.current[streamId];
    delete grpcStreamTabRef.current[streamId];
    invoke('grpc_stream_cancel', { streamId }).catch(() => {});
    if (tabId) {
      setTabs(prev =>
        prev.map(t =>
          t.id === tabId && t.grpcStream?.streamId === streamId
            ? { ...t, grpcStream: { ...t.grpcStream, active: false } as GrpcStreamState }
            : t
        )
      );
      patchTabRequestState(tabId, { isRequesting: false });
    }
  }, [patchTabRequestState]);

  useEffect(() => {
    cancelGrpcStreamRef.current = cancelGrpcStream;
  }, [cancelGrpcStream]);

  // Aba fechada com stream aberto: cancela no Rust também (senão a conexão
  // ficaria aberta sem ninguém olhando).
  useEffect(() => {
    const openTabIds = new Set(tabs.map(t => t.id));
    for (const [streamId, tabId] of Object.entries(grpcStreamTabRef.current)) {
      if (!openTabIds.has(tabId)) cancelGrpcStream(streamId);
    }
  }, [tabs, cancelGrpcStream]);

  // Botão principal do painel gRPC: unário chama; streaming abre o stream.
  const handleGrpcRun = useCallback((kind: GrpcMethodKind) => {
    if (kind === 'unary') handleGrpcInvoke();
    else handleGrpcStartStream(kind);
  }, [handleGrpcInvoke, handleGrpcStartStream]);

  // Resolve {{variáveis}} pro painel gRPC (reflection e grpcurl).
  const resolveWithActiveEnv = useCallback((text: string) => {
    const envMap = buildEnvMap(activeEnv?.values);
    return replaceWithEnv(text, envMap);
  }, [activeEnv]);
  useEffect(() => {
    resolveWithActiveEnvRef.current = resolveWithActiveEnv;
  }, [resolveWithActiveEnv]);

  // O "Try" de example é declarado mais abaixo (depende de collections);
  // o atalho lê por ref.
  const tryExampleRef = useRef<() => void>(() => {});

  // Ctrl+Enter (Cmd+Enter no macOS) — atalho igual Postman/Insomnia pra
  // disparar o Send sem precisar clicar no botão. Cancela em vez de enviar
  // se já tiver uma requisição em andamento (mesmo comportamento do botão).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (activeTab?.protocol === 'grpc') {
          const stream = activeTab.grpcStream;
          if (stream?.active && !stream.sendingClosed) handleGrpcSendOnStream();
          else if (isRequesting) handleGrpcCancel();
          else handleGrpcRun(activeTab.grpc?.methodKind ?? 'unary');
        }
        else if (isRequesting) handleCancelRequest();
        else if (activeTab?.kind === 'example') tryExampleRef.current();
        else handleSendRequest('send');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isRequesting, handleCancelRequest, handleSendRequest, activeTab?.kind, activeTab?.protocol, activeTab?.grpcStream, activeTab?.grpc?.methodKind, handleGrpcRun, handleGrpcCancel, handleGrpcSendOnStream]);



  const handleDownloadResponse = useCallback(async () => {
    if (!activeTab?.response) return;
    try { await saveResponseToFile(activeTab.response, activeTab.urlInput); }
    catch (e) { console.log('Download error:', e); }
  }, [activeTab]);

const handleClearResponseBody = useCallback(() => {
  if (!activeTab?.response) return;
  updateActiveTab({ response: null, responseTime: 0, testResults: [] });
}, [activeTab, updateActiveTab]);

const handleLoadResponseFromHistory = useCallback((entry: ResponseHistoryEntry) => {
  updateActiveTab({
    response: toApiResponse(entry),
    responseTime: entry.responseTime ?? 0,
    // Entradas salvas antes dessa feature não têm request snapshot — nesse
    // caso só restaura a resposta mesmo, como já fazia.
    ...(entry.request
      ? {
          method: entry.request.method,
          urlInput: entry.request.urlInput,
          requestBodyValue: entry.request.requestBodyValue,
          bodyType: entry.request.bodyType,
          requestHeadersValue: entry.request.requestHeadersValue,
          auth: entry.request.auth,
          queryParams: entry.request.queryParams,
          params: entry.request.params,
        }
      : {}),
  });
  // Sem isso, carregar uma resposta do histórico enquanto a tela de erro do
  // último envio está sendo exibida não tinha efeito nenhum na tela: a
  // condição que mostra o RequestErrorScreen (ver renderResponseBody) só
  // olha pro erro da aba, não pro response — o response até era trocado,
  // mas a tela de erro continuava por cima.
  if (activeTabId) patchTabRequestState(activeTabId, { error: null });
}, [updateActiveTab, activeTabId, patchTabRequestState]);

const handleOpenResponseInNewWindow = useCallback(async () => {
  if (!activeTab?.response) return;

  const body = activeTab.response.parsedBody;
  const content = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body, null, 2);

  const storageKey = `response-viewer:${crypto.randomUUID()}`;
  // Falhar aqui é falhar em abrir a janela, não em salvar uma preferência:
  // avisa e não segue, senão a janela abriria vazia sem explicação.
  if (!safeSetItem(storageKey, content)) {
    toast.error('Not enough local storage to open the response in a new window');
    return;
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const label = `response-${Date.now()}`;

    // Abre CENTRALIZADA no mesmo monitor da janela principal. Usar a posição
    // bruta da janela principal (via outerPosition) quebrava quando ela
    // estava maximizada: em setup com vários monitores, `center: true` do
    // Tauri centraliza no monitor PRIMÁRIO, não no monitor onde a janela
    // principal realmente está — daí a nova janela "pulava" pro outro
    // monitor. `currentMonitor()` retorna o monitor da janela em foco (a
    // principal, já que foi ela que disparou o clique), então centralizamos
    // manualmente dentro da área útil (workArea) DESSE monitor.
    const NEW_WIN_WIDTH = 900;
    const NEW_WIN_HEIGHT = 700;
    let position: { x: number; y: number } | null = null;
    try {
      const monitor = await currentMonitor();
      if (monitor) {
        const { position: workPosPhysical, size: workSizePhysical } = monitor.workArea;
        const workPosLogical = workPosPhysical.toLogical(monitor.scaleFactor);
        const workSizeLogical = workSizePhysical.toLogical(monitor.scaleFactor);
        position = {
          x: Math.round(workPosLogical.x + (workSizeLogical.width - NEW_WIN_WIDTH) / 2),
          y: Math.round(workPosLogical.y + (workSizeLogical.height - NEW_WIN_HEIGHT) / 2),
        };
      }
    } catch (e) {
      console.error('Não foi possível ler o monitor da janela principal:', e);
    }

    const win = new WebviewWindow(label, {
      url: `/response-viewer?key=${encodeURIComponent(storageKey)}&title=${encodeURIComponent(activeTab.name)}`,
      title: `Response — ${activeTab.name}`,
      width: NEW_WIN_WIDTH,
      height: NEW_WIN_HEIGHT,
      minWidth: 480,
      minHeight: 320,
      ...(position ? { x: position.x, y: position.y } : { center: true }),
      // Sem decorações nativas (barra branca do SO) — a própria página
      // renderiza sua barra de título escura com os controles, igual a
      // janela principal.
      decorations: false,
    });

    win.once('tauri://error', (e) => {
      console.error('Erro ao abrir janela de resposta:', e);
    });
  } catch (e) {
    console.error('Falha ao criar janela:', e);
  }
}, [activeTab]);

// `keepBodyComments`: por padrão o body vai LIMPO (sem os comentários "//"
// e vírgulas sobrando que o editor tolera), igual ao que o app realmente
// envia — antes o curl saía com os comentários e não rodava se colado num
// terminal, já que o JSON ficava inválido. Com a flag ligada os comentários
// são preservados, pra quem quer compartilhar o body documentado.
// Monta a request RESOLVIDA que alimenta os geradores de snippet: URL com
// {{variáveis}} e :path params já substituídos, headers finais (auth
// incluída) e body resolvido. Antes isto montava a string do curl direto;
// agora devolve a forma normalizada, e quem escreve o texto de cada
// linguagem é o codeSnippets, que é puro e testável.
const buildSnippetRequest = useCallback((keepBodyComments = false): SnippetRequest | null => {
  if (!activeTab) return null;
  const envMap      = buildEnvMap(activeEnv?.values);
  const effectiveQueryParams = getEffectiveQueryParams(activeTab.urlInput || '', activeTab.queryParams || []);
  const resolvedUrl = buildFinalUrl(activeTab.urlInput || '', activeTab.params || [], effectiveQueryParams);
  const finalUrl    = replaceWithEnv(replaceUrlParams(resolvedUrl, activeTab.params || []), envMap);
  const finalHeaders = buildFinalHeaders(activeTab, envMap);

  let body: string | undefined;
  if (activeTab.bodyType === 'graphql' && activeTab.requestBodyValue) {
    try {
      body = buildGraphQLRequestBody(activeTab.requestBodyValue, envMap);
    } catch {
      // variables inválidas: não quebra a geração do snippet, só omite o body
    }
  } else if (activeTab.bodyType !== 'none' && activeTab.requestBodyValue) {
    const resolvedBody = replaceWithEnv(activeTab.requestBodyValue, envMap);
    body = keepBodyComments ? resolvedBody : sanitizeJsonBodyForSend(resolvedBody);
  }

  return { method: activeTab.method, url: finalUrl, headers: finalHeaders, body };
}, [activeTab, activeEnv, buildFinalHeaders]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      sidebarGroupRef.current?.setLayout({
        'sidebar-panel': next ? 0 : 20,
        'main-panel': next ? 100 : 80,
      });
      return next;
    });
  }, []);

  const consoleErrorCount = useMemo(
    () => logs.filter(l => l.level === 'error').length,
    [logs]
  );
  const consoleWarningCount = useMemo(
    () => logs.filter(l => l.level === 'warn').length,
    [logs]
  );

  const filteredLogs = useMemo(() => {
    const bySearch = consoleSearch.trim().toLowerCase();
    return logs.filter(l => {
      if (consoleFilter !== 'all' && l.level !== consoleFilter) return false;
      if (bySearch) {
        const haystack = `${l.message} ${l.requestName ?? ''} ${l.detail ?? ''}`.toLowerCase();
        if (!haystack.includes(bySearch)) return false;
      }
      return true;
    });
  }, [logs, consoleFilter, consoleSearch]);

  useEffect(() => {
    if (!consoleOpen) return;
    const el = consoleLogListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filteredLogs, consoleOpen]);

  const handleCopyResponse = useCallback(async () => {
  if (!activeTab?.response) return;
  const body = activeTab.response.parsedBody;
  const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setCopiedResponse(true);
    setTimeout(() => setCopiedResponse(false), 1500);
  } catch (e) {
    console.log('Copy error:', e);
  }
  }, [activeTab]);

  // "Save as Example" no painel de resposta — segunda forma de criar um
  // Saved Example (a primeira é "Add Example" vazio, pelo menu de contexto
  // da árvore). Igual o Postman: pega a resposta atual e salva como filho
  // da própria request na árvore, já abrindo o editor pra dar um nome.
  const handleSaveResponseAsExample = useCallback(() => {
    if (!activeTab?.response) return;

    // A tab só corresponde a um node real da árvore se o id dela existir lá
    // (tabs "soltas"/não salvas não têm onde pendurar o example).
    const requestNode = findNodeById(collections, activeTab.id);
    if (!requestNode || requestNode.type !== 'request') {
      toast.error('Save the request in a collection before adding an example to it.');
      return;
    }

    const newExample: CollectionItem = {
      id:   crypto.randomUUID(),
      name: `${activeTab.response.status} ${getStatusText(activeTab.response.status)}`,
      type: 'example',
      method: requestNode.method,
      // Snapshot da request original no momento do save — mesmo padrão que
      // createExample (useCollectionTree.ts) usa pro "Add Example" vazio, e
      // o que o Postman de verdade guarda em cada Saved Example.
      request: requestNode.request ? { ...requestNode.request } : undefined,
      example: exampleFromResponse(activeTab.response),
    };

    setCollections(prev => addNode(prev, activeTab.id, newExample));
    // Abre direto como aba, igual o Postman — sem painel lateral.
    handleRequestSelect(newExample);
  }, [activeTab, collections, handleRequestSelect]);

  // "Try" de um example: abre a request dele numa aba nova (solta, fora da
  // collection) e envia lá. O example em si nunca recebe a resposta — só se
  // o usuário clicar em "Update example" na aba de Try.
  const pendingTrySendRef = useRef<string | null>(null);
  const handleTryExample = useCallback(() => {
    const tab = activeTab;
    if (!tab || tab.kind !== 'example') return;

    const tryTab: Tab = {
      ...tab,
      id: crypto.randomUUID(),
      name: `${tab.name} (Try)`,
      kind: 'request',
      exampleDraft: undefined,
      tryOfExampleId: tab.id,
      response: null,
      responseTime: 0,
      testResults: undefined,
      isDirty: false,
      // Cópias, pra editar a aba de Try não mexer no example.
      requestHeadersValue: tab.requestHeadersValue.map(h => ({ ...h, id: crypto.randomUUID() })),
      params: tab.params.map(p => ({ ...p, id: crypto.randomUUID() })),
      queryParams: tab.queryParams.map(p => ({ ...p, id: crypto.randomUUID() })),
    };
    pendingTrySendRef.current = tryTab.id;
    setTabs(prev => [...prev, tryTab]);
    setActiveTabId(tryTab.id);
  }, [activeTab]);
  useEffect(() => {
    tryExampleRef.current = handleTryExample;
  }, [handleTryExample]);

  // Envia a aba de Try assim que ela vira a aba ativa (handleSendRequest
  // sempre age sobre a aba ativa).
  useEffect(() => {
    if (pendingTrySendRef.current && activeTab?.id === pendingTrySendRef.current) {
      pendingTrySendRef.current = null;
      handleSendRequest('send');
    }
  }, [activeTab?.id, handleSendRequest]);

  // Grava a resposta da aba de Try no example de origem — ação explícita.
  const handleUpdateExampleFromResponse = useCallback(() => {
    const tab = activeTab;
    if (!tab?.response || !tab.tryOfExampleId) return;
    const exampleNode = findNodeById(collections, tab.tryOfExampleId);
    if (!exampleNode || exampleNode.type !== 'example') {
      toast.error('The original example no longer exists.');
      return;
    }

    const updated = exampleFromResponse(tab.response, exampleNode.example?.previewLanguage);
    setCollections(prev => patchNode(prev, exampleNode.id, { example: updated }));
    // Aba do example aberta: mostra a resposta nova lá também.
    setTabs(prev => prev.map(t => (t.id === exampleNode.id ? { ...t, exampleDraft: toExampleDraft(updated) } : t)));
    toast.success(`Example "${exampleNode.name}" updated with this response.`);
  }, [activeTab, collections]);

const handleGitHubPull = useCallback(async (rawData: unknown) => {
  const result = importData(rawData);
  const workspace = selectedWorkspaceRef.current; // ✅ sempre atual
  if (result.collections) {
    const fixedCollections = backfillExampleRequests(result.collections);
    suppressPendingMarkRef.current = true;
        suppressEnvPendingMarkRef.current = true;
    setCollections(fixedCollections);
    await saveWorkspaceCollections(workspace, fixedCollections);
  }
  clearWorkspacePendingPush(workspace);
  setPendingPush(EMPTY_PENDING);
  if (result.environments) {
    setEnvironments(result.environments);
    await saveWorkspaceEnvironments(workspace, result.environments);
    setEnvVersion(v => v + 1);
  }
  setImportToast(result);
  setTimeout(() => setImportToast(null), 5000);
}, [importData, setEnvironments]); // selectedWorkspace removido das deps

  const handleGitHubPullEnvironments = useCallback(async (rawData: unknown) => {
    const result = importData(rawData);

    if (result.environments) {
      const incoming = result.environments.map(env => ({
        id: env.id,
        name: env.name,
        values: env.values.map(v => ({
          id: crypto.randomUUID(),
          key: v.key,
          value: v.value,
          enabled: v.enabled,
          type: v.type,
          // Descrição acompanha: sem isto, um pull apagava a documentação
          // das variáveis toda vez.
          description: v.description,
        })),
        color: undefined,
        _postman_variable_scope: 'environment',
      }));

      // ✅ dedup por id — mantém a última ocorrência
      const deduped = Array.from(
        new Map(incoming.map(env => [env.id, env])).values()
      );

      setEnvironments(deduped);

      await saveWorkspaceEnvironments(selectedWorkspace, deduped);
      setEnvVersion(v => v + 1);
    } else {
      // Workspace sem environments válidos no GitHub: o pull substitui pelo
      // que veio de lá, que é nada.
      setEnvironments([]);
      await saveWorkspaceEnvironments(selectedWorkspace, []);
      setEnvVersion(v => v + 1);
    }

    setImportToast(result);
    setTimeout(() => setImportToast(null), 5000);
  }, [importData, setEnvironments, selectedWorkspace]); // ✅

  // Pull de TODOS os workspaces do repositório (GitHubStorageClient chama
  // isso uma vez por workspace remoto encontrado). Diferente do
  // handleGitHubPull acima, aqui o workspace-alvo é um parâmetro — não é
  // necessariamente o workspace ativo no app — então:
  //   1. garante que o workspace existe localmente (cria se precisar);
  //   2. persiste os dados direto no storage daquele workspace;
  //   3. só atualiza o estado em tela (setCollections/setEnvironments) se
  //      for, por coincidência, o workspace que já está ativo agora.
  const handlePullWorkspaceData = useCallback(async (
    workspaceName: string,
    rawCollections: unknown[],
    rawEnvironments: unknown[]
  ) => {
    if (!workspaceName) return;

    const existing = await listWorkspaces();
    if (!existing.some(w => w.path === workspaceName)) {
      await createWorkspaceStore(workspaceName);
    }

    const collectionsResult = importData(rawCollections);
    let collections = backfillExampleRequests(collectionsResult.collections ?? []);

    let environments: Environment[] = [];
    const environmentsResult = importData(rawEnvironments);
    if (environmentsResult.environments) {
      const incoming = environmentsResult.environments.map(env => ({
        id: env.id,
        name: env.name,
        values: env.values.map(v => ({
          id: crypto.randomUUID(),
          key: v.key,
          value: v.value,
          enabled: v.enabled,
          type: v.type,
          description: v.description,
        })),
        color: undefined,
        _postman_variable_scope: 'environment',
      }));
      environments = Array.from(new Map(incoming.map(env => [env.id, env])).values());
    }

    const { collections: existingCollections } = await loadWorkspaceLocalData(workspaceName);

    // Pelo mesmo motivo dos ambientes locais: favoritar é marca pessoal e não
    // sobe pro GitHub, então nunca volta num pull. Como o pull substitui a
    // árvore inteira, sem recolocar as marcas daqui baixar atualizações
    // apagaria os favoritos do usuário.
    const starMarks = collectStarMarks(
      Array.isArray(existingCollections) ? existingCollections : []
    );
    collections = applyStarMarks(collections, starMarks);

    await Promise.all([
      saveWorkspaceCollections(workspaceName, collections),
      saveWorkspaceEnvironments(workspaceName, environments),
    ]);

    // O local desse workspace acabou de ser substituído pelo remoto, então
    // não há mais nada "salvo mas não enviado" nele.
    clearWorkspacePendingPush(workspaceName);

    if (selectedWorkspaceRef.current === workspaceName) {
      suppressPendingMarkRef.current = true;
        suppressEnvPendingMarkRef.current = true;
      setCollections(collections);
      setEnvironments(environments);
      setEnvVersion(v => v + 1);
      setPendingPush(EMPTY_PENDING);
    }
  }, [importData, setEnvironments]);

  // Pull de um workspace só, disparado pelo ícone no menu de workspaces —
  // delega pro GitHubSync (que baixa/descriptografa e chama
  // handlePullWorkspaceData acima pra persistir).
  const handlePullSingleWorkspace = useCallback(async (workspaceName: string) => {
    await githubSyncRef.current?.pullWorkspace(workspaceName);
  }, []);

  // Push de um workspace só (não necessariamente o selecionado agora),
  // disparado pelo ícone ao lado do Pull no menu de workspaces — delega pro
  // GitHubSync, que carrega os dados locais desse workspace direto do
  // storage e envia só eles, sem afetar os outros workspaces.
  const handlePushSingleWorkspace = useCallback(async (workspaceName: string) => {
    await githubSyncRef.current?.pushWorkspace(workspaceName);
  }, []);

  // Abre a janela de histórico de commits do workspace (ícone de relógio no
  // menu de workspaces) — de lá dá pra baixar o estado dos arquivos em um
  // commit específico, e não só a versão mais recente da branch.
  const handleOpenCommitHistory = useCallback((workspaceName: string) => {
    githubSyncRef.current?.openCommitHistory(workspaceName);
  }, []);

  // Push concluído com sucesso: local e remoto voltaram a bater.
  const handlePushCompleted = useCallback((workspaceName: string) => {
    clearWorkspacePendingPush(workspaceName);
    if (workspaceName === selectedWorkspaceRef.current) {
      setPendingPush(EMPTY_PENDING);
      // O que acabou de ser enviado vira o estado comum: a partir daqui, só
      // o que mudar AQUI conta como trabalho local numa comparação.
      void recordSyncBase(workspaceName, nodeHashes(collectionsRef.current));
    }
  }, []);

  // Compara o remoto recém-buscado com o que está na tela, sem aplicar nada.
  //
  // Passa o remoto pelo MESMO importData/backfill do pull antes de comparar.
  // Sem isso a comparação seria entre formatos diferentes (o do arquivo e o
  // da árvore) e acusaria diferença em toda collection, sempre.
  const handleCompareRemote = useCallback((
    _workspaceName: string,
    rawCollections: unknown[]
  ) => {
    const imported = importData(rawCollections);
    const remoteTree = backfillExampleRequests(imported.collections ?? []);
    const comparison = compareWorkspaces(collections, remoteTree);

    const names = new Map<string, string>();
    for (const c of [...collections, ...remoteTree]) {
      if (c?.id) names.set(c.id, c.name);
    }
    const summary = describeComparison(comparison, id => names.get(id));

    const nodes = diffTrees(collections, remoteTree);

    // Guarda o diff e abre a tela de revisão. A frase de status continua
    // existindo pra quem fecha a janela sem decidir nada.
    setDiffNodes(nodes);
    setDiffNames(names);
    setDiffRemoteTree(remoteTree);
    setDiffTarget('collections');
    void loadSyncBase(selectedWorkspaceRef.current).then(setDiffBase);
    if (nodes.length > 0) setDiffOpen(true);

    if (nodes.length === 0) return summary;
    return `${summary} (${nodes.length} item${nodes.length === 1 ? '' : 's'})`;
  }, [collections, importData]);

  // Pull com comparação dos ENVIRONMENTS. Mesmo fluxo do de collections, com
  // outra fonte: o diff e a tela são os mesmos (ver environmentDiff).
  const handlePullEnvironments = useCallback(async () => {
    if (pullingCollectionRef.current) return;
    pullingCollectionRef.current = true;

    const workspace = selectedWorkspaceRef.current;
    try {
      const remote = await githubSyncRef.current?.fetchWorkspace(
        workspace,
        undefined,
        'Checking environments on GitHub...'
      );
      if (!remote) return;

      const imported = importData(remote.environments);
      const remoteEnvs = imported.environments ?? [];
      const nodes = diffEnvironments(environments, remoteEnvs);

      if (nodes.length === 0) {
        toast.success('Environments already match GitHub.');
        return;
      }

      const names = new Map<string, string>();
      for (const e of [...environments, ...remoteEnvs]) names.set(e.id, e.name);

      setDiffNodes(nodes);
      setDiffNames(names);
      setDiffRemoteEnvs(remoteEnvs);
      setDiffTarget('environments');
      // Environments não entram na base: lá a identidade é a key da
      // variável, não um id de nó.
      setDiffBase(null);
      setDiffOpen(true);
    } catch (e) {
      toast.error('Could not read GitHub', { description: (e as Error)?.message ?? String(e) });
    } finally {
      pullingCollectionRef.current = false;
    }
  }, [environments, importData]);

  const handleApplyDiff = useCallback(async (selectedIds: Set<string>, overrides: OverrideMap) => {
    const workspace = selectedWorkspaceRef.current;

    if (diffTarget === 'environments') {
      const merged = applyEnvironmentChanges(environments, diffRemoteEnvs, selectedIds, overrides);
      // Suprime a marcação automática pelo mesmo motivo do de collections: a
      // mescla não é "edição local", boa parte dela acabou de vir de lá.
      suppressEnvPendingMarkRef.current = true;
      setEnvironments(merged);
      setDiffOpen(false);
      return;
    }

    const merged = applySelectedChanges(collections, diffRemoteTree, selectedIds, overrides);

    // Suprime a marcação automática: o efeito de `collections` acusaria a
    // mescla inteira como edição local, quando boa parte dela acabou de vir
    // do GitHub e já está igual lá.
    suppressPendingMarkRef.current = true;
    setCollections(merged);
    await saveWorkspaceCollections(workspace, merged);

    // E recalcula a pendência comparando o resultado com o remoto. Zerar tudo
    // (o que o pull faz) passaria a mentir depois de uma aplicação parcial:
    // o que foi recusado continua diferente lá, e continua esperando push.
    //
    // `requiresFullPush` é preservado: ele marca uma collection APAGADA
    // localmente, que não tem id pra reaparecer na comparação — recalcular
    // sem ele esqueceria a exclusão, e o arquivo ficaria órfão no remoto.
    // Conflito no push: o envio recomeça com o resultado da mescla.
    // Reenviar o item ANTIGO mandaria de volta exatamente a versão que
    // acabou de ser reconciliada.
    const pending = pushAfterDiff;
    setPushAfterDiff(null);
    if (pending) {
      const reconciled = findNodeById(merged, pending.id);
      if (reconciled) {
        setDiffOpen(false);
        try {
          // Direto pelo ref, e não pelo handlePushCollection: aquele é
          // declarado depois daqui, e citá-lo na lista de dependências
          // quebraria no render. Um segundo conflito aqui também não deve
          // reabrir esta tela — seria um laço — e o painel de sync já diz.
          await githubSyncRef.current?.pushCollection(reconciled);
        } catch {
          /* reportado pelo painel de sync */
        }
      }
    }

    const hadRemovals = readPendingPush(workspace).requiresFullPush;
    clearWorkspacePendingPush(workspace);
    const stillDiffer = compareWorkspaces(merged, diffRemoteTree);
    const pendingIds = [...stillDiffer.modified, ...stillDiffer.onlyLocal];
    if (pendingIds.length > 0) markCollectionsPendingPush(workspace, pendingIds);

    // O remoto que acabou de ser visto vira o estado comum: é dele que os
    // dois lados passam a divergir. Gravar a MESCLA diria que o que você
    // recusou já está lá.
    void recordSyncBase(workspace, nodeHashes(diffRemoteTree));
    if (hadRemovals) markFullPushRequired(workspace);
    setPendingPush(readPendingPush(workspace));

    setDiffOpen(false);
    // `diffTarget`, `environments` e `diffRemoteEnvs` entram de verdade: sem
    // eles o callback aplicaria o ramo de environment com dados congelados da
    // primeira renderização — e escreveria valores velhos por cima dos atuais.
  }, [collections, diffRemoteTree, diffTarget, environments, diffRemoteEnvs, setEnvironments, pushAfterDiff]);

  // Baixar o que mudou no GitHub SÓ desta collection e abrir a comparação.
  //
  // Busca o workspace inteiro (os arquivos remotos são por collection, mas a
  // resolução de caminhos é do workspace) e então FILTRA o diff pelo id dela.
  // Filtrar basta pra limitar o alcance: o applySelectedChanges só altera o
  // que está selecionado, e aqui não há como selecionar nó de outra.
  const handlePullCollection = useCallback(async (item: CollectionItem) => {
    // Clicar duas vezes dispararia duas buscas e abriria a janela com o
    // resultado da que terminasse por último — que não é necessariamente a
    // última pedida.
    if (pullingCollectionRef.current) return;
    pullingCollectionRef.current = true;

    const workspace = selectedWorkspaceRef.current;
    try {
      const remote = await githubSyncRef.current?.fetchWorkspace(
        workspace,
        undefined,
        `Checking "${item.name}" on GitHub...`
      );
      if (!remote) return;

      const imported = importData(remote.collections);
      const remoteTree = backfillExampleRequests(imported.collections ?? []);
      // Recorta pela SUBÁRVORE: numa Sprint com cinco User Stories, trazer a
      // atualização de uma sem mexer nas outras é o caso comum. Numa
      // collection raiz o recorte coincide com ela inteira.
      const nodes = filterSubtree(diffTrees(collections, remoteTree), item.id);

      if (nodes.length === 0) {
        toast.success(`"${item.name}" already matches GitHub.`);
        return;
      }

      const names = new Map<string, string>();
      for (const c of [...collections, ...remoteTree]) {
        if (c?.id) names.set(c.id, c.name);
      }

      setDiffNodes(nodes);
      setDiffNames(names);
      setDiffRemoteTree(remoteTree);
      setDiffTarget('collections');
      setDiffBase(await loadSyncBase(workspace));
      setDiffOpen(true);
    } catch (e) {
      toast.error('Could not read GitHub', {
        description: (e as Error)?.message ?? String(e),
      });
    } finally {
      pullingCollectionRef.current = false;
    }
  }, [collections, importData]);

  /**
   * Responde "tem algo novo?" sem abrir a revisão.
   *
   * O pull também avisa quando não há nada — mas quando HÁ, ele já entra na
   * tela de comparação. Querer só saber, para decidir a hora de mexer, era
   * um caminho que não existia: a verificação do workspace inteiro vive no
   * painel de sync e abre a mesma tela.
   *
   * A resposta vem num toast com atalho para revisar, então saber e agir
   * continuam a um clique de distância.
   */
  const handleCheckCollectionUpdates = useCallback(async (item: CollectionItem) => {
    if (pullingCollectionRef.current) return;
    pullingCollectionRef.current = true;

    try {
      const remote = await githubSyncRef.current?.fetchWorkspace(
        selectedWorkspaceRef.current,
        undefined,
        `Checking "${item.name}" on GitHub...`
      );
      if (!remote) return;

      const remoteTree = backfillExampleRequests(importData(remote.collections).collections ?? []);
      const nodes = filterSubtree(diffTrees(collections, remoteTree), item.id);

      if (nodes.length === 0) {
        toast.success(`"${item.name}" is up to date.`);
        return;
      }

      const added = nodes.filter(n => n.change === 'added').length;
      const removed = nodes.filter(n => n.change === 'removed').length;
      const changed = nodes.length - added - removed;
      const parts = [
        changed > 0 ? `${changed} changed` : null,
        added > 0 ? `${added} only on GitHub` : null,
        removed > 0 ? `${removed} only here` : null,
      ].filter(Boolean);

      toast.info(
        `${nodes.length} difference${nodes.length === 1 ? '' : 's'} in "${item.name}"`,
        {
          description: parts.join(' · '),
          duration: 10000,
          action: { label: 'Review', onClick: () => { void handlePullCollection(item) } },
        }
      );
    } catch (e) {
      toast.error('Could not read GitHub', { description: (e as Error)?.message ?? String(e) });
    } finally {
      pullingCollectionRef.current = false;
    }
  }, [collections, importData, handlePullCollection]);

  // Enviar UMA collection pela árvore. O erro é engolido de propósito: o
  // painel de sync já mostra o motivo (conflito, falta de passphrase, rede),
  // e deixar a exceção subir daqui derrubaria o clique num menu de contexto.
  const handlePushCollection = useCallback(async (item: CollectionItem) => {
    try {
      await githubSyncRef.current?.pushCollection(item);
    } catch (e) {
      // Alguém enviou esta collection depois do seu último sync. Antes a
      // mensagem mandava "dê um pull antes" e parava aí — e o pull é outro
      // menu, noutro item, que depois exige voltar e clicar em enviar de
      // novo. No meio desse caminho é fácil enviar assim mesmo e passar por
      // cima do trabalho do colega.
      //
      // Agora o conflito abre a própria tela de comparação, e o envio
      // continua sozinho quando a mescla é aplicada.
      if (e instanceof GitHubConflictError) {
        setPushAfterDiff(item);
        await handlePullCollection(item);
        return;
      }
      /* o resto já foi reportado pelo painel de sync */
    }
  }, [handlePullCollection]);

  // Limpa a pendência SÓ desta collection. Usar o handlePushCompleted aqui
  // zeraria o workspace inteiro e apagaria o aviso das outras collections que
  // continuam esperando push — e de uma exclusão pendente, que só o push
  // completo resolve.
  const handleCollectionPushed = useCallback((collectionId: string) => {
    if (!collectionId) return;
    const workspace = selectedWorkspaceRef.current;
    clearCollectionsPendingPush(workspace, [collectionId]);
    setPendingPush(readPendingPush(workspace));

    // Só esta collection entra na base: enviar uma não torna as outras
    // sincronizadas, e gravar a árvore toda diria que ficaram.
    const sent = collectionsRef.current.find(c => c.id === collectionId);
    if (sent) void recordSyncBase(workspace, nodeHashes([sent]));
  }, []);

  // O indicador é por workspace, então recalcula ao trocar de workspace.
  //
  // E zera as impressões da árvore junto: elas são do workspace anterior, e
  // comparar contra elas faria a primeira edição no workspace novo acusar
  // TODAS as collections como alteradas — nada em comum entre as duas
  // árvores. As impressões do workspace novo são tiradas no próximo passe dos
  // efeitos de collections/environments.
  useEffect(() => {
    setPendingPush(readPendingPush(selectedWorkspace));
    rootPrintsRef.current = new Map();
    envPrintsRef.current = new Map();
    suppressPendingMarkRef.current = true;
    suppressEnvPendingMarkRef.current = true;
  }, [selectedWorkspace]);

  // ── Servidor MCP (Claude Code → DevFlow) ────────────────────────────────
  // Grava um script na request. Só mexe no estado local (a persistência e a
  // marcação de "pendente de push" acontecem no efeito que salva
  // collections); nunca envia pro GitHub — um agente iterando sobre um
  // script não pode virar uma enxurrada de commits.
  const handleMcpSetRequestScript = useCallback(
    async (requestId: string, phase: 'preRequest' | 'postResponse', code: string) => {
      const applyToTree = (list: CollectionItem[]): CollectionItem[] =>
        list.map(item => {
          if (item.id === requestId) {
            return {
              ...item,
              request: {
                ...(item.request ?? {} as any),
                scripts: { ...(item.request?.scripts ?? {}), [phase]: code },
              },
            };
          }
          if (item.item) return { ...item, item: applyToTree(item.item) };
          return item;
        });

      setCollections(prev => applyToTree(prev));

      // Se a request estiver aberta numa aba, reflete lá também — senão o
      // editor continuaria mostrando o script antigo.
      // preRequest/postResponse são obrigatórios em Tab['scripts'], então
      // preenche os dois em vez de espalhar só a fase alterada.
      setTabs(prev =>
        prev.map(t =>
          t.id === requestId
            ? {
                ...t,
                scripts: {
                  ...t.scripts,
                  preRequest: phase === 'preRequest' ? code : (t.scripts?.preRequest ?? ''),
                  postResponse: phase === 'postResponse' ? code : (t.scripts?.postResponse ?? ''),
                },
              }
            : t
        )
      );
    },
    []
  );

  // Pastas e requests criadas pelo agente (create_folder / create_request).
  // Mesma regra do script: só estado local, o push continua manual.
  const handleMcpAddCollectionItem = useCallback(
    async (parentId: string | null, node: CollectionItem) => {
      setCollections(prev => (parentId ? addNode(prev, parentId, node) : [...prev, node]));
    },
    []
  );

  // rename_item do MCP: renomeia na árvore e na aba aberta do item (sem
  // marcar a aba como alterada — o nome já está salvo na árvore; deixar a
  // aba com o nome antigo faria o próximo Save desfazer o rename).
  const handleMcpRenameCollectionItem = useCallback(
    async (id: string, name: string) => {
      setCollections(prev => renameNode(prev, id, name));
      setTabs(prev => prev.map(t => (t.id === id ? { ...t, name } : t)));
    },
    []
  );

  // get_oauth2_token do MCP: grava o token na variável do environment. Igual
  // o "Get New Access Token" da aba Authorization: sem marcar o environment
  // pra push (token não deve ir pro GitHub).
  const handleMcpSetEnvironmentVariable = useCallback(
    async (environmentName: string, key: string, value: string) => {
      setEnvironments(prev =>
        prev.map(env => {
          if (env.name !== environmentName) return env;
          const exists = env.values.some(v => v.key === key);
          return {
            ...env,
            values: exists
              ? env.values.map(v => (v.key === key ? { ...v, value, enabled: true } : v))
              : [...env.values, { id: crypto.randomUUID(), key, value, enabled: true, type: 'default' }],
          };
        })
      );
    },
    [setEnvironments]
  );

  // Lido a cada chamada de ferramenta (ver useMcpServer): precisa refletir o
  // estado atual, não o do momento em que o servidor subiu.
  const getMcpContext = useCallback((): McpContext => ({
    workspace: selectedWorkspaceRef.current,
    collections,
    environments,
    activeEnvironmentName: activeEnv?.name,
    // Abas com as respostas já carregadas: é o que permite responder sobre
    // "o body que está na tela" sem reexecutar a request.
    tabs,
    activeTabId,
    consoleLogs: logs,
    setRequestScript: handleMcpSetRequestScript,
    addCollectionItem: handleMcpAddCollectionItem,
    renameCollectionItem: handleMcpRenameCollectionItem,
    setEnvironmentVariable: handleMcpSetEnvironmentVariable,
  }), [collections, environments, activeEnv?.name, tabs, activeTabId, logs, handleMcpSetRequestScript, handleMcpAddCollectionItem, handleMcpRenameCollectionItem, handleMcpSetEnvironmentVariable]);

  const mcp = useMcpServer(getMcpContext);

  // Extensões: mesmo contexto de execução do MCP — a API que a extensão usa
  // e a que o Claude usa são a mesma, definida uma vez só (ver mcpTools.ts).
  const extensionHost = useExtensionHost(getMcpContext, message => {
    pushLog('info', message, { source: 'system' });
  });

  // Painel do Claude (modo headless). Recebe a ponte do MCP pra já mandar
  // o --mcp-config apontando pro servidor local — assim o Claude enxerga
  // as collections sem o usuário configurar nada por fora.
  const [claudePanelOpen, setClaudePanelOpen] = useState(false);
  const claudeChat = useClaudeChat({
    port: mcp.port,
    token: mcp.token,
    enabled: mcp.enabled,
  });

  // Texto exatamente como vai pro `value` do Editor de response — memoizado
  // porque também é usado pra saber quando o Monaco terminou de trocar o
  // conteúdo pro da aba nova (ver applySavedResponsePosition).
  const responseBodyText = useMemo(
    () => (activeTab?.response?.parsedBody ? JSON.stringify(activeTab.response.parsedBody, null, 2) : '{}'),
    [activeTab?.response?.parsedBody]
  );
  const responseBodyTextRef = useRef(responseBodyText);
  responseBodyTextRef.current = responseBodyText;

  // Enquanto a busca está sendo restaurada programaticamente, os eventos de
  // mudança do find widget não devem ser gravados (senão a restauração da
  // aba nova acabaria sobrescrevendo o estado dela mesma no meio do caminho).
  const restoringSearchRef = useRef(false);

  // Reabre (ou fecha) o Ctrl+F do response com o termo que a aba tinha.
  const applySavedResponseSearch = useCallback((tabId: string | null) => {
    const editorInstance = responseEditorInstanceRef.current;
    if (!editorInstance || !tabId) return;

    // `editor.contrib.findController` é API interna do Monaco — daí o
    // acesso todo opcional/try-catch: se mudar de nome numa versão futura a
    // feature simplesmente para de restaurar, sem quebrar o editor.
    try {
      const controller: any = editorInstance.getContribution?.('editor.contrib.findController');
      if (!controller) return;

      const saved = responseSearches.get(tabId);
      const state = controller.getState?.();

      restoringSearchRef.current = true;

      if (saved?.isRevealed && saved.query) {
        controller.start?.({
          forceRevealReplace: false,
          seedSearchStringFromSelection: 'none',
          seedSearchStringFromNonEmptySelection: false,
          seedSearchStringFromGlobalClipboard: false,
          shouldFocus: 0, // NoFocusChange — não rouba o foco ao trocar de aba
          shouldAnimate: false,
          updateSearchScope: false,
          loop: true,
        });
        controller.setSearchString?.(saved.query);
      } else if (state?.isRevealed) {
        // A aba não tinha busca aberta — fecha a que ficou da aba anterior.
        controller.closeFindWidget?.();
      }
    } catch (e) {
      console.log('Não foi possível restaurar a busca do response:', e);
    } finally {
      restoringSearchRef.current = false;
    }
  }, []);

  const applySavedResponsePosition = useCallback((tabId: string | null, expectedText: string) => {
  const editorInstance = responseEditorInstanceRef.current;
  if (!editorInstance || !tabId) return;

  const saved = responsePositions.get(tabId);
  if (!saved) return;

  // A posição foi salva sobre um corpo diferente do que essa aba tem agora
  // (ex: a request foi reenviada e o response mudou) — nesse caso não faz
  // sentido "voltar pra linha 31" de um conteúdo que não existe mais.
  if (saved.contentLength !== expectedText.length) return;

  // Só posiciona depois que o MODEL já contém o conteúdo da aba nova.
  // Bug anterior: a espera era só `getLineCount() >= saved.lineNumber`, o
  // que já era verdade contra o conteúdo AINDA ANTIGO quando se vinha de
  // uma aba com response maior. O cursor era movido no texto velho e, logo
  // depois, o Monaco trocava o texto e resetava tudo pra linha 1 — daí a
  // sensação de que a feature "não funcionava" ao alternar de aba.
  let attempts = 0;
  const tryApply = () => {
    const model = editorInstance.getModel?.();
    if (
      model &&
      model.getValueLength() === expectedText.length &&
      model.getLineCount() >= saved.lineNumber
    ) {
      editorInstance.setPosition({ lineNumber: saved.lineNumber, column: saved.column });
      editorInstance.revealLineInCenter(saved.lineNumber);
      return;
    }
    if (attempts++ < 30) requestAnimationFrame(tryApply);
  };
  tryApply();
}, []);

const handleResponseEditorMount: OnMount = useCallback((editorInstance) => {
  responseEditorInstanceRef.current = editorInstance;
  applySavedResponsePosition(activeTabIdRef.current, responseBodyTextRef.current);
  applySavedResponseSearch(activeTabIdRef.current);

  // Salva a posição continuamente a cada clique/movimento de cursor — não
  // só no cleanup do useEffect abaixo ao trocar de aba. O cleanup sozinho
  // dependia do editor ainda estar montado E de getPosition() ser chamado
  // antes do React descartar a instância; salvando ao vivo isso não depende
  // mais de acertar esse timing.
  const cursorDisposable = editorInstance.onDidChangeCursorPosition((e: any) => {
    // reason 1 = ContentFlush: não foi o usuário que moveu o cursor, foi o
    // Monaco resetando pra linha 1 porque o texto do editor acabou de ser
    // trocado (troca de aba / response novo). Gravar isso apagava a posição
    // salva JUSTAMENTE da aba que estava sendo aberta — o `value` novo
    // chega depois do activeTabId já ter mudado, então o reset era
    // atribuído à aba nova. Essa era a causa principal do bug.
    if (e?.reason === 1) return;

    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const model = editorInstance.getModel?.();
    responsePositions.set(tabId, {
      lineNumber: e.position.lineNumber,
      column: e.position.column,
      contentLength: model ? model.getValueLength() : 0,
    });
  });

  // Guarda o termo/estado do Ctrl+F por aba.
  let findDisposable: any = null;
  try {
    const controller: any = editorInstance.getContribution?.('editor.contrib.findController');
    const state: any = controller?.getState?.();
    findDisposable = state?.onFindReplaceStateChange?.((e: any) => {
      // Só reage a mudanças de termo/abertura. O evento também dispara a
      // cada recontagem de matches — inclusive quando o Monaco recalcula a
      // busca depois de trocar o texto na troca de aba, o que gravaria o
      // termo da aba ANTERIOR na aba nova.
      if (!e?.searchString && !e?.isRevealed) return;
      if (restoringSearchRef.current) return;

      const tabId = activeTabIdRef.current;
      if (!tabId) return;
      responseSearches.set(tabId, {
        query: state.searchString ?? '',
        isRevealed: !!state.isRevealed,
      });
    });
  } catch (e) {
    console.log('Não foi possível observar a busca do response:', e);
  }

  // Se essa instância for descartada (ex: trocou pra uma aba "sem response"
  // e o Editor desmontou), zera a ref pra não deixar código futuro chamando
  // método num editor Monaco já destruído.
  editorInstance.onDidDispose?.(() => {
    findDisposable?.dispose?.();
    cursorDisposable.dispose?.();
    if (responseEditorInstanceRef.current === editorInstance) {
      responseEditorInstanceRef.current = null;
    }
  });
}, [applySavedResponsePosition, applySavedResponseSearch]);

useEffect(() => {
  // Depende de responseBodyText também: o `value` do Monaco só é trocado
  // depois que o activeTabId muda, então reagir apenas à aba tentava
  // posicionar antes do conteúdo certo existir.
  applySavedResponsePosition(activeTabId, responseBodyText);
  applySavedResponseSearch(activeTabId);
}, [activeTabId, responseBodyText, applySavedResponsePosition, applySavedResponseSearch]);

// O ícone do botão de colapsar/expandir volta ao estado "expandido" quando
// troca de aba ou chega uma resposta nova — o Monaco recalcula as regiões
// de fold a partir do texto novo (começa sempre expandido), então o ícone
// precisa acompanhar isso em vez de continuar mostrando "colapsado".
useEffect(() => {
  setIsResponseBodyCollapsed(false);
}, [activeTabId, activeTab?.response]);

const handleToggleResponseBodyCollapse = useCallback(() => {
  const editorInstance = responseEditorInstanceRef.current;
  if (!editorInstance) return;

  if (isResponseBodyCollapsed) {
    editorInstance.getAction('editor.unfoldAll')?.run();
  } else {
    editorInstance.getAction('editor.foldAll')?.run();
  }
  setIsResponseBodyCollapsed(v => !v);
}, [isResponseBodyCollapsed]);

    const isCurrentSessionDirty = useMemo(() => {
  if (!currentSessionId) return false;
  const session = tabSessions.find(s => s.id === currentSessionId);
  if (!session) return false;
  if (session.activeTabId !== activeTabId) return true;

  // A MESMA forma que a gravação usa. Quando as duas discordavam, o arquivo
  // inchava com respostas que a comparação ignorava.
  return !sameSessionTabs(tabs, session.tabs);
  }, [currentSessionId, tabSessions, tabs, activeTabId]);

  const handleTogglePinSession = useCallback((sessionId: string) => {
  setTabSessions(prev => prev.map(s =>
    s.id === sessionId ? { ...s, pinned: !s.pinned } : s
  ));
}, []);

  const handleDuplicateSession = useCallback((sessionId: string) => {
  const source = tabSessions.find(s => s.id === sessionId);
  if (!source) return;

  const copy: TabSession = {
    id: crypto.randomUUID(),
    name: `${source.name} (copy)`,
    tabs: source.tabs,
    activeTabId: source.activeTabId,
    savedAt: Date.now(),
  };
  setTabSessions(prev => [...prev, copy]);
  }, [tabSessions]);

  const [isWorkspaceSynced, setIsWorkspaceSynced] = useState(false);

const handleSyncStatusChange = useCallback((synced: boolean) => {
  setIsWorkspaceSynced(synced);
}, []);


// Exclui um workspace LOCAL por completo: apaga os dados salvos (tabs,
// collections, environments) e remove o registro da lista de workspaces.
// Não mexe em nada no GitHub — só o que está salvo no disco do usuário.
//
// Bug corrigido aqui: antes essa função ignorava qual workspace o usuário
// clicou em "Limpar" no dropdown e sempre operava em cima do workspace
// ATIVO (selectedWorkspaceRef.current), então excluir um workspace
// diferente do selecionado não tinha efeito nenhum visível.
const handleDeleteWorkspace = useCallback(async (path: string) => {
  if (!path) return;

  try {
    await Promise.all([
      saveTabs(path, []),
      saveActiveTabId(path, null),
      saveWorkspaceCollections(path, []),
      saveWorkspaceEnvironments(path, []),
    ]);

    await deleteWorkspaceStore(path);

    // Se o workspace excluído era o ativo, troca pra outro que ainda exista
    // — ou pro estado vazio, se não sobrou nenhum workspace local.
    if (selectedWorkspaceRef.current === path) {
      const remaining = await listWorkspaces();

      if (remaining.length > 0) {
        // handleSelectWorkspace já trata os próprios erros e não deixa o
        // workspace anterior (que acabamos de excluir) travado na tela.
        await handleSelectWorkspace(remaining[0].path);
        return;
      }

      isSwitchingWorkspaceRef.current = true;
      try {
        selectedWorkspaceRef.current = '';
        setSelectedWorkspace('');
        await persistSelectedWorkspace('');
        suppressPendingMarkRef.current = true;
        suppressEnvPendingMarkRef.current = true;
        setTabs([]);
        setActiveTabId(null);
        setCollections([]);
        setEnvironments([]);
      } finally {
        isSwitchingWorkspaceRef.current = false;
      }
    }
  } catch (err) {
    console.error(`Erro ao excluir o workspace "${path}":`, err);
    toast.error(`Não foi possível excluir o workspace "${path}" por completo.`);
  }
}, [handleSelectWorkspace, setEnvironments]);

  if (!hydrated) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-pm-bg text-pm-text-muted text-sm font-sans">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-pm-border border-t-transparent" />
          <span>Loading interface...</span>
        </div>
      </div>
    );
  }

  const renderUrlBar = () => (
    <div className="px-3 py-2.5 bg-pm-bg">
      <div className="flex gap-2 h-9">
        <div className="flex items-center flex-1 bg-pm-bg rounded-lg border border-pm-border focus-within:border-blue-500/50  transition-colors">
          <MethodDropdown
            activeTab={activeTab ?? { method: 'GET' }}
            updateActiveTab={updateActiveTab}
          />
          <div className="w-px h-8 bg-pm-hover mr-2 flex-shrink-0" />
          <UrlInputWithVariables
            value={activeTab?.urlInput ?? ''}
            onChange={handleUrlChange}
            onPathParamsChange={handlePathParamsChange}
            params={activeTab?.params}
           // onValidationChange={setUrlHasError}
          />
          {!!activeTab?.urlInput && (
            <button
              type="button"
              onClick={handleCopyUrl}
              title={copiedUrl ? 'Copied!' : 'Copy URL'}
              className="mr-2 flex shrink-0 items-center justify-center text-pm-text-muted hover:text-pm-text-secondary transition-colors cursor-pointer"
            >
              {copiedUrl ? <Check size={13} className="text-[#68b684]" /> : <Copy size={13} />}
            </button>
          )}
        </div>
        {activeTab?.kind === 'example' ? (
          <button
            onClick={handleTryExample}
            title="Send this example's request in a new tab — the saved response is not changed (Ctrl+Enter)"
            className="h-9 px-5 rounded-lg font-semibold text-[12px] text-white flex items-center gap-1.5 transition-all duration-150 select-none cursor-pointer bg-pm-accent hover:brightness-110 active:brightness-90 flex-shrink-0"
          >
            <ExternalLink size={12} strokeWidth={2.5} />
            <span>Try</span>
          </button>
        ) : (
        <div ref={sendDropdownRef} className="relative flex flex-shrink-0">
          {/* //aqui */}
          <button
            onClick={() => isRequesting ? handleCancelRequest() : handleSendRequest('send')}
            title={isRequesting ? 'Cancel' : 'Send (Ctrl+Enter)'}
            className={`h-9 px-5 rounded-l-lg font-semibold text-[12px] text-white flex items-center gap-1.5 transition-all duration-150 select-none cursor-pointer
              ${isRequesting ? 'bg-red-500 hover:bg-red-500 active:bg-red-700 rounded-r-lg' : 'bg-pm-accent hover:brightness-110 active:brightness-90'}`}
          >
            {isRequesting ? <><X size={12} strokeWidth={2.5} /><span>Cancel</span></> : <span>Send</span>}
          </button>
          {!isRequesting && (
            <>
              <div className="w-px bg-pm-border self-stretch flex-shrink-0" />
              <button
                onClick={() => setIsSendDropdownOpen(v => !v)}
                className={`h-9 w-7 rounded-r-lg text-white flex items-center justify-center cursor-pointer transition-all duration-150 select-none
                  ${isSendDropdownOpen ? 'bg-pm-accent brightness-90' : 'bg-pm-accent hover:brightness-110 active:brightness-90'}`}
              >
                <ChevronDown size={12} strokeWidth={2.5} className={`transition-transform duration-200 ${isSendDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
            </>
          )}
          {isSendDropdownOpen && (
            <div className="absolute top-[calc(100%+6px)] right-0 z-50 bg-pm-sidebar border border-pm-border rounded-xl overflow-hidden shadow-2xl shadow-black/60 min-w-[210px] ring-1 ring-pm-border/40">
              <button onClick={() => { setIsSendDropdownOpen(false); handleSendRequest('send'); }}
                className="flex items-center gap-3 w-full px-4 py-3 text-[12px] text-pm-text hover:bg-pm-hover/70 transition-colors">
                <div className="w-6 h-6 rounded-md bg-pm-accent/15 flex items-center justify-center flex-shrink-0">
                  <Send size={11} className="text-pm-accent" />
                </div>
                <div className="text-left">
                  <div className="font-medium">Send</div>
                  <div className="text-[10px] text-pm-text-muted">Execute and view response</div>
                </div>
              </button>
              <div className="h-px bg-pm-border mx-3" />
              <button onClick={() => { setIsSendDropdownOpen(false); handleSendRequest('send-and-download'); }}
                className="flex items-center gap-3 w-full px-4 py-3 cursor-pointer text-[12px] text-pm-text hover:bg-pm-hover/70 transition-colors">
                <div className="w-6 h-6 rounded-md bg-[#4ff09d]/10 flex items-center justify-center flex-shrink-0">
                  <Download size={11} className="text-[#4ff09d]" />
                </div>
                <div className="text-left">
                  <div className="font-medium">Send and download</div>
                  <div className="text-[10px] text-pm-text-muted">Save response to file</div>
                </div>
              </button>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );

  const handleRenameTab = (tabId: string, newName: string) => {
    // Renomear agora é só uma edição em memória — precisa de Save pra persistir/sincronizar,
    // igual qualquer outra alteração no request.
    setTabs(prev =>
      prev.map(tab =>
        tab.id === tabId ? { ...tab, name: newName, isDirty: true } : tab
      )
    );
  };
  

  // Request "dona" do example aberto / example de origem da aba de Try —
  // mostrados no sub-header com link pra abrir.
  const exampleParentId = activeTab?.kind === 'example' ? findParentId(collections, activeTab.id) : null;
  const exampleParent = exampleParentId ? findNodeById(collections, exampleParentId) : undefined;
  const tryOriginNode = activeTab?.tryOfExampleId ? findNodeById(collections, activeTab.tryOfExampleId) : undefined;
  const tryOrigin = tryOriginNode?.type === 'example' ? tryOriginNode : undefined;

  const renderSubHeader = () => (
    <div className="h-10 flex items-center justify-between bg-pm-bg px-4 border-b border-pm-border/60 flex-shrink-0">

      <div className="flex items-center gap-2 min-w-0">
        {activeTab?.kind === 'example' && (
          <span
            className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-300"
            title="Saved example — sending happens in a separate Try tab"
          >
            Example
          </span>
        )}
        <EditableTitle
          value={activeTab?.name ?? ''}
          onSave={(newName) => {
            if (activeTab?.id) {
              handleRenameTab(activeTab.id, newName);
            }
          }}
        />
        {exampleParent && (
          <button
            type="button"
            onClick={() => handleRequestSelect(exampleParent)}
            title="Open the request this example belongs to"
            className="min-w-0 truncate text-[11px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
          >
            of <span className="font-semibold">{exampleParent.method}</span> {exampleParent.name}
          </button>
        )}
        {tryOrigin && (
          <button
            type="button"
            onClick={() => handleRequestSelect(tryOrigin)}
            title="Open the example this tab was tried from"
            className="min-w-0 truncate text-[11px] text-violet-300/80 hover:text-violet-300 transition-colors cursor-pointer"
          >
            tried from example “{tryOrigin.name}”
          </button>
        )}

      </div>

      <div className="flex items-center gap-2">
        {/* Botão dividido: o Save continua a um clique, e a seta abre o que
            escreve em várias requests. O que protege do engano é a
            confirmação que lista cada alvo, não o botão estar escondido. */}
        {activeTab?.isDirty && (
          <div ref={saveMenuRef} className="relative flex items-center rounded-lg border border-pm-border bg-pm-hover/40">
            <button
              onClick={handleSaveActiveTab}
              title="Save (Ctrl+S)"
              className="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 text-[11px] font-medium rounded-l-lg border-none bg-transparent text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
            >
              <Save size={13} />
              <span>Save</span>
            </button>

            <span className="w-px self-stretch bg-pm-border" />

            <button
              onClick={() => setSaveMenuOpen(v => !v)}
              title="More save options"
              aria-label="More save options"
              className="flex items-center px-1.5 py-1.5 rounded-r-lg border-none bg-transparent text-pm-text-muted hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer"
            >
              <ChevronDown size={12} className={`transition-transform duration-100 ${saveMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {saveMenuOpen && (
              <div className="absolute right-0 top-[calc(100%+4px)] z-[9999] w-[260px] rounded-lg border border-pm-border bg-pm-surface p-1 shadow-2xl">
                <button
                  onClick={() => { setSaveMenuOpen(false); handleSaveToAllWithName() }}
                  className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-pm-hover transition-colors cursor-pointer border-none bg-transparent"
                >
                  <CopyCheck size={13} className="mt-0.5 shrink-0 text-pm-text-muted" />
                  <span className="min-w-0">
                    <span className="block text-[11.5px] font-medium text-pm-text">Save to all with this name</span>
                    <span className="block text-[10.5px] text-pm-text-muted">
                      Overwrites every request named &ldquo;{activeTab.name}&rdquo;
                    </span>
                  </span>
                </button>
              </div>
            )}
          </div>
        )}

        <EnvironmentSelector key={envVersion} workspace={selectedWorkspace} onSaveEnvironment={handleSaveEnvironmentToGitHub} onPullEnvironments={handlePullEnvironments} />

{/* Menu Dropdown de Ferramentas cURL */}
    <div className="relative" ref={toolsMenuRef}>
      <button
        type="button"
        onClick={() => setIsToolsMenuOpen((prev) => !prev)}
        title="cURL and code tools"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-lg transition-all duration-150 cursor-pointer ${
          isToolsMenuOpen
            ? 'bg-pm-hover text-pm-text'
            : 'text-pm-text-muted hover:text-pm-text hover:bg-pm-hover/80'
        }`}
      >
        <Code2 size={14} />
        <MoreHorizontal size={13} />
      </button>

      {/* Popover / Menu Flutuante */}
      {isToolsMenuOpen && (
        <div className="absolute right-0 top-full mt-1.5 w-44 z-50 rounded-lg border border-pm-border bg-pm-surface p-1 shadow-xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100">
          {activeTab?.protocol !== 'grpc' && (
          <button
            type="button"
            onClick={() => {
              setIsToolsMenuOpen(false);
              setIsCurlModalOpen(true);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] font-medium text-pm-text-secondary transition-colors hover:bg-pm-hover hover:text-pm-text cursor-pointer"
          >
            <Globe size={13} className="text-pm-text-muted" />
            <span>Code Snippet</span>
          </button>
          )}

          <button
            type="button"
            onClick={() => {
              setIsToolsMenuOpen(false);
              setImportOpen(true);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[11px] font-medium text-pm-text-secondary transition-colors hover:bg-pm-hover hover:text-pm-text cursor-pointer"
          >
            <Download size={13} className="text-pm-text-muted" />
            <span>Import cURL</span>
          </button>
        </div>
      )}
    </div>

    {/* Modais mantidos fora da estrutura do menu */}
    <CurlModal
      isOpen={isCurlModalOpen}
      onClose={() => setIsCurlModalOpen(false)}
      request={buildSnippetRequest()}
      requestWithComments={buildSnippetRequest(true) ?? undefined}
      requestName={activeTab?.name}
    />

    <ImportCurlDialog
      open={importOpen}
      onClose={() => setImportOpen(false)}
      onImport={handleImportCurl}
    />
  </div>


    </div>
  );



  const renderResponseHeader = () => (
    <div className="h-10 flex items-center justify-between px-3 bg-pm-bg relative overflow-hidden flex-shrink-0">
      {isRequesting && (
        <div className="absolute top-0 left-0 w-full h-[2px] overflow-hidden">
          <div className="devflow-loader" />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-0.5 items-center shrink-0">
        {(['body', 'headers', 'tests'] as const).map((tab) => {
          const testsPassed = activeTab?.testResults?.filter(t => t.passed).length ?? 0;
          const testsTotal = activeTab?.testResults?.length ?? 0;
          return (
            <button
              key={tab}
              onClick={() => setResponseTab(tab)}
              className={`flex items-center gap-1.5 shrink-0 whitespace-nowrap text-[11px] font-medium px-2.5 h-7 rounded-md cursor-pointer transition-colors duration-150 capitalize
                ${responseTab === tab
                  ? 'bg-pm-hover text-pm-text'
                  : 'text-pm-text-muted hover:text-pm-text hover:bg-pm-hover/40'}`}
            >
              {tab === 'tests' ? 'Tests' : tab}
              {tab === 'tests' && testsTotal > 0 && (
                <span className={`shrink-0 min-w-[19px] text-center px-1 h-[15px] leading-[15px] rounded-full text-[10px] font-bold tabular-nums normal-case
                  ${testsPassed === testsTotal
                    ? 'bg-[#4ff09d]/15 text-[#4ff09d]'
                    : 'bg-[#ff7b7b]/15 text-[#ff7b7b]'}`}>
                  {testsPassed}/{testsTotal}
                </span>
              )}
            </button>
          );
        })}

        {responseTab === 'body' && activeTab?.response && !isRequesting && (
          <>
            <div className="w-px h-4 bg-pm-hover mx-1" />

            <button
              onClick={handleToggleResponseBodyCollapse}
              title={isResponseBodyCollapsed ? 'Expand all' : 'Collapse all'}
              className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
            >
              {isResponseBodyCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
            </button>
          </>
        )}

        {responseHistory.length > 0 && !isRequesting && (
          <>
            {/* Só desenha o separador aqui se o botão de colapsar não já
                tiver desenhado um — evita dois traços colados quando os
                dois estão visíveis ao mesmo tempo. */}
            {!(responseTab === 'body' && activeTab?.response) && (
              <div className="w-px h-4 bg-pm-hover mx-1" />
            )}

            <DropdownMenu onOpenChange={(open) => open && refreshResponseHistory()}>
              <DropdownMenuTrigger asChild>
                <button
                  title="Response history"
                  className="h-6 flex items-center gap-1 px-1.5 rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
                >
                  <History size={13} />
                </button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="start" className="w-80 bg-pm-surface border border-pm-border rounded-xl p-1">
                <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-pm-text-muted">
                  Last {responseHistory.length} responses
                </div>
                {responseHistory.map((entry, index) => {
                  const ok = entry.status >= 200 && entry.status < 300;
                  return (
                    <DropdownMenuItem
                      key={entry.savedAt}
                      onClick={() => handleLoadResponseFromHistory(entry)}
                      className="flex flex-col items-stretch gap-1 rounded-lg text-xs cursor-pointer py-2 px-2.5 outline-none focus:bg-pm-hover"
                    >
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            ok ? 'bg-[#4ff09d]/15 text-[#4ff09d]' : 'bg-[#ff7b7b]/15 text-[#ff7b7b]'
                          }`}>
                            {entry.status}
                          </span>
                          <span className="text-[11px] text-pm-text-muted truncate">
                            {new Date(entry.savedAt).toLocaleTimeString()}
                          </span>
                          {index === 0 && (
                            <span className="shrink-0 rounded-full bg-pm-hover px-1.5 py-0.5 text-[9px] font-semibold text-pm-text-muted">
                              latest
                            </span>
                          )}
                        </div>
                        {typeof entry.responseTime === 'number' && (
                          <span className="shrink-0 text-[10px] text-pm-text-muted tabular-nums">
                            {entry.responseTime}ms
                          </span>
                        )}
                      </div>
                      {entry.request && (
                        <div className="flex items-center gap-1.5 min-w-0 pl-0.5">
                          <span className="shrink-0 text-[10px] font-bold text-pm-accent">
                            {entry.request.method}
                          </span>
                          <span className="text-[11px] text-pm-text-muted truncate font-mono">
                            {entry.request.urlInput || '(empty URL)'}
                          </span>
                        </div>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>

      {/* Info + ações */}
      <div className="flex items-center gap-1.5 shrink-0">
        {(isRequesting || activeTab?.response) && (
          <div className="flex items-center gap-1.5">
            {activeTab?.response && !isRequesting && (
              <span className={`px-2 h-6 flex items-center rounded-md border text-[11px] font-bold tracking-wide
                ${activeTab.response.status >= 200 && activeTab.response.status < 300
                  ? 'bg-[#0f3d2a] border-[#1a5c3d] text-[#4ff09d]'
                  : 'bg-[#3d1a1a] border-[#5c2a2a] text-[#ff7b7b]'}`}>
                {activeTab.response.status} {getStatusText(activeTab.response.status)}
              </span>
            )}

            <ResponseTimer isRequesting={isRequesting} startTime={startTime} finalTime={activeTab?.responseTime ?? 0} />

            {activeTab?.response && !isRequesting && (
              <span className="flex items-center gap-1 px-2 h-6 rounded-md bg-pm-hover/50 border border-pm-border text-[11px] font-semibold text-pm-text-secondary tabular-nums">
                <Database size={11} className="text-pm-text-muted" />
                {formatBytes(getResponseSize(activeTab.response))}
              </span>
            )}
          </div>
        )}

        {activeTab?.response && !isRequesting && (
          <>
            <div className="w-px h-4 bg-pm-hover mx-1" />

            <div className="flex items-center gap-0.5">
              {activeTab.tryOfExampleId ? (
                <button
                  onClick={handleUpdateExampleFromResponse}
                  title="Replace the saved response of the original example with this one"
                  className="h-6 flex items-center gap-1 px-2 mr-1 rounded-md text-[11px] font-medium text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 transition-colors cursor-pointer"
                >
                  <FilePlus2 size={12} />
                  Update example
                </button>
              ) : (
                <button
                  onClick={handleSaveResponseAsExample}
                  title="Save this response as an example of the request"
                  className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
                >
                  <FilePlus2 size={13} />
                </button>
              )}

              <button
                onClick={handleDownloadResponse}
                title="Save response"
                className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
              >
                <Download size={13} />
              </button>

              <button
                onClick={handleCopyResponse}
                title={copiedResponse ? 'Copied!' : 'Copy response'}
                className={`h-6 w-6 flex items-center justify-center rounded-md transition-colors cursor-pointer ${
                  copiedResponse ? 'text-[#4ff09d]' : 'text-pm-text-muted hover:text-pm-text hover:bg-pm-hover'
                }`}
              >
                <span className="relative w-[13px] h-[13px] inline-flex items-center justify-center">
                  <Copy size={13} className={`absolute transition-all duration-200 ${copiedResponse ? 'opacity-0 scale-50 rotate-12' : 'opacity-100 scale-100 rotate-0'}`} />
                  <Check size={13} className={`absolute transition-all duration-200 ${copiedResponse ? 'opacity-100 scale-100 rotate-0' : 'opacity-0 scale-50 -rotate-12'}`} />
                </span>
              </button>

              <button
                onClick={handleClearResponseBody}
                title="Clear response"
                className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
              >
                <Trash2 size={13} />
              </button>

              <button
                onClick={handleOpenResponseInNewWindow}
                title="Open in new window"
                className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
              >
                <ExternalLink size={13} />
              </button>
            </div>
          </>
        )}

        <div className="w-px h-4 bg-pm-hover mx-1" />

        <div className="flex items-center gap-0.5 bg-pm-bg border border-pm-border rounded-md p-0.5">
          <button
            onClick={() => setResponseLayout('bottom')}
            title="Response embaixo"
            className={`p-1 rounded cursor-pointer transition-colors ${
              responseLayout === 'bottom' ? 'bg-pm-hover text-pm-text' : 'text-pm-text-muted hover:text-pm-text-secondary'
            }`}
          >
            <Rows2 size={12} />
          </button>
          <button
            onClick={() => setResponseLayout('side')}
            title="Response ao lado"
            className={`p-1 rounded cursor-pointer transition-colors ${
              responseLayout === 'side' ? 'bg-pm-hover text-pm-text' : 'text-pm-text-muted hover:text-pm-text-secondary'
            }`}
          >
            <Columns2 size={12} />
          </button>
        </div>
      </div>
    </div>
  );

  const renderResponseBody = () => {
    // Se o último envio desta aba falhou (erro de rede/conexão/URL inválida
    // etc — ver o catch em handleSendRequest), mostra a tela de erro em vez
    // do body — mesmo que ainda exista uma resposta ANTIGA/bem-sucedida
    // guardada em activeTab.response, senão fica parecendo que a request
    // que falhou na verdade funcionou (mostrando dado desatualizado).
    if (requestError && !isRequesting && responseTab === 'body') {
      return (
        <RequestErrorScreen
          errorMessage={requestError}
          onDebugWithAI={handleDebugWithAI}
          isDebugging={isDebugging}
          aiDebugResult={aiDebugResult}
          onViewConsole={() => setConsoleOpen(true)}
          responseHistory={responseHistory}
          onLoadFromHistory={handleLoadResponseFromHistory}
        />
      );
    }

    return (
      <div className="flex-1 bg-pm-bg overflow-hidden p-2">
        {responseTab === 'body' && (
          isRequesting ? (
            <div className="relative h-full overflow-hidden  ">
              <div className="absolute inset-0 opacity-20 pointer-events-none overflow-hidden">
                <Editor height="100%" defaultLanguage="json" theme={monacoTheme} beforeMount={handleMonacoBeforeMount}
                  value={activeTab?.response?.parsedBody ? JSON.stringify(activeTab.response.parsedBody, null, 2) : '{}'}
                  options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, padding: { top: 10 } }} />
              </div>
              <div className="absolute inset-0 bg-pm-bg/60 backdrop-blur-[2px]" />
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <div className="w-8 h-8 rounded-full border-2 border-pm-accent/30 border-t-pm-accent animate-spin" />
                <span className="text-[11px] text-pm-text-muted">Sending request…</span>
              </div>
            </div>
          ) : activeTab?.response ? (
            <Editor height="100%" defaultLanguage="json" theme={monacoTheme} beforeMount={handleMonacoBeforeMount}
              value={responseBodyText}
              onMount={handleResponseEditorMount}
              options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, padding: { top: 10 }, wordWrap: 'on',  scrollbar: {
              vertical: 'auto',
              horizontal: 'auto',
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 10,
              useShadows: false,
            }, }} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-pm-text-muted">
              <div className="w-12 h-12 rounded-2xl bg-pm-hover/50 flex items-center justify-center">
                <Globe size={22} className="opacity-40" />
              </div>
              <div className="text-center">
                <p className="text-xs font-medium text-pm-text-muted">No response yet</p>
                <p className="text-[11px] text-pm-text-muted mt-0.5">Press Send to execute the request</p>
              </div>
            </div>
          )
        )}
        {responseTab === 'headers' && (
          <div className="h-full overflow-y-auto">
            {activeTab?.response?.headers ? (
              <table className="w-full text-[12px] font-mono border-collapse">
                <tbody>
                  {Object.entries(activeTab.response.headers).map(([key, value]) => (
                    <tr key={key} className="border-b border-pm-border/70 hover:bg-pm-hover/30 transition-colors">
                      <td className="py-2 px-4 text-pm-text-muted font-semibold w-2/5 align-top">{key}</td>
                      <td className="py-2 px-4 text-[#4ff09d] break-all">{String(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-pm-text-muted">
                <p className="text-xs">No headers available</p>
              </div>
            )}
          </div>
        )}
        {responseTab === 'tests' && (
          <div className="h-full overflow-y-auto">
            {activeTab?.testResults && activeTab.testResults.length > 0 ? (
              <div className="flex flex-col gap-1.5 p-1">
                {activeTab.testResults.map((t, i) => (
                  <div
                    key={`${t.name}-${i}`}
                    className={`flex items-start gap-2 px-3 py-2 rounded-md border text-[12px]
                      ${t.passed
                        ? 'bg-[#0f3d2a]/30 border-[#1a5c3d]/60'
                        : 'bg-[#3d1a1a]/30 border-[#5c2a2a]/60'}`}
                  >
                    {t.passed ? (
                      <CheckCircle2 size={14} className="text-[#4ff09d] mt-0.5 shrink-0" />
                    ) : (
                      <XCircle size={14} className="text-[#ff7b7b] mt-0.5 shrink-0" />
                    )}
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className={`font-medium ${t.passed ? 'text-pm-text' : 'text-[#ff7b7b]'}`}>
                        {t.name}
                      </span>
                      {!t.passed && t.message && (
                        <span className="text-[11px] text-pm-text-muted font-mono break-all">{t.message}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-pm-text-muted">
                <p className="text-xs">
                  {activeTab?.scripts?.postResponse?.trim()
                    ? 'No pm.test(...) was executed in this script.'
                    : 'No tests defined. Use pm.test(name, fn) in the Post-response script.'}
                </p>
              </div>
            )}
          </div>
        )}

      </div>
    );
  }
  
  return (
    <div className="h-screen w-screen flex flex-col bg-pm-bg text-pm-text font-sans overflow-hidden select-none">
      <TitleBar
        leftContent={
          <>
            <WorkspaceSelector
              selectedWorkspace={selectedWorkspace}
              isSynced={isWorkspaceSynced}
              onSelectWorkspace={handleSelectWorkspace}
              onCreateWorkspace={handleCreateWorkspace}
              onRenameWorkspace={handleRenameWorkspaceLocal}
                onDeleteWorkspace={handleDeleteWorkspace}
                onPullWorkspace={handlePullSingleWorkspace}
                onPushWorkspace={handlePushSingleWorkspace}
                onOpenCommitHistory={handleOpenCommitHistory}
            />

            <GitHubSync
              ref={githubSyncRef}
              workspace={selectedWorkspace}
              currentCollections={collections}
              currentEnvironments={environments}
              onPullCollections={handleGitHubPull}
              onPullEnvironments={handleGitHubPullEnvironments}
              onImportWorkspace={handleImportWorkspaceFromGitHub}
              onSyncStatusChange={handleSyncStatusChange}
              onPullWorkspaceData={handlePullWorkspaceData}
              // "Não sincronizado" agora cobre dois casos: aba com edição
              // não salva E conteúdo salvo local esperando push — sem o
              // segundo, um Pull sobrescreveria trabalho salvo sem avisar.
              hasUnsyncedChanges={tabs.some(t => t.isDirty) || hasPendingPush}
              hasPendingPush={hasPendingPush}
              onPushCompleted={handlePushCompleted}
              onCollectionPushed={handleCollectionPushed}
              onCompareRemote={handleCompareRemote}
              currentMarkers={markers}
              onPullMarkers={handlePullMarkers}
            />

            <div className="w-[1px] h-3 bg-pm-border ml-2"></div>

            <TabSessionSelector
              sessions={tabSessions}
              workspace={selectedWorkspace}
              onLeaveSession={handleLeaveSession}
              currentSessionId={currentSessionId}
              isCurrentSessionDirty={isCurrentSessionDirty}
              onUpdateCurrentSession={handleUpdateCurrentSession}
              onLoadSession={handleLoadSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={handleRenameSession}
              onDuplicateSession={handleDuplicateSession}
              onTogglePinSession={handleTogglePinSession}
              onConvertToFlow={handleConvertSessionToFlow}
              onNewSession={handleNewSession}
              currentTabCount={tabs.length}
              hasUnsavedTabs={tabs.some(t => t.isDirty)}
            />
          </>
        }
        rightContent={
          <>
            <button
              onClick={handleToggleAlwaysOnTop}
              className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                alwaysOnTop ? 'text-amber-400 hover:text-amber-300 bg-amber-400/10 hover:bg-amber-400/15' : 'text-pm-text-muted hover:text-pm-text hover:bg-pm-hover/80'
              }`}
              title={alwaysOnTop ? 'Unpin window (always on top)' : 'Pin window on top of others'}
            >
              {alwaysOnTop ? <Pin size={16} className="fill-amber-400/30" /> : <PinOff size={16} />}
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-1.5 rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover/80 transition-colors cursor-pointer"
              title="Settings"
            >
              <Settings size={16} />
            </button>
            <UserBadge/>
          </>
        }
      />

      <div className="flex flex-1 overflow-hidden">
        <ResizablePanelGroup groupRef={sidebarGroupRef} orientation="horizontal" className="flex-1">
          <ResizablePanel id="sidebar-panel" defaultSize={20} minSize={0} className="bg-pm-bg">
            <Sidebar
              collections={collections}
              pendingPushIds={pendingCollectionIds}
              //update git v2
              setCollections={setCollections}
              activeId={activeTabId || undefined}
              onRequestSelect={handleRequestSelect}
              onOpenAllRequests={handleOpenAllRequests}
              onRenameItem={handleRenameFromTree}
              onRunCollection={setRunnerItem}
              onLoadTestItem={setLoadTestItem}
              onPushCollection={handlePushCollection}
              onPullCollection={handlePullCollection}
              onCheckUpdates={handleCheckCollectionUpdates}
              onAddExampleItem={handleRequestSelect}
              folderPickMode={!!flowPickerSession}
              pickerLabel={flowPickerSession ? `Select a folder to create the "${flowPickerSession.name}" flow` : undefined}
              onPickFolder={handlePickFlowFolder}
              onCancelPicker={handleCancelFlowPicker}
              markers={markers}
              onMarkersChange={handleMarkersChange}
            />
          </ResizablePanel>
          
          <ResizableHandle className="w-px bg-pm-hover hover:bg-pm-accent/60 transition-colors data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 before:hidden after:w-2" />

          <ResizablePanel id="main-panel" defaultSize={80}>
            <div className="flex flex-col h-full overflow-hidden bg-pm-bg">

          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabClick={setActiveTabId}
            onTabClose={handleCloseTab}
            onTabsReorder={setTabs}
            onNewTab={handleNewTab}
            onCloseOthers={handleCloseOthers}
            onCloseToRight={handleCloseToRight}
            onCloseAll={handleCloseAllTabs}
            currentSessionId={currentSessionId}
            onUpdateCurrentSession={handleUpdateCurrentSession}
            groups={liveTabGroups}
            onGroupsChange={setTabGroups}
          />

              {activeTab ? (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  {renderSubHeader()}
                  <ResizablePanelGroup
                    key="active-tab-group"
                    groupRef={requestGroupRef}
                    orientation={responseLayout === 'side' ? 'horizontal' : 'vertical'}
                    onLayoutChanged={handleRequestLayoutChanged}
                    className="flex-1 min-h-0"
                  >
                <ResizablePanel
                  id="request-panel"
                  defaultSize={getRequestPanelSize(activeTabId)}
                  minSize={20}
                  className="flex flex-col min-h-0 overflow-hidden"
                >
                    {activeTab.protocol === 'grpc' ? (
                      <GrpcRequestPanel
                        grpc={activeTab.grpc ?? emptyGrpcRequest()}
                        onChange={grpc => updateActiveTab({ grpc })}
                        onRun={handleGrpcRun}
                        onSend={handleGrpcSendOnStream}
                        onEndStream={handleGrpcEndStream}
                        onCancel={handleGrpcCancel}
                        isInvoking={isRequesting}
                        stream={activeTab.grpcStream}
                        resolve={resolveWithActiveEnv}
                      />
                    ) : (
                    <>
                    {renderUrlBar()}
                    <div className="flex-1 min-h-0 w-full overflow-hidden flex flex-col">
                      <RequestEditor
                        activeTab={activeTab}
                        updateActiveTab={updateActiveTab}
                        requestBodyValue={activeTab.requestBodyValue}
                        requestHeadersValue={activeTab.requestHeadersValue}
                        updateRequestScript={updateRequestScript}
                        setRequestBodyValue={val => updateActiveTab({ requestBodyValue: val })}
                        setRequestHeadersValue={val => {
                          // Assinatura de updater do React: o valor pode vir
                          // pronto ou como função do valor anterior. O cast
                          // pra `Function` que havia aqui era desnecessário —
                          // o próprio typeof já estreita a união declarada na
                          // prop.
                          const next =
                            typeof val === 'function'
                              ? val(activeTab.requestHeadersValue)
                              : val;
                          updateActiveTab({ requestHeadersValue: next });
                        }}
                        bodyType={activeTab.bodyType}
                        setBodyType={type => updateActiveTab({ bodyType: type })}
                        auth={activeTab.auth}
                        setAuth={updateRequestAuth}
                        
                      />
                    </div>
                    </>
                    )}
                  </ResizablePanel>

                  {/* Divisor */}
                <ResizableHandle
                  className="bg-pm-hover hover:bg-pm-accent/60 transition-colors
                    data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full
                    data-[panel-group-direction=horizontal]:w-px data-[panel-group-direction=horizontal]:h-full
                    focus-visible:bg-pm-accent/60 focus-visible:ring-0 focus-visible:ring-offset-0 before:hidden after:w-2 after:h-2"
                />

                  <ResizablePanel
                  id="response-panel"
                  defaultSize={100 - getRequestPanelSize(activeTabId)}
                    //defaultSize={getPanelSizes(activeTabId)[1]}
                    className="flex flex-col min-h-0 overflow-hidden bg-pm-bg"
                  >
                    {activeTab.protocol === 'grpc' ? (
                      <GrpcResponsePanel
                        result={activeTab.grpcResult}
                        stream={activeTab.grpcStream}
                        error={requestError}
                        isInvoking={isRequesting}
                        responseLayout={responseLayout}
                        onLayoutChange={setResponseLayout}
                      />
                    ) : activeTab.kind === 'example' ? (
                      <ExampleResponseEditor
                        draft={activeTab.exampleDraft ?? toExampleDraft(findNodeById(collections, activeTab.id)?.example)}
                        onChange={exampleDraft => updateActiveTab({ exampleDraft })}
                        onTry={handleTryExample}
                        responseLayout={responseLayout}
                        onLayoutChange={setResponseLayout}
                      />
                    ) : (
                      <>
                        {renderResponseHeader()}
                        {renderResponseBody()}
                      </>
                    )}
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
                 ) : (
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  {renderSubHeader()}
                  <ResizablePanelGroup key="empty-state-group" orientation={responseLayout === 'side' ? 'horizontal' : 'vertical'} className="flex-1 min-h-0">
                    <ResizablePanel id="empty-request-panel" defaultSize={50} minSize={20} className="flex flex-col min-h-0 overflow-hidden">
                      {renderUrlBar()}
                      <div className="flex-1 flex items-center justify-center text-pm-text-muted min-h-0">
                        <div className="text-center">
                          <div className="w-14 h-14 rounded-2xl bg-pm-hover/40 flex items-center justify-center mx-auto mb-3">
                            <Plus size={20} className="opacity-40" />
                          </div>
                          <p className="text-xs font-medium text-pm-text-muted">Open a request to get started</p>
                          <p className="text-[11px] text-pm-text-muted mt-1">Click + to create a new tab</p>
                        </div>
                      </div>
                    </ResizablePanel>
                    <ResizableHandle className="h-px bg-pm-hover hover:bg-pm-accent/60 transition-colors data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 before:hidden after:w-2 after:h-2" />

                    <ResizablePanel id="empty-response-panel" defaultSize={50} className="flex flex-col min-h-0 overflow-hidden bg-pm-bg">
                      {renderResponseHeader()}
                      {renderResponseBody()}
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Painel do Claude: fica fora do ResizablePanelGroup de propósito
            — largura fixa, pra não competir com os tamanhos salvos dos
            painéis de request/response. */}
        <ClaudeChatPanel
          open={claudePanelOpen}
          onClose={() => setClaudePanelOpen(false)}
          chat={claudeChat}
          mcpEnabled={mcp.enabled}
        />
</div>

      <div className="h-6 flex items-center justify-between px-1 bg-pm-hover/40 text-pm-text-secondary text-[11px] font-medium select-none flex-shrink-0 border-t border-pm-border">
        <div className="flex items-center h-full">
          <button
            onClick={toggleSidebar}
            title={sidebarCollapsed ? 'Mostrar sidebar' : 'Ocultar sidebar'}
            className={`h-full px-2 flex items-center gap-1 cursor-pointer transition-colors ${
              sidebarCollapsed ? 'bg-pm-hover' : 'hover:bg-pm-hover'
            }`}
          >
            <PanelLeft size={13} />
          </button>


          <button
            onClick={() => setClaudePanelOpen(prev => !prev)}
            title="Ask Claude about this workspace"
            className={`h-full px-2 flex items-center gap-1 cursor-pointer transition-colors ${
              claudePanelOpen ? 'bg-pm-row-active' : 'hover:bg-pm-hover'
            }`}
          >
            <Sparkles size={11} />
            <span>Claude</span>
          </button>

          <button
            onClick={() => setConsoleOpen(prev => !prev)}
            title="Open application console"
            className={`h-full px-2 flex items-center gap-1 cursor-pointer transition-colors ${
              consoleOpen ? 'bg-pm-row-active' : 'hover:bg-pm-hover'
            }`}
          >
            <span>Console</span>
            {logs.length > 0 && (
              <span className="text-[9px] bg-pm-row-active px-1 rounded-full font-bold leading-none">
                {logs.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center h-full">
          <button
            onClick={() => { setConsoleFilter('warn'); setConsoleOpen(true); }}
            className="h-full px-2 flex items-center gap-1 cursor-pointer hover:bg-pm-hover transition-colors"
            title="Avisos"
          >
            <AlertTriangle size={12} className={consoleWarningCount > 0 ? 'text-amber-400' : undefined} />
            <span>{consoleWarningCount}</span>
          </button>
          <button
            onClick={() => { setConsoleFilter('error'); setConsoleOpen(true); }}
            className="h-full px-2 flex items-center gap-1 cursor-pointer hover:bg-pm-hover transition-colors"
            title="Erros"
          >
            <XCircle size={12} className={consoleErrorCount > 0 ? 'text-red-400' : undefined} />
            <span>{consoleErrorCount}</span>
          </button>

          <div className="w-px h-3 bg-pm-hover mx-1" />

          <div className="flex items-center h-full gap-0.5">
            <button
              onClick={() => setResponseLayout('bottom')}
              title="Response embaixo"
              className={`h-full px-1.5 flex items-center cursor-pointer transition-colors ${
                responseLayout === 'bottom' ? 'bg-pm-row-active text-pm-text' : 'text-pm-text-muted hover:bg-pm-hover hover:text-pm-text-secondary'
              }`}
            >
              <Rows2 size={12} />
            </button>
            <button
              onClick={() => setResponseLayout('side')}
              title="Response ao lado"
              className={`h-full px-1.5 flex items-center cursor-pointer transition-colors ${
                responseLayout === 'side' ? 'bg-pm-row-active text-pm-text' : 'text-pm-text-muted hover:bg-pm-hover hover:text-pm-text-secondary'
              }`}
            >
              <Columns2 size={12} />
            </button>
          </div>

          {/* Fica sempre visível, inclusive em 100%: agora ele não é só um
              indicador de "está fora do normal", é o caminho pra escolher o
              nível — escondido em 100% não haveria como abrir a lista. */}
          <div className="w-px h-3 bg-pm-hover mx-1" />
          <ZoomControl zoom={zoom} onChange={setZoom} />

          {/* Widgets contribuídos por extensões, cada um num iframe isolado
              (ver ExtensionSlot). O relógio + calculadora de diferença de
              datas que ficava aqui virou uma extensão embutida
              (src/extensions/builtin/dateDiffExtension.ts) — dá pra
              desativar em Settings → Extensions. */}
          <div className="w-px h-3 bg-pm-hover mx-1" />
          <ExtensionSlot host={extensionHost} slot="statusBar" />
        </div>
      </div>

      {consoleOpen && (
        <div
          style={{ height: consoleHeight }}
          className="relative flex flex-col font-mono text-[12px] bg-pm-bg border-t border-pm-border flex-shrink-0"
        >
          <div
            onMouseDown={handleConsoleResizeStart}
            className="absolute top-0 left-0 right-0 h-1 -translate-y-1/2 cursor-row-resize z-10 hover:bg-pm-accent/60 transition-colors"
          />
          <div className="flex items-center gap-2 px-2 py-1.5 bg-pm-bg border-b border-pm-border/60 flex-shrink-0">
            <div className="flex items-center gap-0.5">
              {([
                { key: 'all', label: 'All', count: logs.length },
                { key: 'log', label: 'Log', count: logs.filter(l => l.level === 'log').length },
                { key: 'info', label: 'Info', count: logs.filter(l => l.level === 'info').length },
                { key: 'warn', label: 'Warn', count: consoleWarningCount },
                { key: 'error', label: 'Error', count: consoleErrorCount },
              ] as const).map(f => (
                <button
                  key={f.key}
                  onClick={() => setConsoleFilter(f.key)}
                  className={`text-[10px] font-semibold px-2 py-1 rounded-md cursor-pointer transition-colors ${
                    consoleFilter === f.key
                      ? 'bg-pm-hover text-pm-text'
                      : 'text-pm-text-muted hover:text-pm-text-secondary hover:bg-pm-hover/60'
                  }`}
                >
                  {f.label}{f.count > 0 ? ` (${f.count})` : ''}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 flex-1 min-w-0 max-w-[220px] h-6 px-2 rounded-md bg-pm-hover border border-pm-border">
              <Search size={11} className="text-pm-text-muted shrink-0" />
              <input
                value={consoleSearch}
                onChange={e => setConsoleSearch(e.target.value)}
                placeholder="Filter logs..."
                className="bg-transparent flex-1 min-w-0 text-[11px] text-pm-text-secondary outline-none placeholder:text-pm-text-muted"
              />
            </div>

            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(filteredLogs.map(l => l.message).join('\n'));
                  } catch (e) { console.log('Copy logs error:', e); }
                }}
                disabled={filteredLogs.length === 0}
                className="text-[10px] text-pm-text-muted hover:text-pm-text-secondary transition-colors px-2 py-0.5 rounded hover:bg-pm-hover cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Copy all
              </button>
              <button
                onClick={() => setLogs([])}
                className="text-[10px] text-pm-text-muted hover:text-pm-text-secondary transition-colors px-2 py-0.5 rounded hover:bg-pm-hover cursor-pointer"
              >
                Clear
              </button>
              <button
                onClick={() => setConsoleOpen(false)}
                title="Close console"
                className="p-0.5 rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
              >
                <X size={12} />
              </button>
            </div>
          </div>
          <div ref={consoleLogListRef} className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {filteredLogs.length === 0
              ? (
                <div className="text-pm-text-muted italic p-6 text-center text-[11px]">
                  {logs.length === 0 ? 'No logs captured' : 'No logs match this filter'}
                </div>
              )
              : filteredLogs.map(log => {
                  const meta: Record<ConsoleLogLevel, { icon: React.ReactNode; border: string; text: string }> = {
                    log:   { icon: <Terminal size={11} className="text-pm-text-muted" />,     border: 'border-pm-border',  text: 'text-pm-text-secondary' },
                    info:  { icon: <Info size={11} className="text-pm-accent" />,         border: 'border-pm-accent', text: 'text-pm-text-secondary' },
                    warn:  { icon: <AlertTriangle size={11} className="text-amber-400" />, border: 'border-amber-500', text: 'text-amber-200' },
                    error: { icon: <XCircle size={11} className="text-red-400" />,        border: 'border-red-500',   text: 'text-red-300' },
                  };
                  const sourceLabel: Record<ConsoleLogSource, string> = {
                    response: 'Response',
                    script: 'Script',
                    system: 'System',
                  };
                  const m = meta[log.level];
                  const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false }) +
                    '.' + String(log.timestamp % 1000).padStart(3, '0');
                  const isExpanded = expandedLogIds.has(log.id);
                  const copyText = log.detail ? `${log.message}\n\n${log.detail}` : log.message;
                  return (
                    <div
                      key={log.id}
                      className={`group flex flex-col gap-1 border-l-2 ${m.border} pl-2.5 pr-1.5 py-1 hover:bg-pm-hover/40 transition-colors rounded-r`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 mt-[1px]">{m.icon}</span>
                        <span className="shrink-0 text-[10px] text-pm-text-muted tabular-nums mt-[1px]">{time}</span>
                        {log.requestName && (
                          <span className="shrink-0 text-[10px] font-semibold text-pm-text-muted bg-pm-hover/70 rounded px-1.5 py-[1px] mt-[0.5px] max-w-[140px] truncate" title={log.requestName}>
                            {log.requestName}
                          </span>
                        )}
                        {log.status !== undefined && (
                          <span className={`shrink-0 text-[10px] font-bold tabular-nums rounded px-1.5 py-[1px] mt-[0.5px] ${
                            log.status >= 500 ? 'bg-[#3d1a1a] text-[#ff7b7b]' : 'bg-[#3d2a1a] text-[#e5c07b]'
                          }`}>
                            {log.status}
                          </span>
                        )}
                        {log.source && (
                          <span className="shrink-0 text-[9px] uppercase tracking-wide text-pm-text-muted mt-[2px]">
                            {sourceLabel[log.source]}
                          </span>
                        )}
                        <pre className={`flex-1 min-w-0 whitespace-pre-wrap break-words text-[11px] font-mono ${m.text}`}>
                          {log.message}
                        </pre>
                        <button
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(copyText);
                              setCopiedLogId(log.id);
                              setTimeout(() => setCopiedLogId(prev => (prev === log.id ? null : prev)), 1200);
                            } catch (e) { console.log('Copy log error:', e); }
                          }}
                          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover cursor-pointer"
                          title="Copy"
                        >
                          {copiedLogId === log.id ? <Check size={11} className="text-[#4ff09d]" /> : <Copy size={11} />}
                        </button>
                      </div>
                      {log.detail && (
                        <div className="pl-5">
                          <button
                            onClick={() => toggleLogExpanded(log.id)}
                            className="flex items-center gap-1 text-[10px] text-pm-text-muted hover:text-pm-text-secondary transition-colors cursor-pointer"
                          >
                            {isExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                            {isExpanded ? 'Hide details' : 'Show details'}
                          </button>
                          {isExpanded && (
                            <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] font-mono text-pm-text-muted bg-pm-hover border border-pm-border rounded p-2 max-h-64 overflow-y-auto">
                              {log.detail}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
            }
          </div>
        </div>
      )}

<SettingsModal
  isOpen={settingsOpen}
  onClose={() => setSettingsOpen(false)}
  mcp={mcp}
  extensionHost={extensionHost}
  collections={collections}
  onApplySecrets={handleApplySecrets}
/>

{/* Confirmação do "Save to all". Lista ONDE cada cópia está: duas requests
    com o mesmo nome podem ser o mesmo passo duplicado — ou coisas
    diferentes que por acaso se chamam igual, e aí sobrescrever é perda. */}
{saveAllTargets && activeTab && (
  <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
    <div className="w-[460px] max-h-[70vh] bg-pm-surface border border-pm-border rounded-xl shadow-2xl overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-pm-border">
        <CopyCheck size={15} className="text-amber-400" />
        <span className="text-[13px] font-semibold text-pm-text">
          Save to {saveAllTargets.length + 1} requests?
        </span>
      </div>

      <div className="px-4 py-3 flex flex-col gap-2 overflow-y-auto">
        <p className="text-[12px] text-pm-text-muted leading-relaxed">
          The current tab will be saved, and the same content will overwrite
          every other request named <span className="font-mono text-pm-text">{activeTab.name}</span>.
          There is no undo.
        </p>
        <div className="flex flex-col gap-1">
          {saveAllTargets.map(target => (
            <div key={target.id} className="text-[11px] font-mono text-pm-text-secondary truncate">
              {target.path.join(' / ') || '(root)'}
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2 px-4 py-3 border-t border-pm-border bg-pm-hover/20">
        <button
          onClick={() => setSaveAllTargets(null)}
          className="flex-1 h-[32px] rounded-md text-xs font-semibold border border-pm-border bg-pm-hover text-pm-text hover:bg-pm-row-active transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={confirmSaveToAllWithName}
          className="flex-1 h-[32px] rounded-md text-xs font-semibold border-none bg-[#f26b3a] text-white hover:bg-[#f26b3a]/90 transition-colors cursor-pointer"
        >
          Overwrite {saveAllTargets.length}
        </button>
      </div>
    </div>
  </div>
)}

<SyncDiffDialog
  open={diffOpen}
  nodes={diffNodes}
  pendingCollectionIds={pendingCollectionIds}
  base={diffBase}
  collectionNames={diffNames}
  onClose={() => {
    // Fechar sem aplicar desiste também do envio que esperava a mescla.
    // Sem isto, o alvo ficaria guardado e uma comparação futura, de outra
    // collection, dispararia um push que ninguém pediu.
    setPushAfterDiff(null)
    setDiffOpen(false)
  }}
  onApply={handleApplyDiff}
/>

<CollectionRunnerPanel item={runnerItem} open={!!runnerItem} onClose={() => setRunnerItem(null)} />
<LoadTestPanel item={loadTestItem} open={!!loadTestItem} onClose={() => setLoadTestItem(null)} />

      {pendingClose && (
        <div
          className="fixed inset-0 z-[10001] flex items-start justify-center pt-[18vh] pointer-events-none"
        >
          <div
            className="pointer-events-auto w-[400px] bg-pm-sidebar border border-pm-border rounded-xl shadow-[0_16px_48px_-8px_rgba(0,0,0,0.6)] overflow-hidden font-sans ring-1 ring-white/[0.04] animate-in fade-in slide-in-from-top-2 duration-150"
          >
            <div className="flex items-start gap-3 px-4 pt-4 pb-3">
              <span className="w-8 h-8 rounded-full bg-amber-500/15 text-amber-400 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={15} />
              </span>
              <div className="flex flex-col gap-0.5 min-w-0 pt-0.5">
                <span className="text-[13.5px] font-semibold text-pm-text">
                  Unsaved changes
                </span>
                <span className="text-[11.5px] text-pm-text-muted leading-relaxed">
                  {pendingClose.dirtyTabs.length === 1
                    ? `Do you want to save the changes you made to "${pendingClose.dirtyTabs[0].name}"?`
                    : `Do you want to save the changes made to ${pendingClose.dirtyTabs.length} tabs?`}
                </span>

                {/* O que exatamente vai ser gravado. Sem isto o aviso pede uma
                    decisão sobre algo que não mostra, e o caminho seguro vira
                    sempre "Save" — inclusive quando a alteração foi sem
                    querer. */}
                {pendingClose.dirtyTabs.length === 1 && (() => {
                  const labels = pendingChanges.get(pendingClose.dirtyTabs[0].id) ?? [];
                  if (labels.length === 0) return null;
                  return (
                    <span className="mt-1 text-[11.5px] text-pm-text-secondary">
                      Changed: <span className="text-pm-text">{describeChanges(labels)}</span>
                    </span>
                  );
                })()}
              </div>
            </div>

            {pendingClose.dirtyTabs.length > 1 && (
              <div className="mx-4 mb-1 max-h-[130px] overflow-y-auto rounded-lg border border-pm-border bg-pm-hover">
                {/* Clicar leva à aba, SEM fechar o aviso: o fundo dele é
                    pointer-events-none, então o app atrás continua vivo e dá
                    para conferir uma aba, depois outra, e só então decidir.
                    Fechar o aviso aqui obrigaria a refazer o fechamento de
                    todas elas. */}
                {pendingClose.dirtyTabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTabId(t.id)}
                    title={`Go to "${t.name}" to review the changes`}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-left border-b border-pm-border/60 last:border-b-0 cursor-pointer transition-colors ${
                      activeTabId === t.id
                        ? 'bg-pm-row-active text-pm-text'
                        : 'bg-transparent text-pm-text-secondary hover:bg-pm-surface hover:text-pm-text'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-[#4ff09d] flex-shrink-0" />
                    <span className="truncate">{t.name}</span>
                    {(pendingChanges.get(t.id)?.length ?? 0) > 0 && (
                      <span className="ml-auto shrink-0 text-[10.5px] text-pm-text-muted">
                        {describeChanges(pendingChanges.get(t.id)!, 2)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <p className="px-4 pb-4 pt-1 text-[11px] text-pm-text-muted">
              Your changes will be lost if you don&apos;t save them.
            </p>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-pm-border/80 bg-pm-hover/50">
              <button
                className="h-[30px] px-3 rounded-md text-[11.5px] font-medium cursor-pointer border-none bg-transparent text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors"
                onClick={handlePendingCloseCancel}
              >
                Cancel
              </button>
              <button
                className="h-[30px] px-3 rounded-md text-[11.5px] font-medium cursor-pointer border border-pm-border bg-pm-hover/80 text-pm-text hover:bg-pm-hover hover:text-pm-text transition-colors"
                onClick={handlePendingCloseDiscard}
              >
                Don&apos;t Save
              </button>
              <button
                className="h-[30px] px-3.5 rounded-md text-[11.5px] font-semibold cursor-pointer border-none bg-pm-accent text-white hover:brightness-110 transition-colors"
                onClick={handlePendingCloseSaveAndClose}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

