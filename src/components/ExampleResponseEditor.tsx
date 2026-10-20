'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { Monaco } from '@monaco-editor/react';
import { Plus, Trash2, Play, Rows2, Columns2 } from 'lucide-react';
import { ExampleData } from '@/app/types/CollectionItem';
import { useTheme } from './ThemeContext';
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes';

// Resposta de um Saved Example, editável à mão — igual o Postman: dá pra
// documentar um 404 ou um 500 sem precisar provocar o erro na API. Só muda
// com edição explícita (ou "Update example" numa aba de Try); enviar a
// request nunca mexe aqui.

const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[12px] text-pm-text-muted">Loading editor...</div>
  ),
});

export const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const LANGUAGES = [
  { id: 'json', label: 'JSON' },
  { id: 'xml', label: 'XML' },
  { id: 'html', label: 'HTML' },
  { id: 'text', label: 'Text' },
] as const;

interface Props {
  draft: ExampleData;
  onChange: (draft: ExampleData) => void;
  onTry: () => void;
  responseLayout: 'bottom' | 'side';
  onLayoutChange: (layout: 'bottom' | 'side') => void;
}

export function ExampleResponseEditor({ draft, onChange, onTry, responseLayout, onLayoutChange }: Props) {
  const { effectiveThemeId } = useTheme();
  const [tab, setTab] = useState<'body' | 'headers'>('body');
  const language = draft.previewLanguage ?? 'json';
  const ok = draft.code >= 200 && draft.code < 300;

  const setCode = (raw: string) => {
    const code = Math.max(0, Math.min(999, Number(raw.replace(/\D/g, '')) || 0));
    // Troca o texto junto só se ele ainda era o padrão do código anterior —
    // texto personalizado ("Pedido duplicado") é preservado.
    const autoText = !draft.status || draft.status === STATUS_TEXT[draft.code];
    onChange({ ...draft, code, status: autoText ? STATUS_TEXT[code] ?? draft.status : draft.status });
  };

  const setHeader = (index: number, field: 'key' | 'value' | 'enabled', value: string | boolean) => {
    onChange({
      ...draft,
      headers: draft.headers.map((h, i) => (i === index ? { ...h, [field]: value } : h)),
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-pm-bg">
      {/* Cabeçalho: abas + status editável */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex items-center gap-0.5">
          <span className="mr-2 rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-300">
            Example response
          </span>
          {(['body', 'headers'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`h-7 cursor-pointer rounded-md px-2.5 text-[11px] font-medium capitalize transition-colors ${
                tab === t ? 'bg-pm-hover text-pm-text' : 'text-pm-text-muted hover:bg-pm-hover/40 hover:text-pm-text'
              }`}
            >
              {t}
              {t === 'headers' && draft.headers.length > 0 && (
                <span className="ml-1 text-pm-text-muted">{draft.headers.length}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <div
            className={`flex h-7 items-center overflow-hidden rounded-md border text-[11px] font-bold ${
              ok ? 'border-[#1a5c3d] bg-[#0f3d2a] text-[#4ff09d]' : 'border-[#5c2a2a] bg-[#3d1a1a] text-[#ff7b7b]'
            }`}
            title="Status of the saved response"
          >
            <input
              value={draft.code || ''}
              onChange={e => setCode(e.target.value)}
              inputMode="numeric"
              placeholder="200"
              aria-label="Status code"
              className="h-full w-11 bg-transparent px-1.5 text-center tabular-nums outline-none"
            />
            <input
              value={draft.status}
              onChange={e => onChange({ ...draft, status: e.target.value })}
              placeholder="OK"
              aria-label="Status text"
              className="h-full w-[150px] border-l border-current/20 bg-transparent px-1.5 font-semibold outline-none"
            />
          </div>

          {tab === 'body' && (
            <select
              value={language}
              onChange={e => onChange({ ...draft, previewLanguage: e.target.value })}
              title="Body format"
              className="h-7 cursor-pointer rounded-md border border-pm-border bg-pm-hover px-1.5 text-[11px] text-pm-text outline-none"
            >
              {LANGUAGES.map(l => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={onTry}
            title="Send this example's request in a new tab — the saved response is not changed"
            className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-pm-border bg-pm-hover px-2 text-[11px] font-medium text-pm-text transition-colors hover:bg-pm-row-active"
          >
            <Play size={11} />
            Try
          </button>

          <div className="mx-0.5 h-4 w-px bg-pm-hover" />
          <div className="flex items-center gap-0.5 rounded-md border border-pm-border bg-pm-bg p-0.5">
            <button
              type="button"
              onClick={() => onLayoutChange('bottom')}
              title="Response below"
              className={`cursor-pointer rounded p-1 transition-colors ${
                responseLayout === 'bottom' ? 'bg-pm-hover text-pm-text' : 'text-pm-text-muted hover:text-pm-text-secondary'
              }`}
            >
              <Rows2 size={12} />
            </button>
            <button
              type="button"
              onClick={() => onLayoutChange('side')}
              title="Response beside"
              className={`cursor-pointer rounded p-1 transition-colors ${
                responseLayout === 'side' ? 'bg-pm-hover text-pm-text' : 'text-pm-text-muted hover:text-pm-text-secondary'
              }`}
            >
              <Columns2 size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-2">
        {tab === 'body' ? (
          <Editor
            height="100%"
            language={language === 'text' ? 'plaintext' : language}
            theme={getMonacoThemeName(effectiveThemeId)}
            beforeMount={(monaco: Monaco) => registerDevflowMonacoThemes(monaco)}
            value={draft.body}
            onChange={value => onChange({ ...draft, body: value ?? '' })}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              padding: { top: 10 },
              wordWrap: 'on',
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="grid grid-cols-[28px_minmax(0,2fr)_minmax(0,3fr)_32px] border-l border-r border-t border-pm-border text-[12px]">
              {draft.headers.map((h, i) => (
                <div key={i} className="group contents">
                  <div className="flex items-center justify-center border-b border-r border-pm-border">
                    <input
                      type="checkbox"
                      checked={h.enabled !== false}
                      onChange={e => setHeader(i, 'enabled', e.target.checked)}
                      className="h-3.5 w-3.5 cursor-pointer accent-pm-accent"
                    />
                  </div>
                  <input
                    value={h.key}
                    onChange={e => setHeader(i, 'key', e.target.value)}
                    placeholder="key"
                    className="h-8 border-b border-r border-pm-border bg-pm-hover/40 px-2 font-mono text-pm-text outline-none placeholder:text-pm-text-muted focus:bg-pm-accent/[0.06]"
                  />
                  <input
                    value={h.value}
                    onChange={e => setHeader(i, 'value', e.target.value)}
                    placeholder="value"
                    className="h-8 border-b border-r border-pm-border bg-transparent px-2 font-mono text-pm-text outline-none placeholder:text-pm-text-muted focus:bg-pm-accent/[0.06]"
                  />
                  <button
                    type="button"
                    onClick={() => onChange({ ...draft, headers: draft.headers.filter((_, j) => j !== i) })}
                    title="Remove header"
                    className="flex cursor-pointer items-center justify-center border-b border-pm-border text-pm-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => onChange({ ...draft, headers: [...draft.headers, { key: '', value: '', enabled: true }] })}
              className="mt-2 flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text"
            >
              <Plus size={12} />
              Add header
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
