import { describe, expect, it } from 'vitest';
import {
  EMPTY_CONNECTIONS,
  McpConnectionAction,
  McpConnections,
  canEndSession,
  connectedSessions,
  desiredMcpPort,
  friendlyClientName,
  mcpConnectionsReducer,
  negotiateProtocolVersion,
  parseUserAgent,
  sessionStatus,
} from './mcpConnections';

const run = (actions: McpConnectionAction[], from: McpConnections = EMPTY_CONNECTIONS) =>
  actions.reduce(mcpConnectionsReducer, from);

const T0 = 1_700_000_000_000;

describe('sessões MCP', () => {
  it('initialize abre a sessão com o nome do clientInfo', () => {
    const state = run([
      {
        type: 'request',
        meta: { sessionId: 's1', userAgent: 'node' },
        method: 'initialize',
        clientInfo: { name: 'claude-code', version: '2.1.3' },
        at: T0,
      },
    ]);
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ key: 's1', clientName: 'Claude Code', clientVersion: '2.1.3', calls: 0 });
    expect(sessionStatus(state.sessions[0], T0 + 1000)).toBe('active');
  });

  it('ferramenta em andamento e depois concluída', () => {
    const state = run([
      { type: 'request', meta: { sessionId: 's1' }, method: 'tools/call', at: T0 },
      { type: 'toolStart', key: 's1', callId: 'c1', tool: 'run_collection', at: T0 },
    ]);
    expect(sessionStatus(state.sessions[0], T0 + 10)).toBe('running');
    expect(state.sessions[0].running[0].tool).toBe('run_collection');

    const done = run([{ type: 'toolEnd', key: 's1', callId: 'c1', ok: false, at: T0 + 4000 }], state);
    expect(done.sessions[0].running).toEqual([]);
    expect(done.sessions[0].calls).toBe(1);
    expect(done.sessions[0].lastTool).toEqual({ name: 'run_collection', at: T0 + 4000, ok: false, ms: 4000 });
  });

  it('DELETE fecha a sessão; nova chamada reabre', () => {
    const closed = run([
      { type: 'request', meta: { sessionId: 's1' }, method: 'tools/list', at: T0 },
      { type: 'closed', sessionId: 's1', at: T0 + 10 },
    ]);
    expect(sessionStatus(closed.sessions[0], T0 + 20)).toBe('closed');
    expect(connectedSessions(closed, T0 + 20)).toEqual([]);

    const back = run([{ type: 'request', meta: { sessionId: 's1' }, method: 'tools/list', at: T0 + 30 }], closed);
    expect(sessionStatus(back.sessions[0], T0 + 40)).toBe('active');
  });

  it('Disconnect no painel encerra a sessão e larga o que rodava; sem Mcp-Session-Id não dá', () => {
    const state = run([
      { type: 'request', meta: { sessionId: 's1' }, method: 'tools/call', at: T0 },
      { type: 'toolStart', key: 's1', callId: 'c1', tool: 'run_collection', at: T0 },
      { type: 'request', meta: { userAgent: 'codex' }, method: 'tools/list', at: T0 },
    ]);
    const s1 = state.sessions.find(s => s.key === 's1')!;
    expect(canEndSession(s1)).toBe(true);
    expect(canEndSession(state.sessions.find(s => s.key !== 's1')!)).toBe(false);
    const ended = run([{ type: 'closed', sessionId: 's1', at: T0 + 5, endedHere: true }], state);
    const after = ended.sessions.find(s => s.key === 's1')!;
    expect(after).toMatchObject({ endedHere: true, running: [] });
    expect(sessionStatus(after, T0 + 6)).toBe('closed');
    expect(canEndSession(after)).toBe(false);
  });

  it('sem atividade há 5 min vira ociosa; há 2 h some', () => {
    const state = run([{ type: 'request', meta: { sessionId: 's1' }, method: 'ping', at: T0 }]);
    expect(sessionStatus(state.sessions[0], T0 + 6 * 60_000)).toBe('idle');
    const later = run([{ type: 'request', meta: { sessionId: 's2' }, method: 'ping', at: T0 + 3 * 3_600_000 }], state);
    expect(later.sessions.map(s => s.key)).toEqual(['s2']);
  });

  it('sessão desconhecida (app reiniciou) se identifica pelo User-Agent', () => {
    const state = run([
      { type: 'request', meta: { sessionId: 'velha', userAgent: 'claude-code/2.0.9 (cli)' }, method: 'tools/call', at: T0 },
    ]);
    expect(state.sessions[0]).toMatchObject({ clientName: 'Claude Code', clientVersion: '2.0.9', calls: 1 });
  });

  it('sem Mcp-Session-Id agrupa pelo User-Agent; o painel do DevFlow tem nome próprio', () => {
    const state = run([
      { type: 'request', meta: { userAgent: 'claude-code/2.1.0' }, method: 'tools/list', at: T0 },
      { type: 'request', meta: { userAgent: 'claude-code/2.1.0' }, method: 'tools/list', at: T0 + 1 },
      { type: 'request', meta: { sessionId: 'p1', userAgent: 'claude-code/2.1.0', clientTag: 'panel' }, method: 'initialize', clientInfo: { name: 'claude-code' }, at: T0 + 2 },
    ]);
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions.find(s => s.key === 'p1')?.clientName).toBe('DevFlow panel');
  });

  it('chamadas recusadas guardam as 5 últimas, mais nova primeiro', () => {
    const actions: McpConnectionAction[] = Array.from({ length: 7 }, (_, i) => ({
      type: 'rejected' as const,
      reason: 'wrong' as const,
      userAgent: 'codex',
      at: T0 + i,
    }));
    const state = run(actions);
    expect(state.rejections).toHaveLength(5);
    expect(state.rejections[0].at).toBe(T0 + 6);
  });
});

describe('identificação e protocolo', () => {
  it('nomes de clientes conhecidos', () => {
    expect(friendlyClientName('claude-code')).toBe('Claude Code');
    expect(friendlyClientName('codex-mcp-client')).toBe('Codex');
    expect(friendlyClientName('cursor-vscode')).toBe('Cursor');
    expect(friendlyClientName('meu-cliente')).toBe('meu-cliente');
    expect(friendlyClientName('')).toBe('Unknown client');
    expect(parseUserAgent('claude-code/2.1.3 (external, cli)')).toEqual({ name: 'claude-code', version: '2.1.3' });
  });

  it('devolve a versão pedida quando conhecida; senão a mais nova', () => {
    expect(negotiateProtocolVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateProtocolVersion('2024-11-05')).toBe('2024-11-05');
    expect(negotiateProtocolVersion('2099-01-01')).toBe('2025-11-25');
    expect(negotiateProtocolVersion(undefined)).toBe('2025-11-25');
  });

  it('porta salva na faixa dinâmica do Windows é trocada pela fixa', () => {
    expect(desiredMcpPort('49673')).toBe(37650);
    expect(desiredMcpPort('53467')).toBe(37650);
    expect(desiredMcpPort(null)).toBe(37650);
    // Reserva (37651–37659) é temporária: volta pra 37650.
    expect(desiredMcpPort('37652')).toBe(37650);
    expect(desiredMcpPort('40000')).toBe(40000);
  });
});
