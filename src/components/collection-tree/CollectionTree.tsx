'use client'

import {
  DndContext,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'

import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'

import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { CollectionItem } from '@/app/types/CollectionItem'
import {
  type Marker,
  applyMarker,
  createMarker,
  filterTreeByMarkers,
  hasMarker,
  markerCounts,
  markerNote,
  purgeMarker,
  removeMarker,
  setMarkerNote,
  recolorMarker,
  toggleMarker,
} from '@/lib/markers'
import { TreeNode } from './TreeNode'
import { TreeSearch } from './TreeSearch'
import { MarkersDialog } from './MarkersDialog'
import { MarkerPopover } from './MarkerPopover'
import { MarkerGlyph } from './MarkerGlyph'
import { TreeContextMenu } from './TreeContextMenu'
import { useCollectionTree } from './hooks/useCollectionTree'
import {
  moveNode,
  findParentId,
  findPathToItem,
  projectSiblingDrop,
  DropPosition,
  parseTreeQuery,
  setDescription,
  collectExpandableIds,
  collectRequests,
  collectAllIds,
  collectStarred,
  removeNode,
  moveUp,
  moveDown,
  moveOut,
  canMoveUp,
  canMoveDown,
  canMoveOut,
  numberFolderChildren,
  restoreNames,
} from './utils/tree.utils'
import { buildItemCurl, buildItemUrl } from './utils/requestCopy'
import { ChevronRight, FileText, Folder, GripVertical, Star } from 'lucide-react'
import { toast } from 'sonner'
import { ImportCurlDialog } from '../SlidePanel/ImportCurlDialog'
import { copyItemsToClipboard, getClipboardItems, hasClipboardItems } from '@/storage/treeClipboard'
import { useEnvironment } from '@/components/EnvironmentContext'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buildEnvMap } from '@/lib/envMap';


interface Props {
  items: CollectionItem[]
  activeRequestId?: string
  onRequestSelect?: (item: CollectionItem) => void
  // Abre todas as requests de uma pasta em abas, de uma vez so.
  onOpenAllRequests?: (requests: CollectionItem[]) => void
  onUpdateItems: (items: CollectionItem[]) => void
  onRename?: (id: string, newName: string) => void
  onRunItem?: (item: CollectionItem) => void
  onLoadTestItem?: (item: CollectionItem) => void
  onPushCollection?: (item: CollectionItem) => void
  onPullCollection?: (item: CollectionItem) => void
  onCheckUpdates?: (item: CollectionItem) => void
  onAddExampleItem?: (item: CollectionItem) => void
  // Modo "escolher pasta" (ver TreeNode.tsx) — usado pelo fluxo de
  // Tab Group -> Flow.
  folderPickMode?: boolean
  onPickFolder?: (id: string) => void
  // Incrementado pelo botão "Collapse all" do Sidebar — cada mudança fecha
  // todas as pastas.
  collapseAllToken?: number
  // Ids de collections raiz com alteração local esperando push (ver
  // storage/pendingPushStore). Por ora só o ponto na linha; enviar a
  // collection isolada vem na etapa seguinte.
  pendingPushIds?: Set<string>
  // Catalogo de marcadores do workspace (ver lib/markers.ts). Vem de cima
  // porque e do WORKSPACE, nao da arvore: a mesma lista vale pra todas as
  // collections, e quem a persiste e o AppLayout.
  markers?: Marker[]
  onMarkersChange?: (markers: Marker[]) => void
}

// Pastas abertas, persistidas entre sessões (antes tudo reabria fechado).
const EXPANDED_STORAGE_KEY = 'devflow_tree_expanded'
const FAVORITES_OPEN_STORAGE_KEY = 'devflow_tree_favorites_open'

function loadExpandedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

function loadFavoritesOpen(): boolean {
  try {
    return localStorage.getItem(FAVORITES_OPEN_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

const METHOD_COLORS: Record<string, string> = {
  GET:    '#6bc46d',
  POST:   '#ef8c3a',
  PUT:    '#56aff5',
  DELETE: '#e06c75',
  PATCH:  '#e5c07b',
}

export interface DropIndicator {
  // Linha contra a qual o traço é desenhado, e de que lado dela.
  id: string
  position: DropPosition
  // Nó de referência passado pro moveNode. Difere de `id` quando o usuário
  // puxa pra esquerda pra tirar o item de nível: o traço continua no ponto de
  // inserção sob o cursor, mas o item vira irmão de um ANCESTRAL dessa linha.
  targetId?: string
  // Recuo do traço, em níveis. Mostra em qual nível o item vai cair.
  indentDepth?: number
}

// Altura, em px, da faixa nas bordas da linha de uma pasta que vale como
// "soltar ao lado" em vez de "soltar dentro". Linha da árvore = 22px.
const FOLDER_EDGE = 5

// Quantos px de arraste pra ESQUERDA valem um nível a menos no ponto de
// inserção. Maior que o recuo visual (INDENT = 10px) de propósito: o gesto
// precisa ser deliberado, senão a mão tremendo na horizontal durante um
// arraste vertical já mudaria o nível de destino.
const OUTDENT_STEP = 20

function findNode(items: CollectionItem[], id: string): CollectionItem | null {
  for (const item of items) {
    if (item.id === id) return item
    if (item.item) {
      const found = findNode(item.item, id)
      if (found) return found
    }
  }
  return null
}

// True se `id` está na subárvore de `node` (o próprio nó incluído).
function isDescendantOf(node: CollectionItem, id: string): boolean {
  if (node.id === id) return true
  return (node.item ?? []).some((child) => isDescendantOf(child, id))
}

export function CollectionTree({
  items,
  activeRequestId,
  onRequestSelect,
  onOpenAllRequests,
  onUpdateItems,
  onRename,
  onRunItem,
  onLoadTestItem,
  onPushCollection,
  onPullCollection,
  onCheckUpdates,
  onAddExampleItem,
  folderPickMode,
  onPickFolder,
  collapseAllToken,
  pendingPushIds,
  markers,
  onMarkersChange,
}: Props) {
  const { search, setSearch, filteredItems, actions } = useCollectionTree({
    items,
    onUpdateItems,
    onRename
  })
  const { activeEnv } = useEnvironment()

  const [activeItem, setActiveItem] = useState<CollectionItem | null>(null)
  const [curlDialogParentId, setCurlDialogParentId] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null)

  // Multi-seleção via Ctrl/Cmd+Click na árvore — usada pra copiar vários
  // itens de uma vez (de pastas/collections diferentes até) e colar em
  // outra collection depois.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    item: CollectionItem | null
    canPaste: boolean
  } | null>(null)

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleClearSelection = useCallback(() => {
    setSelectedIds(prev => (prev.size > 0 ? new Set() : prev))
  }, [])

  // Esc limpa a seleção múltipla (Ctrl/Cmd+Click) — só registra o listener
  // enquanto há algo selecionado, pra não interferir com outros usos de Esc
  // (fechar popovers, etc.) no resto do app.
  useEffect(() => {
    if (selectedIds.size === 0) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClearSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectedIds.size, handleClearSelection])

  const handleRowContextMenu = useCallback((e: React.MouseEvent, item: CollectionItem) => {
    e.preventDefault()
    e.stopPropagation()

    // O clique direito não pinta a linha: ela fica igual ao que o clique
    // esquerdo deixa. Quem diz em quem o menu manda é o próprio alvo do
    // clique, via o fallback do deleteTargets/copyItems.
    //
    // Só a seleção que JÁ existe importa: clicar dentro dela preserva (o
    // menu age sobre as N linhas); clicar fora dela limpa, senão o menu
    // mostraria "Delete (3)" para uma linha que não é nenhuma das três.
    setSelectedIds(prev => {
      if (prev.has(item.id)) return prev
      return prev.size === 0 ? prev : new Set()
    })
    setContextMenu({ x: e.clientX, y: e.clientY, item, canPaste: hasClipboardItems() })
  }, [])

  const handleBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    // Só dispara quando o clique é realmente no espaço vazio (não veio de
    // uma linha da árvore, que já dá stopPropagation no próprio handler).
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, item: null, canPaste: hasClipboardItems() })
  }, [])

  // Copia os itens selecionados (Ctrl/Cmd+Click) — ou, sem seleção, o
  // `fallbackId` (linha com foco de teclado). Retorna quantos copiou.
  const copyItems = useCallback((fallbackId?: string | null): number => {
    const ids = selectedIds.size > 0 ? Array.from(selectedIds) : fallbackId ? [fallbackId] : []
    const nodes = ids
      .map(id => findNode(items, id))
      .filter((n): n is CollectionItem => !!n)
    if (nodes.length === 0) return 0
    copyItemsToClipboard(nodes)
    return nodes.length
  }, [items, selectedIds])

  // Reordenar pelo menu de contexto. O que pode ser feito é calculado na
  // abertura do menu, pra que as entradas impossíveis nasçam desabilitadas em
  // vez de não fazer nada ao serem clicadas.
  const buildMoveActions = useCallback((id: string) => ({
    canUp: canMoveUp(items, id),
    canDown: canMoveDown(items, id),
    canOut: canMoveOut(items, id),
    onUp: () => onUpdateItems(moveUp(items, id)),
    onDown: () => onUpdateItems(moveDown(items, id)),
    onOut: () => onUpdateItems(moveOut(items, id)),
  }), [items, onUpdateItems])

  /**
   * Renumera os filhos diretos da pasta: "01 - ", "02 - ".
   *
   * Oferece desfazer no toast em vez de pedir confirmação antes: são muitos
   * renomes de uma vez, o app não tem undo, e perguntar antes atrasaria a
   * ação comum para proteger do caso raro. Com o desfazer ali, o caso raro
   * custa um clique.
   */
  const handleNumberChildren = useCallback((folderId: string) => {
    const { items: next, previous } = numberFolderChildren(items, folderId)
    if (previous.length === 0) {
      toast.info('Already numbered.')
      return
    }

    const before = items
    onUpdateItems(next)
    toast.success(`Numbered ${previous.length} item${previous.length === 1 ? '' : 's'}.`, {
      action: { label: 'Undo', onClick: () => onUpdateItems(restoreNames(before, previous)) },
      duration: 8000,
    })
  }, [items, onUpdateItems])

  /**
   * O que a ação de apagar atinge: a seleção, ou o item clicado quando não
   * há seleção.
   *
   * Mesma regra da tecla Delete — eram dois caminhos para o mesmo gesto, e
   * duas regras divergiriam.
   */
  const deleteTargets = useCallback((fallback: CollectionItem | null): CollectionItem[] => {
    if (selectedIds.size > 0) {
      return Array.from(selectedIds)
        .map(id => findNode(items, id))
        .filter((n): n is CollectionItem => !!n)
    }
    return fallback ? [fallback] : []
  }, [selectedIds, items])

  /*
   * ============================================================
   * MARCADORES
   * ============================================================
   */
  const markerCatalog = useMemo(() => markers ?? [], [markers])

  const markerMap = useMemo(
    () => new Map(markerCatalog.map(m => [m.id, { name: m.name, color: m.color }])),
    [markerCatalog]
  )

  // Alvos de marcar: a mesma regra do delete e do copy — a seleção, ou a
  // linha clicada quando não há seleção.
  const contextMarkerTargets = useMemo(
    () => (contextMenu?.item ? deleteTargets(contextMenu.item) : []),
    [contextMenu, deleteTargets]
  )

  // 'on' = todos os alvos têm; 'partial' = alguns. Ausente = nenhum.
  const contextMarkerState = useMemo(() => {
    const state: Record<string, 'on' | 'partial'> = {}
    if (contextMarkerTargets.length === 0) return state
    for (const marker of markerCatalog) {
      const hits = contextMarkerTargets.filter(node => hasMarker(node, marker.id)).length
      if (hits === 0) continue
      state[marker.id] = hits === contextMarkerTargets.length ? 'on' : 'partial'
    }
    return state
  }, [contextMarkerTargets, markerCatalog])

  const handleToggleMarker = useCallback(
    (markerId: string) => {
      const ids = contextMarkerTargets.map(n => n.id)
      if (ids.length === 0) return
      onUpdateItems(toggleMarker(items, ids, markerId))
    },
    [contextMarkerTargets, items, onUpdateItems]
  )

  // Cria e já aplica, no mesmo gesto. Nome repetido reaproveita o marcador
  // existente (createMarker devolve o que já havia), então digitar "flaky"
  // de novo marca com o "flaky" do time em vez de criar um segundo.
  const handleCreateMarker = useCallback(
    (name: string, color?: string) => {
      if (!onMarkersChange) return
      let result
      try {
        result = createMarker(markerCatalog, name, { color })
      } catch {
        return
      }
      if (!result.existed) onMarkersChange(result.catalog)
      const ids = contextMarkerTargets.map(n => n.id)
      if (ids.length > 0) onUpdateItems(applyMarker(items, ids, result.marker.id))
    },
    [markerCatalog, onMarkersChange, contextMarkerTargets, items, onUpdateItems]
  )

  const handleRecolorMarker = useCallback(
    (markerId: string, color: string) => {
      onMarkersChange?.(recolorMarker(markerCatalog, markerId, color))
    },
    [markerCatalog, onMarkersChange]
  )

  // Marcadores escolhidos na barra de filtro. Só ids — o catálogo pode mudar
  // (um marcador apagado por um colega chega no pull), e guardar o objeto
  // deixaria o filtro preso numa cor/nome que já não existe.
  const [filterMarkerIds, setFilterMarkerIds] = useState<string[]>([])

  const toggleFilterMarker = useCallback((markerId: string) => {
    setFilterMarkerIds(prev =>
      prev.includes(markerId) ? prev.filter(id => id !== markerId) : [...prev, markerId]
    )
  }, [])

  // Marcador que sumiu do catálogo não pode continuar filtrando a árvore em
  // silêncio: sem isto o usuário veria a árvore recortada sem nenhum chip
  // aceso explicando por quê.
  const activeFilterIds = useMemo(
    () => filterMarkerIds.filter(id => markerMap.has(id)),
    [filterMarkerIds, markerMap]
  )

  // Só os marcadores em uso aparecem na barra: um catálogo de 20 com 3 em
  // uso viraria uma parede de chips que não filtram nada.
  const filterBarMarkers = useMemo(() => {
    const counts = markerCounts(items)
    return markerCatalog.filter(m => (counts.get(m.id) ?? 0) > 0 || activeFilterIds.includes(m.id))
  }, [markerCatalog, items, activeFilterIds])

  const handleSaveDescription = useCallback(
    (nodeId: string, text: string) => {
      onUpdateItems(setDescription(items, nodeId, text))
    },
    [items, onUpdateItems]
  )

  // Requests da pasta clicada, recursivo. Calculado na abertura do menu pra
  // que o número já apareça no rótulo, antes do clique.
  const contextOpenAll = useMemo(
    () =>
      contextMenu?.item?.type === 'folder'
        ? collectRequests(contextMenu.item.item ?? [])
        : [],
    [contextMenu]
  )

  const [managingMarkers, setManagingMarkers] = useState(false)

  // Marca aberta pelo clique no quadradinho da linha: o par (item, marcador)
  // mais a posição, porque o popover nasce colado no quadradinho clicado.
  const [openMarker, setOpenMarker] = useState<{
    itemId: string
    itemName: string
    markerId: string
    x: number
    y: number
  } | null>(null)

  const handleMarkerClick = useCallback(
    (node: CollectionItem, markerId: string, x: number, y: number) => {
      setOpenMarker({ itemId: node.id, itemName: node.name, markerId, x, y })
    },
    []
  )

  const handleSaveMarkerNote = useCallback(
    (nodeId: string, markerId: string, text: string) => {
      onUpdateItems(setMarkerNote(items, nodeId, markerId, text))
    },
    [items, onUpdateItems]
  )

  const handleRemoveMarkerHere = useCallback(
    (nodeId: string, markerId: string) => {
      onUpdateItems(removeMarker(items, [nodeId], markerId))
      setOpenMarker(null)
    },
    [items, onUpdateItems]
  )

  const markerUsage = useMemo(() => markerCounts(items), [items])

  // Apagar do catálogo tem que tirar da árvore junto: deixar o id nos nós
  // viraria uma marca invisível, que nenhum filtro alcança e nenhuma tela
  // mostra — e que voltaria a aparecer se alguém criasse outro marcador
  // reaproveitando o id.
  const handleDeleteMarker = useCallback(
    (markerId: string) => {
      onUpdateItems(purgeMarker(items, markerId))
      setFilterMarkerIds(prev => prev.filter(id => id !== markerId))
    },
    [items, onUpdateItems]
  )

  // Alvos do delete do menu de contexto. Fixados aqui porque o menu lê isso
  // duas vezes (o rótulo da confirmação e a ação), e a seleção não muda
  // enquanto ele está aberto.
  const contextDeleteTargets = useMemo(
    () => (contextMenu ? deleteTargets(contextMenu.item) : []),
    [contextMenu, deleteTargets]
  )

  // Copia pelo menu: a seleção, ou a linha clicada quando não há seleção.
  // O toast é o único retorno — o clique direito não acende mais a linha,
  // então sem ele a cópia não dá sinal nenhum de que aconteceu.
  const handleCopySelected = useCallback((fallbackId?: string | null) => {
    const count = copyItems(fallbackId)
    if (count > 0) toast.success(`${count} item${count === 1 ? '' : 's'} copied`)
  }, [copyItems])

  // Cola o clipboard da árvore: numa pasta -> dentro dela; num request ->
  // como irmão (mesmo pai, ou raiz); sem alvo -> na raiz.
  const pasteInto = useCallback((target: CollectionItem | null): boolean => {
    const clipboardItems = getClipboardItems()
    if (clipboardItems.length === 0) return false

    if (!target) {
      actions.pasteItems(null, clipboardItems)
    } else if (target.type === 'folder') {
      actions.pasteItems(target.id, clipboardItems)
    } else {
      const parentId = findParentId(items, target.id)
      actions.pasteItems(parentId ?? null, clipboardItems)
    }
    return true
  }, [items, actions])

  const handlePaste = useCallback(() => {
    if (!contextMenu) return
    pasteInto(contextMenu.item)
  }, [contextMenu, pasteInto])

  // Posição Y real do ponteiro durante o drag — mais preciso que o centro do
  // elemento "fantasma" arrastado (que fica deslocado do cursor dependendo
  // de onde dentro da linha o usuário agarrou pra arrastar). Isso deixa o
  // cálculo de "antes/depois/dentro" fiel ao que o usuário está vendo.
  const pointerYRef = useRef<number | null>(null)
  // X do ponteiro e X onde o arraste começou — a diferença entre os dois é o
  // que define quantos níveis o item sobe (ver OUTDENT_STEP).
  const pointerXRef = useRef<number | null>(null)
  const dragStartXRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!activeItem) return
    const onPointerMove = (e: PointerEvent) => {
      pointerYRef.current = e.clientY
      pointerXRef.current = e.clientX
      updateDropIndicator()
    }
    window.addEventListener('pointermove', onPointerMove)
    return () => window.removeEventListener('pointermove', onPointerMove)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItem])

  const envMap = useMemo(
    () =>
      buildEnvMap(activeEnv?.values) as Record<string, string>,
    [activeEnv]
  )

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} copied`)
    } catch {
      toast.error(`Couldn't copy ${label}`)
    }
  }, [])

  const actionsWithImport = {
    ...actions,
    copyUrl: (item: CollectionItem) => copyText(buildItemUrl(item, envMap), 'URL'),
    copyCurl: (item: CollectionItem) => copyText(buildItemCurl(item, envMap), 'cURL'),
    importCurl: (parentId: string) => setCurlDialogParentId(parentId),
    run: onRunItem ? (item: CollectionItem) => onRunItem(item) : undefined,
    loadTest: onLoadTestItem ? (item: CollectionItem) => onLoadTestItem(item) : undefined,
    pushCollection: onPushCollection ? (item: CollectionItem) => onPushCollection(item) : undefined,
    pullCollection: onPullCollection ? (item: CollectionItem) => onPullCollection(item) : undefined,
    checkUpdates: onCheckUpdates ? (item: CollectionItem) => onCheckUpdates(item) : undefined,
    addExample: onAddExampleItem
      ? (item: CollectionItem) => onAddExampleItem(actions.createExample(item))
      : undefined,
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    })
  )

  const uniqueFilteredItems = useMemo(() => {
    // Marcador DEPOIS da busca: os dois recortam, e encadear deixa "@flaky
    // + quote" significar o óbvio — entre os marcados, os que casam com a
    // busca. A ordem inversa daria o mesmo conjunto, mas a busca é a que o
    // usuário digitou por último e recortar primeiro por ela é mais barato.
    const byMarker = filterTreeByMarkers(filteredItems, activeFilterIds)
    const seen = new Set<string>()
    const deduped = byMarker.filter((item) => {
      if (!item.id || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    // A árvore mostra exatamente a ordem guardada no estado. Antes, itens que
    // continham uma pasta favoritada eram ancorados no topo na hora de
    // desenhar, o que desfazia silenciosamente qualquer drag-and-drop: com
    // "Order" favoritada, nada conseguia ficar acima de "Barramento B2B -
    // Dev". As favoritas continuam acessíveis pelo dropdown de Favorites.
    return deduped
  }, [filteredItems, activeFilterIds])

  const rootIds = useMemo(() => {
    return uniqueFilteredItems.map((item) => item.id)
  }, [uniqueFilteredItems])

  /*
   * ============================================================
   * ABERTO / FECHADO
   * ============================================================
   * Fora da busca: `expandedIds`, persistido no localStorage.
   * Durante a busca: tudo que tem resultado fica aberto (antes os achados
   * ficavam escondidos dentro de pastas fechadas); o usuário ainda pode
   * fechar pastas, e isso vale só enquanto a busca não muda — não mexe no
   * estado salvo de fora da busca.
   */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(loadExpandedIds)
  const [searchCollapsedIds, setSearchCollapsedIds] = useState<Set<string>>(new Set())
  const searchTokens = useMemo(() => parseTreeQuery(search), [search])
  // Filtrar por marcador tambem abre as pastas: o resultado costuma estar
  // tres niveis abaixo, e deixar tudo fechado esconde justamente o que o
  // filtro acabou de encontrar.
  const isSearching = searchTokens.length > 0 || activeFilterIds.length > 0

  useEffect(() => {
    setSearchCollapsedIds(new Set())
  }, [search, activeFilterIds])

  // Persiste, descartando ids que não existem mais (itens apagados). Com a
  // árvore ainda vazia (antes das collections carregarem) não poda nada, pra
  // não apagar o estado salvo.
  useEffect(() => {
    try {
      let ids = Array.from(expandedIds)
      if (items.length > 0) {
        const existing = collectAllIds(items)
        ids = ids.filter(id => existing.has(id))
      }
      localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(ids))
    } catch {}
  }, [expandedIds, items])

  const searchExpandableIds = useMemo(
    () => (isSearching ? collectExpandableIds(uniqueFilteredItems) : new Set<string>()),
    [isSearching, uniqueFilteredItems]
  )

  const effectiveExpandedIds = useMemo(() => {
    if (!isSearching) return expandedIds
    return new Set(Array.from(searchExpandableIds).filter(id => !searchCollapsedIds.has(id)))
  }, [isSearching, expandedIds, searchExpandableIds, searchCollapsedIds])

  const setExpanded = useCallback((id: string, open: boolean) => {
    const apply = (prev: Set<string>, add: boolean) => {
      if (prev.has(id) === add) return prev
      const next = new Set(prev)
      if (add) next.add(id)
      else next.delete(id)
      return next
    }
    if (isSearching) setSearchCollapsedIds(prev => apply(prev, !open))
    else setExpandedIds(prev => apply(prev, open))
  }, [isSearching])

  const expandPath = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setExpandedIds(prev => {
      if (ids.every(id => prev.has(id))) return prev
      const next = new Set(prev)
      ids.forEach(id => next.add(id))
      return next
    })
  }, [])

  // Abre as pastas ancestrais do item ativo (a aba selecionada) — trocar de
  // aba revela o item mesmo dentro de uma pasta fechada. Só abre, nunca
  // fecha, então não briga com o usuário fechando depois.
  useEffect(() => {
    if (!activeRequestId) return
    const path = findPathToItem(items, activeRequestId)
    if (path) expandPath(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRequestId])

  // "Collapse all" (botão no cabeçalho do Sidebar).
  const firstCollapseToken = useRef(collapseAllToken)
  useEffect(() => {
    if (collapseAllToken === firstCollapseToken.current) return
    setExpandedIds(new Set())
    setSearchCollapsedIds(collectExpandableIds(uniqueFilteredItems))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseAllToken])

  /*
   * ============================================================
   * TECLADO
   * ============================================================
   */
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [treeFocused, setTreeFocused] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CollectionItem[] | null>(null)

  const handleRenameHandled = useCallback(() => setRenamingId(null), [])
  const handleRowFocus = useCallback((id: string) => setFocusedId(id), [])

  // Linhas visíveis na ordem da tela — lidas do DOM (data-tree-row), que já
  // reflete o que está aberto/filtrado.
  const getVisibleRows = useCallback(() => {
    const container = scrollRef.current
    if (!container) return []
    return Array.from(container.querySelectorAll<HTMLElement>('[data-tree-row]')).map(row => ({
      id: row.dataset.treeRow!,
      depth: Number(row.dataset.treeRowDepth ?? 0),
    }))
  }, [])

  // Mantém a linha com foco visível ao navegar.
  useEffect(() => {
    if (!focusedId) return
    const frame = requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-tree-row="${CSS.escape(focusedId)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusedId])

  const focusTree = useCallback(() => {
    const rows = getVisibleRows()
    if (rows.length === 0) return
    setFocusedId(current =>
      current && rows.some(r => r.id === current) ? current : rows[0].id
    )
    scrollRef.current?.focus({ preventScroll: true })
  }, [getVisibleRows])

  const handleTreeFocus = useCallback(() => {
    setTreeFocused(true)
    setFocusedId(current => {
      if (current) return current
      if (activeRequestId && findNode(items, activeRequestId)) return activeRequestId
      return getVisibleRows()[0]?.id ?? null
    })
  }, [activeRequestId, items, getVisibleRows])

  const handleTreeBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTreeFocused(false)
  }, [])

  // Apaga de fato. Os dois gestos (tecla Delete e menu de contexto) passam
  // por aqui — cada um com a sua confirmação, mas com uma única regra de
  // remoção e de para onde o foco vai.
  const deleteNodes = useCallback((nodes: CollectionItem[]) => {
    if (nodes.length === 0) return
    const updated = nodes.reduce((acc, node) => removeNode(acc, node.id), items)
    onUpdateItems(updated)
    setSelectedIds(new Set())
    // Foco vai pra linha anterior visível (a apagada some).
    const rows = getVisibleRows()
    const idx = rows.findIndex(r => r.id === focusedId)
    const deletedIds = new Set(nodes.map(n => n.id))
    const fallback = rows.slice(0, Math.max(idx, 0)).reverse().find(r => !deletedIds.has(r.id))
    setFocusedId(fallback?.id ?? null)
    requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }))
  }, [items, onUpdateItems, getVisibleRows, focusedId])

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return
    deleteNodes(pendingDelete)
    setPendingDelete(null)
  }, [pendingDelete, deleteNodes])

  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isTextInput(e.target)) return

    const rows = getVisibleRows()
    if (rows.length === 0) return
    const idx = rows.findIndex(r => r.id === focusedId)
    const current = idx >= 0 ? rows[idx] : null
    const node = current ? findNode(uniqueFilteredItems, current.id) : null
    const isOpen = !!node && effectiveExpandedIds.has(node.id)
    const canExpand = !!node && (node.type === 'folder' || (node.item?.length ?? 0) > 0)
    const mod = e.ctrlKey || e.metaKey

    const move = (to: number) => setFocusedId(rows[Math.max(0, Math.min(rows.length - 1, to))].id)

    let handled = true
    switch (e.key) {
      case 'ArrowDown':
        move(idx < 0 ? 0 : idx + 1)
        break
      case 'ArrowUp':
        move(idx < 0 ? 0 : idx - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(rows.length - 1)
        break
      case 'ArrowRight':
        if (!node) break
        if (canExpand && !isOpen) setExpanded(node.id, true)
        else if (isOpen && rows[idx + 1] && rows[idx + 1].depth > current!.depth) move(idx + 1)
        break
      case 'ArrowLeft': {
        if (!node) break
        if (canExpand && isOpen) {
          setExpanded(node.id, false)
        } else {
          const parentId = findParentId(items, node.id)
          if (parentId) setFocusedId(parentId)
        }
        break
      }
      case 'Enter':
        if (!node) break
        if (folderPickMode) {
          if (node.type === 'folder') onPickFolder?.(node.id)
        } else if (node.type === 'folder') {
          setExpanded(node.id, !isOpen)
        } else {
          onRequestSelect?.(node)
        }
        break
      case 'F2':
        if (node && !folderPickMode) setRenamingId(node.id)
        break
      case 'Delete': {
        if (folderPickMode) break
        const targets = deleteTargets(node ?? null)
        if (targets.length > 0) setPendingDelete(targets)
        break
      }
      default:
        if (mod && e.key.toLowerCase() === 'c' && !folderPickMode) {
          const count = copyItems(node?.id)
          if (count > 0) toast.success(`${count} item${count === 1 ? '' : 's'} copied`)
        } else if (mod && e.key.toLowerCase() === 'v' && !folderPickMode) {
          if (!pasteInto(node)) toast.info('Nothing to paste')
        } else {
          handled = false
        }
    }

    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }, [
    getVisibleRows, focusedId, uniqueFilteredItems, effectiveExpandedIds, setExpanded, items,
    folderPickMode, onPickFolder, onRequestSelect, copyItems, pasteInto,
    // selectedIds saiu: quem o lê agora é o deleteTargets, que já o captura.
    deleteTargets,
  ])

  /*
   * ============================================================
   * FAVORITOS
   * ============================================================
   */
  const starred = useMemo(() => collectStarred(items), [items])
  const [favoritesOpen, setFavoritesOpen] = useState(loadFavoritesOpen)

  const toggleFavoritesOpen = () => {
    setFavoritesOpen(prev => {
      try { localStorage.setItem(FAVORITES_OPEN_STORAGE_KEY, String(!prev)) } catch {}
      return !prev
    })
  }

  // Clique num favorito: abre o caminho até ele e põe o foco na linha. Pasta
  // também abre ela mesma; request/example abre a aba.
  const openFavorite = useCallback((item: CollectionItem) => {
    const path = findPathToItem(items, item.id) ?? []
    expandPath(item.type === 'folder' ? [...path, item.id] : path)
    setFocusedId(item.id)
    if (item.type !== 'folder') onRequestSelect?.(item)
    requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }))
  }, [items, expandPath, onRequestSelect])

  const handleDragStart = (event: DragStartEvent) => {
    const node = findNode(uniqueFilteredItems, event.active.id as string)
    setActiveItem(node)
    setDropIndicator(null)
    const activator = event.activatorEvent as PointerEvent
    dragStartXRef.current = activator?.clientX ?? null
    pointerXRef.current = activator?.clientX ?? null
  }

  // Calcula, em tempo real, se o item deve ir "antes", "depois" ou "dentro"
  // do alvo.
  //
  // Não usa o `over` do dnd-kit de propósito. O nó droppable registrado por
  // cada TreeNode é o wrapper de FORA, que numa pasta aberta engloba toda a
  // subárvore — então `over.rect` de uma pasta aberta tinha centenas de
  // pixels de altura e o `closestCenter` comparava o cursor com o centro
  // desse bloco inteiro, não com a linha da pasta. Resultado: passar por
  // cima da linha de "Order" resolvia pra outro nó (ou pra posição errada) e
  // o drop nunca virava "irmão acima da pasta".
  //
  // Aqui a decisão é feita por hit-test do ponteiro contra as LINHAS reais
  // (22px, marcadas com data-tree-row em TreeNode) — exatamente o que o
  // usuário está vendo. Também roda a cada pointermove, e não só quando o
  // alvo muda (o dnd-kit só dispara onDragOver na troca de alvo, o que
  // congelava o "dentro" ao entrar pelo meio de uma pasta).
  const updateDropIndicator = () => {
    const pointerY = pointerYRef.current
    const pointerX = pointerXRef.current
    const container = scrollRef.current
    const dragged = activeItem

    if (pointerY == null || !container || !dragged) {
      setDropIndicator(null)
      return
    }

    // As linhas da própria subárvore arrastada saem da lista: elas não são
    // alvo válido (moveNode recusaria o ciclo) e, como vizinhas, bagunçariam
    // o cálculo de nível abaixo — o item arrastado não vai estar ali no fim.
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-tree-row]')
    ).filter((row) => {
      const id = row.dataset.treeRow
      return !!id && !isDescendantOf(dragged, id)
    })

    const depthOf = (row: HTMLElement) => Number(row.dataset.treeRowDepth ?? 0)

    let hit = -1
    let rect: DOMRect | null = null

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (pointerY >= r.top && pointerY <= r.bottom) {
        hit = i
        rect = r
        break
      }
    }

    // Fora de qualquer linha (áreas vazias da árvore, ou em cima da própria
    // subárvore arrastada) — sem indicador.
    if (hit === -1 || !rect) {
      setDropIndicator(null)
      return
    }

    const hitRow = rows[hit]
    const hitId = hitRow.dataset.treeRow!
    const relativeY = pointerY - rect.top

    // Pasta: "dentro" ocupa o miolo da linha e sobra só uma faixa fina nas
    // bordas pra virar irmão (antes/depois). Dividir em terços dava ~7px por
    // zona numa linha de 22px e acertar o "dentro" virava sorte; a borda fixa
    // torna o gesto previsível sem tirar o espaço de soltar entre duas pastas.
    if (
      hitRow.dataset.treeRowType === 'folder' &&
      relativeY > FOLDER_EDGE &&
      relativeY < rect.height - FOLDER_EDGE
    ) {
      setDropIndicator((current) =>
        current && current.id === hitId && current.position === 'inside'
          ? current
          : { id: hitId, position: 'inside' }
      )
      return
    }

    // Fora do miolo, o drop é "entre duas linhas". Normaliza pra sempre ser
    // "depois da linha de cima": antes-da-linha-X e depois-da-linha-anterior
    // são o mesmo ponto de inserção, e tratar um caso só simplifica o resto.
    const above = relativeY < rect.height / 2 ? hit - 1 : hit

    // Inserir acima de tudo: não há nível pra subir, o único destino possível
    // é virar irmão da primeira linha.
    if (above < 0) {
      setDropIndicator((current) =>
        current && current.id === hitId && current.position === 'before'
          ? current
          : { id: hitId, position: 'before' }
      )
      return
    }

    // Quanto o ponteiro andou pra esquerda desde o início do arraste é o que
    // decide quantos níveis o item sobe.
    const startX = dragStartXRef.current
    const outdent =
      pointerX == null || startX == null
        ? 0
        : Math.max(0, Math.floor((startX - pointerX) / OUTDENT_STEP))

    const projected = projectSiblingDrop(
      rows.map((row) => ({ id: row.dataset.treeRow!, depth: depthOf(row) })),
      above,
      outdent
    )

    const next: DropIndicator = {
      id: rows[above].dataset.treeRow!,
      position: 'after',
      targetId: projected.targetId,
      indentDepth: projected.depth,
    }

    // Só atualiza quando algo mudou de fato: isso roda a cada movimento do
    // ponteiro, e re-renderizar a árvore inteira nesse ritmo travaria o
    // arraste.
    setDropIndicator((current) =>
      current &&
      current.id === next.id &&
      current.position === next.position &&
      current.targetId === next.targetId &&
      current.indentDepth === next.indentDepth
        ? current
        : next
    )
  }

  const handleDragOver = (_event: DragOverEvent) => updateDropIndicator()
  const handleDragMove = (_event: DragMoveEvent) => updateDropIndicator()

  const handleDragEnd = (event: DragEndEvent) => {
    const { active } = event
    const indicator = dropIndicator

    setActiveItem(null)
    setDropIndicator(null)
    pointerYRef.current = null
    pointerXRef.current = null
    dragStartXRef.current = null

    // O alvo é o do indicador (o que estava desenhado na tela), não o `over`
    // do dnd-kit — ver o comentário em updateDropIndicator.
    if (!indicator) return

    const targetId = indicator.targetId ?? indicator.id
    if (active.id === targetId) return

    const updated = moveNode(
      items,
      active.id as string,
      targetId,
      indicator.position
    )
    onUpdateItems(updated)
  }

  return (
    <div className="h-full flex flex-col pb-2"> 
      <TreeSearch value={search} onChange={setSearch} onArrowDown={focusTree} />

      {/* Barra de marcadores: só os que estão em uso, logo abaixo da busca.
          Chip aceso = filtrando. Vários acesos é OU — "flaky ou smoke" é o
          que se quer ao varrer; E deixaria quase tudo vazio. */}
      {filterBarMarkers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
          {filterBarMarkers.map(marker => {
            const on = activeFilterIds.includes(marker.id)
            return (
              <button
                key={marker.id}
                onClick={() => toggleFilterMarker(marker.id)}
                title={on ? `Stop filtering by "${marker.name}"` : `Filter by "${marker.name}"`}
                className={`flex items-center gap-1.5 rounded-full border px-2 py-[2px] text-[10.5px] transition-colors ${
                  on
                    ? 'border-transparent text-pm-text'
                    : 'border-pm-border text-pm-text-muted hover:text-pm-text'
                }`}
                style={on ? { backgroundColor: `${marker.color}28`, borderColor: marker.color } : undefined}
              >
                <MarkerGlyph color={marker.color} size={11} className="shrink-0" />
                <span className="max-w-[110px] truncate">{marker.name}</span>
              </button>
            )
          })}
          {activeFilterIds.length > 0 && (
            <button
              onClick={() => setFilterMarkerIds([])}
              className="px-1 text-[10.5px] text-pm-text-muted hover:text-pm-text"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Favoritos: atalhos pras pastas favoritadas (em qualquer nível).
          Some durante a busca pra não disputar espaço com os resultados. */}
      {!isSearching && starred.length > 0 && (
        <div className="shrink-0 px-1.5 pb-1.5">
          <button
            type="button"
            onClick={toggleFavoritesOpen}
            className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-[10px] font-bold uppercase tracking-wider text-pm-text-muted hover:text-pm-text-secondary cursor-pointer"
          >
            <ChevronRight
              size={11}
              style={{
                transform: favoritesOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 150ms ease',
              }}
            />
            Favorites
            <span className="font-normal tabular-nums">({starred.length})</span>
          </button>

          {favoritesOpen && (
            <div className="max-h-[132px] overflow-y-auto">
              {starred.map(({ item, rootName }) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openFavorite(item)}
                  title={rootName ? `${rootName} / ${item.name}` : item.name}
                  className="flex h-[22px] w-full items-center gap-1.5 rounded-[5px] pl-5 pr-2 text-left text-[12px] text-pm-text hover:bg-pm-hover cursor-pointer"
                >
                  <Star size={11} className="shrink-0 text-amber-400 fill-amber-400" />
                  {item.type === 'folder' ? (
                    <Folder size={12} className="shrink-0 text-pm-text-muted" />
                  ) : item.type === 'example' ? (
                    <FileText size={11} className="shrink-0 text-pm-text-muted" />
                  ) : (
                    <span
                      className="shrink-0 font-mono text-[9px] font-semibold"
                      style={{ color: METHOD_COLORS[item.method ?? ''] ?? '#888' }}
                    >
                      {item.method === 'DELETE' ? 'DEL' : item.method ?? 'GET'}
                    </span>
                  )}
                  <span className="truncate">{item.name}</span>
                  {rootName && (
                    <span className="ml-auto shrink-0 max-w-[45%] truncate text-[10px] text-pm-text-muted">
                      {rootName}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="mx-1.5 mt-1 h-px bg-pm-border" />
        </div>
      )}

      {/* As "setinhas" nativas repetidas que apareciam aqui não eram do
          scrollbar deste container — vinham de cada linha da árvore
          (TreeNode) tendo overflow-x-hidden sem overflow-y explícito, o
          que fazia o WebView2 tratar cada linha como sua própria caixa de
          rolagem vertical. Corrigido usando overflow-x: clip nas linhas
          (TreeNode.tsx), que não cria contexto de rolagem. Este container
          agora pode expor a scrollbar normalmente. */}
      <div className="flex-1 min-h-0">
      <div
        ref={scrollRef}
        className="tree-scroll h-full overflow-y-auto overflow-x-hidden outline-none"
        onContextMenu={handleBackgroundContextMenu}
        onClick={handleClearSelection}
        // Navegação por teclado: ↑↓ Home End, → abre / entra, ← fecha / sobe
        // pro pai, Enter abre, F2 renomeia, Del apaga, Ctrl+C / Ctrl+V.
        tabIndex={0}
        onKeyDown={handleTreeKeyDown}
        onFocus={handleTreeFocus}
        onBlur={handleTreeBlur}
      >
        {uniqueFilteredItems.length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-pm-text-muted">
            {isSearching ? (
              <>
                No results for <b className="text-pm-text-secondary">&ldquo;{search.trim()}&rdquo;</b>.
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="ml-1 text-[#3794ff] hover:underline cursor-pointer"
                >
                  Clear filter
                </button>
              </>
            ) : (
              'No collections yet. Use + to create one or the import button to bring one from Postman.'
            )}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDropIndicator(null)}
          >
            <SortableContext items={rootIds} strategy={verticalListSortingStrategy}>
              {uniqueFilteredItems.map((item, index) => (
                <TreeNode
                  key={`${item.id}-${index}`}
                  item={item}
                  depth={0}
                  isPendingPush={pendingPushIds?.has(item.id)}
                  activeRequestId={activeRequestId}
                  onRequestSelect={onRequestSelect}
                  actions={actionsWithImport}
                  isDragging={activeItem?.id === item.id}
                  dropIndicator={dropIndicator}
                  selectedIds={selectedIds}
                  onToggleSelect={handleToggleSelect}
                  onRowContextMenu={handleRowContextMenu}
                  expandedIds={effectiveExpandedIds}
                  onSetExpanded={setExpanded}
                  focusedId={treeFocused ? focusedId : null}
                  onRowFocus={handleRowFocus}
                  renamingId={renamingId}
                  onRenameHandled={handleRenameHandled}
                  searchTokens={searchTokens}
                  markerMap={markerMap}
                  onMarkerClick={onMarkersChange ? handleMarkerClick : undefined}
                  folderPickMode={folderPickMode}
                  onPickFolder={onPickFolder}
                />
              ))}
            </SortableContext>

            <DragOverlay
              dropAnimation={{
                duration: 150,
                easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
              }}
            >
              {activeItem && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    height: '22px',
                    padding: '0 8px',
                    borderRadius: '3px',
                    background: '#2c313a',
                    border: '1px solid #404754',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.5), 0 1px 4px rgba(0,0,0,0.3)',
                    fontSize: '12px',
                    color: '#c9d1d9',
                    width: '100%',
                    cursor: 'grabbing',
                    userSelect: 'none',
                    opacity: 0.97,
                  }}
                >
                  <GripVertical size={11} style={{ color: '#6b7280', flexShrink: 0 }} />

                  {activeItem.type === 'folder' ? (
                    <Folder size={13} style={{ color: '#6b7280', flexShrink: 0 }} />
                  ) : (
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        width: '38px',
                        flexShrink: 0,
                        color: METHOD_COLORS[activeItem.method ?? ''] ?? '#888',
                      }}
                    >
                      {activeItem.method}
                    </span>
                  )}

                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activeItem.name}
                  </span>
                </div>
              )}
            </DragOverlay>
          </DndContext>
        )}
      </div>
      </div>

      {curlDialogParentId && (
        <ImportCurlDialog
          open={!!curlDialogParentId}
          onClose={() => setCurlDialogParentId(null)}
          onImport={(parsedRequest) => {
            actions.createRequestFromCurl(curlDialogParentId, parsedRequest)
            setCurlDialogParentId(null)
          }}
        />
      )}

      {contextMenu && (
        <TreeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          targetItem={contextMenu.item}
          selectionCount={selectedIds.size}
          canPaste={contextMenu.canPaste}
          onCopy={() => handleCopySelected(contextMenu.item?.id)}
          onRename={
            contextMenu.item ? () => setRenamingId(contextMenu.item!.id) : undefined
          }
          onPaste={handlePaste}
          move={contextMenu.item ? buildMoveActions(contextMenu.item.id) : undefined}
          numberableCount={contextMenu.item?.item?.length ?? 0}
          onNumberChildren={
            contextMenu.item?.type === 'folder'
              ? () => handleNumberChildren(contextMenu.item!.id)
              : undefined
          }
          markers={
            onMarkersChange
              ? {
                  catalog: markerCatalog,
                  state: contextMarkerState,
                  onToggle: handleToggleMarker,
                  onCreate: handleCreateMarker,
                  onRecolor: handleRecolorMarker,
                  onManage: () => setManagingMarkers(true),
                }
              : undefined
          }
          openAllCount={contextOpenAll.length}
          onOpenAll={
            onOpenAllRequests ? () => onOpenAllRequests(contextOpenAll) : undefined
          }
          onSaveDescription={
            contextMenu.item
              ? text => handleSaveDescription(contextMenu.item!.id, text)
              : undefined
          }
          onDelete={() => deleteNodes(contextDeleteTargets)}
          deleteHasFolder={contextDeleteTargets.some(n => n.type === 'folder')}
          onClose={() => setContextMenu(null)}
        />
      )}

      {openMarker && markerMap.has(openMarker.markerId) && (
        <MarkerPopover
          x={openMarker.x}
          y={openMarker.y}
          marker={{ id: openMarker.markerId, ...markerMap.get(openMarker.markerId)! }}
          itemName={openMarker.itemName}
          // Lido da árvore a cada render, não congelado na abertura: o
          // mesmo item pode ser editado por outro caminho com isto aberto.
          note={markerNote(findNode(items, openMarker.itemId) ?? ({} as CollectionItem), openMarker.markerId)}
          onSaveNote={text => handleSaveMarkerNote(openMarker.itemId, openMarker.markerId, text)}
          onRemove={() => handleRemoveMarkerHere(openMarker.itemId, openMarker.markerId)}
          onClose={() => setOpenMarker(null)}
        />
      )}

      {onMarkersChange && (
        <MarkersDialog
          open={managingMarkers}
          catalog={markerCatalog}
          counts={markerUsage}
          onChange={onMarkersChange}
          onDelete={handleDeleteMarker}
          onClose={() => setManagingMarkers(false)}
        />
      )}

      {/* Confirmação da tecla Delete — é o único gesto sem um menu aberto
          onde confirmar em linha (os menus "…" e de clique direito
          confirmam dentro de si mesmos). */}
      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null)
            requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }))
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete && pendingDelete.length > 1
                ? `Delete ${pendingDelete.length} items?`
                : `Delete "${pendingDelete?.[0]?.name ?? ''}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.some(n => n.type === 'folder')
                ? 'Everything inside will be deleted too. This can’t be undone.'
                : 'This can’t be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  )
}

