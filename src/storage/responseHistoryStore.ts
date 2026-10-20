// Histórico local das últimas 5 respostas recebidas por request (chave =
// id da request/aba, estável mesmo fechando e reabrindo a aba). Persistido
// em localStorage — sobrevive a reload/restart do app.
//
// Respostas binárias (isBinary) não entram no histórico: o corpo vem em
// base64 e pode ser grande o suficiente pra estourar a cota do
// localStorage rapidinho com só 5 entradas.
//
// Cada entrada também guarda um snapshot do REQUEST que gerou aquela
// resposta (método, URL, body, headers, auth, params) — igual ao Postman,
// que salva o request no histórico independente da resposta. Isso permite
// restaurar não só a resposta, mas o estado do editor de request também,
// ao selecionar uma entrada do histórico.

import { ApiResponse } from '@/app/types/DataResponse';
import {
  entryBytes,
  measurePrefix,
  planEviction,
  safeRemoveItem,
} from '@/lib/safeStorage';
import { AuthorizationDetails } from '@/app/types/AuthorizationDetails';
import { QueryParam } from '@/app/types/QueryParam';

const STORAGE_PREFIX = 'devflow_response_history_';
const MAX_ENTRIES = 5;

// Teto do corpo guardado por entrada. O que está na tela nunca passa por
// aqui — isto é só a cópia que sobrevive ao restart, e uma resposta de
// megabytes no histórico tira o espaço de dezenas de outras.
const MAX_BODY_BYTES = 256 * 1024;

// Orçamento de TODO o histórico de respostas. A cota do localStorage é ~5
// MiB para o app inteiro; sem um teto aqui, 257 chaves chegaram a 2,2 MB e
// quem quebrava era o próximo a escrever — o tamanho dos painéis.
const HISTORY_BUDGET_BYTES = 1.5 * 1024 * 1024;

export interface RequestSnapshot {
  method: string;
  urlInput: string;
  requestBodyValue: string;
  bodyType: 'none' | 'raw' | 'graphql';
  requestHeadersValue: QueryParam[];
  auth: AuthorizationDetails;
  queryParams: QueryParam[];
  params: QueryParam[];
}

export interface ResponseHistoryEntry {
  savedAt: number;
  status: number;
  headers: Record<string, string>;
  parsedBody: any;
  isBinary: boolean;
  responseTime?: number;
  request?: RequestSnapshot;
}

function keyFor(requestId: string): string {
  return `${STORAGE_PREFIX}${requestId}`;
}

/** Marca que ocupa o lugar de um corpo grande demais para o histórico. */
export interface OmittedBody {
  __devflowOmitted: true;
  reason: string;
}

export function isOmittedBody(value: unknown): value is OmittedBody {
  return !!value && typeof value === 'object' && (value as OmittedBody).__devflowOmitted === true;
}

/**
 * Corpo que não cabe no histórico vira uma marca, não um texto cortado.
 *
 * Cortar produziria um JSON inválido que o viewer tentaria interpretar; a
 * marca diz o que aconteceu e não finge ser a resposta.
 */
export function capBody(body: any, maxBytes: number = MAX_BODY_BYTES): any {
  let serialized: string;
  try {
    serialized = JSON.stringify(body) ?? '';
  } catch {
    // Referência circular ou algo que não serializa: nem chegaria ao disco.
    return { __devflowOmitted: true, reason: 'Response could not be stored in history' };
  }

  if (serialized.length * 2 <= maxBytes) return body;
  return {
    __devflowOmitted: true,
    reason: `Response too large for history (${Math.round((serialized.length * 2) / 1024)} KB)`,
  };
}

/**
 * Derruba o histórico das requests menos recentes até caber no orçamento.
 *
 * Chamado depois de cada gravação: é o único momento em que o total pode ter
 * crescido, e varrer na partida apenas deixaria a cota estourar durante o
 * uso — que é exatamente o que acontecia.
 */
export function enforceHistoryBudget(budget: number = HISTORY_BUDGET_BYTES): number {
  const items = measurePrefix(STORAGE_PREFIX).map(item => {
    let touchedAt = 0;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(item.key) ?? '[]');
      if (Array.isArray(parsed) && typeof parsed[0]?.savedAt === 'number') {
        touchedAt = parsed[0].savedAt;
      }
    } catch {
      // Entrada ilegível é a primeira a sair: touchedAt 0.
    }
    return { ...item, touchedAt };
  });

  const doomed = planEviction(items, budget);
  for (const key of doomed) safeRemoveItem(key);
  return doomed.length;
}

// requestHeadersValue mudou de Record<string,string> pra QueryParam[] (ver
// Tab.ts) — entradas de histórico salvas ANTES dessa mudança ainda têm o
// formato antigo. Sem essa normalização, "load from history" numa entrada
// velha injetava um objeto onde o resto do app espera array, quebrando
// buildFinalHeaders/HeadersManager com "forEach is not a function".
function normalizeRequestSnapshot(request: any): RequestSnapshot | undefined {
  if (!request) return undefined;
  if (Array.isArray(request.requestHeadersValue)) return request as RequestSnapshot;

  const record = (request.requestHeadersValue && typeof request.requestHeadersValue === 'object')
    ? request.requestHeadersValue as Record<string, string>
    : {};

  return {
    ...request,
    requestHeadersValue: Object.entries(record).map(([key, value]) => ({
      id: crypto.randomUUID(),
      key,
      value,
      enabled: true,
    })),
  };
}

export function getResponseHistory(requestId: string): ResponseHistoryEntry[] {
  if (typeof window === 'undefined' || !requestId) return [];
  try {
    const raw = window.localStorage.getItem(keyFor(requestId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is ResponseHistoryEntry =>
          e && typeof e.savedAt === 'number' && typeof e.status === 'number'
      )
      .map((e) => ({ ...e, request: normalizeRequestSnapshot(e.request) }));
  } catch {
    return [];
  }
}

export function pushResponseHistory(
  requestId: string,
  response: { status: number; headers: Record<string, string>; parsedBody: any; isBinary: boolean },
  responseTime?: number,
  request?: RequestSnapshot
): void {
  if (typeof window === 'undefined' || !requestId) return;
  if (response.isBinary) return;

  const current = getResponseHistory(requestId);
  const next: ResponseHistoryEntry[] = [
    {
      savedAt: Date.now(),
      status: response.status,
      headers: response.headers ?? {},
      parsedBody: capBody(response.parsedBody),
      isBinary: false,
      responseTime,
      request,
    },
    ...current,
  ].slice(0, MAX_ENTRIES);

  const key = keyFor(requestId);
  const payload = JSON.stringify(next);

  try {
    window.localStorage.setItem(key, payload);
  } catch {
    // Cota estourada: abre espaço e tenta de novo UMA vez. Se ainda não
    // couber, o histórico desta request fica sem a entrada nova — perder
    // histórico é aceitável, atrapalhar quem está trabalhando não é.
    enforceHistoryBudget(HISTORY_BUDGET_BYTES - entryBytes(key, payload));
    try {
      window.localStorage.setItem(key, payload);
    } catch {
      return;
    }
  }

  enforceHistoryBudget();
}

// Limpa o histórico de resposta de TODAS as requests de uma vez (usado pelo
// "Clear all history" das settings) — varre as chaves do localStorage em vez
// de precisar saber os ids das requests de antemão.
export function clearAllResponseHistory(): void {
  if (typeof window === 'undefined') return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // localStorage indisponível — falha silenciosa, não é crítico
  }
}

// Reconstrói um ApiResponse "de mentira" a partir de uma entrada do
// histórico, no formato que o painel de response já sabe renderizar.
export function toApiResponse(entry: ResponseHistoryEntry): ApiResponse {
  const fake = Object.create(ApiResponse.prototype) as ApiResponse;
  fake.status = entry.status;
  fake.headers = entry.headers;
  fake.parsedBody = entry.parsedBody;
  fake.isBinary = false;
  return fake;
}
