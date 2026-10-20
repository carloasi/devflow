'use client';

import { useState } from 'react';
import { FieldChange, FileChange, ItemChange } from '@/lib/commitDiff';
import { SideBySideDiff } from './SideBySideDiff';

// Painel "Changes" da janela de histórico de commits: o que o commit
// selecionado mudou em cada collection/environment do workspace.

const KIND_STYLE: Record<ItemChange['kind'], { label: string; className: string }> = {
  added: { label: 'Added', className: 'bg-emerald-500/15 text-emerald-400' },
  removed: { label: 'Removed', className: 'bg-rose-500/15 text-rose-400' },
  modified: { label: 'Changed', className: 'bg-amber-500/15 text-amber-400' },
};

const FILE_STATUS_LABEL: Record<FileChange['status'], string> = {
  added: 'new file',
  removed: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
};

const METHOD_COLOR: Record<string, string> = {
  GET: 'text-emerald-400',
  POST: 'text-amber-400',
  PUT: 'text-sky-400',
  PATCH: 'text-violet-400',
  DELETE: 'text-rose-400',
};

function FieldRow({ change }: { change: FieldChange }) {
  if (change.masked) {
    return (
      <div className="flex gap-2 text-[11px]">
        <span className="shrink-0 text-pm-text-muted">{change.field}</span>
        <span className="italic text-pm-text-muted">changed (hidden)</span>
      </div>
    );
  }

  if (change.lines) {
    return (
      <div className="flex flex-col gap-1 text-[11px]">
        <span className="text-pm-text-muted">{change.field}</span>
        <pre className="max-h-[240px] overflow-auto rounded-md border border-pm-border bg-pm-bg/60 py-1 font-mono text-[10.5px] leading-[1.45]">
          {change.lines.map((line, i) => (
            <div
              key={i}
              className={`whitespace-pre px-2 ${
                line.type === 'add'
                  ? 'bg-emerald-500/10 text-emerald-300'
                  : line.type === 'del'
                    ? 'bg-rose-500/10 text-rose-300'
                    : line.type === 'skip'
                      ? 'text-pm-text-muted/70 italic'
                      : 'text-pm-text-muted'
              }`}
            >
              {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : line.type === 'skip' ? '⋯ ' : '  '}
              {line.text}
            </div>
          ))}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
      <span className="shrink-0 text-pm-text-muted">{change.field}</span>
      {change.before !== undefined && (
        <span className="break-all font-mono text-rose-300 line-through decoration-rose-400/50">
          {change.before || '(empty)'}
        </span>
      )}
      {change.before !== undefined && change.after !== undefined && <span className="text-pm-text-muted">→</span>}
      {change.after !== undefined && (
        <span className="break-all font-mono text-emerald-300">{change.after || '(empty)'}</span>
      )}
    </div>
  );
}

function ItemRow({ change }: { change: ItemChange }) {
  const [open, setOpen] = useState(change.fields.length > 0 && change.fields.length <= 3);
  const style = KIND_STYLE[change.kind];
  const hasDetails = change.fields.length > 0;

  return (
    <div className="rounded-md border border-pm-border/60 bg-pm-bg/30">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        className={`flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left ${hasDetails ? 'cursor-pointer hover:bg-pm-hover/60' : 'cursor-default'}`}
      >
        <span className={`shrink-0 rounded px-1.5 text-[9px] font-bold uppercase tracking-wide ${style.className}`}>
          {style.label}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-pm-text-muted">{change.itemType}</span>
        {change.method && (
          <span className={`shrink-0 font-mono text-[10px] font-bold ${METHOD_COLOR[change.method] ?? 'text-pm-text-muted'}`}>
            {change.method}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-pm-text" title={change.path ? `${change.path} / ${change.name}` : change.name}>
          {change.path && <span className="text-pm-text-muted">{change.path} / </span>}
          {change.name}
        </span>
        {hasDetails && <span className="shrink-0 text-[10px] text-pm-text-muted">{open ? '▾' : '▸'}</span>}
      </button>

      {open && hasDetails && (
        <div className="flex flex-col gap-1.5 border-t border-pm-border/60 px-2.5 py-2">
          {change.fields.map((field, i) => (
            <FieldRow key={i} change={field} />
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  loading: boolean;
  error: string | null;
  files: FileChange[] | null;
  // Ex.: "6ec9cfb" — aparece no título do diff lado a lado.
  commitLabel?: string;
}

export function CommitChangesView({ loading, error, files, commitLabel }: Props) {
  const [diffFile, setDiffFile] = useState<FileChange | null>(null);

  if (loading) {
    return <div className="px-4 py-10 text-center text-[12px] text-pm-text-muted">Downloading and comparing files...</div>;
  }
  if (error) {
    return <div className="px-4 py-10 text-center text-[12px] text-rose-400">{error}</div>;
  }
  if (!files) {
    return <div className="px-4 py-10 text-center text-[12px] text-pm-text-muted">Select a commit to see what changed.</div>;
  }
  if (files.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-pm-text-muted">
        This commit didn&apos;t change any file in this workspace.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {files.map((file) => (
        <div key={file.file} className="flex flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#3c89e0]">{file.kind}</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-pm-text" title={file.file}>
              {file.title}
            </span>
            <span className="shrink-0 text-[10px] text-pm-text-muted">{FILE_STATUS_LABEL[file.status]}</span>
            {!file.error && (file.beforeText != null || file.afterText != null) && (
              <button
                type="button"
                onClick={() => setDiffFile(file)}
                title="Compare the whole file, before and after this commit"
                className="h-6 shrink-0 cursor-pointer rounded-md border border-pm-border bg-pm-hover px-2 text-[10.5px] font-semibold text-pm-text transition-colors hover:bg-pm-row-active"
              >
                Diff
              </button>
            )}
          </div>

          {file.error && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/5 px-2 py-1.5 text-[11px] text-rose-300">
              Could not read this file: {file.error}
            </div>
          )}

          {!file.error && file.changes.length === 0 && (
            <div className="px-1 text-[11px] italic text-pm-text-muted">
              File was re-saved with no content changes.
            </div>
          )}

          {file.changes.map((change, i) => (
            <ItemRow key={`${change.kind}-${change.path}-${change.name}-${i}`} change={change} />
          ))}
        </div>
      ))}

      {diffFile && (
        <SideBySideDiff
          title={diffFile.title}
          subtitle={`${diffFile.file}${commitLabel ? ` · commit ${commitLabel}` : ''}`}
          before={diffFile.beforeText ?? null}
          after={diffFile.afterText ?? null}
          onClose={() => setDiffFile(null)}
        />
      )}
    </div>
  );
}
