'use client';

import { useEffect, useState } from 'react';
import { Copy, Check, Trash2 } from 'lucide-react';
import {
  ErrorLogEntry,
  clearErrorLog,
  getErrorLog,
  subscribeErrorLog,
} from '@/lib/errorLog';
import { ErrorReportForm } from '../ErrorReportForm';

export function ErrorReportSettingsSection() {
  const [entries, setEntries] = useState<ErrorLogEntry[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const refresh = () => setEntries(getErrorLog());
    refresh();
    return subscribeErrorLog(refresh);
  }, []);

  const handleCopy = async () => {
    const text = entries
      .map((e) => `[${e.time}] (${e.source}) ${e.message}${e.stack ? `\n${e.stack}` : ''}`)
      .join('\n\n');
    await navigator.clipboard.writeText(text || '(empty)');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleClear = () => {
    clearErrorLog();
    setEntries([]);
  };

  const recent = entries.slice(-5).reverse();

  return (
    <div className="mt-5 pt-5 border-t border-pm-border">
      <h3 className="text-sm font-semibold text-pm-text mb-2">Report a problem</h3>
      <p className="text-xs text-pm-text-muted mb-3">
        Sends your description and the most recent errors from this app&apos;s error log for
        analysis. Tokens and passwords are masked before sending. Crashes are already sent
        automatically.
      </p>

      <ErrorReportForm />

      <div className="mt-4 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-pm-text-muted">
          Error log ({entries.length})
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            disabled={entries.length === 0}
            title="Copy the whole log"
            className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
            Copy
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={entries.length === 0}
            title="Clear the local error log"
            className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-pm-text-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 size={11} /> Clear
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-col gap-1">
        {recent.length === 0 ? (
          <div className="rounded-md border border-pm-border bg-pm-hover/60 px-2.5 py-2 text-[11px] text-pm-text-muted">
            No errors logged.
          </div>
        ) : (
          recent.map((e) => (
            <div
              key={e.id}
              className="rounded-md border border-pm-border bg-pm-hover/60 px-2.5 py-1.5"
              title={e.stack || e.message}
            >
              <div className="flex items-center gap-2 text-[10px] text-pm-text-muted">
                <span>{new Date(e.time).toLocaleString()}</span>
                <span className="rounded bg-pm-border/60 px-1 font-mono">{e.source}</span>
              </div>
              <div className="truncate font-mono text-[11px] text-red-400">{e.message}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
