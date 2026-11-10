'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Deixa um modal (DialogContent) mudar de tamanho por qualquer borda ou
// canto, e maximizar. O tamanho escolhido (e se está maximizado) fica salvo
// em `storageKey`, pra reabrir do jeito que a pessoa deixou.
//
// O modal é centralizado por CSS (top/left 50% + translate -50%): crescer a
// largura em d move cada borda d/2. Por isso o delta do mouse entra em dobro —
// assim a borda arrastada acompanha o cursor (a oposta abre na mesma medida).
//
// O limite é medido a partir do CENTRO atual do modal, não só do tamanho da
// janela: um modal arrastado pra perto de uma borda cresce dos dois lados, e
// sem isso o lado de lá sairia da tela.

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface Size {
  width: number
  height: number
}

const MARGIN = 16

interface Stored {
  size: Size | null
  maximized: boolean
}

function load(key: string): Stored {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { size: null, maximized: false }
    const parsed = JSON.parse(raw) as Partial<Size> & { maximized?: boolean }
    const size =
      typeof parsed.width === 'number' && typeof parsed.height === 'number'
        ? { width: parsed.width, height: parsed.height }
        : null
    return { size, maximized: parsed.maximized === true }
  } catch {
    return { size: null, maximized: false }
  }
}

function save(key: string, stored: Stored): void {
  try {
    if (!stored.size && !stored.maximized) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify({ ...(stored.size ?? {}), maximized: stored.maximized || undefined }))
  } catch {
    // Sem storage: o tamanho só não persiste.
  }
}

/**
 * Tamanho novo de um gesto de redimensionar. Pura (testada): `center` é o
 * centro do modal no começo do gesto, `viewport` o tamanho da janela.
 */
export function resizedSize(
  edge: ResizeEdge,
  start: Size,
  delta: { x: number; y: number },
  center: { x: number; y: number },
  viewport: Size,
  min: Size
): Size {
  const maxWidth = Math.max(0, 2 * Math.min(center.x - MARGIN, viewport.width - MARGIN - center.x))
  const maxHeight = Math.max(0, 2 * Math.min(center.y - MARGIN, viewport.height - MARGIN - center.y))
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(Math.min(v, hi), Math.min(lo, hi)))
  const dx = edge.includes('e') ? delta.x : edge.includes('w') ? -delta.x : 0
  const dy = edge.includes('s') ? delta.y : edge.includes('n') ? -delta.y : 0
  const horizontal = edge.includes('e') || edge.includes('w')
  const vertical = edge.includes('n') || edge.includes('s')
  return {
    width: horizontal ? clamp(start.width + dx * 2, min.width, maxWidth) : start.width,
    height: vertical ? clamp(start.height + dy * 2, min.height, maxHeight) : start.height,
  }
}

export interface ResizableDialog {
  /** Juntar ao `style` do DialogContent. */
  style: React.CSSProperties
  /** Props da alça de cada borda. */
  handleProps: (edge: ResizeEdge) => {
    onMouseDown: (e: React.MouseEvent) => void
    onDoubleClick: () => void
  }
  resizing: boolean
  maximized: boolean
  toggleMaximized: () => void
}

export function useResizableDialog(
  storageKey: string,
  { minWidth = 560, minHeight = 360 }: { minWidth?: number; minHeight?: number } = {}
): ResizableDialog {
  const [stored, setStored] = useState<Stored>(() => load(storageKey))
  const [resizing, setResizing] = useState(false)
  const gesture = useRef<{ edge: ResizeEdge; x: number; y: number; start: Size; center: { x: number; y: number } } | null>(null)
  const latest = useRef<Stored>(stored)

  const update = useCallback((next: Stored, persist: boolean) => {
    latest.current = next
    setStored(next)
    if (persist) save(storageKey, next)
  }, [storageKey])

  const onMouseDown = useCallback((edge: ResizeEdge, e: React.MouseEvent) => {
    if (e.button !== 0) return
    const node = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-slot="dialog-content"]')
    if (!node) return
    e.preventDefault()
    e.stopPropagation()
    const rect = node.getBoundingClientRect()
    gesture.current = {
      edge,
      x: e.clientX,
      y: e.clientY,
      start: { width: rect.width, height: rect.height },
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    }
    setResizing(true)
  }, [])

  useEffect(() => {
    if (!resizing) return

    const handleMove = (e: MouseEvent) => {
      const g = gesture.current
      if (!g) return
      const size = resizedSize(
        g.edge,
        g.start,
        { x: e.clientX - g.x, y: e.clientY - g.y },
        g.center,
        { width: window.innerWidth, height: window.innerHeight },
        { width: minWidth, height: minHeight }
      )
      // Redimensionar à mão sai do maximizado, a partir do tamanho que ele tinha.
      update({ size, maximized: false }, false)
    }
    const stop = () => {
      setResizing(false)
      gesture.current = null
      save(storageKey, latest.current)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', stop)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
    }
  }, [resizing, storageKey, minWidth, minHeight, update])

  // Duplo clique numa alça volta ao tamanho padrão do modal.
  const reset = useCallback(() => update({ size: null, maximized: false }, true), [update])

  // Maximizar guarda o tamanho de antes: restaurar volta a ele.
  const toggleMaximized = useCallback(
    () => update({ size: latest.current.size, maximized: !latest.current.maximized }, true),
    [update]
  )

  const fill = (axis: 'vw' | 'vh') => `calc(100${axis} - ${MARGIN * 2}px)`
  const style: React.CSSProperties = stored.maximized
    ? { width: fill('vw'), height: fill('vh'), maxWidth: 'none', maxHeight: 'none' }
    : stored.size
      ? {
          // `min(...)`: um tamanho salvo numa tela maior não passa da janela atual.
          width: `min(${stored.size.width}px, ${fill('vw')})`,
          height: `min(${stored.size.height}px, ${fill('vh')})`,
          maxWidth: 'none',
          maxHeight: 'none',
        }
      : {}

  return {
    style,
    handleProps: (edge: ResizeEdge) => ({
      onMouseDown: (e: React.MouseEvent) => onMouseDown(edge, e),
      onDoubleClick: reset,
    }),
    resizing,
    maximized: stored.maximized,
    toggleMaximized,
  }
}
