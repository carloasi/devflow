'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clampOffset, offsetTransform, type Point } from '@/lib/dragWindow'

// Torna um modal arrastável pelo cabeçalho.
//
// Os listeners de movimento ficam na JANELA, não no cabeçalho: arrastar
// rápido tira o cursor de cima do elemento, e com o listener nele o modal
// "soltava" sozinho no meio do gesto.

export interface DraggableDialog {
  /** Espalhar no cabeçalho — é por ele que o modal é arrastado. */
  handleProps: {
    ref: React.RefObject<HTMLDivElement | null>
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

  // Mesma ideia (achar o DialogContent a partir de um nó nativo, não de um
  // ref atravessando o Radix) — mas presente DESDE O MOUNT, não só dentro do
  // onMouseDown: o efeito de "não deixa nascer fora da tela" abaixo precisa
  // medir o modal ANTES de qualquer arrasto.
  const headerRef = useRef<HTMLDivElement | null>(null)

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

  // Um modal com muito conteúdo (ex: várias linhas expandidas no Runner)
  // pode ficar mais alto que a janela. Centralizado (`top-1/2 -translate-
  // y-1/2`, aplicado pelo CSS), isso empurra o TOPO do modal — e com ele o
  // próprio cabeçalho que serve pra arrastar — pra ACIMA da tela, de onde
  // não dá pra agarrar: o modal nasce inalcançável.
  //
  // Corre SEMPRE, arrastado antes ou não: antes isso só rodava até o primeiro
  // arrasto do usuário ("dali em diante quem manda é o gesto da pessoa"), mas
  // o conteúdo pode crescer DEPOIS de um arrasto (expandir uma linha do
  // Runner com o modal já deslocado) — e nessa hora não há arrasto em curso
  // pra "atrapalhar": só o topo sumindo de novo, agora sem rede de proteção
  // nenhuma. clampOffset, durante o PRÓPRIO arrasto, já impede chegar a um
  // offset que esconda o topo — então corrigir aqui nunca desfaz uma escolha
  // deliberada, só evita a única posição que o gesto do usuário não
  // alcançaria sozinho.
  //
  // Sem dependências de propósito, igual à mesma ideia em TreeContextMenu:
  // precisa remedir a cada render, não só na montagem. `rect.top` arredondado
  // ANTES de entrar na conta: o offset aplicado (ver offsetTransform) também é
  // arredondado, e comparar um valor sub-pixel contra ele nunca bate — o bail-
  // out no setOffset não converge, e cada render dispara outra correção.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = headerRef.current?.closest<HTMLElement>('[data-slot="dialog-content"]')
    if (!el) return
    const top = Math.round(el.getBoundingClientRect().top)
    if (top >= 0) return
    setOffset(prev => {
      const nextY = prev.y - top
      return prev.y === nextY ? prev : { x: prev.x, y: nextY }
    })
  })

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

  // Devolve ao centro — a correção automática acima roda de qualquer jeito
  // (não depende mais de nunca ter arrastado), então se o modal continuar
  // mais alto que a janela ela reage sozinha, sem precisar rearmar nada aqui.
  const reset = useCallback(() => {
    setOffset({ x: 0, y: 0 })
  }, [])

  return {
    handleProps: {
      ref: headerRef,
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
