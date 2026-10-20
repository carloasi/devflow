'use client'

import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, Clipboard, Copy, CornerLeftUp } from 'lucide-react'
import { CollectionItem } from '@/app/types/CollectionItem'

interface Props {
  x: number
  y: number
  // Item que recebeu o clique direito — null quando o clique foi no espaço
  // vazio da árvore (contexto de "raiz").
  targetItem: CollectionItem | null
  selectionCount: number
  canPaste: boolean
  onCopy: () => void
  // Ausente = árvore sem reordenação pelo menu.
  move?: {
    canUp: boolean
    canDown: boolean
    canOut: boolean
    onUp: () => void
    onDown: () => void
    onOut: () => void
  }
  onPaste: () => void
  onClose: () => void
}

// Menu de contexto customizado (posicionado livremente no cursor) — a árvore
// não tem nenhum menu de clique direito nativo ainda, só o dropdown de 3
// pontinhos hover (TreeActionMenu), que não serve pra essa interação porque
// precisa reagir à posição real do clique com o botão direito.
export function TreeContextMenu({
  x,
  y,
  targetItem,
  selectionCount,
  canPaste,
  onCopy,
  onPaste,
  move,
  onClose,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const itemClass = `
    relative
    flex
    items-center
    gap-2.5
    rounded-lg
    px-3
    py-2
    text-[13px]
    font-medium
    cursor-pointer
    select-none
    outline-none
    border-none
    ring-0
    transition-all
    duration-150
    hover:bg-pm-hover
    focus:bg-pm-hover
  `

  const disabledItemClass = `${itemClass} opacity-40 cursor-not-allowed hover:bg-transparent`

  const pasteLabel = !targetItem
    ? 'Paste at Root'
    : targetItem.type === 'folder'
    ? 'Paste Here'
    : 'Paste'

  // Ajusta a posição pra não estourar a viewport quando o clique acontece
  // perto da borda direita/inferior da janela.
  const MENU_WIDTH = 200
  // Cresce com as três entradas de mover: subestimar faz o menu nascer
  // grudado na borda de baixo quando o clique é na parte inferior da árvore.
  const MENU_HEIGHT = targetItem ? 240 : 60
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8)
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 8)

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', left, top, zIndex: 9999, minWidth: MENU_WIDTH }}
      className="
        overflow-hidden
        rounded-xl
        border
        border-pm-border
        bg-pm-surface
        backdrop-blur-2xl
        p-1.5
        text-pm-text-secondary
        shadow-[0_12px_40px_rgba(0,0,0,0.55)]
        outline-none
        ring-0
      "
    >
      {targetItem && (
        <button
          onClick={() => {
            onCopy()
            onClose()
          }}
          className={itemClass}
        >
          <Copy size={14} className="text-pm-text-muted" />
          Copy{selectionCount > 1 ? ` (${selectionCount})` : ''}
        </button>
      )}

      <button
        onClick={() => {
          if (!canPaste) return
          onPaste()
          onClose()
        }}
        disabled={!canPaste}
        className={canPaste ? itemClass : disabledItemClass}
      >
        <Clipboard size={14} className="text-pm-text-muted" />
        {pasteLabel}
      </button>

      {/* Mover sem arrastar. Numa árvore de centenas de itens, com rolagem,
          arrastar um passo uma posição acima é desproporcional — e sair de
          uma pasta profunda exige mira. */}
      {targetItem && move && (
        <>
          <div className="my-1 h-px bg-pm-border/70" />

          <button
            onClick={() => { if (move.canUp) { move.onUp(); onClose() } }}
            disabled={!move.canUp}
            className={move.canUp ? itemClass : disabledItemClass}
          >
            <ArrowUp size={14} className="text-pm-text-muted" />
            Move up
          </button>

          <button
            onClick={() => { if (move.canDown) { move.onDown(); onClose() } }}
            disabled={!move.canDown}
            className={move.canDown ? itemClass : disabledItemClass}
          >
            <ArrowDown size={14} className="text-pm-text-muted" />
            Move down
          </button>

          <button
            onClick={() => { if (move.canOut) { move.onOut(); onClose() } }}
            disabled={!move.canOut}
            title={move.canOut ? undefined : 'Already at the top level'}
            className={move.canOut ? itemClass : disabledItemClass}
          >
            <CornerLeftUp size={14} className="text-pm-text-muted" />
            Move out of folder
          </button>
        </>
      )}
    </div>
  )
}
