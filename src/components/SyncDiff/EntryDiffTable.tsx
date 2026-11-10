'use client'

import { useState } from 'react'
import { Minus, Plus, Pencil, Eye, EyeOff } from 'lucide-react'
import {
  applyChoice,
  countChangedEntries,
  sideOf,
  type EntryRow,
  type KeyedEntry,
  type Side,
} from '@/lib/entryDiff'
import { isLikelySecretValue, maskValue } from '@/lib/secretScan'
import { useSyncDiffStrings } from '@/lib/i18n/syncDiffStrings'

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

function ValueLine({
  label,
  entry,
  tone,
  masked,
  onToggleMask,
}: {
  label: string
  entry: KeyedEntry
  tone: string
  masked: boolean
  onToggleMask?: () => void
}) {
  const t = useSyncDiffStrings()
  const text = entry.value || t.empty
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="w-11 shrink-0 text-[9px] uppercase tracking-wide text-pm-text-muted/70">
        {label}
      </span>
      <span className={`font-mono text-[10.5px] break-all ${tone}`}>
        {masked ? maskValue(text) : text}
      </span>
      {onToggleMask && (
        <button
          onClick={onToggleMask}
          title={masked ? t.showValue : t.hideValue}
          className="shrink-0 text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
        >
          {masked ? <Eye size={10} /> : <EyeOff size={10} />}
        </button>
      )}
      {entry.enabled === false && (
        <span
          title={t.disabledSide}
          className="shrink-0 rounded-sm bg-pm-border px-1 text-[8.5px] uppercase text-pm-text-muted"
        >
          {t.off}
        </span>
      )}
    </div>
  )
}

export function EntryDiffTable({ rows, entries, onEntriesChange }: Props) {
  const t = useSyncDiffStrings()
  const changed = countChangedEntries(rows)

  // Headers como Authorization/Cookie aparecem em texto puro nesta tabela
  // sempre que há diferença — bem mais frequente que o export, onde já
  // existe um scanner pra isso. Mascarado por padrão, com toggle por linha:
  // quem está mesclando de propósito ainda precisa poder ver pra decidir.
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const toggleRevealed = (id: string) => {
    setRevealed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const choose = (row: EntryRow, side: Side) => {
    if (!entries) return
    onEntriesChange(applyChoice(entries, row, side))
  }

  return (
    <div className="mb-1.5">
      <div className="mb-1 text-[9.5px] uppercase tracking-wide text-pm-text-muted/70">
        {t.entriesChanged(changed, rows.length)}
      </div>

      <div className="max-h-56 overflow-y-auto rounded border border-pm-border bg-pm-bg">
        {rows.map(row => {
          const mark = CHANGE_MARK[row.change]
          const sensitive =
            isLikelySecretValue(row.key, row.local?.value) || isLikelySecretValue(row.key, row.remote?.value)
          const isRevealed = revealed.has(row.id)
          const masked = sensitive && !isRevealed

          // `same` não ganha botões: não há escolha a fazer, e oferecê-la
          // transformaria a lista num campo minado de cliques sem efeito.
          if (!mark) {
            const text = row.remote?.value || row.local?.value || t.empty
            return (
              <div
                key={row.id}
                className="flex items-baseline gap-1.5 px-2 py-1 border-b border-pm-border/40 last:border-b-0"
              >
                <span className="w-3 shrink-0" />
                <span className="font-mono text-[10.5px] text-pm-text-muted shrink-0">{row.key}</span>
                <span className="font-mono text-[10.5px] text-pm-text-muted/60 truncate">
                  {masked ? maskValue(text) : text}
                </span>
                {sensitive && (
                  <button
                    onClick={() => toggleRevealed(row.id)}
                    title={masked ? t.showValue : t.hideValue}
                    className="shrink-0 text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                  >
                    {masked ? <Eye size={10} /> : <EyeOff size={10} />}
                  </button>
                )}
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
                    label={t.here}
                    active={side === 'local'}
                    disabled={!entries}
                    onClick={() => choose(row, 'local')}
                  />
                  <SideButton
                    label={t.github}
                    active={side === 'remote'}
                    disabled={!entries}
                    onClick={() => choose(row, 'remote')}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-0.5 pl-[15px]">
                {row.local ? (
                  <ValueLine
                    label={t.here}
                    entry={row.local}
                    tone="text-red-300/80"
                    masked={masked}
                    onToggleMask={sensitive ? () => toggleRevealed(row.id) : undefined}
                  />
                ) : (
                  <div className="text-[10px] text-pm-text-muted/60">{t.notHere}</div>
                )}
                {row.remote ? (
                  <ValueLine
                    label={t.github}
                    entry={row.remote}
                    tone="text-[#4ff09d]/80"
                    masked={masked}
                    onToggleMask={sensitive ? () => toggleRevealed(row.id) : undefined}
                  />
                ) : (
                  <div className="text-[10px] text-pm-text-muted/60">{t.goneOnGithub}</div>
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
  const t = useSyncDiffStrings()
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? t.fixJsonToChoose : t.keepSide(label)}
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
