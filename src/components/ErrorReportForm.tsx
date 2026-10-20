'use client';

import { useState } from 'react';
import { Send, Check, TriangleAlert } from 'lucide-react';
import { sendErrorReport, ErrorReportResult } from '@/lib/errorLog';

// Formulário de "Report a problem" — usado nas Settings e na tela de crash
// (app/error.tsx). Manda a descrição + as últimas entradas do log de erros.
export function ErrorReportForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ErrorReportResult | null>(null);

  const handleSend = async () => {
    setSending(true);
    setResult(null);
    const outcome = await sendErrorReport(description.trim());
    setResult(outcome);
    if (outcome.reportId) setDescription('');
    setSending(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus={autoFocus}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What were you doing when the problem happened? (optional)"
        rows={3}
        disabled={sending}
        className="w-full resize-y rounded-md border border-pm-border bg-pm-hover px-2 py-1.5 text-xs text-pm-text outline-none placeholder:text-pm-text-muted focus:border-[#007acc] disabled:opacity-50"
      />

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-pm-text-muted">
          {result?.reportId && (
            <span className="inline-flex items-center gap-1 text-emerald-400">
              <Check size={12} /> Report sent — reference: <b className="font-mono">{result.reportId}</b>
              {result.sent < result.total && (
                <span className="text-amber-400">({result.sent} of {result.total} entries)</span>
              )}
            </span>
          )}
          {result && !result.reportId && result.failure === 'not-recorded' && (
            <span className="inline-flex items-start gap-1 text-red-400">
              <TriangleAlert size={12} className="mt-[1px] shrink-0" />
              The report server answered but didn&apos;t save it — its Apps Script deployment is outdated. Ask the
              app admin to redeploy it.
            </span>
          )}
          {result && !result.reportId && result.failure !== 'not-recorded' && (
            <span className="inline-flex items-center gap-1 text-red-400">
              <TriangleAlert size={12} /> Couldn&apos;t send the report. Check your connection and try again.
            </span>
          )}
        </span>

        <button
          type="button"
          onClick={handleSend}
          disabled={sending}
          className="flex shrink-0 items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-semibold text-white bg-[#007acc] hover:bg-[#1a8ad4] transition-colors cursor-pointer disabled:opacity-50"
        >
          <Send size={12} /> {sending ? 'Sending...' : 'Send report'}
        </button>
      </div>
    </div>
  );
}
