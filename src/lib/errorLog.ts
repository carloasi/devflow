// ─────────────────────────────────────────────────────────────────────────────
// Log de erros do app + envio pra análise.
//
// Captura (automático, ver installErrorCapture):
//   - window "error" (erro JS não tratado)
//   - window "unhandledrejection" (Promise rejeitada sem catch)
//   - console.error (qualquer lugar do app que já loga erro)
//   - crash de render do React (app/error.tsx e app/global-error.tsx chamam
//     logError com source "react")
//
// Tudo fica num buffer local (localStorage, últimas MAX_ENTRIES entradas) —
// sobrevive a reload/crash, então o usuário consegue mandar o log DEPOIS.
//
// Envio: pro mesmo Web App do Apps Script do APP_STATUS_URL (ver
// google-apps-script/Code.gs), que grava uma linha por erro na aba "Errors"
// da planilha.
//   - Erros não tratados / crashes de render -> enviados automaticamente
//     (com dedupe e limite por sessão, pra um erro em loop não inundar a
//     planilha).
//   - console.error -> só vai junto quando o usuário clica em "Report a
//     problem" nas Settings (é barulhento demais pra mandar sozinho).
//
// Vai via GET com query string, um request por entrada — mesmo motivo do
// reportUsage em appStatus.ts: o Apps Script responde com 302 e o reqwest
// descarta o body de um POST ao seguir o redirect. Por isso os campos são
// truncados (URL não pode ficar gigante).
// ─────────────────────────────────────────────────────────────────────────────

import { APP_STATUS_URL } from './appStatus';

export type ErrorSource = 'window' | 'promise' | 'console' | 'react' | 'manual';

export interface ErrorLogEntry {
  id: string;
  time: string;
  source: ErrorSource;
  message: string;
  stack?: string;
}

const STORAGE_KEY = 'devflow_error_log';
const MAX_ENTRIES = 100;
const MAX_MESSAGE = 500;
const MAX_STACK = 1500;
const MAX_DESCRIPTION = 1000;
const MAX_AUTO_REPORTS_PER_SESSION = 10;
const SEND_TIMEOUT_MS = 8000;

// Quantas entradas recentes vão junto num report manual.
export const MANUAL_REPORT_ENTRIES = 30;

// ── Redação de dados sensíveis ──────────────────────────────────────────────
// Mensagens de erro de request podem carregar header/URL com token. Antes de
// salvar (e portanto antes de enviar) mascara os padrões mais comuns.
function redact(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1***')
    .replace(/(basic\s+)[A-Za-z0-9+/]+=*/gi, '$1***')
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, '***jwt***')
    .replace(
      /((?:access_?token|refresh_?token|id_?token|token|password|passwd|pwd|secret|api_?key|client_?secret|authorization)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
      '$1***'
    );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max}]` : text;
}

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

// ── Buffer local ────────────────────────────────────────────────────────────
export function getErrorLog(): ErrorLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveErrorLog(entries: ErrorLogEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // localStorage cheio/indisponível — só perde o log, nunca quebra o app.
  }
}

export function clearErrorLog() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

const listeners = new Set<() => void>();
export function subscribeErrorLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function logError(
  source: ErrorSource,
  errorOrMessage: unknown,
  options: { autoReport?: boolean } = {}
): ErrorLogEntry {
  const err = errorOrMessage instanceof Error ? errorOrMessage : undefined;
  const message = err ? `${err.name}: ${err.message}` : stringifyArg(errorOrMessage);

  const entry: ErrorLogEntry = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    source,
    message: truncate(redact(message), MAX_MESSAGE),
    stack: err?.stack ? truncate(redact(err.stack), MAX_STACK) : undefined,
  };

  saveErrorLog([...getErrorLog(), entry]);
  listeners.forEach((fn) => fn());

  if (options.autoReport) void autoReport(entry);

  return entry;
}

// ── Contexto (usuário do Windows + versão) ──────────────────────────────────
let contextPromise: Promise<{ username: string; version: string }> | null = null;

function getReportContext() {
  if (!contextPromise) {
    contextPromise = (async () => {
      let username = '';
      let version = '';
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        version = await getVersion();
      } catch {}
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        username = await invoke<string>('get_windows_username');
      } catch {}
      return { username, version };
    })();
  }
  return contextPromise;
}

// ── Envio ───────────────────────────────────────────────────────────────────
type ReportKind = 'auto' | 'manual';

// Resultado de um envio:
//   'ok'           -> a planilha respondeu {"ok":true} (linha gravada)
//   'not-recorded' -> o Web App respondeu, mas não gravou: é o que acontece
//                     quando o deployment publicado é anterior ao recordError
//                     do Code.gs — ele ignora ?errorlog=1 e devolve o JSON de
//                     status com HTTP 200. Antes isso contava como sucesso.
//   'failed'       -> rede, timeout ou HTTP de erro
export type SendOutcome = 'ok' | 'not-recorded' | 'failed';

async function sendEntry(
  entry: Pick<ErrorLogEntry, 'time' | 'source' | 'message' | 'stack'>,
  reportId: string,
  kind: ReportKind,
  description: string
): Promise<SendOutcome> {
  if (!APP_STATUS_URL.trim()) return 'failed';

  const { username, version } = await getReportContext();

  const params = new URLSearchParams({
    errorlog: '1',
    reportId,
    kind,
    username,
    version,
    description: truncate(redact(description), MAX_DESCRIPTION),
    occurredAt: entry.time,
    source: entry.source,
    message: entry.message,
    stack: entry.stack || '',
  });

  const separator = APP_STATUS_URL.includes('?') ? '&' : '?';
  const url = `${APP_STATUS_URL}${separator}${params.toString()}`;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), SEND_TIMEOUT_MS)
    );
    const result = await Promise.race([
      invoke<{ status: number; body: string }>('make_http_request', {
        method: 'GET',
        url,
        body: null,
        headersInput: null,
      }),
      timeoutPromise,
    ]);
    if (!result || result.status >= 400) return 'failed';

    // HTTP 200 não basta: só conta se a planilha confirmou que gravou.
    try {
      const parsed = JSON.parse(result.body);
      return parsed?.ok === true ? 'ok' : 'not-recorded';
    } catch {
      return 'not-recorded';
    }
  } catch {
    return 'failed';
  }
}

const autoReportedKeys = new Set<string>();

async function autoReport(entry: ErrorLogEntry) {
  // Mesmo erro repetido (ex: um render quebrando em loop) só vai uma vez por
  // sessão, e no máximo N erros distintos por sessão.
  const key = `${entry.source}|${entry.message}|${(entry.stack || '').split('\n')[1] || ''}`;
  if (autoReportedKeys.has(key)) return;
  if (autoReportedKeys.size >= MAX_AUTO_REPORTS_PER_SESSION) return;
  autoReportedKeys.add(key);

  await sendEntry(entry, crypto.randomUUID(), 'auto', '');
}

export interface ErrorReportResult {
  // Presente quando pelo menos uma linha foi gravada.
  reportId: string | null;
  sent: number;
  total: number;
  // Por que nada foi gravado (quando reportId é null).
  failure?: 'not-recorded' | 'failed';
}

/**
 * Report manual ("Report a problem" nas Settings / tela de crash): manda a
 * descrição do usuário + as últimas MANUAL_REPORT_ENTRIES entradas do log,
 * todas com o mesmo reportId pra dar pra agrupar na planilha.
 */
export async function sendErrorReport(description: string): Promise<ErrorReportResult> {
  const reportId = crypto.randomUUID().slice(0, 8);
  const entries = getErrorLog().slice(-MANUAL_REPORT_ENTRIES);

  // Sem nenhum erro no log, ainda manda uma linha só com a descrição.
  const toSend = entries.length > 0
    ? entries
    : [{ time: new Date().toISOString(), source: 'manual' as const, message: '(no errors in log)' }];

  let sent = 0;
  let notRecorded = 0;
  // Sequencial (não Promise.all) pra não abrir dezenas de requests de uma vez
  // contra o Apps Script, que tem limite de execuções simultâneas.
  for (const entry of toSend) {
    const outcome = await sendEntry(entry, reportId, 'manual', description);
    if (outcome === 'ok') sent++;
    else if (outcome === 'not-recorded') {
      notRecorded++;
      // Se a primeira já não gravou, o deployment não tem o recordError:
      // as outras também não vão gravar, não adianta mandar 30 requests.
      if (sent === 0) break;
    }
  }

  if (sent > 0) return { reportId, sent, total: toSend.length };
  return { reportId: null, sent: 0, total: toSend.length, failure: notRecorded > 0 ? 'not-recorded' : 'failed' };
}

// ── Captura global ──────────────────────────────────────────────────────────
let installed = false;

export function installErrorCapture() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    logError('window', event.error ?? event.message, { autoReport: true });
  });

  window.addEventListener('unhandledrejection', (event) => {
    logError('promise', event.reason ?? 'Unhandled promise rejection', { autoReport: true });
  });

  const originalConsoleError = console.error.bind(console);
  let inConsoleError = false;
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    // Guarda contra recursão (algo dentro de logError chamando console.error).
    if (inConsoleError) return;
    inConsoleError = true;
    try {
      const firstError = args.find((a) => a instanceof Error) as Error | undefined;
      if (firstError) {
        const text = args.filter((a) => a !== firstError).map(stringifyArg).join(' ');
        const wrapped = new Error(text ? `${text} ${firstError.message}` : firstError.message);
        wrapped.name = firstError.name;
        wrapped.stack = firstError.stack;
        logError('console', wrapped);
      } else {
        logError('console', args.map(stringifyArg).join(' '));
      }
    } finally {
      inConsoleError = false;
    }
  };
}
