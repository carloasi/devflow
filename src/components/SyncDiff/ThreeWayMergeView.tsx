'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, PencilLine, Undo2 } from 'lucide-react'
import {
  chunkResult,
  composeForEditing,
  composeMerge,
  conflictMarkerCount,
  pickConflicts,
  type ChunkPick,
  type MergeChunk,
} from '@/lib/sync/mergeChunks'
import { useSyncDiffStrings } from '@/lib/i18n/syncDiffStrings'
import { useSplitRatio } from '@/components/helper/useSplitRatio'

// ─────────────────────────────────────────────────────────────────────────
// Editor de merge de um campo de texto, no layout do merge do Visual Studio:
//
//   ┌ GitHub (incoming) ─────┬ Sua versão (current) ──┐
//   │ ☑ trecho que mudou lá  │ ☐ trecho que mudou aqui │
//   ├ Resultado ─────────────┴────────────────────────┤
//   │ o que vai ser salvo, colorido pela origem       │
//
// Cada trecho alterado tem uma caixinha do lado que o mudou; o resultado é
// montado a partir delas (lib/sync/mergeChunks). Os dois painéis de cima
// andam juntos linha a linha (uma grade só, então linhas que quebram não
// desalinham). Dá pra sair das caixinhas e editar o resultado à mão.
// ─────────────────────────────────────────────────────────────────────────

interface Props {
  chunks: MergeChunk[]
  /** Marcas atuais; `null` = o resultado foi editado à mão. */
  picks: ChunkPick[] | null
  /** Texto do resultado quando editado à mão. */
  manualText: string
  /** Sem a versão da última sincronização: toda diferença é conflito. */
  twoWay: boolean
  /** Só leitura (item em Minha sem poder virar Merge). */
  readOnly: boolean
  /** A sua versão usa CRLF — o resultado sai igual. */
  crlf: boolean
  onPicks: (picks: ChunkPick[]) => void
  onManualText: (text: string) => void
  onBackToBoxes: () => void
  /**
   * Simulação (janela de diferença dos avisos de merge): as caixinhas mudam
   * só o que se vê no Resultado — nada é aplicado daqui.
   */
  simulation?: boolean
  /**
   * Texto com que a edição à mão começa, quando não é o que as caixinhas
   * montaram. Na simulação os trechos são a PRÉVIA (segredo mascarado, texto
   * longo cortado) e editar a partir deles gravaria a máscara; quem chama
   * monta o texto real. Na simulação, sem isto não há edição à mão.
   */
  manualSeed?: () => string
  /** Nota sob a caixa editada à mão, no lugar da padrão. */
  manualNote?: string
}

const NONE: ChunkPick = { theirs: false, mine: false }

/** Trechos estáveis seguidos com mais linhas que isto são recolhidos. */
const COLLAPSE_OVER = 8
const CONTEXT = 3

// Cores por origem — as mesmas da tela: GitHub verde, você azul, conflito âmbar.
const TONE = {
  theirs: 'bg-[#4ff09d]/10',
  mine: 'bg-[#007acc]/20',
  conflict: 'bg-amber-500/15',
  same: 'bg-pm-hover/60',
}

type Block =
  | { type: 'chunk'; index: number }
  | { type: 'stable'; indexes: number[]; key: number }

/** Junta os trechos estáveis seguidos, pra poder recolher os longos. */
function blocksOf(chunks: MergeChunk[]): Block[] {
  const out: Block[] = []
  chunks.forEach((chunk, index) => {
    const last = out[out.length - 1]
    if (chunk.kind !== 'stable') out.push({ type: 'chunk', index })
    else if (last?.type === 'stable') last.indexes.push(index)
    else out.push({ type: 'stable', indexes: [index], key: index })
  })
  return out
}

function Line({ n, text, tone = '', gutter }: { n?: number; text?: string; tone?: string; gutter?: React.ReactNode }) {
  return (
    <div className={`flex min-h-[17px] ${tone}`}>
      <span className="w-5 shrink-0 flex items-start justify-center pt-[2px]">{gutter}</span>
      <span className="w-8 shrink-0 pr-1.5 text-right text-pm-text-muted/60 select-none">{n ?? ''}</span>
      <span className="min-w-0 flex-1 pr-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{text ?? ''}</span>
    </div>
  )
}

export function ThreeWayMergeView({
  chunks, picks, manualText, twoWay, readOnly, crlf, onPicks, onManualText, onBackToBoxes,
  simulation = false, manualSeed, manualNote,
}: Props) {
  const t = useSyncDiffStrings()
  // Largura de cada coluna (GitHub | sua versão), guardada entre aberturas.
  const split = useSplitRatio('devflow_merge_columns', 0.5, { minLeft: 140, minRight: 140 })
  const columns = { gridTemplateColumns: `minmax(0, ${split.ratio}fr) minmax(0, ${1 - split.ratio}fr)` }
  const manual = picks === null
  const current = picks ?? chunks.map(() => NONE)
  const blocks = useMemo(() => blocksOf(chunks), [chunks])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [focus, setFocus] = useState<number | null>(null)
  const rowRefs = useRef(new Map<number, HTMLDivElement>())

  const conflictIndexes = chunks.map((c, i) => (c.kind === 'conflict' ? i : -1)).filter(i => i >= 0)
  const composed = composeMerge(chunks, current, crlf)
  // À mão, o conflito pendente fica marcado no texto (composeForEditing):
  // conta enquanto a marca estiver lá.
  const unresolved = manual ? conflictMarkerCount(manualText) : composed.unresolved
  const autoJoined = chunks.filter(c => c.kind === 'theirs' || c.kind === 'mine').length

  // Edição à mão do resultado: pra acrescentar algo que nenhum dos lados tem,
  // ou quando o merge fica complexo demais pras caixinhas. Começa do que as
  // caixinhas montaram até aqui.
  const canEditByHand = !readOnly && (!simulation || !!manualSeed)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const focusTextarea = useRef(false)
  const editByHand = () => {
    if (!canEditByHand || manual) return
    focusTextarea.current = true
    onManualText(manualSeed ? manualSeed() : composeForEditing(chunks, current, crlf))
  }
  useEffect(() => {
    if (!manual || !focusTextarea.current) return
    focusTextarea.current = false
    textareaRef.current?.focus()
  }, [manual])

  // Número da primeira linha de cada trecho, em cada lado e no resultado.
  const numbers = useMemo(() => {
    let l = 1
    let r = 1
    let q = 1
    return chunks.map((chunk, i) => {
      const at = { left: l, right: r, result: q }
      l += chunk.theirs.length
      r += chunk.mine.length
      q += (chunkResult(chunk, current[i] ?? NONE) ?? []).length
      return at
    })
  }, [chunks, current])

  const setPick = (index: number, side: 'theirs' | 'mine', on: boolean) => {
    const next = current.map(p => ({ ...p }))
    next[index] = { ...(next[index] ?? NONE), [side]: on }
    setFocus(index)
    onPicks(next)
  }

  const go = (step: 1 | -1) => {
    if (!conflictIndexes.length) return
    const at = focus === null ? -1 : conflictIndexes.indexOf(focus)
    const nextAt = at < 0 ? (step > 0 ? 0 : conflictIndexes.length - 1) : (at + step + conflictIndexes.length) % conflictIndexes.length
    const index = conflictIndexes[nextAt]
    setFocus(index)
    rowRefs.current.get(index)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  const checkbox = (index: number, side: 'theirs' | 'mine') => (
    <input
      type="checkbox"
      checked={(current[index] ?? NONE)[side]}
      disabled={readOnly || manual}
      onChange={e => setPick(index, side, e.target.checked)}
      aria-label={t.mvInclude}
      title={t.mvInclude}
      className="h-3 w-3 cursor-pointer accent-[#007acc] disabled:cursor-not-allowed"
    />
  )

  // Linhas estáveis visíveis de um bloco (as do meio recolhidas, se for longo).
  const visibleStable = (block: Extract<Block, { type: 'stable' }>) => {
    const all = block.indexes
    if (all.length <= COLLAPSE_OVER || expanded.has(block.key)) return { head: all, hidden: 0, tail: [] as number[] }
    const first = blocks[0] === block
    const last = blocks[blocks.length - 1] === block
    const head = first ? [] : all.slice(0, CONTEXT)
    const tail = last ? [] : all.slice(all.length - CONTEXT)
    return { head, hidden: all.length - head.length - tail.length, tail }
  }
  const expand = (key: number) => setExpanded(prev => new Set(prev).add(key))
  const collapsedRow = (key: number, hidden: number) => (
    <button
      type="button"
      onClick={() => expand(key)}
      // Expandir linhas no Resultado não é pedir pra editá-lo.
      onDoubleClick={e => e.stopPropagation()}
      className="w-full py-0.5 text-center text-[10px] italic text-pm-text-muted/70 bg-pm-hover/30 hover:text-pm-text cursor-pointer border-none"
    >
      {t.mvShowLines(hidden)}
    </button>
  )

  return (
    <div className={`rounded-md border border-pm-border overflow-hidden ${split.dragging ? 'select-none' : ''}`}>
      {/* Barra: contagem, navegação e "aceitar" nos conflitos */}
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-pm-border bg-pm-hover/40 text-[10.5px]">
        <span
          className={`rounded px-1.5 py-px font-semibold ${
            unresolved > 0 ? 'bg-amber-500/15 text-amber-300' : 'bg-[#4ff09d]/10 text-[#4ff09d]'
          }`}
        >
          {unresolved > 0 ? t.mvConflicts(unresolved) : t.mvNoConflicts}
        </span>
        {autoJoined > 0 && <span className="text-pm-text-muted">{t.mvAutoJoined(autoJoined)}</span>}
        <span className="flex-1" />
        {conflictIndexes.length > 0 && (
          <>
            <button type="button" onClick={() => go(-1)} title={t.mvPrev} aria-label={t.mvPrev}
              className="h-5 w-5 flex items-center justify-center rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover cursor-pointer">
              <ArrowUp size={11} />
            </button>
            <button type="button" onClick={() => go(1)} title={t.mvNext} aria-label={t.mvNext}
              className="h-5 w-5 flex items-center justify-center rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover cursor-pointer">
              <ArrowDown size={11} />
            </button>
            {!readOnly && !manual && (
              [
                [t.mvAcceptGithub, { theirs: true, mine: false }],
                [t.mvAcceptMine, { theirs: false, mine: true }],
                [t.mvAcceptBoth, { theirs: true, mine: true }],
              ] as const
            ).map(([label, pick]) => (
              <button
                key={label}
                type="button"
                title={t.mvAcceptTitle}
                onClick={() => onPicks(pickConflicts(chunks, current, pick))}
                className="rounded border border-pm-border px-1.5 py-px text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text cursor-pointer"
              >
                {label}
              </button>
            ))}
          </>
        )}
      </div>

      {twoWay && <div className="px-2 py-1 border-b border-pm-border text-[10px] text-amber-300/90">{t.mvTwoWay}</div>}

      {/* GitHub | Sua versão — uma grade só, linha a linha. A divisória entre
          as duas colunas arrasta (duplo clique volta ao meio). */}
      <div ref={split.containerRef} className="relative">
      <div
        {...split.handleProps}
        title={t.mvColumnsResize}
        style={{ left: `calc(${split.ratio * 100}% - 3px)` }}
        className={`absolute top-0 bottom-0 z-10 w-1.5 cursor-col-resize outline-none hover:bg-[#007acc]/40 focus-visible:bg-[#007acc]/40 ${split.dragging ? 'bg-[#007acc]/50' : ''}`}
      />
      <div className="grid border-b border-pm-border text-[10px]" style={columns}>
        <div className="flex items-center gap-1.5 px-2 py-1 border-r border-pm-border">
          <span className="rounded px-1 bg-[#4ff09d]/10 text-[#4ff09d] font-semibold">{t.github}</span>
          <span className="text-pm-text-muted">{t.mvIncomingSub}</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1">
          <span className="rounded px-1 bg-[#007acc]/20 text-[#9fd3f7] font-semibold">{t.yourVersion}</span>
          <span className="text-pm-text-muted">{t.mvCurrentSub}</span>
        </div>
      </div>
      <div className="font-mono text-[10.5px] leading-[17px] text-pm-text">
        {blocks.map(block => {
          if (block.type === 'stable') {
            const { head, hidden, tail } = visibleStable(block)
            const row = (i: number) => (
              <div key={i} className="grid text-pm-text-muted" style={columns}>
                <div className="border-r border-pm-border"><Line n={numbers[i].left} text={chunks[i].theirs[0]} /></div>
                <Line n={numbers[i].right} text={chunks[i].mine[0]} />
              </div>
            )
            return (
              <Fragment key={`s${block.key}`}>
                {head.map(row)}
                {hidden > 0 && collapsedRow(block.key, hidden)}
                {tail.map(row)}
              </Fragment>
            )
          }
          const i = block.index
          const chunk = chunks[i]
          const leftActive = chunk.kind === 'theirs' || chunk.kind === 'conflict'
          const rightActive = chunk.kind === 'mine' || chunk.kind === 'conflict'
          const tone = (active: boolean) =>
            chunk.kind === 'same' ? TONE.same : !active ? '' : chunk.kind === 'conflict' ? TONE.conflict : chunk.kind === 'theirs' ? TONE.theirs : TONE.mine
          const height = Math.max(chunk.theirs.length, chunk.mine.length, 1)
          return (
            <div
              key={`c${i}`}
              ref={el => { if (el) rowRefs.current.set(i, el); else rowRefs.current.delete(i) }}
              className={focus === i ? 'outline outline-1 -outline-offset-1 outline-amber-400/70' : ''}
            >
              {Array.from({ length: height }, (_, r) => (
                <div key={r} className="grid" style={columns}>
                  <div className="border-r border-pm-border">
                    <Line
                      n={r < chunk.theirs.length ? numbers[i].left + r : undefined}
                      text={chunk.theirs[r]}
                      tone={r < chunk.theirs.length ? tone(leftActive) : ''}
                      gutter={r === 0 && leftActive ? checkbox(i, 'theirs') : undefined}
                    />
                  </div>
                  <Line
                    n={r < chunk.mine.length ? numbers[i].right + r : undefined}
                    text={chunk.mine[r]}
                    tone={r < chunk.mine.length ? tone(rightActive) : ''}
                    gutter={r === 0 && rightActive ? checkbox(i, 'mine') : undefined}
                  />
                </div>
              ))}
            </div>
          )
        })}
      </div>
      </div>

      {/* Resultado */}
      <div className="flex items-center gap-1.5 px-2 py-1 border-y border-pm-border text-[10px]">
        <span className="rounded px-1 bg-pm-hover text-pm-text-secondary font-semibold">{t.mvResult}</span>
        <span className="text-pm-text-muted">{t.mvResultSub}</span>
        <span className="flex-1" />
        {canEditByHand && (manual ? (
          <button type="button" onClick={onBackToBoxes}
            className="flex items-center gap-1 text-pm-text-muted hover:text-pm-text cursor-pointer">
            <Undo2 size={10} /> {t.mvBackToBoxes}
          </button>
        ) : (
          <button type="button" onClick={editByHand} title={t.mvEditResultTitle}
            className="flex items-center gap-1 rounded border border-pm-border px-1.5 py-px text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text cursor-pointer">
            <PencilLine size={10} /> {t.mvEditResult}
          </button>
        ))}
      </div>
      {manual ? (
        <div className="p-1.5">
          <textarea
            ref={textareaRef}
            value={manualText}
            onChange={e => onManualText(e.target.value)}
            readOnly={readOnly}
            spellCheck={false}
            rows={Math.min(16, Math.max(3, manualText.split('\n').length))}
            className="w-full rounded border border-pm-border bg-pm-bg px-2 py-1.5 font-mono text-[10.5px] text-pm-text outline-none resize-y focus:border-[#007acc]/60"
          />
          <p className="mt-0.5 text-[10px] text-pm-text-muted/70">{manualNote ?? t.mvManualNote}</p>
        </div>
      ) : (
        <div
          className={`font-mono text-[10.5px] leading-[17px] text-pm-text ${canEditByHand ? 'cursor-text' : ''}`}
          // Duplo clique, não clique: um clique pra selecionar/copiar um
          // trecho não pode tirar o campo das caixinhas sem querer.
          onDoubleClick={canEditByHand ? editByHand : undefined}
          title={canEditByHand ? t.mvEditResultTitle : undefined}
        >
          {blocks.map(block => {
            if (block.type === 'stable') {
              const { head, hidden, tail } = visibleStable(block)
              const row = (i: number) => <Line key={i} n={numbers[i].result} text={chunks[i].base[0]} tone="text-pm-text-muted" />
              return (
                <Fragment key={`r${block.key}`}>
                  {head.map(row)}
                  {hidden > 0 && collapsedRow(block.key, hidden)}
                  {tail.map(row)}
                </Fragment>
              )
            }
            const i = block.index
            const chunk = chunks[i]
            const pick = current[i] ?? NONE
            const lines = chunkResult(chunk, pick)
            if (lines === null) {
              return (
                <div key={`r${i}`} className={`flex items-center gap-1.5 px-2 min-h-[19px] ${TONE.conflict} font-sans text-[10.5px] text-amber-300`}>
                  <AlertTriangle size={11} className="shrink-0" />
                  {t.mvUnresolved}
                </div>
              )
            }
            // Cor pela origem de cada linha: GitHub, sua, ou a base.
            const both = pick.theirs && pick.mine && lines.length === chunk.theirs.length + chunk.mine.length
            const toneAt = (r: number) =>
              chunk.kind === 'same' ? TONE.same
                : both ? (r < chunk.theirs.length ? TONE.theirs : TONE.mine)
                  : pick.theirs ? TONE.theirs : pick.mine ? TONE.mine : ''
            return (
              <Fragment key={`r${i}`}>
                {lines.map((text, r) => <Line key={r} n={numbers[i].result + r} text={text} tone={toneAt(r)} />)}
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
