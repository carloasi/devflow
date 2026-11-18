'use client'

import { useMemo } from 'react'
import { collapseUnchanged, diffLines, type DiffLine } from '@/lib/textDiff'

// Diff de um campo na revisão do GitHub: linhas que saíram em vermelho, que
// entraram em verde, o trecho que mudou dentro da linha destacado, e os
// trechos longos sem mudança recolhidos (ver lib/textDiff).

interface Props {
  before: string
  after: string
  /** Rótulo do lado que sai e do que entra — "Last sync"/"GitHub", etc. */
  beforeLabel: string
  afterLabel: string
  emptyText: string
  collapsedText: (count: number) => string
  /**
   * O item inteiro é novo ou apagado (um lado vazio = não existe): mostra só
   * o lado que existe, sem a linha "−"/"+" vazia nem o rótulo do outro. Fora
   * disso, vazio é um valor (variável esvaziada) e os dois lados aparecem.
   */
  hideEmptySide?: boolean
}

function LineText({ line }: { line: DiffLine }) {
  if (!line.segments) return <>{line.text || ' '}</>
  return (
    <>
      {line.segments.map((segment, i) =>
        segment.changed ? (
          <mark
            key={i}
            className={`rounded-sm px-px text-inherit ${line.type === 'del' ? 'bg-rose-500/35' : 'bg-emerald-400/30'}`}
          >
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        )
      )}
    </>
  )
}

export function TextDiffView({ before, after, beforeLabel, afterLabel, emptyText, collapsedText, hideEmptySide }: Props) {
  const hideBefore = !!hideEmptySide && before === ''
  const hideAfter = !!hideEmptySide && after === ''
  const rows = useMemo(() => {
    const lines = diffLines(before, after).filter(
      line => !(hideBefore && line.type === 'del') && !(hideAfter && line.type === 'add')
    )
    return collapseUnchanged(lines)
  }, [before, after, hideBefore, hideAfter])

  if (before === after) {
    return <p className="text-[10px] italic text-pm-text-muted/70">{emptyText}</p>
  }

  return (
    <div>
      <div className="mb-0.5 flex items-center gap-3 text-[9px] uppercase tracking-wide text-pm-text-muted/70">
        {!hideBefore && <span className="text-rose-300/80">− {beforeLabel}</span>}
        {!hideAfter && <span className="text-emerald-300/80">+ {afterLabel}</span>}
      </div>
      <div className="max-h-56 overflow-auto rounded border border-pm-border bg-pm-bg font-mono text-[10.5px] leading-[1.45]">
        {rows.map((row, i) =>
          'count' in row ? (
            <div key={i} className="px-2 py-0.5 text-[9.5px] italic text-pm-text-muted/60 bg-pm-hover/30">
              {collapsedText(row.count)}
            </div>
          ) : (
            <div
              key={i}
              className={`flex whitespace-pre-wrap break-all ${
                row.type === 'del'
                  ? 'bg-rose-500/10 text-rose-200'
                  : row.type === 'add'
                    ? 'bg-emerald-500/10 text-emerald-200'
                    : 'text-pm-text-muted'
              }`}
            >
              <span className="w-4 shrink-0 select-none text-center opacity-60">
                {row.type === 'del' ? '−' : row.type === 'add' ? '+' : ' '}
              </span>
              <span className="min-w-0 flex-1 pr-2">
                <LineText line={row} />
              </span>
            </div>
          )
        )}
      </div>
    </div>
  )
}
