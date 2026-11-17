'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Mesmo default do backend (RequestTimeoutState em lib.rs) — só usado aqui
// pra pré-preencher o campo antes do valor real chegar do backend, e como
// fallback ao digitar algo inválido.
const DEFAULT_TIMEOUT_MS = 30000;

export function NetworkSettingsSection() {
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_TIMEOUT_MS);
  const [inputValue, setInputValue] = useState(String(DEFAULT_TIMEOUT_MS));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    invoke<number>('get_request_timeout_ms')
      .then((ms) => {
        setTimeoutMs(ms);
        // Se estiver em "sem timeout" (0), deixa o campo numérico já
        // pré-preenchido com um valor razoável pra quando o usuário
        // desmarcar "No timeout" — em vez de mostrar 0 ali.
        setInputValue(ms > 0 ? String(ms) : String(DEFAULT_TIMEOUT_MS));
      })
      .catch((err) => console.error('Erro ao carregar timeout:', err))
      .finally(() => setLoading(false));
  }, []);

  const commit = async (nextMs: number) => {
    const clamped = Math.max(0, Math.round(nextMs));
    const previous = timeoutMs;
    setTimeoutMs(clamped);
    setSaving(true);

    try {
      await invoke('set_request_timeout_ms', { value: clamped });
    } catch (err) {
      console.error('Erro ao salvar timeout:', err);
      setTimeoutMs(previous); // rollback
    } finally {
      setSaving(false);
    }
  };

  const isNoTimeout = timeoutMs === 0;

  if (loading) {
    return <div className="text-sm text-pm-text-muted py-3">Loading...</div>;
  }

  return (
    <div className="mt-5 pt-5 border-t border-pm-border">
      <h3 className="text-sm font-semibold text-pm-text mb-2">Network</h3>

      <div className="py-3">
        <p className="text-sm font-medium text-pm-text">Request timeout</p>
        <p className="text-xs text-pm-text-muted mt-0.5 mb-2.5">
          If a request takes longer than this to respond, it&apos;s cancelled and shown as a timeout error.
        </p>

        <div className="flex items-center gap-3">
          <div className="relative">
            <input
              type="number"
              min={0}
              step={500}
              value={inputValue}
              disabled={isNoTimeout || saving}
              onChange={(e) => setInputValue(e.target.value)}
              onBlur={() => {
                const parsed = Number(inputValue);
                const next = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
                setInputValue(String(next));
                if (next !== timeoutMs) commit(next);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="h-8 w-28 rounded-md border border-pm-border bg-pm-hover px-2.5 pr-8 text-sm text-pm-text outline-none focus:border-pm-accent/50 disabled:opacity-40 disabled:cursor-not-allowed"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-pm-text-muted">
              ms
            </span>
          </div>

          <label className="flex items-center gap-1.5 text-xs text-pm-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isNoTimeout}
              disabled={saving}
              onChange={(e) => {
                if (e.target.checked) {
                  commit(0);
                } else {
                  const restored = Number(inputValue) || DEFAULT_TIMEOUT_MS;
                  setInputValue(String(restored));
                  commit(restored);
                }
              }}
              className="rounded accent-pm-accent"
            />
            No timeout
          </label>
        </div>
      </div>

      <div className="py-3 border-t border-pm-border">
        <p className="text-sm font-medium text-pm-text">Cookies</p>
        <p className="text-xs text-pm-text-muted mt-0.5 mb-2.5">
          Cookies returned by the APIs you call are stored and sent back automatically,
          per domain, like a browser does. They live only while the app is open, and are
          not synced to GitHub.
        </p>

        <button
          type="button"
          onClick={async () => {
            setClearing(true);
            try {
              await invoke('clear_cookies');
              setCleared(true);
              setTimeout(() => setCleared(false), 2000);
            } catch (err) {
              console.error('Erro ao limpar cookies:', err);
            } finally {
              setClearing(false);
            }
          }}
          disabled={clearing}
          className="h-8 rounded-md border border-pm-border bg-pm-hover px-3 text-xs text-pm-text-secondary transition-colors hover:text-pm-text hover:bg-pm-row-active disabled:opacity-40 cursor-pointer"
        >
          {cleared ? 'Cookies cleared' : clearing ? 'Clearing...' : 'Clear all cookies'}
        </button>
      </div>
    </div>
  );
}
