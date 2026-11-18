// ─────────────────────────────────────────────────────────────────────────
// Quem está usando o servidor MCP.
//
// O MCP por HTTP não mantém conexão aberta: cada chamada é uma requisição.
// "Conectado" aqui é uma SESSÃO — aberta no `initialize` (o Rust entrega um
// Mcp-Session-Id que o cliente devolve em toda chamada) e fechada no DELETE
// que o cliente manda ao sair. Quem é vem do `clientInfo` do initialize
// (claude-code, codex, cursor…) ou, sem ele, do User-Agent.
//
// Funções puras (reducer) pra dar pra testar sem Tauri.
// ─────────────────────────────────────────────────────────────────────────

export interface McpToolRun {
  callId: string;
  tool: string;
  since: number;
}

export interface McpSession {
  /** Mcp-Session-Id; sem ele, uma chave derivada do User-Agent. */
  key: string;
  clientName: string;
  clientVersion?: string;
  userAgent?: string;
  startedAt: number;
  lastSeenAt: number;
  calls: number;
  running: McpToolRun[];
  lastTool?: { name: string; at: number; ok: boolean; ms: number };
  closedAt?: number;
  /** Encerrada pelo botão Disconnect do painel (não pelo cliente). */
  endedHere?: boolean;
}

export interface McpRejection {
  at: number;
  reason: 'missing' | 'wrong';
  userAgent?: string;
}

export interface McpConnections {
  sessions: McpSession[];
  rejections: McpRejection[];
}

export const EMPTY_CONNECTIONS: McpConnections = { sessions: [], rejections: [] };

export interface McpRequestMeta {
  sessionId?: string | null;
  userAgent?: string | null;
  clientTag?: string | null;
}

export type McpConnectionAction =
  | {
      type: 'request';
      meta: McpRequestMeta;
      method?: string;
      clientInfo?: { name?: unknown; version?: unknown };
      at: number;
    }
  | { type: 'toolStart'; key: string; callId: string; tool: string; at: number }
  | { type: 'toolEnd'; key: string; callId: string; ok: boolean; at: number }
  | { type: 'closed'; sessionId: string; at: number; endedHere?: boolean }
  | { type: 'rejected'; reason: 'missing' | 'wrong'; userAgent?: string | null; at: number }
  | { type: 'reset' };

/** Sessão sem atividade há mais que isso some da lista. */
const FORGET_IDLE_MS = 2 * 60 * 60 * 1000;
/** Sessão encerrada fica visível um tempo, pra dar pra ver que saiu. */
const FORGET_CLOSED_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 20;
const MAX_REJECTIONS = 5;
/** Atividade mais recente que isso conta como "ativa". */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

const KNOWN_CLIENTS: Array<[RegExp, string]> = [
  [/claude[-_ ]?code|claude-cli/i, 'Claude Code'],
  [/codex/i, 'Codex'],
  [/cursor/i, 'Cursor'],
  [/windsurf|codeium/i, 'Windsurf'],
  [/visual studio code|vscode|copilot/i, 'VS Code'],
  [/gemini/i, 'Gemini CLI'],
  [/claude/i, 'Claude'],
];

/** Nome legível do cliente: "claude-code" → "Claude Code". */
export function friendlyClientName(raw: string | undefined | null): string {
  const name = (raw ?? '').trim();
  if (!name) return 'Unknown client';
  for (const [pattern, label] of KNOWN_CLIENTS) {
    if (pattern.test(name)) return label;
  }
  return name;
}

/** "claude-code/2.1.3 (external, cli)" → { name: "claude-code", version: "2.1.3" }. */
export function parseUserAgent(ua: string | undefined | null): { name?: string; version?: string } {
  const first = (ua ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first) return {};
  const [name, version] = first.split('/');
  return { name: name || undefined, version: version || undefined };
}

/** Chave da sessão de uma chamada. Sem Mcp-Session-Id (cliente que se
 *  conectou antes de o servidor entregar sessões), agrupa pelo User-Agent. */
export function sessionKey(meta: McpRequestMeta): string {
  if (meta.sessionId) return meta.sessionId;
  return `ua:${meta.userAgent ?? 'unknown'}|${meta.clientTag ?? ''}`;
}

function identify(meta: McpRequestMeta, clientInfo?: { name?: unknown; version?: unknown }) {
  if (meta.clientTag === 'panel') {
    return { clientName: 'DevFlow panel', clientVersion: undefined as string | undefined };
  }
  const infoName = typeof clientInfo?.name === 'string' ? clientInfo.name : undefined;
  const infoVersion = typeof clientInfo?.version === 'string' ? clientInfo.version : undefined;
  const ua = parseUserAgent(meta.userAgent);
  return {
    clientName: friendlyClientName(infoName ?? ua.name),
    clientVersion: infoVersion ?? ua.version,
  };
}

function prune(sessions: McpSession[], now: number): McpSession[] {
  return sessions
    .filter(s =>
      s.running.length > 0 ||
      (s.closedAt !== undefined ? now - s.closedAt < FORGET_CLOSED_MS : now - s.lastSeenAt < FORGET_IDLE_MS)
    )
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_SESSIONS);
}

function updateSession(state: McpConnections, key: string, fn: (s: McpSession) => McpSession): McpConnections {
  if (!state.sessions.some(s => s.key === key)) return state;
  return { ...state, sessions: state.sessions.map(s => (s.key === key ? fn(s) : s)) };
}

export function mcpConnectionsReducer(state: McpConnections, action: McpConnectionAction): McpConnections {
  switch (action.type) {
    case 'reset':
      return EMPTY_CONNECTIONS;

    case 'request': {
      const key = sessionKey(action.meta);
      const existing = state.sessions.find(s => s.key === key);
      const isInit = action.method === 'initialize';
      const isCall = action.method === 'tools/call';
      // O painel do DevFlow sobe um CLI novo a cada prompt (initialize novo,
      // sem DELETE no fim): sem isto, 4 prompts em 5 min viravam "MCP 4".
      const others =
        isInit && action.meta.clientTag === 'panel'
          ? state.sessions.map(s =>
              s.key !== key && s.clientName === 'DevFlow panel' && s.closedAt === undefined && s.running.length === 0
                ? { ...s, closedAt: action.at }
                : s
            )
          : state.sessions;
      if (!existing) {
        const id = identify(action.meta, action.clientInfo);
        const created: McpSession = {
          key,
          ...id,
          userAgent: action.meta.userAgent ?? undefined,
          startedAt: action.at,
          lastSeenAt: action.at,
          calls: isCall ? 1 : 0,
          running: [],
        };
        return { ...state, sessions: prune([created, ...others], action.at) };
      }
      const refreshed: McpSession = {
        ...existing,
        // O initialize traz o clientInfo, que é melhor que o User-Agent.
        ...(isInit && action.clientInfo ? identify(action.meta, action.clientInfo) : {}),
        lastSeenAt: action.at,
        calls: existing.calls + (isCall ? 1 : 0),
        // Voltou a falar depois do DELETE: reabriu.
        closedAt: undefined,
        endedHere: undefined,
      };
      return {
        ...state,
        sessions: prune(state.sessions.map(s => (s.key === key ? refreshed : s)), action.at),
      };
    }

    case 'toolStart':
      return updateSession(state, action.key, s => ({
        ...s,
        running: [...s.running, { callId: action.callId, tool: action.tool, since: action.at }],
      }));

    case 'toolEnd':
      return updateSession(state, action.key, s => {
        const run = s.running.find(r => r.callId === action.callId);
        if (!run) return s;
        return {
          ...s,
          lastSeenAt: action.at,
          running: s.running.filter(r => r.callId !== action.callId),
          lastTool: { name: run.tool, at: action.at, ok: action.ok, ms: action.at - run.since },
        };
      });

    case 'closed':
      return updateSession(state, action.sessionId, s => ({
        ...s,
        closedAt: action.at,
        ...(action.endedHere ? { endedHere: true } : {}),
        // O que estava rodando não volta mais pro cliente.
        running: action.endedHere ? [] : s.running,
      }));

    case 'rejected':
      return {
        ...state,
        rejections: [
          { at: action.at, reason: action.reason, userAgent: action.userAgent ?? undefined },
          ...state.rejections,
        ].slice(0, MAX_REJECTIONS),
      };
  }
}

/** Só sessão com Mcp-Session-Id dá pra encerrar (a chave "ua:" agrupa por User-Agent). */
export function canEndSession(session: McpSession): boolean {
  return !session.key.startsWith('ua:') && session.closedAt === undefined;
}

export type McpSessionStatus = 'running' | 'active' | 'idle' | 'closed';

export function sessionStatus(session: McpSession, now: number): McpSessionStatus {
  if (session.running.length > 0) return 'running';
  if (session.closedAt !== undefined) return 'closed';
  return now - session.lastSeenAt < ACTIVE_WINDOW_MS ? 'active' : 'idle';
}

/** Sessões que contam como "conectadas" (rodando ou com atividade recente). */
export function connectedSessions(state: McpConnections, now: number): McpSession[] {
  return state.sessions.filter(s => {
    const status = sessionStatus(s, now);
    return status === 'running' || status === 'active';
  });
}

/** "agora", "há 40 s", "há 3 min", "há 2 h". */
export function formatAgo(ms: number): string {
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  return `${Math.round(ms / 3_600_000)} h ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Versão do protocolo: a do cliente, se a conhecemos; senão a mais nova daqui. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];
}

/** Porta padrão do servidor, fora da faixa dinâmica do Windows (ver STABLE_PORTS no Rust). */
export const DEFAULT_MCP_PORT = 37650;

/** Porta salva que ainda vale a pena pedir: fora da faixa dinâmica (49152+),
 *  onde o SO sorteia efêmeras e o Hyper-V reserva blocos a cada boot. */
export function desiredMcpPort(saved: string | null): number {
  const port = Number(saved ?? 0);
  // As reservas 37651–37659 são temporárias: o endereço estável é sempre o
  // 37650, e o app volta pra ele assim que puder (com o aviso de porta mudada).
  const isFallback = port > DEFAULT_MCP_PORT && port <= DEFAULT_MCP_PORT + 9;
  return Number.isInteger(port) && port > 1024 && port < 49152 && !isFallback ? port : DEFAULT_MCP_PORT;
}
