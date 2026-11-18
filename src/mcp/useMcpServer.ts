'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MCP_TOOLS, McpContext, executeMcpTool } from './mcpTools';
import { getSecret, saveSecret } from '@/lib/secureStorage';
import { safeSetItem } from '@/lib/safeStorage';
import {
  EMPTY_CONNECTIONS,
  McpConnections,
  McpRequestMeta,
  desiredMcpPort,
  mcpConnectionsReducer,
  negotiateProtocolVersion,
  sessionKey,
} from './mcpConnections';
import { createWriteQueue, TREE_WRITE_TOOLS } from './writeQueue';

// ─────────────────────────────────────────────────────────────────────────
// Camada JSON-RPC do servidor MCP. O Rust (mcp_server.rs) só transporta:
// cada requisição HTTP chega aqui por evento, é interpretada como JSON-RPC
// e a resposta volta pelo comando `mcp_respond`.
//
// Protocolo implementado: initialize, tools/list, tools/call, ping — o
// suficiente pro Claude Code. Notificações (sem `id`) não têm resposta (o
// Rust já devolve 202 sem passar por aqui).
// ─────────────────────────────────────────────────────────────────────────

const ENABLED_KEY = 'devflow_mcp_enabled';
const PORT_KEY = 'devflow_mcp_port';
const TOKEN_KEY = 'devflow_mcp_token';
// Bem abaixo dos 120 s de inatividade que o Rust tolera.
const MCP_HEARTBEAT_MS = 30_000;

interface McpRequestEvent extends McpRequestMeta {
  id: number;
  payload: string;
}

interface McpActivityEvent {
  kind: 'closed' | 'rejected';
  sessionId?: string | null;
  userAgent?: string | null;
  reason?: 'missing' | 'wrong' | null;
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// O token vive no armazenamento seguro do Rust (mesmo do token do GitHub), e
// não em localStorage: ele autoriza disparar qualquer request salva com os
// seus environments de verdade, então vale pelo menos o mesmo cuidado. Em
// localStorage ele ficava legível por qualquer script da webview e em claro
// no perfil dela.
//
// A migração preserva o token que já existe em vez de sortear um novo: trocar
// o valor aqui quebraria silenciosamente o cliente MCP que o usuário já
// configurou, e o sintoma seria só um 401 sem explicação.
async function loadToken(): Promise<string> {
  try {
    const stored = await getSecret(TOKEN_KEY);
    if (stored) return stored;

    const legacy = (() => {
      try {
        return localStorage.getItem(TOKEN_KEY);
      } catch {
        return null;
      }
    })();

    const token = legacy || generateToken();
    await saveSecret(TOKEN_KEY, token);

    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // Se não deu pra limpar, o secure store já é a fonte da verdade.
    }

    return token;
  } catch (e) {
    // Sem o armazenamento seguro não dá pra garantir um token estável entre
    // sessões, e gerar um volátil faria o servidor subir com credencial que
    // o cliente não conhece. Melhor falhar e deixar o enable() mostrar o erro.
    throw new Error(
      `Could not read the MCP token from secure storage: ${(e as Error)?.message ?? String(e)}`
    );
  }
}

export interface UseMcpServerResult {
  enabled: boolean;
  port: number | null;
  token: string;
  error: string | null;
  /** A porta salva não pôde ser usada e o SO escolheu outra; o cliente MCP
   *  já configurado aponta pra URL antiga e precisa ser refeito. */
  portChanged: boolean;
  starting: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  regenerateToken: () => Promise<void>;
  /** Derruba uma sessão de cliente (próximas chamadas dela recebem 404). */
  endSession: (sessionId: string) => Promise<void>;
  /** Para e sobe o servidor de novo, na mesma porta e com o mesmo token. */
  restart: () => Promise<void>;
  /** Sessões de clientes MCP e chamadas recusadas por token. */
  connections: McpConnections;
}

export function useMcpServer(getContext: () => McpContext): UseMcpServerResult {
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [portChanged, setPortChanged] = useState(false);
  const [starting, setStarting] = useState(false);
  const [connections, dispatchConnection] = useReducer(mcpConnectionsReducer, EMPTY_CONNECTIONS);
  // Resolve quando o listener do mcp-request está registrado. O enable espera
  // por ele: antes o servidor já aceitava conexões enquanto o listener ainda
  // não existia, e um pedido nessa janela ficava 120 s pendurado.
  const listenerReadyRef = useRef<Promise<unknown>>(Promise.resolve());
  const enableInFlightRef = useRef<Promise<void> | null>(null);

  // O contexto (collections/environments/workspace) muda o tempo todo; ler
  // por ref evita re-registrar o listener a cada render e garante que cada
  // chamada enxergue o estado atual.
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;
  // Escritas na árvore uma de cada vez, cada uma esperando o React aplicar a
  // anterior (ver writeQueue): sem isto, duas edições na mesma request se
  // sobrescreviam.
  const writeQueueRef = useRef<ReturnType<typeof createWriteQueue> | null>(null);
  if (!writeQueueRef.current) writeQueueRef.current = createWriteQueue(() => getContextRef.current().collections);

  useEffect(() => {
    loadToken()
      .then(setToken)
      .catch(e => setError(e?.message ?? String(e)));
  }, []);

  const handleRpc = useCallback(async (message: any): Promise<any | null> => {
    const { method, id, params } = message ?? {};

    // Notificação: o protocolo manda não responder.
    if (id === undefined || id === null) return null;

    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, msg: string) => ({
      jsonrpc: '2.0',
      id,
      error: { code, message: msg },
    });

    switch (method) {
      case 'initialize':
        return ok({
          // Devolve a versão que o cliente pediu quando a conhecemos; fixa em
          // 2024-11-05, clientes que já não aceitam a antiga recusavam.
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: 'devflow', version: '1.0.0' },
        });

      case 'ping':
        return ok({});

      case 'tools/list':
        return ok({ tools: MCP_TOOLS });

      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments ?? {};
        try {
          const run = () => executeMcpTool(toolName, args, getContextRef.current());
          const result = TREE_WRITE_TOOLS.has(String(toolName)) ? await writeQueueRef.current!(run) : await run();
          return ok({
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          });
        } catch (e: any) {
          // Erro de ferramenta volta como resultado com isError, não como
          // erro de protocolo: assim o modelo lê a mensagem e se corrige.
          return ok({
            content: [{ type: 'text', text: `Error: ${e?.message ?? String(e)}` }],
            isError: true,
          });
        }
      }

      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }, []);

  // Uma mensagem JSON-RPC na lista de conexões: quem chamou e, no
  // tools/call, o que está rodando. Devolve o fim da chamada.
  const track = useCallback((meta: McpRequestMeta, message: any): ((ok: boolean) => void) => {
    const method = typeof message?.method === 'string' ? message.method : undefined;
    const at = Date.now();
    dispatchConnection({ type: 'request', meta, method, clientInfo: message?.params?.clientInfo, at });
    if (method !== 'tools/call') return () => {};
    const key = sessionKey(meta);
    const callId = `${at}-${Math.random().toString(36).slice(2)}`;
    dispatchConnection({ type: 'toolStart', key, callId, tool: String(message?.params?.name ?? '?'), at });
    return ok => dispatchConnection({ type: 'toolEnd', key, callId, ok, at: Date.now() });
  }, []);

  const handleTracked = useCallback(
    async (meta: McpRequestMeta, message: any) => {
      const done = track(meta, message);
      const response = await handleRpc(message);
      done(!response?.error && !response?.result?.isError);
      return response;
    },
    [handleRpc, track]
  );

  // Sessão encerrada (DELETE) e chamada recusada por token, vindos do Rust.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<McpActivityEvent>('mcp-activity', event => {
      const { kind, sessionId, userAgent, reason } = event.payload;
      if (kind === 'closed' && sessionId) dispatchConnection({ type: 'closed', sessionId, at: Date.now() });
      if (kind === 'rejected') {
        dispatchConnection({ type: 'rejected', reason: reason ?? 'wrong', userAgent, at: Date.now() });
      }
    })
      .then(fn => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(err => console.error('Erro ao escutar mcp-activity:', err));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Listener dos pedidos vindos do Rust. Fica registrado mesmo com o servidor
  // desligado (aí simplesmente não chega nada): assim ele já existe quando o
  // servidor começa a aceitar conexões.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const ready = listen<McpRequestEvent>('mcp-request', async event => {
      const { id, payload, sessionId, userAgent, clientTag } = event.payload;
      const meta: McpRequestMeta = { sessionId, userAgent, clientTag };

      // Sinal de vida pro Rust enquanto a ferramenta trabalha: o prazo de lá
      // é de inatividade, não de duração (ver FRONTEND_IDLE_TIMEOUT_SECS).
      // Sem isso um run_collection ou um login de mais de 2 min voltava como
      // "timed out" pro agente com o fluxo ainda rodando.
      const heartbeat = setInterval(() => {
        invoke('mcp_heartbeat', { id }).catch(() => {});
      }, MCP_HEARTBEAT_MS);

      let response: unknown;
      try {
        const parsed = JSON.parse(payload);

        if (Array.isArray(parsed)) {
          // Batch JSON-RPC: responde só o que não é notificação.
          const results = [];
          for (const message of parsed) {
            const r = await handleTracked(meta, message);
            if (r) results.push(r);
          }
          response = results.length > 0 ? results : null;
        } else {
          response = await handleTracked(meta, parsed);
        }
      } catch (e: any) {
        response = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${e?.message ?? String(e)}` },
        };
      } finally {
        clearInterval(heartbeat);
      }

      invoke('mcp_respond', {
        id,
        payload: response === null ? '' : JSON.stringify(response),
      }).catch(err => console.error('Erro ao responder o MCP:', err));
    })
      .then(fn => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(err => console.error('Erro ao escutar mcp-request:', err));
    listenerReadyRef.current = ready;

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleTracked]);

  // Espera o listener em vigor. Se ele foi trocado enquanto esperava (o
  // StrictMode do modo dev monta, desmonta e monta de novo), espera o novo.
  const waitForListener = useCallback(async () => {
    for (;;) {
      const current = listenerReadyRef.current;
      await current;
      if (current === listenerReadyRef.current) return;
    }
  }, []);

  const enable = useCallback(async () => {
    // Dois enables seguidos (o religar da abertura roda duas vezes no modo
    // dev) viram um só.
    if (enableInFlightRef.current) return enableInFlightRef.current;
    const run = (async () => {
      setStarting(true);
      setError(null);
      try {
        // No religar automático da abertura do app o estado `token` ainda está
        // vazio (é preenchido por outro efeito), então busca direto.
        const activeToken = token || (await loadToken());
        const savedPort = Number(localStorage.getItem(PORT_KEY) ?? 0) || 0;
        // Porta salva na faixa dinâmica do Windows (de quando o SO sorteava)
        // é trocada uma vez pela porta fixa: ela tende a sumir no próximo boot.
        const desiredPort = desiredMcpPort(localStorage.getItem(PORT_KEY));
        await waitForListener();
        const boundPort = await invoke<number>('start_mcp_server', {
          port: desiredPort,
          token: activeToken,
        });

        // A porta salva não pôde ser usada e o servidor subiu em outra. A URL
        // muda — e quem já rodou o `claude mcp add` ficaria com um cliente
        // apontando pro lugar errado, sem nada na tela explicando por quê.
        setPortChanged(savedPort !== 0 && boundPort !== savedPort);
        setToken(activeToken);
        setPort(boundPort);
        setEnabled(true);
        localStorage.setItem(ENABLED_KEY, 'true');
        localStorage.setItem(PORT_KEY, String(boundPort));
      } catch (e: any) {
        setError(e?.message ?? String(e));
        setEnabled(false);
      } finally {
        setStarting(false);
      }
    })();
    enableInFlightRef.current = run;
    try {
      await run;
    } finally {
      enableInFlightRef.current = null;
    }
  }, [token, waitForListener]);

  const disable = useCallback(async () => {
    try {
      await invoke('stop_mcp_server');
    } catch (e) {
      console.error('Erro ao parar o servidor MCP:', e);
    }
    setEnabled(false);
    setPort(null);
    dispatchConnection({ type: 'reset' });
    // O servidor já parou; não lembrar disso no disco é um detalhe, derrubar
    // a janela ao desligá-lo não é.
    safeSetItem(ENABLED_KEY, 'false');
  }, []);

  const endSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('mcp_end_session', { sessionId });
      dispatchConnection({ type: 'closed', sessionId, at: Date.now(), endedHere: true });
    } catch (e) {
      setError(`Could not end the MCP session: ${(e as Error)?.message ?? String(e)}`);
    }
  }, []);

  // Reiniciar = o mesmo start do Turn on (para o listener, espera soltar a
  // porta e sobe de novo). Chamadas em andamento voltam com erro pro cliente;
  // os clientes seguem funcionando na próxima chamada (sessão desconhecida é aceita).
  const restart = useCallback(async () => {
    if (!enabled) return;
    setStarting(true);
    setError(null);
    try {
      const boundPort = await invoke<number>('start_mcp_server', {
        port: port ?? desiredMcpPort(null),
        token: token || (await loadToken()),
      });
      setPortChanged(port !== null && boundPort !== port);
      setPort(boundPort);
      safeSetItem(PORT_KEY, String(boundPort));
      dispatchConnection({ type: 'reset' });
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setStarting(false);
    }
  }, [enabled, port, token]);

  const regenerateToken = useCallback(async () => {
    const created = generateToken();
    try {
      // Só publica o token novo depois que ele foi gravado: se a gravação
      // falhar e o servidor já tivesse reiniciado com ele, o app passaria a
      // exigir uma credencial que se perderia no próximo start.
      await saveSecret(TOKEN_KEY, created);
    } catch (e) {
      setError(`Could not save the new MCP token: ${(e as Error)?.message ?? String(e)}`);
      return;
    }

    setToken(created);
    setError(null);

    // Quem já estava conectado passa a receber 401 até reconfigurar — é o
    // ponto de gerar um token novo.
    if (enabled) {
      try {
        const boundPort = await invoke<number>('start_mcp_server', {
          port: port ?? desiredMcpPort(null),
          token: created,
        });
        setPort(boundPort);
        safeSetItem(PORT_KEY, String(boundPort));
      } catch (e) {
        setError((e as Error)?.message ?? String(e));
      }
    }
  }, [enabled, port]);

  // Religa sozinho na abertura do app se estava ligado.
  useEffect(() => {
    if (localStorage.getItem(ENABLED_KEY) !== 'true') return;
    enable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    enabled, port, token, error, portChanged, starting, enable, disable, regenerateToken, connections, endSession, restart,
  };
}
