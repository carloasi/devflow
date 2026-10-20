'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { clampOffset, offsetTransform, type Point } from '@/lib/dragWindow'

// Torna um modal arrastável pelo cabeçalho.
//
// Os listeners de movimento ficam na JANELA, não no cabeçalho: arrastar
// rápido tira o cursor de cima do elemento, e com o listener nele o modal
// "soltava" sozinho no meio do gesto.

export interface DraggableDialog {
  /** Espalhar no cabeçalho — é por ele que o modal é arrastado. */
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void
    style: React.CSSProperties
  }
  /** Espalhar no DialogContent. */
  contentProps: {
    style: React.CSSProperties
  }
  dragging: boolean
  /** Devolve o modal ao centro. */
  reset: () => void
}

export function useDraggableDialog(enabled = true): DraggableDialog {
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  // O nó é achado a partir do próprio cabeçalho, e não por `ref` passado ao
  // DialogContent: ali o ref teria que atravessar o componente de UI e o
  // primitivo do Radix pra chegar no DOM, e se em algum ponto ele se perder a
  // falha é silenciosa — sem o nó não há medida, sem medida não há limite, e
  // o modal sai da tela sem volta. O seletor é o `data-slot` que o próprio
  // DialogContent já põe.
  const nodeRef = useRef<HTMLElement | null>(null)

  // Ponto em que o gesto começou, já descontando o deslocamento vigente —
  // sem isso, cada novo arrasto saltaria de volta pro centro.
  const originRef = useRef<Point>({ x: 0, y: 0 })

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!enabled || e.button !== 0) return
      // Clique num botão do cabeçalho (fechar, por exemplo) não é arrasto.
      if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return

      e.preventDefault()
      nodeRef.current = (e.currentTarget as HTMLElement).closest<HTMLElement>(
        '[data-slot="dialog-content"]'
      )
      originRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y }
      setDragging(true)
    },
    [enabled, offset]
  )

  useEffect(() => {
    if (!dragging) return

    const handleMove = (e: MouseEvent) => {
      const raw = { x: e.clientX - originRef.current.x, y: e.clientY - originRef.current.y }
      const rect = nodeRef.current?.getBoundingClientRect()
      setOffset(
        rect
          ? clampOffset(
              raw,
              { width: rect.width, height: rect.height },
              { width: window.innerWidth, height: window.innerHeight }
            )
          : raw
      )
    }
    const stop = () => setDragging(false)

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', stop)
    // Soltar o botão fora da janela não dispara mouseup: sem isto o modal
    // continuaria grudado no cursor depois que ele voltasse.
    window.addEventListener('blur', stop)

    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
    }
  }, [dragging])

  const reset = useCallback(() => setOffset({ x: 0, y: 0 }), [])

  return {
    handleProps: {
      onMouseDown,
      style: enabled ? { cursor: dragging ? 'grabbing' : 'grab' } : {},
    },
    contentProps: {
      style:
        offset.x === 0 && offset.y === 0
          ? {}
          : {
              transform: offsetTransform(offset),
              // A animação de abertura do Radix anima o transform; mantê-la
              // durante o arrasto faria o modal perseguir o cursor com atraso.
              transition: 'none',
            },
    },
    dragging,
    reset,
  }
}
