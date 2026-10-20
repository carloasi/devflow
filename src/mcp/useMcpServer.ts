'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MCP_TOOLS, McpContext, executeMcpTool } from './mcpTools';
import { getSecret, saveSecret } from '@/lib/secureStorage';
import { safeSetItem } from '@/lib/safeStorage';

// ─────────────────────────────────────────────────────────────────────────
// Camada JSON-RPC do servidor MCP. O Rust (mcp_server.rs) só transporta:
// cada requisição HTTP chega aqui por evento, é interpretada como JSON-RPC
// e a resposta volta pelo comando `mcp_respond`.
//
// Protocolo implementado: initialize, tools/list, tools/call, ping — o
// suficiente pro Claude Code. Notificações (sem `id`) não têm resposta.
// ─────────────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '2024-11-05';
const ENABLED_KEY = 'devflow_mcp_enabled';
const PORT_KEY = 'devflow_mcp_port';
const TOKEN_KEY = 'devflow_mcp_token';

interface McpRequestEvent {
  id: number;
  payload: string;
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
}

export function useMcpServer(getContext: () => McpContext): UseMcpServerResult {
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [portChanged, setPortChanged] = useState(false);
  const [starting, setStarting] = useState(false);

  // O contexto (collections/environments/workspace) muda o tempo todo; ler
  // por ref evita re-registrar o listener a cada render e garante que cada
  // chamada enxergue o estado atual.
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;

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
          protocolVersion: PROTOCOL_VERSION,
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
          const result = await executeMcpTool(toolName, args, getContextRef.current());
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

  // Listener dos pedidos vindos do Rust.
  useEffect(() => {
    if (!enabled) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<McpRequestEvent>('mcp-request', async event => {
      const { id, payload } = event.payload;

      let response: unknown;
      try {
        const parsed = JSON.parse(payload);

        if (Array.isArray(parsed)) {
          // Batch JSON-RPC: responde só o que não é notificação.
          const results = [];
          for (const message of parsed) {
            const r = await handleRpc(message);
            if (r) results.push(r);
          }
          response = results.length > 0 ? results : null;
        } else {
          response = await handleRpc(parsed);
        }
      } catch (e: any) {
        response = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${e?.message ?? String(e)}` },
        };
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

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enabled, handleRpc]);

  const enable = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      // No religar automático da abertura do app o estado `token` ainda está
      // vazio (é preenchido por outro efeito), então busca direto.
      const activeToken = token || (await loadToken());
      const desiredPort = Number(localStorage.getItem(PORT_KEY) ?? 0) || 0;
      const boundPort = await invoke<number>('start_mcp_server', {
        port: desiredPort,
        token: activeToken,
      });

      // O Rust cai pra porta efêmera quando a porta salva não aceita bind (no
      // Windows isso acontece sozinho depois de um boot, pelas faixas que o
      // Hyper-V reserva). O servidor sobe, mas a URL muda — e quem já rodou o
      // `claude mcp add` ficaria com um cliente apontando pro lugar errado,
      // sem nada na tela explicando por quê.
      setPortChanged(desiredPort !== 0 && boundPort !== desiredPort);
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
  }, [token]);

  const disable = useCallback(async () => {
    try {
      await invoke('stop_mcp_server');
    } catch (e) {
      console.error('Erro ao parar o servidor MCP:', e);
    }
    setEnabled(false);
    setPort(null);
    // O servidor já parou; não lembrar disso no disco é um detalhe, derrubar
    // a janela ao desligá-lo não é.
    safeSetItem(ENABLED_KEY, 'false');
  }, []);

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
          port: port ?? 0,
          token: created,
        });
        setPort(boundPort);
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

  return { enabled, port, token, error, portChanged, starting, enable, disable, regenerateToken };
}
