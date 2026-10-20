'use client';

import { useState } from 'react';
import { Trash2, X, Check, TriangleAlert } from 'lucide-react';
import { clearAllLoadTestHistory } from '../LoadTest/loadTestHistory';
import { clearAllResponseHistory } from '@/storage/responseHistoryStore';
import { resetAppToFactoryDefaults } from '@/lib/factoryReset';

export function DataSettingsSection() {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [done, setDone] = useState(false);

  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');

  const handleClearAll = async () => {
    setClearing(true);
    try {
      // Response history (localStorage) nunca lança, mas load test history
      // passa pelo backend Rust — se ela falhar, ainda queremos ter limpo o
      // que já foi possível.
      clearAllResponseHistory();
      await clearAllLoadTestHistory();
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch (err) {
      console.error('Erro ao limpar histórico:', err);
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  };

  // Reseta o app inteiro pro estado de instalação nova: apaga workspaces,
  // coleções, environments, config/token do GitHub e preferências de UI.
  // Recarrega a janela no final pra já mostrar o app "zerado" — não dá pra
  // simplesmente resetar o estado em memória porque ele foi hidratado uma
  // vez no mount e tem efeitos que reagem a mudanças, não a um reset externo.
  const handleResetEverything = async () => {
    setResetting(true);
    try {
      await resetAppToFactoryDefaults();
      window.location.reload();
    } catch (err) {
      console.error('Erro ao resetar o app:', err);
      setResetting(false);
      setConfirmingReset(false);
      setResetConfirmText('');
    }
  };

  const resetConfirmed = resetConfirmText.trim().toUpperCase() === 'RESET';

  return (
    <div className="mt-5 pt-5 border-t border-pm-border">
      <h3 className="text-sm font-semibold text-pm-text mb-2">Data</h3>

      <div className="flex items-center justify-between py-3">
        <div className="flex-1 pr-4">
          <p className="text-sm font-medium text-pm-text">Clear all history</p>
          <p className="text-xs text-pm-text-muted mt-0.5">
            Removes saved response history and load test history for every request. This can&apos;t be undone.
          </p>
        </div>

        {confirming ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={clearing}
              className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs font-medium text-pm-text-secondary border border-pm-border hover:bg-pm-hover transition-colors cursor-pointer disabled:opacity-50"
            >
              <X size={12} /> Cancel
            </button>
            <button
              type="button"
              onClick={handleClearAll}
              disabled={clearing}
              className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs font-semibold text-white bg-red-600 hover:bg-red-500 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Trash2 size={12} /> {clearing ? 'Clearing...' : 'Confirm'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-red-500 border border-red-900/60 hover:bg-red-500/10 transition-colors cursor-pointer shrink-0"
          >
            {done ? <Check size={12} /> : <Trash2 size={12} />}
            {done ? 'Cleared' : 'Clear all history'}
          </button>
        )}
      </div>

      <div className="flex items-center justify-between py-3 border-t border-pm-border/60 mt-1">
        <div className="flex-1 pr-4">
          <p className="text-sm font-medium text-pm-text">Reset everything</p>
          <p className="text-xs text-pm-text-muted mt-0.5">
            Erases every workspace, collection, environment, GitHub sync connection and app
            preference — the app goes back to exactly how it was on first install. This can&apos;t be undone.
          </p>
        </div>

        {confirmingReset ? null : (
          <button
            type="button"
            onClick={() => setConfirmingReset(true)}
            className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-red-500 border border-red-900/60 hover:bg-red-500/10 transition-colors cursor-pointer shrink-0"
          >
            <TriangleAlert size={12} />
            Reset everything
          </button>
        )}
      </div>

      {confirmingReset && (
        <div className="mb-1 rounded-md border border-red-900/60 bg-red-500/5 p-3">
          <p className="text-xs text-pm-text-muted mb-2">
            This will permanently delete all local workspaces, collections, environments, the
            GitHub sync connection and every app preference. Type <b className="text-pm-text">RESET</b> to confirm.
          </p>
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              type="text"
              value={resetConfirmText}
              onChange={(e) => setResetConfirmText(e.target.value)}
              placeholder="RESET"
              disabled={resetting}
              className="flex-1 min-w-0 h-7 px-2 rounded-md bg-pm-hover border border-pm-border text-pm-text text-xs outline-none focus:border-red-500 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => {
                setConfirmingReset(false);
                setResetConfirmText('');
              }}
              disabled={resetting}
              className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs font-medium text-pm-text-secondary border border-pm-border hover:bg-pm-hover transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            >
              <X size={12} /> Cancel
            </button>
            <button
              type="button"
              onClick={handleResetEverything}
              disabled={resetting || !resetConfirmed}
              className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs font-semibold text-white bg-red-600 hover:bg-red-500 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              <Trash2 size={12} /> {resetting ? 'Resetting...' : 'Confirm'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
