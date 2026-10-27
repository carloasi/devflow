'use client'

import { useEffect, useRef, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { MarkerGlyph } from './MarkerGlyph'

// ─────────────────────────────────────────────────────────────────────────
// O que abre ao clicar num quadradinho de marcador na linha da árvore.
//
// Duas coisas que só fazem sentido no PAR (item, marcador), e por isso não
// cabiam nem no menu de contexto (que é do item) nem na tela de gerenciar
// (que é do catálogo): a nota daquela marca ali, e tirar a marca dali.
// ─────────────────────────────────────────────────────────────────────────

interface Props {
  /** Canto superior esquerdo, em coordenadas de viewport. */
  x: number
  y: number
  marker: { id: string; name: string; color: string }
  /** Nome do item que carrega a marca — o popover abre longe da linha. */
  itemName: string
  note: string
  onSaveNote: (text: string) => void
  onRemove: () => void
  onClose: () => void
}

const WIDTH = 240
// Reserva a linha extra da confirmacao desde o inicio: a posicao e
// calculada na abertura, e crescer depois empurraria o popover justamente
// no passo em que o usuario vai clicar.
const HEIGHT = 206

export function MarkerPopover({
  x,
  y,
  marker,
  itemName,
  note,
  onSaveNote,
  onRemove,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState(note)
  const [confirming, setConfirming] = useState(false)

  // O rascunho grava ao fechar, não a cada tecla: é texto corrido, e gravar
  // por tecla encheria o diff do sync de versões intermediárias.
  // Os listeners sao registrados uma vez e congelariam o valor do primeiro
  // render; os refs sao a ponte pro estado atual.
  const draftRef = useRef(draft)
  const confirmingRef = useRef(confirming)
  useEffect(() => {
    draftRef.current = draft
    confirmingRef.current = confirming
  })

  useEffect(() => {
    const finish = () => {
      if (draftRef.current.trim() !== note.trim()) onSaveNote(draftRef.current)
      onClose()
    }
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) finish()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // No evento nativo, senão o modal em volta (Radix escuta no
        // document) fecha junto.
        e.stopImmediatePropagation()
        // Esc sai da confirmação ANTES de fechar: quem abriu a confirmação
        // sem querer espera voltar ao popover, não perder o rascunho junto.
        if (confirmingRef.current) setConfirming(false)
        else onClose()
      }
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [note, onSaveNote, onClose])

  const left = Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8))
  const top = Math.min(y, window.innerHeight - HEIGHT - 8)

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left, top, zIndex: 9999, width: WIDTH }}
      onClick={e => e.stopPropagation()}
      className="rounded-xl border border-pm-border bg-pm-surface p-2 shadow-[0_12px_40px_rgba(0,0,0,0.55)]"
    >
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <MarkerGlyph color={marker.color} size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-pm-text">
          {marker.name}
        </span>
      </div>

      {/* O nome do item fica à vista: o popover nasce no cursor e, numa
          árvore de centenas de linhas, "qual item é este mesmo" não é
          óbvio depois de rolar. */}
      <div className="truncate px-1 pb-1.5 text-[10px] text-pm-text-muted" title={itemName}>
        on {itemName}
      </div>

      <textarea
        autoFocus
        rows={3}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        placeholder="Why it's marked here…"
        spellCheck={false}
        className="w-full resize-none rounded border border-pm-border bg-pm-bg px-1.5 py-1 text-[11.5px] leading-snug text-pm-text outline-none focus:border-[#f26b3a]/60"
      />

      {confirming ? (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {/* Cancelar vem primeiro e cai onde estava o "Remove": um segundo
              clique por engano acerta o cancelar, não a remoção. */}
          <button
            onClick={() => setConfirming(false)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-pm-text-secondary transition-colors hover:bg-pm-hover"
          >
            <X size={13} className="text-pm-text-muted" />
            Cancel
          </button>
          <button
            onClick={onRemove}
            title={
              note.trim()
                ? 'The note written here goes with it.'
                : 'The marker stays in the catalog — only this item loses it.'
            }
            /* O `!` passa por cima do hover do container; sem ele a linha
               destrutiva acende igual a qualquer outra. */
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] font-semibold text-red-400 transition-colors hover:bg-red-500! hover:text-white!"
          >
            <Trash2 size={13} />
            {/* Dizer que a nota vai junto é o ponto: ela só existe neste
                par (item, marcador) e não volta de lugar nenhum. */}
            {note.trim() ? 'Remove, and the note' : 'Confirm removal'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="mt-1.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 size={13} />
          Remove from this item
        </button>
      )}
    </div>
  )
}
