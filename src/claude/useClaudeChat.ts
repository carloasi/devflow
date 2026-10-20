'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ClaudeConversation,
  deleteConversation as deleteStoredConversation,
  deriveTitle,
  listConversations,
  saveConversation,
} from './claudeHistoryStore';
import { CLAUDE_API_KEY_SECRET, readClaudeAuthMode, readClaudeIsolated } from './useClaudeAuth';
import { getSecret } from '@/lib/secureStorage';

// ─────────────────────────────────────────────────────────────────────────
// Conversa com o Claude Code em modo headless (ver claude_cli.rs).
//
// O CLI devolve stream-json: uma linha JSON por evento. Aqui a gente só
// pega o que interessa pra UI — texto do assistente, chamadas de ferramenta
// e o resultado final — e ignora o resto (retry, init, partials de
// thinking), que existe pro protocolo, não pro usuário.
// ─────────────────────────────────────────────────────────────────────────

const BINARY_PATH_KEY = 'devflow_claude_binary_path';
const CWD_KEY = 'devflow_claude_cwd';

// Sem isso o modelo trata a sessão como um projeto de código: tenta Glob,
// Grep e Bash pra "achar o arquivo do response", bate no bloqueio de
// permissão (só as ferramentas do devflow são pré-aprovadas) e desperdiça
// turnos pedindo pro usuário colar o conteúdo — foi exatamente o que
// aconteceu antes de existirem as ferramentas get_response/get_active_request.
const PANEL_SYSTEM_PROMPT = [
  'You are running inside DevFlow, an API client, in a side panel next to the request the user is looking at.',
  'You have no filesystem access here and no shell: do not use Glob, Grep, Read or Bash, they are blocked.',
  'Everything you need comes from the "devflow" MCP tools.',
  'To see the response the user is looking at, call get_response — it returns the body already on screen, without re-running anything.',
  'Use get_active_request when the user says "this request" or "the response on screen".',
  // Sem esta linha o agente concluía "não há resposta salva" e pedia pro
  // usuário executar de novo um fluxo que ele acabara de rodar no Runner —
  // o resultado estava guardado, só não havia nada apontando pra ele.
  'When a request was run by the Collection Runner rather than opened in a tab, get_response finds nothing: call get_last_run instead. It returns the status, the assertions and the response body of every request of the last run, so never ask the user to re-run a flow before checking it.',
  'Prefer reading over acting: get_last_run and get_response cost nothing, while run_request and run_collection hit the real API with the user\'s real credentials.',
  // O agente lia "URL vazia" num passo de token e propunha preencher ou
  // apagar — o oposto do certo, e apagar quebraria o fluxo inteiro.
  'A request whose Authorization is OAuth 2.0 and whose URL is empty is a token step (MSAL/Azure AD): it is not broken and must never be "fixed" by adding a URL or deleted. It exists to hold the OAuth settings, and running the flow fills the {{variable}} the rest of it uses — the Collection Runner and run_request get the token by themselves, reusing a valid one; get_oauth2_token is for when you need expiry, audience and scopes, or a forced renewal. get_request flags these with tokenStep: true.',
  'Before writing any pre-request or post-response script, call get_script_api: the runtime is a sandboxed QuickJS with a hand-written pm object, not Node and not the full Postman API.',
  'You can fix scripts with set_request_script (it saves locally, it never pushes to GitHub), run load tests with run_load_test, review past ones with list_load_tests, and read the app console with get_console_logs.',
  'Answer in the language the user writes in.',
].join(' ');

export interface ClaudeMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  // Só pra role 'tool': nome da ferramenta chamada.
  toolName?: string;
}

export interface UseClaudeChatResult {
  messages: ClaudeMessage[];
  running: boolean;
  available: boolean | null;
  version: string | null;
  send: (prompt: string) => Promise<void>;
  cancel: () => Promise<void>;
  // Fecha a conversa atual (guardada no histórico) e começa uma nova.
  reset: () => void;
  history: ClaudeConversation[];
  loadConversation: (id: string) => void;
  removeConversation: (id: string) => void;
}

interface McpBridge {
  port: number | null;
  token: string;
  enabled: boolean;
}

// Id único de verdade, não um contador. O contador reiniciava do zero a
// cada abertura do app, então reabrir uma conversa do histórico (cujas
// mensagens já eram "msg-1", "msg-2"...) e mandar uma mensagem nova gerava
// "msg-1" de novo — duas linhas com a mesma key, que o React rejeita e pode
// duplicar/omitir na renderização.
let messageCounter = 0;
function nextId(): string {
  messageCounter += 1;
  const unique =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  return `msg-${unique}-${messageCounter}`;
}

// Conversas gravadas antes da correção acima já têm ids repetidos dentro
// delas ("msg-1" de uma sessão + "msg-1" de outra), e o React quebra ao
// renderizar. Regerar o id de qualquer duplicata (ou id ausente) na leitura
// conserta o histórico existente sem precisar apagá-lo.
function normalizeMessageIds(messages: ClaudeMessage[]): ClaudeMessage[] {
  const seen = new Set<string>();
  return messages.map(message => {
    if (!message.id || seen.has(message.id)) {
      const fresh = nextId();
      seen.add(fresh);
      return { ...message, id: fresh };
    }
    seen.add(message.id);
    return message;
  });
}

export function useClaudeChat(mcp: McpBridge): UseClaudeChatResult {
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  const [history, setHistory] = useState<ClaudeConversation[]>([]);

  // Sessão do claude, pra segunda mensagem em diante continuar a conversa
  // em vez de começar do zero.
  const sessionIdRef = useRef<string | null>(null);
  // Id local da conversa (diferente do sessionId do CLI): identifica o
  // registro no histórico, e existe antes mesmo do CLI responder.
  const conversationIdRef = useRef<string>(`conv-${Date.now()}`);
  // Texto do assistente da vez, montado a partir dos deltas do stream.
  const streamingRef = useRef<{ id: string; text: string } | null>(null);
  const mcpRef = useRef(mcp);
  mcpRef.current = mcp;

  const binaryPath = () => localStorage.getItem(BINARY_PATH_KEY) ?? undefined;

  // Lida na hora do envio, e não guardada em estado: assim trocar de modo ou
  // de chave nas configurações já vale na próxima mensagem, sem o painel
  // precisar ser remontado.
  const currentApiKey = async (): Promise<string | undefined> => {
    if (readClaudeAuthMode() !== 'apiKey') return undefined;
    try {
      return (await getSecret(CLAUDE_API_KEY_SECRET)) || undefined;
    } catch {
      return undefined;
    }
  };

  useEffect(() => {
    invoke<string>('claude_available', { binaryPath: binaryPath(), isolated: readClaudeIsolated() })
      .then(v => {
        setVersion(v);
        setAvailable(true);
      })
      .catch(() => setAvailable(false));
  }, []);

  const appendMessage = useCallback((message: ClaudeMessage) => {
    setMessages(prev => [...prev, message]);
  }, []);

  const handleLine = useCallback((raw: string) => {
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return; // linha não-JSON: ignora em vez de poluir a conversa
    }

    // Guarda o id da sessão pra próxima mensagem (--resume).
    if (event.session_id) sessionIdRef.current = event.session_id;

    // Texto chegando token a token.
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
      const delta = event.event.delta.text ?? '';
      if (!streamingRef.current) {
        const id = nextId();
        streamingRef.current = { id, text: delta };
        setMessages(prev => [...prev, { id, role: 'assistant', text: delta }]);
      } else {
        streamingRef.current.text += delta;
        const { id, text } = streamingRef.current;
        setMessages(prev => prev.map(m => (m.id === id ? { ...m, text } : m)));
      }
      return;
    }

    // Mensagem completa do assistente: fecha o bloco em streaming e mostra
    // as chamadas de ferramenta (é o que dá pro usuário acompanhar o que o
    // Claude está fazendo no DevFlow).
    if (event.type === 'assistant') {
      const content = event.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          appendMessage({
            id: nextId(),
            role: 'tool',
            toolName: String(block.name ?? 'tool'),
            text: JSON.stringify(block.input ?? {}, null, 2),
          });
        }
      }
      streamingRef.current = null;
      return;
    }

    if (event.type === 'result') {
      streamingRef.current = null;
      // `result` traz o texto final. Se nada foi renderizado via delta
      // (partials desligados, resposta curta), mostra aqui.
      if (event.is_error) {
        appendMessage({
          id: nextId(),
          role: 'error',
          text: String(event.result ?? 'The run failed.'),
        });
      }
    }
  }, [appendMessage]);

  useEffect(() => {
    let unlistenLine: (() => void) | undefined;
    let unlistenDone: (() => void) | undefined;
    let cancelled = false;

    listen<{ line: string }>('claude-chat-line', e => handleLine(e.payload.line))
      .then(fn => (cancelled ? fn() : (unlistenLine = fn)))
      .catch(err => console.error('Erro ao escutar claude-chat-line:', err));

    listen<{ code: number | null; stderr: string }>('claude-chat-done', e => {
      streamingRef.current = null;
      setRunning(false);
      const { code, stderr } = e.payload;
      if (code !== null && code !== 0 && stderr.trim()) {
        appendMessage({ id: nextId(), role: 'error', text: stderr.trim() });
      }
    })
      .then(fn => (cancelled ? fn() : (unlistenDone = fn)))
      .catch(err => console.error('Erro ao escutar claude-chat-done:', err));

    return () => {
      cancelled = true;
      unlistenLine?.();
      unlistenDone?.();
    };
  }, [handleLine, appendMessage]);

  const send = useCallback(async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed || running) return;

    appendMessage({ id: nextId(), role: 'user', text: trimmed });
    setRunning(true);

    // Passa o servidor MCP local já configurado: o Claude enxerga as
    // collections deste app sem o usuário rodar `claude mcp add`.
    const bridge = mcpRef.current;
    const mcpConfig =
      bridge.enabled && bridge.port
        ? JSON.stringify({
            mcpServers: {
              devflow: {
                type: 'http',
                url: `http://127.0.0.1:${bridge.port}/mcp`,
                headers: { Authorization: `Bearer ${bridge.token}` },
              },
            },
          })
        : undefined;

    try {
      await invoke('claude_send', {
        prompt: trimmed,
        sessionId: sessionIdRef.current,
        mcpConfig,
        // Só as ferramentas do DevFlow são pré-aprovadas. O painel não tem
        // UI de permissão, e com --permission-mode dontAsk o resto é negado
        // sem travar esperando resposta.
        allowedTools: mcpConfig ? 'mcp__devflow' : undefined,
        appendSystemPrompt: PANEL_SYSTEM_PROMPT,
        cwd: localStorage.getItem(CWD_KEY) ?? undefined,
        binaryPath: binaryPath(),
        // Só vai preenchida no modo "chave da API" (ver useClaudeAuth); no
        // modo conta fica undefined pro CLI usar a credencial dele.
        apiKey: await currentApiKey(),
        // Mesmo perfil do CLI usado pela autenticacao; se divergir, o envio
        // procuraria a credencial num diretorio onde ela nao esta.
        isolated: readClaudeIsolated(),
      });
    } catch (e: any) {
      appendMessage({ id: nextId(), role: 'error', text: e?.message ?? String(e) });
      setRunning(false);
    }
  }, [running, appendMessage]);

  const cancel = useCallback(async () => {
    try {
      await invoke('claude_cancel');
    } catch (e) {
      console.error('Erro ao cancelar o Claude:', e);
    }
    setRunning(false);
  }, []);

  // Persiste a conversa a cada mudança. Roda com um debounce curto porque
  // o texto chega token a token — sem isso seria uma escrita em
  // localStorage por caractere.
  useEffect(() => {
    if (messages.length === 0) return;
    const timer = setTimeout(() => {
      saveConversation({
        id: conversationIdRef.current,
        title: deriveTitle(messages),
        updatedAt: Date.now(),
        sessionId: sessionIdRef.current,
        messages,
      });
      setHistory(listConversations());
    }, 400);
    return () => clearTimeout(timer);
  }, [messages]);

  useEffect(() => {
    setHistory(listConversations());
  }, []);

  const reset = useCallback(() => {
    // A conversa atual já está salva pelo efeito acima; aqui só se começa
    // outra, com id e sessão novos.
    sessionIdRef.current = null;
    streamingRef.current = null;
    conversationIdRef.current = `conv-${Date.now()}`;
    setMessages([]);
    setHistory(listConversations());
  }, []);

  const loadConversation = useCallback((id: string) => {
    const found = listConversations().find(c => c.id === id);
    if (!found) return;
    conversationIdRef.current = found.id;
    // Restaura a sessão do CLI: continuar de onde parou em vez de recomeçar.
    sessionIdRef.current = found.sessionId;
    streamingRef.current = null;
    setMessages(normalizeMessageIds(found.messages));
  }, []);

  const removeConversation = useCallback((id: string) => {
    deleteStoredConversation(id);
    setHistory(listConversations());
    if (conversationIdRef.current === id) {
      conversationIdRef.current = `conv-${Date.now()}`;
      sessionIdRef.current = null;
      setMessages([]);
    }
  }, []);

  return {
    messages,
    running,
    available,
    version,
    send,
    cancel,
    reset,
    history,
    loadConversation,
    removeConversation,
  };
}
