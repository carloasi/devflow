'use client'

import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, FolderPlus, Plus, Star } from 'lucide-react'
import { CollectionItem } from '@/app/types/CollectionItem'
import type { Marker } from '@/lib/markers'
import { MarkerGlyph } from './MarkerGlyph'
import { TreeActionMenu, type ActionMenuView } from './TreeActionMenu'
import { useSortable } from '@dnd-kit/sortable'
import type { DropIndicator } from './CollectionTree'
import { countRequests } from './utils/tree.utils'

// Uma LINHA da árvore. A árvore não é mais desenhada recursivamente: o
// CollectionTree achata o que está aberto (treeRows.flattenVisibleTree) e
// desenha só as linhas que cabem no scroll, cada uma com tudo o que ela
// precisa já resolvido em booleanos (isActive, isFocused, isOpen…). Assim
// trocar o foco ou o alvo do arraste re-renderiza duas linhas, não todas.
interface Props {
  item: CollectionItem
  depth: number
  // Pasta, ou request com Saved Examples — e se está aberta agora.
  hasChildren: boolean
  isOpen: boolean
  // Posição entre os irmãos, pro leitor de tela (aria-posinset/setsize).
  posInSet: number
  setSize: number
  isActive: boolean
  isSelected: boolean
  // Foco de teclado (só true enquanto a árvore tem foco).
  isFocused: boolean
  onRequestSelect?: (item: CollectionItem) => void
  // Só chega preenchido na linha contra a qual o traço/anel é desenhado.
  dropIndicator?: DropIndicator | null
  onToggleSelect?: (id: string) => void
  onRowContextMenu?: (e: React.MouseEvent, item: CollectionItem) => void
  onSetExpanded: (id: string, open: boolean) => void
  /** `plainClick`: botão esquerdo sem Ctrl/Cmd — desfaz a seleção múltipla. */
  onRowFocus?: (id: string, plainClick?: boolean) => void
  // F2/item recém-criado -> esta linha entra em modo rename.
  renameRequested?: boolean
  onRenameHandled?: () => void
  // Termos da busca, pra destacar o trecho que bateu no nome.
  searchTokens?: string[]
  // Nome e cor de cada marcador, por id (ver lib/markers.ts). Vem pronto
  // de cima pra que a linha nao precise conhecer o catalogo inteiro.
  markerMap?: Map<string, { name: string; color: string }>
  // Clique num quadradinho de marcador da linha (abre o popover da marca).
  onMarkerClick?: (item: CollectionItem, markerId: string, x: number, y: number) => void
  // Catálogo inteiro (ver lib/markers.ts) — o menu "…" precisa dele pra
  // listar/criar marcador, não só da cor de cada um (ver markerMap acima).
  markerCatalog?: Marker[]
  onToggleMarker?: (itemId: string, markerId: string) => void
  onCreateMarker?: (itemId: string, name: string, color?: string) => void
  onRecolorMarker?: (markerId: string, color: string) => void
  onManageMarkers?: () => void
  // Grava a descrição do item (ver CollectionItem.description) — mesmo
  // menu "…", que foi pra onde "Add description" e "Markers" se mudaram.
  onSaveDescription?: (itemId: string, text: string) => void
  // Se o menu "..." DESTA linha está aberto — controlado pelo CollectionTree
  // pra só um menu da árvore ficar aberto por vez (ver
  // handleActionMenuOpenChange lá). undefined = ninguém controla.
  actionMenuOpen?: boolean
  // Vista em que o "..." abre quando o atalho M / Shift+M o abriu.
  actionMenuView?: ActionMenuView
  onActionMenuOpenChange?: (itemId: string, open: boolean) => void
  // Esta collection tem alteração local esperando push. Só chega preenchido
  // nas raízes — é a granularidade em que o pendente é rastreado.
  isPendingPush?: boolean
  // Total de requests da collection SEM filtro — com a busca ativa o
  // contador vira "achadas / total". Só nas raízes.
  totalRequests?: number
  // "Modo escolher pasta" — usado pelo fluxo de Tab Group -> Flow (ver
  // AppLayout.tsx). Enquanto ativo, clicar numa pasta chama
  // onPickFolder em vez do comportamento normal (abrir request/expandir);
  // clicar num item que não é pasta não faz nada.
  folderPickMode?: boolean
  onPickFolder?: (id: string) => void
  actions: {
    createRequest: (parentId: string) => void
    createGrpcRequest?: (parentId: string) => void
    createFolder: (parentId: string) => void
    rename: (id: string, name: string) => void
    remove: (id: string) => void
    toggleStar?: (id: string) => void
    duplicate: (id: string) => void
    export: (item: CollectionItem) => Promise<void>
    /** Pasta → .html que roda os passos no navegador (lib/flowHtml). */
    exportHtml?: (item: CollectionItem) => Promise<void>
    importCurl?: (parentId: string) => void
    run?: (item: CollectionItem) => void
    loadTest?: (item: CollectionItem) => void
    pushCollection?: (item: CollectionItem) => void
    openSync?: (item: CollectionItem) => void
    addExample?: (item: CollectionItem) => void
    copyUrl?: (item: CollectionItem) => void
    copyCurl?: (item: CollectionItem) => void
  }
}

/** id do elemento da linha — o `aria-activedescendant` da árvore aponta pra ele. */
export const treeRowDomId = (id: string) => `tree-row-${id}`

// Divide o nome em trechos, marcando os que batem com algum termo da busca.
function highlightName(name: string, tokens: string[] | undefined): React.ReactNode {
  if (!tokens || tokens.length === 0) return name
  const lower = name.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const token of tokens) {
    let from = 0
    let idx: number
    while ((idx = lower.indexOf(token, from)) !== -1) {
      ranges.push([idx, idx + token.length])
      from = idx + token.length
    }
  }
  if (ranges.length === 0) return name

  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }

  const parts: React.ReactNode[] = []
  let cursor = 0
  merged.forEach(([start, end], i) => {
    if (start > cursor) parts.push(name.slice(cursor, start))
    parts.push(
      <mark key={i} className="bg-transparent font-semibold text-[#74b3ff]">
        {name.slice(start, end)}
      </mark>
    )
    cursor = end
  })
  if (cursor < name.length) parts.push(name.slice(cursor))
  return parts
}

const METHOD_META: Record<string, { label: string; color: string }> = {
  GET: { label: 'GET', color: '#6BCB77' },
  POST: { label: 'POST', color: '#F0883E' },
  PUT: { label: 'PUT', color: '#5BA4CF' },
  DELETE: { label: 'DEL', color: '#E06C75' },
  PATCH: { label: 'PATCH', color: '#E5C07B' },
  HEAD: { label: 'HEAD', color: '#C678DD' },
  OPTIONS: { label: 'OPT', color: '#888' },
}

const GRPC_META = { label: 'gRPC', color: '#4FB3BF' }

const INDENT = 10
const MAX_INDENT = 70
const ACCENT = '#22569B'

// Traço de inserção. O tique vertical na ponta esquerda marca o NÍVEL em que o
// item vai cair: puxar o ponteiro pra esquerda durante o arraste tira o item
// de dentro das pastas, e é o tique andando que mostra isso acontecendo.
function DropLine({ edge, indent }: { edge: 'top' | 'bottom'; indent: number }) {
  return (
    <span
      style={{
        position: 'absolute',
        [edge]: -1,
        left: indent,
        right: 4,
        height: 2,
        borderRadius: 2,
        backgroundColor: ACCENT,
        boxShadow: `0 0 4px ${ACCENT}`,
        zIndex: 10,
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: -3,
          width: 2,
          height: 8,
          borderRadius: 1,
          backgroundColor: ACCENT,
        }}
      />
    </span>
  )
}

export const TreeNode = memo(function TreeNode({
  item,
  depth,
  hasChildren,
  isOpen: open,
  posInSet,
  setSize,
  isActive,
  isSelected,
  isFocused,
  onRequestSelect,
  dropIndicator,
  onToggleSelect,
  onRowContextMenu,
  onSetExpanded,
  onRowFocus,
  renameRequested,
  onRenameHandled,
  searchTokens,
  markerMap,
  onMarkerClick,
  markerCatalog,
  onToggleMarker,
  onCreateMarker,
  onRecolorMarker,
  onManageMarkers,
  onSaveDescription,
  actionMenuOpen,
  actionMenuView,
  onActionMenuOpenChange,
  folderPickMode,
  onPickFolder,
  isPendingPush,
  totalRequests,
  actions,
}: Props) {
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) =>
    onSetExpanded(item.id, typeof next === 'function' ? next(open) : next)
  // Clique único numa pasta abre/fecha — mas adiado, pra um duplo-clique
  // (renomear) poder cancelar antes de rodar. Sem isso, os dois `onClick`
  // que o duplo-clique dispara antes do `onDoubleClick` leem o MESMO `open`
  // (closure da mesma renderização, sem repintar entre eles) e calculam o
  // MESMO valor em vez de se cancelarem — a pasta abre sozinha ao renomear.
  const expandClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (expandClickTimerRef.current) clearTimeout(expandClickTimerRef.current)
    }
  }, [])
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(item.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  // Enter/Esc já decidiram o rename; o blur que vem quando o campo some (o
  // Chromium/WebView2 dispara blur ao remover o input focado) não pode
  // decidir de novo. Sem isto, o onBlur — closure da renderização anterior,
  // ainda com o texto digitado — gravava o nome novo depois do Esc.
  const renameSettledRef = useRef(false)

  useEffect(() => {
    setValue(item.name)
  }, [item.name])

  // Ao entrar em modo de edição, foca e já seleciona todo o texto
  useEffect(() => {
    if (editing) renameSettledRef.current = false
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const isFolder = item.type === 'folder'
  const isExample = item.type === 'example'
  // Qualquer pasta pode ser favoritada, inclusive a collection inteira — é
  // assim que uma collection vai pro topo da árvore, como no Postman.
  //
  // Antes só a pasta de "último nível" (sem subpastas) podia: favoritar
  // alimentava um dropdown que abria UMA ABA POR REQUEST da pasta, e numa
  // pasta com subpastas isso viraria dezenas de abas de uma vez. Esse dropdown
  // não existe mais, então a restrição só servia pra impedir justamente o caso
  // mais útil — favoritar a collection.
  //
  // Hoje qualquer item pode ser favoritado (pasta, request ou example) — a
  // lógica de mover pro topo / devolver ao lugar (toggleStarNode) não depende
  // do tipo.
  const canToggleStar = true
  // Collection = pasta na raiz. Ganha nome em destaque e o contador de
  // requests.
  const isCollection = isFolder && depth === 0
  const requestCount = useMemo(
    () => (isCollection ? countRequests(item) : 0),
    [isCollection, item]
  )
  // Com a busca ativa, "achadas / total": só o número filtrado parecia a
  // collection ter encolhido.
  const countLabel =
    totalRequests !== undefined && totalRequests !== requestCount
      ? `${requestCount} / ${totalRequests}`
      : String(requestCount)
  const countTitle =
    totalRequests !== undefined && totalRequests !== requestCount
      ? `${requestCount} of ${totalRequests} requests match the filter`
      : `${requestCount} request${requestCount === 1 ? '' : 's'}`
  // Marcadores da linha. Três bolinhas no máximo e o resto vira "+N": a
  // linha tem 22px e o nome é o que importa — uma fila de sete pontos come
  // o nome que eles deveriam estar qualificando.
  const MAX_DOTS = 3
  const resolvedMarkers = useMemo(() => {
    if (!markerMap || !item.markers?.length) return []
    return item.markers
      .map(id => ({ id, marker: markerMap.get(id), note: item.markerNotes?.[id] ?? '' }))
      .filter((m): m is { id: string; marker: { name: string; color: string }; note: string } => !!m.marker)
  }, [markerMap, item.markers, item.markerNotes])
  const markerDots = resolvedMarkers.slice(0, MAX_DOTS)
  const extraMarkers = resolvedMarkers.length - markerDots.length
  const markerTitle = useMemo(
    () =>
      resolvedMarkers
        .map(m => (m.note ? `${m.marker.name} — ${m.note}` : m.marker.name))
        .join('\n') || undefined,
    [resolvedMarkers]
  )

  // Pro menu "…" (TreeActionMenu): "quais marcadores este item já tem",
  // pronto no formato que o seletor de marcadores espera. Só 'on' — nunca
  // 'partial', que só existia pra uma SELEÇÃO de vários itens.
  const itemMarkerState = useMemo(() => {
    const state: Record<string, 'on'> = {}
    for (const id of item.markers ?? []) state[id] = 'on'
    return state
  }, [item.markers])

  const actionMenuMarkers = useMemo(() => {
    if (!markerCatalog || !onToggleMarker) return undefined
    return {
      catalog: markerCatalog,
      state: itemMarkerState,
      onToggle: (markerId: string) => onToggleMarker(item.id, markerId),
      onCreate: (name: string, color?: string) => onCreateMarker?.(item.id, name, color),
      onRecolor: onRecolorMarker,
      onManage: onManageMarkers,
    }
  }, [markerCatalog, itemMarkerState, onToggleMarker, onCreateMarker, onRecolorMarker, onManageMarkers, item.id])

  const method = item.protocol === 'grpc' ? GRPC_META : METHOD_META[item.method as string]

  // F2 pelo teclado, ou item recém-criado (CollectionTree) -> modo rename.
  useEffect(() => {
    if (renameRequested) {
      setEditing(true)
      onRenameHandled?.()
    }
  }, [renameRequested, onRenameHandled])

  const {
    attributes,
    listeners,
    setNodeRef,
    isDragging,
  } = useSortable({
    id: item.id,
    // Desabilita arrastar (e ser alvo de drop) enquanto o item está em modo
    // de edição (renomeando) — sem isso, clicar/arrastar dentro do campo de
    // texto do rename podia iniciar um drag do item sem querer.
    disabled: editing,
  })

  // Ao sair do rename, devolve o foco pra linha — senão o foco cai no body e
  // a navegação por teclado da árvore para de funcionar.
  const refocusRow = () => requestAnimationFrame(() => rowRef.current?.focus({ preventScroll: true }))

  const submitRename = () => {
    if (renameSettledRef.current) return
    renameSettledRef.current = true
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed && trimmed !== item.name) {
      actions.rename(item.id, trimmed)
    } else {
      setValue(item.name)
    }
  }

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Cancela o abrir/fechar pendente do clique único — ver expandClickTimerRef.
    if (expandClickTimerRef.current) {
      clearTimeout(expandClickTimerRef.current)
      expandClickTimerRef.current = null
    }
    setEditing(true)
  }

  const isDropTarget = dropIndicator?.id === item.id
  const showLineBefore = isDropTarget && dropIndicator?.position === 'before'
  const showLineAfter = isDropTarget && dropIndicator?.position === 'after'
  const showInsideRing = isDropTarget && dropIndicator?.position === 'inside'
  // O traço fica sempre no ponto de inserção sob o cursor, mas seu recuo
  // mostra em que nível o item vai cair — é o retorno visual de puxar pra
  // esquerda pra tirar o item de dentro da pasta.
  const lineIndent =
    Math.min((dropIndicator?.indentDepth ?? depth) * INDENT, MAX_INDENT) + 8

  // Antes a pasta abria sozinha depois de pairar um tempinho na zona
  // "dentro" durante o drag — removido a pedido: soltar dentro de uma
  // pasta fechada não precisa abri-la (o item vai pro final da lista de
  // filhos normalmente), e a pasta abrindo no meio do arrasto mexia no
  // layout sem necessidade.

  // (Abrir as pastas ancestrais do item ativo e rolar até ele agora é feito
  // no CollectionTree: com a árvore desenhada só na janela do scroll, a linha
  // de um item fora da tela nem existe pra rolar até ela.)

  return (
    <div
      ref={setNodeRef}
      style={{
        opacity: isDragging ? 0.35 : 1,
        background: isDragging ? 'rgba(255,255,255,0.03)' : undefined,
        pointerEvents: isDragging ? 'none' : undefined,
        position: 'relative',
      }}
      className="relative w-full min-w-0 overflow-x-clip"
    >
      {/* Linhas guia: uma por nível acima desta linha, ligando o chevron de
          cada pasta aberta aos filhos, igual ao Postman — só visíveis com o
          mouse sobre a árvore (.tree-scroll:hover, ver globals.css). Antes
          era um traço só no container dos filhos; com as linhas achatadas,
          cada uma desenha o seu pedaço. */}
      {Array.from({ length: depth }, (_, level) => (
        <span
          key={level}
          className="tree-guide-line"
          style={{
            position: 'absolute',
            left: Math.min(level * INDENT, MAX_INDENT) + 20,
            top: 0,
            bottom: 0,
            width: 1,
            backgroundColor: 'var(--color-pm-border)',
            pointerEvents: 'none',
          }}
        />
      ))}
      <div className="relative w-full">
      {/* Linha indicadora de inserção ANTES do item */}
      {showLineBefore && <DropLine edge="top" indent={lineIndent} />}

      <div
        ref={rowRef}
        // Marca a LINHA (22px) pro cálculo de drop do CollectionTree. O nó
        // droppable do dnd-kit é o wrapper de fora, que numa pasta aberta
        // engloba toda a subárvore — medir por ele fazia o "antes/dentro/
        // depois" ser calculado contra um bloco de centenas de pixels em vez
        // da linha da pasta.
        data-tree-row={item.id}
        data-tree-row-type={item.type}
        data-tree-row-depth={depth}
        {...attributes}
        {...listeners}
        // Depois do spread de propósito: o dnd-kit põe role="button" e
        // tabIndex=0 em cada linha — o Tab parava em centenas de linhas e o
        // leitor de tela ouvia uma lista de botões. A árvore é um widget só
        // (o container tem o tabIndex e o aria-activedescendant); cada linha
        // é um treeitem com nível, posição e estado.
        id={treeRowDomId(item.id)}
        role="treeitem"
        tabIndex={-1}
        aria-level={depth + 1}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        aria-expanded={hasChildren ? open : undefined}
        aria-selected={isSelected || isActive}
        aria-label={item.type === 'request' && item.method ? `${item.method} ${item.name}` : item.name}
        className={`group relative h-[22px] w-full overflow-x-clip${
          showInsideRing ? ' tree-drop-inside' : ''
        }`}
        style={{
          backgroundColor: showInsideRing
            ? 'rgba(60,137,224,0.28)'
            : isSelected
            ? 'rgba(9,123,237,0.22)'
            : isActive
            ? 'var(--color-pm-row-active)'
            : 'transparent',
          // No modo "escolher pasta", itens que não são pasta ficam
          // esmaecidos (não são um alvo válido) — pastas continuam com
          // opacidade normal pra sinalizar que são clicáveis.
          opacity: folderPickMode && !isFolder ? 0.4 : 1,
          cursor: folderPickMode ? (isFolder ? 'pointer' : 'default') : 'default',
          width: 'calc(100% - 10px)',
          marginLeft: Math.min(depth * INDENT, 10),
          borderRadius: '5px',
          outline: showInsideRing
            ? '1.5px solid rgba(60,137,224,0.9)'
            : isSelected
            ? '1px solid rgba(9,123,237,0.5)'
            : isFocused
            ? '1px solid rgba(116,179,255,0.55)'
            : 'none',
          outlineOffset: -1,
          transform: showInsideRing ? 'scale(1.015)' : 'scale(1)',
          transition: 'outline-color 100ms ease, background-color 100ms ease, transform 100ms ease, opacity 100ms ease',
        }}
        onMouseEnter={e => {
          if (folderPickMode) {
            if (isFolder) e.currentTarget.style.backgroundColor = 'rgba(60,137,224,0.16)'
            return
          }
          if (!isActive && !isSelected) e.currentTarget.style.backgroundColor = 'var(--color-pm-hover)'
        }}
        onMouseLeave={e => {
          if (folderPickMode) {
            e.currentTarget.style.backgroundColor = 'transparent'
            return
          }
          if (!isActive && !isSelected) e.currentTarget.style.backgroundColor = 'transparent'
        }}
        onMouseDown={e => onRowFocus?.(item.id, e.button === 0 && !e.ctrlKey && !e.metaKey && !folderPickMode)}
        onContextMenu={e => {
          if (folderPickMode) { e.preventDefault(); return }
          e.preventDefault()
          e.stopPropagation()
          onRowContextMenu?.(e, item)
        }}
      >
        {isActive && (
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 2,
              height: '100%',
              borderRadius: '0 20px 20px 0',
            }}
          />
        )}

        <div
          className="flex items-center h-full min-w-0 overflow-x-clip"
          style={{ marginLeft: Math.min(depth * INDENT, MAX_INDENT) }}
        >
          <div className="shrink-0 relative" style={{ width: 10, height: '100%', marginRight: 2 }} />

          <button
            onClick={e => {
              e.stopPropagation()
              if (hasChildren) setOpen(v => !v)
            }}
            className="shrink-0 flex items-center justify-center"
            style={{
              width: 16,
              height: 22,
              marginRight: 2,
              color: hasChildren ? 'var(--color-pm-text-muted)' : 'transparent',
              pointerEvents: hasChildren ? 'auto' : 'none',
            }}
          >
            <ChevronRight
              size={11}
              style={{
                transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                transformOrigin: 'center',
                transition: 'transform 150ms ease',
              }}
            />
          </button>

          {isFolder ? (
            <span
              className="shrink-0 flex items-center"
              style={{ marginRight: 6, color: showInsideRing ? '#74b3ff' : 'var(--color-pm-text-muted)' }}
            >
              {showInsideRing ? <FolderOpen size={13} /> : <Folder size={13} />}
            </span>
          ) : isExample ? (
            <span
              className="shrink-0 flex items-center justify-end"
              style={{ width: 24, marginRight: 8, color: 'var(--color-pm-text-muted)' }}
            >
              <FileText size={11} />
            </span>
          ) : (
            <span
              className="shrink-0 font-semibold"
              style={{
                width: 24,
                marginRight: 8,
                fontSize: '10px',
                lineHeight: 1,
                color: method?.color ?? '#888',
                textAlign: 'right',
                fontFamily: '"SF Mono", "Fira Code", monospace',
              }}
            >
              {method?.label ?? item.method}
            </span>
          )}

          {editing ? (
            <input
              ref={inputRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onBlur={submitRename}
              onClick={e => e.stopPropagation()}
              onKeyDown={e => {
                // Não deixa as teclas do rename chegarem na navegação da árvore.
                e.stopPropagation()
                if (e.key === 'Enter') {
                  submitRename()
                  refocusRow()
                }
                if (e.key === 'Escape') {
                  renameSettledRef.current = true
                  setEditing(false)
                  setValue(item.name)
                  refocusRow()
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                height: 18,
                padding: '0 6px',
                borderRadius: 4,
                border: 'none',
                backgroundColor: 'var(--color-pm-surface)',
                color: 'var(--color-pm-text)',
                fontSize: 11,
                outline: 'none',
              }}
            />
          ) : (
            <button
              onClick={e => {
                if (folderPickMode) {
                  e.stopPropagation()
                  if (isFolder) onPickFolder?.(item.id)
                  return
                }
                if (e.ctrlKey || e.metaKey) {
                  e.stopPropagation()
                  onToggleSelect?.(item.id)
                  return
                }
                if (!isFolder) {
                  onRequestSelect?.(item)
                } else {
                  if (expandClickTimerRef.current) clearTimeout(expandClickTimerRef.current)
                  expandClickTimerRef.current = setTimeout(() => {
                    expandClickTimerRef.current = null
                    setOpen(v => !v)
                  }, 250)
                }
              }}
              onDoubleClick={folderPickMode ? undefined : startEditing}
              // O nome vem primeiro: a linha corta com reticências e esta é a
              // única forma de ler o resto. A dica de renomear se aprende uma
              // vez; o nome é o que falta toda vez.
              // A descrição entra entre o nome e a dica: é o que explica o
              // item, e quem passa o mouse quer ler isso antes de qualquer
              // instrução de interface.
              title={
                folderPickMode
                  ? isFolder
                    ? 'Click to select this folder'
                    : undefined
                  : [
                      item.name,
                      item.description?.trim(),
                      'Double-click to rename',
                    ]
                      .filter(Boolean)
                      .join('\n\n')
              }
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                textAlign: 'left',
                fontSize: 12,
                fontWeight: showInsideRing ? 600 : isCollection ? 500 : 400,
                color: showInsideRing
                  ? '#bfdcff'
                  : isActive || isFolder
                  ? 'var(--color-pm-text)'
                  : 'var(--color-pm-text-secondary)',
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              {highlightName(item.name, searchTokens)}
            </button>
          )}

          {/* Salvar é só local desde que o push virou ação explícita. Sem
              este ponto, a única pista de que há coisa não enviada era um
              indicador no ícone do painel de sync, que não diz QUAL
              collection — e com várias abertas isso não ajuda a decidir o
              que enviar. */}
          {isPendingPush && !editing && (
            <span
              className="shrink-0 ml-1.5 w-[6px] h-[6px] rounded-full bg-amber-400"
              title="Local changes not pushed to GitHub yet"
            />
          )}

          {isCollection && !editing && (
            <span
              className="shrink-0 pl-1.5 text-[10px] tabular-nums text-pm-text-muted"
              title={countTitle}
            >
              {countLabel}
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center">
          {/* Marcadores: bolinhas antes dos botões de hover. Ficam SEMPRE
              visíveis (diferente da estrela contornada) — é informação do
              item, não um atalho, e some no hover derrotaria o propósito de
              varrer a árvore procurando o que está marcado. */}
          {markerDots.length > 0 && !editing && (
            <span className="flex shrink-0 items-center gap-[3px] pr-1" title={markerTitle}>
              {markerDots.map(dot => (
                // Clicável: é o único lugar onde "este marcador NESTE item"
                // existe — a nota daquela marca ali e o tirar dali.
                <button
                  key={dot.id}
                  onClick={e => {
                    e.stopPropagation()
                    const box = e.currentTarget.getBoundingClientRect()
                    onMarkerClick?.(item, dot.id, box.left, box.bottom + 4)
                  }}
                  title={
                    dot.note
                      ? `${dot.marker.name} — ${dot.note}`
                      : `${dot.marker.name} — click for notes`
                  }
                  className="relative flex items-center justify-center transition-transform hover:scale-125"
                >
                  {/* Etiqueta cheia = tem nota (ver MarkerGlyph): sem um
                      sinal, não há como saber que existe texto ali sem
                      clicar em cada uma. */}
                  <MarkerGlyph color={dot.marker.color} size={11} solid={!!dot.note} />
                </button>
              ))}
              {extraMarkers > 0 && (
                <span className="text-[9px] leading-none text-pm-text-muted">+{extraMarkers}</span>
              )}
            </span>
          )}

          {/* Estrela: sempre visível (preenchida) quando já é favorito; nos
              demais, aparece contornada no hover pra favoritar direto, sem
              abrir o menu "…". */}
          {canToggleStar && actions.toggleStar && (
            <button
              onClick={e => {
                e.stopPropagation()
                actions.toggleStar!(item.id)
              }}
              title={item.starred ? 'Remove from Favorites' : 'Add to Favorites'}
              className={`h-6 w-6 flex items-center justify-center rounded-md shrink-0 transition-opacity duration-100 ${
                item.starred ? 'opacity-100' : `opacity-0 ${folderPickMode ? '' : 'group-hover:opacity-100'}`
              } ${folderPickMode ? 'pointer-events-none' : ''}`}
            >
              <Star
                size={13}
                className={item.starred ? 'text-amber-400 fill-amber-400' : 'text-pm-text-muted hover:text-amber-400'}
              />
            </button>
          )}

          {/* Atalho de "Add Request" no hover da pasta (antes só pelo menu). */}
          {isFolder && (
            <button
              onClick={e => {
                e.stopPropagation()
                actions.createRequest(item.id)
                setOpen(true)
              }}
              title="Add Request"
              className={`h-6 w-6 flex items-center justify-center rounded-md shrink-0 text-pm-text-muted hover:text-pm-text opacity-0 transition-opacity duration-100 ${
                folderPickMode ? 'pointer-events-none' : 'group-hover:opacity-100'
              }`}
            >
              <Plus size={13} />
            </button>
          )}

          {/* Mesmo atalho para pasta. Depois do "+" de propósito: a ordem é a
              do VS Code (arquivo, depois pasta), e mover o "+" de lugar
              quebraria a memória muscular de quem já usa. */}
          {isFolder && (
            <button
              onClick={e => {
                e.stopPropagation()
                actions.createFolder(item.id)
                setOpen(true)
              }}
              title="Add Folder"
              className={`h-6 w-6 flex items-center justify-center rounded-md shrink-0 text-pm-text-muted hover:text-pm-text opacity-0 transition-opacity duration-100 ${
                folderPickMode ? 'pointer-events-none' : 'group-hover:opacity-100'
              }`}
            >
              <FolderPlus size={13} />
            </button>
          )}

          <div className={`opacity-0 ${folderPickMode ? '' : 'group-hover:opacity-100'} transition-opacity duration-100 shrink-0 ${folderPickMode ? 'pointer-events-none' : ''}`}>
            <TreeActionMenu
              item={item}
              onRename={() => setEditing(true)}
              onDelete={() => actions.remove(item.id)}
              onDuplicate={() => actions.duplicate(item.id)}
              onAddFolder={() => actions.createFolder(item.id)}
              onAddRequest={() => actions.createRequest(item.id)}
              onAddGrpcRequest={actions.createGrpcRequest ? () => actions.createGrpcRequest!(item.id) : undefined}
              onImportCurl={actions.importCurl ? () => actions.importCurl!(item.id) : undefined}
              onExport={() => actions.export(item)}
              onExportHtml={isFolder && actions.exportHtml ? () => void actions.exportHtml!(item) : undefined}
              onRun={actions.run ? () => actions.run!(item) : undefined}
              onLoadTest={actions.loadTest ? () => actions.loadTest!(item) : undefined}
              // Numa subpasta ou request, envia SÓ esse item — o arquivo da
              // collection sobe com o GitHub de agora e esse item trocado
              // (AppLayout.handlePushItem). A collection inteira é pela
              // Central de Sincronização.
              onPushCollection={depth > 0 && (isFolder || item.type === 'request') && actions.pushCollection ? () => actions.pushCollection!(item) : undefined}
              // Receber, enviar e conflitos: a Central, filtrada na collection.
              onOpenSync={isFolder && actions.openSync ? () => actions.openSync!(item) : undefined}
              onAddExample={actions.addExample ? () => actions.addExample!(item) : undefined}
              onToggleStar={canToggleStar && actions.toggleStar ? () => actions.toggleStar!(item.id) : undefined}
              onCopyUrl={actions.copyUrl ? () => actions.copyUrl!(item) : undefined}
              onCopyCurl={actions.copyCurl ? () => actions.copyCurl!(item) : undefined}
              isRoot={depth === 0}
              markers={actionMenuMarkers}
              onSaveDescription={
                onSaveDescription ? (text: string) => onSaveDescription(item.id, text) : undefined
              }
              // undefined (em vez de false) quando ninguém está controlando
              // isto de cima — senão o menu nasceria preso fechado, sem
              // onOpenChange nenhum pra reabrir.
              open={actionMenuOpen}
              onOpenChange={next => onActionMenuOpenChange?.(item.id, next)}
              requestedView={actionMenuOpen ? actionMenuView : undefined}
            />
          </div>
          </div>
        </div>
      </div>

      {/* Linha indicadora de inserção DEPOIS do item */}
      {showLineAfter && <DropLine edge="bottom" indent={lineIndent} />}
      </div>
    </div>
  )
})

