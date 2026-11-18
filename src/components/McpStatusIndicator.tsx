'use client';

import { Plug } from 'lucide-react';
import { UseMcpServerResult } from '@/mcp/useMcpServer';
import { connectedSessions, formatAgo } from '@/mcp/mcpConnections';
import { useNow } from './Settings/McpConnectionsList';

// Indicador do servidor MCP na barra de status: só aparece com o servidor
// ligado. Mostra quantos clientes estão conectados (com atividade recente) e,
// no tooltip, quem são. Clicar abre Settings → Claude Code (MCP).
//
// Componente próprio (e não dentro do AppLayout) porque o relógio que faz os
// "há X s" andarem re-renderiza a cada 5 s — aqui isso custa uma linha.
export function McpStatusIndicator({ mcp, onOpen }: { mcp: UseMcpServerResult; onOpen: () => void }) {
  const now = useNow();
  if (!mcp.enabled) return null;

  const connected = connectedSessions(mcp.connections, now);
  const running = connected.some(s => s.running.length > 0);
  const lastRejection = mcp.connections.rejections[0];
  const recentRejection = lastRejection && now - lastRejection.at < 10 * 60_000;

  const lines = [
    `MCP server on 127.0.0.1:${mcp.port}`,
    ...(connected.length === 0
      ? ['No client connected']
      : connected.map(s => {
          const doing = s.running.length > 0 ? `running ${s.running[0].tool}` : `last call ${formatAgo(now - s.lastSeenAt)}`;
          return `• ${s.clientName}${s.clientVersion ? ` ${s.clientVersion}` : ''} — ${doing}`;
        })),
    ...(recentRejection ? [`Refused a call with a wrong token ${formatAgo(now - lastRejection.at)}`] : []),
  ];

  return (
    <button
      onClick={onOpen}
      title={lines.join('\n')}
      className="h-full px-2 flex items-center gap-1 cursor-pointer transition-colors hover:bg-pm-hover"
    >
      <Plug size={11} className={recentRejection ? 'text-amber-400' : undefined} />
      <span>MCP</span>
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          running ? 'bg-sky-400 animate-pulse' : connected.length > 0 ? 'bg-emerald-400' : 'bg-pm-text-muted/50'
        }`}
      />
      {connected.length > 0 && <span className="tabular-nums">{connected.length}</span>}
    </button>
  );
}
