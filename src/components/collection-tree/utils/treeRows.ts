import type { CollectionItem } from '@/app/types/CollectionItem'

/**
 * Linhas visíveis da árvore, achatadas na ordem em que aparecem na tela.
 *
 * A árvore desenhava TODOS os nós abertos, recursivamente — com collections
 * de 800+ itens abertas, milhares de linhas no DOM, e cada seta do teclado
 * (foco) ou movimento do arraste re-renderizava todas. Achatada, a lista
 * vira a fonte única do que está visível: o CollectionTree desenha só a
 * janela que cabe no scroll (ver visibleRange), e a navegação por teclado e
 * o cálculo de drop leem daqui em vez de varrer o DOM.
 */

/** Altura fixa de cada linha (px) — a mesma do `h-[22px]` do TreeNode. */
export const TREE_ROW_HEIGHT = 22

export interface FlatRow {
  item: CollectionItem
  depth: number
  parentId: string | null
  /** Pasta, ou request com Saved Examples. */
  hasChildren: boolean
  isOpen: boolean
  /** Posição entre os irmãos (1-based) e total deles — pro aria-posinset/setsize. */
  posInSet: number
  setSize: number
}

export function hasTreeChildren(item: CollectionItem): boolean {
  return item.type === 'folder' || (item.type === 'request' && !!item.item?.length)
}

export function flattenVisibleTree(
  items: CollectionItem[],
  expandedIds: ReadonlySet<string>
): FlatRow[] {
  const rows: FlatRow[] = []
  const walk = (list: CollectionItem[], depth: number, parentId: string | null) => {
    list.forEach((item, i) => {
      const hasChildren = hasTreeChildren(item)
      const isOpen = hasChildren && expandedIds.has(item.id)
      rows.push({ item, depth, parentId, hasChildren, isOpen, posInSet: i + 1, setSize: list.length })
      if (isOpen && item.item?.length) walk(item.item, depth + 1, item.id)
    })
  }
  walk(items, 0, null)
  return rows
}

/**
 * Faixa [start, end) de linhas a desenhar pra uma janela de scroll, com uma
 * folga (`overscan`) acima e abaixo pra rolagem rápida não mostrar buraco.
 */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  total: number,
  rowHeight = TREE_ROW_HEIGHT,
  overscan = 10
): { start: number; end: number } {
  if (total === 0) return { start: 0, end: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight)
  const start = Math.max(0, Math.min(total, first - overscan))
  const end = Math.min(total, Math.max(start, last + overscan))
  return { start, end }
}

/**
 * Novo scrollTop pra a linha `index` ficar inteira à vista, mexendo o mínimo
 * (como o scrollIntoView `block: 'nearest'`). null = já está visível.
 */
export function scrollTopToReveal(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = TREE_ROW_HEIGHT
): number | null {
  const top = index * rowHeight
  const bottom = top + rowHeight
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight)
  return null
}

/**
 * Busca por digitação: a próxima linha (a partir da seguinte à atual, dando
 * a volta) cujo nome começa com `prefix`. Repetir a mesma letra percorre os
 * itens que começam com ela, como no Explorer.
 */
export function findTypeAheadMatch(
  rows: Array<{ id: string; name: string }>,
  currentIndex: number,
  prefix: string
): number {
  if (rows.length === 0 || !prefix) return -1
  const p = prefix.toLowerCase()
  const allSame = p.split('').every((c) => c === p[0])
  // "aaa" percorre os "a…" um por vez; um prefixo de verdade ("abc") fica
  // na linha atual enquanto ela ainda casa.
  const needle = allSame ? p[0] : p
  const from = allSame || currentIndex < 0 ? currentIndex + 1 : currentIndex
  for (let k = 0; k < rows.length; k++) {
    const i = (from + k + rows.length) % rows.length
    if (rows[i].name.toLowerCase().startsWith(needle)) return i
  }
  return -1
}

/**
 * Seleção restrita ao que está na tela. Um item selecionado que sai de
 * vista (filtro, pasta fechada, apagado num pull, troca de workspace)
 * continuava selecionado: Delete e Copy agiam sobre linhas invisíveis, e o
 * menu contava "Delete (3)" com duas na tela. Devolve o mesmo Set quando
 * nada sai.
 */
export function keepVisibleSelection(
  selected: ReadonlySet<string>,
  visible: { has(id: string): boolean }
): ReadonlySet<string> {
  if (selected.size === 0) return selected
  let next: Set<string> | null = null
  for (const id of selected) {
    if (!visible.has(id)) {
      next ??= new Set(selected)
      next.delete(id)
    }
  }
  return next ?? selected
}

/**
 * Ids das linhas entre `anchorId` e `toId`, inclusive, na ordem da tela —
 * o Shift+Click / Shift+seta. Âncora fora da tela começa em `toId`.
 */
export function rangeIds(rows: Array<{ id: string }>, anchorId: string | null, toId: string): string[] {
  const to = rows.findIndex((r) => r.id === toId)
  if (to < 0) return []
  const from = anchorId ? rows.findIndex((r) => r.id === anchorId) : -1
  if (from < 0) return [toId]
  const [a, b] = from <= to ? [from, to] : [to, from]
  return rows.slice(a, b + 1).map((r) => r.id)
}

/**
 * A guia de recuo a realçar: a da pasta que contém a linha com foco (ou a
 * da própria linha, quando é uma pasta aberta). Devolve o nível da guia e a
 * faixa [start, end) de linhas que ela atravessa; null quando a linha está
 * na raiz e fechada.
 */
export function activeGuide(
  rows: Array<{ depth: number; isOpen: boolean }>,
  focusIndex: number
): { level: number; start: number; end: number } | null {
  if (focusIndex < 0 || focusIndex >= rows.length) return null
  let owner = focusIndex
  if (!rows[focusIndex].isOpen) {
    owner = -1
    for (let i = focusIndex - 1; i >= 0; i--) {
      if (rows[i].depth < rows[focusIndex].depth) {
        owner = i
        break
      }
    }
  }
  if (owner < 0) return null
  const level = rows[owner].depth
  let end = owner + 1
  while (end < rows.length && rows[end].depth > level) end++
  if (end === owner + 1) return null
  return { level, start: owner + 1, end }
}
