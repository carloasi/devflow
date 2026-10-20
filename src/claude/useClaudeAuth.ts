'use client';

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getSecret, saveSecret, deleteSecret } from '@/lib/secureStorage';

// ─────────────────────────────────────────────────────────────────────────
// Credencial do painel do Claude.
//
// O painel não fala com a API: ele roda o CLI `claude` (ver claude_cli.rs), e
// quem tem credencial é o CLI. Então "logar" aqui é delegar pro `claude auth`,
// e não guardar sessão nossa.
//
// Dois caminhos, que é o que o próprio CLI oferece:
//  - Conta Claude (assinatura): `claude auth login --claudeai`.
//  - Anthropic Console: cobrança por uso de API, via `--console` ou passando
//    uma chave direto, que o CLI lê de ANTHROPIC_API_KEY.
//
// A chave fica no armazenamento seguro do Rust, igual aos tokens do GitHub e
// do MCP — é credencial de cobrança, não preferência de UI.
// ─────────────────────────────────────────────────────────────────────────

// Exportados porque o envio da mensagem (useClaudeChat) precisa ler a mesma
// chave e o mesmo modo sem depender deste hook estar montado.
export const CLAUDE_API_KEY_SECRET = 'claude_api_key';
const MODE_KEY = 'devflow_claude_auth_mode';
const ISOLATED_KEY = 'devflow_claude_isolated_login';

// Login próprio do DevFlow, num CLAUDE_CONFIG_DIR separado, em vez do
// ~/.claude global do usuário.
//
// Ligado por padrão: sem isso, entrar pela conta pessoal aqui substituiria a
// conta que a pessoa já usa no terminal — e era exatamente o impedimento pra
// usar a assinatura no painel. Com o diretório separado as duas convivem.
//
// Em troca, este perfil não enxerga settings, MCP e CLAUDE.md globais. Quem
// prefere reaproveitar o login que já existe no terminal desliga a opção.
export function readClaudeIsolated(): boolean {
  try {
    return localStorage.getItem(ISOLATED_KEY) !== 'false';
  } catch {
    return true;
  }
}

export type ClaudeAuthMode = 'account' | 'apiKey';

// Campos do `claude auth status --json`. Só os que a UI usa: o CLI pode
// acrescentar outros, e o parsing tolerante evita quebrar quando isso
// acontecer.
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider?: string;
}

export interface UseClaudeAuthResult {
  status: ClaudeAuthStatus | null;
  checking: boolean;
  error: string | null;
  mode: ClaudeAuthMode;
  apiKey: string;
  /** Credencial que o painel vai usar de fato, ou null se não há nenhuma. */
  activeApiKey: string | null;
  hasCredential: boolean;
  isolated: boolean;
  setIsolated: (value: boolean) => void;
  setMode: (mode: ClaudeAuthMode) => void;
  saveApiKey: (key: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  login: (useConsole: boolean) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function readClaudeAuthMode(): ClaudeAuthMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'apiKey' ? 'apiKey' : 'account';
  } catch {
    return 'account';
  }
}

export function useClaudeAuth(binaryPath?: string): UseClaudeAuthResult {
  const [status, setStatus] = useState<ClaudeAuthStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeState] = useState<ClaudeAuthMode>('account');
  const [apiKey, setApiKey] = useState('');
  const [isolated, setIsolatedState] = useState(true);

  useEffect(() => {
    setModeState(readClaudeAuthMode());
    setIsolatedState(readClaudeIsolated());
    getSecret(CLAUDE_API_KEY_SECRET)
      .then(k => setApiKey(k ?? ''))
      .catch(() => setApiKey(''));
  }, []);

  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const raw = await invoke<string>('claude_auth_status', { binaryPath, isolated });
      const parsed = JSON.parse(raw) as ClaudeAuthStatus;
      setStatus(parsed);
    } catch (e) {
      setStatus(null);
      setError((e as Error)?.message ?? String(e));
    } finally {
      setChecking(false);
    }
  }, [binaryPath, isolated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setMode = useCallback((next: ClaudeAuthMode) => {
    setModeState(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Sem localStorage a escolha só não sobrevive ao restart.
    }
  }, []);

  const setIsolated = useCallback((value: boolean) => {
    setIsolatedState(value);
    try {
      localStorage.setItem(ISOLATED_KEY, String(value));
    } catch {
      // Sem localStorage a escolha so nao sobrevive ao restart.
    }
  }, []);

  const saveApiKey = useCallback(async (key: string) => {
    const trimmed = key.trim();
    await saveSecret(CLAUDE_API_KEY_SECRET, trimmed);
    setApiKey(trimmed);
  }, []);

  const clearApiKey = useCallback(async () => {
    await deleteSecret(CLAUDE_API_KEY_SECRET);
    setApiKey('');
  }, []);

  const login = useCallback(
    async (useConsole: boolean) => {
      setError(null);
      try {
        await invoke('claude_auth_login', { binaryPath, useConsole, isolated });
      } catch (e) {
        setError((e as Error)?.message ?? String(e));
      }
      // Sem refresh automático aqui: o login abre um terminal e só termina
      // quando o usuário completa o fluxo no navegador. Quem chama decide
      // quando reconsultar (a UI oferece um "check again").
    },
    [binaryPath, isolated]
  );

  const logout = useCallback(async () => {
    setError(null);
    try {
      await invoke('claude_auth_logout', { binaryPath, isolated });
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
    await refresh();
  }, [binaryPath, isolated, refresh]);

  const activeApiKey = mode === 'apiKey' && apiKey.trim() ? apiKey.trim() : null;
  // No modo chave, estar logado no CLI é irrelevante — e vice-versa. Sem essa
  // distinção o painel diria "sem credencial" com uma chave válida
  // configurada, só porque o `claude auth` está deslogado.
  const hasCredential = mode === 'apiKey' ? !!activeApiKey : !!status?.loggedIn;

  return {
    status,
    checking,
    error,
    mode,
    apiKey,
    activeApiKey,
    hasCredential,
    isolated,
    setIsolated,
    setMode,
    saveApiKey,
    clearApiKey,
    login,
    logout,
    refresh,
  };
}
