'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Clipboard,
  Copy,
  CornerLeftUp,
  FolderOpen,
  ListOrdered,
  Move,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import { CollectionItem } from '@/app/types/CollectionItem'
import { isMacPlatform } from '@/lib/platform'

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
    // Pula direto pra ponta — a mesma condição de canUp/canDown habilita
    // (ver moveToFirst/moveToLast em tree.utils.ts): só o destino muda.
    onToFirst: () => void
    onToLast: () => void
    onOut: () => void
  }
  onPaste: () => void
  // Cola como irmão do item clicado, antes ou depois dele — em vez de sempre
  // no fim da lista do pai (que é o que onPaste faz). Ausente = clique no
  // espaço vazio da árvore, onde não há "ao lado de quem" colar.
  onPasteBeside?: (position: 'before' | 'after') => void
  // Renumera os filhos diretos da pasta: "01 - ", "02 - ". Só aparece em
  // pasta com mais de um filho — numerar um item só não ordena nada.
  onNumberChildren?: () => void
  numberableCount?: number
  // Apaga a seleção inteira — ou o item clicado, quando não há seleção.
  // Apaga de verdade: a confirmação é aqui dentro, em dois passos.
  onDelete?: () => void
  // Pasta na mira leva o conteúdo junto — muda o texto da confirmação.
  deleteHasFolder?: boolean
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
  onPasteBeside,
  onNumberChildren,
  numberableCount,
  onDelete,
  deleteHasFolder,
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
  // Paste (3 opções) e Move (5 opções) viraram submenu — igual ao "voltar"
  // de Add description/Markers no menu "…" (TreeActionMenu): troca o
  // CONTEÚDO do mesmo menu, sem precisar de outro flyout posicionado à
  // parte. Sem isso o menu principal tinha virado uma lista de 15+ linhas.
  const [view, setView] = useState<'main' | 'paste' | 'move'>('main')

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
    rounded-md
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

  // "Paste" ambíguo (request) saiu: virou Paste above/below, que diz onde
  // cai sem precisar adivinhar. "Paste Here" continua só pra pasta — ali o
  // destino É a pasta, não um irmão dela.
  const showPasteInto = !targetItem || targetItem.type === 'folder'
  const pasteIntoLabel = !targetItem ? 'Paste at Root' : 'Paste Here'

  const MENU_WIDTH = 200

  // Posição medida de verdade, não um número de altura chutado à mão.
  //
  // Antes era uma constante (MENU_HEIGHT) reajustada manualmente toda vez
  // que uma entrada nova entrava no menu, e sempre ficava pra trás de novo —
  // o menu nascia cortado embaixo porque o número não acompanhou a próxima
  // entrada. A altura também muda dentro do MESMO menu aberto: a confirmação
  // de delete e a de "Open all requests" acrescentam uma linha, e nenhuma
  // constante única dá conta disso sem ser reajustada a cada mudança.
  //
  // Mede o próprio nó depois de cada render (useLayoutEffect roda ANTES da
  // tinta ir pra tela, então a correção nunca pisca) e reposiciona com base
  // no tamanho real. Sem dependências de propósito: qualquer render pode ter
  // mudado o conteúdo, e enumerar cada estado que afeta a altura seria o
  // mesmo erro de manutenção da constante, só que espalhado.
  const [pos, setPos] = useState(() => ({ left: x, top: y }))

  // Sem deps de propósito: precisa remedir a CADA render, não só quando x/y
  // mudam (ver o comentário acima — a confirmação de delete/open-all também
  // muda a altura). O bail-out no setPos abaixo é o que impede o loop
  // infinito que a regra avisa; a sugestão dela (deps [x, y]) pararia de
  // remedir justamente quando o conteúdo muda sem x/y mudar.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    // Devolve o MESMO objeto quando o valor não muda — sem isto, o
    // setState com um objeto novo a cada chamada (mesmo com os números
    // iguais) re-renderiza para sempre: o render mede de novo, acha o
    // mesmo valor, cria outro objeto, dispara outro render.
    setPos(prev => (prev.left === left && prev.top === top ? prev : { left, top }))
  })

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 9999, minWidth: MENU_WIDTH }}
      className="
        overflow-hidden
        rounded-lg
        border
        border-pm-border
        bg-pm-surface
        backdrop-blur-2xl
        p-1.5
        text-pm-text-secondary
        outline-none
        ring-0
      "
    >
      {view === 'main' && targetItem && (
        <button
          onClick={() => {
            onCopy()
            onClose()
          }}
          className={itemClass}
        >
          <Copy size={14} className="text-pm-text-muted" />
          Copy{selectionCount > 1 ? ` (${selectionCount})` : ''}
          <span className="ml-auto pl-3 text-[11px] text-pm-text-muted">{isMacPlatform ? '⌘C' : 'Ctrl+C'}</span>
        </button>
      )}

      {/* Só com um alvo: renomear vários de uma vez não quer dizer nada. */}
      {view === 'main' && targetItem && onRename && selectionCount <= 1 && (
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
      {view === 'main' && onOpenAll && openAllCount > 0 && (
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

      {/* Descrição e Markers moraram aqui e se mudaram pro menu "…"
          (TreeActionMenu): os dois ganharam vistas próprias (textarea,
          catálogo inteiro) que cresciam MUITO este menu, que já é longo —
          e o "…" tem o posicionamento do Radix de graça, que se reajusta
          sozinho ao trocar de vista; aqui era medido na mão (ver o
          comentário do useLayoutEffect acima). */}

      {/* Paste e Move viraram ponto de entrada pro submenu — ver view e os
          dois blocos abaixo. */}
      {view === 'main' && (showPasteInto || (targetItem && onPasteBeside)) && (
        <button
          onClick={() => { if (canPaste) setView('paste') }}
          disabled={!canPaste}
          className={canPaste ? itemClass : disabledItemClass}
        >
          <Clipboard size={14} className="text-pm-text-muted" />
          Paste
          <ChevronRight size={14} className="ml-auto text-pm-text-muted" />
        </button>
      )}

      {/* Mover sem arrastar. Numa árvore de centenas de itens, com rolagem,
          arrastar um passo uma posição acima é desproporcional — e sair de
          uma pasta profunda exige mira. */}
      {view === 'main' && targetItem && move && (
        <>
          <div className="my-1 h-px bg-pm-border/70" />
          <button onClick={() => setView('move')} className={itemClass}>
            <Move size={14} className="text-pm-text-muted" />
            Move
            <ChevronRight size={14} className="ml-auto text-pm-text-muted" />
          </button>
        </>
      )}

      {/* Submenu do Paste — above vem antes do "Here"/root e below depois:
          a ordem na tela segue a mesma ordem espacial de onde cada um cola. */}
      {view === 'paste' && (
        <>
          <button
            onClick={() => setView('main')}
            className={`${itemClass} text-pm-text-muted`}
          >
            <ChevronLeft size={14} />
            Paste
          </button>
          <div className="my-1 h-px bg-pm-border/70" />

          {targetItem && onPasteBeside && (
            <button
              onClick={() => { onPasteBeside('before'); onClose() }}
              className={itemClass}
            >
              <Clipboard size={14} className="text-pm-text-muted" />
              Paste above
            </button>
          )}

          {showPasteInto && (
            <button
              onClick={() => { onPaste(); onClose() }}
              className={itemClass}
            >
              <Clipboard size={14} className="text-pm-text-muted" />
              {pasteIntoLabel}
            </button>
          )}

          {targetItem && onPasteBeside && (
            <button
              onClick={() => { onPasteBeside('after'); onClose() }}
              className={itemClass}
            >
              <Clipboard size={14} className="text-pm-text-muted" />
              Paste below
            </button>
          )}
        </>
      )}

      {/* Submenu do Move. */}
      {view === 'move' && targetItem && move && (
        <>
          <button
            onClick={() => setView('main')}
            className={`${itemClass} text-pm-text-muted`}
          >
            <ChevronLeft size={14} />
            Move
          </button>
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

          {/* Pulo direto pra ponta — "Move up" dez vezes numa pasta de
              vinte fluxos não é uma opção séria. Mesma condição de
              habilitar que o passo único: só muda o destino. */}
          <button
            onClick={() => { if (move.canUp) { move.onToFirst(); onClose() } }}
            disabled={!move.canUp}
            className={move.canUp ? itemClass : disabledItemClass}
          >
            <ChevronsUp size={14} className="text-pm-text-muted" />
            Move to first
          </button>

          <button
            onClick={() => { if (move.canDown) { move.onToLast(); onClose() } }}
            disabled={!move.canDown}
            className={move.canDown ? itemClass : disabledItemClass}
          >
            <ChevronsDown size={14} className="text-pm-text-muted" />
            Move to last
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
      {view === 'main' && onNumberChildren && (numberableCount ?? 0) > 1 && (
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
      {view === 'main' && targetItem && onDelete && (
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
                    ? 'Everything inside will be deleted too. You can undo it right after.'
                    : 'You can undo it right after.'
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
              <span className="ml-auto pl-3 text-[11px] text-red-400/70">Del</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}
