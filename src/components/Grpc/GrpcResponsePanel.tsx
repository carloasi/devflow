'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import type { Monaco } from '@monaco-editor/react';
import { toast } from 'sonner';
import { Copy, Rows2, Columns2, Radio, ArrowUp, ArrowDown } from 'lucide-react';
import { GrpcCallResult, GrpcStreamState } from '@/app/types/Grpc';
import { GrpcStreamTimeline } from './GrpcStreamTimeline';
import { useTheme } from '@/components/ThemeContext';
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes';

// Resposta de uma chamada gRPC unária: status do gRPC (não o HTTP — o erro
// vem nos trailers com HTTP 200), mensagem em JSON e metadata.

const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[12px] text-pm-text-muted">Loading editor...</div>
  ),
});

interface Props {
  result: GrpcCallResult | null | undefined;
  // Último stream da aba — quando existe, o painel mostra a linha do tempo.
  stream: GrpcStreamState | null | undefined;
  // Falha antes de chegar ao servidor (conexão, schema, JSON inválido).
  error: string | null | undefined;
  isInvoking: boolean;
  responseLayout: 'bottom' | 'side';
  onLayoutChange: (layout: 'bottom' | 'side') => void;
}

export function GrpcResponsePanel({ result, stream, error, isInvoking, responseLayout, onLayoutChange }: Props) {
  const { effectiveThemeId } = useTheme();
  const [tab, setTab] = useState<'response' | 'metadata'>('response');
  const ok = result?.statusCode === 0;

  // Resumo do stream pro cabeçalho.
  const streamFinal = stream?.events.find(e => e.kind === 'end' || e.kind === 'error');
  const sentCount = stream?.events.filter(e => e.kind === 'sent').length ?? 0;
  const receivedCount = stream?.events.filter(e => e.kind === 'message').length ?? 0;
  const lastElapsed = stream?.events.length ? stream.events[stream.events.length - 1].elapsedMs : 0;

  const copyResponse = async () => {
    if (!result?.response) return;
    try {
      await navigator.clipboard.writeText(result.response);
      toast.success('Response copied');
    } catch {
      toast.error("Couldn't copy the response");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-pm-bg">
      <div className="relative flex h-10 shrink-0 items-center justify-between overflow-hidden px-3">
        {isInvoking && !stream?.active && (
          <div className="absolute left-0 top-0 h-[2px] w-full overflow-hidden">
            <div className="devflow-loader" />
          </div>
        )}
        <div className="flex items-center gap-0.5">
          {(['response', 'metadata'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`h-7 cursor-pointer rounded-md px-2.5 text-[11px] font-medium capitalize transition-colors ${
                tab === t ? 'bg-pm-hover text-pm-text' : 'text-pm-text-muted hover:bg-pm-hover/40 hover:text-pm-text'
              }`}
            >
              {t}
              {t === 'metadata' && result && result.metadata.length > 0 && (
                <span className="ml-1 text-pm-text-muted">{result.metadata.length}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          {stream && (
            <>
              <span className="flex h-6 items-center gap-1.5 rounded-md border border-pm-border bg-pm-hover/50 px-2 text-[11px] font-semibold tabular-nums text-pm-text-secondary">
                <ArrowUp size={11} className="text-sky-300" />
                {sentCount}
                <ArrowDown size={11} className="text-emerald-300" />
                {receivedCount}
              </span>
              {stream.active ? (
                <span className="flex h-6 items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 text-[11px] font-bold text-emerald-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                  STREAMING
                </span>
              ) : streamFinal ? (
                <span
                  className={`flex h-6 items-center rounded-md border px-2 text-[11px] font-bold tracking-wide ${
                    streamFinal.statusCode === 0
                      ? 'border-[#1a5c3d] bg-[#0f3d2a] text-[#4ff09d]'
                      : 'border-[#5c2a2a] bg-[#3d1a1a] text-[#ff7b7b]'
                  }`}
                >
                  {streamFinal.statusCode} {streamFinal.statusName}
                </span>
              ) : (
                <span className="flex h-6 items-center rounded-md border border-pm-border px-2 text-[11px] font-bold text-pm-text-muted">
                  CANCELLED
                </span>
              )}
              <span className="flex h-6 items-center rounded-md border border-pm-border bg-pm-hover/50 px-2 text-[11px] font-semibold tabular-nums text-pm-text-secondary">
                {lastElapsed} ms
              </span>
            </>
          )}
          {!stream && result && !isInvoking && (
            <>
              <span
                className={`flex h-6 items-center rounded-md border px-2 text-[11px] font-bold tracking-wide ${
                  ok ? 'border-[#1a5c3d] bg-[#0f3d2a] text-[#4ff09d]' : 'border-[#5c2a2a] bg-[#3d1a1a] text-[#ff7b7b]'
                }`}
                title={`gRPC status ${result.statusCode}`}
              >
                {result.statusCode} {result.statusName}
              </span>
              <span className="flex h-6 items-center rounded-md border border-pm-border bg-pm-hover/50 px-2 text-[11px] font-semibold tabular-nums text-pm-text-secondary">
                {result.timeMs} ms
              </span>
              {result.response && (
                <button
                  type="button"
                  onClick={copyResponse}
                  title="Copy response"
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text"
                >
                  <Copy size={13} />
                </button>
              )}
            </>
          )}
          <div className="mx-1 h-4 w-px bg-pm-hover" />
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
        {stream && !(error && !isInvoking) ? (
          <GrpcStreamTimeline stream={stream} tab={tab} />
        ) : error && !isInvoking ? (
          <div className="m-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-[12px] text-red-300">
            <div className="mb-1 font-semibold">The call did not reach the server</div>
            <div className="whitespace-pre-wrap break-words font-mono text-[11px]">{error}</div>
          </div>
        ) : !result ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-pm-text-muted">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-pm-hover/50">
              <Radio size={22} className="opacity-40" />
            </div>
            <div className="text-center">
              <p className="text-xs font-medium">{isInvoking ? 'Waiting for the server…' : 'No response yet'}</p>
              {!isInvoking && <p className="mt-0.5 text-[11px]">Press Invoke to call the method</p>}
            </div>
          </div>
        ) : tab === 'response' ? (
          result.response !== null ? (
            <Editor
              height="100%"
              language="json"
              theme={getMonacoThemeName(effectiveThemeId)}
              beforeMount={(monaco: Monaco) => registerDevflowMonacoThemes(monaco)}
              value={result.response}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                padding: { top: 10 },
                wordWrap: 'on',
                automaticLayout: true,
                scrollBeyondLastLine: false,
              }}
            />
          ) : (
            <div className="m-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-[12px] text-red-300">
              <div className="mb-1 font-semibold">
                {result.statusName}
                {result.statusMessage ? ':' : ''}
              </div>
              {result.statusMessage && (
                <div className="whitespace-pre-wrap break-words font-mono text-[11px]">{result.statusMessage}</div>
              )}
            </div>
          )
        ) : result.metadata.length > 0 ? (
          <div className="h-full overflow-y-auto">
            <table className="w-full border-collapse font-mono text-[12px]">
              <tbody>
                {result.metadata.map(([key, value], i) => (
                  <tr key={`${key}-${i}`} className="border-b border-pm-border/70 transition-colors hover:bg-pm-hover/30">
                    <td className="w-2/5 px-4 py-2 align-top font-semibold text-pm-text-muted">{key}</td>
                    <td className="break-all px-4 py-2 text-[#4ff09d]">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-pm-text-muted">No metadata returned</div>
        )}
      </div>
    </div>
  );
}
