'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Copy,
  CornerLeftUp,
  FolderOpen,
  FileText,
  ListOrdered,
  Pencil,
  Palette as PaletteIcon,
  Plus,
  Settings2,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { CollectionItem } from '@/app/types/CollectionItem'
import type { Marker } from '@/lib/markers'
import { MarkerGlyph } from './MarkerGlyph'
import { MARKER_COLORS, MAX_MARKER_NAME, pickColor } from '@/lib/markers'

interface Props {
  x: number
  y: number
  // Item que recebeu o clique direito — null quando o clique foi no espaço
  // vazio da árvore (contexto de "raiz").
  targetItem: CollectionItem | null
  selectionCount: number
  canPaste: boolean
  onCopy: () => void
  // Edita o nome no lugar. Mesmo caminho do F2 — que ninguém descobre sozinho.
  onRename?: () => void
  // Ausente = árvore sem reordenação pelo menu.
  move?: {
    canUp: boolean
    canDown: boolean
    canOut: boolean
    onUp: () => void
    onDown: () => void
    onOut: () => void
  }
  onPaste: () => void
  // Renumera os filhos diretos da pasta: "01 - ", "02 - ". Só aparece em
  // pasta com mais de um filho — numerar um item só não ordena nada.
  onNumberChildren?: () => void
  numberableCount?: number
  // Apaga a seleção inteira — ou o item clicado, quando não há seleção.
  // Apaga de verdade: a confirmação é aqui dentro, em dois passos.
  onDelete?: () => void
  // Pasta na mira leva o conteúdo junto — muda o texto da confirmação.
  deleteHasFolder?: boolean
  // Marcadores aplicáveis ao alvo (ver lib/markers.ts). O estado é por
  // marcador porque o alvo pode ser uma seleção: 'partial' é "alguns dos
  // selecionados têm".
  markers?: {
    catalog: Marker[]
    state: Record<string, 'on' | 'partial'>
    onToggle: (markerId: string) => void
    onCreate: (name: string, color?: string) => void
    onRecolor?: (markerId: string, color: string) => void
    onManage?: () => void
  }
  // Grava a descricao do item (ver CollectionItem.description).
  onSaveDescription?: (text: string) => void
  // Abre todas as requests da pasta em abas. `openAllCount` é quantas são —
  // o número precisa estar no rótulo antes do clique, não depois.
  onOpenAll?: () => void
  openAllCount?: number
  onClose: () => void
}

// Acima disto, abrir tudo pede confirmacao. Vinte e um pouco mais do que
// cabe na barra de abas sem rolar — dai pra cima o gesto deixa de ser
// "abrir a pasta" e vira "encher a barra".
const OPEN_ALL_CONFIRM_AT = 20

// Paleta fechada (ver MARKER_COLORS): dez quadradinhos numa fila só. Um
// seletor de cor livre deixaria dois marcadores em tons indistinguíveis na
// árvore, que é justamente onde a cor precisa funcionar — e o que lê bem no
// tema escuro costuma sumir no claro.
function Palette({ selected, onPick }: { selected: string; onPick: (color: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {MARKER_COLORS.map(color => (
        <button
          key={color}
          onClick={() => onPick(color)}
          className="size-4 rounded-[3px] transition-transform hover:scale-110"
          style={{
            backgroundColor: color,
            outline: color === selected ? '1.5px solid var(--color-pm-text)' : 'none',
            outlineOffset: 1,
          }}
        />
      ))}
    </div>
  )
}

// Menu de contexto customizado (posicionado livremente no cursor) — a árvore
// não tem nenhum menu de clique direito nativo ainda, só o dropdown de 3
// pontinhos hover (TreeActionMenu), que não serve pra essa interação porque
// precisa reagir à posição real do clique com o botão direito.
export function TreeContextMenu({
  x,
  y,
  targetItem,
  selectionCount,
  canPaste,
  onCopy,
  onRename,
  onPaste,
  onNumberChildren,
  numberableCount,
  onDelete,
  deleteHasFolder,
  markers,
  onSaveDescription,
  onOpenAll,
  openAllCount = 0,
  move,
  onClose,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  // Confirmação em dois passos dentro do próprio menu, como no menu "…". Um
  // diálogo no centro da janela pra apagar uma linha da árvore tira o olho de
  // onde o clique aconteceu.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // Abrir muitas abas de uma vez e descobrir depois e caro de desfazer: a
  // partir deste ponto o item pede confirmacao em linha, como o delete.
  const [confirmingOpenAll, setConfirmingOpenAll] = useState(false)
  // O menu troca de conteúdo no lugar em vez de abrir submenu. Um submenu
  // teria que ser posicionado à mão (este menu já nasce no cursor, perto das
  // bordas) e fecharia a cada clique — e marcar costuma ser em série:
  // "flaky" e "regressão" no mesmo item.
  const [view, setView] = useState<'main' | 'markers' | 'description'>('main')
  const [draftDescription, setDraftDescription] = useState(targetItem?.description ?? '')
  const [newMarker, setNewMarker] = useState('')
  const [newColor, setNewColor] = useState<string | null>(null)
  const [recoloring, setRecoloring] = useState<string | null>(null)
  // Cor que o marcador novo teria se ninguém escolhesse — a mesma que o
  // createMarker usaria, pra que a paleta já nasça mostrando a verdade.
  const suggestedColor = pickColor(markers?.catalog ?? [])

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const itemClass = `
    relative
    flex
    items-center
    gap-2.5
    rounded-lg
    px-3
    py-2
    text-[13px]
    font-medium
    cursor-pointer
    select-none
    outline-none
    border-none
    ring-0
    transition-all
    duration-150
    hover:bg-pm-hover
    focus:bg-pm-hover
  `

  const disabledItemClass = `${itemClass} opacity-40 cursor-not-allowed hover:bg-transparent`

  const pasteLabel = !targetItem
    ? 'Paste at Root'
    : targetItem.type === 'folder'
    ? 'Paste Here'
    : 'Paste'

  // Ajusta a posição pra não estourar a viewport quando o clique acontece
  // perto da borda direita/inferior da janela.
  const MENU_WIDTH = 200
  // Cresce com as três entradas de mover: subestimar faz o menu nascer
  // grudado na borda de baixo quando o clique é na parte inferior da árvore.
  // Reserva desde o início a linha extra da confirmação: a posição é
  // recalculada a cada render, e crescer depois faria o menu pular debaixo do
  // cursor justamente no passo em que o usuário vai clicar em "apagar".
  const MENU_HEIGHT = targetItem ? 404 : 60
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8)
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 8)

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', left, top, zIndex: 9999, minWidth: MENU_WIDTH }}
      className="
        overflow-hidden
        rounded-xl
        border
        border-pm-border
        bg-pm-surface
        backdrop-blur-2xl
        p-1.5
        text-pm-text-secondary
        shadow-[0_12px_40px_rgba(0,0,0,0.55)]
        outline-none
        ring-0
      "
    >
      {view === 'description' && onSaveDescription && targetItem ? (
        <>
          <button
            onClick={() => setView('main')}
            className={`${itemClass} text-pm-text-muted`}
          >
            <ChevronLeft size={14} />
            <span className="truncate">{targetItem.name}</span>
          </button>

          <div className="my-1 h-px bg-pm-border/70" />

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
                  onClose()
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
              <span className="text-[10px] text-pm-text-muted">⌘/Ctrl + Enter</span>
              <button
                onClick={() => {
                  onSaveDescription(draftDescription)
                  onClose()
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
          <button
            onClick={() => setView('main')}
            className={`${itemClass} text-pm-text-muted`}
          >
            <ChevronLeft size={14} />
            Markers{selectionCount > 1 ? ` · ${selectionCount} items` : ''}
          </button>

          <div className="my-1 h-px bg-pm-border/70" />

          {markers.catalog.length === 0 ? (
            <p className="px-3 py-2 text-[11px] leading-snug text-pm-text-muted">
              No markers yet. Create the first one below.
            </p>
          ) : (
            <div className="max-h-[220px] overflow-y-auto">
              {markers.catalog.map(marker => {
                const state = markers.state[marker.id]
                if (recoloring === marker.id) {
                  return (
                    <div key={marker.id} className="px-1.5 py-1">
                      <div className="mb-1 truncate text-[10px] text-pm-text-muted">{marker.name}</div>
                      <Palette
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
                      title={
                        state === 'partial'
                          ? `Some of the selected items have "${marker.name}" — click to apply to all`
                          : marker.name
                      }
                      className={`${itemClass} min-w-0 flex-1`}
                    >
                      <MarkerGlyph color={marker.color} size={12} className="shrink-0" />
                      <span className="truncate">{marker.name}</span>
                      {state && (
                        <span
                          className="ml-auto pl-2 text-[11px] text-pm-text-muted"
                          aria-label={state === 'on' ? 'applied' : 'partially applied'}
                        >
                          {/* Traço, e não meio-check: num menu de 13px um
                              ícone "indeterminado" não se distingue do check. */}
                          {state === 'on' ? '✓' : '–'}
                        </span>
                      )}
                    </button>

                    {/* Trocar a cor fica no hover, e não como linha própria:
                        a lista é de MARCAR, e um botão fixo por linha
                        competiria com o alvo principal em 200px de largura. */}
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

          <div className="my-1 h-px bg-pm-border/70" />

          {/* Criar e aplicar no mesmo gesto: ter que abrir outra tela pra
              criar o marcador antes de usá-lo é o caminho que faz ninguém
              marcar nada. */}
          <div className="flex items-center gap-1.5 px-1.5 py-1">
            <Plus size={13} className="shrink-0 text-pm-text-muted" />
            <input
              autoFocus
              value={newMarker}
              maxLength={MAX_MARKER_NAME}
              onChange={e => setNewMarker(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newMarker.trim()) {
                  markers.onCreate(newMarker, newColor ?? undefined)
                  setNewMarker('')
                  setNewColor(null)
                }
                if (e.key === 'Escape') {
                  e.nativeEvent.stopImmediatePropagation()
                  if (newMarker) setNewMarker('')
                  else setView('main')
                }
              }}
              placeholder="New marker…"
              spellCheck={false}
              className="min-w-0 flex-1 rounded border border-pm-border bg-pm-bg px-1.5 py-0.5 text-[12px] text-pm-text outline-none focus:border-[#f26b3a]/60"
            />
          </div>

          {/* A paleta do novo marcador só aparece depois que há nome: antes
              disso não há o que colorir, e ela empurraria o campo pra fora
              da altura reservada do menu. */}
          {newMarker.trim() && (
            <div className="px-1.5 pb-1">
              <Palette selected={newColor ?? suggestedColor} onPick={setNewColor} />
            </div>
          )}

          {/* Renomear e apagar não cabem aqui: as duas precisam do catálogo
              inteiro à vista (colisão de nome, quantos itens perdem a marca). */}
          {markers.onManage && (
            <>
              <div className="my-1 h-px bg-pm-border/70" />
              <button
                onClick={() => {
                  markers.onManage!()
                  onClose()
                }}
                className={`${itemClass} text-pm-text-muted`}
              >
                <Settings2 size={14} />
                Manage markers…
              </button>
            </>
          )}
        </>
      ) : (
        <>
      {targetItem && (
        <button
          onClick={() => {
            onCopy()
            onClose()
          }}
          className={itemClass}
        >
          <Copy size={14} className="text-pm-text-muted" />
          Copy{selectionCount > 1 ? ` (${selectionCount})` : ''}
        </button>
      )}

      {/* Só com um alvo: renomear vários de uma vez não quer dizer nada. */}
      {targetItem && onRename && selectionCount <= 1 && (
        <button
          onClick={() => {
            onRename()
            onClose()
          }}
          className={itemClass}
        >
          <Pencil size={14} className="text-pm-text-muted" />
          Rename
          <span className="ml-auto pl-3 text-[11px] text-pm-text-muted">F2</span>
        </button>
      )}

      {/* Abrir a pasta inteira em abas. Primeiro item do bloco porque é a
          ação de LEITURA da pasta — percorrer o fluxo do começo ao fim é o
          que se faz com uma, e até agora só dava clicando request por
          request. */}
      {onOpenAll && openAllCount > 0 && (
        <>
          {confirmingOpenAll ? (
            <>
              <button
                onClick={() => setConfirmingOpenAll(false)}
                className={`${itemClass} text-pm-text-secondary`}
              >
                <X size={14} className="text-pm-text-muted" />
                Cancel
              </button>
              <button
                onClick={() => { onOpenAll(); onClose() }}
                className={`${itemClass} font-semibold`}
              >
                <FolderOpen size={14} className="text-[#f26b3a]" />
                Open {openAllCount} tabs
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                if (openAllCount > OPEN_ALL_CONFIRM_AT) {
                  setConfirmingOpenAll(true)
                  return
                }
                onOpenAll()
                onClose()
              }}
              className={itemClass}
            >
              <FolderOpen size={14} className="text-pm-text-muted" />
              Open all requests
              <span className="ml-auto pl-3 text-[11px] tabular-nums text-pm-text-muted">
                {openAllCount}
              </span>
            </button>
          )}
          <div className="my-1 h-px bg-pm-border/70" />
        </>
      )}

      {/* Descrição: o único lugar onde pasta também pode ganhar texto — o
          editor de request não serve, pasta não tem request. */}
      {targetItem && onSaveDescription && selectionCount <= 1 && (
        <button onClick={() => setView('description')} className={itemClass}>
          <FileText size={14} className="text-pm-text-muted" />
          {targetItem.description?.trim() ? 'Edit description' : 'Add description'}
          <ChevronRight size={13} className="ml-auto pl-2 text-pm-text-muted" />
        </button>
      )}

      {/* Marcar é a ação que se repete mais, e vale em qualquer nível —
          collection, pasta, request ou example. */}
      {targetItem && markers && (
        <button onClick={() => setView('markers')} className={itemClass}>
          <Tag size={14} className="text-pm-text-muted" />
          Markers
          <span className="ml-auto flex items-center gap-1 pl-2">
            {/* As cores do que já está aplicado, direto no menu principal:
                sem isso só dá pra saber o que o item tem entrando na lista. */}
            {markers.catalog
              .filter(m => markers.state[m.id] === 'on')
              .slice(0, 4)
              .map(m => (
                <MarkerGlyph key={m.id} color={m.color} size={10} />
              ))}
            <ChevronRight size={13} className="text-pm-text-muted" />
          </span>
        </button>
      )}

      <button
        onClick={() => {
          if (!canPaste) return
          onPaste()
          onClose()
        }}
        disabled={!canPaste}
        className={canPaste ? itemClass : disabledItemClass}
      >
        <Clipboard size={14} className="text-pm-text-muted" />
        {pasteLabel}
      </button>

      {/* Mover sem arrastar. Numa árvore de centenas de itens, com rolagem,
          arrastar um passo uma posição acima é desproporcional — e sair de
          uma pasta profunda exige mira. */}
      {targetItem && move && (
        <>
          <div className="my-1 h-px bg-pm-border/70" />

          <button
            onClick={() => { if (move.canUp) { move.onUp(); onClose() } }}
            disabled={!move.canUp}
            className={move.canUp ? itemClass : disabledItemClass}
          >
            <ArrowUp size={14} className="text-pm-text-muted" />
            Move up
          </button>

          <button
            onClick={() => { if (move.canDown) { move.onDown(); onClose() } }}
            disabled={!move.canDown}
            className={move.canDown ? itemClass : disabledItemClass}
          >
            <ArrowDown size={14} className="text-pm-text-muted" />
            Move down
          </button>

          <button
            onClick={() => { if (move.canOut) { move.onOut(); onClose() } }}
            disabled={!move.canOut}
            title={move.canOut ? undefined : 'Already at the top level'}
            className={move.canOut ? itemClass : disabledItemClass}
          >
            <CornerLeftUp size={14} className="text-pm-text-muted" />
            Move out of folder
          </button>
        </>
      )}

      {/* Numerar à mão uma pasta de vinte fluxos é tedioso e desalinha ao
          inserir um no meio. */}
      {onNumberChildren && (numberableCount ?? 0) > 1 && (
        <>
          <div className="my-1 h-px bg-pm-border/70" />
          <button
            onClick={() => { onNumberChildren(); onClose() }}
            title={`Rename the ${numberableCount} items in this folder to "01 - ", "02 - "…`}
            className={itemClass}
          >
            <ListOrdered size={14} className="text-pm-text-muted" />
            Number items
          </button>
        </>
      )}

      {/* Por último e em vermelho: é o único item daqui que destrói. Apagar
          vários só existia na tecla Delete, que não se descobre sozinha. */}
      {targetItem && onDelete && (
        <>
          <div className="my-1 h-px bg-pm-border/70" />
          {confirmingDelete ? (
            <>
              {/* Cancelar vem primeiro: fica debaixo do cursor, no lugar em
                  que estava o "Delete" que acabou de ser clicado. */}
              <button
                onClick={() => setConfirmingDelete(false)}
                className={`${itemClass} text-pm-text-secondary`}
              >
                <X size={14} className="text-pm-text-muted" />
                Cancel
              </button>
              <button
                onClick={() => { onDelete(); onClose() }}
                title={
                  deleteHasFolder
                    ? 'Everything inside will be deleted too. This can’t be undone.'
                    : 'This can’t be undone.'
                }
                /* O `!` passa por cima do hover:bg-pm-hover que vem no
                   itemClass — sem ele a linha destrutiva acende cinza como
                   qualquer outra. */
                className={`${itemClass} font-semibold text-red-400 hover:bg-red-500! hover:text-white!`}
              >
                <Trash2 size={14} />
                {selectionCount > 1
                  ? `Delete ${selectionCount} items`
                  : deleteHasFolder
                  ? 'Delete folder & contents'
                  : 'Confirm deletion'}
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              className={`${itemClass} text-red-400 hover:text-red-300 hover:bg-red-500/10`}
            >
              <Trash2 size={14} />
              Delete{selectionCount > 1 ? ` (${selectionCount})` : ''}
            </button>
          )}
        </>
      )}
        </>
      )}
    </div>
  )
}
