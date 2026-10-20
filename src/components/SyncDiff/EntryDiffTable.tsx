'use client'

import { Minus, Plus, Pencil } from 'lucide-react'
import {
  applyChoice,
  countChangedEntries,
  sideOf,
  type EntryRow,
  type KeyedEntry,
  type Side,
} from '@/lib/entryDiff'

// ─────────────────────────────────────────────────────────────────────────
// Headers e variáveis, entrada a entrada.
//
// Substitui os dois blocos de JSON lado a lado nesses campos. O que se quer
// saber é "qual header mudou", e isso some quando a resposta é procurar a
// diferença a olho em dois arrays quase idênticos.
//
// Os botões por linha escrevem na MESMA caixa de resultado que já existia —
// não há um segundo estado de edição. Quem preferir mexer no JSON à mão
// continua podendo, e a tela só deixa de marcar o lado quando o que está lá
// não é nenhum dos dois.
// ─────────────────────────────────────────────────────────────────────────

const CHANGE_MARK: Record<EntryRow['change'], { color: string; Icon: typeof Plus } | null> = {
  added: { color: 'text-[#4ff09d]', Icon: Plus },
  removed: { color: 'text-[#ff7b7b]', Icon: Minus },
  changed: { color: 'text-amber-400', Icon: Pencil },
  same: null,
}

interface Props {
  rows: EntryRow[]
  /**
   * Lista que está na caixa de resultado, ou `null` quando o texto de lá não
   * é uma lista válida — JSON pela metade enquanto se digita, por exemplo.
   * Sem ela a tabela ainda compara; só não dá pra escolher por linha.
   */
  entries: KeyedEntry[] | null
  onEntriesChange: (next: KeyedEntry[]) => void
}

function ValueLine({ label, entry, tone }: { label: string; entry: KeyedEntry; tone: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="w-11 shrink-0 text-[9px] uppercase tracking-wide text-pm-text-muted/70">
        {label}
      </span>
      <span className={`font-mono text-[10.5px] break-all ${tone}`}>
        {entry.value || '(empty)'}
      </span>
      {entry.enabled === false && (
        <span
          title="Disabled on this side"
          className="shrink-0 rounded-sm bg-pm-border px-1 text-[8.5px] uppercase text-pm-text-muted"
        >
          off
        </span>
      )}
    </div>
  )
}

export function EntryDiffTable({ rows, entries, onEntriesChange }: Props) {
  const changed = countChangedEntries(rows)

  const choose = (row: EntryRow, side: Side) => {
    if (!entries) return
    onEntriesChange(applyChoice(entries, row, side))
  }

  return (
    <div className="mb-1.5">
      <div className="mb-1 text-[9.5px] uppercase tracking-wide text-pm-text-muted/70">
        {changed} of {rows.length} {rows.length === 1 ? 'entry' : 'entries'} changed
      </div>

      <div className="max-h-56 overflow-y-auto rounded border border-pm-border bg-pm-bg">
        {rows.map(row => {
          const mark = CHANGE_MARK[row.change]
          // `same` não ganha botões: não há escolha a fazer, e oferecê-la
          // transformaria a lista num campo minado de cliques sem efeito.
          if (!mark) {
            return (
              <div
                key={row.id}
                className="flex items-baseline gap-1.5 px-2 py-1 border-b border-pm-border/40 last:border-b-0"
              >
                <span className="w-3 shrink-0" />
                <span className="font-mono text-[10.5px] text-pm-text-muted shrink-0">{row.key}</span>
                <span className="font-mono text-[10.5px] text-pm-text-muted/60 truncate">
                  {row.remote?.value || row.local?.value || '(empty)'}
                </span>
              </div>
            )
          }

          const side = entries ? sideOf(entries, row) : null

          return (
            <div key={row.id} className="px-2 py-1.5 border-b border-pm-border/40 last:border-b-0">
              <div className="flex items-center gap-1.5 mb-1">
                <mark.Icon size={10} className={`${mark.color} shrink-0`} />
                <span className="font-mono text-[10.5px] font-semibold text-pm-text truncate flex-1">
                  {row.key}
                </span>

                <div className="flex items-center gap-0.5 shrink-0">
                  <SideButton
                    label="Here"
                    active={side === 'local'}
                    disabled={!entries}
                    onClick={() => choose(row, 'local')}
                  />
                  <SideButton
                    label="GitHub"
                    active={side === 'remote'}
                    disabled={!entries}
                    onClick={() => choose(row, 'remote')}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-0.5 pl-[15px]">
                {row.local ? (
                  <ValueLine label="Here" entry={row.local} tone="text-red-300/80" />
                ) : (
                  <div className="text-[10px] text-pm-text-muted/60">Not here</div>
                )}
                {row.remote ? (
                  <ValueLine label="GitHub" entry={row.remote} tone="text-[#4ff09d]/80" />
                ) : (
                  <div className="text-[10px] text-pm-text-muted/60">Gone on GitHub</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SideButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string
  active: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Fix the JSON below to choose per entry' : `Keep the ${label} version`}
      className={`rounded px-1.5 py-0.5 text-[9.5px] border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? 'border-[#63b3ed]/60 bg-[#63b3ed]/15 text-[#63b3ed]'
          : 'border-transparent bg-transparent text-pm-text-muted hover:bg-pm-hover hover:text-pm-text'
      }`}
    >
      {label}
    </button>
  )
}
