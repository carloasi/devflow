'use client'

import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSyncDiffStrings } from '@/lib/i18n/syncDiffStrings'
import { closeMergeDiff, useMergeDiff, type MergeDiffRequest } from '@/lib/sync/mergeDiffStore'
import { requestReviewEdit } from '@/lib/sync/reviewEditHint'
import { defaultPicks, mergeChunks, type ChunkPick } from '@/lib/sync/mergeChunks'
import type { RemoteChangeItem, RemoteFieldPreview } from '@/lib/sync/remoteChangeAlert'
import { ThreeWayMergeView } from './ThreeWayMergeView'
import { useSplitRatio } from '@/components/helper/useSplitRatio'

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

function FieldDiff({ field, onEditInReview }: { field: RemoteFieldPreview; onEditInReview?: () => void }) {
  const t = useSyncDiffStrings()
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
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-pm-text-muted">
        {/* "content" é a request inteira (item novo ou apagado na Central). */}
        {field.field === 'content' ? t.scContent : field.field}
      </div>
      <ThreeWayMergeView
        chunks={chunks}
        picks={picks ?? defaultPicks(chunks)}
        manualText=""
        twoWay={twoWay}
        readOnly={false}
        crlf={field.before.includes('\r\n')}
        simulation
        onEditInReview={onEditInReview}
        onPicks={setPicks}
        onManualText={() => {}}
        onBackToBoxes={() => setPicks(defaultPicks(chunks))}
      />
    </div>
  )
}

/**
 * A lista de itens e a diferença do escolhido, em três painéis — o miolo da
 * janela de diferença. Exportado pra a Central de Sincronização mostrar o
 * mesmo DENTRO dela, em vez de abrir outra janela por cima.
 */
export function MergeDiffPanel({
  items,
  focusId,
  onSelect,
  onEditInReview,
}: {
  items: RemoteChangeItem[]
  focusId?: string
  /** Avisa qual item está aberto (a Central o leva pra janela separada). */
  onSelect?: (id: string) => void
  /**
   * "Editar na revisão" de um campo — só nos itens em CONFLITO, que são os
   * que a revisão do merge abre pra decidir. Ausente = sem o botão.
   */
  onEditInReview?: (itemId: string, field: string) => void
}) {
  const t = useSyncDiffStrings()
  const [selectedId, setSelected] = useState<string | null>(
    () => focusId ?? items.find(i => i.fields.length > 0)?.id ?? items[0]?.id ?? null
  )
  const setSelectedId = (id: string) => {
    setSelected(id)
    onSelect?.(id)
  }
  const selected: RemoteChangeItem | undefined = items.find(i => i.id === selectedId)
  // Largura da lista de itens (arrastando a divisória), guardada entre aberturas.
  const split = useSplitRatio('devflow_merge_diff_items', 0.24, { minLeft: 160, minRight: 360 })

  return (
      <div ref={split.containerRef} className={`flex-1 min-h-0 flex ${split.dragging ? 'select-none' : ''}`}>
        {/* Itens */}
        <div className="shrink-0 overflow-y-auto p-1.5" style={{ width: `${split.ratio * 100}%` }}>
          <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-pm-text-muted">
            {t.mdItems(items.length)}
          </div>
          {items.map(item => {
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
        {/* Divisória: arrasta (ou setas do teclado); duplo clique volta ao padrão. */}
        <div
          {...split.handleProps}
          title={t.scItemsResize}
          className={`w-1 shrink-0 cursor-col-resize border-l border-pm-border outline-none hover:bg-[#007acc]/40 focus-visible:bg-[#007acc]/40 ${split.dragging ? 'bg-[#007acc]/50' : ''}`}
        />

        {/* Diferença do item, campo a campo */}
        <div className="flex-1 min-w-0 overflow-y-auto p-3">
          {selected ? (
            <div className="flex flex-col gap-3">
              <div className="text-[12px] font-semibold text-pm-text">{selected.path.join(' / ')}</div>
              {selected.fields.length === 0 ? (
                <p className="text-[11px] text-pm-text-muted">{t.mdNoFields}</p>
              ) : (
                selected.fields.map(field => (
                  <FieldDiff
                    key={`${selected.id}:${field.field}`}
                    field={field}
                    onEditInReview={
                      onEditInReview && selected.conflict ? () => onEditInReview(selected.id, field.field) : undefined
                    }
                  />
                ))
              )}
            </div>
          ) : null}
        </div>
      </div>
  )
}

function MergeDiffBody({ request }: { request: MergeDiffRequest }) {
  const t = useSyncDiffStrings()
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

      <MergeDiffPanel
        items={request.items}
        focusId={request.focusId}
        // A ação de quem abriu (o "Resolver agora" do aviso) é o Pull com
        // revisão: deixa o recado de qual campo editar e segue por ela.
        onEditInReview={
          request.action
            ? (itemId, field) => {
                requestReviewEdit({ itemId, field })
                closeMergeDiff()
                request.action!.onClick()
              }
            : undefined
        }
      />

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
