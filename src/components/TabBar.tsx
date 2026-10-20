'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X, RefreshCw, FolderPlus, FolderMinus, Check } from 'lucide-react'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Tab } from '@/app/types/Tab'
import {
  GROUP_COLORS,
  assignToGroup,
  buildSegments,
  colorOf,
  defaultGroupName,
  nextColor,
  pruneEmptyGroups,
  regroupAfterReorder,
  removeFromGroup,
  ungroup,
  type TabGroup,
} from '@/lib/tabGroups'

const EDITOR_WIDTH = 220

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-[#6BCB77]',
  POST: 'text-[#F0883E]',
  PUT: 'text-[#5BA4CF]',
  DELETE: 'text-[#E06C75]',
  PATCH: 'text-[#E5C07B]',
  HEAD: 'text-[#C678DD]',
}

interface TabItemProps {
  tab: Tab
  isActive: boolean
  isDraggingOverlay?: boolean
  onClick: (e: React.MouseEvent) => void
  onClose: (e: React.MouseEvent) => void
  // Faz parte de uma seleção múltipla (Ctrl+clique).
  isSelected?: boolean
  onContextMenu: (e: React.MouseEvent) => void
}

function TabItem({
  tab,
  isActive,
  isDraggingOverlay = false,
  isSelected = false,
  onClick,
  onClose,
  onContextMenu,
}: TabItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
  }

  const methodColorClass = METHOD_COLORS[tab.method] ?? 'text-pm-text-muted'

  return (
    <div
      ref={setNodeRef}
      data-tab-id={tab.id}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onContextMenu={onContextMenu}
      // ✅ Fecha a aba com o botão do meio do mouse (auxclick, button === 1).
      //    preventDefault evita o comportamento padrão do navegador (autoscroll).
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          e.stopPropagation()
          onClose(e as unknown as React.MouseEvent)
        }
      }}
      className={`group relative flex items-center shrink-0 h-full cursor-pointer select-none border-r border-pm-border ${
        isDragging ? 'opacity-0 z-50' : 'opacity-100'
      } ${isSelected ? 'bg-[#047ae7]/20' : ''}`}
      title={tab.name}
    >
      {isActive && !isDraggingOverlay && (
        <span className="absolute top-0 left-0 right-0 h-[2px] bg-[#047ae7]" />
      )}

      <div
        className={`flex items-center gap-1 h-full min-w-[84px] max-w-[160px] px-2 transition-colors duration-120 ${
          isDraggingOverlay
            ? 'bg-pm-hover'
            : isActive
            ? 'bg-pm-hover'
            : 'bg-transparent hover:bg-pm-hover/60'
        }`}
      >
        {tab.kind === 'example' ? (
          <span
            className="text-[9px] font-bold font-mono shrink-0 min-w-[22px] text-right text-violet-300"
            title="Saved example"
          >
            e.g.
          </span>
        ) : (
          <span
            className={`text-[9px] font-bold font-mono shrink-0 min-w-[22px] text-right ${methodColorClass}`}
          >
            {tab.method === 'DELETE' ? 'DEL' : (tab.method || 'GET')}
          </span>
        )}

        <span
          className={`text-[11px] overflow-hidden whitespace-nowrap text-ellipsis flex-1 transition-colors duration-120 ${
            isActive ? 'text-pm-text' : 'text-pm-text-muted'
          }`}
        >
          {tab.name}
        </span>

        <div className="relative flex items-center justify-center w-3.5 h-3.5 shrink-0">
          {tab.isDirty && (
            <span
              className="absolute w-2 h-2 rounded-full bg-emerald-400 transition-opacity duration-120 group-hover:opacity-0 pointer-events-none"
              title="Unsaved changes"
            />
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClose(e)
            }}
            className="absolute flex items-center justify-center w-3.5 h-3.5 rounded border-none bg-transparent text-pm-text-muted cursor-pointer opacity-0 transition-opacity duration-120 group-hover:opacity-100 hover:bg-pm-hover hover:text-pm-text"
            aria-label={`Close ${tab.name}`}
          >
            <X size={10} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Context menu ────────────────────────────────────────────────────────────

interface ContextMenuState {
  x: number
  y: number
  tabId: string
}

interface TabContextMenuProps {
  state: ContextMenuState
  hasOthers: boolean
  hasToRight: boolean
  canUpdateGroup: boolean
  onClose: () => void
  onCloseThis: () => void
  onCloseOthers: () => void
  onCloseToRight: () => void
  onCloseAll: () => void
  onUpdateGroup?: () => void
  // Ausente quando a barra roda sem agrupamento (onGroupsChange não veio).
  groupActions?: {
    groups: TabGroup[]
    currentGroup: TabGroup | undefined
    onAddToNew: () => void
    onAddTo: (groupId: string) => void
    // Quantas abas a ação vai mover: 1 normalmente, N quando há seleção por
    // Ctrl+clique. Só muda o rótulo — a ação já é a mesma.
    count: number
    onRemove: () => void
    onUngroup: () => void
  }
}

function TabContextMenu({
  state,
  hasOthers,
  hasToRight,
  canUpdateGroup,
  groupActions,
  onClose,
  onCloseThis,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onUpdateGroup,
}: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuHeight, setMenuHeight] = useState(180);

  useEffect(() => {
      if (menuRef.current) {
          setMenuHeight(menuRef.current.offsetHeight)
      }
  }, [])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const handleScroll = () => onClose()

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleScroll)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleScroll)
    }
  }, [onClose])

  const MENU_WIDTH = 200
  const left = Math.min(state.x, window.innerWidth - MENU_WIDTH - 8)
  const top = Math.min(state.y, window.innerHeight - menuHeight - 8)

  return createPortal(
    <div
      ref={menuRef}
      style={{ left, top }}
      className="fixed z-[100000] w-[200px] bg-pm-surface border border-pm-border rounded-lg shadow-2xl font-sans overflow-hidden p-1"
    >
      <button
        className="flex items-center w-full px-3 py-1.5 text-xs text-pm-text-secondary bg-transparent border-none text-left cursor-pointer hover:bg-pm-hover rounded-md transition-colors"
        onClick={() => {
          onCloseThis()
          onClose()
        }}
      >
        Close
      </button>

      <button
        disabled={!hasOthers}
        className="flex items-center w-full px-3 py-1.5 text-xs text-pm-text-secondary bg-transparent border-none text-left rounded-md transition-colors disabled:text-pm-text-muted disabled:opacity-50 disabled:cursor-not-allowed enabled:cursor-pointer enabled:hover:bg-pm-hover"
        onClick={() => {
          if (hasOthers) {
            onCloseOthers()
            onClose()
          }
        }}
      >
        Close other
      </button>

      <button
        disabled={!hasToRight}
        className="flex items-center w-full px-3 py-1.5 text-xs text-pm-text-secondary bg-transparent border-none text-left rounded-md transition-colors disabled:text-pm-text-muted disabled:opacity-50 disabled:cursor-not-allowed enabled:cursor-pointer enabled:hover:bg-pm-hover"
        onClick={() => {
          if (hasToRight) {
            onCloseToRight()
            onClose()
          }
        }}
      >
        Close to the right
      </button>

      {groupActions && (
        <>
          <div className="h-[1px] bg-pm-hover my-1 mx-1.5" />

          {groupActions.currentGroup ? (
            <>
              <button
                className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-pm-text-secondary bg-transparent border-none text-left cursor-pointer hover:bg-pm-hover rounded-md transition-colors"
                onClick={() => { groupActions.onRemove(); onClose() }}
              >
                <FolderMinus size={11} />
                Remove from group
              </button>
              <button
                className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-pm-text-secondary bg-transparent border-none text-left cursor-pointer hover:bg-pm-hover rounded-md transition-colors"
                onClick={() => { groupActions.onUngroup(); onClose() }}
              >
                <FolderMinus size={11} />
                Ungroup &quot;{groupActions.currentGroup.name}&quot;
              </button>
            </>
          ) : (
            <>
              <button
                className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-pm-text-secondary bg-transparent border-none text-left cursor-pointer hover:bg-pm-hover rounded-md transition-colors"
                onClick={() => { groupActions.onAddToNew(); onClose() }}
              >
                <FolderPlus size={11} />
                {groupActions.count > 1 ? `Add ${groupActions.count} tabs to new group` : "Add to new group"}
              </button>

              {/* Os grupos existentes entram como entradas próprias em vez de
                  submenu: são poucos, e um submenu aqui exigiria hover com
                  atraso — interação pesada demais pro ganho. */}
              {groupActions.groups.map(group => (
                <button
                  key={group.id}
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-pm-text-secondary bg-transparent border-none text-left cursor-pointer hover:bg-pm-hover rounded-md transition-colors"
                  onClick={() => { groupActions.onAddTo(group.id); onClose() }}
                >
                  <span
                    className="w-[7px] h-[7px] rounded-full shrink-0"
                    style={{ backgroundColor: colorOf(group) }}
                  />
                  <span className="truncate">
                    {groupActions.count > 1 ? `Add ${groupActions.count} tabs to` : "Add to"} &quot;{group.name}&quot;
                  </span>
                </button>
              ))}
            </>
          )}
        </>
      )}

      {canUpdateGroup && onUpdateGroup && (
        <>
          <div className="h-[1px] bg-pm-hover my-1 mx-1.5" />
          <button
            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-[#3794ff] bg-transparent border-none text-left cursor-pointer hover:bg-[#3794ff]/10 rounded-md transition-colors"
            onClick={() => {
              onUpdateGroup()
              onClose()
            }}
          >
            <RefreshCw size={11} />
            Update group
          </button>
        </>
      )}

      <div className="h-[1px] bg-pm-hover my-1 mx-1.5" />

      <button
        className="flex items-center w-full px-3 py-1.5 text-xs text-[#e06c75] bg-transparent border-none text-left cursor-pointer hover:bg-[#e06c75]/10 rounded-md transition-colors"
        onClick={() => {
          onCloseAll()
          onClose()
        }}
      >
        Close all
      </button>
    </div>,
    document.body
  )
}

// Pílula colorida que abre o grupo. Clicar recolhe/expande; clicar de novo
// com ele já em foco abre o editor de nome e cor, como no Chrome.
function GroupPill({
  group,
  count,
  onToggleCollapse,
  onEdit,
}: {
  group: TabGroup
  count: number
  onToggleCollapse: () => void
  onEdit: (e: React.MouseEvent) => void
}) {
  const color = colorOf(group)
  return (
    <button
      onClick={onToggleCollapse}
      onContextMenu={onEdit}
      title={`${group.name} — click to ${group.collapsed ? 'expand' : 'collapse'}, right-click to rename`}
      className="flex items-center gap-1.5 h-full shrink-0 px-2 cursor-pointer border-none bg-transparent"
    >
      <span
        className="flex items-center gap-1 rounded-full px-2 py-[2px] text-[10px] font-semibold leading-none"
        style={{ backgroundColor: `${color}22`, color }}
      >
        <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ backgroundColor: color }} />
        {group.name}
        {/* A contagem só aparece recolhido: aberto, as abas estão à vista e o
            número vira ruído. */}
        {group.collapsed && <span className="tabular-nums opacity-70">{count}</span>}
      </span>
    </button>
  )
}

// ── TabBar ───────────────────────────────────────────────────────────────────

interface TabBarProps {
  tabs: Tab[]
  activeTabId: string | null
  onTabClick: (id: string) => void
  onTabClose: (id: string, e: React.MouseEvent) => void
  onTabsReorder: (tabs: Tab[]) => void
  onNewTab: () => void
  onCloseOthers: (id: string) => void
  onCloseToRight: (id: string) => void
  onCloseAll: () => void
  // ✅ novos — opcionais, pra permitir "Update group" no menu de contexto
  currentSessionId?: string | null
  onUpdateCurrentSession?: () => void
  // Agrupamento na barra (lib/tabGroups). Opcional: sem onGroupsChange a
  // barra funciona como antes, sem nenhuma opção de grupo.
  groups?: TabGroup[]
  onGroupsChange?: (groups: TabGroup[]) => void
}

export function TabBar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onTabsReorder,
  onNewTab,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  currentSessionId,
  onUpdateCurrentSession,
  groups = [],
  onGroupsChange,
}: TabBarProps) {
  const [draggingTab, setDraggingTab] = useState<Tab | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  // Grupo com o editor de nome/cor aberto, e onde ancorá-lo. A posição é
  // capturada no clique: a pílula pode estar em qualquer ponto da rolagem, e
  // sem isso o painel aparecia sempre encostado à esquerda da barra.
  const [editingGroup, setEditingGroup] = useState<{ id: string; x: number; y: number } | null>(null)

  // Ctrl/Cmd+clique seleciona abas sem abrir nenhuma — é o que permite mandar
  // várias de uma vez pro grupo, em vez de repetir o menu aba por aba.
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set())

  const handleTabClick = (tabId: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setSelectedTabIds(prev => {
        const next = new Set(prev)
        if (next.has(tabId)) next.delete(tabId)
        else next.add(tabId)
        // A aba clicada entra junto: selecionar "as outras" sem ela quase
        // nunca é o que se quer, e exigiria um Ctrl+clique a mais.
        if (next.size > 0) next.add(activeTabId ?? tabId)
        return next
      })
      return
    }
    setSelectedTabIds(new Set())
    onTabClick(tabId)
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)

  // ── Scrollbar customizada (o scrollbar nativo do WebView2 no Windows
  //    pega a cor de destaque do sistema e não some — por isso desenhamos
  //    a nossa própria barrinha, só visível no hover, igual ao VS Code) ──
  const updateThumb = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollWidth, clientWidth, scrollLeft } = el

    if (scrollWidth <= clientWidth + 1) {
      setThumb(null)
      return
    }

    const width = Math.max((clientWidth / scrollWidth) * clientWidth, 24)
    const maxLeft = clientWidth - width
    const left = (scrollLeft / (scrollWidth - clientWidth)) * maxLeft
    setThumb({ left, width })
  }, [])

  // Arrastar a barrinha (antes ela era pointer-events-none e o clique
  // passava direto pra tab embaixo, disparando o drag de reordenar aba).
  const handleThumbMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const el = scrollRef.current
    if (!el) return

    const startX = e.clientX
    const startScrollLeft = el.scrollLeft
    const { scrollWidth, clientWidth } = el
    const thumbWidth = Math.max((clientWidth / scrollWidth) * clientWidth, 24)
    const maxScrollLeft = scrollWidth - clientWidth
    const maxThumbLeft = clientWidth - thumbWidth
    const ratio = maxThumbLeft > 0 ? maxScrollLeft / maxThumbLeft : 0

    const handleMouseMove = (moveEvent: MouseEvent) => {
      el.scrollLeft = startScrollLeft + (moveEvent.clientX - startX) * ratio
    }
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  )

  const handleDragStart = (e: DragStartEvent) => {
    const tab = tabs.find((t) => t.id === e.active.id)
    setDraggingTab(tab ?? null)
  }

  const handleDragEnd = (e: DragEndEvent) => {
    setDraggingTab(null)
    const { active, over } = e
    if (!over || active.id === over.id) return

    const oldIdx = tabs.findIndex((t) => t.id === active.id)
    const newIdx = tabs.findIndex((t) => t.id === over.id)
    if (oldIdx === -1 || newIdx === -1) return

    const reordered = arrayMove(tabs, oldIdx, newIdx)
    // A aba herda o grupo de quem ficou à volta dela — soltar no meio de um
    // grupo entra nele, soltar fora sai. Sem isso daria pra deixar uma aba
    // solta no meio da pílula, quebrando a contiguidade.
    onTabsReorder(onGroupsChange ? regroupAfterReorder(reordered, String(active.id)) : reordered)
  }

  // ── Grupos ─────────────────────────────────────────────────────────────

  const groupOfTab = (tabId: string): TabGroup | undefined => {
    const groupId = tabs.find(t => t.id === tabId)?.groupId
    return groupId ? groups.find(g => g.id === groupId) : undefined
  }

  const handleAddToNewGroup = (tabIds: string[], anchor?: { x: number; y: number }) => {
    if (!onGroupsChange) return
    const created: TabGroup = {
      id: crypto.randomUUID(),
      name: defaultGroupName(groups),
      color: nextColor(groups),
    }
    onGroupsChange([...groups, created])
    onTabsReorder(assignToGroup(tabs, tabIds, created.id))
    setSelectedTabIds(new Set())
    // Abre o editor já ancorado onde o menu estava: o grupo acabou de nascer
    // com nome genérico, e renomear é o passo seguinte quase sempre.
    if (anchor) setEditingGroup({ id: created.id, x: anchor.x, y: anchor.y })
  }

  const handleAddToGroup = (tabIds: string[], groupId: string) => {
    onTabsReorder(assignToGroup(tabs, tabIds, groupId))
    setSelectedTabIds(new Set())
  }

  const handleRemoveFromGroup = (tabId: string) => {
    if (!onGroupsChange) return
    const next = removeFromGroup(tabs, tabId)
    onTabsReorder(next)
    onGroupsChange(pruneEmptyGroups(next, groups))
  }

  const handleUngroup = (groupId: string) => {
    if (!onGroupsChange) return
    const next = ungroup(tabs, groupId)
    onTabsReorder(next)
    onGroupsChange(groups.filter(g => g.id !== groupId))
  }

  const handleToggleCollapse = (groupId: string) => {
    onGroupsChange?.(
      groups.map(g => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
    )
  }

  const handlePatchGroup = (groupId: string, patch: Partial<TabGroup>) => {
    onGroupsChange?.(groups.map(g => (g.id === groupId ? { ...g, ...patch } : g)))
  }

const handleWheel = (e: React.WheelEvent) => {
    if (!scrollRef.current) return

    e.preventDefault()

    scrollRef.current.scrollLeft += e.deltaY
}

  // Recalcula a barrinha quando as tabs mudam (add/remove/reorder) e quando a janela redimensiona.
  useEffect(() => {
    updateThumb()
  }, [tabs, updateThumb])

  // Rola a tab bar automaticamente até a aba ativa ficar visível — seja
  // clicando na collection, no dropdown de sessões, ou trocando de aba
  // por qualquer outro caminho.
  useEffect(() => {
    if (!activeTabId) return
    const container = scrollRef.current
    if (!container) return

    const el = container.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`)
    if (!el) return

    const visibleLeft = container.scrollLeft
    const visibleRight = visibleLeft + container.clientWidth
    const elLeft = el.offsetLeft
    const elRight = elLeft + el.offsetWidth
    const margin = 12

    if (elLeft < visibleLeft) {
      container.scrollTo({ left: Math.max(elLeft - margin, 0), behavior: 'smooth' })
    } else if (elRight > visibleRight) {
      container.scrollTo({ left: elRight - container.clientWidth + margin, behavior: 'smooth' })
    }
  }, [activeTabId])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    el.addEventListener('scroll', updateThumb, { passive: true })
    window.addEventListener('resize', updateThumb)
    return () => {
      el.removeEventListener('scroll', updateThumb)
      window.removeEventListener('resize', updateThumb)
    }
  }, [updateThumb])

  const handleTabContextMenu = (tabId: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, tabId })
  }

  const contextTabIndex = contextMenu
    ? tabs.findIndex((t) => t.id === contextMenu.tabId)
    : -1
  const hasOthers = contextMenu ? tabs.length > 1 : false
  const hasToRight =
    contextTabIndex !== -1 && contextTabIndex < tabs.length - 1

  const segments = buildSegments(tabs, groups)
  const editingGroupData = editingGroup ? groups.find(g => g.id === editingGroup.id) ?? null : null

  // Abas que o menu vai mover: a seleção, quando a aba clicada faz parte
  // dela; só a clicada caso contrário. Clicar com o direito numa aba FORA da
  // seleção agir sobre a seleção seria agir longe do cursor.
  const menuTargetIds =
    contextMenu && selectedTabIds.size > 1 && selectedTabIds.has(contextMenu.tabId)
      ? [...selectedTabIds]
      : contextMenu
        ? [contextMenu.tabId]
        : []
  // A aba recolhida sai da SortableContext junto com a renderização: arrastar
  // o que não está na tela não teria alvo nenhum.
  const sortableIds = segments.flatMap(seg =>
    seg.kind === "tab" ? [seg.tab.id] : seg.group.collapsed ? [] : seg.tabs.map(t => t.id)
  )

  return (
      <div className="relative group flex flex-col bg-pm-bg border-b border-pm-border shrink-0">
<div
  ref={scrollRef}
  onWheel={handleWheel}
  className="tabbar-scroll flex items-center overscroll-x-contain overflow-x-auto overflow-y-hidden h-[32px]"
>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sortableIds}
            strategy={horizontalListSortingStrategy}
          >
            <div className="flex items-stretch h-full shrink-0">
              {segments.map((segment) =>
                segment.kind === 'tab' ? (
                  <TabItem
                    key={segment.tab.id}
                    tab={segment.tab}
                    isActive={segment.tab.id === activeTabId}
                    isSelected={selectedTabIds.has(segment.tab.id)}
                    onClick={(e) => handleTabClick(segment.tab.id, e)}
                    onClose={(e) => onTabClose(segment.tab.id, e)}
                    onContextMenu={(e) => handleTabContextMenu(segment.tab.id, e)}
                  />
                ) : (
                  <div
                    key={segment.group.id}
                    className="flex items-stretch h-full shrink-0 rounded-t-md"
                    // Faixa colorida no topo e fundo sutil: é o que faz as abas
                    // do grupo lerem como um bloco só, em vez de abas soltas
                    // atrás de uma etiqueta.
                    style={{
                      borderTop: `2px solid ${colorOf(segment.group)}`,
                      backgroundColor: `${colorOf(segment.group)}14`,
                    }}
                  >
                    <GroupPill
                      group={segment.group}
                      count={segment.tabs.length}
                      onToggleCollapse={() => handleToggleCollapse(segment.group.id)}
                      onEdit={(e) => {
                        e.preventDefault()
                        const rect = e.currentTarget.getBoundingClientRect()
                        setEditingGroup({ id: segment.group.id, x: rect.left, y: rect.bottom })
                      }}
                    />
                    {!segment.group.collapsed &&
                      segment.tabs.map((tab) => (
                        <TabItem
                          key={tab.id}
                          tab={tab}
                          isActive={tab.id === activeTabId}
                          isSelected={selectedTabIds.has(tab.id)}
                          onClick={(e) => handleTabClick(tab.id, e)}
                          onClose={(e) => onTabClose(tab.id, e)}
                          onContextMenu={(e) => handleTabContextMenu(tab.id, e)}
                        />
                      ))}
                  </div>
                )
              )}
            </div>
          </SortableContext>

          <DragOverlay dropAnimation={null}>
            {draggingTab && (
              <TabItem
                tab={draggingTab}
                isActive={draggingTab.id === activeTabId}
                isDraggingOverlay
                onClick={() => {}}
                onClose={() => {}}
                onContextMenu={() => {}}
              />
            )}
          </DragOverlay>
        </DndContext>

        {/* Botão + posicionado diretamente após a última aba */}
        <button
          onClick={onNewTab}
          title="Create new request"
          className="flex items-center justify-center w-6 h-6 my-auto mx-1 shrink-0 rounded-sm border-none bg-transparent text-pm-text-muted hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer"
          aria-label="Create new request"
        >
          <Plus size={14} />
        </button>

        {/* Ctrl+clique não se anuncia sozinho: sem este aviso a seleção fica
            invisível pra quem não sabe que ela existe, e quem selecionou sem
            querer não entende por que a aba não abriu. */}
        {selectedTabIds.size > 1 && onGroupsChange && (
          <div className="flex items-center gap-1.5 h-6 my-auto ml-1 mr-2 shrink-0 rounded-full bg-[#047ae7]/15 pl-2.5 pr-1 text-[10px] text-[#8ec5ff]">
            {selectedTabIds.size} selected — right-click to group
            <button
              onClick={() => setSelectedTabIds(new Set())}
              title="Clear selection"
              className="flex items-center justify-center w-4 h-4 rounded-full border-none bg-transparent text-[#8ec5ff] hover:bg-[#047ae7]/30 cursor-pointer"
            >
              <X size={10} />
            </button>
          </div>
        )}
      </div>

      {/* Scrollbar customizada: só existe quando há overflow, e só fica visível no hover — idêntica em qualquer engine (WebView2 não respeitava o estilo do scrollbar nativo). Agora arrastável (por isso pointer-events habilitado e z-index acima das tabs). */}
      {thumb && (
        <div
          onMouseDown={handleThumbMouseDown}
          className="absolute bottom-0 z-10 h-[7px] rounded-full bg-pm-text-muted/0 group-hover:bg-pm-text-muted/30 hover:bg-pm-text-muted/45 active:bg-pm-text-muted/60 transition-colors duration-150 cursor-pointer"
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}

 {contextMenu && (
        <TabContextMenu
          state={contextMenu}
          hasOthers={hasOthers}
          hasToRight={hasToRight}
          canUpdateGroup={!!currentSessionId}
          onClose={() => setContextMenu(null)}
          onCloseThis={() =>
            onTabClose(contextMenu.tabId, {} as React.MouseEvent)
          }
          onCloseOthers={() => onCloseOthers(contextMenu.tabId)}
          onCloseToRight={() => onCloseToRight(contextMenu.tabId)}
          onCloseAll={onCloseAll}
          onUpdateGroup={onUpdateCurrentSession}
          groupActions={
            onGroupsChange
              ? {
                  groups,
                  currentGroup: groupOfTab(contextMenu.tabId),
                  count: menuTargetIds.length,
                  onAddToNew: () => handleAddToNewGroup(menuTargetIds, { x: contextMenu.x, y: contextMenu.y }),
                  onAddTo: (groupId) => handleAddToGroup(menuTargetIds, groupId),
                  onRemove: () => handleRemoveFromGroup(contextMenu.tabId),
                  onUngroup: () => {
                    const group = groupOfTab(contextMenu.tabId)
                    if (group) handleUngroup(group.id)
                  },
                }
              : undefined
          }
        />
      )}

      {editingGroup && editingGroupData && (
        <div
          className="fixed inset-0 z-[100000]"
          onClick={() => setEditingGroup(null)}
        >
          {/* Logo abaixo da pílula que o abriu. A posição vem do rect
              capturado no clique, e não de uma âncora fixa: a barra rola, e
              um painel sempre à esquerda não indica qual grupo está sendo
              editado quando há vários. O clamp evita que ele saia da tela
              quando a pílula está perto da borda direita. */}
          <div
            style={{
              left: Math.max(4, Math.min(editingGroup.x, window.innerWidth - EDITOR_WIDTH - 8)),
              top: editingGroup.y + 2,
            }}
            className="fixed w-[220px] bg-pm-surface border border-pm-border rounded-lg shadow-2xl p-2.5 flex flex-col gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={editingGroupData.name}
              onChange={(e) => handlePatchGroup(editingGroupData.id, { name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingGroup(null) }}
              placeholder="Group name"
              className="h-7 px-2 rounded-md bg-pm-bg border border-pm-border text-xs text-pm-text outline-none focus:border-[#007acc]/60"
            />

            <div className="flex items-center gap-1.5 flex-wrap">
              {GROUP_COLORS.map((color, index) => (
                <button
                  key={color}
                  onClick={() => handlePatchGroup(editingGroupData.id, { color: index })}
                  className="w-5 h-5 rounded-full flex items-center justify-center cursor-pointer border-none"
                  style={{ backgroundColor: color }}
                  title={`Color ${index + 1}`}
                >
                  {editingGroupData.color === index && <Check size={11} className="text-black/70" />}
                </button>
              ))}
            </div>

            <button
              onClick={() => { handleUngroup(editingGroupData.id); setEditingGroup(null) }}
              className="h-7 rounded-md text-[11px] font-medium text-[#e06c75] hover:bg-[#e06c75]/10 transition-colors cursor-pointer border-none bg-transparent"
            >
              Ungroup — keeps the tabs open
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
