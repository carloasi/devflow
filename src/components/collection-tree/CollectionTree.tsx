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
  markerCounts,
  markerNote,
  purgeMarker,
  removeMarker,
  setMarkerNote,
  recolorMarker,
  toggleMarker,
} from '@/lib/markers'
import { TreeNode, treeRowDomId } from './TreeNode'
import {
  TREE_ROW_HEIGHT,
  flattenVisibleTree,
  visibleRange,
  scrollTopToReveal,
  findTypeAheadMatch,
  keepVisibleSelection,
  rangeIds,
  activeGuide,
} from './utils/treeRows'
import { TreeSearch } from './TreeSearch'
import { MarkersDialog } from './MarkersDialog'
import { MarkerPopover } from './MarkerPopover'
import { scanTree, type SecretFinding } from '@/lib/secretScan'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useDraggableDialog } from '@/components/helper/useDraggableDialog'
import { MarkerGlyph } from './MarkerGlyph'
import { TreeContextMenu } from './TreeContextMenu'
import { useCollectionTree } from './hooks/useCollectionTree'
import {
  moveNode,
  findNodeById,
  findParentId,
  findPathToItem,
  projectSiblingDrop,
  DropPosition,
  parseTreeQuery,
  setDescription,
  collectExpandableIds,
  collectRequests,
  collectStarred,
  countRequests,
  removeNode,
  canDropAt,
  resolvePasteParent,
  countPlaceable,
  topLevelInTreeOrder,
  moveNodes,
  restoreMoved,
  moveNodesInto,
  rootIdOf,
  pruneExpandedIds,
  captureRemoval,
  restoreRemoved,
  positionOf,
  restorePosition,
  moveUp,
  moveDown,
  moveToFirst,
  moveToLast,
  moveOut,
  canMoveUp,
  canMoveDown,
  canMoveOut,
  numberFolderChildren,
  restoreNames,
} from './utils/tree.utils'
import { buildItemCurl, buildItemUrl } from './utils/requestCopy'
import { ArrowUpRight, ChevronRight, FileText, Folder, GripVertical, KeyRound, ShieldAlert, Star, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { ExportFlowHtmlDialog, type ExportFlowHtmlChoice } from './ExportFlowHtmlDialog'
import type { ActionMenuView } from './TreeActionMenu'
import { shortcutFor } from './treeShortcuts'
import { ImportCurlDialog } from '../SlidePanel/ImportCurlDialog'
import { copyItemsToClipboard, cutItemsToClipboard, getCutIds, clearCut, clearClipboard, getClipboardItems, hasClipboardItems } from '@/storage/treeClipboard'
import { useEnvironment } from '@/components/EnvironmentContext'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buildEnvMap } from '@/lib/envMap';


/** Pendência de uma collection desde a última sincronização. */
export interface PendingDetail {
  count: number
  changed: ReadonlySet<string>
}

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
  // Abre a Central de Sincronização filtrada na collection do item.
  onOpenSync?: (item: CollectionItem) => void
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
  // Detalhe da pendência por collection: quantas alterações e quais itens
  // (ver lib/syncBase.pendingChanges). Ausente = só o ponto.
  pendingChanges?: Map<string, PendingDetail>
  // Workspace aberto: filtro e rolagem são lembrados por workspace.
  workspaceKey?: string
  // Catalogo de marcadores do workspace (ver lib/markers.ts). Vem de cima
  // porque e do WORKSPACE, nao da arvore: a mesma lista vale pra todas as
  // collections, e quem a persiste e o AppLayout.
  markers?: Marker[]
  onMarkersChange?: (markers: Marker[]) => void
  // Pedido de "abre onde está o item X" vindo de FORA da árvore (ex: um
  // achado clicado no scanner de segredos, em Settings → Security — uma
  // tela que não tem acesso nenhum ao estado interno daqui). O `nonce`
  // garante que pedir o MESMO id de novo (clicar o mesmo achado duas vezes)
  // ainda dispara o efeito — comparar só o id não mudaria.
  focusRequest?: { id: string; nonce: number } | null
}

// Pastas abertas, persistidas entre sessões (antes tudo reabria fechado).
const EXPANDED_STORAGE_KEY = 'devflow_tree_expanded'
const FAVORITES_OPEN_STORAGE_KEY = 'devflow_tree_favorites_open'
const MAX_PERSISTED_EXPANDED = 5000
// Pausa máxima entre teclas pra continuar a mesma busca por digitação.
const TYPE_AHEAD_MS = 800
const VIEW_BY_WORKSPACE_KEY = 'devflow_tree_view_by_workspace'

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
  // Lado de targetId em que o item entra, quando difere de `position` (que é
  // o lado da linha em que o traço é desenhado): soltar logo abaixo de uma
  // pasta aberta desenha o traço DEPOIS da pasta e põe o item ANTES do
  // primeiro filho dela.
  targetPosition?: 'before'
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

// True se `id` está na subárvore de `node` (o próprio nó incluído).
/**
 * Avisa quando o colar deixou itens de fora (ver canPlaceNode): antes eles
 * sumiam calados, e colar uma request no espaço vazio não fazia nada.
 */
function reportPasteSkips(total: number, pasted: number, atRoot: boolean) {
  if (pasted === total) return
  const where = atRoot
    ? 'Only folders can be collections: paste requests into a collection.'
    : "Saved examples only go inside a request, and requests can't go inside a request."
  if (pasted === 0) toast.error(`Can't paste here. ${where}`)
  else toast.warning(`Pasted ${pasted} of ${total} items. ${where}`)
}

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
  onOpenSync,
  onAddExampleItem,
  folderPickMode,
  onPickFolder,
  collapseAllToken,
  pendingPushIds,
  pendingChanges,
  workspaceKey,
  markers,
  onMarkersChange,
  focusRequest,
}: Props) {
  const { search, setSearch, filteredItems, revealIds, reveal, actions } = useCollectionTree({
    items,
    onUpdateItems,
    onRename
  })

  // Árvore mais recente, pro "Undo" dos toasts: ele é clicado segundos
  // depois, e a closure da ação já teria uma árvore velha.
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  // Mover vários (arraste da seleção, recortar e colar): um toast e um Undo
  // pro grupo inteiro, cada item de volta ao lugar de antes (restoreMoved).
  const moveGroupWithUndo = useCallback((ids: string[], next: CollectionItem[]): boolean => {
    if (next === items) return false
    const before = captureRemoval(items, ids)
    const moved = before.filter(entry => {
      const now = positionOf(next, entry.node.id)
      return !now || now.parentId !== entry.parentId || now.index !== entry.index
    }).length
    onUpdateItems(next)
    toast(moved === 1 ? `Moved "${before[0]?.node.name ?? 'Item'}"` : `Moved ${moved} items`, {
      action: {
        label: 'Undo',
        onClick: () => onUpdateItems(restoreMoved(itemsRef.current, before)),
      },
      duration: 5000,
    })
    return true
  }, [items, onUpdateItems])

  // Mover com desfazer: menu "Move…" e arraste. O Undo devolve só o item
  // movido ao lugar de antes (restorePosition), sem desfazer o resto.
  const moveWithUndo = useCallback((id: string, next: CollectionItem[]) => {
    if (next === items) return
    const before = positionOf(items, id)
    const name = findNodeById(items, id)?.name ?? 'Item'
    onUpdateItems(next)
    if (!before) return
    toast(`Moved "${name}"`, {
      action: {
        label: 'Undo',
        onClick: () => onUpdateItems(restorePosition(itemsRef.current, id, before)),
      },
      duration: 5000,
    })
  }, [items, onUpdateItems])
  const { activeEnv, environments } = useEnvironment()
  // Pasta cujo "Export as HTML runner" está com a janela de escolhas aberta.
  const [exportHtmlItem, setExportHtmlItem] = useState<CollectionItem | null>(null)

  const [activeItem, setActiveItem] = useState<CollectionItem | null>(null)
  // Os itens arrastados juntos quando o arraste começa numa linha selecionada
  // (vazio = só o activeItem).
  const dragNodesRef = useRef<CollectionItem[]>([])
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

  // Id do item cujo menu "..." (TreeActionMenu) está aberto. Os dois menus
  // da árvore — este e o de clique direito acima — são componentes
  // independentes, sem nada em comum; sem isto, abrir um nunca fechava o
  // outro.
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null)
  // Vista em que o "..." abre: 'main' pelo mouse; Markers/descrição quando
  // quem abre é o atalho M / Shift+M (ver treeShortcuts).
  const [actionMenuView, setActionMenuView] = useState<ActionMenuView>('main')

  const handleActionMenuOpenChange = useCallback((itemId: string, open: boolean) => {
    if (open) {
      // O "..." vai abrir: o de clique direito não pode continuar na tela.
      setContextMenu(null)
      setActionMenuView('main')
      setOpenActionMenuId(itemId)
    } else {
      // Só fecha se for ESTE que estava aberto — evita a corrida em que o
      // onOpenChange(false) de um item antigo chega depois do onOpenChange
      // (true) de um novo e apaga o que acabou de abrir.
      setOpenActionMenuId(prev => (prev === itemId ? null : prev))
    }
  }, [])

  // De onde o Shift+Click / Shift+seta conta o intervalo: o último item
  // escolhido com Ctrl+Click ou clique comum.
  const selectionAnchorRef = useRef<string | null>(null)
  // Linhas visíveis atuais, pros handlers estáveis abaixo (flatRows vem
  // depois no corpo do componente).
  const visibleIdsRef = useRef<Array<{ id: string }>>([])

  const handleRangeSelect = useCallback((id: string) => {
    const range = rangeIds(visibleIdsRef.current, selectionAnchorRef.current, id)
    if (range.length === 0) return
    selectionAnchorRef.current ??= id
    setSelectedIds(new Set(range))
  }, [])

  const handleToggleSelect = useCallback((id: string) => {
    selectionAnchorRef.current = id
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
  //
  // Com um menu ou a confirmação de exclusão aberta, o Esc é DELES: fechar o
  // menu de clique direito (ou cancelar o "Delete 3 items") com Esc também
  // apagava a seleção em que eles iam agir.
  const escOwnedElsewhere = !!contextMenu || !!openActionMenuId
  useEffect(() => {
    if (selectedIds.size === 0 || escOwnedElsewhere) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      handleClearSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectedIds.size, escOwnedElsewhere, handleClearSelection])

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
    // O de clique direito vai abrir: fecha o "..." que porventura esteja
    // aberto em outra linha — mesma regra do sentido contrário, em
    // handleActionMenuOpenChange.
    setOpenActionMenuId(null)
    setContextMenu({ x: e.clientX, y: e.clientY, item, canPaste: hasClipboardItems() })
  }, [])

  const handleBackgroundContextMenu = useCallback((e: React.MouseEvent) => {
    // Só dispara quando o clique é realmente no espaço vazio (não veio de
    // uma linha da árvore, que já dá stopPropagation no próprio handler).
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    setOpenActionMenuId(null)
    setContextMenu({ x: e.clientX, y: e.clientY, item: null, canPaste: hasClipboardItems() })
  }, [])

  // Copia os itens selecionados (Ctrl/Cmd+Click) — ou, sem seleção, o
  // `fallbackId` (linha com foco de teclado). Retorna quantos copiou.
  const copyItems = useCallback((fallbackId?: string | null): number => {
    const ids = selectedIds.size > 0 ? Array.from(selectedIds) : fallbackId ? [fallbackId] : []
    // Na ordem da árvore e sem o que já vem dentro de outro escolhido: uma
    // pasta e um filho dela selecionados colavam o filho duas vezes.
    const nodes = topLevelInTreeOrder(items, ids)
    if (nodes.length === 0) return 0
    copyItemsToClipboard(nodes)
    setCutIds(prev => (prev.size === 0 ? prev : new Set()))
    return nodes.length
  }, [items, selectedIds])

  // Recortar (Ctrl+X): o próximo colar MOVE estes itens (ver pasteCut). As
  // linhas recortadas ficam esmaecidas até lá.
  const [cutIds, setCutIds] = useState<ReadonlySet<string>>(() =>
    typeof window === 'undefined' ? new Set() : new Set(getCutIds())
  )
  const cutItems = useCallback((fallbackId?: string | null): number => {
    const ids = selectedIds.size > 0 ? Array.from(selectedIds) : fallbackId ? [fallbackId] : []
    const nodes = topLevelInTreeOrder(items, ids)
    if (nodes.length === 0) return 0
    cutItemsToClipboard(nodes)
    setCutIds(new Set(nodes.map(n => n.id)))
    toast.success(`${nodes.length} item${nodes.length === 1 ? '' : 's'} cut. Paste to move.`)
    return nodes.length
  }, [items, selectedIds])

  // Colar de um recorte: move os originais em vez de copiar. null = não há
  // recorte valendo (nada recortado, ou os originais não estão nesta
  // árvore — aí o colar segue como cópia, do que ficou no clipboard).
  const pasteCut = useCallback((place: (ids: string[]) => CollectionItem[]): boolean | null => {
    const present = getCutIds().filter(id => findNodeById(items, id))
    if (present.length === 0) {
      clearCut()
      setCutIds(prev => (prev.size === 0 ? prev : new Set()))
      return null
    }
    const next = place(present)
    if (!moveGroupWithUndo(present, next)) {
      toast.error("Can't move here. Collections only hold folders, and requests can't go inside a request.")
      return false
    }
    // Recorte é de uso único, como no Explorer: depois de colado o
    // clipboard esvazia. Antes só o recorte saía e as CÓPIAS guardadas
    // ficavam — o Ctrl+V seguinte colava duplicatas do que foi movido.
    clearClipboard()
    setCutIds(new Set())
    const left = present.filter(id => {
      const before = positionOf(items, id)
      const after = positionOf(next, id)
      return before && after && before.parentId === after.parentId && before.index === after.index
    }).length
    if (left > 0) toast.warning(`${left} item${left === 1 ? '' : 's'} couldn't go there and stayed where ${left === 1 ? 'it was' : 'they were'}.`)
    return true
  }, [items, moveGroupWithUndo])

  // Reordenar pelo menu de contexto. O que pode ser feito é calculado na
  // abertura do menu, pra que as entradas impossíveis nasçam desabilitadas em
  // vez de não fazer nada ao serem clicadas.
  const buildMoveActions = useCallback((id: string) => ({
    // canMoveUp/canMoveDown servem tanto pro passo único quanto pro pulo
    // direto (ver moveToFirst/moveToLast): a condição de habilitar é a
    // mesma, "não está já na ponta" — só o destino do pulo muda.
    canUp: canMoveUp(items, id),
    canDown: canMoveDown(items, id),
    canOut: canMoveOut(items, id),
    onUp: () => moveWithUndo(id, moveUp(items, id)),
    onDown: () => moveWithUndo(id, moveDown(items, id)),
    onToFirst: () => moveWithUndo(id, moveToFirst(items, id)),
    onToLast: () => moveWithUndo(id, moveToLast(items, id)),
    onOut: () => moveWithUndo(id, moveOut(items, id)),
  }), [items, moveWithUndo])

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
    // Sem o que está dentro de outro selecionado: some junto com ele, e
    // contado à parte dava "Delete 2 items" pra uma pasta e um filho dela.
    if (selectedIds.size > 0) return topLevelInTreeOrder(items, selectedIds)
    return fallback ? [fallback] : []
  }, [selectedIds, items])

  // O que o menu mostra em "Copy (N)" / "Delete (N)": o mesmo que as ações
  // vão atingir.
  const selectionCount = useMemo(
    () => (selectedIds.size > 0 ? topLevelInTreeOrder(items, selectedIds).length : 0),
    [selectedIds, items]
  )

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

  // Marcar mora só no menu "…" (TreeActionMenu) agora — um menu por LINHA,
  // então o alvo é sempre o próprio item dessa linha, nunca uma seleção.
  // Isso simplificou o que era "alguns dos selecionados têm" (estado
  // 'partial'): aqui só existe 'on' ou ausente.
  const handleToggleMarker = useCallback(
    (itemId: string, markerId: string) => {
      onUpdateItems(toggleMarker(items, [itemId], markerId))
    },
    [items, onUpdateItems]
  )

  // Cria e já aplica, no mesmo gesto. Nome repetido reaproveita o marcador
  // existente (createMarker devolve o que já havia), então digitar "flaky"
  // de novo marca com o "flaky" do time em vez de criar um segundo.
  const handleCreateMarker = useCallback(
    (itemId: string, name: string, color?: string) => {
      if (!onMarkersChange) return
      let result
      try {
        result = createMarker(markerCatalog, name, { color })
      } catch {
        return
      }
      if (!result.existed) onMarkersChange(result.catalog)
      onUpdateItems(applyMarker(items, [itemId], result.marker.id))
    },
    [markerCatalog, onMarkersChange, items, onUpdateItems]
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
    // Sobre um example, "o pai" é a request dona — colar requests ali as
    // punha entre os examples (ver resolvePasteParent).
    const parentId = resolvePasteParent(items, target, clipboardItems)
    if (pasteCut(ids => moveNodesInto(items, ids, parentId)) !== null) return true
    const fits = countPlaceable(items, parentId, clipboardItems)
    if (fits > 0) actions.pasteItems(parentId, clipboardItems)
    reportPasteSkips(clipboardItems.length, fits, parentId === null)
    return true
  }, [items, actions, pasteCut])

  const handlePaste = useCallback(() => {
    if (!contextMenu) return
    pasteInto(contextMenu.item)
  }, [contextMenu, pasteInto])

  // Cola como irmão de `target`, logo antes ou logo depois dele — em vez de
  // sempre no fim da lista do pai (que é o que pasteInto faz pra requests).
  // Só faz sentido com um alvo de verdade: sem ele não há "ao lado de quem".
  const pasteBeside = useCallback((target: CollectionItem, position: 'before' | 'after'): boolean => {
    const clipboardItems = getClipboardItems()
    if (clipboardItems.length === 0) return false
    // Requests coladas "ao lado" de um example vão pro lado da request dona:
    // ao lado do example seria dentro da request.
    let anchorId = target.id
    if (target.type === 'example' && !clipboardItems.every(n => n.type === 'example')) {
      anchorId = findParentId(items, target.id) ?? target.id
    }
    const parentId = findParentId(items, anchorId)
    if (parentId === undefined) return false
    if (pasteCut(ids => moveNodes(items, ids, anchorId, position)) !== null) return true
    const fits = countPlaceable(items, parentId, clipboardItems)
    if (fits > 0) actions.pasteItemsBeside(anchorId, clipboardItems, position)
    reportPasteSkips(clipboardItems.length, fits, parentId === null)
    return true
  }, [items, actions, pasteCut])

  const handlePasteBeside = useCallback((position: 'before' | 'after') => {
    if (!contextMenu?.item) return
    pasteBeside(contextMenu.item, position)
  }, [contextMenu, pasteBeside])

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

  // Antes de escrever o arquivo, checa por credencial literal (header,
  // auth, resposta salva) — exportar sem avisar é o jeito mais fácil de
  // mandar um JWT/Bearer de verdade pra quem importar. Sem achado, segue
  // direto pro export de sempre.
  //
  // Precisa ser um useCallback À PARTE, referenciado por nome dentro de
  // actionsWithImport (não um closure escrito ali dentro): um closure
  // inline chamando setPendingExportSecrets direto no objeto fazia o React
  // Compiler desistir de memoizar uma dúzia de outros callbacks do
  // componente, sem relação nenhuma com isto — confirmado comparando o lint
  // com/sem essa única mudança.
  // Grava e diz o resultado: sucesso, falha ao gravar, gRPC que ficaram de
  // fora. Os dois caminhos (direto e "Export anyway") passam por aqui.
  const runExport = useCallback(async (item: CollectionItem) => {
    try {
      const result = await actions.export(item)
      if (!result.saved) return
      toast.success(`"${item.name}" exported`, {
        description: result.skippedGrpc > 0
          ? `${result.skippedGrpc} gRPC request${result.skippedGrpc === 1 ? ' was' : 's were'} left out: the Postman format has no gRPC.`
          : undefined,
      })
    } catch (e) {
      toast.error(`Could not export "${item.name}"`, { description: (e as Error)?.message ?? String(e) })
    }
  }, [actions])

  const exportWithSecretCheck = useCallback(async (item: CollectionItem) => {
    const findings = scanTree([item])
    if (findings.length > 0) {
      setPendingExportSecrets({ item, findings })
      return
    }
    await runExport(item)
  }, [runExport])

  // "Export as HTML runner": o flow vira um .html que roda os passos no
  // navegador (lib/flowHtml). Primeiro abre a janela de escolhas
  // (environments, segredos — ExportFlowHtmlDialog); o export roda no OK.
  // useCallback à parte pelo mesmo motivo do exportWithSecretCheck acima.
  const exportFlowAsHtml = useCallback(async (item: CollectionItem) => {
    setExportHtmlItem(item)
  }, [])

  const runExportFlowHtml = useCallback(async (item: CollectionItem, choice: ExportFlowHtmlChoice) => {
    setExportHtmlItem(null)
    const pathOf = (list: CollectionItem[], trail: string[]): string[] | null => {
      for (const node of list) {
        const here = [...trail, node.name]
        if (node.id === item.id) return here
        const inner = node.item ? pathOf(node.item, here) : null
        if (inner) return inner
      }
      return null
    }
    try {
      const { exportFlowHtml } = await import('@/lib/flowHtml/exportFlowHtml')
      const result = await exportFlowHtml(item, { path: pathOf(items, []) ?? [item.name], ...choice })
      if (!result.saved) return
      toast.success(`"${item.name}" exported as ${choice.format === 'har' ? 'HAR' : 'an HTML runner'}`, {
        description:
          `${result.steps} step(s), ${result.environments} environment(s).` +
          (result.secrets === 0
            ? ''
            : result.secretsIncluded
            ? ` It contains ${result.secrets} secret value(s) — share it only within the team.`
            : ` ${result.secrets} secret value(s) were left out — whoever opens it pastes them in.`),
      })
    } catch (e) {
      toast.error('Could not export the flow', { description: (e as Error)?.message ?? String(e) })
    }
  }, [items])

  const openManageMarkers = useCallback(() => setManagingMarkers(true), [])

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
    const byMarker = filterTreeByMarkers(filteredItems, activeFilterIds, 'any', revealIds)
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
  }, [filteredItems, activeFilterIds, revealIds])

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

  // Descarta pastas que sumiram da árvore (apagadas aqui ou num pull). A poda
  // compara a árvore anterior com a nova em vez de "o que não está na atual":
  // a atual é só a do workspace aberto, e aquela regra apagava do disco as
  // pastas abertas de todos os outros workspaces (ver pruneExpandedIds).
  const prevItemsRef = useRef(items)
  useEffect(() => {
    const prev = prevItemsRef.current
    prevItemsRef.current = items
    if (prev === items) return
    setExpandedIds(current => pruneExpandedIds(current, prev, items))
  }, [items])

  useEffect(() => {
    try {
      // Os mais recentes ficam (Set guarda a ordem de inserção): ids de itens
      // apagados por fora do app não podem fazer isto crescer sem limite.
      const ids = Array.from(expandedIds).slice(-MAX_PERSISTED_EXPANDED)
      localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(ids))
    } catch {}
  }, [expandedIds])

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

  // Fecha o nó e tudo o que está aberto dentro dele (Shift+←).
  const collapseSubtree = useCallback((id: string) => {
    const node = findNodeById(items, id)
    if (!node) return
    const inside = collectExpandableIds([node])
    inside.add(id)
    if (isSearching) {
      setSearchCollapsedIds(prev => {
        const next = new Set(prev)
        inside.forEach(x => next.add(x))
        return next
      })
    } else {
      setExpandedIds(prev => {
        if (![...inside].some(x => prev.has(x))) return prev
        const next = new Set(prev)
        inside.forEach(x => next.delete(x))
        return next
      })
    }
  }, [items, isSearching])

  // O que está visível, achatado na ordem da tela (ver treeRows).
  const flatRows = useMemo(
    () => flattenVisibleTree(uniqueFilteredItems, effectiveExpandedIds),
    [uniqueFilteredItems, effectiveExpandedIds]
  )
  const rowIndexById = useMemo(
    () => new Map(flatRows.map((row, i) => [row.item.id, i])),
    [flatRows]
  )

  // Selecionado é só o que está na tela (ver keepVisibleSelection).
  useEffect(() => {
    visibleIdsRef.current = flatRows.map(r => ({ id: r.item.id }))
    setSelectedIds(prev => keepVisibleSelection(prev, rowIndexById) as Set<string>)
  }, [rowIndexById])

  const expandPath = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setExpandedIds(prev => {
      if (ids.every(id => prev.has(id))) return prev
      const next = new Set(prev)
      ids.forEach(id => next.add(id))
      return next
    })
    // Durante a busca quem manda é o searchCollapsedIds: sem isto, revelar
    // um item (aba trocada, achado do scanner de segredos) não abria uma
    // pasta que o usuário tinha fechado nos resultados.
    setSearchCollapsedIds(prev => {
      if (!ids.some(id => prev.has(id))) return prev
      const next = new Set(prev)
      ids.forEach(id => next.delete(id))
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

  // Guia realçada: a da pasta da linha com foco (ou da aba ativa).
  const guide = useMemo(() => {
    // Com a árvore sem foco vale a aba ativa: o foco que ficou pra trás
    // não diz mais onde a pessoa está.
    const id = (treeFocused ? focusedId : null) ?? activeRequestId ?? focusedId
    const index = id ? rowIndexById.get(id) ?? -1 : -1
    return activeGuide(flatRows, index)
  }, [focusedId, treeFocused, activeRequestId, rowIndexById, flatRows])

  // Caminho até a aba ativa, mostrado acima da árvore. Cada parte leva ao
  // item na árvore.
  const breadcrumb = useMemo(() => {
    if (!activeRequestId) return null
    const path = findPathToItem(items, activeRequestId)
    if (!path) return null
    return [...path, activeRequestId]
      .map(id => findNodeById(items, id))
      .filter((n): n is CollectionItem => !!n)
  }, [items, activeRequestId])

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<CollectionItem[] | null>(null)
  // Achados de credencial literal (JWT, Bearer...) antes de um Export —
  // avisa e deixa escolher, em vez de simplesmente incluir no arquivo
  // (ver scanTree/secretScan.ts). `null` = nenhum export pendente.
  const [pendingExportSecrets, setPendingExportSecrets] = useState<{
    item: CollectionItem
    findings: SecretFinding[]
  } | null>(null)
  const exportSecretsDrag = useDraggableDialog()

  const handleRenameHandled = useCallback(() => setRenamingId(null), [])
  // Clique comum (sem Ctrl/Cmd) numa linha desfaz a seleção, como no
  // Explorer. Antes ela ficava: clicar numa request e apertar Delete apagava
  // os itens selecionados lá atrás, não a linha recém-clicada.
  const handleRowFocus = useCallback((id: string, plainClick?: boolean) => {
    setFocusedId(id)
    if (plainClick) selectionAnchorRef.current = id
    if (plainClick) setSelectedIds(prev => (prev.size > 0 ? new Set() : prev))
  }, [])
  const typeAheadRef = useRef({ buffer: '', at: 0 })

  // Linhas visíveis na ordem da tela — da lista achatada, não do DOM: só a
  // janela do scroll está desenhada.
  const getVisibleRows = useCallback(
    () => flatRows.map(r => ({ id: r.item.id, depth: r.depth, name: r.item.name })),
    [flatRows]
  )

  /*
   * ============================================================
   * JANELA DO SCROLL (virtualização)
   * ============================================================
   * Só as linhas que cabem na tela (mais uma folga) existem no DOM. O estado
   * guarda a FAIXA, não o scrollTop: rolar dentro da mesma faixa não
   * re-renderiza nada.
   */
  const [range, setRange] = useState({ start: 0, end: 60 })
  const updateRange = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const next = visibleRange(el.scrollTop, el.clientHeight, flatRows.length)
    setRange(prev => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [flatRows.length])

  // Itens mudados desde a última sincronização, de todas as collections.
  const changedIds = useMemo(() => {
    const all = new Set<string>()
    pendingChanges?.forEach(detail => detail.changed.forEach(id => all.add(id)))
    return all
  }, [pendingChanges])

  // Filtro e rolagem por workspace: trocar de workspace e voltar devolve a
  // árvore como estava. Guardado no localStorage (uma entrada por
  // workspace); sem storage, só não lembra.
  const pendingScrollRef = useRef<number | null>(null)
  const applyPendingScroll = () => {
    const el = scrollRef.current
    const top = pendingScrollRef.current
    if (!el || top === null || (top > 0 && el.scrollHeight <= el.clientHeight)) return
    pendingScrollRef.current = null
    el.scrollTop = top
    updateRange()
  }
  const viewByWorkspaceRef = useRef<Record<string, { search: string; scrollTop: number }> | null>(null)
  const shownWorkspaceRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (viewByWorkspaceRef.current === null) {
      try {
        viewByWorkspaceRef.current = JSON.parse(localStorage.getItem(VIEW_BY_WORKSPACE_KEY) ?? '{}') ?? {}
      } catch {
        viewByWorkspaceRef.current = {}
      }
    }
    const views = viewByWorkspaceRef.current!
    const previous = shownWorkspaceRef.current
    if (previous === workspaceKey) return
    if (previous) {
      views[previous] = { search, scrollTop: scrollRef.current?.scrollTop ?? 0 }
      try {
        localStorage.setItem(VIEW_BY_WORKSPACE_KEY, JSON.stringify(views))
      } catch {
        // sem storage: só não lembra
      }
    }
    shownWorkspaceRef.current = workspaceKey
    if (!workspaceKey) return
    const saved = views[workspaceKey]
    setSearch(saved?.search ?? '')
    // A rolagem só vale depois que as linhas do workspace novo estão lá: as
    // collections dele chegam do disco depois da troca (ver o efeito em
    // `items` abaixo). O rAF cobre o caso de elas já estarem carregadas.
    pendingScrollRef.current = saved?.scrollTop ?? 0
    requestAnimationFrame(() => requestAnimationFrame(applyPendingScroll))
    // Só a troca de workspace dispara: search/updateRange mudam o tempo todo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceKey])

  useEffect(() => {
    if (items.length > 0) requestAnimationFrame(applyPendingScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  // Ao fechar o app (ou a árvore desmontar), grava a vista do workspace atual.
  const searchRef = useRef(search)
  searchRef.current = search
  useEffect(() => {
    const save = () => {
      const key = shownWorkspaceRef.current
      const views = viewByWorkspaceRef.current
      if (!key || !views) return
      views[key] = { search: searchRef.current, scrollTop: scrollRef.current?.scrollTop ?? 0 }
      try {
        localStorage.setItem(VIEW_BY_WORKSPACE_KEY, JSON.stringify(views))
      } catch {
        // sem storage: só não lembra
      }
    }
    window.addEventListener('beforeunload', save)
    return () => {
      save()
      window.removeEventListener('beforeunload', save)
    }
  }, [])

  useEffect(() => {
    updateRange()
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateRange)
    observer.observe(el)
    return () => observer.disconnect()
  }, [updateRange])

  // Índices desenhados: a janela, mais a linha sendo arrastada se ela saiu
  // da tela — o dnd-kit perde o arraste se o nó dele é desmontado.
  const renderedIndexes = useMemo(() => {
    const start = Math.min(range.start, flatRows.length)
    const end = Math.min(range.end, flatRows.length)
    const out: number[] = []
    for (let i = start; i < end; i++) out.push(i)
    const dragIndex = activeItem ? rowIndexById.get(activeItem.id) : undefined
    if (dragIndex !== undefined && (dragIndex < start || dragIndex >= end)) out.push(dragIndex)
    return out
  }, [range, flatRows.length, activeItem, rowIndexById])

  // Total de requests de cada collection SEM filtro — o contador da raiz
  // mostra "achadas / total" durante a busca.
  const rootRequestTotals = useMemo(
    () => new Map(items.map(root => [root.id, countRequests(root)])),
    [items]
  )

  const scrollRowIntoView = useCallback((id: string, smooth = false): boolean => {
    const el = scrollRef.current
    const index = rowIndexById.get(id)
    if (!el || index === undefined) return false
    const top = scrollTopToReveal(index, el.scrollTop, el.clientHeight)
    if (top !== null) {
      el.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
      // Sem esperar o evento de scroll: ele chega depois (ou nem chega, com
      // a janela em segundo plano) e, até lá, a linha alvo não estaria
      // desenhada — o aria-activedescendant apontaria pra um id inexistente.
      // No smooth, a animação dispara os scrolls que faltam.
      if (!smooth) updateRange()
    }
    return true
  }, [rowIndexById, updateRange])

  // Mantém a linha com foco visível ao navegar. Rola uma vez por id: a
  // linha pode ainda não existir (pasta abrindo), então tenta de novo quando
  // as linhas mudam — mas, achada, não puxa mais o scroll de volta enquanto
  // o usuário rola com o mouse e abre/fecha pastas.
  const scrolledFocusRef = useRef<string | null>(null)
  useEffect(() => {
    if (!focusedId || scrolledFocusRef.current === focusedId) return
    if (scrollRowIntoView(focusedId)) scrolledFocusRef.current = focusedId
  }, [focusedId, treeFocused, scrollRowIntoView])

  // Rola até o item ativo (a aba selecionada) quando ele muda — também uma
  // vez por id, pelo mesmo motivo. Pula quando a troca veio de um clique na
  // própria linha: o primeiro clique de um duplo-clique rolaria a lista
  // embaixo do cursor e o segundo acertaria outra linha (comum com nomes
  // repetidos, como vários "01 - Token v1" em flows diferentes).
  const scrolledActiveRef = useRef<string | null>(null)
  const selfClickRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeRequestId || scrolledActiveRef.current === activeRequestId) return
    if (selfClickRef.current === activeRequestId) {
      scrolledActiveRef.current = activeRequestId
      return
    }
    if (scrollRowIntoView(activeRequestId, true)) scrolledActiveRef.current = activeRequestId
  }, [activeRequestId, scrollRowIntoView])

  const handleRowSelect = useCallback((item: CollectionItem) => {
    selfClickRef.current = item.id
    onRequestSelect?.(item)
  }, [onRequestSelect])

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
    // Voltando pra árvore, a linha com foco pode ter rolado pra fora da
    // tela: traz de volta (o efeito de foco só rola uma vez por id).
    scrolledFocusRef.current = null
    setFocusedId(current => {
      if (current) return current
      if (activeRequestId && findNodeById(items, activeRequestId)) return activeRequestId
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
    // Guardado ANTES de apagar: o Undo reinsere cada um no lugar de onde
    // saiu (restoreRemoved), sem desfazer o que foi editado depois.
    const removed = captureRemoval(items, nodes.map(n => n.id))
    const updated = nodes.reduce((acc, node) => removeNode(acc, node.id), items)
    onUpdateItems(updated)
    toast(
      nodes.length === 1 ? `Deleted "${nodes[0].name}"` : `Deleted ${nodes.length} items`,
      {
        action: {
          label: 'Undo',
          onClick: () => onUpdateItems(restoreRemoved(itemsRef.current, removed)),
        },
        duration: 8000,
      }
    )
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

  // Item recém-criado: aparece mesmo com filtro ativo (reveal), abre as
  // pastas até ele, recebe o foco e — pra pasta/request em branco — já entra
  // em rename. Antes o "New Request" nascia sem pedir nome e, com filtro,
  // sumia no próprio clique.
  const afterCreate = useCallback((parentId: string, newId: string, rename: boolean) => {
    reveal(newId)
    expandPath([...(findPathToItem(items, parentId) ?? []), parentId])
    setFocusedId(newId)
    if (rename) setRenamingId(newId)
  }, [items, reveal, expandPath])

  // Memoizado pelo mesmo motivo do `actions` do hook: desce pra todo TreeNode.
  const actionsWithImport = useMemo(() => ({
    ...actions,
    createRequest: (parentId: string) => {
      const id = actions.createRequest(parentId)
      afterCreate(parentId, id, true)
      return id
    },
    createGrpcRequest: (parentId: string) => {
      const id = actions.createGrpcRequest(parentId)
      afterCreate(parentId, id, true)
      return id
    },
    createFolder: (parentId: string) => {
      const id = actions.createFolder(parentId)
      afterCreate(parentId, id, true)
      return id
    },
    // Excluir pelo menu "…" passa pela mesma regra (e pelo mesmo Undo) da
    // tecla Delete e do clique direito.
    remove: (id: string) => {
      const node = findNodeById(items, id)
      if (node) deleteNodes([node])
    },
    export: exportWithSecretCheck,
    exportHtml: exportFlowAsHtml,
    copyUrl: (item: CollectionItem) => copyText(buildItemUrl(item, envMap), 'URL'),
    copyCurl: (item: CollectionItem) => copyText(buildItemCurl(item, envMap), 'cURL'),
    importCurl: (parentId: string) => setCurlDialogParentId(parentId),
    run: onRunItem ? (item: CollectionItem) => onRunItem(item) : undefined,
    loadTest: onLoadTestItem ? (item: CollectionItem) => onLoadTestItem(item) : undefined,
    pushCollection: onPushCollection ? (item: CollectionItem) => onPushCollection(item) : undefined,
    openSync: onOpenSync ? (item: CollectionItem) => onOpenSync(item) : undefined,
    addExample: onAddExampleItem
      ? (item: CollectionItem) => onAddExampleItem(actions.createExample(item))
      : undefined,
  }), [
    actions, afterCreate, items, deleteNodes, exportWithSecretCheck, exportFlowAsHtml, copyText,
    envMap, onRunItem, onLoadTestItem, onPushCollection, onOpenSync, onAddExampleItem,
  ])

  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isTextInput(e.target)) return

    const rows = getVisibleRows()
    if (rows.length === 0) return
    const idx = rows.findIndex(r => r.id === focusedId)
    const current = idx >= 0 ? rows[idx] : null
    const node = current ? findNodeById(uniqueFilteredItems, current.id) ?? null : null
    const isOpen = !!node && effectiveExpandedIds.has(node.id)
    const canExpand = !!node && (node.type === 'folder' || (node.item?.length ?? 0) > 0)
    const mod = e.ctrlKey || e.metaKey

    // Andar sem Shift muda de onde o próximo Shift+seta/Shift+Click conta:
    // da linha a que se chegou, não de um clique antigo.
    const move = (to: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))].id
      selectionAnchorRef.current = target
      setFocusedId(target)
    }

    // Busca por digitação (como no Explorer/VS Code): letras pulam pro item
    // cujo nome começa com o que foi digitado. F, R, N e M sozinhos são
    // atalhos da árvore (treeShortcuts), então uma sequência não começa
    // neles — mas, já começada, qualquer letra continua a sequência.
    const printable = e.key.length === 1 && !mod && !e.altKey && e.key !== ' '
    const typeAhead = typeAheadRef.current
    const typing = typeAhead.buffer !== '' && Date.now() - typeAhead.at < TYPE_AHEAD_MS
    const runTypeAhead = () => {
      const buffer = (typing ? typeAhead.buffer : '') + e.key
      typeAheadRef.current = { buffer, at: Date.now() }
      const found = findTypeAheadMatch(rows, idx, buffer)
      if (found >= 0) move(found)
    }

    // Shift+seta: estende a seleção da âncora até a linha nova.
    const moveAndExtend = (to: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))]
      if (!target) return
      const anchor = selectionAnchorRef.current ?? current?.id ?? target.id
      selectionAnchorRef.current = anchor
      setFocusedId(target.id)
      setSelectedIds(new Set(rangeIds(rows, anchor, target.id)))
    }

    let handled = true
    switch (e.key) {
      case 'ArrowDown':
        if (e.shiftKey && !folderPickMode) moveAndExtend(idx < 0 ? 0 : idx + 1)
        else move(idx < 0 ? 0 : idx + 1)
        break
      case 'ArrowUp':
        if (e.shiftKey && !folderPickMode) moveAndExtend(idx < 0 ? 0 : idx - 1)
        else move(idx < 0 ? 0 : idx - 1)
        break
      case ' ':
        // No meio da busca por digitação o espaço é parte do nome ("order
        // groups"); fora dela marca/desmarca a linha, como o Ctrl+Click.
        if (typing) runTypeAhead()
        else if (node && !folderPickMode) handleToggleSelect(node.id)
        else handled = false
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
        if (e.shiftKey) {
          // Shift+←: fecha a collection inteira do item (ela e tudo o que
          // está aberto dentro) e põe o foco nela.
          const rootId = rootIdOf(items, node.id)
          if (rootId) {
            collapseSubtree(rootId)
            setFocusedId(rootId)
          }
          break
        }
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
        if (printable && typing) {
          runTypeAhead()
          break
        }
        if (mod && e.key.toLowerCase() === 'c' && !folderPickMode) {
          const count = copyItems(node?.id)
          if (count > 0) toast.success(`${count} item${count === 1 ? '' : 's'} copied`)
        } else if (mod && e.key.toLowerCase() === 'x' && !folderPickMode) {
          cutItems(node?.id)
        } else if (mod && e.key.toLowerCase() === 'a' && !folderPickMode) {
          // Ctrl+A: todos os irmãos visíveis da linha com foco.
          if (current) {
            const parentId = findParentId(items, current.id) ?? null
            const siblings = flatRows.filter(r => r.parentId === parentId).map(r => r.item.id)
            setSelectedIds(new Set(siblings))
            selectionAnchorRef.current = siblings[0] ?? null
          }
        } else if (mod && e.key.toLowerCase() === 'v' && !folderPickMode) {
          if (!pasteInto(node)) toast.info('Nothing to paste')
        } else if (mod && e.key.toLowerCase() === 'd' && !folderPickMode) {
          // Mesmo alvo único do "Duplicate" do menu "..." — duplicar nunca
          // suportou seleção múltipla, então aqui também é só o item com foco.
          if (node) actions.duplicate(node.id)
        } else {
          // Os atalhos que o menu "..." mostra ao lado de cada ação (uma
          // tabela só, treeShortcuts). Sempre no item com foco.
          const shortcut = node && !folderPickMode ? shortcutFor(e) : null
          const isFolder = node?.type === 'folder'
          const openMenu = (view: ActionMenuView) => {
            setContextMenu(null)
            setActionMenuView(view)
            setOpenActionMenuId(node!.id)
          }
          switch (shortcut) {
            case 'favorite':
              if (actions.toggleStar) actions.toggleStar(node!.id)
              else handled = false
              break
            case 'run':
              if (isFolder && onRunItem) onRunItem(node!)
              else handled = false
              break
            case 'addRequest':
            case 'addFolder':
              if (!isFolder) {
                handled = false
                break
              }
              if (shortcut === 'addRequest') actionsWithImport.createRequest(node!.id)
              else actionsWithImport.createFolder(node!.id)
              setExpanded(node!.id, true)
              break
            case 'markers':
              openMenu('markers')
              break
            case 'description':
              openMenu('description')
              break
            case 'menu':
              openMenu('main')
              break
            default:
              handled = false
          }
        }
    }

    if (!handled && printable && !folderPickMode) {
      handled = true
      runTypeAhead()
    }

    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }, [
    getVisibleRows, focusedId, uniqueFilteredItems, effectiveExpandedIds, setExpanded, items,
    folderPickMode, onPickFolder, onRequestSelect, copyItems, cutItems, pasteInto, flatRows, handleToggleSelect, collapseSubtree, actions, actionsWithImport, onRunItem,
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
    scrolledFocusRef.current = null
    setFocusedId(item.id)
    if (item.type !== 'folder') onRequestSelect?.(item)
    requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }))
  }, [items, expandPath, onRequestSelect])

  // Mesma ideia do openFavorite acima, só que a partir de um ID solto — é o
  // que um achado do scanner de segredos tem em mãos (SecretFinding.requestId),
  // não um CollectionItem já resolvido.
  const focusItemById = useCallback((id: string) => {
    const item = findNodeById(items, id)
    if (!item) return
    const path = findPathToItem(items, id) ?? []
    expandPath(item.type === 'folder' ? [...path, id] : path)
    scrolledFocusRef.current = null
    setFocusedId(id)
    if (item.type !== 'folder') onRequestSelect?.(item)
    requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }))
  }, [items, expandPath, onRequestSelect])

  // Pedido externo de "abre onde está X" (ver comentário do prop) — roda
  // toda vez que o nonce muda, nunca ao montar sem pedido nenhum.
  useEffect(() => {
    if (!focusRequest) return
    focusItemById(focusRequest.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce])

  const handleDragStart = (event: DragStartEvent) => {
    const node = findNodeById(uniqueFilteredItems, event.active.id as string) ?? null
    // Arrastar uma linha que faz parte da seleção leva a seleção inteira
    // (só os de cima — o que está dentro vai junto). Fora dela, só a linha.
    dragNodesRef.current =
      node && selectedIds.has(node.id) && selectedIds.size > 1
        ? topLevelInTreeOrder(items, selectedIds)
        : []
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
  // Aqui a decisão é feita por hit-test do ponteiro contra as LINHAS (22px
  // cada, na ordem de flatRows) — exatamente o que o usuário está vendo. Também roda a cada pointermove, e não só quando o
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
    // Com seleção, arrasta o grupo: as linhas de TODOS os arrastados (e o
    // que está dentro deles) saem dos alvos possíveis.
    const dragNodes = dragNodesRef.current.length ? dragNodesRef.current : [dragged]
    const inDragged = (id: string) => dragNodes.some((n) => isDescendantOf(n, id))

    // Hit-test pela LISTA de linhas (flatRows), não pelo DOM: com a árvore
    // desenhada só na janela do scroll, as linhas acima da tela não existem
    // no DOM — e o cálculo de nível (projectSiblingDrop) precisa delas pra
    // achar o ancestral. Toda linha tem a mesma altura, então a linha sob o
    // ponteiro sai de uma divisão.
    const box = container.getBoundingClientRect()
    if (pointerY < box.top || pointerY > box.bottom) {
      setDropIndicator(null)
      return
    }
    const offsetY = pointerY - box.top + container.scrollTop
    const rawIndex = Math.floor(offsetY / TREE_ROW_HEIGHT)
    const hitRowAll = flatRows[rawIndex]
    // Fora de qualquer linha (abaixo da última) ou em cima da própria
    // subárvore arrastada — sem indicador.
    if (!hitRowAll || inDragged(hitRowAll.item.id)) {
      setDropIndicator(null)
      return
    }

    // As linhas da própria subárvore arrastada saem da lista: elas não são
    // alvo válido (moveNode recusaria o ciclo) e, como vizinhas, bagunçariam
    // o cálculo de nível abaixo — o item arrastado não vai estar ali no fim.
    const rows = flatRows.filter((row) => !inDragged(row.item.id))
    const hit = rows.indexOf(hitRowAll)
    const hitId = hitRowAll.item.id
    const relativeY = offsetY - rawIndex * TREE_ROW_HEIGHT

    // Pasta: "dentro" ocupa o miolo da linha e sobra só uma faixa fina nas
    // bordas pra virar irmão (antes/depois). Dividir em terços dava ~7px por
    // zona numa linha de 22px e acertar o "dentro" virava sorte; a borda fixa
    // torna o gesto previsível sem tirar o espaço de soltar entre duas pastas.
    if (
      hitRowAll.item.type === 'folder' &&
      relativeY > FOLDER_EDGE &&
      relativeY < TREE_ROW_HEIGHT - FOLDER_EDGE
    ) {
      // Example não entra em pasta: sem indicador, em vez de um anel que o
      // drop depois ignora (ver canDropAt).
      if (!canDropAt(items, dragged.id, hitId, 'inside')) {
        setDropIndicator(null)
        return
      }
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
    const above = relativeY < TREE_ROW_HEIGHT / 2 ? hit - 1 : hit

    // Inserir acima de tudo: não há nível pra subir, o único destino possível
    // é virar irmão da primeira linha.
    if (above < 0) {
      if (!canDropAt(items, dragged.id, hitId, 'before')) {
        setDropIndicator(null)
        return
      }
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
      rows.map((row) => ({ id: row.item.id, depth: row.depth })),
      above,
      outdent
    )

    // Request solta entre os examples de outra (ou example fora da sua
    // request): o drop seria recusado, então o traço não aparece.
    if (!canDropAt(items, dragged.id, projected.targetId, projected.position ?? 'after')) {
      setDropIndicator(null)
      return
    }

    const next: DropIndicator = {
      id: rows[above].item.id,
      position: 'after',
      targetId: projected.targetId,
      targetPosition: projected.position,
      indentDepth: projected.depth,
    }

    // Só atualiza quando algo mudou de fato: isso roda a cada movimento do
    // ponteiro, e re-renderizar nesse ritmo travaria o arraste.
    setDropIndicator((current) =>
      current &&
      current.id === next.id &&
      current.position === next.position &&
      current.targetId === next.targetId &&
      current.targetPosition === next.targetPosition &&
      current.indentDepth === next.indentDepth
        ? current
        : next
    )
  }

  // Cursor durante o arraste: "não pode" quando soltar ali não faria nada
  // (fora das linhas, ou destino recusado por canDropAt). Antes o traço só
  // sumia, sem dizer por quê.
  const dropBlocked = !!activeItem && !dropIndicator
  useEffect(() => {
    if (!activeItem) return
    const body = document.body
    body.classList.toggle('tree-drag-blocked', dropBlocked)
    body.classList.toggle('tree-dragging', !dropBlocked)
    return () => body.classList.remove('tree-drag-blocked', 'tree-dragging')
  }, [activeItem, dropBlocked])

  // A lista rola sozinha quando o arraste encosta na borda (auto-scroll do
  // dnd-kit) sem o ponteiro se mexer, e sem pointermove o traço ficava preso
  // na linha de antes, que subia junto — o item caía longe do cursor.
  const handleTreeScroll = () => {
    updateRange()
    if (activeItem) updateDropIndicator()
  }

  const handleDragOver = (_event: DragOverEvent) => updateDropIndicator()
  const handleDragMove = (_event: DragMoveEvent) => updateDropIndicator()

  // Fim do arraste, solto ou cancelado. O cancelar (Esc no meio do arraste)
  // só apagava o traço: activeItem ficava preso, então o cursor de arrastar
  // não saía do body e o traço voltava a seguir o mouse até o próximo
  // arraste.
  const resetDrag = () => {
    dragNodesRef.current = []
    setActiveItem(null)
    setDropIndicator(null)
    pointerYRef.current = null
    pointerXRef.current = null
    dragStartXRef.current = null
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active } = event
    const indicator = dropIndicator
    const group = dragNodesRef.current

    resetDrag()

    // O alvo é o do indicador (o que estava desenhado na tela), não o `over`
    // do dnd-kit — ver o comentário em updateDropIndicator.
    if (!indicator) return

    const targetId = indicator.targetId ?? indicator.id
    if (active.id === targetId) return

    if (group.length > 1) {
      const ids = group.map((n) => n.id)
      moveGroupWithUndo(ids, moveNodes(items, ids, targetId, indicator.targetPosition ?? indicator.position))
      return
    }

    const updated = moveNode(
      items,
      active.id as string,
      targetId,
      indicator.targetPosition ?? indicator.position
    )
    moveWithUndo(active.id as string, updated)
  }

  return (
    <div className="h-full flex flex-col pb-2"> 
      <TreeSearch value={search} onChange={setSearch} onArrowDown={focusTree} />

      {/* Onde está a aba aberta: Collection › Pasta › Request. Cada parte
          leva até o item na árvore (abre as pastas e rola até ele). */}
      {breadcrumb && breadcrumb.length > 1 && !folderPickMode && (
        <nav
          aria-label="Open item location"
          className="flex items-center gap-0.5 px-3 pb-1 text-[11px] text-pm-text-muted min-w-0 overflow-hidden"
        >
          {breadcrumb.map((node, i) => (
            <span key={node.id} className={`flex items-center gap-0.5 ${i === breadcrumb.length - 1 ? 'min-w-0 shrink' : 'min-w-0 shrink-[2]'}`}>
              {i > 0 && <ChevronRight size={10} className="shrink-0 opacity-60" />}
              <button
                type="button"
                onClick={() => focusItemById(node.id)}
                title={node.name}
                className={`truncate hover:text-pm-text hover:underline cursor-pointer ${i === breadcrumb.length - 1 ? 'text-pm-text-secondary' : ''}`}
              >
                {node.name}
              </button>
            </span>
          ))}
        </nav>
      )}

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
        role="tree"
        aria-label="Collections"
        aria-multiselectable
        aria-activedescendant={treeFocused && focusedId && rowIndexById.has(focusedId) ? treeRowDomId(focusedId) : undefined}
        onScroll={handleTreeScroll}
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
            onDragCancel={resetDrag}
          >
            <SortableContext items={rootIds} strategy={verticalListSortingStrategy}>
              {/* Só a janela do scroll é desenhada (ver treeRows): o espaçador
                  tem a altura da lista inteira e cada linha é posicionada no
                  seu lugar. Com 800+ itens abertos o DOM fica em ~60 linhas. */}
              <div role="presentation" style={{ position: 'relative', height: flatRows.length * TREE_ROW_HEIGHT }}>
                {renderedIndexes.map(index => {
                  const row = flatRows[index]
                  const id = row.item.id
                  return (
                    <div
                      key={id}
                      role="none"
                      style={{ position: 'absolute', top: index * TREE_ROW_HEIGHT, left: 0, right: 0, height: TREE_ROW_HEIGHT }}
                    >
                      <TreeNode
                        item={row.item}
                        depth={row.depth}
                        hasChildren={row.hasChildren}
                        isOpen={row.isOpen}
                        posInSet={row.posInSet}
                        setSize={row.setSize}
                        isActive={activeRequestId === id}
                        isSelected={selectedIds.has(id)}
                        isCut={cutIds.has(id)}
                        activeGuideLevel={guide && index >= guide.start && index < guide.end ? guide.level : undefined}
                        isFocused={treeFocused && focusedId === id}
                        isPendingPush={row.depth === 0 ? pendingPushIds?.has(id) : undefined}
                        pendingCount={row.depth === 0 ? pendingChanges?.get(id)?.count : undefined}
                        isChanged={row.depth > 0 && changedIds.has(id)}
                        totalRequests={row.depth === 0 && isSearching ? rootRequestTotals.get(id) : undefined}
                        onRequestSelect={handleRowSelect}
                        actions={actionsWithImport}
                        dropIndicator={dropIndicator?.id === id ? dropIndicator : null}
                        onToggleSelect={handleToggleSelect}
                        onRangeSelect={handleRangeSelect}
                        onRowContextMenu={handleRowContextMenu}
                        onSetExpanded={setExpanded}
                        onRowFocus={handleRowFocus}
                        renameRequested={renamingId === id}
                        onRenameHandled={handleRenameHandled}
                        searchTokens={searchTokens}
                        markerMap={markerMap}
                        onMarkerClick={onMarkersChange ? handleMarkerClick : undefined}
                        markerCatalog={markerCatalog}
                        onToggleMarker={handleToggleMarker}
                        onCreateMarker={handleCreateMarker}
                        onRecolorMarker={handleRecolorMarker}
                        onManageMarkers={onMarkersChange ? openManageMarkers : undefined}
                        onSaveDescription={handleSaveDescription}
                        actionMenuOpen={openActionMenuId === id}
                        actionMenuView={actionMenuView}
                        onActionMenuOpenChange={handleActionMenuOpenChange}
                        folderPickMode={folderPickMode}
                        onPickFolder={onPickFolder}
                      />
                    </div>
                  )
                })}
              </div>
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
                  {dragNodesRef.current.length > 1 && (
                    <span className="ml-auto shrink-0 rounded px-1 text-[10px] font-semibold" style={{ background: "#3c89e0", color: "#fff" }}>
                      {dragNodesRef.current.length} items
                    </span>
                  )}
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
          selectionCount={selectionCount}
          canPaste={contextMenu.canPaste}
          onCopy={() => handleCopySelected(contextMenu.item?.id)}
          onCut={folderPickMode ? undefined : () => cutItems(contextMenu.item?.id)}
          onRename={
            contextMenu.item ? () => setRenamingId(contextMenu.item!.id) : undefined
          }
          onPaste={handlePaste}
          onPasteBeside={contextMenu.item ? handlePasteBeside : undefined}
          move={contextMenu.item ? buildMoveActions(contextMenu.item.id) : undefined}
          numberableCount={contextMenu.item?.item?.length ?? 0}
          onNumberChildren={
            contextMenu.item?.type === 'folder'
              ? () => handleNumberChildren(contextMenu.item!.id)
              : undefined
          }
          openAllCount={contextOpenAll.length}
          onOpenAll={
            onOpenAllRequests ? () => onOpenAllRequests(contextOpenAll) : undefined
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
          note={markerNote(findNodeById(items, openMarker.itemId) ?? ({} as CollectionItem), openMarker.markerId)}
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
        {/* Mesmo visual dos outros modais de confirmação (ModalCard, ex. o
            "Remove from GitHub?"): o AlertDialogContent puro ficou sem borda
            quando o ring do shadcn saiu, e o rodapé/botões usavam os tokens
            do shadcn em vez dos pm-*. Os `!` vencem as classes do Button,
            que o asChild junta por concatenação (sem tailwind-merge). flex no
            lugar do grid da base: num grid, o título longo esticava a coluna
            e empurrava o botão Delete pra fora do card. */}
        <AlertDialogContent className="flex flex-col w-[380px] max-w-[380px]! gap-0 p-0 overflow-hidden rounded-lg border border-pm-border bg-pm-surface text-pm-text shadow-2xl font-sans">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-pm-border">
            <span className="w-[22px] h-[22px] shrink-0 rounded-md bg-rose-500/15 text-rose-400 flex items-center justify-center">
              <Trash2 size={13} />
            </span>
            <AlertDialogTitle className="min-w-0 flex-1 text-[13px] font-semibold text-pm-text truncate" title={pendingDelete?.length === 1 ? pendingDelete[0]?.name : undefined}>
              {pendingDelete && pendingDelete.length > 1
                ? `Delete ${pendingDelete.length} items?`
                : `Delete "${pendingDelete?.[0]?.name ?? ''}"?`}
            </AlertDialogTitle>
          </div>
          <div className="px-4 py-3">
            <AlertDialogDescription className="text-[12px] text-pm-text-muted leading-relaxed text-left">
              {pendingDelete?.some(n => n.type === 'folder')
                ? 'Everything inside will be deleted too. You can undo it right after.'
                : 'You can undo it right after.'}
            </AlertDialogDescription>
          </div>
          <div className="flex gap-2 px-4 py-3 border-t border-pm-border bg-pm-hover/20">
            <AlertDialogCancel
              variant="ghost"
              className="flex-1 h-[32px]! rounded-md! text-xs! font-semibold cursor-pointer border! border-pm-border! bg-pm-hover! text-pm-text! hover:bg-pm-row-active! transition-colors"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="ghost"
              onClick={confirmDelete}
              className="flex-1 h-[32px]! rounded-md! text-xs! font-semibold cursor-pointer border-none! bg-rose-600! text-white! hover:bg-rose-500! transition-colors"
            >
              Delete
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* Escolhas do "Export as HTML runner". `key` remonta a janela a cada
          pasta, pra ela abrir sempre com o environment ativo de agora. */}
      <ExportFlowHtmlDialog
        key={exportHtmlItem?.id ?? 'closed'}
        item={exportHtmlItem}
        environments={environments}
        activeEnvId={activeEnv?.id ?? null}
        onCancel={() => setExportHtmlItem(null)}
        onExport={choice => { if (exportHtmlItem) void runExportFlowHtml(exportHtmlItem, choice) }}
      />

      {/* Credencial literal achada antes do Export (ver scanTree) — avisa e
          deixa escolher, em vez de incluir no arquivo sem avisar. Dialog
          arrastável (não AlertDialog) de propósito: clicar num achado abre o
          item na árvore SEM fechar, pra revisar vários sem reabrir a tela
          toda vez — e pra isso dar certo com a árvore por baixo, precisa dar
          pra tirar o diálogo do caminho. */}
      <Dialog
        open={!!pendingExportSecrets}
        modal={false}
        onOpenChange={(open) => { if (!open) setPendingExportSecrets(null) }}
      >
        <DialogContent
          showCloseButton={false}
          showOverlay={false}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          {...exportSecretsDrag.contentProps}
          className="bg-pm-bg border border-pm-border text-pm-text sm:max-w-md p-0 flex flex-col overflow-hidden rounded-lg gap-0"
        >
          <div
            {...exportSecretsDrag.handleProps}
            onDoubleClick={exportSecretsDrag.reset}
            title="Drag to move — double-click to recenter"
            className="h-11 shrink-0 flex items-center gap-1.5 px-4 border-b border-pm-border select-none"
          >
            <ShieldAlert size={14} className="text-amber-400 shrink-0" />
            <DialogTitle className="text-[13px] font-semibold text-pm-text flex-1 truncate">
              {pendingExportSecrets?.findings.length === 1
                ? '1 hard-coded credential found'
                : `${pendingExportSecrets?.findings.length ?? 0} hard-coded credentials found`}
            </DialogTitle>
            <button
              onClick={() => setPendingExportSecrets(null)}
              className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer shrink-0"
            >
              <X size={14} />
            </button>
          </div>

          <div className="px-4 pt-3 pb-1">
            <p className="text-[11.5px] text-pm-text-secondary leading-relaxed">
              This export would include a token, key or password written straight into a
              request instead of a <code className="text-[10.5px] rounded bg-pm-hover px-1 py-px">{'{{variable}}'}</code> —
              anyone who imports the file gets the real value.
            </p>
          </div>

          <div className="mx-4 mb-2 max-h-52 overflow-y-auto rounded-lg border border-pm-border divide-y divide-pm-border/60">
            {pendingExportSecrets?.findings.map((f, i) => (
              <button
                key={`${f.requestId}-${i}`}
                type="button"
                onClick={() => focusItemById(f.requestId)}
                title={`Open "${f.requestName}" in the tree`}
                className="group flex w-full items-start gap-2 px-3 py-2 text-left cursor-pointer hover:bg-pm-hover transition-colors"
              >
                {f.expired === true ? (
                  <ShieldAlert size={13} className="mt-0.5 shrink-0 text-pm-text-muted" />
                ) : (
                  <KeyRound size={13} className="mt-0.5 shrink-0 text-amber-400" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] text-pm-text truncate">{f.requestName}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-mono text-pm-text-secondary">
                      {f.location.type === 'header'
                        ? f.location.key
                        : f.location.type === 'exampleHeader'
                          ? `example response · ${f.location.key}`
                          : f.location.type === 'oauth2'
                            ? `oauth2 · ${f.location.key}`
                            : `auth · ${f.location.field}`}
                    </span>
                    <span className="text-[10px] font-mono text-pm-text-muted">{f.preview}</span>
                    {f.expired === true && (
                      <span className="text-[9.5px] rounded-sm bg-pm-border px-1 text-pm-text-muted">
                        expired {f.expiredDaysAgo}d ago
                      </span>
                    )}
                  </div>
                </div>
                <ArrowUpRight
                  size={12}
                  className="mt-0.5 shrink-0 text-pm-text-muted opacity-0 group-hover:opacity-100 transition-opacity"
                />
              </button>
            ))}
          </div>

          <p className="px-4 pb-3 text-[10.5px] text-pm-text-muted">
            Click one to open it in the tree — this stays open so you can check more than one.
            To fix them first, open <strong className="text-pm-text-secondary">Settings → Security</strong> and
            extract them into environment variables, then export again.
          </p>

          <div className="h-12 shrink-0 flex items-center justify-end gap-2 px-4 border-t border-pm-border">
            <button
              onClick={() => setPendingExportSecrets(null)}
              className="h-7 px-3 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:bg-pm-hover transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (pendingExportSecrets) void runExport(pendingExportSecrets.item)
                setPendingExportSecrets(null)
              }}
              className="h-7 px-3 rounded-md text-xs font-semibold bg-amber-500 text-white hover:bg-amber-400 transition-colors cursor-pointer"
            >
              Export anyway
            </button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  )
}

