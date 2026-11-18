'use client'

import {
  ArrowUpToLine,
  Check,
  ChevronLeft,
  Download,
  Edit2,
  FilePlus2,
  FileText,
  Folder,
  Gauge,
  Link,
  MoreHorizontal,
  Palette as PaletteIcon,
  Play,
  Plus,
  Search,
  Settings2,
  Star,
  StickyNote,
  Tag,
  Terminal,
  Trash2,
  X,
  Radio, FileCode2, ArrowDownUp } from 'lucide-react'
import { useSyncDiffStrings } from '@/lib/i18n/syncDiffStrings'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { CollectionItem } from '@/app/types/CollectionItem'
import { useEffect, useState } from 'react'
import type { Marker } from '@/lib/markers'
import { MAX_MARKER_NAME, pickColor } from '@/lib/markers'
import { isMacPlatform } from '@/lib/platform'
import { MarkerGlyph } from './MarkerGlyph'
import { MarkerPalette } from './MarkerPalette'
import { shortcutLabel, type TreeShortcut } from './treeShortcuts'

export type ActionMenuView = 'main' | 'markers' | 'description'

interface Props {
  item: CollectionItem
  onRename: () => void
  onDelete: () => void
  onDuplicate: () => void
  onAddRequest: () => void
  onAddGrpcRequest?: () => void
  onAddFolder: () => void
  onImportCurl?: () => void
  onExport?: () => void
  // Pasta → um .html que mostra e executa os passos no navegador.
  onExportHtml?: () => void
  onRun?: () => void
  onLoadTest?: () => void
  // Envia SÓ esta subpasta ou request pro GitHub (a collection inteira é
  // pela Central de Sincronização).
  onPushCollection?: () => void
  // Abre a Central de Sincronização filtrada na collection deste item.
  onOpenSync?: () => void
  onAddExample?: () => void
  onToggleStar?: () => void
  onCopyUrl?: () => void
  onCopyCurl?: () => void
  // Collection (raiz) -> "Export Collection"; subpasta/request -> "Export".
  isRoot?: boolean
  // Marcadores aplicáveis a ESTE item (ver lib/markers.ts). Diferente do
  // menu de clique direito — que pode mirar uma seleção inteira — aqui o
  // alvo é sempre só o `item` da linha, então o estado nunca é 'partial'.
  markers?: {
    catalog: Marker[]
    state: Record<string, 'on' | 'partial'>
    onToggle: (markerId: string) => void
    onCreate: (name: string, color?: string) => void
    onRecolor?: (markerId: string, color: string) => void
    onManage?: () => void
  }
  // Grava a descrição do item (ver CollectionItem.description).
  onSaveDescription?: (text: string) => void
  // Controlado de fora pra que só um menu da árvore fique aberto por vez —
  // este "..." e o de clique direito (TreeContextMenu) são componentes
  // separados, sem nenhum estado em comum, então abrir um não fechava o
  // outro sozinho. Ausente = descontrolado (abre/fecha por si, como antes).
  open?: boolean
  onOpenChange?: (open: boolean) => void
  // Vista em que o menu abre quando quem abre é o teclado (atalhos M e
  // Shift+M da árvore, ver treeShortcuts) — direto em Markers/descrição.
  requestedView?: ActionMenuView
}

// A tecla do atalho, à direita da ação (a mesma tabela que a árvore usa).
function Kbd({ shortcut, auto = true }: { shortcut: TreeShortcut; auto?: boolean }) {
  return (
    <span className={`${auto ? 'ml-auto ' : ''}shrink-0 pl-4 text-[10.5px] font-normal tracking-wide text-pm-text-muted/80`}>
      {shortcutLabel(shortcut, isMacPlatform)}
    </span>
  )
}

const iconClass = 'shrink-0 text-pm-text-muted group-hover:text-pm-text'
const separatorClass = 'bg-pm-border mx-1 my-1.5'

export function TreeActionMenu({
  item,
  onRename,
  onDelete,
  onDuplicate,
  onAddFolder,
  onAddRequest,
  onAddGrpcRequest,
  onImportCurl,
  onExport,
  onExportHtml,
  onRun,
  onLoadTest,
  onPushCollection,
  onOpenSync,
  onAddExample,
  onToggleStar,
  onCopyUrl,
  onCopyCurl,
  isRoot,
  markers,
  onSaveDescription,
  open,
  onOpenChange,
  requestedView,
}: Props) {
  const syncText = useSyncDiffStrings()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Mesmo truque do menu de clique direito: troca de conteúdo no lugar em
  // vez de submenu (um submenu do Radix dentro de outro populariza um
  // segundo nível de posicionamento que não ganha nada aqui).
  const [view, setView] = useState<ActionMenuView>('main')
  const [draftDescription, setDraftDescription] = useState(item.description ?? '')
  // Um campo só na vista de Markers: filtra a lista enquanto se digita e,
  // se nada tem esse nome, Enter cria (e aplica) o marcador.
  const [markerQuery, setMarkerQuery] = useState('')
  const [newColor, setNewColor] = useState<string | null>(null)
  const [recoloring, setRecoloring] = useState<string | null>(null)
  // Cor que o marcador novo teria se ninguém escolhesse — a mesma que o
  // createMarker usaria, pra que a paleta já nasça mostrando a verdade.
  const suggestedColor = pickColor(markers?.catalog ?? [])

  const appliedMarkers = markers ? markers.catalog.filter(m => markers.state[m.id] === 'on') : []
  const hasDescription = !!item.description?.trim()
  // A descrição acompanha a marcação: só aparece com o item marcado (ou se
  // ele já tiver uma descrição — senão ela ficaria sem como editar/apagar).
  const showDescription = !!onSaveDescription && (appliedMarkers.length > 0 || hasDescription)

  const query = markerQuery.trim()
  const filteredMarkers = markers
    ? markers.catalog.filter(m => !query || m.name.toLowerCase().includes(query.toLowerCase()))
    : []
  const exactMarker = markers?.catalog.find(m => m.name.toLowerCase() === query.toLowerCase())

  const resetViews = () => {
    setConfirmingDelete(false)
    setView('main')
    setMarkerQuery('')
    setNewColor(null)
    setRecoloring(null)
  }

  // Aberto pelo teclado (atalho da árvore): o Radix não chama onOpenChange
  // quando quem abre é o `open` controlado, então a vista pedida e o
  // rascunho da descrição entram aqui.
  useEffect(() => {
    if (!open) return
    setDraftDescription(item.description ?? '')
    if (requestedView && requestedView !== 'main') {
      if (requestedView === 'description' && !showDescription) return
      setView(requestedView)
    }
    // Só na abertura; o item e a vista vêm junto com ela.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requestedView])

  const itemClass = `
  group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5
  text-[12.5px] font-medium
  cursor-pointer select-none outline-none border-none ring-0
  transition-colors duration-100
  hover:bg-pm-hover focus:bg-pm-hover
  data-[highlighted]:bg-pm-hover data-[highlighted]:text-pm-text
`

  const submitMarkerQuery = () => {
    if (!markers || !query) return
    if (exactMarker) markers.onToggle(exactMarker.id)
    else markers.onCreate(query, newColor ?? undefined)
    setMarkerQuery('')
    setNewColor(null)
  }

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          // Volta pra tela principal, e esquece rascunhos — o menu fica
          // montado entre uma abertura e outra (a linha não desmonta), e
          // sem isto reabrir cairia direto na vista anterior.
          resetViews()
        } else {
          // Reabrindo: o rascunho pode estar desatualizado se a descrição
          // mudou por outro caminho (um pull do GitHub) desde o último
          // fechamento.
          setDraftDescription(item.description ?? '')
        }
        onOpenChange?.(next)
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation()
          }}
          title={`More actions (${shortcutLabel('menu', isMacPlatform)})`}
          className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text transition-all duration-150"
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        sideOffset={6}
        // Distância das bordas da janela: o menu é comprido e, colado no
        // topo ou no rodapé, parecia cortado.
        collisionPadding={16}
        // A margem de cima e de baixo fica na caixa e a rolagem numa área
        // de dentro: com o padding na própria área que rola, ele subia junto
        // com a lista e o item rolado encostava na borda do menu.
        className="
          z-50 min-w-[264px] max-w-[320px]
          max-h-(--radix-dropdown-menu-content-available-height)
          flex flex-col overflow-hidden
          rounded-lg border border-pm-border bg-pm-surface backdrop-blur-2xl
          px-1.5 py-2
          text-pm-text-secondary outline-none ring-0
          data-[state=open]:animate-in data-[state=closed]:animate-out
          data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0
          data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95
          duration-100
        "
      >
        {/* Área que rola. scroll-py: quando o teclado leva o foco a um item
            fora de vista, ele para um pouco antes da borda, não colado nela. */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scroll-py-1.5">
        {view === 'description' && onSaveDescription ? (
          <>
            {/* "Voltar", e não um X: dentro do dropdown não há pra onde
                fechar além de voltar pra lista — fechar o menu inteiro só
                porque mudou de ideia na descrição seria demais. */}
            <DropdownMenuItem
              onSelect={e => { e.preventDefault(); setView('main') }}
              className={`${itemClass} text-pm-text-muted`}
            >
              <ChevronLeft size={14} />
              <span className="truncate">Description · {item.name}</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator className={separatorClass} />

            {appliedMarkers.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 px-2.5 pb-1.5">
                {appliedMarkers.map(m => (
                  <span key={m.id} className="inline-flex items-center gap-1 rounded bg-pm-hover px-1.5 py-px text-[10.5px] text-pm-text-secondary">
                    <MarkerGlyph color={m.color} size={8} />
                    {m.name}
                  </span>
                ))}
              </div>
            )}

            <div className="px-1.5 pb-1">
              <textarea
                autoFocus
                rows={5}
                value={draftDescription}
                onChange={e => setDraftDescription(e.target.value)}
                onKeyDown={e => {
                  // Enter quebra linha (é texto corrido); Ctrl/Cmd+Enter grava.
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    onSaveDescription(draftDescription)
                    onOpenChange?.(false)
                  }
                  if (e.key === 'Escape') {
                    e.nativeEvent.stopImmediatePropagation()
                    setView('main')
                  }
                }}
                placeholder="What this does, what it depends on…"
                spellCheck={false}
                className="w-full resize-none rounded border border-pm-border bg-pm-bg px-1.5 py-1 text-[12px] leading-snug text-pm-text outline-none focus:border-[#f26b3a]/60"
              />
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[10px] text-pm-text-muted">{isMacPlatform ? '⌘' : 'Ctrl'} + Enter</span>
                <button
                  onClick={() => {
                    onSaveDescription(draftDescription)
                    onOpenChange?.(false)
                  }}
                  className="rounded px-2 py-0.5 text-[11px] font-medium text-pm-text hover:bg-pm-hover"
                >
                  Save
                </button>
              </div>
            </div>
          </>
        ) : view === 'markers' && markers ? (
          <>
            <DropdownMenuItem
              onSelect={e => { e.preventDefault(); setView('main') }}
              className={`${itemClass} text-pm-text-muted`}
            >
              <ChevronLeft size={14} />
              Markers
              {appliedMarkers.length > 0 && (
                <span className="ml-auto text-[10.5px] font-normal">{appliedMarkers.length} applied</span>
              )}
            </DropdownMenuItem>

            <DropdownMenuSeparator className={separatorClass} />

            {/* Buscar e criar no mesmo campo: com muitos marcadores, achar o
                certo na lista é o gargalo; e ter que abrir outra tela pra
                criar antes de usar é o caminho que faz ninguém marcar nada. */}
            <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
              <Search size={12} className="shrink-0 text-pm-text-muted" />
              <input
                autoFocus
                value={markerQuery}
                maxLength={MAX_MARKER_NAME}
                onChange={e => setMarkerQuery(e.target.value)}
                onKeyDown={e => {
                  // Sem isto, o typeahead do Radix rouba as letras digitadas.
                  e.stopPropagation()
                  if (e.key === 'Enter') submitMarkerQuery()
                  if (e.key === 'Escape') {
                    e.nativeEvent.stopImmediatePropagation()
                    if (markerQuery) setMarkerQuery('')
                    else setView('main')
                  }
                }}
                placeholder="Find or create a marker…"
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-pm-border bg-pm-bg px-1.5 py-1 text-[12px] text-pm-text outline-none focus:border-[#f26b3a]/60"
              />
            </div>

            {markers.catalog.length === 0 && !query && (
              <p className="px-2.5 py-1.5 text-[11px] leading-snug text-pm-text-muted">
                No markers yet. Type a name above and press Enter to create the first one.
              </p>
            )}

            {filteredMarkers.length > 0 && (
              <div className="max-h-[240px] overflow-y-auto">
                {filteredMarkers.map(marker => {
                  const on = markers.state[marker.id] === 'on'
                  if (recoloring === marker.id) {
                    return (
                      <div key={marker.id} className="px-1.5 py-1">
                        <div className="mb-1 truncate text-[10px] text-pm-text-muted">{marker.name}</div>
                        <MarkerPalette
                          selected={marker.color}
                          onPick={color => {
                            markers.onRecolor?.(marker.id, color)
                            setRecoloring(null)
                          }}
                        />
                      </div>
                    )
                  }
                  return (
                    <div key={marker.id} className="group/mk relative flex items-center">
                      <button
                        onClick={() => markers.onToggle(marker.id)}
                        title={on ? `Remove "${marker.name}"` : `Apply "${marker.name}"`}
                        aria-pressed={on}
                        className={`${itemClass} min-w-0 flex-1 pr-8`}
                      >
                        {/* Caixinha à esquerda: dá pra ver de relance o que
                            está aplicado, sem procurar o ✓ no fim da linha. */}
                        <span
                          className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
                            on ? 'border-[#f26b3a] bg-[#f26b3a] text-white' : 'border-pm-text-muted/60'
                          }`}
                        >
                          {on && <Check size={10} strokeWidth={3} />}
                        </span>
                        <MarkerGlyph color={marker.color} size={12} className="shrink-0" />
                        <span className={`truncate ${on ? 'text-pm-text' : ''}`}>{marker.name}</span>
                      </button>

                      {/* Trocar a cor fica no hover, e não como linha
                          própria: a lista é de MARCAR, e um botão fixo por
                          linha competiria com o alvo principal. */}
                      {markers.onRecolor && (
                        <button
                          onClick={() => setRecoloring(marker.id)}
                          title={`Change the color of "${marker.name}"`}
                          className="absolute right-1 flex size-5 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-pm-hover group-hover/mk:opacity-100"
                        >
                          <PaletteIcon size={12} className="text-pm-text-muted" />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Nada com esse nome: Enter cria. A paleta só aparece aqui —
                antes de haver nome não há o que colorir. */}
            {query && !exactMarker && (
              <div className="px-1.5 pt-1">
                <button
                  onClick={submitMarkerQuery}
                  className={`${itemClass} w-full text-pm-text`}
                >
                  <Plus size={13} className="shrink-0 text-pm-text-muted" />
                  <span className="truncate">Create “{query}”</span>
                  <span className="ml-auto shrink-0 pl-4 text-[10.5px] font-normal text-pm-text-muted/80">Enter</span>
                </button>
                <div className="px-1 pb-1">
                  <MarkerPalette selected={newColor ?? suggestedColor} onPick={setNewColor} />
                </div>
              </div>
            )}

            {/* Descrição junto da marcação: só com o item marcado. */}
            {showDescription && (
              <>
                <DropdownMenuSeparator className={separatorClass} />
                <DropdownMenuItem
                  onSelect={e => { e.preventDefault(); setView('description') }}
                  className={itemClass}
                >
                  <StickyNote size={14} className={iconClass} />
                  {hasDescription ? 'Edit description' : 'Add description'}
                  <Kbd shortcut="description" />
                </DropdownMenuItem>
              </>
            )}

            {/* Renomear e apagar não cabem aqui: as duas precisam do
                catálogo inteiro à vista (colisão de nome, quantos itens
                perdem a marca). */}
            {markers.onManage && (
              <>
                <DropdownMenuSeparator className={separatorClass} />
                <DropdownMenuItem
                  onClick={() => markers.onManage!()}
                  className={`${itemClass} text-pm-text-muted`}
                >
                  <Settings2 size={14} />
                  Manage markers…
                </DropdownMenuItem>
              </>
            )}
          </>
        ) : (
        <>
        {/* Favoritar vale pra qualquer tipo de item. */}
        {onToggleStar && (
          <>
            <DropdownMenuItem onClick={onToggleStar} className={itemClass}>
              <Star
                size={14}
                className={item.starred ? 'shrink-0 text-amber-400 fill-amber-400' : iconClass}
              />
              {item.starred ? 'Remove from Favorites' : 'Add to Favorites'}
              <Kbd shortcut="favorite" />
            </DropdownMenuItem>
            <DropdownMenuSeparator className={separatorClass} />
          </>
        )}

        {item.type === 'folder' && (
          <>
            {/* GitHub */}
            {(onPushCollection || onOpenSync) && (
              <>
                {/* Receber/enviar/conflitos: a Central, já filtrada. */}
                {onOpenSync && (
                  <DropdownMenuItem onClick={onOpenSync} className={itemClass} title={syncText.scOpenItemTitle}>
                    <ArrowDownUp size={14} className={iconClass} />
                    {syncText.scOpenItem}
                  </DropdownMenuItem>
                )}
                {onPushCollection && (
                  <DropdownMenuItem onClick={onPushCollection} className={itemClass}>
                    <ArrowUpToLine size={14} className={iconClass} />
                    {syncText.scSendOnlyFolder}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator className={separatorClass} />
              </>
            )}

            {/* Executar */}
            {(onRun || onLoadTest) && (
              <>
                {onRun && (
                  <DropdownMenuItem onClick={onRun} className={itemClass}>
                    <Play size={14} className={iconClass} />
                    Run
                    <Kbd shortcut="run" />
                  </DropdownMenuItem>
                )}
                {onLoadTest && (
                  <DropdownMenuItem onClick={onLoadTest} className={itemClass}>
                    <Gauge size={14} className={iconClass} />
                    Load Test
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator className={separatorClass} />
              </>
            )}

            {/* Criar dentro da pasta */}
            <DropdownMenuItem onClick={onAddRequest} className={itemClass}>
              <Plus size={14} className={iconClass} />
              Add Request
              <Kbd shortcut="addRequest" />
            </DropdownMenuItem>
            {onAddGrpcRequest && (
              <DropdownMenuItem onClick={onAddGrpcRequest} className={itemClass}>
                <Radio size={14} className={iconClass} />
                Add gRPC Request
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onAddFolder} className={itemClass}>
              <Folder size={14} className={iconClass} />
              Add Folder
              <Kbd shortcut="addFolder" />
            </DropdownMenuItem>
            {onImportCurl && (
              <DropdownMenuItem onClick={onImportCurl} className={itemClass}>
                <Terminal size={14} className={iconClass} />
                Import cURL
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator className={separatorClass} />
          </>
        )}

        {item.type === 'request' && (onLoadTest || onAddExample || onCopyUrl || onCopyCurl || onPushCollection) && (
          <>
            {onPushCollection && (
              <DropdownMenuItem onClick={onPushCollection} className={itemClass}>
                <ArrowUpToLine size={14} className={iconClass} />
                {syncText.scSendOnlyRequest}
              </DropdownMenuItem>
            )}
            {onCopyUrl && (
              <DropdownMenuItem onClick={onCopyUrl} className={itemClass}>
                <Link size={14} className={iconClass} />
                Copy URL
              </DropdownMenuItem>
            )}
            {onCopyCurl && (
              <DropdownMenuItem onClick={onCopyCurl} className={itemClass}>
                <Terminal size={14} className={iconClass} />
                Copy as cURL
              </DropdownMenuItem>
            )}
            {onLoadTest && (
              <DropdownMenuItem onClick={onLoadTest} className={itemClass}>
                <Gauge size={14} className={iconClass} />
                Load Test
              </DropdownMenuItem>
            )}
            {onAddExample && (
              <DropdownMenuItem onClick={onAddExample} className={itemClass}>
                <FilePlus2 size={14} className={iconClass} />
                Add Example
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator className={separatorClass} />
          </>
        )}

        {/* Editar o item */}
        <DropdownMenuItem onClick={onRename} className={itemClass}>
          <Edit2 size={14} className={iconClass} />
          Rename
          <Kbd shortcut="rename" />
        </DropdownMenuItem>

        <DropdownMenuItem onClick={onDuplicate} className={itemClass}>
          <FileText size={14} className={iconClass} />
          Duplicate
          <Kbd shortcut="duplicate" />
        </DropdownMenuItem>

        {/* Abrem uma vista no lugar deste conteúdo, por isso onSelect +
            preventDefault — igual à confirmação de delete logo abaixo: sem
            isso, o próprio Radix fecharia o menu ao "selecionar" o item. */}
        {markers && (
          <DropdownMenuItem
            onSelect={e => { e.preventDefault(); setView('markers') }}
            className={itemClass}
          >
            <Tag size={14} className={iconClass} />
            Markers
            {/* O que já está aplicado, com nome — só as cores não diziam
                qual marcador era qual sem entrar na vista. */}
            {/* Um marcador: o nome. Vários: as cores e quantos são — dois
                nomes lado a lado ficavam cortados ("E…", "U") e não diziam
                nada. A lista completa fica no título. */}
            <span
              title={appliedMarkers.map(m => m.name).join(', ') || undefined}
              className="ml-auto flex min-w-0 items-center gap-1 pl-3"
            >
              {appliedMarkers.length === 1 ? (
                <span className="inline-flex min-w-0 max-w-[110px] items-center gap-1 rounded bg-pm-hover px-1.5 py-px text-[10px] font-normal text-pm-text-secondary">
                  <MarkerGlyph color={appliedMarkers[0].color} size={8} className="shrink-0" />
                  <span className="truncate">{appliedMarkers[0].name}</span>
                </span>
              ) : appliedMarkers.length > 1 ? (
                <span className="inline-flex items-center gap-1 rounded bg-pm-hover px-1.5 py-px text-[10px] font-normal text-pm-text-secondary">
                  {appliedMarkers.slice(0, 4).map(m => (
                    <MarkerGlyph key={m.id} color={m.color} size={8} className="shrink-0" />
                  ))}
                  <span className="tabular-nums">{appliedMarkers.length}</span>
                </span>
              ) : null}
            </span>
            <Kbd shortcut="markers" auto={false} />
          </DropdownMenuItem>
        )}

        {/* A descrição acompanha a marcação: só com o item marcado (ou
            se já houver uma). Recuada, pra ler como parte de Markers. */}
        {showDescription && (
          <DropdownMenuItem
            onSelect={e => { e.preventDefault(); setView('description') }}
            className={`${itemClass} pl-8`}
          >
            <StickyNote size={13} className={iconClass} />
            {hasDescription ? 'Edit description' : 'Add description'}
            <Kbd shortcut="description" />
          </DropdownMenuItem>
        )}

        {(onExport || onExportHtml) && (
          <>
            <DropdownMenuSeparator className={separatorClass} />
            {onExport && (
              <DropdownMenuItem onClick={onExport} className={itemClass}>
                <Download size={14} className={iconClass} />
                {isRoot ? 'Export Collection' : 'Export'}
              </DropdownMenuItem>
            )}
            {onExportHtml && (
              <DropdownMenuItem onClick={onExportHtml} className={itemClass}>
                <FileCode2 size={14} className={iconClass} />
                Export flow (HTML runner / HAR)
              </DropdownMenuItem>
            )}
          </>
        )}

        <DropdownMenuSeparator className={separatorClass} />

        {confirmingDelete ? (
          <>
            {/* Cancelar vem primeiro para ser a opção focada por padrão */}
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault()
                setConfirmingDelete(false)
              }}
              className={`${itemClass} text-muted-foreground hover:text-foreground`}
            >
              <X size={14} />
              Cancel
            </DropdownMenuItem>

            {/* Ação destrutiva destacada */}
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault()
                onDelete()
                setConfirmingDelete(false)
              }}
              className={`${itemClass} font-semibold text-red-500 hover:bg-red-500 hover:text-white data-[highlighted]:bg-red-500 data-[highlighted]:text-white transition-colors`}
            >
              <Trash2 size={14} className="shrink-0" />
              Confirm deletion
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault()
              setConfirmingDelete(true)
            }}
            className={`${itemClass} text-red-500 hover:bg-red-500/10 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-600`}
          >
            <Trash2 size={14} className="shrink-0" />
            Delete
            <Kbd shortcut="delete" />
          </DropdownMenuItem>
        )}
        </>
        )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
