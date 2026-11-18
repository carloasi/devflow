'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, Columns3, ExternalLink, Maximize2, Minimize2, RefreshCw, Trash2, X } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSyncDiffStrings, type SyncDiffStrings } from '@/lib/i18n/syncDiffStrings'
import { useLanguage } from '@/lib/i18n/language'
import { MergeDiffPanel } from '@/components/SyncDiff/MergeDiffHost'
import { useDraggableDialog } from '@/components/helper/useDraggableDialog'
import { useResizableDialog, type ResizeEdge } from '@/components/helper/useResizableDialog'
import { DevFlowLoader, DevFlowMark, DevFlowSpinner, ProgressStrip } from '@/components/helper/DevFlowLoader'
import { openMergeDiff } from '@/lib/sync/mergeDiffStore'
import {
  closeSyncCenter,
  isSyncCenterBusy,
  markResumeAfterReview,
  openSyncCenter,
  resultMessages,
  useRemoteBehind,
  useSyncCenter,
  withoutActions,
  type SyncCenterFilter,
  type SyncAction,
  type SyncActionResult,
  type SyncActionScope,
  type SyncCenterTab,
} from '@/lib/sync/syncCenterStore'
import { filterOverview, overviewCounts, type SyncItem, type SyncOverview } from '@/lib/sync/syncOverview'
import { TextDiffView } from '@/components/SyncDiff/TextDiffView'

// ─────────────────────────────────────────────────────────────────────────
// Central de Sincronização — um lugar só pro que entra, o que sai e o que
// pede decisão, em vez de Pull/Push/Check espalhados pela barra, pela
// árvore, pelo seletor de environment e pelo card de alerta.
//
// Tudo sai do MESMO merge de teste do push e do pull (lib/sync/syncOverview),
// lido do GitHub em modo prévia: abrir a Central não conta como "versão
// lida" e não muda nada aqui. As ações (receber, enviar, sincronizar tudo,
// resolver) usam os mesmos handlers de push e pull de sempre; parando num
// conflito, a Central sai da frente da tela de revisão.
//
// Vocabulário e cor, iguais em todo lugar: ↓ Receber (azul), ↑ Enviar
// (verde), ⚠ Conflito (âmbar).
// ─────────────────────────────────────────────────────────────────────────

export const SYNC_TONE = {
  incoming: 'text-[#9fd3f7]',
  outgoing: 'text-[#4ff09d]',
  conflicts: 'text-amber-300',
} as const

const BADGE: Record<string, string> = {
  conflict: 'bg-amber-500/15 text-amber-300',
  new: 'bg-[#4ff09d]/10 text-[#4ff09d]',
  deleted: 'bg-rose-500/15 text-rose-300',
  changed: 'bg-[#63b3ed]/15 text-[#9fd3f7]',
  moved: 'bg-pm-hover text-pm-text-secondary',
  reordered: 'bg-pm-hover text-pm-text-secondary',
}

interface LastChange {
  authorName: string
  date: string
}

interface Props {
  /** Workspace aberto; vazio = sem sincronização configurada. */
  workspace: string
  loadOverview: () => Promise<SyncOverview>
  lastChangeOf: (rootId: string) => Promise<LastChange | null>
  /**
   * Receber, enviar, os dois ou resolver — os handlers de push/pull de sempre.
   * `scope`: com a Central filtrada, o "Enviar" vale só para aquele item.
   */
  runAction: (action: SyncAction, scope?: SyncActionScope, hint?: { outgoing?: boolean }) => Promise<SyncActionResult>
  /** Volta um item (ou uma variável) daqui à versão do GitHub — nada é enviado. */
  discard: (target: { itemId?: string; envName?: string; label: string }) => Promise<SyncActionResult>
  /** Abre a request numa aba. */
  openItem: (itemId: string) => void
  /** Para a ação em curso no próximo ponto seguro. */
  cancelAction?: () => void
}

function timeAgo(iso: string, t: SyncDiffStrings, locale: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!iso || !Number.isFinite(ms)) return ''
  const min = Math.round(ms / 60000)
  if (min < 1) return t.justNow
  if (min < 60) return t.minAgo(min)
  const h = Math.round(min / 60)
  if (h < 24) return t.hoursAgo(h)
  const d = Math.round(h / 24)
  if (d < 30) return t.daysAgo(d)
  return new Date(iso).toLocaleDateString(locale)
}

/** Itens agrupados pela collection (o primeiro nome do caminho). */
function groupByCollection(items: SyncItem[]): { name: string; rootId?: string; items: SyncItem[] }[] {
  const groups = new Map<string, { name: string; rootId?: string; items: SyncItem[] }>()
  for (const item of items) {
    const name = item.path[0] ?? '—'
    const key = item.rootId ?? name
    const group = groups.get(key) ?? { name, rootId: item.rootId, items: [] }
    group.items.push(item)
    groups.set(key, group)
  }
  return [...groups.values()]
}

/**
 * Confirmação do "Descartar" / "Apagar daqui", numa janela própria: diz
 * exatamente o que vai acontecer, e que o item NÃO sai só do envio (do
 * commit) — ele muda (ou some) neste computador. Antes era uma faixa dentro
 * da linha, fácil de ler como "tirar da lista do que vai subir".
 */
function DiscardConfirm({
  title,
  text,
  deletes = false,
  onConfirm,
  onCancel,
  busy,
}: {
  title: string
  text: string
  /** Apaga o item (criado aqui): o aviso e o botão dizem "apagar". */
  deletes?: boolean
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}) {
  const t = useSyncDiffStrings()
  return (
    <AlertDialog open onOpenChange={open => { if (!open) onCancel() }}>
      <AlertDialogContent className="flex flex-col w-[420px] max-w-[calc(100vw-32px)]! gap-0 p-0 overflow-hidden rounded-lg border border-pm-border bg-pm-surface text-pm-text shadow-2xl font-sans">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-pm-border">
          <span className="w-[22px] h-[22px] shrink-0 rounded-md bg-rose-500/15 text-rose-400 flex items-center justify-center">
            {deletes ? <Trash2 size={13} /> : <AlertTriangle size={13} />}
          </span>
          <AlertDialogTitle className="min-w-0 flex-1 text-[13px] font-semibold text-pm-text">{title}</AlertDialogTitle>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3">
          <p className="rounded-md border border-rose-500/30 bg-rose-500/5 px-2.5 py-2 text-[12px] font-medium text-rose-200 leading-relaxed">
            {deletes ? t.scDeleteNotJustCommit : t.scDiscardNotJustCommit}
          </p>
          <AlertDialogDescription className="text-[12px] text-pm-text-secondary leading-relaxed text-left">{text}</AlertDialogDescription>
          <p className="text-[11px] text-pm-text-muted">{t.scSendWithoutHint}</p>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-pm-border">
          <AlertDialogCancel className="h-7! px-3! rounded-md! text-xs! font-medium! border! border-pm-border! bg-transparent! text-pm-text-secondary! hover:bg-pm-hover! cursor-pointer">
            {t.scDiscardCancel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={busy}
            className="h-7! px-3! rounded-md! text-xs! font-semibold! text-white! bg-rose-600! hover:bg-rose-600/90! disabled:opacity-50 cursor-pointer"
          >
            {deletes ? t.scRemoveHere : t.scDiscard}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Botão pequeno da barra de ações de uma linha aberta. */
function RowAction({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="h-6 px-2 inline-flex items-center gap-1 rounded border border-pm-border text-[11px] text-pm-text-secondary hover:text-pm-text hover:bg-pm-hover disabled:opacity-40 cursor-pointer"
    >
      {children}
    </button>
  )
}

/**
 * Pasta nova ou apagada: as requests de dentro, cada uma abrindo o detalhe
 * completo (método, URL, headers, payload, scripts). A primeira já vem aberta
 * quando só há uma.
 */
function InsideRequests({ requests, outgoing }: { requests: NonNullable<SyncItem['requests']>; outgoing: boolean }) {
  const t = useSyncDiffStrings()
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(requests.length === 1 ? [requests[0].id] : []))
  const toggle = (id: string) =>
    setOpenIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div>
      <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-pm-text-muted">
        {t.scInsideRequests(requests.length)}
      </div>
      <div className="flex flex-col gap-0.5">
        {requests.map(request => {
          const isOpen = openIds.has(request.id)
          // A 1ª linha do texto é "MÉTODO URL": o resumo da request fechada.
          const summary = (request.after || request.before).split('\n')[0]
          return (
            <div key={request.id}>
              <button
                type="button"
                onClick={() => toggle(request.id)}
                className="w-full flex items-center gap-1.5 px-1 py-0.5 text-left rounded hover:bg-pm-hover cursor-pointer"
                title={request.path.join(' / ')}
              >
                {isOpen ? (
                  <ChevronDown size={10} className="shrink-0 text-pm-text-muted" />
                ) : (
                  <ChevronRight size={10} className="shrink-0 text-pm-text-muted" />
                )}
                <span className="shrink-0 text-[11.5px] text-pm-text">{request.path.join(' / ')}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-pm-text-muted">{summary}</span>
              </button>
              {isOpen && (
                <div className="pl-4 pt-0.5">
                  <TextDiffView
                    before={outgoing ? request.after : request.before}
                    after={outgoing ? request.before : request.after}
                    beforeLabel={outgoing ? t.github : t.rcHere}
                    afterLabel={outgoing ? t.rcHere : t.github}
                    emptyText=""
                    collapsedText={t.collapsedLines}
                    hideEmptySide
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ItemRow({
  item,
  tab,
  open,
  onToggle,
  onViewDiff,
  onSend,
  onDiscard,
  onOpen,
  busy,
}: {
  item: SyncItem
  tab: SyncCenterTab
  open: boolean
  onToggle: () => void
  onViewDiff: () => void
  /** "Para enviar": manda só este item (pasta ou request). */
  onSend?: () => void
  /** "Para enviar": volta este item à versão do GitHub. */
  onDiscard?: () => Promise<void>
  /** Abre a request numa aba. */
  onOpen?: () => void
  busy?: boolean
}) {
  const t = useSyncDiffStrings()
  const [confirming, setConfirming] = useState(false)
  const [showFull, setShowFull] = useState(false)
  // Os campos que mudaram, e a request inteira (com o payload) à parte.
  const fieldDiffs = item.fields.filter(f => f.field !== 'content')
  const content = item.fields.find(f => f.field === 'content')
  // Novo ou apagado (ou sem campo pra comparar): a request inteira É a
  // mudança. Alterado: os campos primeiro, a request completa num clique.
  const contentDirect = !!content && (item.change === 'new' || item.change === 'deleted' || fieldDiffs.length === 0)
  const kind = item.conflict ? 'conflict' : item.change
  const name = item.path[item.path.length - 1]
  const moved = (item.change === 'moved' || item.change === 'reordered') && !!item.localPath && !!item.remotePath
  // "Para enviar" sempre abre: é lá que ficam Abrir, Enviar e Descartar.
  const canExpand = item.fields.length > 0 || moved || !!onDiscard || !!onOpen
  // "Para enviar": de como está no GitHub pra como está aqui. Nos outros, o
  // contrário — o que vai mudar AQUI.
  const outgoing = tab === 'outgoing'
  const from = outgoing ? item.remotePath : item.localPath
  const to = outgoing ? item.localPath : item.remotePath
  return (
    <div className={`group/item relative rounded-md ${open ? 'bg-pm-hover/40' : ''}`}>
      <button
        type="button"
        onClick={canExpand ? onToggle : undefined}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-left rounded-md ${canExpand ? 'hover:bg-pm-hover cursor-pointer' : 'cursor-default'}`}
        title={item.path.join(' / ')}
      >
        {canExpand ? (
          open ? <ChevronDown size={11} className="shrink-0 text-pm-text-muted" /> : <ChevronRight size={11} className="shrink-0 text-pm-text-muted" />
        ) : (
          <span className="w-[11px] shrink-0" />
        )}
        <span
          className={`shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide ${BADGE[kind] ?? BADGE.changed}`}
          // O selo diz o que aconteceu, e de que lado.
          title={t.scBadgeHint(kind, tab)}
        >
          {t.rcBadge[kind] ?? kind}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-pm-text">
          {item.path.length > 2 && <span className="text-pm-text-muted">{item.path.slice(1, -1).join(' / ')} / </span>}
          {name}
        </span>
        {fieldDiffs.length > 0 && (
          <span className={`shrink-0 truncate max-w-[180px] text-[10.5px] text-pm-text-muted ${onSend ? 'pr-20' : 'pr-6'}`}>
            {fieldDiffs.map(f => f.field).join(', ')}
          </span>
        )}
      </button>
      {onSend && (
        <button
          type="button"
          onClick={onSend}
          disabled={busy}
          title={t.scSendThisTitle}
          className={`absolute top-1 h-5 px-1.5 inline-flex items-center gap-1 rounded text-[10.5px] text-pm-text-secondary opacity-0 group-hover/item:opacity-100 focus:opacity-100 hover:text-pm-text hover:bg-pm-hover disabled:opacity-30 cursor-pointer ${item.fields.length > 0 ? 'right-7' : 'right-1'}`}
        >
          <ArrowUp size={10} className={SYNC_TONE.outgoing} />
          {t.scSendThis}
        </button>
      )}
      {item.fields.length > 0 && (
        <button
          type="button"
          onClick={onViewDiff}
          title={t.scDiffViewTitle}
          aria-label={t.rcViewDiff}
          className="absolute right-1 top-1 h-5 w-5 flex items-center justify-center rounded text-pm-text-muted opacity-0 group-hover/item:opacity-100 focus:opacity-100 hover:text-pm-text hover:bg-pm-hover cursor-pointer"
        >
          <Columns3 size={11} />
        </button>
      )}
      {open && canExpand && (
        <div className="flex flex-col gap-1.5 px-2 pb-2 pt-0.5 pl-6">
          <p className="text-[11px] text-pm-text-muted">{t.scBadgeHint(kind, tab)}</p>
          {moved && from && to && (
            <p className="text-[11px] text-pm-text-secondary">{t.scMovedFromTo(from.join(' / '), to.join(' / '))}</p>
          )}
          {(onOpen || onSend || onDiscard) && !confirming && (
            <div className="flex flex-wrap items-center gap-1.5">
              {onOpen && <RowAction onClick={onOpen}>{t.scOpenInTab}</RowAction>}
              {onSend && (
                <RowAction onClick={onSend} disabled={busy} title={t.scSendThisTitle}>
                  <ArrowUp size={10} className={SYNC_TONE.outgoing} />
                  {t.scSendThis}
                </RowAction>
              )}
              {onDiscard && (
                <RowAction onClick={() => setConfirming(true)} disabled={busy} title={t.scDiscardTitle}>
                  {item.change === 'new' ? <Trash2 size={10} className="text-rose-300" /> : <X size={10} className="text-rose-300" />}
                  {item.change === 'new' ? t.scRemoveHere : t.scDiscard}
                </RowAction>
              )}
            </div>
          )}
          {confirming && onDiscard && (
            <DiscardConfirm
              title={item.change === 'new' ? t.scDeleteDialogTitle(name) : t.scDiscardDialogTitle(name)}
              deletes={item.change === 'new'}
              text={`${t.scDiscardConfirm(item.change, name, item.kind === 'folder', item.insideRequests ?? 0)}${item.missingParent ? ` ${t.scDiscardNeedsParent(name, item.missingParent)}` : ''}`}
              busy={busy}
              onCancel={() => setConfirming(false)}
              onConfirm={() => {
                setConfirming(false)
                void onDiscard()
              }}
            />
          )}
          {[...fieldDiffs, ...(content && (contentDirect || showFull) ? [content] : [])].map(field => (
            <div key={field.field}>
              <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-pm-text-muted">
                {field.field === 'content' ? t.scContent : field.field}
              </div>
              <TextDiffView
                before={outgoing ? field.after : field.before}
                after={outgoing ? field.before : field.after}
                beforeLabel={outgoing ? t.github : t.rcHere}
                afterLabel={outgoing ? t.rcHere : t.github}
                emptyText=""
                collapsedText={t.collapsedLines}
                // Item novo ou apagado: o lado vazio é "não existe", não um valor.
                hideEmptySide={field.field === 'content' && (item.change === 'new' || item.change === 'deleted')}
              />
            </div>
          ))}
          {!!item.requests?.length && <InsideRequests requests={item.requests} outgoing={outgoing} />}
          {content && !contentDirect && (
            <button
              type="button"
              onClick={() => setShowFull(v => !v)}
              className="self-start text-[11px] text-[#9fd3f7] hover:underline cursor-pointer"
            >
              {showFull ? t.scHideFullRequest : t.scShowFullRequest}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Uma variável (ou um environment inteiro) na Central. Clicar abre o diff do
 * valor — antes só o nome aparecia, e não dava pra ver o que ia subir.
 */
function EnvRow({
  name,
  note,
  tab,
  value,
  open,
  onToggle,
  onDiscard,
  busy,
}: {
  name: string
  note: string
  tab: SyncCenterTab
  value?: { local?: string; remote?: string }
  open: boolean
  onToggle: () => void
  onDiscard?: () => Promise<void>
  busy?: boolean
}) {
  const t = useSyncDiffStrings()
  const [confirming, setConfirming] = useState(false)
  const hasValues = !!value && (value.local !== undefined || value.remote !== undefined)
  const canExpand = hasValues || !!onDiscard
  // "Para enviar": do GitHub pra cá (o que sobe). Recebidos: daqui pro GitHub
  // (o que vai mudar aqui).
  const outgoing = tab === 'outgoing'
  const [envName, ...rest] = name.split(' › ')
  return (
    <div className={`rounded-md ${open ? 'bg-pm-hover/40' : ''}`}>
      <button
        type="button"
        onClick={canExpand ? onToggle : undefined}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-left rounded-md ${canExpand ? 'hover:bg-pm-hover cursor-pointer' : 'cursor-default'}`}
        title={name}
      >
        {canExpand ? (
          open ? <ChevronDown size={11} className="shrink-0 text-pm-text-muted" /> : <ChevronRight size={11} className="shrink-0 text-pm-text-muted" />
        ) : (
          <span className="w-[11px] shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-pm-text">
          {rest.length > 0 ? (
            <>
              <span className="text-pm-text-muted">{envName} › </span>
              {rest.join(' › ')}
            </>
          ) : (
            envName
          )}
        </span>
        {note && <span className="shrink-0 text-[10.5px] text-amber-300/90">{note}</span>}
      </button>
      {open && canExpand && (
        <div className="flex flex-col gap-1.5 px-2 pb-2 pt-0.5 pl-6">
          {onDiscard && !confirming && (
            <div className="flex items-center gap-1.5">
              <RowAction onClick={() => setConfirming(true)} disabled={busy} title={t.scDiscardTitle}>
                <X size={10} className="text-rose-300" />
                {t.scDiscard}
              </RowAction>
            </div>
          )}
          {confirming && onDiscard && (
            <DiscardConfirm
              title={t.scDiscardEnvDialogTitle(name)}
              text={t.scDiscardEnvConfirm(name)}
              busy={busy}
              onCancel={() => setConfirming(false)}
              onConfirm={() => {
                setConfirming(false)
                void onDiscard()
              }}
            />
          )}
          {hasValues && (
            <TextDiffView
              before={(outgoing ? value!.remote : value!.local) ?? ''}
              after={(outgoing ? value!.local : value!.remote) ?? ''}
              beforeLabel={outgoing ? t.github : t.rcHere}
              afterLabel={outgoing ? t.rcHere : t.github}
              emptyText=""
              collapsedText={t.collapsedLines}
            />
          )}
        </div>
      )}
    </div>
  )
}

function CollectionGroup({
  group,
  tab,
  lastChangeOf,
  openId,
  setOpenId,
  onViewDiff,
  onSend,
  onDiscard,
  onOpen,
  busy,
}: {
  group: { name: string; rootId?: string; items: SyncItem[] }
  tab: SyncCenterTab
  lastChangeOf: Props['lastChangeOf']
  openId: string | null
  setOpenId: (id: string | null) => void
  onViewDiff: (focusId: string) => void
  /** Só em "Para enviar": manda um item (ou a collection inteira, sem id). */
  onSend?: (scope: SyncActionScope) => void
  /** Só em "Para enviar": volta um item (ou a collection inteira) ao GitHub. */
  onDiscard?: (target: { itemId: string; label: string }) => Promise<void>
  onOpen?: (itemId: string) => void
  busy?: boolean
}) {
  const t = useSyncDiffStrings()
  const locale = useLanguage()
  const [last, setLast] = useState<LastChange | null>(null)
  const [confirmingAll, setConfirmingAll] = useState(false)
  const rootItem = group.items.find(i => i.id === group.rootId)
  // Quem mexeu por último lá — só faz sentido no que vem do GitHub.
  useEffect(() => {
    if (tab === 'outgoing' || !group.rootId) return
    let alive = true
    lastChangeOf(group.rootId)
      .then(change => {
        if (alive) setLast(change)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [tab, group.rootId, lastChangeOf])

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2 px-2 pt-1">
        <span className="text-[11px] font-semibold text-pm-text-secondary">{group.name}</span>
        {last?.authorName && (
          <span className="truncate text-[10.5px] text-pm-text-muted">
            {t.scLastChange(last.authorName, last.date ? timeAgo(last.date, t, locale) : '')}
          </span>
        )}
        {group.rootId && (onSend || onDiscard) && (
          <span className="ml-auto flex items-center gap-1">
            {onDiscard && (
              <button
                type="button"
                onClick={() => setConfirmingAll(true)}
                disabled={busy}
                title={t.scDiscardTitle}
                className="h-5 px-1.5 inline-flex items-center gap-1 rounded text-[10.5px] text-pm-text-muted hover:text-rose-300 hover:bg-pm-hover disabled:opacity-40 cursor-pointer"
              >
                {rootItem?.change === 'new' ? <Trash2 size={10} /> : <X size={10} />}
                {rootItem?.change === 'new' ? t.scRemoveHere : t.scDiscardAll}
              </button>
            )}
            {onSend && (
              <button
                type="button"
                onClick={() => onSend({ rootId: group.rootId, label: group.name })}
                disabled={busy}
                className="h-5 px-1.5 inline-flex items-center gap-1 rounded text-[10.5px] text-pm-text-secondary hover:text-pm-text hover:bg-pm-hover disabled:opacity-40 cursor-pointer"
              >
                <ArrowUp size={10} className={SYNC_TONE.outgoing} />
                {t.scSendOnlyScoped(group.name)}
              </button>
            )}
          </span>
        )}
      </div>
      {confirmingAll && onDiscard && group.rootId && (
        <div>
          <DiscardConfirm
            title={t.scDiscardAllDialogTitle(group.name, rootItem?.change === 'new')}
            deletes={rootItem?.change === 'new'}
            // Collection criada aqui é APAGADA inteira — o aviso diz isso.
            text={t.scDiscardAllConfirm(group.name, rootItem?.change === 'new', rootItem?.insideRequests ?? 0)}
            busy={busy}
            onCancel={() => setConfirmingAll(false)}
            onConfirm={() => {
              setConfirmingAll(false)
              void onDiscard({ itemId: group.rootId!, label: group.name })
            }}
          />
        </div>
      )}
      {group.items.map(item => (
        <ItemRow
          key={item.id}
          item={item}
          tab={tab}
          open={openId === item.id}
          onToggle={() => setOpenId(openId === item.id ? null : item.id)}
          onViewDiff={() => onViewDiff(item.id)}
          // Item apagado aqui não tem o que enviar sozinho: a exclusão sobe
          // com o envio da collection (ou do workspace).
          onSend={
            onSend && group.rootId && item.change !== 'deleted' && item.id !== group.rootId
              ? () =>
                  onSend({
                    rootId: group.rootId,
                    itemId: item.id,
                    label: item.path[item.path.length - 1],
                  })
              : undefined
          }
          onDiscard={onDiscard ? () => onDiscard({ itemId: item.id, label: item.path[item.path.length - 1] }) : undefined}
          onOpen={
            onOpen && item.existsHere && (item.kind === 'request' || item.kind === 'example')
              ? () => onOpen(item.id)
              : undefined
          }
          busy={busy}
        />
      ))}
    </div>
  )
}

// Esc com a diferença aberta volta pra lista em vez de fechar a Central
// (quem decide é o corpo; o Dialog só pergunta).
let escapeOverride: (() => boolean) | null = null

function SyncCenterBody({ workspace, loadOverview, lastChangeOf, runAction, discard, openItem, cancelAction, initialTab, filter, initialResult, onWideChange, dragHandle, maximize }: Props & {
  initialTab?: SyncCenterTab
  filter?: SyncCenterFilter
  /** A ação que terminou depois da revisão (a Central voltou com ela). */
  initialResult?: SyncActionResult
  /** A diferença lado a lado pede a janela mais larga. */
  onWideChange?: (wide: boolean) => void
  /** Cabeçalho que arrasta a janela (e volta ao centro no duplo clique). */
  dragHandle?: React.HTMLAttributes<HTMLDivElement>
  /** Maximizar / voltar ao tamanho. */
  maximize?: { maximized: boolean; toggle: () => void }
}) {
  const t = useSyncDiffStrings()
  const [overview, setOverview] = useState<SyncOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [running, setRunning] = useState<SyncAction | null>(null)
  // O que o push e o pull disseram na última ação — com a Central aberta, o
  // painel do GitHub (onde isso aparecia) está fechado.
  const [lastResult, setLastResult] = useState<SyncActionResult | null>(initialResult ?? null)
  // Arquivos que mudaram no GitHub desde a última sincronização (o ↓ da barra).
  const behindCount = useRemoteBehind(workspace) ?? 0
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const locale = useLanguage()

  // Cada leitura tem um número: só a última vale. Uma leitura cancelada (ou
  // ultrapassada por outra mais nova) termina sem mexer na lista.
  const readSeq = useRef(0)
  const refresh = useCallback(async () => {
    if (!workspace) return
    const seq = ++readSeq.current
    setLoading(true)
    setError(null)
    try {
      const next = await loadOverview()
      if (seq !== readSeq.current) return
      setOverview(next)
      setCheckedAt(new Date())
    } catch (e) {
      if (seq !== readSeq.current) return
      setError((e as Error)?.message || t.scReadFailed)
    } finally {
      if (seq === readSeq.current) setLoading(false)
    }
  }, [workspace, loadOverview, t])
  /** Cancela a leitura em curso: a lista fica como estava (ou vazia, com "Tentar de novo"). */
  const cancelRead = () => {
    readSeq.current++
    setLoading(false)
    if (!overview) setError(t.scLoadCancelled)
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  const shown = useMemo(() => (overview ? filterOverview(overview, filter) : null), [overview, filter])
  const counts = shown ? overviewCounts(shown) : null
  // Sem aba pedida: a primeira que tem algo, conflito primeiro.
  const [tab, setTab] = useState<SyncCenterTab | null>(initialTab ?? null)
  const activeTab: SyncCenterTab =
    tab ?? (counts?.conflicts ? 'conflicts' : counts?.incoming ? 'incoming' : counts?.outgoing ? 'outgoing' : 'incoming')

  const items = shown ? (activeTab === 'incoming' ? shown.incoming : activeTab === 'outgoing' ? shown.outgoing : shown.conflicts) : []
  const envNames = shown
    ? activeTab === 'incoming'
      ? shown.envIncoming.map(name => ({ name, note: '' }))
      : activeTab === 'outgoing'
        ? [...shown.envOutgoing.map(name => ({ name, note: '' })), ...shown.envKeptMine.map(name => ({ name, note: t.scKeptMine }))]
        : []
    : []
  const groups = groupByCollection(items)
  const tabLabel = { incoming: t.scTabIncoming, outgoing: t.scTabOutgoing, conflicts: t.scTabConflicts }
  const forMergeDiff = (list: SyncItem[]) =>
    list.map(i => {
      const real = i.fields.filter(f => f.field !== 'content')
      return real.length > 0 ? { ...i, fields: real } : i
    })
  // "Ver diferença": troca o conteúdo DESTA janela pela visão lado a lado
  // (antes abria outra janela por cima da Central). "Voltar à lista" (ou Esc)
  // volta.
  const [diffFocusId, setDiffFocusId] = useState<string | null>(null)
  // O item aberto na visão lado a lado (pode não ser o do clique inicial).
  const diffSelectedRef = useRef<string | null>(null)
  const viewDiff = (focusId: string) => {
    diffSelectedRef.current = focusId
    setDiffFocusId(focusId)
  }
  // O jeito anterior: a mesma visão numa janela separada, por cima da Central.
  const openDiffInWindow = () => {
    openMergeDiff({
      title: `${tabLabel[activeTab]} — ${workspace}`,
      items: forMergeDiff(items),
      focusId: diffSelectedRef.current ?? diffFocusId ?? undefined,
    })
    setDiffFocusId(null)
  }
  useEffect(() => {
    onWideChange?.(diffFocusId !== null)
    escapeOverride = diffFocusId !== null
      ? () => {
          setDiffFocusId(null)
          return true
        }
      : null
    return () => {
      escapeOverride = null
    }
  }, [diffFocusId, onWideChange])

  const tabs: { id: SyncCenterTab; icon: React.ReactNode; count: number | undefined }[] = [
    { id: 'incoming', icon: <ArrowDown size={12} />, count: counts?.incoming },
    { id: 'outgoing', icon: <ArrowUp size={12} />, count: counts?.outgoing },
    { id: 'conflicts', icon: <AlertTriangle size={12} />, count: counts?.conflicts },
  ]
  const hint = { incoming: t.scIncomingHint, outgoing: t.scOutgoingHint, conflicts: t.scConflictsHint }[activeTab]

  // As contagens do workspace inteiro (o filtro só recorta a lista): é
  // sobre ele que os botões agem.
  const total = overview ? overviewCounts(overview) : null
  const scope: SyncActionScope | undefined = filter?.rootId || filter?.environmentName
    ? { rootId: filter.rootId, itemId: filter.itemId, environmentName: filter.environmentName, label: filter.label }
    : undefined
  // O que vai subir, contado ANTES da ação — pra faixa dizer o que foi
  // enviado, e não só "pushed to GitHub".
  const sendSummary = (action: SyncAction, explicitScope?: SyncActionScope): string | null => {
    if (action !== 'send' && action !== 'all') return null
    if (explicitScope?.label) return t.scSentItem(explicitScope.label)
    const source = action === 'send' && scope ? shown : overview
    if (!source) return null
    const items = source.outgoing.length
    const envs = source.envOutgoing.length + source.envKeptMine.length
    return items + envs > 0 ? t.scSentSummary(items, envs) : null
  }
  const run = async (action: SyncAction, explicitScope?: SyncActionScope) => {
    setRunning(action)
    setLastResult(null)
    const summary = sendSummary(action, explicitScope)
    try {
      // Filtrada, só o "Enviar" fica no item; receber é sempre do workspace.
      // "Sincronizar tudo" envia pelo que a Central mostrou em "Para enviar",
      // não só pela pendência marcada (que nem sempre a acompanha).
      const result = await runAction(action, action === 'send' ? explicitScope ?? scope : undefined, {
        outgoing: !!total && total.outgoing > 0,
      })
      // Parou num conflito: a tela de revisão assume.
      if (result.result === 'review') {
        // Ao aplicar (ou fechar) a revisão, a Central volta — com o resultado
        // do envio que a mescla destrava (ver handleApplyDiffAndReturn).
        markResumeAfterReview({
          tab: activeTab,
          filter,
          // Sem o "Desfazer": depois de uma revisão que envia, ele já não
          // vale (o botão voltava na faixa e não fazia nada).
          messages: withoutActions(result.messages),
          continueSend: result.continueSend,
          outgoing: !!total && total.outgoing > 0,
        })
        closeSyncCenter()
        return
      }
      // Enviou de verdade (o push disse que subiu): a faixa abre com o que foi.
      const pushed = result.result === 'done' && result.messages.some(m => m.type === 'success')
      setLastResult(
        summary && pushed
          ? { ...result, messages: [{ type: 'success', message: summary }, ...result.messages] }
          : result
      )
      // Volta pra aba que ainda tem algo (ou pro "tudo sincronizado"), em vez
      // de ficar na que acabou de esvaziar.
      if (result.result === 'done') setTab(null)
    } finally {
      setRunning(null)
      setCancelling(false)
    }
    void refresh()
  }
  const [discarding, setDiscarding] = useState(false)
  const busy = running !== null || loading || discarding
  // "Cancelar": durante uma ação, pede pra parar no próximo ponto seguro (o
  // botão fica em "Cancelando…" até ela voltar); só lendo, descarta a leitura.
  const [cancelling, setCancelling] = useState(false)
  const cancel = () => {
    if (running !== null) {
      setCancelling(true)
      cancelAction?.()
    } else if (loading) {
      cancelRead()
    }
  }
  const canCancel = running !== null ? !!cancelAction : loading
  // "Descartar": o resultado (com "Desfazer") vai pra faixa, e a lista recarrega.
  const discardTarget = async (target: { itemId?: string; envName?: string; label: string }) => {
    setDiscarding(true)
    setLastResult(null)
    try {
      setLastResult(await discard(target))
    } finally {
      setDiscarding(false)
    }
    void refresh()
  }
  // Com arquivo mudado lá e nada a mesclar (mudança igual à sua), o receber
  // ainda é o que marca esses arquivos como lidos e zera o ↓ da barra.
  const canReceive = !!total && (total.incoming + total.conflicts > 0 || behindCount > 0)
  // Filtrada: só o que é do item conta pro "Enviar só ...".
  const canSend = scope ? !!counts && counts.outgoing > 0 : !!total && total.outgoing > 0
  const canAll = !!total && (total.incoming + total.outgoing + total.conflicts > 0 || behindCount > 0)
  const markerRows = shown && activeTab === 'incoming'
    ? [
        ...shown.markers.added.map(name => ({ name, kind: 'new' })),
        ...shown.markers.changed.map(name => ({ name, kind: 'changed' })),
        ...shown.markers.removed.map(name => ({ name, kind: 'deleted' })),
      ]
    : []
  const empty = { incoming: t.scEmptyIncoming, outgoing: t.scEmptyOutgoing, conflicts: t.scEmptyConflicts }[activeTab]
  // Nada a receber, enviar nem decidir (e, sem filtro, nenhum arquivo novo lá):
  // a tela diz isso com todas as letras, em vez de três abas vazias.
  const allSynced =
    !!counts && counts.incoming + counts.outgoing + counts.conflicts === 0 && (!!scope || behindCount === 0)
  const sessionTokens = shown?.envSessionTokens.length ?? 0
  // "1 nova · 2 alteradas · 1 variável de environment": o todo da aba de uma
  // vez, sem abrir item por item.
  const tabSummary = (() => {
    if (!shown || allSynced) return ''
    const count = (change: string) => items.filter(i => !i.conflict && i.change === change).length
    const parts = [
      count('new') && t.scCountNew(count('new')),
      count('changed') && t.scCountChanged(count('changed')),
      count('deleted') && t.scCountDeleted(count('deleted')),
      count('moved') + count('reordered') && t.scCountMoved(count('moved') + count('reordered')),
      activeTab === 'conflicts' && items.length && t.scCountConflicts(items.length),
      envNames.length && t.scCountEnv(envNames.length),
      markerRows.length && t.scCountMarkers(markerRows.length),
    ].filter(Boolean)
    return parts.join(' · ')
  })()

  return (
    <>
      <div {...dragHandle} className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-pm-border select-none">
        {/* A marca gira enquanto algo carrega (a lista, uma ação). */}
        <DevFlowMark size={16} animated={loading || running !== null || discarding} />
        <DialogTitle className="text-[13px] font-semibold text-pm-text">{t.scTitle}</DialogTitle>
        <span className="truncate text-[11.5px] text-pm-text-muted">{workspace}</span>
        {(loading || running !== null) && shown && (
          <span className="truncate text-[11px] text-[#9fd3f7]">{running ? t.scRunning : t.scRefreshing}</span>
        )}
        <div className="flex-1" />
        {maximize && (
          <button
            type="button"
            onClick={maximize.toggle}
            title={maximize.maximized ? t.restore : t.maximize}
            aria-label={maximize.maximized ? t.restore : t.maximize}
            className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
          >
            {maximize.maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || !workspace}
          title={t.scRefresh}
          aria-label={t.scRefresh}
          className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover disabled:opacity-40 transition-colors cursor-pointer"
        >
          {loading ? <DevFlowSpinner size={14} /> : <RefreshCw size={13} />}
        </button>
        <button
          type="button"
          onClick={closeSyncCenter}
          aria-label={t.close}
          title={`${t.close} (Esc)`}
          className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>

      {/* Abas */}
      <div className="shrink-0 flex items-center gap-1 px-3 pt-2 border-b border-pm-border">
        {tabs.map(({ id, icon, count }) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              setTab(id)
              setDiffFocusId(null)
            }}
            className={`flex items-center gap-1.5 px-3 h-8 -mb-px border-b-2 text-[12px] cursor-pointer transition-colors ${
              activeTab === id ? 'border-[#f26b3a] text-pm-text' : 'border-transparent text-pm-text-muted hover:text-pm-text'
            }`}
          >
            <span className={SYNC_TONE[id]}>{icon}</span>
            {tabLabel[id]}
            {count !== undefined && (
              <span className={`tabular-nums text-[11px] ${count > 0 ? SYNC_TONE[id] : 'text-pm-text-muted'}`}>{count}</span>
            )}
          </button>
        ))}
        {filter?.label && (
          <span className="ml-auto mb-1 flex items-center gap-1.5 rounded-md bg-pm-hover px-2 py-0.5 text-[11px] text-pm-text-secondary">
            {t.scFilteredBy(filter.label)}
            <button
              type="button"
              onClick={() => openSyncCenter({ tab: activeTab })}
              className="text-[#9fd3f7] hover:underline cursor-pointer"
            >
              {t.scShowAll}
            </button>
          </span>
        )}
      </div>

      {/* Carregando com algo já na tela: a barra corre, sem esconder a lista. */}
      <ProgressStrip active={!!shown && (loading || running !== null || discarding)} />

      {lastResult && resultMessages(lastResult).length > 0 && (
        <div
          className={`shrink-0 flex items-start gap-2 px-4 py-2 border-b border-pm-border text-[11.5px] ${
            lastResult.result === 'failed' ? 'bg-rose-500/10 text-rose-200' : 'bg-emerald-500/5 text-pm-text-secondary'
          }`}
          role="status"
        >
          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
            {resultMessages(lastResult)
              // Falhou: os erros. Senão, os resultados de cada passo (sem o
              // progresso, que empurrava pra fora o "Pulled N [Desfazer]").
              .slice(-4)
              .map((m, i) => (
                <div key={i} className="flex items-baseline gap-2">
                  <span className={m.type === 'error' ? 'text-rose-300' : m.type === 'success' ? 'text-[#4ff09d]' : 'text-[#9fd3f7]'}>
                    {m.type === 'error' ? '!' : m.type === 'success' ? '✓' : 'i'}
                  </span>
                  <span className="min-w-0 break-words">{m.message}</span>
                  {m.action && (
                    <button
                      type="button"
                      onClick={() => {
                        m.action?.run()
                        setLastResult(null)
                        void refresh()
                      }}
                      className="shrink-0 text-[#9fd3f7] hover:underline cursor-pointer"
                    >
                      {m.action.label}
                    </button>
                  )}
                </div>
              ))}
          </div>
          <button
            type="button"
            onClick={() => setLastResult(null)}
            aria-label={t.scResultDismiss}
            title={t.scResultDismiss}
            className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover cursor-pointer"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {diffFocusId !== null && shown ? (
        <>
          <div className="shrink-0 flex items-center gap-3 px-4 py-1.5 border-b border-pm-border">
            <button
              type="button"
              onClick={() => setDiffFocusId(null)}
              title={`${t.scBackToList} (Esc)`}
              className="h-6 px-2 inline-flex items-center gap-1 rounded-md text-[11.5px] text-pm-text-secondary hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
            >
              <ArrowLeft size={12} />
              {t.scBackToList}
            </button>
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-pm-text-muted">{t.mdSimulation}</span>
            <button
              type="button"
              onClick={openDiffInWindow}
              title={t.rcViewDiffTitle}
              className="h-6 px-2 inline-flex items-center gap-1 rounded-md text-[11.5px] text-pm-text-secondary hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
            >
              <ExternalLink size={12} />
              {t.scOpenInWindow}
            </button>
          </div>
          <MergeDiffPanel
            key={`${activeTab}:${diffFocusId}`}
            items={forMergeDiff(items)}
            focusId={diffFocusId}
            onSelect={id => {
              diffSelectedRef.current = id
            }}
          />
        </>
      ) : (
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {!workspace ? (
          <p className="text-[12px] text-pm-text-muted">{t.scNoWorkspace}</p>
        ) : error ? (
          <div className="flex items-center gap-3">
            <p className={`text-[12px] ${error === t.scLoadCancelled ? 'text-pm-text-muted' : 'text-rose-300'}`}>{error}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="h-6 px-2 inline-flex items-center gap-1 rounded-md text-[11.5px] text-[#9fd3f7] hover:bg-pm-hover cursor-pointer"
            >
              <RefreshCw size={11} />
              {t.scTryAgain}
            </button>
          </div>
        ) : !shown ? (
          <div className="h-full flex flex-col items-center justify-center">
            <DevFlowLoader label={t.scLoading} detail={t.scLoadingSub} />
            <button
              type="button"
              onClick={cancelRead}
              title={t.scCancelTitle}
              className="-mt-8 h-7 px-3 inline-flex items-center gap-1 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:bg-pm-hover transition-colors cursor-pointer"
            >
              <X size={12} />
              {t.scCancel}
            </button>
          </div>
        ) : allSynced ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 py-10 text-center">
            <div className="h-11 w-11 rounded-full bg-[#4ff09d]/10 flex items-center justify-center">
              <Check size={22} className="text-[#4ff09d]" />
            </div>
            <p className="text-[13.5px] font-semibold text-pm-text">
              {filter?.label ? t.scSyncedItem(filter.label) : t.scAllSynced}
            </p>
            {checkedAt && (
              <p className="text-[11px] text-pm-text-muted">
                {t.scCheckedAt(checkedAt.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }))}
              </p>
            )}
            {sessionTokens > 0 && (
              <p className="max-w-[48ch] text-[11px] text-pm-text-muted">{t.scSessionTokensNote(sessionTokens)}</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-pm-text-muted">{hint}</p>
            {tabSummary && <p className="text-[11.5px] text-pm-text-secondary">{tabSummary}</p>}
            {activeTab === 'conflicts' && items.length > 0 && (
              <div className="flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <AlertTriangle size={14} className="shrink-0 text-amber-300" />
                <span className="flex-1 text-[11.5px] text-pm-text-secondary">{t.scResolveHint}</span>
                <button
                  type="button"
                  onClick={() => void run('resolve')}
                  disabled={busy}
                  className="h-7 px-3 rounded-md text-xs font-semibold text-white bg-amber-600 hover:bg-amber-600/90 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {t.scResolve}
                </button>
              </div>
            )}
            {groups.length === 0 && envNames.length === 0 && markerRows.length === 0 && (
              <p className="text-[12px] text-pm-text-muted">
                {activeTab === 'incoming' && behindCount > 0 && !filter?.label ? t.scBehindOnly(behindCount) : empty}
              </p>
            )}
            {groups.map(group => (
              <CollectionGroup
                // Pela aba também: o "quem mudou" de uma aba não pode
                // sobrar na outra (em "Para enviar" ele não se aplica).
                key={`${activeTab}:${group.rootId ?? group.name}`}
                group={group}
                tab={activeTab}
                lastChangeOf={lastChangeOf}
                openId={openId}
                setOpenId={setOpenId}
                onViewDiff={viewDiff}
                onSend={activeTab === 'outgoing' ? scopeSend => void run('send', scopeSend) : undefined}
                onDiscard={activeTab === 'outgoing' ? target => discardTarget(target) : undefined}
                onOpen={openItem}
                busy={busy}
              />
            ))}
            {markerRows.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <div className="px-2 pt-1 text-[11px] font-semibold text-pm-text-secondary">{t.scMarkers}</div>
                {markerRows.map(({ name, kind }) => (
                  <div key={`${kind}|${name}`} className="flex items-center gap-1.5 px-2 py-0.5 text-[12px] text-pm-text">
                    <span className="w-[11px] shrink-0" />
                    <span className={`shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide ${BADGE[kind] ?? BADGE.changed}`}>
                      {t.rcBadge[kind as keyof typeof t.rcBadge] ?? kind}
                    </span>
                    <span className="truncate">{name}</span>
                  </div>
                ))}
              </div>
            )}
            {envNames.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <div className="px-2 pt-1 text-[11px] font-semibold text-pm-text-secondary">{t.rcEnvironments}</div>
                {envNames.map(({ name, note }) => (
                  <EnvRow
                    key={`${name}|${note}`}
                    name={name}
                    note={note}
                    tab={activeTab}
                    value={shown.envValues?.[name]}
                    open={openId === `env:${name}`}
                    onToggle={() => setOpenId(openId === `env:${name}` ? null : `env:${name}`)}
                    onDiscard={activeTab === 'outgoing' ? () => discardTarget({ envName: name, label: name }) : undefined}
                    busy={busy}
                  />
                ))}
              </div>
            )}
            {activeTab === 'outgoing' && sessionTokens > 0 && (
              <p className="px-2 text-[10.5px] text-pm-text-muted">{t.scSessionTokensNote(sessionTokens)}</p>
            )}
          </div>
        )}
      </div>
      )}

      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-t border-pm-border">
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-pm-text-muted">
          {cancelling ? t.scCancelling : running ? t.scRunning : scope ? t.scScopedHint : t.scSyncAllHint}
        </span>
        {(running !== null || (loading && !!shown)) && canCancel && (
          <button
            type="button"
            onClick={cancel}
            disabled={cancelling}
            title={t.scCancelTitle}
            className="h-7 px-2.5 inline-flex items-center gap-1 rounded-md text-xs font-medium border border-rose-500/40 text-rose-200 hover:bg-rose-500/10 disabled:opacity-50 transition-colors cursor-pointer"
          >
            <X size={12} />
            {cancelling ? t.scCancelling : t.scCancel}
          </button>
        )}
        <button
          type="button"
          onClick={() => void run('receive')}
          disabled={busy || !canReceive}
          title={t.scIncomingHint}
          className="h-7 px-2.5 inline-flex items-center gap-1 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:bg-pm-hover disabled:opacity-40 transition-colors cursor-pointer"
        >
          <ArrowDown size={12} className={SYNC_TONE.incoming} />
          {t.scReceiveOnly}
        </button>
        <button
          type="button"
          onClick={() => void run('send')}
          disabled={busy || !canSend}
          title={t.scOutgoingHint}
          className="h-7 px-2.5 inline-flex items-center gap-1 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:bg-pm-hover disabled:opacity-40 transition-colors cursor-pointer"
        >
          <ArrowUp size={12} className={SYNC_TONE.outgoing} />
          {scope && filter?.label ? t.scSendOnlyScoped(filter.label) : t.scSendOnly}
        </button>
        <button
          type="button"
          onClick={() => void run('all')}
          disabled={busy || !canAll}
          title={t.scSyncAllHint}
          className="h-7 px-3 inline-flex items-center gap-1.5 rounded-md text-xs font-semibold text-white bg-[#f26b3a] hover:bg-[#f26b3a]/90 disabled:opacity-50 transition-colors cursor-pointer"
        >
          {running === 'all' ? <DevFlowSpinner size={13} /> : <RefreshCw size={12} />}
          {t.scSyncAll}
        </button>
      </div>
    </>
  )
}

// Alças de tamanho: as quatro bordas e os cantos (o sudeste tem o desenho).
const RESIZE_HANDLES: { edge: ResizeEdge; className: string }[] = [
  { edge: 'n', className: 'top-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 's', className: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 'e', className: 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'w', className: 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'nw', className: 'top-0 left-0 h-2.5 w-2.5 cursor-nwse-resize' },
  { edge: 'ne', className: 'top-0 right-0 h-2.5 w-2.5 cursor-nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 h-2.5 w-2.5 cursor-nesw-resize' },
]

export function SyncCenter(props: Props) {
  const t = useSyncDiffStrings()
  const request = useSyncCenter()
  // Com a diferença lado a lado aberta, a janela fica mais larga (se a pessoa
  // não escolheu um tamanho).
  const [wide, setWide] = useState(false)
  // Arrastar pelo cabeçalho, mudar o tamanho pelas bordas, maximizar. O
  // tamanho escolhido fica guardado.
  const drag = useDraggableDialog()
  const resize = useResizableDialog('devflow_sync_center_size', { minWidth: 560, minHeight: 360 })
  return (
    // Durante uma ação a Central não fecha (Esc, clique fora): o push pode
    // estar esperando uma resposta num aviso por cima dela ("apagar no
    // GitHub?"), e o Esc desse aviso fecharia a Central junto.
    // modal={false}: a Central flutua sobre o app sem travá-lo — dá pra usar
    // a árvore, as abas e abrir outras janelas com ela aberta.
    <Dialog open={!!request} modal={false} onOpenChange={open => { if (!open && !isSyncCenterBusy()) closeSyncCenter() }}>
      <DialogContent
        showCloseButton={false}
        showOverlay={false}
        onPointerDownOutside={e => e.preventDefault()}
        // Avisos e toasts por cima da Central são outras camadas: clicar
        // neles não é "clicar fora" (fechava a Central no meio da ação).
        onInteractOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => {
          if (escapeOverride?.()) e.preventDefault()
        }}
        {...drag.contentProps}
        style={{ ...drag.contentProps.style, ...resize.style }}
        className={`bg-pm-bg border border-pm-border text-pm-text ${wide ? 'sm:max-w-6xl h-[84vh]' : 'sm:max-w-4xl h-[78vh]'} w-[calc(100vw-48px)] p-0 flex flex-col overflow-hidden rounded-lg gap-0 ${resize.resizing ? 'select-none' : ''}`}
      >
        {RESIZE_HANDLES.map(({ edge, className }) => (
          <div key={edge} {...resize.handleProps(edge)} title={t.resizeTitle} className={`absolute z-10 hover:bg-[#007acc]/30 ${className}`} />
        ))}
        <div {...resize.handleProps('se')} title={t.resizeTitle} className="absolute bottom-0 right-0 z-20 h-3.5 w-3.5 cursor-nwse-resize">
          <svg viewBox="0 0 10 10" className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 text-pm-text-muted/70">
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
        {/* A chave recomeça (e recarrega) a cada abertura. */}
        {request && (
          <SyncCenterBody
            key={request.nonce}
            {...props}
            initialTab={request.tab}
            initialResult={request.result}
            filter={request.filter}
            onWideChange={setWide}
            dragHandle={{ ...drag.handleProps, onDoubleClick: drag.reset, title: t.dragTitle }}
            maximize={{ maximized: resize.maximized, toggle: resize.toggleMaximized }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
