
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
import { ModalCard } from '@/components/ui/modal-card';
import { invoke } from "@tauri-apps/api/core";
import { useEnvironment } from '@/components/EnvironmentContext';
import { useTheme } from '@/components/ThemeContext';
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes';
import {  ResizableHandle,  ResizablePanel,  ResizablePanelGroup} from "@/components/ui/resizable";
import { useGroupRef } from "react-resizable-panels";
import Sidebar from "@/components/collection-tree/Sidebar";
import { addNode, removeNode, renameNode, findNodeById, findParentId, patchNode, pasteNodesBeside, backfillExampleRequests, collectStarMarks, applyStarMarks, findRequestsByName, partitionExisting, setRequestScript, setRequestUrl, type NamedMatch } from "@/components/collection-tree/utils/tree.utils";
import { useAppZoom } from '@/lib/useAppZoom';
import type { SnippetRequest } from '@/lib/codeSnippets';
import { ZoomControl } from '@/components/ZoomControl';
import { useMcpServer } from '@/mcp/useMcpServer';
import { McpStatusIndicator } from './McpStatusIndicator';
import { McpContext } from '@/mcp/mcpTools';
import { moveItem as moveTreeItem } from '@/mcp/treeEdit';
import { isSessionToken, withoutSessionTokens } from '@/lib/jwt';
import { expectedBehaviorTests, withExpectedBehavior } from '@/lib/exampleExpectations';
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

// 'requestBodyValue' e 'scripts' ficam de FORA: os dois só são editados
// dentro do Monaco, que já tem seu próprio undo/redo nativo (ver o motivo
// completo em getHistoryKeys/tabHistoryKeys.ts — a mesma dupla fica fora de
// lá também, e por aquele lado é o que faz essas chaves nem chegarem a
// empurrar um passo de histórico).
const SNAPSHOT_KEYS: (keyof TabSnapshot)[] = [
  'name', 'method', 'urlInput', 'bodyType',
  'requestHeadersValue', 'auth', 'queryParams', 'params', 'disabledDefaultHeaders',
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
import GitHubSync, { GitHubSyncHandle, type ReviewScope } from './GitHubStorageClient';
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
import { parseScriptError } from '@/lib/scriptError';
import { getHistoryKeys } from '@/lib/tabHistoryKeys';
import { GitHubConflictError } from './GitHubStorageClient';
import { changedFieldLabels, describeChanges } from '@/lib/unsavedChanges';
import { stripTabsForSession, sameSessionTabs } from '@/lib/tabSessions';
import { safeSetItem, sweepDeadKeys } from '@/lib/safeStorage';
import { loadWorkspaceLocalData, loadWorkspaceMarkers, saveWorkspaceCollections, saveWorkspaceEnvironments, saveWorkspaceMarkers } from '@/storage/localSyncStore';
import { type Marker, MARKER_BASE_PREFIX, markerBaseHashes, markerChangeCount, markerChangesFromRemote, mergeCatalogs, purgeOrphans, remapMarkers } from '@/lib/markers';
import {
  markCollectionsPendingPush,
  markEnvironmentsPendingPush,
  markFullPushRequired,
  clearWorkspacePendingPush,
  clearCollectionsPendingPush,
  clearEnvironmentsPendingPush,
  readPendingPush,
  isPendingEmpty,
  EMPTY_PENDING,
  type PendingPush,
} from '@/storage/pendingPushStore';
import { fingerprintRoots, diffRoots, type RootFingerprints } from '@/lib/collectionFingerprint';
import { compareWorkspaces, describeComparison } from '@/lib/remoteComparison';
import { diffTrees, fieldDiffs, filterSubtree, type DiffNode } from '@/lib/collectionDiff';
import { SyncListDialog, detailToItem, type SyncListItem, type SyncListSection } from '@/components/SyncDiff/SyncListDialog';
import type { ItemChange, ReviewDecision } from '@/components/SyncDiff/SyncDiffDialog';
import { loadConflictHistory, recordConflictDecisions } from '@/lib/sync/conflictHistory';
import { useSyncDiffStrings } from '@/lib/i18n/syncDiffStrings';
import type { ChangeDetail, RebaseResult } from '@/lib/sync/rebase';
import type { EnvRebaseResult } from '@/lib/sync/envMerge';
import type { FileShas } from '@/lib/remoteVersions';
import { pruneEmptyGroups, type TabGroup } from '@/lib/tabGroups';
import { applySelectedChanges } from '@/lib/applyDiff';
import { diffEnvironments, applyEnvironmentChanges } from '@/lib/environmentDiff';
import { nodeHashes, recordSyncBase, loadSyncBase, clearSyncBase, reviewedBase, matchesSyncBase, pendingChanges as pendingChangesSince, type NodeHashes } from '@/lib/syncBase';
import type { PendingDetail } from '@/components/collection-tree/CollectionTree';
import { applyRemoteMoves, rebaseCollections } from '@/lib/sync/rebase';
import { buildRemoteChangePreview, commitChangeItems, detailItems } from '@/lib/sync/remoteChangeAlert';
import { reloadedTab, tabsAfterSync } from '@/lib/sync/openTabsRefresh';
import { exampleNameFor } from '@/lib/exampleName';
import { withLocalOnlyValues } from '@/lib/sync/pulledEnvironments';
import { buildSyncOverview, namePathTo, withContentPreviews, type SyncOverview } from '@/lib/sync/syncOverview';
import { discardEnvironmentChange, discardLocalChange } from '@/lib/sync/discardChange';
import { asCancelled, isSyncCancelRequested, requestSyncCancel, resetSyncCancel, SYNC_CANCELLED_MESSAGE, throwIfSyncCancelled, captureSyncStatus, withoutActions, markResumeAfterReview, openSyncCenter, reportSyncStatus, setKnownConflicts, setSyncCenterBusy, takeResumeAfterReview, type SyncAction, type SyncActionResult, type SyncActionScope, type SyncCenterTab } from '@/lib/sync/syncCenterStore';
import { SyncCenter } from '@/components/SyncCenter/SyncCenter';
import { isInSubtree, withSubtreeFrom } from '@/lib/sync/subtreePush';
import { ENV_BASE_PREFIX, environmentHashes, rebaseEnvironments } from '@/lib/sync/envMerge';
import type { RebaseOutcome } from '@/components/GitHubStorageClient';
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
import { DevFlowFullScreenLoader, DevFlowLoader, DevFlowSpinner } from '@/components/helper/DevFlowLoader';
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

// Aba de "Try" de um example (handleTryExample) é solta: nunca existiu na
// árvore. Salvá-la = criar uma request nova com o que está nela, logo depois
// da request dona do example. `placed` diz o id novo de cada aba; `failed`,
// as que não têm mais onde ficar (o example ou a request dele foram apagados).
function placeTryTabsAsRequests(
  tree: CollectionItem[],
  tryTabs: Tab[]
): { tree: CollectionItem[]; placed: Map<string, CollectionItem>; failed: Tab[] } {
  let next = tree;
  const placed = new Map<string, CollectionItem>();
  const failed: Tab[] = [];
  for (const tab of tryTabs) {
    const requestId = tab.tryOfExampleId ? findParentId(next, tab.tryOfExampleId) : null;
    const requestNode = requestId ? findNodeById(next, requestId) : null;
    if (!requestId || !requestNode) {
      failed.push(tab);
      continue;
    }
    const item = { ...createRequestItemFromTab(tab), name: `${requestNode.name} (copy)` };
    next = pasteNodesBeside(next, requestId, [item], 'after');
    placed.set(tab.id, item);
  }
  return { tree: next, placed, failed };
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
  const { activeEnv, environments, setEnvironments, markEnvironmentSynced, selectedEnvId, setSelectedEnvId, patchEnvironmentVariables } = useEnvironment();
  const { effectiveThemeId } = useTheme();
  const monacoTheme = getMonacoThemeName(effectiveThemeId);
  const handleMonacoBeforeMount = useCallback((monaco: Monaco) => {
    registerDevflowMonacoThemes(monaco);
  }, []);
  const [importOpen, setImportOpen] = useState(false);
  const [hydrated,           setHydrated]           = useState(false);
  // Workspace sendo aberto (o carregamento por cima do app).
  const [switchingWorkspace, setSwitchingWorkspace] = useState<string | null>(null);
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
    const isActive = selectedWorkspaceRef.current === workspaceName;

    // Pro workspace ATIVO, o estado em memória (collectionsRef/markersRef)
    // é a fonte mais atual, não o disco: handleMarkersChange grava em disco
    // sem esperar (`void saveWorkspaceMarkers`), e o autosave da árvore
    // também não é imediato. Ler só do disco aqui podia pegar um marcador
    // (ou uma atribuição) recém-criado ainda não persistido, e o merge
    // abaixo reescreveria o estado vivo SEM ele — era assim que um marcador
    // acabado de criar sumia ao dar push logo em seguida (o conflito do
    // push chama este merge pelo meio).
    const tree = isActive
      ? collectionsRef.current
      : (((await loadWorkspaceLocalData(workspaceName)).collections as CollectionItem[]) ?? []);
    const localCatalog = isActive
      ? markersRef.current
      : ((await loadWorkspaceMarkers(workspaceName)) as Marker[]);

    // Com a base: o que você apagou não volta, o que apagaram no GitHub sai
    // daqui, e renomear aqui não é desfeito por um pull (lib/markers).
    const syncBase = await loadSyncBase(workspaceName);
    const { catalog, remapped } = mergeCatalogs(localCatalog, remoteMarkers, syncBase);
    await saveWorkspaceMarkers(workspaceName, catalog);
    // O catálogo do GitHub que acabou de ser visto vira a base dele.
    await recordSyncBase(workspaceName, markerBaseHashes(remoteMarkers), [MARKER_BASE_PREFIX]);

    // Reescreve a árvore só se o remap tiver algo a fazer — não há caminho
    // mais curto porque o merge do catálogo só é conhecido agora.
    const remappedTree = remapMarkers(tree, remapped);
    // purgeOrphans depois do remap, nunca antes: um id que o remap ia
    // converter seria apagado como "órfão" por não estar no catálogo ainda.
    const cleaned = purgeOrphans(remappedTree, catalog);
    if (cleaned !== tree) await saveWorkspaceCollections(workspaceName, cleaned);

    if (isActive) {
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
  const [runnerItemId, setRunnerItemId] = useState<string | null>(null);
  // Lookup vivo, não um snapshot: editar um script da request pelo próprio
  // Runner (onUpdateRequestScript) só reflete no re-run se `runnerItem`
  // acompanhar `collections` em vez de congelar o nó do momento em que o
  // Runner abriu.
  const runnerItem = useMemo(
    () => (runnerItemId ? findNodeById(collections, runnerItemId) ?? null : null),
    [runnerItemId, collections]
  );
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
  // Mesma ideia do pushAfterDiff acima, mas pro push INTEIRO (handlePushEverything,
  // via onCompareRemote com isPushConflict) — sem item nenhum pra guardar, só
  // "depois de mesclar, reenvie tudo".
  const [pushAllAfterDiff, setPushAllAfterDiff] = useState(false);
  // "Push deste item" que esbarrou em conflito: depois da revisão, o envio
  // do item recomeça (via pushItemRef — handlePushItem é declarado depois).
  const [pushItemAfterDiff, setPushItemAfterDiff] = useState<CollectionItem | null>(null);
  const pushItemRef = useRef<((item: CollectionItem) => Promise<void>) | null>(null);
  // Envio de item que a revisão dispara no próximo tick (ver handleApplyDiff).
  const deferredPushRef = useRef<Promise<void> | null>(null);
  // O GitHub que a Central leu por último (ver handleSyncDiscard).
  const lastSyncPeekRef = useRef<{ workspace: string; remoteTree: CollectionItem[]; remoteEnvs: Environment[] } | null>(null);
  // Mesma ideia, pro push de UM environment (handleSaveEnvironmentToGitHub).
  const [pushEnvAfterDiff, setPushEnvAfterDiff] = useState<Environment | null>(null);
  // Conflito ao enviar um workspace que pode não ser o selecionado agora (menu
  // de workspaces) — guarda o NOME pra saber qual reenviar depois da mescla.
  const [pushWorkspaceAfterDiff, setPushWorkspaceAfterDiff] = useState<string | null>(null);
  // Base local do merge quando o conflito é de OUTRO workspace: `collections`
  // é sempre o workspace SELECIONADO, que pode não ter nada a ver com o que
  // está em conflito — sem isso a mescla usaria a árvore errada.
  const [diffLocalOverride, setDiffLocalOverride] = useState<{ collections: CollectionItem[]; environments: Environment[] } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  // Uma ação da Central de Sincronização abriu a revisão? Marcado na hora
  // (não espera o render), pra quem chamou saber que parou num conflito.
  const reviewRequestedRef = useRef(false);
  const openReviewDialog = useCallback(() => {
    reviewRequestedRef.current = true;
    setDiffOpen(true);
  }, []);
  // A revisão aberta faz parte de um push (algum envio espera a mescla)? Muda
  // o que os botões dizem: aplicar ali também ENVIA, e "não aceitar nada"
  // sobrescreve o GitHub com a versão daqui.
  // Pull revisado do workspace (handlePullWorkspaceWithReview): collections e
  // environments são duas telas. Se as duas têm diferença, a de environments
  // espera aqui e abre logo depois que a de collections for aplicada.
  // O que a revisão aberta cobre, pra registrar como sincronizado ao aplicar
  // (ver markReviewed no GitHubSync). `null` = recorte que não cobre um
  // arquivo inteiro (pull de uma subpasta): não registra nada.
  const [diffReviewScope, setDiffReviewScope] = useState<ReviewScope | null>(null);
  // Revisão de um commit antigo (restaurar), não do GitHub atual: o "remoto"
  // da tela é aquele commit. Muda o título, desliga a base (os rótulos de
  // "quem mexeu" falariam do GitHub de hoje) e o que for aplicado vira
  // pendência de push em vez de "sincronizado".
  const [diffSnapshotLabel, setDiffSnapshotLabel] = useState<string | null>(null);
  // A revisão abriu porque o merge automático do push achou conflitos: ela
  // já começa filtrada neles — o resto foi resolvido sozinho e só faria volume.
  const [diffConflictsOnly, setDiffConflictsOnly] = useState(false);
  // Revisão de environments: o que começa em "Mine" (envKeepMineIds). Sem
  // isto, sem base nenhuma, a revisão marcava tudo como "usar a do GitHub".
  const [diffEnvKeepMine, setDiffEnvKeepMine] = useState<ReadonlySet<string> | null>(null);

  // Janela de listas do sync: relatório do merge, prévia do push, histórico.
  const syncText = useSyncDiffStrings();
  const [syncList, setSyncList] = useState<{
    title: string;
    subtitle?: string;
    sections: SyncListSection[];
    /** Mostra "Enviar agora" (prévia do push). */
    pushNow?: boolean;
  } | null>(null);

  // Relatório do merge que um push fez — mostrado quando o push termina.
  const pushReportRef = useRef<{ workspace: string; sections: SyncListSection[]; keptMine: string[]; incoming: number } | null>(null);

  // "Desfazer" do último pull/revisão: o estado de antes, por 10 minutos.
  const undoRef = useRef<{
    workspace: string;
    at: number;
    collections: CollectionItem[];
    environments: Environment[];
    pending: PendingPush;
    base: NodeHashes | null;
    synced: FileShas;
    // O catálogo também: o pull o mescla (handlePullMarkers), e desfazer só
    // a árvore deixava marcadores do GitHub (ou remaps) no catálogo daqui.
    markers: Marker[];
  } | null>(null);
  // Última edição LOCAL de verdade (árvore ou environments) — não as que o
  // próprio pull aplica. O Desfazer compara com o momento do snapshot pra
  // avisar antes de apagar o que foi editado depois do pull.
  const lastLocalEditRef = useRef(0);

  // Itens de relatório com o antes/depois de cada um — o "Ver diferença" da
  // lista abre no formato de três painéis (MergeDiffHost). Depois do merge
  // a base já é outra, então a visão é de duas vias (daqui × GitHub).
  const withDiffs = useCallback((details: ChangeDetail[], nodes: DiffNode[], conflict = false): SyncListItem[] => {
    const diffs = detailItems(details, nodes, { conflict });
    return details.map((d, i) => ({ ...detailToItem(d, syncText.changeLabels), diff: diffs[i] }));
  }, [syncText]);

  // Seções do relatório de um merge (lib/sync/rebase + envMerge).
  const mergeReportSections = useCallback((
    collectionsResult: RebaseResult | null,
    envResult: EnvRebaseResult | null,
    includeYours: boolean
  ): SyncListSection[] => {
    const t = syncText;
    const sections: SyncListSection[] = [
      {
        title: t.reportFromGithub,
        tone: 'github',
        items: [
          ...withDiffs(collectionsResult?.incomingDetails ?? [], collectionsResult?.nodes ?? []),
          ...(envResult?.incomingNames ?? []).map(name => ({ primary: name, secondary: t.changeLabels.changed })),
        ],
        emptyText: t.previewNothing,
      },
      {
        title: t.reportKeptMine,
        tone: 'conflict',
        items: [...(collectionsResult?.keptMineNames ?? []), ...(envResult?.keptMineNames ?? [])].map(name => ({ primary: name })),
        emptyText: t.previewNothing,
      },
    ];
    if (includeYours) {
      sections.push({
        title: t.reportYours,
        tone: 'mine',
        items: [
          ...withDiffs(collectionsResult?.outgoingDetails ?? [], collectionsResult?.nodes ?? []),
          ...(envResult?.outgoingNames ?? []).map(name => ({ primary: name, secondary: t.changeLabels.changed })),
        ],
        emptyText: t.previewNothing,
      });
    }
    return sections;
  }, [syncText, withDiffs]);

  const [pendingEnvReview, setPendingEnvReview] = useState<{ nodes: DiffNode[]; remoteEnvs: Environment[] } | null>(null);
  const diffPushPending = !!pushAfterDiff || pushAllAfterDiff || !!pushEnvAfterDiff || !!pushWorkspaceAfterDiff || !!pushItemAfterDiff;
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
  // A árvore que o efeito de collections viu por último — o "antes" de uma
  // sincronização, pra saber quais abas abertas o merge mudou.
  const treeSeenRef = useRef<{ workspace: string; tree: CollectionItem[] } | null>(null);

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
  // Seção a abrir quando o Settings é aberto por um atalho (ex. o MCP da barra).
  const [settingsSection, setSettingsSection] = useState<'mcp' | undefined>(undefined);
  // "Abre onde está X" pedido de fora da árvore — hoje só o scanner de
  // segredos (Settings → Security), que não tem acesso nenhum ao estado
  // interno do CollectionTree. Repassado como prop (ver focusRequest lá).
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("");
  const selectedWorkspaceRef = useRef(selectedWorkspace); 

  // Quantas alterações cada collection pendente tem, e quais itens — o ponto
  // laranja da árvore só dizia "tem algo". Comparado com a base da última
  // sincronização (lib/syncBase.pendingChanges), lida do disco: espera a
  // digitação parar um pouco e descarta a resposta de um workspace antigo.
  const [pendingDetails, setPendingDetails] = useState<Map<string, PendingDetail>>(() => new Map());
  // Só a leitura mais recente vale: uma mais lenta, disparada antes, não
  // pode sobrescrever a contagem nova com a velha.
  const pendingDetailsSeqRef = useRef(0);
  useEffect(() => {
    if (pendingCollectionIds.size === 0) {
      pendingDetailsSeqRef.current++;
      setPendingDetails(prev => (prev.size === 0 ? prev : new Map()));
      return;
    }
    const workspace = selectedWorkspace;
    const roots = collections;
    const timer = setTimeout(() => {
      const seq = ++pendingDetailsSeqRef.current;
      void loadSyncBase(workspace).then(base => {
        if (seq !== pendingDetailsSeqRef.current || selectedWorkspaceRef.current !== workspace) return;
        const next = new Map<string, PendingDetail>();
        for (const id of pendingCollectionIds) {
          const detail = pendingChangesSince(base, roots.find(c => c.id === id));
          if (!detail) continue;
          next.set(id, { count: detail.changed.length + detail.deleted, changed: new Set(detail.changed) });
        }
        setPendingDetails(next);
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [collections, pendingCollectionIds, selectedWorkspace]);
  const [isToolsMenuOpen, setIsToolsMenuOpen] = useState(false);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  // Mesma razão do tabsRef: os callbacks de sync têm deps vazias e leriam
  // uma árvore congelada na primeira renderização.
  const collectionsRef = useRef<CollectionItem[]>(collections);
  // Mesma razão do collectionsRef — handlePullMarkers precisa do catálogo
  // VIVO do workspace ativo, não do que já foi gravado em disco (ver o
  // comentário ali: o write em disco é fire-and-forget, e ler só do disco
  // perdia um marcador recém-criado que ainda não tinha sido persistido).
  const markersRef = useRef<Marker[]>(markers);
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
  preRequestScriptError: null, postResponseScriptError: null,
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
  // Mesma ideia, pros environments: a base gravada no fim do push precisa do
  // estado de AGORA (que o merge do push pode ter acabado de trocar).
  const environmentsRef = useRef(environments);
  useEffect(() => { environmentsRef.current = environments; }, [environments]);
  useEffect(() => { markersRef.current = markers; }, [markers]);
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
  // O carregamento aparece só se a troca demorar (workspace grande): numa
  // troca instantânea ele só piscaria.
  const showLoader = setTimeout(() => setSwitchingWorkspace(path), 150);
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
    clearTimeout(showLoader);
    setSwitchingWorkspace(null);
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
    // Migra todos os dados do workspace antigo para o novo path. Faltavam
    // grupos de abas, a environment ativa, a base de sync (NodeHashes do
    // diff de três vias — sem ela o painel de sync passava a comparar contra
    // nada e avisava demais) e o catálogo de marcadores: cada um tem sua
    // própria chave namespaced por workspace, igual tabs/collections/
    // environments, mas não estavam sendo migrados — o rename "perdia" esses
    // dados (ficavam órfãos sob o path antigo).
    const [oldTabs, oldActiveId, oldLocalData, oldTabGroups, oldActiveEnvId, oldSyncBase, oldMarkers] = await Promise.all([
      loadTabs(oldPath),
      loadActiveTabId(oldPath),
      loadWorkspaceLocalData(oldPath),
      loadTabGroups(oldPath),
      loadActiveEnvironmentId(oldPath),
      loadSyncBase(oldPath),
      loadWorkspaceMarkers(oldPath),
    ]);

    await Promise.all([
      saveTabs(newPath, oldTabs),
      saveActiveTabId(newPath, oldActiveId),
      saveWorkspaceCollections(newPath, oldLocalData.collections),
      saveWorkspaceEnvironments(newPath, oldLocalData.environments),
      saveTabGroups(newPath, oldTabGroups),
      saveActiveEnvironmentId(newPath, oldActiveEnvId),
      oldSyncBase ? recordSyncBase(newPath, oldSyncBase) : Promise.resolve(),
      saveWorkspaceMarkers(newPath, oldMarkers),
    ]);

    // Limpa as chaves antigas pra não deixar lixo órfão no storage.
    await Promise.all([
      saveTabs(oldPath, []),
      saveActiveTabId(oldPath, null),
      saveWorkspaceCollections(oldPath, []),
      saveWorkspaceEnvironments(oldPath, []),
      saveTabGroups(oldPath, []),
      saveActiveEnvironmentId(oldPath, null),
      clearSyncBase(oldPath),
      saveWorkspaceMarkers(oldPath, []),
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
    return;
  }

  // Renomeia a pasta remota também, se este workspace estiver sincronizado.
  // Sem isso, a pasta antiga ("Postman/<nome antigo>") continua existindo no
  // GitHub, e um Pull de todos os workspaces mais tarde a redescobre como se
  // fosse um workspace novo — recriando localmente o que acabou de ser
  // renomeado, com os dados antigos. Erro aqui tem seu próprio aviso (abaixo),
  // separado do catch acima: a migração LOCAL já terminou e não deve parecer
  // que falhou só porque o GitHub não respondeu.
  try {
    await githubSyncRef.current?.renameWorkspace(oldPath, newPath);
  } catch (err) {
    console.error(`Erro ao renomear a pasta remota de "${oldPath}" para "${newPath}":`, err);
    toast.error(
      `Workspace renomeado localmente, mas a pasta no GitHub não pôde ser renomeada.`,
      {
        description: `${(err as Error)?.message ?? String(err)} — Um Pull de todos os workspaces pode recriar o nome antigo. Tente renomear de novo, ou mova os arquivos manualmente no GitHub.`,
        duration: 12000,
      }
    );
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

// Menu de contexto da aba -> Flow: mesmo picker de pasta do "Convert to
// Flow", mas com TODAS as abas abertas em vez das de um grupo específico.
const handleAddAllTabsToFlow = useCallback(() => {
  const openTabs = tabsRef.current;
  if (openTabs.length === 0) {
    toast.error('There are no open tabs to add.');
    return;
  }
  setFlowPickerSession({
    id: crypto.randomUUID(),
    name: 'Open Tabs',
    tabs: openTabs,
    activeTabId: activeTabIdRef.current,
    savedAt: Date.now(),
  });
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

  const historyKeys = getHistoryKeys(updates);
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

// Os botões do aviso da aba de Try chamam funções declaradas mais abaixo
// (saveTryTabAsRequest, handleUpdateExampleFromResponse).
const saveTryTabAsRequestRef = useRef<((tabId: string) => Promise<void>) | null>(null);
const updateExampleFromResponseRef = useRef<(() => void) | null>(null);

// `tryTabs`: o que fazer com abas de "Try" de example, que não existem na
// árvore. 'ask' (Ctrl+S numa aba) oferece as duas saídas; 'saveAsRequest'
// (salvar em lote antes de fechar) cria a request — fechar descartaria a
// edição, e quem pediu "salvar" não quer perdê-la.
const saveTabsList = useCallback(async (
  tabsToSave: Tab[],
  options: { tryTabs?: 'ask' | 'saveAsRequest' } = {}
) => {
  if (tabsToSave.length === 0) return;

  // Aba de Try não é "órfã": ela nunca foi gravada na árvore. Antes caía no
  // aviso de aba de outro workspace ("switch to the workspace they belong
  // to"), que não fazia sentido nenhum aqui.
  // Uma árvore só, gravada uma vez no fim: a request criada pela aba de Try
  // e as abas salvas normalmente entram na mesma.
  let tree = collections;
  let treeChanged = false;
  const tryTabs = tabsToSave.filter(t => !!t.tryOfExampleId && !findNodeById(collections, t.id));
  if (tryTabs.length > 0) {
    if ((options.tryTabs ?? 'ask') === 'saveAsRequest') {
      const result = placeTryTabsAsRequests(tree, tryTabs);
      if (result.placed.size > 0) {
        tree = result.tree;
        treeChanged = true;
        removeTabDrafts([...result.placed.keys()]);
        toast.success(
          result.placed.size === 1
            ? `Saved as a new request: "${[...result.placed.values()][0].name}"`
            : `Saved ${result.placed.size} example tries as new requests`
        );
      }
      // O que não teve onde ficar (example apagado) cai no aviso de órfã.
      tabsToSave = [...tabsToSave.filter(t => !tryTabs.includes(t)), ...result.failed];
    } else {
      const tab = tryTabs[0];
      toast.info(`"${tab.name}" is a try of an example`, {
        description:
          "It isn't saved in the collection. Save it as a new request next to the original, or keep this response in the example.",
        duration: 12000,
        action: { label: 'Save as request', onClick: () => void saveTryTabAsRequestRef.current?.(tab.id) },
        ...(tab.response
          ? { cancel: { label: 'Update example', onClick: () => updateExampleFromResponseRef.current?.() } }
          : {}),
      });
      tabsToSave = tabsToSave.filter(t => !tryTabs.includes(t));
    }
  }
  if (tabsToSave.length === 0) {
    if (treeChanged) {
      setCollections(tree);
      await saveWorkspaceCollections(selectedWorkspaceRef.current, tree);
    }
    return;
  }

  // Uma aba cujo id não está na árvore deste workspace não tem onde ser
  // gravada: updateItemInTree procura o nó, não acha, e devolve a árvore
  // intacta — sem erro. Antes seguíamos assim mesmo, limpando o "não salvo"
  // e apagando o rascunho: a edição sumia das duas pontas, em silêncio.
  //
  // Não é hipótese. Acontece ao restaurar uma sessão de abas salva noutro
  // workspace (sessões não guardam de qual vieram) e ao excluir da árvore uma
  // request que está aberta.
  const { missing } = partitionExisting(tree, tabsToSave.map(t => t.id));
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

  if (savable.length === 0) {
    if (treeChanged) {
      setCollections(tree);
      await saveWorkspaceCollections(selectedWorkspaceRef.current, tree);
    }
    return;
  }

  let updatedCollections = tree;
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
        if (dirtyTabs.length > 0) await saveTabsList(dirtyTabs, { tryTabs: 'saveAsRequest' });
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
  saveTabsList(pendingClose.dirtyTabs, { tryTabs: 'saveAsRequest' });
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

  // Clique num achado do scanner de segredos (Settings → Security): fecha a
  // tela de Settings, abre a aba (se for request/example) e manda o
  // CollectionTree expandir/rolar/focar até o item — ver focusRequest.
  const handleJumpToItem = useCallback((requestId: string) => {
    setSettingsOpen(false);
    const item = findNodeById(collectionsRef.current, requestId);
    if (item && (item.type === 'request' || item.type === 'example')) {
      handleRequestSelect(item);
    }
    setFocusRequest({ id: requestId, nonce: Date.now() });
  }, [handleRequestSelect]);

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
  //
  // Valor com cara de JWT também fica de fora: é o access token que um fluxo
  // OAuth2 renova sozinho (get_oauth2_token do MCP, passo de token do Runner,
  // "Get new access token"). Ele expira em uma hora e é de cada pessoa; contá-lo
  // como alteração acendia "pendente de push" a cada login e mandava o token
  // pro GitHub no push seguinte. Criar ou apagar a variável continua contando.
  // Só JWT em variável com nome de token (isSessionToken): uma chave de
  // serviço JWT fixa editada de propósito continua marcando pendência — e o
  // push tira o token de sessão do que sobe (withoutSessionTokens).
  const nextPrints = new Map(
    environments
      .filter(e => e?.id)
      .map(e => {
        const { isDirty: _ignored, ...content } = e;
        const values = (content.values ?? []).map(v =>
          isSessionToken(v.key, v.value) ? { ...v, value: '[jwt]' } : v
        );
        return [e.id, JSON.stringify({ ...content, values })] as const;
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

  lastLocalEditRef.current = Date.now();
  if (changed.length > 0) markEnvironmentsPendingPush(selectedWorkspace, changed);
  if (removed.length > 0) markFullPushRequired(selectedWorkspace);
  setPendingPush(readPendingPush(selectedWorkspace));
}, [environments, selectedWorkspace]);

// Depois de um merge/pull: recarrega as abas abertas cujo item mudou. As
// que têm edição não salva ficam como estão, com um aviso que oferece
// recarregar (descartando a edição).
const refreshOpenTabsAfterSync = (before: CollectionItem[], after: CollectionItem[]) => {
  const { reloaded, dirty } = tabsAfterSync(tabsRef.current, before, after, buildTabFromItem);
  if (reloaded.length > 0) {
    const byId = new Map(reloaded.map(t => [t.id, t]));
    // Por id e só se continuar sem edição: entre o cálculo e o render a
    // pessoa pode ter digitado na aba.
    setTabs(prev => prev.map(t => (!t.isDirty && byId.has(t.id) ? byId.get(t.id)! : t)));
    toast.info(syncText.tabsReloaded(reloaded.length, reloaded[0].name));
  }
  if (dirty.length > 0) {
    const ids = new Set(dirty.map(t => t.id));
    toast.warning(syncText.tabsDirtyChanged(dirty.length, dirty[0].name), {
      duration: 20000,
      action: {
        label: syncText.tabsReload,
        onClick: () =>
          setTabs(prev =>
            prev.map(t => {
              if (!ids.has(t.id)) return t;
              const item = findNodeById(collectionsRef.current, t.id);
              return item ? reloadedTab(t, item, buildTabFromItem) : t;
            })
          ),
      },
    });
  }
};

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
  const previousTree = treeSeenRef.current;
  treeSeenRef.current = { workspace: selectedWorkspace, tree: collections };

  // Pull acabou de substituir a árvore pelo remoto: não há nada pendente, só
  // a referência a atualizar pra que a PRÓXIMA edição seja medida contra o
  // que veio de lá.
  if (suppressPendingMarkRef.current) {
    suppressPendingMarkRef.current = false;
    rootPrintsRef.current = nextPrints;
    // Abas abertas de itens que a sincronização mudou passam a mostrar a
    // versão nova (lib/sync/openTabsRefresh). Só no MESMO workspace: na
    // troca de workspace as abas já são as dele.
    if (previousTree && previousTree.workspace === selectedWorkspace && previousTree.tree !== collections) {
      refreshOpenTabsAfterSync(previousTree.tree, collections);
    }
    return;
  }

  const { changed, removed } = diffRoots(rootPrintsRef.current, nextPrints);
  rootPrintsRef.current = nextPrints;
  if (changed.length === 0 && removed.length === 0) return;

  lastLocalEditRef.current = Date.now();
  if (changed.length > 0) markCollectionsPendingPush(selectedWorkspace, changed);
  // Collection apagada não tem mais id pra marcar; só um push completo
  // reconcilia o arquivo que ficou no remoto.
  if (removed.length > 0) markFullPushRequired(selectedWorkspace);
  setPendingPush(readPendingPush(selectedWorkspace));

  // Editar e desfazer à mão deixava o ponto aceso pra sempre. Se a
  // collection voltou a ser exatamente o que foi sincronizado por último
  // (lib/syncBase.matchesSyncBase), a pendência sai. A base é lida do disco
  // (assíncrono): só limpa se a collection conferida ainda é a atual — uma
  // edição no meio do caminho já teria marcado de novo e não pode ser
  // apagada por esta resposta atrasada.
  if (changed.length > 0) {
    const workspace = selectedWorkspace;
    const checked = new Map(
      changed.map(id => [id, collections.find(c => c.id === id)] as const)
    );
    void loadSyncBase(workspace).then(base => {
      if (!base || selectedWorkspaceRef.current !== workspace) return;
      const back = [...checked]
        .filter(([id, root]) =>
          root &&
          collectionsRef.current.find(c => c.id === id) === root &&
          matchesSyncBase(base, root)
        )
        .map(([id]) => id);
      if (back.length === 0) return;
      clearCollectionsPendingPush(workspace, back);
      setPendingPush(readPendingPush(workspace));
    });
  }
}, [collections, selectedWorkspace]);

// useEffect(() => {
//   if (!tabsHydrated.current) return;
//   localStorage.setItem(COLLECTIONS_STORAGE_KEY, JSON.stringify(collections));
// }, [collections]);

// Leva pro environment o que o script devolveu.
//
// A regra de gravação mora em lib/envWrite.ts (applyEnvPatch) e chega aqui
// pelo patchEnvironmentVariables: a entrada habilitada da key é a alterada
// (pm.environment.set) ou removida (pm.environment.unset), duplicata
// desabilitada nunca é tocada, e id/description/type são herdados.
//
// NÃO grava em disco, de propósito. Antes gravava — e lia o array de uma
// variável atribuída DENTRO do updater do setState. O updater do React não
// roda na hora quando a chamada vem depois de um `await` (fora do handler
// de evento), então o que ia pro arquivo era o environment de ANTES do
// script, numa corrida com o efeito de auto-save. Era assim que o valor
// gravado por um fluxo sumia ao rodar o seguinte. Quem persiste é o efeito
// que observa `environments`, e só ele.
const syncEnvToGlobal = useCallback((
  previousEnvMap: Record<string, string>,
  currentEnvMap: Record<string, string>,
  /** Nome da request cujo script fez a gravação — vai no aviso de perda. */
  requestName?: string
) => {
  const envId = activeEnv?.id;
  if (!envId) return;

  // Apagar variável sem deixar rastro é o que faz um valor "sumir sozinho"
  // vinte passos adiante. Um script de limpeza no passo 01 é legítimo; o
  // problema é só ele ser invisível. O Console do app registra quem apagou,
  // o que havia, e em qual request — sem precisar abrir o DevTools.
  patchEnvironmentVariables(envId, previousEnvMap, currentEnvMap, loss => {
    const acao = loss.kind === 'removed' ? 'deleted' : 'emptied';
    pushLog(
      'warn',
      `Script ${acao} {{${loss.key}}}`,
      {
        requestName,
        source: 'script',
        detail:
          `Value lost: ${loss.previous}\n` +
          `Environment: ${activeEnv?.name ?? '?'}\n` +
          (loss.kind === 'removed'
            ? 'The script called pm.environment.unset() — or returned an env map without this key.'
            : 'The script wrote an empty value over it.'),
      }
    );
  });
}, [activeEnv?.id, activeEnv?.name, patchEnvironmentVariables, pushLog]);

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

  // Os dois erros de script também voltam a null aqui — é a bolinha
  // vermelha "zerando" antes de rodar de novo. Sem isto, um erro de três
  // sends atrás continuaria aceso mesmo que desta vez o script rode limpo.
  patchTabRequestState(tabId, {
    isRequesting: true,
    startTime: Date.now(),
    error: null,
    debugResult: null,
    preRequestScriptError: null,
    postResponseScriptError: null,
  });

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
        if (preResult?.env) { const prevEnvMap = envMap; envMap = preResult.env; await syncEnvToGlobal(prevEnvMap, envMap, tab.name); }
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
          // Acende a bolinha vermelha da aba "Pre-request" com um resumo
          // pronto pra tela — não o texto cru do sandbox (que começa com
          // "❌" e às vezes carrega o stack trace inteiro na frente).
          patchTabRequestState(tabId, {
            error: message,
            preRequestScriptError: parseScriptError(preResult.scriptError),
          });
          return;
        }
      } catch (e) {
        // O próprio sandbox falhou (não compilou, travou). Também não envia:
        // o script não chegou a rodar, então nada garante que a request
        // esteja no estado que ele deixaria.
        const message = `Pre-request script error: ${e}`;
        pushLog('error', message, { requestName: tab.name, source: 'script' });
        patchTabRequestState(tabId, {
          error: message,
          // Aqui não é o formato "❌ ..." do sandbox — é o catch do próprio
          // invoke (IPC, parse, timeout). firstLine corta em 140 chars só
          // pro resumo; o detail guarda o erro inteiro.
          preRequestScriptError: { summary: firstLine(String(e)), detail: String(e) },
        });
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
        if (postResult?.env) await syncEnvToGlobal(envMap, postResult.env, tab.name);
        if (postResult?.tests) testResults = postResult.tests;
        if (postResult?.scriptError) {
          pushLog('error', `Post-response script error: ${firstLine(postResult.scriptError)}`, {
            requestName: tab.name,
            source: 'script',
            detail: postResult.scriptError,
          });
          // Diferente do pre-request, não há `return`: a resposta já chegou
          // e continua sendo mostrada — um post-response que quebra MEDE,
          // não bloqueia (ver SCRIPTING.md). A bolinha vermelha ainda assim
          // precisa acender, pra dizer qual das duas fases foi.
          patchTabRequestState(tabId, {
            postResponseScriptError: parseScriptError(postResult.scriptError),
          });
        }
      } catch (e) {
        pushLog('error', `Post-response script error: ${e}`, { requestName: tab.name, source: 'script' });
        patchTabRequestState(tabId, {
          postResponseScriptError: { summary: firstLine(String(e)), detail: String(e) },
        });
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

// Mesma ideia do handleOpenResponseInNewWindow acima, mas genérico — cada
// componente (script, response) do Collection Runner tem seu PRÓPRIO botão
// e abre sua PRÓPRIA janela, em vez de uma janela só com os dois juntos.
const handleOpenTextInNewWindow = useCallback(async (
  content: string, title: string, lang: 'json' | 'javascript' = 'json'
) => {
  const storageKey = `response-viewer:${crypto.randomUUID()}`;
  if (!safeSetItem(storageKey, content)) {
    toast.error('Not enough local storage to open this in a new window');
    return;
  }

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const label = `response-${Date.now()}`;

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
      url: `/response-viewer?key=${encodeURIComponent(storageKey)}&title=${encodeURIComponent(title)}&lang=${lang}`,
      title,
      width: NEW_WIN_WIDTH,
      height: NEW_WIN_HEIGHT,
      minWidth: 480,
      minHeight: 320,
      ...(position ? { x: position.x, y: position.y } : { center: true }),
      decorations: false,
    });

    win.once('tauri://error', (e) => {
      console.error('Erro ao abrir janela de texto:', e);
    });
  } catch (e) {
    console.error('Falha ao criar janela:', e);
  }
}, []);

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
      // Status + a mensagem da notificação do body (lib/exampleName): é o
      // que diferencia um cenário de erro do outro na árvore.
      name: exampleNameFor(activeTab.response.status, getStatusText(activeTab.response.status), activeTab.response.parsedBody),
      type: 'example',
      method: requestNode.method,
      // Snapshot da request original no momento do save — mesmo padrão que
      // createExample (useCollectionTree.ts) usa pro "Add Example" vazio, e
      // o que o Postman de verdade guarda em cada Saved Example. O body (e o
      // tipo dele) vêm da ABA, não do que está salvo na árvore: é o body que
      // gerou esta resposta, mesmo que a edição ainda não tenha sido salva.
      // O Post-response ganha os testes de que esta resposta é o esperado
      // (status e formato do body), que o "Try" do example roda.
      request: applyTabUpdatesToItem(requestNode, {
        requestBodyValue: activeTab.requestBodyValue ?? '',
        bodyType: activeTab.bodyType,
        scripts: {
          preRequest: requestNode.request?.scripts?.preRequest ?? '',
          postResponse: withExpectedBehavior(
            requestNode.request?.scripts?.postResponse,
            expectedBehaviorTests(activeTab.response.status, activeTab.response.parsedBody, activeTab.response.isBinary)
          ),
        },
      }).request,
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

  // "Save as request" de uma aba de Try (aviso do Ctrl+S, ver saveTabsList):
  // cria a request ao lado da original e a aba PASSA A SER essa request —
  // os próximos Ctrl+S salvam nela normalmente.
  const saveTryTabAsRequest = useCallback(async (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab?.tryOfExampleId) return;
    const result = placeTryTabsAsRequests(collectionsRef.current, [tab]);
    const item = result.placed.get(tab.id);
    if (!item) {
      toast.error('The original example no longer exists — there is nowhere to put this request.');
      return;
    }
    collectionsRef.current = result.tree;
    setCollections(result.tree);
    await saveWorkspaceCollections(selectedWorkspaceRef.current, result.tree);
    setTabs(prev =>
      prev.map(t =>
        t.id === tab.id ? { ...t, id: item.id, name: item.name, tryOfExampleId: undefined, isDirty: false } : t
      )
    );
    setActiveTabId(prev => (prev === tab.id ? item.id : prev));
    removeTabDrafts([tab.id]);
    toast.success(`Saved as a new request: "${item.name}"`);
  }, []);
  useEffect(() => {
    saveTryTabAsRequestRef.current = saveTryTabAsRequest;
    updateExampleFromResponseRef.current = handleUpdateExampleFromResponse;
  }, [saveTryTabAsRequest, handleUpdateExampleFromResponse]);

const handleGitHubPull = useCallback(async (rawData: unknown) => {
  const result = importData(rawData);
  const workspace = selectedWorkspaceRef.current; // ✅ sempre atual
  if (result.collections) {
    const fixedCollections = backfillExampleRequests(result.collections);
    // Só a das collections: ligar também a dos environments sem trocá-los
    // (pull sem environments) deixava a flag acesa, e ela engolia a
    // PRÓXIMA edição de environment — que nunca era marcada pra push.
    suppressPendingMarkRef.current = true;
    setCollections(fixedCollections);
    await saveWorkspaceCollections(workspace, fixedCollections);
    // Local = GitHub agora: vira a base (substituindo a anterior). Sem isto,
    // depois de "Discard mine" tudo parecia "alterado aqui" pro merge.
    void recordSyncBase(workspace, nodeHashes(fixedCollections), [], 'all');
  }
  clearWorkspacePendingPush(workspace);
  setPendingPush(EMPTY_PENDING);
  if (result.environments) {
    suppressEnvPendingMarkRef.current = true;
    setEnvironments(result.environments);
    await saveWorkspaceEnvironments(workspace, result.environments);
    setEnvVersion(v => v + 1);
    // Os environments também passam a ser o GitHub: sem a base deles, o
    // merge seguinte via cada variável como "sem base" e ficava sempre com
    // a daqui.
    void recordSyncBase(workspace, environmentHashes(result.environments), [ENV_BASE_PREFIX]);
  }
  setImportToast(result);
  setTimeout(() => setImportToast(null), 5000);
}, [importData, setEnvironments]); // selectedWorkspace removido das deps

  const handleGitHubPullEnvironments = useCallback(async (rawData: unknown) => {
    const result = importData(rawData);
    // Do ref, não da closure: o callback pode ter nascido com outro
    // workspace selecionado.
    const workspace = selectedWorkspaceRef.current;
    // O que vem do GitHub não é edição local: sem isto, todo environment
    // puxado acendia "pendente de push".
    suppressEnvPendingMarkRef.current = true;
    // E o que estava pendente deixa de estar — local = GitHub agora.
    clearEnvironmentsPendingPush(workspace, environmentsRef.current.map(e => e.id));

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

      // ✅ dedup por id — mantém a última ocorrência. Token de sessão (sobe
      // vazio) e cor continuam os daqui (lib/sync/pulledEnvironments).
      const deduped = withLocalOnlyValues(
        Array.from(new Map(incoming.map(env => [env.id, env])).values()),
        environmentsRef.current
      );

      setEnvironments(deduped);

      await saveWorkspaceEnvironments(workspace, deduped);
      setEnvVersion(v => v + 1);
      // Base sem o token: é o que está lá, e com ele o merge seguinte leria
      // o vazio de lá como "mudou no GitHub" e apagaria o daqui.
      void recordSyncBase(workspace, environmentHashes(withoutSessionTokens(deduped)), [ENV_BASE_PREFIX]);
    } else {
      // Workspace sem environments válidos no GitHub: o pull substitui pelo
      // que veio de lá, que é nada.
      setEnvironments([]);
      await saveWorkspaceEnvironments(workspace, []);
      setEnvVersion(v => v + 1);
      void recordSyncBase(workspace, {}, [ENV_BASE_PREFIX]);
    }
    setPendingPush(readPendingPush(workspace));

    setImportToast(result);
    setTimeout(() => setImportToast(null), 5000);
  }, [importData, setEnvironments]); // ✅

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
    rawEnvironments: unknown[],
    // `fromCommit`: restauração de um commit ANTIGO — o GitHub de hoje é
    // outro, então isto não vira a base da sincronização.
    options?: { fromCommit?: boolean }
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

    const { collections: existingCollections, environments: existingEnvironments } = await loadWorkspaceLocalData(workspaceName);
    const localEnvironments = (Array.isArray(existingEnvironments) ? existingEnvironments : []) as Environment[];
    // Nenhum arquivo de environment lá: os daqui ficam (o workspace pode
    // nunca ter enviado os seus). Antes virava lista vazia e os apagava —
    // o Pull do painel (performPull) já tratava assim.
    const keepLocalEnvironments = rawEnvironments.length === 0;
    if (keepLocalEnvironments) environments = localEnvironments;
    // Token de sessão (sobe vazio) e cor são desta máquina (lib/sync/pulledEnvironments).
    else environments = withLocalOnlyValues(environments, localEnvironments);

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
    // não há mais nada "salvo mas não enviado" nele — menos os environments
    // daqui que ficaram (nenhum lá): esses continuam esperando o push.
    const envPendingBefore = readPendingPush(workspaceName).environments;
    clearWorkspacePendingPush(workspaceName);
    if (keepLocalEnvironments && envPendingBefore.length > 0) markEnvironmentsPendingPush(workspaceName, envPendingBefore);

    // E o que veio vira a base (substituindo a anterior) — senão o merge
    // seguinte lia como "alterado aqui" o que só tinha vindo de lá.
    // A base dos environments: sem os tokens de sessão (o que está lá), e
    // intocada quando eles não vieram de lá.
    if (!options?.fromCommit) {
      void recordSyncBase(
        workspaceName,
        { ...nodeHashes(collections), ...(keepLocalEnvironments ? {} : environmentHashes(withoutSessionTokens(environments))) },
        keepLocalEnvironments ? [] : [ENV_BASE_PREFIX],
        'all'
      );
    }

    if (selectedWorkspaceRef.current === workspaceName) {
      suppressPendingMarkRef.current = true;
        suppressEnvPendingMarkRef.current = true;
      setCollections(collections);
      setEnvironments(environments);
      setEnvVersion(v => v + 1);
      setPendingPush(readPendingPush(workspaceName));
    }
  }, [importData, setEnvironments]);

  // Abre a janela de histórico de commits do workspace (ícone de relógio no
  // menu de workspaces) — de lá dá pra baixar o estado dos arquivos em um
  // commit específico, e não só a versão mais recente da branch.
  const handleOpenCommitHistory = useCallback((workspaceName: string) => {
    githubSyncRef.current?.openCommitHistory(workspaceName);
  }, []);

  // Push concluído com sucesso. `pushed` é o que SUBIU — não o que está na
  // tela agora: o que foi editado enquanto o push estava na rede não está no
  // GitHub, e gravar a base a partir da tela diria que está (a edição nunca
  // mais seria enviada).
  const handlePushCompleted = useCallback((
    workspaceName: string,
    pushed?: { collections: unknown[]; environments: unknown[]; keptStale?: boolean }
  ) => {
    const isCurrent = workspaceName === selectedWorkspaceRef.current;
    const keptStale = pushed?.keptStale === true;
    const sentCollections = (pushed?.collections as CollectionItem[] | undefined) ?? (isCurrent ? collectionsRef.current : undefined);
    const sentEnvironments = (pushed?.environments as Environment[] | undefined) ?? (isCurrent ? environmentsRef.current : undefined);

    clearWorkspacePendingPush(workspaceName);
    if (isCurrent && sentCollections) {
      // Pendente continua só o que ainda difere do que subiu.
      const still = compareWorkspaces(collectionsRef.current, sentCollections);
      const stillIds = [...still.modified, ...still.onlyLocal];
      if (stillIds.length > 0) markCollectionsPendingPush(workspaceName, stillIds);
      const sentEnvById = new Map((sentEnvironments ?? []).map(env => [env.id, JSON.stringify(env.values)]));
      const changedEnvs = environmentsRef.current
        // Sem os tokens de sessão: eles não sobem (lib/jwt), e compará-los
        // remarcava como pendente o environment que acabou de subir.
        .filter(env => sentEnvById.get(env.id) !== JSON.stringify(withoutSessionTokens([env])[0].values))
        .map(env => env.id);
      if (changedEnvs.length > 0) markEnvironmentsPendingPush(workspaceName, changedEnvs);
      // O "não sincronizado" do seletor de environment: só o envio de UM
      // environment o zerava; enviar o workspace (agora o caminho da
      // Central) deixava o aviso aceso.
      for (const env of sentEnvironments ?? []) if (!changedEnvs.includes(env.id)) markEnvironmentSynced(env.id);
    }
    // Arquivos apagados aqui que a pessoa manteve no GitHub: a exclusão
    // continua esperando um push.
    if (keptStale) markFullPushRequired(workspaceName);
    if (isCurrent) setPendingPush(readPendingPush(workspaceName));

    // O que subiu vira o estado comum, SUBSTITUINDO o anterior (collections
    // e environments): o push leva o workspace inteiro, então o que não está
    // nele deixou de existir — e não pode ficar na base (ver dropReplaced).
    // Mantendo no GitHub o que foi apagado aqui (keptStale), a base do que
    // ficou lá não sai: sem ela, o pull leria aquilo como "novo no GitHub" e
    // traria de volta o que a pessoa apagou. Substitui só o que subiu.
    if (sentCollections) {
      void recordSyncBase(
        workspaceName,
        { ...nodeHashes(sentCollections), ...(sentEnvironments ? environmentHashes(sentEnvironments) : {}) },
        sentEnvironments && !keptStale ? [ENV_BASE_PREFIX] : [],
        keptStale ? sentCollections.map(c => c.id) : 'all'
      );
    }

    // Relatório do merge que este push fez: o que veio dos outros e o que
    // ficou com a versão daqui sem perguntar (que entra no histórico).
    const report = pushReportRef.current;
    pushReportRef.current = null;
    if (report && report.workspace === workspaceName && (report.incoming > 0 || report.keptMine.length > 0)) {
      const at = new Date().toISOString();
      void recordConflictDecisions(report.keptMine.map(item => ({ at, workspace: workspaceName, item, choice: 'kept-mine-auto' as const })));
      toast.success(`"${workspaceName}" pushed — merged with GitHub`, {
        description: `${report.incoming} change(s) from GitHub came in${report.keptMine.length ? `, ${report.keptMine.length} kept yours` : ''}.`,
        duration: 12000,
        action: {
          label: syncText.reportDetails,
          onClick: () => setSyncList({ title: syncText.reportTitle(workspaceName), sections: report.sections }),
        },
      });
    }
  }, [syncText, markEnvironmentSynced]);

  // Compara o remoto recém-buscado com o que está na tela, sem aplicar nada.
  //
  // Passa o remoto pelo MESMO importData/backfill do pull antes de comparar.
  // Sem isso a comparação seria entre formatos diferentes (o do arquivo e o
  // da árvore) e acusaria diferença em toda collection, sempre.
  const handleCompareRemote = useCallback((
    _workspaceName: string,
    rawCollections: unknown[],
    _rawEnvironments?: unknown[],
    isPushConflict?: boolean
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
    setDiffReviewScope('collections');
    if (nodes.length > 0) {
      // Veio de um conflito de push (não do "Check remote updates" manual):
      // marca pra handleApplyDiff reenviar o push inteiro depois da mescla.
      // Só aqui dentro — sem diferença nenhuma pra mostrar, a tela nem abre,
      // e a flag ficaria presa esperando uma mescla que nunca vai rolar.
      if (isPushConflict) setPushAllAfterDiff(true);
      // Abre só com a base certa carregada: a seleção inicial (o que já vem
      // marcado) sai dela e não é refeita depois — aberta antes, usava a base
      // da revisão anterior (ou de outro workspace). A marca de "abriu a
      // revisão" vai já: quem chamou (Central) não espera a base carregar.
      reviewRequestedRef.current = true;
      void loadSyncBase(selectedWorkspaceRef.current).then(base => {
        setDiffBase(base);
        openReviewDialog();
      });
    } else {
      void loadSyncBase(selectedWorkspaceRef.current).then(setDiffBase);
    }

    if (nodes.length === 0) return { summary, hasChanges: false };
    return { summary: `${summary} (${nodes.length} item${nodes.length === 1 ? '' : 's'})`, hasChanges: true };
  }, [collections, importData]);

  // Conflito ao enviar um workspace pelo menu (handlePushSingleWorkspace) —
  // esse workspace pode não ser o selecionado agora, então a base local do
  // merge é o snapshot que veio junto do conflito (ver pushSingleWorkspace em
  // GitHubStorageClient), nunca `collections`: misturar os dois aplicaria a
  // mescla certa no workspace errado.
  const handleWorkspacePushConflict = useCallback((
    workspaceName: string,
    localCollections: unknown[],
    localEnvironments: unknown[],
    rawRemoteCollections: unknown[],
  ) => {
    const imported = importData(rawRemoteCollections);
    const remoteTree = backfillExampleRequests(imported.collections ?? []);
    const localTree = (localCollections as CollectionItem[]) ?? [];
    const nodes = diffTrees(localTree, remoteTree);
    if (nodes.length === 0) return false;

    const names = new Map<string, string>();
    for (const c of [...localTree, ...remoteTree]) {
      if (c?.id) names.set(c.id, c.name);
    }

    setDiffNodes(nodes);
    setDiffNames(names);
    setDiffRemoteTree(remoteTree);
    setDiffTarget('collections');
    setDiffReviewScope('collections');
    setDiffBase(null);
    setDiffLocalOverride({ collections: localTree, environments: (localEnvironments as Environment[]) ?? [] });
    setPushWorkspaceAfterDiff(workspaceName);
    openReviewDialog();
    return true;
  }, [importData]);

  // Merge automático do push (lib/sync/rebase): o GitHub mudou desde a
  // última sincronização, então em vez de abrir a revisão inteira, reaplica
  // por cima da versão de lá só o que mudou AQUI. Sem conflito, devolve a
  // árvore a enviar (e já aplica aqui o que veio de lá); com conflito, abre a
  // revisão filtrada só neles, e o push continua quando ela for aplicada.
  const handleRebasePush = useCallback(async (
    workspaceName: string,
    localCollections: unknown[],
    localEnvironments: unknown[],
    rawRemoteCollections: unknown[],
    rawRemoteEnvironments: unknown[],
    options?: { environmentsOnly?: boolean }
  ): Promise<RebaseOutcome> => {
    const isCurrent = workspaceName === selectedWorkspaceRef.current;
    const imported = importData(rawRemoteCollections);
    const remoteTree = backfillExampleRequests(imported.collections ?? []);
    const base = await loadSyncBase(workspaceName);
    const pending = new Set(readPendingPush(workspaceName).collections);
    // A árvore de AGORA, lida depois das esperas (rede, base): a do começo
    // do push pode já estar velha, e a mescla substitui a árvore daqui — o
    // que fosse editado nesse meio tempo se perderia.
    const local = isCurrent ? collectionsRef.current : ((localCollections as CollectionItem[]) ?? []);
    // "Cancelar" da Central: antes de mesclar aqui o que veio do GitHub.
    throwIfSyncCancelled();

    // Depois de uma revisão: as collections já foram decididas, só os
    // environments passam pelo merge (ver handlePushEverything).
    const result = options?.environmentsOnly
      ? null
      : rebaseCollections(local, remoteTree, base, pending);

    // Environments, variável a variável (lib/sync/envMerge): o que mudou só
    // lá entra, o resto fica como está aqui. Nunca abre revisão. Aplicado
    // aqui JÁ, antes da revisão de collections que possa abrir: o push que
    // vem depois dela envia os environments do estado, e o sha que ele usa
    // é o desta leitura — sem isto, gravaria por cima do que mudou lá.
    const localEnvs = isCurrent ? environmentsRef.current : ((localEnvironments as Environment[]) ?? []);
    const remoteEnvs = importData(rawRemoteEnvironments).environments ?? [];
    const envResult = rebaseEnvironments(localEnvs, remoteEnvs, base);
    if (envResult.incoming > 0) {
      if (isCurrent) {
        suppressEnvPendingMarkRef.current = true;
        environmentsRef.current = envResult.merged;
        setEnvironments(envResult.merged);
      } else {
        await saveWorkspaceEnvironments(workspaceName, envResult.merged);
      }
    }

    if (!result) {
      pushReportRef.current = {
        workspace: workspaceName,
        sections: mergeReportSections(null, envResult, false),
        keptMine: envResult.keptMineNames,
        incoming: envResult.incoming,
      };
      return { status: 'push', collections: localCollections, environments: envResult.merged, incoming: envResult.incoming, keptMine: envResult.keptMineNames };
    }

    if (result.conflicts.length > 0) {
      setDiffConflictsOnly(true);
      if (isCurrent) {
        handleCompareRemote(workspaceName, rawRemoteCollections, rawRemoteEnvironments, true);
      } else {
        handleWorkspacePushConflict(workspaceName, local, localEnvironments, rawRemoteCollections);
        // A revisão de outro workspace precisa da base DELE pra dizer quem
        // mexeu em cada item (handleWorkspacePushConflict zera a base).
        setDiffBase(base);
      }
      return { status: 'review', conflicts: result.conflicts.length };
    }

    // Item juntado campo a campo também traz algo de lá (o campo que o GitHub
    // mudou) — conta como mudança que chega, igual a um item inteiro.
    const incoming = result.incoming + result.fieldMerged + envResult.incoming;
    // O que ficou com a versão daqui sem perguntar (mudou dos dois lados):
    // a mensagem do push diz, em vez de sobrescrever lá em silêncio.
    const keptMine = [...result.keptMineNames, ...envResult.keptMineNames];
    pushReportRef.current = { workspace: workspaceName, sections: mergeReportSections(result, envResult, false), keptMine, incoming };
    if (result.incoming + result.fieldMerged === 0) {
      return { status: 'push', collections: local, environments: envResult.merged, incoming, keptMine };
    }

    // O que veio do GitHub entra aqui também: depois do push, local e remoto
    // são a mesma árvore. Sem marcar pendência — não é edição local.
    await saveWorkspaceCollections(workspaceName, result.merged);
    if (isCurrent) {
      suppressPendingMarkRef.current = true;
      // O ref já na hora: handlePushCompleted grava a base a partir dele, e
      // o push termina antes do próximo render.
      collectionsRef.current = result.merged;
      setCollections(result.merged);
    }
    return { status: 'push', collections: result.merged, environments: envResult.merged, incoming, keptMine };
  }, [importData, handleCompareRemote, handleWorkspacePushConflict, setEnvironments, mergeReportSections]);

  // Guarda o estado de antes de um pull/revisão — o "Desfazer" volta a ele.
  // Só o workspace aberto (é o que tem a árvore em memória).
  // Snapshot tirado ANTES de abrir uma revisão (antes de mesclar marcadores e
  // environments, que não esperam a revisão). O apply da revisão o usa em vez
  // de tirar outro — tirado no apply, o Desfazer já não voltava esses dois.
  const undoPrimedRef = useRef<typeof undoRef.current>(null);
  const takeUndoSnapshot = useCallback(async (workspaceName: string) => {
    if (workspaceName !== selectedWorkspaceRef.current) return;
    undoRef.current = {
      workspace: workspaceName,
      at: Date.now(),
      collections: collectionsRef.current,
      environments: environmentsRef.current,
      pending: readPendingPush(workspaceName),
      base: await loadSyncBase(workspaceName),
      synced: (await githubSyncRef.current?.snapshotSynced(workspaceName)) ?? {},
      markers: markersRef.current,
    };
  }, []);

  // Volta ao estado de antes do último pull/revisão — árvore, environments,
  // pendências, base e o registro de sincronizado. Os quatro juntos: voltar
  // só a árvore faria o próximo push "desfazer" no GitHub o que tinha vindo.
  const undoLastPull = useCallback(async (force = false) => {
    const snap = undoRef.current;
    if (!snap) return;
    if (Date.now() - snap.at > 10 * 60_000 || snap.workspace !== selectedWorkspaceRef.current) {
      undoRef.current = null;
      toast.error(syncText.undoExpired);
      return;
    }
    // Editou depois do pull: desfazer volta TUDO ao de antes dele, e essas
    // edições iriam junto, sem aviso. Pergunta antes.
    if (!force && lastLocalEditRef.current > snap.at) {
      toast.warning(syncText.undoLosesEdits, {
        duration: 15000,
        action: { label: syncText.undoAnyway, onClick: () => void undoLastPull(true) },
      });
      return;
    }
    undoRef.current = null;
    const workspace = snap.workspace;
    suppressPendingMarkRef.current = true;
    suppressEnvPendingMarkRef.current = true;
    collectionsRef.current = snap.collections;
    environmentsRef.current = snap.environments;
    setCollections(snap.collections);
    setEnvironments(snap.environments);
    await saveWorkspaceCollections(workspace, snap.collections);

    clearWorkspacePendingPush(workspace);
    if (snap.pending.collections.length) markCollectionsPendingPush(workspace, snap.pending.collections);
    if (snap.pending.environments.length) markEnvironmentsPendingPush(workspace, snap.pending.environments);
    if (snap.pending.requiresFullPush) markFullPushRequired(workspace);
    setPendingPush(readPendingPush(workspace));

    // Marcadores e a base deles também voltam (MARKER_BASE_PREFIX: o que o
    // pull gravou sai, e o do snapshot entra).
    markersRef.current = snap.markers;
    setMarkers(snap.markers);
    await saveWorkspaceMarkers(workspace, snap.markers);
    if (snap.base) await recordSyncBase(workspace, snap.base, [ENV_BASE_PREFIX, MARKER_BASE_PREFIX], 'all');
    else await clearSyncBase(workspace);
    await githubSyncRef.current?.restoreSynced(workspace, snap.synced);
    toast.success(syncText.undoDone);
  }, [setEnvironments, syncText]);

  // Histórico de decisões de conflito (lib/sync/conflictHistory).
  const handleShowConflictHistory = useCallback(async () => {
    const t = syncText;
    const entries = await loadConflictHistory();
    setSyncList({
      title: t.historyTitle,
      subtitle: t.historySubtitle,
      sections: [{
        title: t.historyTitle,
        tone: 'neutral',
        items: entries.map(e => ({
          primary: e.item,
          secondary: [t.choiceLabels[e.choice], e.workspace, new Date(e.at).toLocaleString(), e.fields?.join(', ')]
            .filter(Boolean)
            .join(' · '),
        })),
        emptyText: t.historyEmpty,
      }],
    });
  }, [syncText]);

  // "Quem mudou este item?": percorre os últimos commits do arquivo da
  // collection e compara o item versão a versão — o primeiro commit em que
  // ele difere da versão anterior é quem mexeu por último.
  const handleWhoChangedItem = useCallback(async (rootId: string, nodeId: string) => {
    const workspaceName = pushWorkspaceAfterDiff ?? selectedWorkspaceRef.current;
    const limit = 15;
    const history = await githubSyncRef.current?.fileHistoryOf(workspaceName, rootId, limit);
    if (!history) return null;
    const { commits, read } = history;
    // undefined = não deu pra ler aquela versão; null = o item não existia nela.
    const nodeAt = async (sha: string): Promise<CollectionItem | null | undefined> => {
      const raw = await read(sha);
      if (!raw) return undefined;
      const tree = backfillExampleRequests(importData(Array.isArray(raw) ? raw : [raw]).collections ?? []);
      return findNodeById(tree, nodeId) ?? null;
    };
    const asChange = (index: number, kind: ItemChange['kind'], fields: string[]): ItemChange => ({
      authorName: commits[index].authorName,
      date: commits[index].date,
      message: commits[index].message,
      kind,
      fields,
    });

    let newer = commits.length ? await nodeAt(commits[0].sha) : undefined;
    for (let i = 0; i < commits.length; i++) {
      const isOldest = i + 1 >= commits.length;
      // Sem commit mais antigo na lista: se ela não encheu, o arquivo nasceu aqui.
      const older = isOldest ? (commits.length < limit ? null : undefined) : await nodeAt(commits[i + 1].sha);
      if (newer !== undefined && older !== undefined) {
        if (newer && !older) return { change: asChange(i, 'created', []), searched: commits.length };
        if (!newer && older) return { change: asChange(i, 'deleted', []), searched: commits.length };
        if (newer && older) {
          const fields = fieldDiffs(newer, older).map(f => f.field);
          if (fields.length > 0) return { change: asChange(i, 'changed', fields), searched: commits.length };
        }
      }
      newer = older;
    }
    return { change: null, searched: commits.length };
  }, [importData, pushWorkspaceAfterDiff]);

  // Aviso antecipado de conflito (aviso em segundo plano do GitHubSync): o
  // mesmo merge do push/pull, só que SEM aplicar nada — devolve os itens que
  // mudaram dos dois lados. Só pro workspace aberto (é o que tem a árvore
  // daqui em memória).
  // O merge de teste do push/pull SEM aplicar nada, sobre o GitHub de agora
  // lido em modo prévia (peek) — o que o aviso em segundo plano e a Central
  // de Sincronização mostram. Só pro workspace aberto (é o que tem a árvore
  // daqui em memória). `null` = não deu pra ler o GitHub inteiro.
  const peekSyncMerge = useCallback(async (workspaceName: string) => {
    if (workspaceName !== selectedWorkspaceRef.current) return null;
    // peek: o aviso roda sozinho, até com uma revisão aberta — se marcasse
    // a versão como lida, a revisão registraria como sincronizado o que
    // ninguém viu, e o push que a segue passaria por cima.
    const remote = await githubSyncRef.current?.fetchWorkspace(workspaceName, undefined, undefined, { peek: true });
    if (!remote || remote.failedPaths.length > 0) return null;
    const remoteTree = backfillExampleRequests(importData(remote.collections).collections ?? []);
    const base = await loadSyncBase(workspaceName);
    const result = rebaseCollections(
      collectionsRef.current,
      remoteTree,
      base,
      new Set(readPendingPush(workspaceName).collections)
    );
    const byId = new Map(result.nodes.map(n => [n.id, n]));
    // O que mudou nas variáveis de environment (só os nomes: valor costuma
    // ser token) — pro aviso dizer isso também.
    const remoteEnvs = importData(remote.environments).environments ?? [];
    const envResult = rebaseEnvironments(environmentsRef.current, remoteEnvs, base);
    // A versão da última sincronização das collections com item mudado —
    // é ela que deixa a "Ver diferença" do aviso mostrar QUEM mudou cada
    // trecho (três painéis). Uma leitura por collection, guardada por sha
    // (syncedVersionOf); sem ela a visão fica de duas vias.
    const touchedRoots = [
      ...new Set([...result.incomingDetails, ...result.conflictDetails, ...result.outgoingDetails].map(d => byId.get(d.id)?.rootId).filter(Boolean)),
    ] as string[];
    const baseRoots = new Map<string, CollectionItem | null>();
    await Promise.all(
      touchedRoots.map(async rootId => {
        try {
          const raw = await githubSyncRef.current?.syncedVersionOf(workspaceName, rootId);
          const tree = raw ? backfillExampleRequests(importData(Array.isArray(raw) ? raw : [raw]).collections ?? []) : [];
          baseRoots.set(rootId, tree.find(c => c.id === rootId) ?? (tree.length === 1 ? tree[0] : null));
        } catch {
          baseRoots.set(rootId, null);
        }
      })
    );
    const baseItemOf = (node: DiffNode): CollectionItem | null | undefined => {
      const root = baseRoots.get(node.rootId);
      return root ? findNodeById([root], node.id) ?? null : undefined;
    };
    // O catálogo de marcadores não entra no merge das collections: o que
    // receber mudaria aqui (o mesmo mergeCatalogs do pull, sem aplicar).
    const markers = markerChangesFromRemote(markersRef.current, remote.markers ?? null, base);
    return { result, envResult, baseItemOf, markers, remoteTree, remoteEnvs };
  }, [importData]);

  const handleConflictPreview = useCallback(async (workspaceName: string, changedRootIds: string[] = []) => {
    const merge = await peekSyncMerge(workspaceName);
    if (!merge) return null;
    const { result, envResult, baseItemOf } = merge;
    const byId = new Map(result.nodes.map(n => [n.id, n]));
    // O que a Central mostra no ⚠ da barra, sem precisar abri-la.
    setKnownConflicts(workspaceName, result.conflicts.length);
    // A prévia do aviso: quais itens vieram do GitHub e, de cada um, o
    // valor daqui, o de lá e o da última sincronização (lib/sync/remoteChangeAlert).
    const preview = buildRemoteChangePreview(result, envResult.incomingNames, baseItemOf);
    // Nada a trazer (a mudança já está aqui: push seu de outra máquina, pull
    // anterior): o aviso mostra o que o último commit de cada collection
    // mudou, pra "Ver diferença" sempre ter o que abrir.
    if (preview.items.length === 0 && changedRootIds.length > 0) {
      const toTree = (raw: unknown) =>
        backfillExampleRequests(importData(Array.isArray(raw) ? raw : [raw]).collections ?? []);
      const perRoot = await Promise.all(
        changedRootIds.slice(0, 5).map(async rootId => {
          try {
            const history = await githubSyncRef.current?.fileHistoryOf(workspaceName, rootId, 2);
            if (!history?.commits.length) return [];
            const [newerRaw, olderRaw] = await Promise.all([
              history.read(history.commits[0].sha),
              history.commits[1] ? history.read(history.commits[1].sha) : Promise.resolve(null),
            ]);
            if (!newerRaw) return [];
            // Sem commit anterior o arquivo nasceu nesse; sem conseguir ler, idem.
            return commitChangeItems(olderRaw ? toTree(olderRaw) : null, toTree(newerRaw), collectionsRef.current);
          } catch {
            return [];
          }
        })
      );
      const items = perRoot.flat();
      if (items.length > 0) Object.assign(preview, { items, fromCommit: true });
    }
    return {
      conflicts: result.conflicts.map(id => {
        const node = byId.get(id);
        return node ? node.path.slice(-2).join(' / ') : id;
      }),
      incoming: result.incoming + result.fieldMerged,
      preview,
    };
  }, [importData, peekSyncMerge]);

  // Central de Sincronização: as três listas (receber, enviar, conflitos)
  // do mesmo merge de teste (lib/sync/syncOverview). Lança quando não deu
  // pra ler o GitHub — a Central mostra o erro em vez de "nada a fazer".
  const handleSyncOverview = useCallback(async (): Promise<SyncOverview> => {
    const workspace = selectedWorkspaceRef.current;
    const merge = await peekSyncMerge(workspace);
    if (!merge) throw new Error(syncText.scReadFailed);
    setKnownConflicts(workspace, merge.result.conflicts.length);
    // O que a Central acabou de ler do GitHub: é contra isto que o
    // "Descartar" volta um item (sem ler de novo).
    lastSyncPeekRef.current = { workspace, remoteTree: merge.remoteTree, remoteEnvs: merge.remoteEnvs };
    const overview = withContentPreviews(
      buildSyncOverview(merge.result, merge.envResult, merge.baseItemOf, merge.markers),
      collectionsRef.current,
      merge.remoteTree
    );
    // "Não sincronizado" aceso sem nada a enviar (marcado antes de os tokens
    // de sessão ficarem de fora, ou por uma edição que já subiu por outro
    // caminho): a Central acabou de confirmar com o GitHub, então apaga.
    // Antes ele ficava aceso, e o "Só enviar" desabilitado não o zerava.
    const pendingEnvIds = new Set(readPendingPush(workspace).environments);
    const sendingEnvs = new Set([...overview.envOutgoing, ...overview.envKeptMine].map(name => name.split(' › ')[0]));
    for (const env of environmentsRef.current) {
      if (env.isDirty && !pendingEnvIds.has(env.id) && !sendingEnvs.has(env.name)) markEnvironmentSynced(env.id);
    }
    return overview;
  }, [peekSyncMerge, syncText, markEnvironmentSynced]);

  // "Descartar" da Central: o item (ou a variável) daqui volta a ser o do
  // GitHub — o que a Central acabou de ler. Nada é enviado. Com "Desfazer"
  // (o mesmo snapshot do pull: árvore, environments, pendência e base).
  const handleSyncDiscard = useCallback(async (target: { itemId?: string; envName?: string; label: string }): Promise<SyncActionResult> => {
    const workspace = selectedWorkspaceRef.current;
    const peek = lastSyncPeekRef.current;
    const failed = (message: string): SyncActionResult => ({ result: 'failed', messages: [{ type: 'error', message }] });
    if (!peek || peek.workspace !== workspace) return failed(syncText.scDiscardStale);

    await takeUndoSnapshot(workspace);
    const undo = { label: syncText.undo, run: () => void undoLastPull(true) };

    if (target.envName) {
      const next = discardEnvironmentChange(environmentsRef.current, peek.remoteEnvs, target.envName);
      if (next === environmentsRef.current) return failed(syncText.scDiscardNothing(target.label));
      suppressEnvPendingMarkRef.current = true;
      environmentsRef.current = next;
      setEnvironments(next);
      // Pendência dos environments: só o que ainda difere do GitHub.
      const envName = target.envName.split(' › ')[0];
      const env = next.find(e => e.name === envName);
      const theirs = peek.remoteEnvs.find(e => e.name === envName);
      if (env) {
        const differs = !theirs || diffEnvironments(withoutSessionTokens([env]), withoutSessionTokens([theirs])).length > 0;
        if (differs) markEnvironmentsPendingPush(workspace, [env.id]);
        else {
          clearEnvironmentsPendingPush(workspace, [env.id]);
          markEnvironmentSynced(env.id);
        }
        setPendingPush(readPendingPush(workspace));
      }
      return { result: 'done', messages: [{ type: 'success', message: syncText.scDiscarded(target.label), action: undo }] };
    }

    const { tree, action } = discardLocalChange(collectionsRef.current, peek.remoteTree, target.itemId!);
    if (action === 'none') return failed(syncText.scDiscardNothing(target.label));
    const rootOf = (forest: CollectionItem[]) =>
      forest.find(c => c.id === target.itemId || !!findNodeById([c], target.itemId!));
    const rootId = (rootOf(collectionsRef.current) ?? rootOf(peek.remoteTree))?.id;

    suppressPendingMarkRef.current = true;
    collectionsRef.current = tree;
    setCollections(tree);
    await saveWorkspaceCollections(workspace, tree);
    // Pendência da collection: continua só se ainda sobrar diferença nela.
    if (rootId) {
      const mine = tree.find(c => c.id === rootId);
      const theirs = peek.remoteTree.find(c => c.id === rootId);
      if (mine && theirs) {
        const still = compareWorkspaces([mine], [theirs]);
        if (still.modified.length + still.onlyLocal.length > 0) markCollectionsPendingPush(workspace, [rootId]);
        else clearCollectionsPendingPush(workspace, [rootId]);
      } else if (!mine && !theirs) {
        clearCollectionsPendingPush(workspace, [rootId]);
      }
      setPendingPush(readPendingPush(workspace));
    }
    return { result: 'done', messages: [{ type: 'success', message: syncText.scDiscarded(target.label), action: undo }] };
  }, [setEnvironments, markEnvironmentSynced, takeUndoSnapshot, undoLastPull, syncText]);

  // "Abrir" da Central: a request (ou o example) numa aba. A Central continua
  // aberta — ela não trava o app (modal={false}), e dá pra movê-la pra ver a
  // aba e voltar pra lista sem esperar o GitHub de novo.
  const handleSyncOpenItem = useCallback((itemId: string) => {
    const item = findNodeById(collectionsRef.current, itemId);
    if (!item || (item.type !== 'request' && item.type !== 'example')) return;
    handleRequestSelect(item);
  }, [handleRequestSelect]);

  // Atalhos pra Central: a collection da árvore (filtrada na raiz dela), o
  // environment e o workspace do menu (abre nele, trocando se preciso).
  const handleOpenSyncFor = useCallback((item: CollectionItem, tab?: SyncCenterTab) => {
    const root = collectionsRef.current.find(c => c.id === item.id || !!findNodeById([c], item.id));
    if (!root) {
      openSyncCenter({ tab });
      return;
    }
    if (root.id === item.id) {
      openSyncCenter({ tab, filter: { rootId: root.id, label: root.name } });
      return;
    }
    // Pasta ou request: a Central recorta nela (pelo id e pelo caminho de
    // nomes, que pega também o que é novo lá dentro).
    openSyncCenter({
      tab,
      filter: { rootId: root.id, itemId: item.id, pathPrefix: namePathTo(root, item.id) ?? undefined, label: item.name },
    });
  }, []);
  // "Enviar esta pasta/request…" da árvore: a Central filtrada no item, na
  // aba "Para enviar" — o envio parcial passa pelo mesmo lugar que o resto,
  // com o resultado (e o erro) aparecendo lá. Antes enviava direto, e o
  // resultado ia pro painel do GitHub, que quase nunca está aberto.
  const handleOpenSyncToSend = useCallback((item: CollectionItem) => {
    handleOpenSyncFor(item, 'outgoing');
  }, [handleOpenSyncFor]);
  const handleOpenSyncForEnvironment = useCallback((env: Environment) => {
    openSyncCenter({ tab: env.isDirty ? 'outgoing' : undefined, filter: { environmentName: env.name, label: env.name } });
  }, []);
  const handleSyncWorkspace = useCallback(async (path: string) => {
    if (path !== selectedWorkspaceRef.current) await handleSelectWorkspace(path);
    // A troca falhou (o handleSelectWorkspace já avisou por toast): abrir a
    // Central agora mostraria — e sincronizaria — o workspace ERRADO, o que
    // continuou aberto, sem nada dizendo isso.
    if (selectedWorkspaceRef.current !== path) return;
    openSyncCenter();
  }, [handleSelectWorkspace]);

  // Quem mexeu por último na collection (pra "Recebidos") — o mesmo da revisão.
  const handleSyncCenterLastChange = useCallback(
    (rootId: string) => githubSyncRef.current?.lastChangeOf(selectedWorkspaceRef.current, rootId) ?? Promise.resolve(null),
    []
  );

  // Abre a revisão de environments com um diff já calculado.
  const openEnvironmentReview = useCallback((
    nodes: DiffNode[],
    remoteEnvs: Environment[],
    // O que começa em "Mine" — ver envKeepMineIds. Ausente (restaurar um
    // commit): a escolha é toda de quem está restaurando.
    keepMine: ReadonlySet<string> | null = null
  ) => {
    const names = new Map<string, string>();
    for (const e of [...environments, ...remoteEnvs]) names.set(e.id, e.name);

    setDiffEnvKeepMine(keepMine);
    setDiffNodes(nodes);
    setDiffNames(names);
    setDiffRemoteEnvs(remoteEnvs);
    setDiffTarget('environments');
    setDiffReviewScope('environments');
    // Environments não entram na base: lá a identidade é a key da
    // variável, não um id de nó.
    setDiffBase(null);
    openReviewDialog();
  }, [environments]);

  /**
   * O botão Pull do painel de sync: traz o workspace ATUAL passando pela
   * revisão, em vez de substituir tudo de uma vez.
   *
   * Antes o Pull baixava todos os workspaces do repositório e trocava o
   * local inteiro, sem mescla — enquanto o Push, ao lado, só enviava o
   * workspace atual. Agora os dois falam do mesmo workspace, e o "trocar
   * tudo" virou uma ação separada e explícita no painel.
   *
   * Collections primeiro, environments depois (são telas diferentes). O
   * catálogo de marcadores é mesclado direto, por união, como no pull de
   * uma collection — não há o que decidir ali.
   */
  const handlePullWorkspaceWithReview = useCallback(async () => {
    if (pullingCollectionRef.current) return;
    pullingCollectionRef.current = true;

    const workspace = selectedWorkspaceRef.current;
    try {
      const remote = await githubSyncRef.current?.fetchWorkspace(
        workspace,
        undefined,
        `Checking "${workspace}" on GitHub...`
      );
      if (!remote) return;

      if (remote.collectionPaths.length === 0 && remote.envPaths.length === 0) {
        toast.info(`"${workspace}" isn't on GitHub yet — push it first.`);
        reportSyncStatus('info', `"${workspace}" isn't on GitHub yet — push it first.`);
        return;
      }
      // Algum arquivo não baixou: sem ele, a collection (ou o environment)
      // pareceria "apagado no GitHub" — tanto pra mescla automática quanto
      // pro "Safe defaults" da revisão, que apagaria daqui. Não aplica nada.
      if (remote.failedPaths.length > 0) {
        const description = `${remote.failedPaths.length} file(s) could not be read from GitHub: ${remote.failedPaths
          .map(p => p.split('/').pop())
          .join(', ')}. Try again.`;
        toast.error('Pull cancelled — nothing was changed here', { description });
        reportSyncStatus('error', `Pull cancelled — nothing was changed here. ${description}`);
        return;
      }

      // "Cancelar" da Central: leu, mas nada foi aplicado ainda.
      if (isSyncCancelRequested()) {
        reportSyncStatus('error', SYNC_CANCELLED_MESSAGE);
        return;
      }
      const remoteEnvs = importData(remote.environments).environments ?? [];

      // Arquivo antigo de uma renomeação ainda no GitHub (mesmo id de outro):
      // a leitura usou o mais novo. Diz isso, em vez de calar.
      if (remote.supersededPaths?.length) {
        const names = remote.supersededPaths.map(p => p.split('/').pop()).join(', ');
        const note = `GitHub still has old file(s) left from a rename: ${names}. The newest version was used; your next push removes the old file(s).`;
        toast.info(note, { duration: 12000 });
        reportSyncStatus('info', note);
      }

      // Estado de antes — pro "Desfazer" do toast no fim. ANTES dos
      // marcadores: mesclados primeiro, o Desfazer não os voltava.
      await takeUndoSnapshot(workspace);
      // Quantos marcadores o merge do catálogo muda aqui — calculado antes de
      // aplicar, pra mensagem dizer que algo chegou mesmo quando é só isso.
      const markerChanges = remote.markers
        ? markerChangeCount(markerChangesFromRemote(markersRef.current, remote.markers, await loadSyncBase(workspace)))
        : 0;
      if (remote.markers) await handlePullMarkers(workspace, remote.markers);

      // Mesma mescla do push (lib/sync/rebase + envMerge): o que mudou só no
      // GitHub entra sozinho, o que é seu fica, e a revisão só abre se
      // sobrar conflito de verdade — já filtrada nele.
      const remoteTree = backfillExampleRequests(importData(remote.collections).collections ?? []);
      const base = await loadSyncBase(workspace);
      // Último ponto seguro do pull: daqui em diante a mescla é aplicada.
      if (isSyncCancelRequested()) {
        reportSyncStatus('error', SYNC_CANCELLED_MESSAGE);
        return;
      }
      const result = rebaseCollections(
        collectionsRef.current,
        remoteTree,
        base,
        new Set(readPendingPush(workspace).collections)
      );
      const envResult = rebaseEnvironments(environmentsRef.current, remoteEnvs, base);

      // Environments nunca perguntam (envMerge): aplica e registra o GitHub
      // visto como base deles.
      if (envResult.incoming > 0) {
        suppressEnvPendingMarkRef.current = true;
        environmentsRef.current = envResult.merged;
        setEnvironments(envResult.merged);
      }
      void recordSyncBase(workspace, environmentHashes(remoteEnvs), [ENV_BASE_PREFIX]);

      if (result.conflicts.length > 0) {
        // O apply da revisão usa o snapshot de antes dos marcadores e dos
        // environments que acabaram de entrar.
        undoPrimedRef.current = undoRef.current;
        await githubSyncRef.current?.markReviewed(workspace, 'environments').catch(() => undefined);
        setDiffConflictsOnly(true);
        handleCompareRemote(workspace, remote.collections, remote.environments);
        return;
      }

      // Aplica JÁ, sem espera no meio: a mescla foi calculada sobre a árvore
      // de agora (collectionsRef), e um await aqui deixaria uma edição feita
      // nesse intervalo ser trocada pela mescla.
      const incoming = result.incoming + result.fieldMerged;
      if (incoming > 0) {
        suppressPendingMarkRef.current = true;
        collectionsRef.current = result.merged;
        setCollections(result.merged);
      }
      await githubSyncRef.current?.markReviewed(workspace, 'environments').catch(() => undefined);
      if (incoming > 0) await saveWorkspaceCollections(workspace, result.merged);

      // O que ainda difere do GitHub é seu e continua esperando push; o
      // resto deixa de estar pendente. A exclusão pendente (requiresFullPush)
      // não tem id pra reaparecer na comparação, então é preservada.
      const hadRemovals = readPendingPush(workspace).requiresFullPush;
      clearCollectionsPendingPush(workspace, [...new Set([...result.merged, ...remoteTree].map(c => c.id))]);
      const still = compareWorkspaces(result.merged, remoteTree);
      const stillIds = [...still.modified, ...still.onlyLocal];
      if (stillIds.length > 0) markCollectionsPendingPush(workspace, stillIds);
      if (hadRemovals) markFullPushRequired(workspace);
      setPendingPush(readPendingPush(workspace));

      // O GitHub que acabou de ser visto vira a base (mesma regra da revisão),
      // substituindo a anterior — o que sumiu de lá sai da base.
      void recordSyncBase(workspace, nodeHashes(remoteTree), [], 'all');
      await githubSyncRef.current?.markReviewed(workspace, 'collections').catch(() => undefined);

      const total = incoming + envResult.incoming;
      const yours = result.outgoing + envResult.keptMine;
      const waiting = yours > 0 ? 'Your own changes were kept and are waiting to be pushed.' : undefined;
      if (total === 0) {
        // Nada mudou: nada a desfazer. Marcadores que chegaram contam.
        if (markerChanges === 0) undoRef.current = null;
        const upToDate = markerChanges > 0
          ? `"${workspace}" is up to date with GitHub — ${markerChanges} marker change(s) came in.`
          : `"${workspace}" is up to date with GitHub.`;
        toast.success(upToDate, { description: waiting });
        reportSyncStatus('success', waiting ? `${upToDate} ${waiting}` : upToDate);
      } else {
        const sections = mergeReportSections(result, envResult, true);
        reportSyncStatus('success', `Pulled ${total} change(s) from GitHub into "${workspace}".${waiting ? ` ${waiting}` : ''}`, {
          label: syncText.undo,
          run: () => void undoLastPull(),
        });
        toast.success(`Pulled ${total} change(s) from GitHub into "${workspace}".`, {
          description: waiting,
          duration: 15000,
          action: { label: syncText.reportDetails, onClick: () => setSyncList({ title: syncText.reportTitle(workspace), sections }) },
          cancel: { label: syncText.undo, onClick: () => void undoLastPull() },
        });
      }
    } catch (e) {
      toast.error('Could not read GitHub', { description: (e as Error)?.message ?? String(e) });
      reportSyncStatus('error', `Could not read GitHub: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      pullingCollectionRef.current = false;
    }
  }, [environments, importData, handleCompareRemote, handlePullMarkers, openEnvironmentReview, setEnvironments, takeUndoSnapshot, mergeReportSections, undoLastPull, syncText]);

  // Envia UM environment, com o mesmo merge por variável do push do
  // workspace (lib/sync/envMerge) — o "Só enviar" da Central aberta a partir
  // de um environment. Sem isto o botão mandava o workspace inteiro, com as
  // collections pela metade junto; antes da Central, o "Save environment"
  // mandava só ele. 3 tentativas: alguém pode enviar entre a leitura e o commit.
  const handlePushEnvironmentOnly = useCallback(async (env: Environment) => {
    if (!githubSyncRef.current) return;
    const workspace = selectedWorkspaceRef.current;
    const fail = (message: string) => {
      toast.error('Push cancelled', { description: message });
      reportSyncStatus('error', `Push cancelled: ${message}`);
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      if (isSyncCancelRequested()) {
        reportSyncStatus('error', SYNC_CANCELLED_MESSAGE);
        return;
      }
      let toSend: Environment = environmentsRef.current.find(e => e.id === env.id) ?? env;
      try {
        const remote = await githubSyncRef.current.fetchWorkspace(workspace, undefined, `Checking "${env.name}" on GitHub...`);
        // Arquivo que não baixou pareceria "apagado lá" — e o envio gravaria
        // por cima de uma versão que nem foi lida.
        if (remote && remote.failedPaths.length > 0) {
          fail(`Could not read ${remote.failedPaths.length} file(s) from GitHub (${remote.failedPaths.map(p => p.split('/').pop()).join(', ')}). Nothing was pushed — try again.`);
          return;
        }
        if (remote) {
          const remoteEnvs = importData(remote.environments).environments ?? [];
          const remoteEnv = remoteEnvs.find(e => e.id === toSend.id) ?? remoteEnvs.find(e => e.name === toSend.name);
          const base = await loadSyncBase(workspace);
          // Relê depois das esperas: a mescla troca o environment daqui.
          toSend = environmentsRef.current.find(e => e.id === env.id) ?? toSend;
          throwIfSyncCancelled();
          const result = rebaseEnvironments([toSend], remoteEnv ? [remoteEnv] : [], base);
          const merged = result.merged.find(e => e.id === toSend.id);
          if (merged && result.incoming > 0) {
            const next = environmentsRef.current.map(e => (e.id === merged.id ? merged : e));
            suppressEnvPendingMarkRef.current = true;
            environmentsRef.current = next;
            setEnvironments(next);
            toSend = merged;
          }
        }
      } catch (e) {
        fail((e as Error)?.message ?? String(e));
        return;
      }

      try {
        await githubSyncRef.current.pushEnvironment(toSend);
      } catch (e) {
        if (e instanceof GitHubConflictError) continue;
        // Sem senha, sem configuração, outro envio em curso: o GitHubSync já
        // disse o motivo (e a Central o recebe pelo status).
        return;
      }
      markEnvironmentSynced(env.id);
      // Pendência só deste environment — e só se nada mudou durante o envio.
      const now = environmentsRef.current.find(e => e.id === env.id);
      const sentValues = JSON.stringify(withoutSessionTokens([toSend])[0].values);
      if (!now || JSON.stringify(withoutSessionTokens([now])[0].values) === sentValues) {
        clearEnvironmentsPendingPush(workspace, [env.id]);
        setPendingPush(readPendingPush(workspace));
      }
      // O que subiu vira a base deste environment, sem o token de sessão.
      void recordSyncBase(workspace, environmentHashes(withoutSessionTokens([toSend])), [`${ENV_BASE_PREFIX}${toSend.id}`]);
      return;
    }
    fail(`"${env.name}" kept changing on GitHub while sending. Use "Sync all" to merge and send.`);
  }, [importData, markEnvironmentSynced, setEnvironments]);

  // Ações da Central de Sincronização — os MESMOS caminhos de sempre, sem
  // sync novo:
  //   receive / resolve → o pull com merge (handlePullWorkspaceWithReview):
  //                       o que é só de lá entra, conflito abre a revisão;
  //   send              → o push (handlePushEverything), que também mescla o
  //                       que veio de lá antes de enviar. Com a Central
  //                       filtrada, só aquela collection ou aquele environment;
  //   all               → receber e, se não parou em conflito nem em erro e
  //                       há o que enviar, enviar.
  // O que o push e o pull disseram no caminho volta em `messages`: com a
  // Central aberta, o painel do GitHub está fechado e o resultado sumia.
  const runSyncAction = useCallback(async (
    action: SyncAction,
    scope: SyncActionScope = {},
    // O que a Central contou em "Para enviar" (o merge de teste). A pendência
    // marcada nem sempre o acompanha — e "Sincronizar tudo" pulava o envio
    // com a Central mostrando ↑N.
    hint: { outgoing?: boolean } = {}
  ): Promise<SyncActionResult> => {
    const workspace = selectedWorkspaceRef.current;
    reviewRequestedRef.current = false;
    resetSyncCancel();
    const capture = captureSyncStatus();
    setSyncCenterBusy(true);
    let review = false;
    let reviewedOnReceive = false;
    try {
      if (action === 'receive' || action === 'resolve' || action === 'all') {
        await handlePullWorkspaceWithReview();
        review = reviewRequestedRef.current;
        reviewedOnReceive = review;
      }
      // Cancelado no receber: o envio de "tudo" nem começa.
      if (!review && !isSyncCancelRequested() && (action === 'send' || action === 'all')) {
        // Envio com escopo (Central filtrada, ou o "Enviar" de uma linha): só
        // aquele item — collection, pasta, request ou environment.
        const scoped = action === 'send' && !!(scope.environmentName || scope.itemId || scope.rootId);
        const env = scoped && scope.environmentName
          ? environmentsRef.current.find(e => e.name === scope.environmentName)
          : undefined;
        const targetId = scope.itemId ?? scope.rootId;
        const item = scoped && !scope.environmentName && targetId
          ? findNodeById(collectionsRef.current, targetId)
          : undefined;
        const receiveFailed = action === 'all' && capture.peek().some(m => m.type === 'error');
        if (receiveFailed) {
          // O pedido era "receber e enviar", e o receber já falhou: pára aqui
          // em vez de enviar por cima de um GitHub que não deu pra ler.
          reportSyncStatus('info', 'Nothing was sent, because receiving from GitHub failed.');
        } else if (scoped && !env && !item) {
          // O item sumiu daqui (apagado com a Central aberta, por exemplo).
          // Antes isto caía no push do workspace inteiro — o oposto do pedido.
          reportSyncStatus('error', `"${scope.label ?? scope.environmentName ?? targetId}" no longer exists here — nothing was sent.`);
        } else if (env) {
          await handlePushEnvironmentOnly(env);
        } else if (item) {
          // Collection, pasta ou request: o handlePushCollection decide (pelo
          // ref, porque é declarado mais abaixo).
          await pushCollectionRef.current?.(item);
        } else if (action === 'send' || hint.outgoing || !isPendingEmpty(readPendingPush(workspace))) {
          // "Tudo" sem nada daqui pra enviar (nem pela pendência, nem pelo que
          // a Central mostrou) não faz commit à toa.
          await githubSyncRef.current?.push();
        }
        review = reviewRequestedRef.current;
      }
    } catch (e) {
      reportSyncStatus('error', (e as Error)?.message ?? String(e));
    } finally {
      setSyncCenterBusy(false);
    }
    const messages = capture.stop();
    // Cancelada: o que terminou antes fica nas mensagens; o resto vira um
    // aviso só (e não "falhou").
    if (isSyncCancelRequested()) {
      resetSyncCancel();
      return asCancelled(messages, syncText.scCancelledResult);
    }
    return {
      result: review ? 'review' : messages.some(m => m.type === 'error') ? 'failed' : 'done',
      messages,
      // Parou no conflito do RECEBER: o envio de "tudo" ainda não rodou.
      ...(review && reviewedOnReceive && action === 'all' ? { continueSend: true } : {}),
    };
  }, [handlePullWorkspaceWithReview, handlePushEnvironmentOnly, syncText]);

  // "Cancelar" da Central: para no próximo ponto seguro (ver syncCenterStore).
  const handleSyncCancel = useCallback(() => requestSyncCancel(), []);

  // Restaurar um commit do workspace aberto (janela de histórico): mesma
  // revisão do Pull, com o commit no lugar do GitHub de hoje.
  const handleReviewSnapshot = useCallback((
    workspaceName: string,
    rawCollections: unknown[],
    rawEnvironments: unknown[],
    label: string
  ) => {
    // Token de sessão fica fora da restauração, como fica do pull: o commit
    // tem o token vazio (ou o antigo de alguém), e escolher "GitHub" trocava o
    // token daqui por ele — e era preciso fazer login de novo. Os tokens
    // daqui entram na versão do commit (withLocalOnlyValues), e a diferença é
    // medida sem eles.
    const remoteEnvs = withLocalOnlyValues(
      withoutSessionTokens(importData(rawEnvironments).environments ?? []),
      environments
    );
    const envNodes = diffEnvironments(withoutSessionTokens(environments), withoutSessionTokens(remoteEnvs));
    const { hasChanges } = handleCompareRemote(workspaceName, rawCollections, rawEnvironments);
    // handleCompareRemote marca o escopo pra registrar como sincronizado —
    // um commit antigo não é o GitHub de agora.
    setDiffReviewScope(null);
    if (hasChanges) {
      setDiffSnapshotLabel(label);
      if (envNodes.length > 0) setPendingEnvReview({ nodes: envNodes, remoteEnvs });
      return;
    }
    if (envNodes.length > 0) {
      setDiffSnapshotLabel(label);
      openEnvironmentReview(envNodes, remoteEnvs);
      return;
    }
    toast.success(`"${workspaceName}" already matches that commit.`);
  }, [environments, importData, handleCompareRemote, openEnvironmentReview]);

  // A collection como estava na última sincronização — a terceira coluna da
  // revisão ("o que você mudou" / "o que mudou no GitHub").
  const handleSyncedVersion = useCallback(async (rootId: string): Promise<CollectionItem | null> => {
    const workspaceName = pushWorkspaceAfterDiff ?? selectedWorkspaceRef.current;
    const raw = await githubSyncRef.current?.syncedVersionOf(workspaceName, rootId);
    if (!raw) return null;
    const tree = backfillExampleRequests(importData(Array.isArray(raw) ? raw : [raw]).collections ?? []);
    return tree.find(c => c.id === rootId) ?? (tree.length === 1 ? tree[0] : null);
  }, [importData, pushWorkspaceAfterDiff]);

  // Quem mexeu por último no GitHub, pro detalhe da revisão. O workspace é o
  // do conflito quando a revisão é de OUTRO workspace (menu de workspaces).
  const handleLastRemoteChange = useCallback(
    (rootId: string) =>
      githubSyncRef.current?.lastChangeOf(pushWorkspaceAfterDiff ?? selectedWorkspaceRef.current, rootId) ??
      Promise.resolve(null),
    [pushWorkspaceAfterDiff]
  );

  const handleApplyDiff = useCallback(async (
    selectedIds: Set<string>,
    overrides: OverrideMap,
    decisions: ReviewDecision[] = []
  ) => {
    const workspace = selectedWorkspaceRef.current;
    setDiffConflictsOnly(false);

    // O que foi decidido nos conflitos vai pro histórico (restaurar um
    // commit não é conflito).
    if (!diffSnapshotLabel && decisions.length > 0) {
      const at = new Date().toISOString();
      void recordConflictDecisions(
        decisions.map(d => ({ at, workspace: pushWorkspaceAfterDiff ?? workspace, item: d.item, choice: d.choice, fields: d.fields }))
      );
    }
    // "Desfazer" só faz sentido quando nada é enviado depois: aí o GitHub
    // continua o que era e dá pra voltar o local ao de antes.
    const pushFollows = !!(pushAfterDiff || pushAllAfterDiff || pushEnvAfterDiff || pushWorkspaceAfterDiff || pushItemAfterDiff);
    const primed = undoPrimedRef.current;
    undoPrimedRef.current = null;
    if (!pushFollows && !diffSnapshotLabel) {
      if (!(primed && primed === undoRef.current && primed.workspace === workspace)) await takeUndoSnapshot(workspace);
    } else undoRef.current = null;
    const offerUndo = () => {
      if (!undoRef.current) return;
      reportSyncStatus('success', 'Changes from GitHub applied.', { label: syncText.undo, run: () => void undoLastPull() });
      toast.success('Changes from GitHub applied.', {
        duration: 15000,
        cancel: { label: syncText.undo, onClick: () => void undoLastPull() },
      });
    };

    // O que foi comparado passa a ser a versão sincronizada (o contador
    // "mudou no GitHub" zera pra isso). ANTES de qualquer push abaixo: o push
    // registra a versão que gravou, e registrar a comparada depois a
    // substituiria pela antiga.
    const reviewScope = diffReviewScope;
    setDiffReviewScope(null);
    if (reviewScope) {
      try {
        await githubSyncRef.current?.markReviewed(pushWorkspaceAfterDiff ?? workspace, reviewScope);
      } catch {
        /* só afeta o contador */
      }
    }

    if (diffTarget === 'environments') {
      const merged = applyEnvironmentChanges(environments, diffRemoteEnvs, selectedIds, overrides);
      // Suprime a marcação automática pelo mesmo motivo do de collections: a
      // mescla não é "edição local", boa parte dela acabou de vir de lá.
      // Restaurar um commit é o contrário: o que voltou PRECISA subir.
      if (!diffSnapshotLabel) suppressEnvPendingMarkRef.current = true;
      // O GitHub que acabou de ser visto vira a base dos environments — mesma
      // regra das collections abaixo. Restaurar um commit não conta.
      if (!diffSnapshotLabel) {
        const remoteIds = diffRemoteEnvs.map(e => `${ENV_BASE_PREFIX}${e.id}`);
        void recordSyncBase(workspace, environmentHashes(diffRemoteEnvs), remoteIds);
      }
      setDiffSnapshotLabel(null);
      setEnvironments(merged);
      // A marcação automática foi suprimida acima — então o que ainda difere
      // do GitHub (você escolheu "Mine") é marcado aqui. Sem isto a escolha
      // não aparecia como "↑ para enviar". Sem os tokens de sessão, que não
      // sobem (lib/jwt).
      if (!diffSnapshotLabel) {
        const localIds = new Set(merged.map(e => e.id));
        const differ = [
          ...new Set(diffEnvironments(withoutSessionTokens(merged), withoutSessionTokens(diffRemoteEnvs)).map(n => n.rootId)),
        ].filter(id => localIds.has(id));
        if (differ.length > 0) {
          markEnvironmentsPendingPush(workspace, differ);
          setPendingPush(readPendingPush(workspace));
        }
      }
      setDiffOpen(false);
      offerUndo();

      // Conflito no push de UM environment: reenvia só ele, já reconciliado —
      // reenviar o `env` antigo mandaria de volta a versão que acabou de ser
      // mesclada (ver handleSaveEnvironmentToGitHub).
      const pendingEnv = pushEnvAfterDiff;
      setPushEnvAfterDiff(null);
      if (pendingEnv) {
        const reconciled = merged.find(e => e.id === pendingEnv.id);
        if (reconciled) {
          try {
            await githubSyncRef.current?.pushEnvironment(reconciled);
          } catch {
            /* reportado pelo painel de sync */
          }
        }
      }
      return;
    }

    // Conflito no push de OUTRO workspace (handleWorkspacePushConflict) — a
    // base local do merge é o snapshot que veio com o conflito, nunca
    // `collections`: esse é sempre o workspace SELECIONADO, que pode não ter
    // nada a ver com o que está em conflito. Pela mesma razão, a pendência de
    // push abaixo (toda escopada no workspace selecionado) não se aplica
    // aqui — o reenvio que acontece no fim já cuida disso via onPushCompleted.
    const pendingWorkspace = pushWorkspaceAfterDiff;
    if (pendingWorkspace) {
      const localBase = diffLocalOverride?.collections ?? [];
      const merged = applySelectedChanges(localBase, diffRemoteTree, selectedIds, overrides);
      setPushWorkspaceAfterDiff(null);
      setDiffLocalOverride(null);
      setDiffOpen(false);
      await saveWorkspaceCollections(pendingWorkspace, merged);
      if (pendingWorkspace === workspace) {
        suppressPendingMarkRef.current = true;
        setCollections(merged);
      }
      try {
        await githubSyncRef.current?.pushWorkspace(pendingWorkspace, { reviewed: true });
      } catch {
        /* reportado pelo painel de sync */
      }
      return;
    }

    const merged = structuredClone(applySelectedChanges(collections, diffRemoteTree, selectedIds, overrides));
    // Itens que o colega MOVEU de pasta (e o que editou neles) não aparecem
    // na revisão — o diff não os lista. Sem isto ficavam no lugar antigo,
    // com o conteúdo antigo; a base gravada abaixo diz "pasta nova", e o
    // push seguinte desfazia a mudança dele no GitHub. Mesma regra do merge
    // do push (lib/sync/rebase). Restaurar um commit não move nada.
    if (!diffSnapshotLabel) applyRemoteMoves(merged, collections, diffRemoteTree, diffBase);

    // Suprime a marcação automática: o efeito de `collections` acusaria a
    // mescla inteira como edição local, quando boa parte dela acabou de vir
    // do GitHub e já está igual lá.
    suppressPendingMarkRef.current = true;
    setCollections(merged);
    await saveWorkspaceCollections(workspace, merged);

    // Restaurar um commit: o que voltou é edição local a enviar, e a base
    // fica como estava (ela fala do GitHub de hoje, não daquele commit).
    if (diffSnapshotLabel) {
      const restoredRoots = [...new Set(diffNodes.filter(n => selectedIds.has(n.id)).map(n => n.rootId))];
      if (restoredRoots.length > 0) markCollectionsPendingPush(workspace, restoredRoots);
      setPendingPush(readPendingPush(workspace));
      setDiffOpen(false);
      const envReview = pendingEnvReview;
      setPendingEnvReview(null);
      if (envReview) openEnvironmentReview(envReview.nodes, envReview.remoteEnvs);
      else setDiffSnapshotLabel(null);
      return;
    }

    // E recalcula a pendência comparando o resultado com o remoto. Zerar tudo
    // (o que o pull faz) passaria a mentir depois de uma aplicação parcial:
    // o que foi recusado continua diferente lá, e continua esperando push.
    //
    // `requiresFullPush` é preservado: ele marca uma collection APAGADA
    // localmente, que não tem id pra reaparecer na comparação — recalcular
    // sem ele esqueceria a exclusão, e o arquivo ficaria órfão no remoto.
    //
    // ANTES de qualquer push abaixo: o push grava a pendência e a base do que
    // subiu (handlePushCompleted) antes de terminar, e fazer isto depois
    // remarcava como pendente o que acabara de subir e regravava a base com
    // o GitHub de antes do push — conflitos falsos no sync seguinte.
    //
    // E só do que foi REVISADO (lib/syncBase.reviewedBase): numa revisão de
    // uma collection (ou subpasta), o que colegas mudaram nas outras não foi
    // visto nem aplicado; gravá-lo como sincronizado fazia o push seguinte
    // mandar a versão antiga daqui por cima.
    const scope: 'all' | { rootIds: string[] } | { nodeIds: string[] } =
      reviewScope === 'collections' || reviewScope === 'environments'
        ? 'all'
        : reviewScope
          ? { rootIds: reviewScope.rootIds }
          : { nodeIds: diffNodes.map(n => n.id) };
    const reviewedRoots =
      scope === 'all'
        ? null
        : 'rootIds' in scope
          ? scope.rootIds
          : [...new Set(diffNodes.map(n => n.rootId))];
    const inScope = <T extends { id: string }>(roots: T[]) =>
      reviewedRoots ? roots.filter(r => reviewedRoots.includes(r.id)) : roots;
    const hadRemovals = readPendingPush(workspace).requiresFullPush;
    // Só as collections: a revisão não diz nada sobre os environments, e
    // a pendência deles (edição não enviada) tem que continuar.
    clearCollectionsPendingPush(
      workspace,
      reviewedRoots ?? [...new Set([...collections, ...merged, ...diffRemoteTree].map(c => c.id))]
    );
    const stillDiffer = compareWorkspaces(inScope(merged), inScope(diffRemoteTree));
    const pendingIds = [...stillDiffer.modified, ...stillDiffer.onlyLocal];
    if (pendingIds.length > 0) markCollectionsPendingPush(workspace, pendingIds);
    // O remoto que acabou de ser visto vira o estado comum: é dele que os
    // dois lados passam a divergir. Gravar a MESCLA diria que o que você
    // recusou já está lá.
    const reviewed = reviewedBase(diffRemoteTree, scope);
    await recordSyncBase(workspace, reviewed.hashes, [], reviewed.replaceRoots);
    if (hadRemovals) markFullPushRequired(workspace);
    setPendingPush(readPendingPush(workspace));

    // Conflito no push: o envio recomeça com o resultado da mescla.
    // Reenviar o item ANTIGO mandaria de volta exatamente a versão que
    // acabou de ser reconciliada.
    const pending = pushAfterDiff;
    setPushAfterDiff(null);
    const pendingAll = pushAllAfterDiff;
    setPushAllAfterDiff(false);
    setPushItemAfterDiff(null);
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
    } else if (pushItemAfterDiff) {
      // Envio de UM item: recomeça em cima da mescla que acabou de ser
      // aplicada (o ref já com ela — o render que atualizaria ainda não veio).
      const item = pushItemAfterDiff;
      setDiffOpen(false);
      collectionsRef.current = merged;
      // A promessa fica guardada: quem abriu esta revisão pela Central
      // espera o envio terminar pra mostrar o resultado (ver
      // handleApplyDiffAndReturn).
      deferredPushRef.current = new Promise<void>(resolve => {
        setTimeout(() => {
          void Promise.resolve(pushItemRef.current?.(item)).catch(() => undefined).finally(resolve);
        }, 0);
      });
    } else if (pendingAll) {
      // Mesma ideia do pending acima, só que pro push INTEIRO: a mescla virou
      // o novo estado local (merged), e é ele que precisa subir — reenviar
      // `collections` (ainda a árvore de antes da mescla) mandaria de volta
      // exatamente a versão que acabou de ser reconciliada.
      setDiffOpen(false);
      try {
        await githubSyncRef.current?.push(merged, environments, { reviewed: true });
      } catch {
        /* reportado pelo painel de sync */
      }
    }

    setDiffOpen(false);

    // Pull revisado: as collections acabaram; se os environments também
    // mudaram, a revisão deles abre agora (ver handlePullWorkspaceWithReview).
    const envReview = pendingEnvReview;
    setPendingEnvReview(null);
    if (!envReview) offerUndo();
    if (envReview && !pending && !pendingAll) openEnvironmentReview(envReview.nodes, envReview.remoteEnvs);
    // `diffTarget`, `environments` e `diffRemoteEnvs` entram de verdade: sem
    // eles o callback aplicaria o ramo de environment com dados congelados da
    // primeira renderização — e escreveria valores velhos por cima dos atuais.
  }, [collections, diffRemoteTree, diffTarget, environments, diffRemoteEnvs, setEnvironments, pushAfterDiff, pushAllAfterDiff, pushEnvAfterDiff, pushWorkspaceAfterDiff, pushItemAfterDiff, diffLocalOverride, pendingEnvReview, openEnvironmentReview, diffReviewScope, diffSnapshotLabel, diffNodes, diffBase, takeUndoSnapshot, undoLastPull, syncText]);

  // A revisão aberta por uma ação da Central: aplica e VOLTA pra Central, com
  // o resultado do que veio depois (o envio que a mescla destrava, o
  // "Desfazer"). Antes a Central fechava pra revisão e não voltava — e o
  // resultado desse envio ia pro painel do GitHub, que estava fechado.
  const handleApplyDiffAndReturn = useCallback(async (...args: Parameters<typeof handleApplyDiff>) => {
    const resume = takeResumeAfterReview();
    if (!resume) return handleApplyDiff(...args);
    const capture = captureSyncStatus();
    reviewRequestedRef.current = false;
    let continueSend = resume.continueSend === true;
    try {
      await handleApplyDiff(...args);
      const deferred = deferredPushRef.current;
      deferredPushRef.current = null;
      if (deferred) await deferred;
      // "Sincronizar tudo" que parou no conflito do receber: com a revisão
      // aplicada (e sem outra aberta), o envio que faltava roda agora. Antes
      // a Central voltava e era preciso clicar "Só enviar".
      if (continueSend && !reviewRequestedRef.current) {
        continueSend = false;
        // Um tick: o envio lê a árvore e os environments do último render.
        await new Promise(resolve => setTimeout(resolve, 0));
        const workspace = selectedWorkspaceRef.current;
        if (resume.outgoing || !isPendingEmpty(readPendingPush(workspace))) {
          await githubSyncRef.current?.push();
        }
      }
    } catch (e) {
      reportSyncStatus('error', (e as Error)?.message ?? String(e));
    }
    const messages = [...resume.messages, ...capture.stop()];
    // A aplicação abriu outra revisão (a dos environments, ou um conflito no
    // envio): a Central volta depois dela. Se foi a dos environments, o envio
    // de "tudo" continua esperando; se foi o conflito do envio, a própria
    // revisão reenvia ao ser aplicada.
    if (reviewRequestedRef.current) {
      markResumeAfterReview({ ...resume, messages: withoutActions(messages), continueSend });
      return;
    }
    openSyncCenter({
      tab: resume.tab,
      filter: resume.filter,
      result: { result: messages.some(m => m.type === 'error') ? 'failed' : 'done', messages },
    });
  }, [handleApplyDiff]);

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
      if (!remote) {
        setPushAfterDiff(null);
        setPushItemAfterDiff(null);
        return;
      }
      // Arquivo que não baixou some da árvore remota, e a collection dele
      // apareceria como "apagada no GitHub" — já marcada, e o Apply a
      // apagaria daqui. Mesma regra do pull do workspace inteiro.
      if (remote.failedPaths.length > 0) {
        toast.error('Pull cancelled — nothing was changed here', {
          description: `${remote.failedPaths.length} file(s) could not be read from GitHub. Try again.`,
        });
        reportSyncStatus('error', `Could not read ${remote.failedPaths.length} file(s) from GitHub — nothing was changed or sent. Try again.`);
        // Sem revisão, o envio que esperava por ela não acontece: desmarca
        // (senão a próxima revisão aplicada enviaria este item).
        setPushAfterDiff(null);
        setPushItemAfterDiff(null);
        return;
      }

      // Fechava um ponto cego: pull de UMA collection só comparava a
      // árvore, nunca o catálogo de marcadores (renomear/recolorir um
      // marcador existente nunca chegava aqui antes). Mesma mescla do pull
      // do workspace inteiro — união, nunca substituição (handlePullMarkers).
      // Desfazer: o estado de ANTES dos marcadores (ver undoPrimedRef).
      await takeUndoSnapshot(workspace);
      undoPrimedRef.current = undoRef.current;
      if (remote.markers) await handlePullMarkers(workspace, remote.markers);

      const imported = importData(remote.collections);
      const remoteTree = backfillExampleRequests(imported.collections ?? []);
      // Recorta pela SUBÁRVORE: numa Sprint com cinco User Stories, trazer a
      // atualização de uma sem mexer nas outras é o caso comum. Numa
      // collection raiz o recorte coincide com ela inteira.
      const nodes = filterSubtree(diffTrees(collections, remoteTree), item.id);

      if (nodes.length === 0) {
        // A revisão não abre: o envio que esperava por ela (pushAfterDiff /
        // pushItemAfterDiff) é desmarcado. Sem isto ficava guardado, e a
        // próxima revisão aplicada — de qualquer coisa — enviava este item.
        setPushAfterDiff(null);
        setPushItemAfterDiff(null);
        setDiffConflictsOnly(false);
        toast.success(`"${item.name}" already matches GitHub.`);
        reportSyncStatus('success', `"${item.name}" already matches GitHub.`);
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
      // O arquivo remoto é por collection RAIZ: só uma revisão da raiz
      // inteira cobre o arquivo todo. Numa subpasta, o resto do arquivo não
      // foi visto — não dá pra chamá-lo de sincronizado.
      setDiffReviewScope(collections.some(c => c.id === item.id) ? { rootIds: [item.id] } : null);
      setDiffBase(await loadSyncBase(workspace));
      openReviewDialog();
    } catch (e) {
      toast.error('Could not read GitHub', {
        description: (e as Error)?.message ?? String(e),
      });
      reportSyncStatus('error', `Could not read GitHub: ${(e as Error)?.message ?? String(e)}`);
      setPushAfterDiff(null);
      setPushItemAfterDiff(null);
    } finally {
      pullingCollectionRef.current = false;
    }
  }, [collections, importData, handlePullMarkers, takeUndoSnapshot]);

  // "Push deste item" (subpasta ou request): sobe SÓ esse item. O arquivo
  // no GitHub continua sendo a collection inteira, então o que vai é a
  // versão que está lá com só este item trocado pelo daqui (já mesclado,
  // lib/sync/subtreePush). As outras mudanças suas na mesma collection ficam
  // aqui, pendentes; o que veio do GitHub entra aqui também.
  const handlePushItem = useCallback(async (item: CollectionItem) => {
    const workspace = selectedWorkspaceRef.current;
    // Toda saída sem envio diz por quê — no toast e na Central, quando o
    // envio veio dela. Antes os erros iam só pro toast (a Central dizia que
    // tinha dado certo) e quatro saídas não diziam nada.
    const fail = (title: string, description?: string) => {
      toast.error(title, description ? { description } : undefined);
      reportSyncStatus('error', description ? `${title}: ${description}` : title);
    };
    const gone = () => fail(`"${item.name}" no longer exists here — nothing was sent.`);
    const rootOf = (id: string) =>
      collectionsRef.current.find(c => c.id === id || !!findNodeById(c.item ?? [], id));

    for (let attempt = 0; attempt < 3; attempt++) {
      const localRoot = rootOf(item.id);
      if (!localRoot) {
        gone();
        return;
      }

      let remote;
      try {
        remote = await githubSyncRef.current?.fetchWorkspace(workspace, undefined, `Checking "${item.name}" on GitHub...`);
      } catch (e) {
        fail('Could not read GitHub', (e as Error)?.message ?? String(e));
        return;
      }
      if (!remote) {
        fail('GitHub sync is not set up — nothing was sent.');
        return;
      }
      // Sem um arquivo, a collection pareceria "não estar no GitHub" — e o
      // envio da collection inteira gravaria por cima da versão de lá.
      if (remote.failedPaths.length > 0) {
        fail('Push cancelled', `Could not read ${remote.failedPaths.length} file(s) from GitHub (${remote.failedPaths.map(p => p.split('/').pop()).join(', ')}). Nothing was pushed — try again.`);
        return;
      }

      const remoteTree = backfillExampleRequests(importData(remote.collections).collections ?? []);
      const remoteRoot =
        remoteTree.find(c => c.id === localRoot.id) ?? remoteTree.find(c => c.name === localRoot.name);
      // A collection nem existe lá: não há "versão de lá" pra trocar um item.
      if (!remoteRoot) {
        toast.info(`"${localRoot.name}" isn't on GitHub yet — pushing the whole collection.`);
        reportSyncStatus('info', `"${localRoot.name}" isn't on GitHub yet — the whole collection was sent.`);
        await pushCollectionRef.current?.(localRoot);
        return;
      }

      const base = await loadSyncBase(workspace);
      // Relê depois das esperas: a mescla troca a collection daqui.
      const latestRoot = rootOf(item.id);
      if (!latestRoot) {
        gone();
        return;
      }
      const result = rebaseCollections([latestRoot], [remoteRoot], base, new Set(readPendingPush(workspace).collections));

      // Só conflito DENTRO do item importa: o resto não está sendo enviado.
      if (result.nodes.some(n => isInSubtree(n, item.id) && result.conflicts.includes(n.id))) {
        setDiffConflictsOnly(true);
        setPushItemAfterDiff(item);
        await handlePullCollection(item);
        return;
      }

      const mergedRoot = result.merged.find(c => c.id === latestRoot.id);
      const toSend = mergedRoot ? withSubtreeFrom(remoteRoot, mergedRoot, item.id) : null;
      if (!mergedRoot || !toSend) {
        fail(`Could not prepare "${item.name}" for sending — nothing was sent. Try "Sync all".`);
        return;
      }

      throwIfSyncCancelled();
      // O que veio do GitHub entra aqui também (sem virar pendência).
      if (result.incoming + result.fieldMerged > 0) {
        const next = collectionsRef.current.map(c => (c.id === latestRoot.id ? mergedRoot : c));
        suppressPendingMarkRef.current = true;
        collectionsRef.current = next;
        setCollections(next);
        await saveWorkspaceCollections(workspace, next);
      }

      try {
        await githubSyncRef.current?.pushCollection(toSend, { partOf: item.name });
      } catch (e) {
        if (e instanceof GitHubConflictError) continue;
        return; // o painel de sync já mostrou o motivo
      }

      // O que está no GitHub agora é a base; a collection só deixa de estar
      // pendente se não sobrou nenhuma outra mudança sua nela.
      void recordSyncBase(workspace, nodeHashes([toSend]), [], [toSend.id, localRoot.id]);
      const still = compareWorkspaces([mergedRoot], [toSend]);
      if (still.modified.length === 0 && still.onlyLocal.length === 0) {
        clearCollectionsPendingPush(workspace, [localRoot.id]);
      } else {
        markCollectionsPendingPush(workspace, [localRoot.id]);
      }
      setPendingPush(readPendingPush(workspace));
      return;
    }

    // GitHub mudando sem parar: cai na revisão, e o envio recomeça depois.
    setPushItemAfterDiff(item);
    await handlePullCollection(item);
  }, [handlePullCollection, importData]);

  useEffect(() => {
    pushItemRef.current = handlePushItem;
  }, [handlePushItem]);

  // handlePushItem cai no push da collection inteira quando ela ainda não
  // existe no GitHub — e o handlePushCollection é declarado logo abaixo.
  const pushCollectionRef = useRef<((item: CollectionItem) => Promise<void>) | null>(null);

  // Enviar UMA collection pela árvore. O erro é engolido de propósito: o
  // painel de sync já mostra o motivo (conflito, falta de passphrase, rede),
  // e deixar a exceção subir daqui derrubaria o clique num menu de contexto.
  const handlePushCollection = useCallback(async (item: CollectionItem) => {
    // Subpasta ou request: envio só desse item.
    if (!collectionsRef.current.some(c => c.id === item.id)) {
      await handlePushItem(item);
      return;
    }
    // Mesmo merge automático do push do workspace (lib/sync/rebase), só que
    // pra UMA collection. Antes, qualquer diferença com o GitHub abria a
    // revisão — inclusive a sua própria mudança ainda não enviada, que é
    // justamente o que o push existe pra levar.
    const workspace = selectedWorkspaceRef.current;
    const openReview = async () => {
      setPushAfterDiff(item);
      await handlePullCollection(item);
    };

    // 3 tentativas: se alguém enviar entre a leitura e o commit, o merge é
    // refeito em cima da versão nova.
    for (let attempt = 0; attempt < 3; attempt++) {
      let toSend: CollectionItem = collectionsRef.current.find(c => c.id === item.id) ?? item;
      try {
        const remote = await githubSyncRef.current?.fetchWorkspace(workspace, undefined, `Checking "${item.name}" on GitHub...`);
        if (remote && remote.failedPaths.length > 0) throw new Error(`Could not read ${remote.failedPaths.length} file(s) from GitHub (${remote.failedPaths.map(p => p.split('/').pop()).join(', ')}). Nothing was pushed — try again.`);
        if (remote) {
          const remoteTree = backfillExampleRequests(importData(remote.collections).collections ?? []);
          const remoteRoot =
            remoteTree.find(c => c.id === toSend.id) ?? remoteTree.find(c => c.name === toSend.name);
          const base = await loadSyncBase(workspace);
          const pending = new Set(readPendingPush(workspace).collections);
          // Relê depois das esperas: a mescla troca a collection daqui.
          toSend = collectionsRef.current.find(c => c.id === item.id) ?? toSend;
          const result = rebaseCollections([toSend], remoteRoot ? [remoteRoot] : [], base, pending);
          const mergedRoot = result.merged.find(c => c.id === toSend.id);

          // Conflito de verdade (ou a collection sumiu lá): revisão só dele.
          if (result.conflicts.length > 0 || !mergedRoot) {
            setDiffConflictsOnly(result.conflicts.length > 0);
            await openReview();
            return;
          }
          throwIfSyncCancelled();
          // O que veio do GitHub entra aqui também, sem virar pendência.
          if (result.incoming + result.fieldMerged > 0) {
            const next = collectionsRef.current.map(c => (c.id === toSend.id ? mergedRoot : c));
            suppressPendingMarkRef.current = true;
            collectionsRef.current = next;
            setCollections(next);
            await saveWorkspaceCollections(workspace, next);
            toSend = mergedRoot;
          }
        }
      } catch (e) {
        // Sem ler o GitHub não há merge — enviar mesmo assim gravaria a
        // versão daqui por cima do que não deu pra ler.
        toast.error('Push cancelled', { description: (e as Error)?.message ?? String(e) });
        reportSyncStatus('error', `Push cancelled: ${(e as Error)?.message ?? String(e)}`);
        return;
      }

      try {
        await githubSyncRef.current?.pushCollection(toSend);
        return;
      } catch (e) {
        if (e instanceof GitHubConflictError) continue;
        /* o resto já foi reportado pelo painel de sync */
        return;
      }
    }
    // GitHub mudando sem parar: cai na revisão de sempre.
    await openReview();
  }, [handlePullCollection, importData, handlePushItem]);

  useEffect(() => {
    pushCollectionRef.current = handlePushCollection;
  }, [handlePushCollection]);

  // Limpa a pendência SÓ desta collection. Usar o handlePushCompleted aqui
  // zeraria o workspace inteiro e apagaria o aviso das outras collections que
  // continuam esperando push — e de uma exclusão pendente, que só o push
  // completo resolve.
  const handleCollectionPushed = useCallback((collectionId: string, pushed?: CollectionItem) => {
    if (!collectionId) return;
    const workspace = selectedWorkspaceRef.current;
    // O que SUBIU (não o que está na tela — pode ter mudado durante o envio).
    const sent = pushed ?? collectionsRef.current.find(c => c.id === collectionId);
    const local = collectionsRef.current.find(c => c.id === collectionId);
    const still = sent && local ? compareWorkspaces([local], [sent]) : null;
    if (still && still.modified.length + still.onlyLocal.length > 0) {
      markCollectionsPendingPush(workspace, [collectionId]);
    } else {
      clearCollectionsPendingPush(workspace, [collectionId]);
    }
    setPendingPush(readPendingPush(workspace));

    // Só esta collection entra na base — substituindo a dela: enviar uma não
    // torna as outras sincronizadas, e o que saiu desta não fica pra trás.
    if (sent) void recordSyncBase(workspace, nodeHashes([sent]), [], [collectionId]);
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

  // run_request / run_collection do MCP: o que os scripts gravaram vai pro
  // environment, igual o Send (syncEnvToGlobal) e o Collection Runner. Mesma
  // regra de gravação (patchEnvironmentVariables) e o mesmo aviso no Console
  // quando um script apaga ou esvazia uma variável — só que no environment
  // que a ferramenta usou, que pode não ser o selecionado.
  // update_request / move_item / delete_item do MCP. Por updater, nunca pelo
  // snapshot do contexto: duas chamadas seguidas não se atropelam. A pendência
  // de push vem do efeito de collections, como em qualquer edição.
  const handleMcpUpdateCollectionItem = useCallback(async (id: string, item: CollectionItem) => {
    setCollections(prev => patchNode(prev, id, item));
    // Aba aberta sem edição não salva: passa a mostrar a versão nova (senão o
    // Save seguinte gravaria a antiga por cima). Com edição, fica como está.
    setTabs(prev => prev.map(t => (t.id === id && !t.isDirty ? reloadedTab(t, item, buildTabFromItem) : t)));
  }, []);
  const handleMcpMoveCollectionItem = useCallback(async (id: string, targetFolderId: string | null, position?: number) => {
    setCollections(prev => moveTreeItem(prev, id, targetFolderId, position).tree);
  }, []);
  const handleMcpRemoveCollectionItem = useCallback(async (id: string) => {
    setCollections(prev => removeNode(prev, id));
  }, []);

  const handleMcpApplyEnvironmentChanges = useCallback(
    async (environmentId: string, before: Record<string, string>, after: Record<string, string>, requestName: string) => {
      patchEnvironmentVariables(environmentId, before, after, loss => {
        const acao = loss.kind === 'removed' ? 'deleted' : 'emptied';
        pushLog('warn', `Script ${acao} {{${loss.key}}} (run by Claude via MCP)`, {
          requestName,
          source: 'script',
          detail:
            `Value lost: ${loss.previous}\n` +
            (loss.kind === 'removed'
              ? 'The script called pm.environment.unset() — or returned an env map without this key.'
              : 'The script wrote an empty value over it.'),
        });
      });
    },
    [patchEnvironmentVariables, pushLog]
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
    applyEnvironmentChanges: handleMcpApplyEnvironmentChanges,
    updateCollectionItem: handleMcpUpdateCollectionItem,
    moveCollectionItem: handleMcpMoveCollectionItem,
    removeCollectionItem: handleMcpRemoveCollectionItem,
  }), [collections, environments, activeEnv?.name, tabs, activeTabId, logs, handleMcpSetRequestScript, handleMcpAddCollectionItem, handleMcpRenameCollectionItem, handleMcpSetEnvironmentVariable, handleMcpApplyEnvironmentChanges, handleMcpUpdateCollectionItem, handleMcpMoveCollectionItem, handleMcpRemoveCollectionItem]);

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

  // Porta de entrada do atalho "Perguntar pra IA" no Collection Runner:
  // abre o painel já com o texto pronto, sem mandar sozinho (ver
  // ClaudeChatPanel.draftPrompt). `nonce` garante que clicar de novo,
  // mesmo com o mesmo texto, ainda sobrescreve o que o usuário tiver
  // editado no meio tempo.
  const [claudeDraftPrompt, setClaudeDraftPrompt] = useState<{ text: string; nonce: number } | null>(null);
  const handleAskAiAboutScript = useCallback((prompt: string) => {
    setClaudePanelOpen(true);
    setClaudeDraftPrompt({ text: prompt, nonce: Date.now() });
  }, []);

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

  // Abrindo o app: o carregamento padrão, com o ícone do DevFlow.
  if (!hydrated) {
    return <DevFlowFullScreenLoader label={syncText.loadingApp} detail={syncText.loadingAppSub} />;
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

        {/* Enviar e receber environments: pela Central de Sincronização, já filtrada nele. */}
        <EnvironmentSelector key={envVersion} workspace={selectedWorkspace} onOpenSync={handleOpenSyncForEnvironment} />

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

              <DropdownMenuContent align="start" className="w-80 bg-pm-surface border border-pm-border rounded-lg p-1">
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
                <DevFlowSpinner size={40} />
                <span className="text-[11px] text-pm-text-muted">{syncText.sendingRequest}</span>
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
                onSyncWorkspace={handleSyncWorkspace}
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
              pendingPushSummary={pendingPush}
              onPushCompleted={handlePushCompleted}
              onCollectionPushed={handleCollectionPushed}
              onCompareRemote={handleCompareRemote}
              onPullWithReview={handlePullWorkspaceWithReview}
              onReviewSnapshot={handleReviewSnapshot}
              onWorkspacePushConflict={handleWorkspacePushConflict}
              onRebasePush={handleRebasePush}
              onConflictPreview={handleConflictPreview}
              onShowConflictHistory={() => void handleShowConflictHistory()}
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
              pendingChanges={pendingDetails}
              workspaceKey={selectedWorkspace}
              //update git v2
              setCollections={setCollections}
              activeId={activeTabId || undefined}
              onRequestSelect={handleRequestSelect}
              onOpenAllRequests={handleOpenAllRequests}
              onRenameItem={handleRenameFromTree}
              onRunCollection={(item) => setRunnerItemId(item.id)}
              onLoadTestItem={setLoadTestItem}
              // Receber/enviar: atalhos pra Central filtrada no item. O "Enviar
              // esta pasta/request…" abre na aba "Para enviar", com o botão de
              // enviar só ele — tudo passa pela Central.
              onOpenSync={(item) => handleOpenSyncFor(item)}
              onPushCollection={handleOpenSyncToSend}
              onAddExampleItem={handleRequestSelect}
              folderPickMode={!!flowPickerSession}
              pickerLabel={flowPickerSession ? `Select a folder to create the "${flowPickerSession.name}" flow` : undefined}
              onPickFolder={handlePickFlowFolder}
              onCancelPicker={handleCancelFlowPicker}
              markers={markers}
              onMarkersChange={handleMarkersChange}
              focusRequest={focusRequest}
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
            onAddAllTabsToFlow={handleAddAllTabsToFlow}
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
                        preRequestScriptError={activeRequestState.preRequestScriptError}
                        postResponseScriptError={activeRequestState.postResponseScriptError}
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
          draftPrompt={claudeDraftPrompt}
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

          <McpStatusIndicator
            mcp={mcp}
            onOpen={() => {
              setSettingsSection('mcp');
              setSettingsOpen(true);
            }}
          />

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
  requestedSection={settingsSection}
  onClose={() => {
    setSettingsOpen(false);
    setSettingsSection(undefined);
  }}
  mcp={mcp}
  extensionHost={extensionHost}
  collections={collections}
  onApplySecrets={handleApplySecrets}
  onJumpToItem={handleJumpToItem}
  onReplaceAllFromGitHub={() => githubSyncRef.current?.replaceAllFromGitHub() ?? Promise.resolve()}
/>

{/* Confirmação do "Save to all". Lista ONDE cada cópia está: duas requests
    com o mesmo nome podem ser o mesmo passo duplicado — ou coisas
    diferentes que por acaso se chamam igual, e aí sobrescrever é perda. */}
{saveAllTargets && activeTab && (
  <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm">
    <ModalCard className="w-[460px] max-h-[70vh] flex flex-col" onClose={() => setSaveAllTargets(null)} closeLabel="Cancel">
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
    </ModalCard>
  </div>
)}

<SyncListDialog
  open={!!syncList}
  title={syncList?.title ?? ''}
  subtitle={syncList?.subtitle}
  sections={syncList?.sections ?? []}
  onClose={() => setSyncList(null)}
  actions={
    syncList?.pushNow ? (
      <button
        onClick={() => {
          setSyncList(null);
          void githubSyncRef.current?.push();
        }}
        className="h-7 px-3 rounded-md text-xs font-semibold text-white bg-[#f26b3a] hover:bg-[#f26b3a]/90 transition-colors cursor-pointer"
      >
        {syncText.pushNow}
      </button>
    ) : undefined
  }
/>

{/* Abrindo outro workspace (quando demora): o carregamento padrão, por
    cima do app — o que estava na tela é do workspace anterior. */}
{switchingWorkspace && (
  <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-pm-bg/80 backdrop-blur-[2px] animate-in fade-in duration-150">
    <DevFlowLoader
      label={syncText.switchingWorkspace(switchingWorkspace.split(/[\\/]/).pop() || switchingWorkspace)}
      detail={syncText.switchingWorkspaceSub}
      size={64}
    />
  </div>
)}

{/* Central de Sincronização: abre pelo indicador da barra (store
    lib/sync/syncCenterStore). */}
<SyncCenter
  workspace={selectedWorkspace}
  loadOverview={handleSyncOverview}
  discard={handleSyncDiscard}
  openItem={handleSyncOpenItem}
  lastChangeOf={handleSyncCenterLastChange}
  runAction={runSyncAction}
  cancelAction={handleSyncCancel}
/>

<SyncDiffDialog
  open={diffOpen}
  nodes={diffNodes}
  pendingCollectionIds={pendingCollectionIds}
  base={diffSnapshotLabel ? null : diffBase}
  collectionNames={diffNames}
  markerCatalog={markers}
  mode={diffPushPending ? 'push' : 'pull'}
  restoreCommit={diffSnapshotLabel ?? undefined}
  initialConflictsOnly={diffConflictsOnly}
  extraConflictIds={diffTarget === 'environments' ? diffEnvKeepMine ?? undefined : undefined}
  baseVersionOf={diffTarget === 'collections' && !diffSnapshotLabel ? handleSyncedVersion : undefined}
  whoChangedItem={diffTarget === 'collections' && !diffSnapshotLabel ? handleWhoChangedItem : undefined}
  onShowHistory={() => void handleShowConflictHistory()}
  lastChangeOf={diffSnapshotLabel ? undefined : handleLastRemoteChange}
  onClose={() => {
    // Fechar sem aplicar desiste também do envio que esperava a mescla.
    // Sem isto, o alvo ficaria guardado e uma comparação futura, de outra
    // collection, dispararia um push que ninguém pediu. Vale pros QUATRO
    // tipos de envio pendente — antes só o de uma collection era limpo, e
    // um "Pull" revisado depois de um push cancelado reenviava o workspace.
    setPushAfterDiff(null)
    setPushAllAfterDiff(false)
    setPushEnvAfterDiff(null)
    setPushWorkspaceAfterDiff(null)
    setPushItemAfterDiff(null)
    setDiffLocalOverride(null)
    setPendingEnvReview(null)
    setDiffReviewScope(null)
    setDiffSnapshotLabel(null)
    setDiffConflictsOnly(false)
    setDiffEnvKeepMine(null)
    setDiffOpen(false)
    // Revisão aberta pela Central e fechada sem aplicar: volta pra Central,
    // com o que já tinha sido dito antes dela (o receber que parou no conflito).
    const resume = takeResumeAfterReview()
    if (resume) {
      openSyncCenter({
        tab: resume.tab,
        filter: resume.filter,
        ...(resume.messages.length > 0
          ? { result: { result: resume.messages.some(m => m.type === 'error') ? 'failed' : 'done', messages: resume.messages } }
          : {}),
      })
    }
  }}
  onApply={handleApplyDiffAndReturn}
/>

<CollectionRunnerPanel
  item={runnerItem}
  open={!!runnerItem}
  onClose={() => setRunnerItemId(null)}
  onUpdateRequestScript={(requestId, phase, value) =>
    setCollections(prev => setRequestScript(prev, requestId, phase, value))
  }
  onUpdateRequestUrl={(requestId, url) =>
    setCollections(prev => setRequestUrl(prev, requestId, url))
  }
  onOpenTextInNewWindow={handleOpenTextInNewWindow}
  onAskAiAboutScript={handleAskAiAboutScript}
/>
<LoadTestPanel item={loadTestItem} open={!!loadTestItem} onClose={() => setLoadTestItem(null)} />

      {pendingClose && (
        <div
          className="fixed inset-0 z-[10001] flex items-start justify-center pt-[18vh] pointer-events-none"
        >
          <ModalCard onClose={handlePendingCloseCancel} closeLabel="Cancel" className="pointer-events-auto w-[400px] bg-pm-sidebar shadow-[0_16px_48px_-8px_rgba(0,0,0,0.6)] animate-in fade-in slide-in-from-top-2 duration-150">
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
          </ModalCard>
        </div>
      )}

    </div>
  );
}

