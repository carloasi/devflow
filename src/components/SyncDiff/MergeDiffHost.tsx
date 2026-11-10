'use client'

import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSyncDiffStrings } from '@/lib/i18n/syncDiffStrings'
import { closeMergeDiff, useMergeDiff, type MergeDiffRequest } from '@/lib/sync/mergeDiffStore'
import { defaultPicks, mergeChunks, type ChunkPick } from '@/lib/sync/mergeChunks'
import type { RemoteChangeItem, RemoteFieldPreview } from '@/lib/sync/remoteChangeAlert'
import { ThreeWayMergeView } from './ThreeWayMergeView'

// ─────────────────────────────────────────────────────────────────────────
// "Ver diferença" dos avisos de merge, no formato de três painéis do Visual
// Studio (ThreeWayMergeView): GitHub e a sua versão lado a lado, o resultado
// embaixo. Montada uma vez no layout; quem abre é openMergeDiff
// (lib/sync/mergeDiffStore) — o toast de mudança no GitHub, o relatório do
// merge, a prévia do push.
//
// Simulação: as caixinhas mostram o que cada escolha daria, mas nada é
// aplicado daqui — aplicar é na revisão (Pull / Review & merge).
// ─────────────────────────────────────────────────────────────────────────

const BADGE: Record<string, string> = {
  conflict: 'bg-amber-500/15 text-amber-300',
  new: 'bg-[#4ff09d]/10 text-[#4ff09d]',
  deleted: 'bg-rose-500/15 text-rose-300',
  changed: 'bg-[#63b3ed]/15 text-[#9fd3f7]',
  moved: 'bg-pm-hover text-pm-text-secondary',
  reordered: 'bg-pm-hover text-pm-text-secondary',
}

function FieldDiff({ field }: { field: RemoteFieldPreview }) {
  const twoWay = field.base === undefined || field.base === null
  const chunks = useMemo(
    () => mergeChunks(twoWay ? null : field.base!, field.before, field.after),
    [twoWay, field.base, field.before, field.after]
  )
  // Começa como o merge automático faria: cada trecho com o lado que mudou.
  const [picks, setPicks] = useState<ChunkPick[] | null>(() => (chunks ? defaultPicks(chunks) : null))
  if (!chunks) return null
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-pm-text-muted">{field.field}</div>
      <ThreeWayMergeView
        chunks={chunks}
        picks={picks ?? defaultPicks(chunks)}
        manualText=""
        twoWay={twoWay}
        readOnly={false}
        crlf={field.before.includes('\r\n')}
        simulation
        onPicks={setPicks}
        onManualText={() => {}}
        onBackToBoxes={() => setPicks(defaultPicks(chunks))}
      />
    </div>
  )
}

function MergeDiffBody({ request }: { request: MergeDiffRequest }) {
  const t = useSyncDiffStrings()
  const [selectedId, setSelectedId] = useState<string | null>(
    () => request.focusId ?? request.items.find(i => i.fields.length > 0)?.id ?? request.items[0]?.id ?? null
  )
  const selected: RemoteChangeItem | undefined = request.items.find(i => i.id === selectedId)

  return (
    <>
      <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-pm-border">
        <DialogTitle className="text-[13px] font-semibold text-pm-text flex-1 truncate">
          {request.title}
        </DialogTitle>
        <button
          type="button"
          onClick={closeMergeDiff}
          aria-label={t.close}
          title={`${t.close} (Esc)`}
          className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>
      <div className="shrink-0 px-4 py-1.5 border-b border-pm-border text-[10.5px] text-pm-text-muted">
        {request.subtitle ? `${request.subtitle} · ` : ''}
        {t.mdSimulation}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Itens */}
        <div className="w-[240px] shrink-0 overflow-y-auto border-r border-pm-border p-1.5">
          <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-pm-text-muted">
            {t.mdItems(request.items.length)}
          </div>
          {request.items.map(item => {
            const kind = item.conflict ? 'conflict' : item.change
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                title={item.path.join(' / ')}
                className={`w-full flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left cursor-pointer ${
                  selectedId === item.id ? 'bg-pm-row-active' : 'hover:bg-pm-hover'
                }`}
              >
                <span className={`shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide ${BADGE[kind]}`}>
                  {t.rcBadge[kind]}
                </span>
                <span className="min-w-0 truncate text-[11.5px] text-pm-text">{item.path[item.path.length - 1]}</span>
              </button>
            )
          })}
        </div>

        {/* Diferença do item, campo a campo */}
        <div className="flex-1 min-w-0 overflow-y-auto p-3">
          {selected ? (
            <div className="flex flex-col gap-3">
              <div className="text-[12px] font-semibold text-pm-text">{selected.path.join(' / ')}</div>
              {selected.fields.length === 0 ? (
                <p className="text-[11px] text-pm-text-muted">{t.mdNoFields}</p>
              ) : (
                selected.fields.map(field => <FieldDiff key={`${selected.id}:${field.field}`} field={field} />)
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-2.5 border-t border-pm-border">
        <button
          type="button"
          onClick={closeMergeDiff}
          className="h-7 px-3 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:bg-pm-hover transition-colors cursor-pointer"
        >
          {t.close}
        </button>
        {request.action && (
          <button
            type="button"
            onClick={() => {
              closeMergeDiff()
              request.action!.onClick()
            }}
            className="h-7 px-3 rounded-md text-xs font-semibold text-white bg-[#f26b3a] hover:bg-[#f26b3a]/90 transition-colors cursor-pointer"
          >
            {request.action.label}
          </button>
        )}
      </div>
    </>
  )
}

export function MergeDiffHost() {
  const request = useMergeDiff()
  return (
    <Dialog open={!!request} onOpenChange={open => { if (!open) closeMergeDiff() }}>
      <DialogContent
        showCloseButton={false}
        className="bg-pm-bg border border-pm-border text-pm-text sm:max-w-6xl w-[calc(100vw-48px)] h-[82vh] p-0 flex flex-col overflow-hidden rounded-lg gap-0"
      >
        {/* A chave reinicia a seleção a cada abertura. */}
        {request && <MergeDiffBody key={`${request.title}|${request.items.map(i => i.id).join(',')}`} request={request} />}
      </DialogContent>
    </Dialog>
  )
}
