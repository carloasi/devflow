'use client'

import type { ReactNode } from 'react'
import { Columns3, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { ChangeDetail } from '@/lib/sync/rebase'
import { useSyncDiffStrings } from '@/lib/i18n/syncDiffStrings'
import { openMergeDiff } from '@/lib/sync/mergeDiffStore'
import type { RemoteChangeItem } from '@/lib/sync/remoteChangeAlert'

// ─────────────────────────────────────────────────────────────────────────
// Janela de listas do sync: o relatório depois de um merge automático, a
// prévia do push e o histórico de conflitos usam a mesma forma — seções com
// itens ("Token v1 · url, body"), cada seção com a sua cor.
// ─────────────────────────────────────────────────────────────────────────

export interface SyncListItem {
  primary: string
  secondary?: string
  /** O antes/depois do item — abre a diferença no formato de três painéis. */
  diff?: RemoteChangeItem
}

export interface SyncListSection {
  title: string
  tone: 'github' | 'mine' | 'conflict' | 'neutral'
  items: SyncListItem[]
  emptyText?: string
}

const TONE: Record<SyncListSection['tone'], string> = {
  github: 'text-[#4ff09d]',
  mine: 'text-[#63b3ed]',
  conflict: 'text-amber-300',
  neutral: 'text-pm-text-secondary',
}

interface Props {
  open: boolean
  title: string
  subtitle?: string
  sections: SyncListSection[]
  onClose: () => void
  /** Botões extra no rodapé (ex. "Push now"). */
  actions?: ReactNode
}

export function SyncListDialog({ open, title, subtitle, sections, onClose, actions }: Props) {
  const t = useSyncDiffStrings()
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent
        showCloseButton={false}
        className="bg-pm-bg border border-pm-border text-pm-text sm:max-w-lg max-h-[80vh] p-0 flex flex-col overflow-hidden rounded-lg gap-0"
      >
        <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-pm-border">
          <DialogTitle className="text-[13px] font-semibold text-pm-text flex-1 truncate">{title}</DialogTitle>
          <button
            onClick={onClose}
            title={t.close}
            className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>
        {subtitle && <p className="shrink-0 px-4 pt-3 text-[11.5px] text-pm-text-secondary leading-relaxed">{subtitle}</p>}
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-4">
          {sections.map(section => {
            // A diferença no formato de três painéis (Visual Studio): por item
            // ou a seção inteira, na janela de diferenças (MergeDiffHost).
            const diffs = section.items.map(i => i.diff).filter((d): d is RemoteChangeItem => !!d && d.fields.length > 0)
            const viewDiff = (focusId?: string) =>
              openMergeDiff({ title: `${title} — ${section.title}`, items: diffs, focusId })
            return (
              <div key={section.title}>
                <div className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide mb-1.5 ${TONE[section.tone]}`}>
                  <span>
                    {section.title} <span className="text-pm-text-muted font-normal">({section.items.length})</span>
                  </span>
                  {diffs.length > 0 && (
                    <button
                      type="button"
                      onClick={() => viewDiff()}
                      title={t.rcViewDiffTitle}
                      className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-[#9fd3f7] hover:bg-pm-hover cursor-pointer"
                    >
                      <Columns3 size={11} />
                      {t.rcViewDiff}
                    </button>
                  )}
                </div>
                {section.items.length === 0 ? (
                  <p className="text-[11px] italic text-pm-text-muted">{section.emptyText ?? '—'}</p>
                ) : (
                  <ul className="rounded-md border border-pm-border divide-y divide-pm-border/60">
                    {section.items.map((item, i) => (
                      <li key={i} className="group flex items-start gap-2 px-3 py-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-[11.5px] text-pm-text break-words">{item.primary}</div>
                          {item.secondary && (
                            <div className="text-[10.5px] text-pm-text-muted break-words mt-0.5">{item.secondary}</div>
                          )}
                        </div>
                        {item.diff && item.diff.fields.length > 0 && (
                          <button
                            type="button"
                            onClick={() => viewDiff(item.diff!.id)}
                            title={t.rcViewDiffTitle}
                            aria-label={t.rcViewDiff}
                            className="shrink-0 h-6 w-6 flex items-center justify-center rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover cursor-pointer"
                          >
                            <Columns3 size={12} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
        <div className="shrink-0 flex justify-end gap-2 px-4 py-3 border-t border-pm-border">
          {actions}
          <button
            onClick={onClose}
            className="h-7 px-3 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:bg-pm-hover transition-colors cursor-pointer"
          >
            {t.close}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** "Token v1" + "url, body · changed" — o texto de um ChangeDetail. */
export function detailToItem(
  detail: ChangeDetail,
  labels: Record<ChangeDetail['change'], string>
): SyncListItem {
  const name = detail.path.slice(-2).join(' / ')
  const what = labels[detail.change]
  return { primary: name, secondary: detail.fields.length ? `${what}: ${detail.fields.join(', ')}` : what }
}
