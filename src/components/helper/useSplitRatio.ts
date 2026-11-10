'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Divisória arrastável entre dois painéis lado a lado. Guarda a fração da
// largura do painel da esquerda em `storageKey`.
//
// Limite em pixels, não só em fração: num modal estreito, 20% da largura
// não cabe nem o nome de uma request.
//
// Mínimos diferentes por lado: a linha da lista tem ícones, o nome e os
// botões Mine/GitHub/Merge (com 220px o nome sumia de vez); o painel de
// merge precisa de espaço pro diff.

/** Mínimo da esquerda (lista de itens), em px. */
export const MIN_LEFT = 300
/** Mínimo da direita (painel de merge), em px. */
export const MIN_RIGHT = 360
/** Passo das setas do teclado (fração da largura). */
const KEY_STEP = 0.02

function load(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback
  } catch {
    return fallback
  }
}

function persist(key: string, value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(value))
  } catch {
    // Sem storage: a divisão só não persiste.
  }
}

/** Fração da esquerda para o cursor em `x`, respeitando o mínimo de cada painel. Pura. */
export function splitRatioAt(
  x: number,
  left: number,
  width: number,
  minLeft = MIN_LEFT,
  minRight = MIN_RIGHT
): number {
  if (width <= 0) return 0.5
  // Contêiner menor que os dois mínimos somados: divide na proporção deles.
  const scale = Math.min(1, width / (minLeft + minRight))
  const lo = minLeft * scale
  const hi = width - minRight * scale
  const px = Math.max(lo, Math.min(hi, x - left))
  return px / width
}

export interface SplitRatio {
  ratio: number
  /** No contêiner dos dois painéis. */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** Na divisória: mouse, duplo clique (volta ao padrão) e setas do teclado. */
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void
    onDoubleClick: () => void
    onKeyDown: (e: React.KeyboardEvent) => void
    tabIndex: number
    role: 'separator'
    'aria-orientation': 'vertical'
    'aria-valuemin': number
    'aria-valuemax': number
    'aria-valuenow': number
  }
  dragging: boolean
}

export function useSplitRatio(storageKey: string, fallback = 0.5): SplitRatio {
  const [ratio, setRatio] = useState(() => load(storageKey, fallback))
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const latest = useRef(ratio)

  const set = useCallback((next: number, save: boolean) => {
    latest.current = next
    setRatio(next)
    if (save) persist(storageKey, next)
  }, [storageKey])

  /** Fração para o pixel `x` na tela, com os limites do contêiner atual. */
  const ratioAt = useCallback((x: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    return rect ? splitRatioAt(x, rect.left, rect.width) : null
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setDragging(true)
  }, [])

  useEffect(() => {
    if (!dragging) return
    // Cursor de redimensionar na página inteira durante o gesto: o mouse
    // passa por cima dos painéis, e sem isto o cursor pisca de um pro outro.
    const previousCursor = document.body.style.cursor
    document.body.style.cursor = 'col-resize'
    const handleMove = (e: MouseEvent) => {
      const next = ratioAt(e.clientX)
      if (next !== null) set(next, false)
    }
    const stop = () => {
      setDragging(false)
      persist(storageKey, latest.current)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', stop)
    window.addEventListener('blur', stop)
    return () => {
      document.body.style.cursor = previousCursor
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
    }
  }, [dragging, storageKey, ratioAt, set])

  const reset = useCallback(() => {
    set(fallback, false)
    persist(storageKey, null)
  }, [fallback, storageKey, set])

  // Setas movem a divisória; Home/End levam aos limites. O limite em pixels
  // vale aqui também: passa pela mesma conta do arrasto.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const step = e.shiftKey ? KEY_STEP * 5 : KEY_STEP
    const current = rect.left + latest.current * rect.width
    let x: number | null = null
    if (e.key === 'ArrowLeft') x = current - step * rect.width
    else if (e.key === 'ArrowRight') x = current + step * rect.width
    else if (e.key === 'Home') x = rect.left
    else if (e.key === 'End') x = rect.right
    if (x === null) return
    e.preventDefault()
    e.stopPropagation()
    set(splitRatioAt(x, rect.left, rect.width), true)
  }, [set])

  return {
    ratio,
    containerRef,
    handleProps: {
      onMouseDown,
      onDoubleClick: reset,
      onKeyDown,
      tabIndex: 0,
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(ratio * 100),
    },
    dragging,
  }
}
