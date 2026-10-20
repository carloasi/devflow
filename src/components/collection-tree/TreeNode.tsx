'use client'

import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, Plus, Star } from 'lucide-react'
import { CollectionItem } from '@/app/types/CollectionItem'
import { TreeActionMenu } from './TreeActionMenu'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { DropIndicator } from './CollectionTree'
import { countRequests } from './utils/tree.utils'

interface Props {
  item: CollectionItem
  depth: number
  activeRequestId?: string
  isDragging?: boolean
  onRequestSelect?: (item: CollectionItem) => void
  dropIndicator?: DropIndicator | null
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
  onRowContextMenu?: (e: React.MouseEvent, item: CollectionItem) => void
  // Quais nós estão abertos — controlado pelo CollectionTree (persistido
  // entre sessões e aberto automaticamente durante a busca).
  expandedIds: Set<string>
  onSetExpanded: (id: string, open: boolean) => void
  // Linha com foco de teclado (só vem preenchido enquanto a árvore tem foco).
  focusedId?: string | null
  onRowFocus?: (id: string) => void
  // F2 pedido pelo teclado -> esta linha entra em modo rename.
  renamingId?: string | null
  onRenameHandled?: () => void
  // Termos da busca, pra destacar o trecho que bateu no nome.
  searchTokens?: string[]
  // "Modo escolher pasta" — usado pelo fluxo de Tab Group -> Flow (ver
  // AppLayout.tsx). Enquanto ativo, clicar numa pasta chama
  // onPickFolder em vez do comportamento normal (abrir request/expandir);
  // clicar num item que não é pasta não faz nada.
  // Esta collection tem alteração local esperando push. Só chega preenchido
  // nas raízes — é a granularidade em que o pendente é rastreado.
  isPendingPush?: boolean
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
    importCurl?: (parentId: string) => void
    run?: (item: CollectionItem) => void
    loadTest?: (item: CollectionItem) => void
    pushCollection?: (item: CollectionItem) => void
    pullCollection?: (item: CollectionItem) => void
    addExample?: (item: CollectionItem) => void
    copyUrl?: (item: CollectionItem) => void
    copyCurl?: (item: CollectionItem) => void
  }
}

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
  activeRequestId,
  onRequestSelect,
  dropIndicator,
  selectedIds,
  onToggleSelect,
  onRowContextMenu,
  expandedIds,
  onSetExpanded,
  focusedId,
  onRowFocus,
  renamingId,
  onRenameHandled,
  searchTokens,
  folderPickMode,
  onPickFolder,
  isPendingPush,
  actions,
}: Props) {
  // `?.` de propósito: durante um hot reload o TreeNode novo chegou a rodar
  // com um CollectionTree antigo (sem expandedIds) e derrubava a árvore
  // inteira com "reading 'has'". Sem o Set, o nó só aparece fechado.
  const open = expandedIds?.has(item.id) ?? false
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) =>
    onSetExpanded(item.id, typeof next === 'function' ? next(open) : next)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(item.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setValue(item.name)
  }, [item.name])

  // Ao entrar em modo de edição, foca e já seleciona todo o texto
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const isFolder = item.type === 'folder'
  const isExample = item.type === 'example'
  // Requests com Saved Examples também podem expandir/colapsar pra revelar
  // os filhos (igual pastas) — mas só quando de fato têm algum example.
  const hasChildren = isFolder || (item.type === 'request' && !!item.item?.length)
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
  const isActive = activeRequestId === item.id
  const isSelected = selectedIds?.has(item.id) ?? false
  const isFocused = focusedId === item.id
  // Collection = pasta na raiz. Ganha nome em destaque e o contador de
  // requests.
  const isCollection = isFolder && depth === 0
  const requestCount = useMemo(
    () => (isCollection ? countRequests(item) : 0),
    [isCollection, item]
  )
  const method = item.protocol === 'grpc' ? GRPC_META : METHOD_META[item.method as string]

  // F2 pelo teclado (CollectionTree) -> entra em modo rename.
  useEffect(() => {
    if (renamingId === item.id) {
      setEditing(true)
      onRenameHandled?.()
    }
  }, [renamingId, item.id, onRenameHandled])

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: item.id,
    // Desabilita arrastar (e ser alvo de drop) enquanto o item está em modo
    // de edição (renomeando) — sem isso, clicar/arrastar dentro do campo de
    // texto do rename podia iniciar um drag do item sem querer.
    disabled: editing,
  })

  const dndStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(
      transform
        ? { x: transform.x, y: transform.y, scaleX: 1, scaleY: 1 }
        : null
    ),
    transition: transition ?? undefined,
    zIndex: isDragging ? 999 : undefined,
    opacity: isDragging ? 0.4 : 1,
    width: '100%',
    maxWidth: '100%',
  }

  // Ao sair do rename, devolve o foco pra linha — senão o foco cai no body e
  // a navegação por teclado da árvore para de funcionar.
  const refocusRow = () => requestAnimationFrame(() => rowRef.current?.focus({ preventScroll: true }))

  const submitRename = () => {
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

  // (Abrir as pastas ancestrais do item ativo agora é feito no
  // CollectionTree, que controla o estado aberto/fechado de todos os nós.)

  // Rola a linha até a viewport quando ela vira o item ativo — cobre tanto
  // o caso de já estar visível (troca de aba simples) quanto o de ter
  // acabado de ser revelada pela abertura automática das pastas acima.
  useEffect(() => {
    if (isActive) {
      rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [isActive])

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
      {/* Envolve SÓ a linha (22px). As linhas de inserção são posicionadas
          contra este container, não contra o wrapper de fora: numa pasta
          aberta o wrapper engloba toda a subárvore, e a marca de "depois"
          aparecia lá embaixo, no fim dos filhos, em vez de logo abaixo da
          linha da pasta. */}
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
        onMouseDown={() => onRowFocus?.(item.id)}
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
                border: `1px solid ${ACCENT}`,
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
                  setOpen(v => !v)
                }
              }}
              onDoubleClick={folderPickMode ? undefined : startEditing}
              title={folderPickMode ? (isFolder ? 'Click to select this folder' : undefined) : 'Double-click to rename'}
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
              title={`${requestCount} request${requestCount === 1 ? '' : 's'}`}
            >
              {requestCount}
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center">
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
              onRun={actions.run ? () => actions.run!(item) : undefined}
              onLoadTest={actions.loadTest ? () => actions.loadTest!(item) : undefined}
              // Só na raiz: o remoto guarda um arquivo por collection, então
              // enviar uma subpasta sozinha não teria representação lá.
              onPushCollection={isCollection && actions.pushCollection ? () => actions.pushCollection!(item) : undefined}
              // Em QUALQUER pasta, não só na raiz: o remoto guarda um arquivo
              // por collection, mas a escolha do que trazer não precisa ter
              // essa granularidade — o diff é recortado pela subárvore.
              onPullCollection={isFolder && actions.pullCollection ? () => actions.pullCollection!(item) : undefined}
              onAddExample={actions.addExample ? () => actions.addExample!(item) : undefined}
              onToggleStar={canToggleStar && actions.toggleStar ? () => actions.toggleStar!(item.id) : undefined}
              onCopyUrl={actions.copyUrl ? () => actions.copyUrl!(item) : undefined}
              onCopyCurl={actions.copyCurl ? () => actions.copyCurl!(item) : undefined}
              isRoot={depth === 0}
            />
          </div>
          </div>
        </div>
      </div>

      {/* Linha indicadora de inserção DEPOIS do item */}
      {showLineAfter && <DropLine edge="bottom" indent={lineIndent} />}
      </div>

      {hasChildren && open && item.item && item.item.length > 0 && (
        <div className="w-full relative">
          {/* Linha guia conectando o chevron desta pasta aos filhos, igual
              ao Postman — só fica visível com o mouse sobre a árvore
              (.tree-scroll:hover, ver globals.css). */}
          <span
            className="tree-guide-line"
            style={{
              position: 'absolute',
              left: Math.min(depth * INDENT, MAX_INDENT) + 20,
              top: 0,
              bottom: 0,
              width: 1,
              backgroundColor: 'var(--color-pm-border)',
              pointerEvents: 'none',
            }}
          />
          {item.item.map(child => (
            <TreeNode
              key={child.id}
              item={child}
              depth={depth + 1}
              activeRequestId={activeRequestId}
              onRequestSelect={onRequestSelect}
              actions={actions}
              dropIndicator={dropIndicator}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
              onRowContextMenu={onRowContextMenu}
              expandedIds={expandedIds}
              onSetExpanded={onSetExpanded}
              focusedId={focusedId}
              onRowFocus={onRowFocus}
              renamingId={renamingId}
              onRenameHandled={onRenameHandled}
              searchTokens={searchTokens}
              folderPickMode={folderPickMode}
              onPickFolder={onPickFolder}
            />
          ))}
        </div>
      )}
    </div>
  )
})

