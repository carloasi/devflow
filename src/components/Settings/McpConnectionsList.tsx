'use client';

import { useEffect, useState } from 'react';
import {
  McpConnections,
  McpSession,
  formatAgo,
  formatDuration,
  sessionStatus,
  connectedSessions,
  canEndSession,
} from '@/mcp/mcpConnections';

// Lista de quem está usando o servidor MCP: uma linha por sessão (cliente),
// com o que está rodando agora e a última ferramenta. Embaixo, as chamadas
// recusadas por token — o sinal mais comum de "a IA não conecta".

/** Relógio pra os "há X s" andarem sozinhos. */
export function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const DOT: Record<ReturnType<typeof sessionStatus>, string> = {
  running: 'bg-sky-400 animate-pulse',
  active: 'bg-emerald-400',
  idle: 'bg-pm-text-muted/50',
  closed: 'border border-pm-text-muted/60',
};

function statusText(session: McpSession, now: number): string {
  const status = sessionStatus(session, now);
  if (status === 'running') {
    const run = session.running[0];
    const more = session.running.length > 1 ? ` (+${session.running.length - 1})` : '';
    return `running ${run.tool}${more} · ${formatDuration(now - run.since)}`;
  }
  if (status === 'closed') {
    return `${session.endedHere ? 'ended here' : 'disconnected'} · ${formatAgo(now - (session.closedAt ?? now))}`;
  }
  if (status === 'active') return `connected · last call ${formatAgo(now - session.lastSeenAt)}`;
  return `idle · last call ${formatAgo(now - session.lastSeenAt)}`;
}

function SessionRow({ session, now, onEnd }: { session: McpSession; now: number; onEnd?: (sessionId: string) => void }) {
  const status = sessionStatus(session, now);
  const last = session.lastTool;
  return (
    <li className="flex items-start gap-2 py-1.5">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[status]}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className={`text-xs font-medium ${status === 'closed' ? 'text-pm-text-muted' : 'text-pm-text'}`}>
            {session.clientName}
          </span>
          {session.clientVersion && (
            <span className="text-[10px] text-pm-text-muted font-mono">{session.clientVersion}</span>
          )}
          <span className="text-[11px] text-pm-text-muted truncate">· {statusText(session, now)}</span>
        </div>
        <div className="text-[10.5px] text-pm-text-muted/80">
          {session.calls} tool call{session.calls === 1 ? '' : 's'} · since {formatAgo(now - session.startedAt)}
          {last && (
            <>
              {' '}· last: <span className="font-mono">{last.name}</span>{' '}
              <span className={last.ok ? 'text-emerald-400/90' : 'text-rose-400/90'}>{last.ok ? '✓' : '✗'}</span>{' '}
              {formatDuration(last.ms)}
            </>
          )}
        </div>
      </div>
      {onEnd && canEndSession(session) && (
        <button
          type="button"
          onClick={() => onEnd(session.key)}
          title={
            session.running.length > 0
              ? 'End this session. The tool already running finishes in DevFlow, but its result no longer reaches the client.'
              : 'End this session: its next call is refused and the client has to reconnect (in Claude Code: /mcp → devflow → Reconnect).'
          }
          className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-pm-text-muted transition-colors hover:bg-rose-500/15 hover:text-rose-300 cursor-pointer"
        >
          Disconnect
        </button>
      )}
    </li>
  );
}

export function McpConnectionsList({
  connections,
  onEndSession,
}: {
  connections: McpConnections;
  onEndSession?: (sessionId: string) => void;
}) {
  const now = useNow();
  const connected = connectedSessions(connections, now);
  const lastRejection = connections.rejections[0];

  return (
    <div className="rounded-md border border-pm-border px-3 py-2">
      <p className="text-[11px] font-semibold text-pm-text-secondary">
        Connections{' '}
        <span className="font-normal text-pm-text-muted">
          · {connected.length === 0 ? 'none active' : `${connected.length} active`}
        </span>
      </p>

      {connections.sessions.length === 0 ? (
        <p className="mt-1 text-[11px] text-pm-text-muted max-w-[60ch]">
          No client has called the server since it started. After adding it, start a new Claude Code
          session — the server shows up under <span className="font-mono">/mcp</span> and here, on its
          first call.
        </p>
      ) : (
        <ul className="mt-0.5 divide-y divide-pm-border/50">
          {connections.sessions.map(session => (
            <SessionRow key={session.key} session={session} now={now} onEnd={onEndSession} />
          ))}
        </ul>
      )}

      {lastRejection && (
        <p className="mt-2 text-[11px] text-amber-400/90 max-w-[60ch]">
          Refused {connections.rejections.length === 5 ? '5+' : connections.rejections.length} call
          {connections.rejections.length === 1 ? '' : 's'} with a{' '}
          {lastRejection.reason === 'missing' ? 'missing' : 'wrong'} token — last {formatAgo(now - lastRejection.at)}
          {lastRejection.userAgent && (
            <>
              {' '}(<span className="font-mono">{lastRejection.userAgent}</span>)
            </>
          )}
          . That client still has an old token: remove and add the server again with the commands above.
        </p>
      )}
    </div>
  );
}
