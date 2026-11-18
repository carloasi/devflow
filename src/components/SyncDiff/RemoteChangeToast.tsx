'use client'

import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, CloudDownload, Columns3, GitCommitHorizontal, X } from 'lucide-react'
import { useSyncDiffStrings, type SyncDiffStrings } from '@/lib/i18n/syncDiffStrings'
import { useLanguage } from '@/lib/i18n/language'
import { initialsOf, type RemoteChangeItem, type RemoteChangePreview } from '@/lib/sync/remoteChangeAlert'
import { TextDiffView } from './TextDiffView'
import { openMergeDiff } from '@/lib/sync/mergeDiffStore'
import { openSyncCenter } from '@/lib/sync/syncCenterStore'

// ─────────────────────────────────────────────────────────────────────────
// O aviso "alguém mudou isto no GitHub", como card (toast.custom do sonner).
//
// Antes era uma linha de texto ("X was changed on GitHub by Y") e, pra saber
// o QUE mudou, só abrindo o pull. Agora diz quem e quando (último commit de
// cada arquivo), quais itens mudaram — conflito primeiro, em âmbar — e,
// clicando num item, um mini-diff de cada campo: como está aqui → como ficou
// no GitHub. Nada é aplicado daqui; o botão leva ao Pull com revisão.
// ─────────────────────────────────────────────────────────────────────────

export interface RemoteCommitInfo {
  /** Nome do arquivo (collection/environment) que o commit mudou. */
  name: string
  author: string
  date: string
  message: string
  removed?: boolean
}

interface Props {
  workspace: string
  commits: RemoteCommitInfo[]
  /** Arquivos mudados além dos que têm commit listado. */
  otherFiles: number
  /** Prévia do merge de teste; null = não deu pra calcular (só os arquivos). */
  preview: RemoteChangePreview | null
  onPull?: () => void
  onDismiss: () => void
}

/** Itens visíveis antes do "+N". */
const MAX_ITEMS = 6

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

// Cor estável por autor — a mesma pessoa tem sempre o mesmo avatar.
const AVATAR_COLORS = ['#f26b3a', '#4ff09d', '#63b3ed', '#c084fc', '#f2c94c', '#f472b6', '#2dd4bf']
function avatarColor(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

const BADGE: Record<string, string> = {
  conflict: 'bg-amber-500/15 text-amber-300',
  new: 'bg-[#4ff09d]/10 text-[#4ff09d]',
  deleted: 'bg-rose-500/15 text-rose-300',
  changed: 'bg-[#63b3ed]/15 text-[#9fd3f7]',
  moved: 'bg-pm-hover text-pm-text-secondary',
  reordered: 'bg-pm-hover text-pm-text-secondary',
}

function ItemRow({ item, open, onToggle, onViewDiff }: { item: RemoteChangeItem; open: boolean; onToggle: () => void; onViewDiff: () => void }) {
  const t = useSyncDiffStrings()
  const kind = item.conflict ? 'conflict' : item.change
  const canPreview = item.fields.length > 0
  return (
    <div className={`group/item relative rounded-md ${open ? 'bg-pm-hover/40' : ''}`}>
      <button
        type="button"
        onClick={canPreview ? onToggle : undefined}
        // pr-7 com prévia: o botão de diferença (absoluto, à direita) aparece
        // no hover por cima da lista de campos ("auth", "body") — sem a folga
        // ele a cobria.
        className={`w-full flex items-center gap-1.5 px-1.5 py-1 text-left rounded-md ${canPreview ? 'pr-7 hover:bg-pm-hover cursor-pointer' : 'cursor-default'}`}
        title={item.path.join(' / ')}
      >
        {canPreview ? (
          open ? <ChevronDown size={11} className="shrink-0 text-pm-text-muted" /> : <ChevronRight size={11} className="shrink-0 text-pm-text-muted" />
        ) : (
          <span className="w-[11px] shrink-0" />
        )}
        <span className={`shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide ${BADGE[kind]}`}>
          {t.rcBadge[kind]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-pm-text">
          {item.path.length > 1 && <span className="text-pm-text-muted">{item.path.slice(-2, -1)[0]} / </span>}
          {item.path[item.path.length - 1]}
        </span>
        {item.fields.length > 0 && (
          <span className="shrink-0 truncate max-w-[110px] text-[10px] text-pm-text-muted">
            {item.fields.map(f => f.field).join(', ')}
          </span>
        )}
      </button>
      {canPreview && (
        <button
          type="button"
          onClick={onViewDiff}
          title={t.rcViewDiffTitle}
          aria-label={t.rcViewDiff}
          className="absolute right-1 top-1 h-5 w-5 flex items-center justify-center rounded text-pm-text-muted opacity-0 group-hover/item:opacity-100 hover:text-pm-text hover:bg-pm-hover cursor-pointer"
        >
          <Columns3 size={11} />
        </button>
      )}
      {open && canPreview && (
        <div className="flex flex-col gap-1.5 px-1.5 pb-1.5 pt-0.5">
          {item.fields.map(field => (
            <div key={field.field}>
              <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-pm-text-muted">{field.field}</div>
              <TextDiffView
                before={field.before}
                after={field.after}
                beforeLabel={t.rcHere}
                afterLabel={t.github}
                emptyText=""
                collapsedText={t.collapsedLines}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function RemoteChangeToast({ workspace, commits, otherFiles, preview, onPull, onDismiss }: Props) {
  const t = useSyncDiffStrings()
  const locale = useLanguage()
  const conflicts = preview?.conflicts.length ?? 0
  const items = preview?.items ?? []
  // A primeira prévia já aberta: é o que a pessoa quer ver primeiro.
  const [openId, setOpenId] = useState<string | null>(() => items.find(i => i.fields.length > 0)?.id ?? null)
  const shown = items.slice(0, MAX_ITEMS)
  // A diferença inteira no formato de três painéis (Visual Studio), numa
  // janela própria — o mini-diff aqui é só a prévia.
  // O card sai da frente: ele fica por cima de qualquer janela. A ação dele
  // (Pull) vai junto pro rodapé da janela de diferenças.
  const viewDiff = (focusId?: string) => {
    onDismiss()
    openMergeDiff({
      title: `${conflicts > 0 ? t.rcConflictTitle : t.rcTitle} — ${workspace}`,
      subtitle: commits[0]?.author
        ? `${commits[0].author}${commits[0].date ? ` · ${timeAgo(commits[0].date, t, locale)}` : ''}`
        : undefined,
      items,
      focusId,
      action: onPull ? { label: conflicts > 0 ? t.rcResolve : t.rcPull, onClick: onPull } : undefined,
    })
  }
  const hiddenItems = items.length - shown.length
  const fromCommit = !!preview?.fromCommit
  // Diff do último commit em que a versão daqui já é a do GitHub: a mudança
  // já está aqui (veio de outra máquina sua, ou de um pull anterior).
  const alreadyHere =
    fromCommit && items.length > 0 && items.every(i => i.fields.every(f => f.before === f.after))
  const canViewDiff = items.some(i => i.fields.length > 0)

  return (
    <div
      role="status"
      className={`w-[420px] max-w-[calc(100vw-32px)] rounded-lg border bg-pm-surface text-pm-text shadow-2xl backdrop-blur-2xl ${
        conflicts > 0 ? 'border-amber-500/50' : 'border-pm-border'
      }`}
    >
      {/* Cabeçalho */}
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
        <span
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
            conflicts > 0 ? 'bg-amber-500/15 text-amber-300' : 'bg-[#63b3ed]/15 text-[#9fd3f7]'
          }`}
        >
          {conflicts > 0 ? <AlertTriangle size={13} /> : <CloudDownload size={13} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold leading-tight">{conflicts > 0 ? t.rcConflictTitle : t.rcTitle}</div>
          <div className="truncate text-[11px] text-pm-text-muted">{workspace}</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t.close}
          className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover cursor-pointer"
        >
          <X size={13} />
        </button>
      </div>

      {/* Quem mudou e quando */}
      {commits.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-pm-border px-3 py-2">
          {commits.map((c, i) => (
            <div key={i} className="flex items-start gap-2">
              <span
                className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-[#1a1a1a]"
                style={{ backgroundColor: avatarColor(c.author || '?') }}
                title={c.author}
              >
                {initialsOf(c.author || '?')}
              </span>
              <div className="min-w-0 flex-1 text-[11px] leading-snug">
                <div className="truncate">
                  <span className="font-semibold">{c.author || '—'}</span>{' '}
                  <span className="text-pm-text-secondary">{c.removed ? t.rcRemovedFile(c.name) : t.rcChangedFile(c.name)}</span>
                  {c.date && <span className="text-pm-text-muted"> · {timeAgo(c.date, t, locale)}</span>}
                </div>
                {c.message && (
                  <div className="flex items-center gap-1 truncate text-[10.5px] text-pm-text-muted" title={c.message}>
                    <GitCommitHorizontal size={10} className="shrink-0" />
                    <span className="truncate">{c.message.split('\n')[0]}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
          {otherFiles > 0 && <div className="pl-7 text-[10.5px] text-pm-text-muted">{t.rcOtherFiles(otherFiles)}</div>}
        </div>
      )}

      {/* O que mudou, com prévia */}
      <div className="border-t border-pm-border px-2 py-2">
        {preview ? (
          <>
            {items.length > 0 && (
              <div className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-pm-text-muted">
                {fromCommit ? t.rcFromCommitTitle(items.length) : t.rcItemsTitle(items.length)}
              </div>
            )}
            <div className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto">
              {shown.map(item => (
                <ItemRow
                  key={item.id}
                  item={item}
                  open={openId === item.id}
                  onToggle={() => setOpenId(prev => (prev === item.id ? null : item.id))}
                  onViewDiff={() => viewDiff(item.id)}
                />
              ))}
            </div>
            {/* O texto manda ver todos na revisão — então leva até ela. */}
            {hiddenItems > 0 &&
              (canViewDiff ? (
                <button
                  type="button"
                  onClick={() => viewDiff()}
                  className="px-1.5 pt-1 text-left text-[10.5px] text-[#9fd3f7] hover:underline cursor-pointer"
                >
                  {t.rcMoreItems(hiddenItems)}
                </button>
              ) : (
                <div className="px-1.5 pt-1 text-[10.5px] text-pm-text-muted">{t.rcMoreItems(hiddenItems)}</div>
              ))}
            {preview.environments.length > 0 && (
              <div className="mt-1.5 px-1.5 text-[10.5px] text-pm-text-secondary">
                <span className="font-semibold text-pm-text-muted">{t.rcEnvironments}: </span>
                {preview.environments.slice(0, 4).join(', ')}
                {preview.environments.length > 4 && ` +${preview.environments.length - 4}`}
              </div>
            )}
            <p className={`mt-1.5 px-1.5 text-[10.5px] leading-snug ${conflicts > 0 ? 'text-amber-300' : 'text-pm-text-muted'}`}>
              {conflicts > 0 ? t.rcConflictNote(conflicts) : alreadyHere ? t.rcAlreadyHere : t.rcMergesAlone}
            </p>
          </>
        ) : (
          <p className="px-1.5 text-[10.5px] text-pm-text-muted">{t.rcNoPreview}</p>
        )}
      </div>

      {/* Ações — dois grupos que nunca quebram o texto por dentro (botão de
          altura fixa com rótulo em duas linhas virava "Depoi / s"). Com os
          quatro botões em 420px não cabe tudo numa linha; aí o grupo da
          direita (Depois + ação principal) desce inteiro, alinhado à direita. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-pm-border px-3 py-2">
        <div className="flex items-center gap-1">
          {canViewDiff && (
            <button
              type="button"
              onClick={() => viewDiff()}
              title={t.rcViewDiffTitle}
              className="h-7 px-2 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md text-[11.5px] text-[#9fd3f7] hover:bg-pm-hover cursor-pointer"
            >
              <Columns3 size={12} />
              {t.rcViewDiff}
            </button>
          )}
          {/* A Central mostra isto junto do resto: o que vai, o que vem, os
              conflitos — e dali se recebe, envia ou resolve. */}
          <button
            type="button"
            onClick={() => {
              onDismiss()
              openSyncCenter({ tab: conflicts > 0 ? 'conflicts' : 'incoming' })
            }}
            className="h-7 px-2 shrink-0 whitespace-nowrap rounded-md text-[11.5px] text-[#9fd3f7] hover:bg-pm-hover cursor-pointer"
          >
            {t.scViewInSync}
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="h-7 px-2.5 shrink-0 whitespace-nowrap rounded-md text-[11.5px] text-pm-text-secondary hover:bg-pm-hover cursor-pointer"
          >
            {t.rcLater}
          </button>
          {onPull && (
            <button
              type="button"
              onClick={() => {
                onDismiss()
                onPull()
              }}
              className={`h-7 px-3 shrink-0 whitespace-nowrap rounded-md text-[11.5px] font-semibold text-white cursor-pointer ${
                conflicts > 0 ? 'bg-amber-600 hover:bg-amber-600/90' : 'bg-[#f26b3a] hover:bg-[#f26b3a]/90'
              }`}
            >
              {conflicts > 0 ? t.rcResolve : t.rcPull}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
