'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import type { Monaco } from '@monaco-editor/react';
import { useTheme } from './ThemeContext';
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes';

// Diff lado a lado do arquivo inteiro (antes × depois de um commit), com o
// mesmo editor de diff do VS Code. Complementa o resumo do CommitChangesView
// quando a pessoa quer ver o JSON completo.

const DiffEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.DiffEditor), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[12px] text-pm-text-muted">Loading editor...</div>
  ),
});

interface Props {
  title: string;
  subtitle?: string;
  before: string | null;
  after: string | null;
  onClose: () => void;
}

export function SideBySideDiff({ title, subtitle, before, after, onClose }: Props) {
  const { effectiveThemeId } = useTheme();
  // Em telas estreitas, inline (uma coluna) lê melhor que duas colunas
  // espremidas; o botão deixa trocar.
  const [inline, setInline] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[88vh] w-[1400px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-pm-border bg-pm-surface font-sans shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-pm-border px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-semibold text-pm-text">{title}</span>
            {subtitle && <span className="truncate text-[10.5px] text-pm-text-muted">{subtitle}</span>}
          </div>
          <button
            type="button"
            onClick={() => setInline((v) => !v)}
            className="h-7 shrink-0 cursor-pointer rounded-md border border-pm-border bg-pm-hover px-2.5 text-[11px] font-semibold text-pm-text transition-colors hover:bg-pm-row-active"
          >
            {inline ? 'Side by side' : 'Inline'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text"
          >
            ✕
          </button>
        </div>

        <div className="flex shrink-0 text-[10.5px] font-semibold uppercase tracking-wide">
          {inline ? (
            <div className="flex-1 border-b border-pm-border px-4 py-1.5 text-pm-text-muted">Changes</div>
          ) : (
            <>
              <div className="flex-1 border-b border-r border-pm-border px-4 py-1.5 text-rose-400">
                Before{before === null ? ' — file did not exist' : ''}
              </div>
              <div className="flex-1 border-b border-pm-border px-4 py-1.5 text-emerald-400">
                After{after === null ? ' — file was deleted' : ''}
              </div>
            </>
          )}
        </div>

        <div className="min-h-0 flex-1">
          <DiffEditor
            beforeMount={(monaco: Monaco) => registerDevflowMonacoThemes(monaco)}
            theme={getMonacoThemeName(effectiveThemeId)}
            language="json"
            original={before ?? ''}
            modified={after ?? ''}
            height="100%"
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: !inline,
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 12,
              fontFamily: 'Fira Code, Consolas, monospace',
              scrollBeyondLastLine: false,
              // Esconde os trechos iguais (dá pra expandir clicando) — em
              // collections grandes, o que mudou se perde no meio do resto.
              hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 },
              wordWrap: 'on',
              diffWordWrap: 'on',
            }}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
