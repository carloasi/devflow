'use client';

import { useState } from 'react';
import { CloudDownload, TriangleAlert } from 'lucide-react';
import { useSyncDiffStrings } from '@/lib/i18n/syncDiffStrings';

// ─────────────────────────────────────────────────────────────────────────
// Configurações → Avançado: ações raras e destrutivas, longe do dia a dia.
//
// "Baixar tudo e substituir" era um link no painel do GitHub, ao lado do
// Pull e do Push — fácil de clicar achando que era o pull normal. Ele troca
// os workspaces daqui pelos do repositório SEM revisão nem mescla; o fluxo
// normal é a Central de Sincronização.
// ─────────────────────────────────────────────────────────────────────────

interface Props {
  /** Ausente = GitHub sync não configurado. */
  onReplaceAllFromGitHub?: () => Promise<void>;
}

export function AdvancedSettingsSection({ onReplaceAllFromGitHub }: Props) {
  const t = useSyncDiffStrings();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);

  const replaceAll = async () => {
    if (!onReplaceAllFromGitHub) return;
    setRunning(true);
    try {
      await onReplaceAllFromGitHub();
    } finally {
      setRunning(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-rose-300/90">{t.scDangerTitle}</div>
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3.5 flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-pm-text">
          <CloudDownload size={15} className="text-rose-300" />
          {t.scReplaceAllTitle}
        </div>
        <p className="text-[12px] leading-relaxed text-pm-text-secondary">{t.scReplaceAllBody}</p>

        {!onReplaceAllFromGitHub ? (
          <p className="text-[11.5px] text-pm-text-muted">{t.scReplaceAllUnavailable}</p>
        ) : confirming ? (
          <div className="flex flex-col gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-2.5">
            <span className="flex items-start gap-1.5 text-[12px] text-rose-200">
              <TriangleAlert size={14} className="mt-px shrink-0" />
              {t.scReplaceAllConfirm}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={running}
                className="h-7 px-3 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:bg-pm-hover disabled:opacity-40 cursor-pointer"
              >
                {t.scCancel}
              </button>
              <button
                type="button"
                onClick={() => void replaceAll()}
                disabled={running}
                className="h-7 px-3 rounded-md text-xs font-semibold text-white bg-rose-600 hover:bg-rose-600/90 disabled:opacity-50 cursor-pointer"
              >
                {running ? t.scRunning : t.scReplaceAllConfirmButton}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="self-start h-7 px-3 rounded-md text-xs font-semibold border border-rose-500/50 text-rose-300 hover:bg-rose-500/15 cursor-pointer"
          >
            {t.scReplaceAllButton}
          </button>
        )}
      </div>
    </div>
  );
}
