'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Sparkles, Square, X, Wrench, AlertTriangle, History, Plus, Copy, Check, Trash2, KeyRound,
} from 'lucide-react';
import { UseClaudeChatResult } from './useClaudeChat';
import { useClaudeAuth } from './useClaudeAuth';

interface ClaudeChatPanelProps {
  open: boolean;
  onClose: () => void;
  chat: UseClaudeChatResult;
  mcpEnabled: boolean;
}

const WIDTH_KEY = 'devflow_claude_panel_width';
const MIN_WIDTH = 300;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 380;

function readStoredWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw));
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function ClaudeChatPanel({ open, onClose, chat, mcpEnabled }: ClaudeChatPanelProps) {
  const [input, setInput] = useState('');
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const auth = useClaudeAuth();
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  // Painel de credencial aberto pelo botão de chave no cabeçalho. Antes ele
  // só existia enquanto NÃO havia credencial: depois de salvar uma chave
  // (mesmo inválida) a faixa sumia e não sobrava nenhum jeito de trocar a
  // chave ou voltar pra conta Claude — o "Invalid API key" ficava preso.
  const [authOpen, setAuthOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setWidth(readStoredWidth());
  }, []);

  // Rola pro fim conforme a resposta chega.
  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat.messages, open]);

  // ── Redimensionar arrastando a borda esquerda ──────────────────────────
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);

    const startX = e.clientX;
    const startWidth = width;

    const onMove = (ev: MouseEvent) => {
      // Painel fica à direita: arrastar pra esquerda aumenta.
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setWidth(next);
    };

    const onUp = () => {
      setResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persiste só no fim do arrasto, não a cada pixel.
      setWidth(current => {
        try { localStorage.setItem(WIDTH_KEY, String(current)); } catch { /* ignora */ }
        return current;
      });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [width]);

  const copy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(current => (current === id ? null : current)), 1500);
    } catch (e) {
      console.error('Erro ao copiar:', e);
    }
  }, []);

  const copyConversation = useCallback(() => {
    const text = chat.messages
      .map(m => {
        const prefix =
          m.role === 'user' ? 'You:' : m.role === 'tool' ? `Tool (${m.toolName}):` : m.role === 'error' ? 'Error:' : 'Claude:';
        return `${prefix}\n${m.text}`;
      })
      .join('\n\n');
    copy('conversation', text);
  }, [chat.messages, copy]);

  if (!open) return null;

  const submit = () => {
    const value = input;
    setInput('');
    chat.send(value);
  };

  return (
    // relative + z alto: o painel continua no fluxo (o conteúdo encolhe em
    // vez de ficar coberto), mas pinta ACIMA dos modais — Load Test, Runner
    // e Settings são overlays fixed com z-[9998]/z-[10001], e sem isso
    // engoliam o painel enquanto abertos.
    <div className="relative z-[10050] flex h-full shrink-0" style={{ width }}>
      {/* Alça de redimensionar */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className={`w-1 shrink-0 cursor-col-resize transition-colors ${
          resizing ? 'bg-pm-accent/60' : 'bg-pm-border hover:bg-pm-accent/40'
        }`}
      />

      <div className="flex min-w-0 flex-1 flex-col bg-pm-sidebar">
        <div className="relative flex h-11 shrink-0 items-center justify-between border-b border-pm-border px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles size={14} className="shrink-0 text-pm-accent" />
            <span className="text-[13px] font-semibold text-pm-text">Claude</span>
            {chat.version && (
              <span className="truncate font-mono text-[10px] text-pm-text-muted">{chat.version}</span>
            )}
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => { setAuthOpen(v => !v); auth.refresh(); }}
              title={
                auth.mode === 'apiKey'
                  ? 'Signed in with an API key — change or remove it'
                  : 'Claude sign-in'
              }
              className={`flex h-7 w-7 items-center justify-center rounded transition-colors cursor-pointer ${
                authOpen ? 'bg-pm-row-active text-pm-text' : 'text-pm-text-muted hover:bg-pm-hover hover:text-pm-text'
              }`}
            >
              <KeyRound size={13} />
            </button>
            {chat.messages.length > 0 && (
              <button
                onClick={copyConversation}
                title="Copy the whole conversation"
                className="flex h-7 w-7 items-center justify-center rounded text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text cursor-pointer"
              >
                {copiedId === 'conversation' ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
              </button>
            )}
            <button
              onClick={() => setHistoryOpen(v => !v)}
              title="Past conversations"
              className={`flex h-7 w-7 items-center justify-center rounded transition-colors cursor-pointer ${
                historyOpen ? 'bg-pm-row-active text-pm-text' : 'text-pm-text-muted hover:bg-pm-hover hover:text-pm-text'
              }`}
            >
              <History size={13} />
            </button>
            <button
              onClick={() => { chat.reset(); setHistoryOpen(false); }}
              title="New conversation"
              className="flex h-7 w-7 items-center justify-center rounded text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text cursor-pointer"
            >
              <Plus size={14} />
            </button>
            <button
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text cursor-pointer"
            >
              <X size={14} />
            </button>
          </div>

          {historyOpen && (
            <div className="absolute right-2 top-[calc(100%+4px)] z-30 max-h-80 w-[290px] overflow-y-auto rounded-lg border border-pm-border bg-pm-surface p-1 shadow-2xl">
              {chat.history.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-pm-text-muted">
                  No past conversations yet.
                </p>
              ) : (
                chat.history.map(conversation => (
                  <div key={conversation.id} className="group flex items-center gap-1 rounded-md px-1 hover:bg-pm-hover">
                    <button
                      onClick={() => { chat.loadConversation(conversation.id); setHistoryOpen(false); }}
                      className="flex min-w-0 flex-1 flex-col items-start px-1.5 py-1.5 text-left cursor-pointer"
                    >
                      <span className="w-full truncate text-[12px] text-pm-text-secondary">
                        {conversation.title}
                      </span>
                      <span className="text-[10px] text-pm-text-muted">
                        {new Date(conversation.updatedAt).toLocaleString()}
                      </span>
                    </button>
                    <button
                      onClick={() => chat.removeConversation(conversation.id)}
                      title="Delete"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-pm-text-muted opacity-0 transition-all hover:bg-rose-500/10 hover:text-rose-400 group-hover:opacity-100 cursor-pointer"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {chat.available === false && (
          <div className="flex items-start gap-2 border-b border-pm-border bg-amber-400/10 px-3 py-2 text-[11px] text-amber-300/90">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            <span>
              The <span className="font-mono">claude</span> CLI wasn&apos;t found. Install Claude Code
              and sign in, then reopen this panel.
            </span>
          </div>
        )}

        {/* O CLI existir não quer dizer que ele tem credencial: `claude
            --version` responde igual deslogado. Sem esta faixa, o sintoma era
            toda mensagem falhando sem o painel dizer por quê. */}
        {chat.available && (authOpen || !auth.hasCredential) && (
          <div
            className={`border-b border-pm-border px-3 py-2 text-[11px] ${
              auth.hasCredential ? 'bg-pm-hover/40 text-pm-text-secondary' : 'bg-amber-400/10 text-amber-300/90'
            }`}
          >
            {auth.hasCredential ? (
              <div className="flex items-start justify-between gap-2">
                <span>
                  {auth.mode === 'apiKey' ? (
                    <>
                      Using an <b className="text-pm-text">API key</b>{' '}
                      <span className="font-mono text-pm-text-muted">
                        (…{auth.activeApiKey?.slice(-4)})
                      </span>
                      . If Claude answers &ldquo;Invalid API key&rdquo;, replace it below or switch
                      back to your Claude account.
                    </>
                  ) : (
                    <>
                      Using your <b className="text-pm-text">Claude account</b>
                      {auth.status?.authMethod ? ` (${auth.status.authMethod})` : ''}.
                    </>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setAuthOpen(false)}
                  title="Close"
                  className="shrink-0 rounded p-0.5 text-pm-text-muted hover:bg-pm-hover hover:text-pm-text cursor-pointer"
                >
                  <X size={11} />
                </button>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                <span>Claude Code has no credential yet. Choose how to sign in:</span>
              </div>
            )}
            {/* Sem isso o login grava em ~/.claude, que é global: entrar aqui
                com a conta pessoal derrubaria a conta já usada no terminal. */}
            <label className="mt-2 flex cursor-pointer items-start gap-1.5 text-[10.5px] text-pm-text-muted">
              <input
                type="checkbox"
                checked={auth.isolated}
                onChange={e => auth.setIsolated(e.target.checked)}
                className="mt-px cursor-pointer"
              />
              <span>
                Keep a <b className="text-pm-text-secondary">separate login for DevFlow</b> — signing
                in here won&apos;t touch the Claude Code account you use in the terminal. Uncheck to
                reuse that account instead (this profile then also picks up your global settings,
                MCP servers and CLAUDE.md).
              </span>
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => auth.login(false)}
                className="h-6 rounded-md bg-[#007acc] px-2 text-[10px] font-medium text-white hover:bg-[#3794ff]"
                title="Opens a terminal running: claude auth login --claudeai"
              >
                Claude subscription
              </button>
              <button
                type="button"
                onClick={() => auth.login(true)}
                className="h-6 rounded-md bg-pm-hover px-2 text-[10px] text-pm-text-secondary hover:text-pm-text"
                title="Opens a terminal running: claude auth login --console (API usage billing)"
              >
                Anthropic Console
              </button>
              {auth.mode === 'apiKey' ? (
                <button
                  type="button"
                  onClick={() => auth.setMode('account')}
                  className="h-6 rounded-md bg-pm-hover px-2 text-[10px] text-pm-text-secondary hover:text-pm-text"
                  title="Stop using the API key and use the signed-in Claude account (the key stays saved)"
                >
                  Use my Claude account
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => auth.setMode('apiKey')}
                  className="h-6 rounded-md bg-pm-hover px-2 text-[10px] text-pm-text-secondary hover:text-pm-text"
                  title="Use an ANTHROPIC_API_KEY instead of a signed-in account"
                >
                  Use an API key
                </button>
              )}
              <button
                type="button"
                onClick={auth.refresh}
                disabled={auth.checking}
                className="h-6 rounded-md px-2 text-[10px] text-pm-text-muted hover:text-pm-text disabled:opacity-50"
              >
                {auth.checking ? 'Checking...' : 'Check again'}
              </button>
            </div>
            {auth.mode === 'apiKey' && (
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  type="password"
                  value={apiKeyDraft}
                  onChange={e => setApiKeyDraft(e.target.value)}
                  placeholder={auth.activeApiKey ? 'New key (sk-ant-...)' : 'sk-ant-...'}
                  className="h-6 min-w-0 flex-1 rounded border border-pm-border bg-pm-surface px-1.5 font-mono text-[10px] text-pm-text outline-none"
                />
                <button
                  type="button"
                  onClick={async () => {
                    await auth.saveApiKey(apiKeyDraft);
                    setApiKeyDraft('');
                  }}
                  disabled={!apiKeyDraft.trim()}
                  className="h-6 rounded-md bg-[#007acc] px-2 text-[10px] font-medium text-white disabled:opacity-40"
                >
                  {auth.activeApiKey ? 'Replace' : 'Save'}
                </button>
                {auth.activeApiKey ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await auth.clearApiKey();
                      auth.setMode('account');
                    }}
                    title="Delete the saved key and go back to the Claude account"
                    className="h-6 rounded-md px-2 text-[10px] text-rose-400 hover:bg-rose-500/10"
                  >
                    Remove key
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => auth.setMode('account')}
                    className="h-6 rounded-md px-2 text-[10px] text-pm-text-muted hover:text-pm-text"
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {chat.available && !mcpEnabled && (
          <div className="border-b border-pm-border bg-pm-hover/40 px-3 py-2 text-[11px] text-pm-text-muted">
            Turn on the MCP server in Settings so Claude can read and run the requests in this
            workspace.
          </div>
        )}

        {/* select-text explícito: o texto do resultado precisa dar pra
            selecionar e copiar com o mouse, além do botão de copiar. */}
        <div ref={listRef} className="flex-1 select-text overflow-y-auto px-3 py-3">
          {chat.messages.length === 0 ? (
            <div className="mt-8 px-2 text-center">
              <p className="text-[12px] text-pm-text-secondary">Ask about this workspace.</p>
              <p className="mt-2 text-[11px] leading-relaxed text-pm-text-muted">
                &ldquo;Run the Booking Flow on env-tst and tell me which step broke.&rdquo;
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {chat.messages.map((message, index) => {
                // Key composta com o índice: a lista é append-only (o índice
                // de uma mensagem nunca muda), e isso garante unicidade
                // mesmo que algum id repetido escape do histórico antigo.
                const key = `${message.id}-${index}`;

                if (message.role === 'user') {
                  return (
                    <div key={key} className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-pm-accent/15 px-2.5 py-1.5 text-[12px] text-pm-text">
                      {message.text}
                    </div>
                  );
                }

                if (message.role === 'tool') {
                  return (
                    <div key={key} className="group rounded-md border border-pm-border bg-pm-hover/50 px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold text-pm-text-secondary">
                        <Wrench size={10} />
                        <span className="flex-1 truncate">{message.toolName}</span>
                        <button
                          onClick={() => copy(message.id, message.text)}
                          title="Copy"
                          className="opacity-0 transition-opacity hover:text-pm-text group-hover:opacity-100 cursor-pointer"
                        >
                          {copiedId === message.id ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                        </button>
                      </div>
                      <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[10px] text-pm-text-muted">
                        {message.text}
                      </pre>
                    </div>
                  );
                }

                if (message.role === 'error') {
                  // Erro de credencial do CLI ("Invalid API key · Fix external
                  // API key", "not logged in"...) -> atalho pro painel de chave.
                  const isAuthError = /api key|not logged in|login|authenticat|unauthori|401/i.test(message.text);
                  return (
                    <div key={key} className="group relative whitespace-pre-wrap break-words rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11.5px] text-rose-300">
                      {message.text}
                      {isAuthError && (
                        <button
                          type="button"
                          onClick={() => { setAuthOpen(true); auth.refresh(); }}
                          className="mt-1.5 flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10.5px] font-medium text-rose-200 hover:bg-rose-500/25 cursor-pointer"
                        >
                          <KeyRound size={10} /> Fix sign-in / API key
                        </button>
                      )}
                      <button
                        onClick={() => copy(message.id, message.text)}
                        title="Copy"
                        className="absolute right-1 top-1 opacity-0 transition-opacity hover:text-rose-200 group-hover:opacity-100 cursor-pointer"
                      >
                        {copiedId === message.id ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                      </button>
                    </div>
                  );
                }

                return (
                  <div key={key} className="group relative whitespace-pre-wrap break-words pr-5 text-[12px] leading-relaxed text-pm-text-secondary">
                    {message.text}
                    <button
                      onClick={() => copy(message.id, message.text)}
                      title="Copy this answer"
                      className="absolute right-0 top-0 text-pm-text-muted opacity-0 transition-opacity hover:text-pm-text group-hover:opacity-100 cursor-pointer"
                    >
                      {copiedId === message.id ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                    </button>
                  </div>
                );
              })}

              {chat.running && (
                <div className="flex items-center gap-1.5 text-[11px] text-pm-text-muted">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-pm-accent" />
                  Working…
                </div>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-pm-border p-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
              e.stopPropagation();
            }}
            disabled={chat.available === false}
            placeholder="Ask Claude…"
            rows={3}
            className="w-full resize-none rounded-md border border-pm-border bg-pm-hover px-2.5 py-2 text-[12px] text-pm-text outline-none transition-colors focus:border-pm-accent/50 disabled:opacity-50"
          />

          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-pm-text-muted">Enter to send</span>
            {chat.running ? (
              <button
                onClick={chat.cancel}
                className="flex items-center gap-1 rounded-md border border-pm-border bg-pm-hover px-2.5 py-1 text-[11px] font-semibold text-pm-text transition-colors hover:bg-pm-row-active cursor-pointer"
              >
                <Square size={10} /> Stop
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!input.trim() || chat.available === false}
                className="rounded-md bg-pm-accent px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
