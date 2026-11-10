'use client'

import { useMemo, useState } from 'react'
import { FileCode2, KeyRound, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { CollectionItem } from '@/app/types/CollectionItem'
import type { Environment } from '@/app/types/Environment'
import { buildEnvMap } from '@/lib/envMap'
import { buildFlowData } from '@/lib/flowHtml/buildFlowHtml'

// ─────────────────────────────────────────────────────────────────────────
// Janela do "Export as HTML runner": QUAIS environments vão no arquivo (o
// HTML troca entre eles num seletor) e se os valores secretos vão junto.
//
// Começa só com o environment ativo marcado e SEM segredos: levar mais
// environments — e principalmente credenciais — é escolha explícita, porque
// o arquivo sai do app e um deles pode ser de produção.
// ─────────────────────────────────────────────────────────────────────────

export interface ExportFlowHtmlChoice {
  format: 'html' | 'har'
  environments: { name: string; envMap: Record<string, string> }[]
  defaultEnvironment?: string
  includeSecrets: boolean
}

interface Props {
  item: CollectionItem | null
  environments: Environment[]
  activeEnvId: string | null
  onCancel: () => void
  onExport: (choice: ExportFlowHtmlChoice) => void
}

export function ExportFlowHtmlDialog({ item, environments, activeEnvId, onCancel, onExport }: Props) {
  // A janela é remontada a cada item (key no pai), então o estado inicial
  // sempre parte do environment ativo de agora.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(activeEnvId ? [activeEnvId] : []))
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [format, setFormat] = useState<'html' | 'har'>('html')

  const chosen = useMemo(
    () => environments.filter(env => selected.has(env.id)),
    [environments, selected]
  )

  // Quais variáveis do flow são secretas nos environments marcados — o
  // mesmo cálculo do export, pra a janela dizer exatamente o que iria junto.
  const secretKeys = useMemo(() => {
    if (!item) return []
    const flow = buildFlowData(item, {
      path: [],
      environments: chosen.map(env => ({ name: env.name, envMap: buildEnvMap(env.values) })),
    })
    return flow.environments[0].variables.filter(v => v.secret).map(v => v.key)
  }, [item, chosen])

  const toggle = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const submit = () => {
    const active = chosen.find(env => env.id === activeEnvId)
    onExport({
      format,
      environments: chosen.map(env => ({ name: env.name, envMap: buildEnvMap(env.values) })),
      defaultEnvironment: (active ?? chosen[0])?.name,
      includeSecrets: includeSecrets && secretKeys.length > 0,
    })
  }

  return (
    <Dialog open={!!item} onOpenChange={open => { if (!open) onCancel() }}>
      <DialogContent
        showCloseButton={false}
        className="bg-pm-bg border border-pm-border text-pm-text sm:max-w-md p-0 flex flex-col overflow-hidden rounded-lg gap-0"
      >
        <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-pm-border">
          <FileCode2 size={14} className="text-pm-text-muted shrink-0" />
          <DialogTitle className="text-[13px] font-semibold text-pm-text flex-1 truncate">
            Export &quot;{item?.name}&quot;
          </DialogTitle>
          <button
            onClick={onCancel}
            className="h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 pt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-pm-text-muted mb-1.5">
            Format
          </div>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['html', 'HTML runner', 'A page that shows and runs the flow in the browser.'],
              ['har', 'HAR (.har)', 'HTTP Archive with the requests — opens in Chrome DevTools, Fiddler, Postman…'],
            ] as const).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFormat(value)}
                aria-pressed={format === value}
                className={`rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer ${
                  format === value
                    ? 'border-[#f26b3a]/70 bg-[#f26b3a]/10'
                    : 'border-pm-border hover:bg-pm-hover'
                }`}
              >
                <span className="block text-[12px] font-semibold text-pm-text">{label}</span>
                <span className="block text-[10.5px] text-pm-text-muted leading-snug mt-0.5">{hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="px-4 pt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-pm-text-muted mb-1.5">
            Environments
          </div>
          <p className="text-[11.5px] text-pm-text-secondary leading-relaxed mb-2">
            {format === 'har'
              ? 'A HAR holds one environment: the active one if checked, otherwise the first checked.'
              : 'The page gets a selector to switch between the ones you check. The active one opens first.'}
          </p>
          {environments.length === 0 ? (
            <p className="text-[11.5px] text-pm-text-muted italic mb-2">
              This workspace has no environments — the page opens with empty variables.
            </p>
          ) : (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-pm-border divide-y divide-pm-border/60">
              {environments.map(env => (
                <label
                  key={env.id}
                  className="flex items-center gap-2 px-3 py-2 text-[12px] cursor-pointer hover:bg-pm-hover transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(env.id)}
                    onChange={() => toggle(env.id)}
                    className="accent-[#f26b3a] cursor-pointer"
                  />
                  <span className="flex-1 truncate text-pm-text">{env.name}</span>
                  {env.id === activeEnvId && (
                    <span className="text-[10px] rounded bg-pm-hover px-1.5 py-px text-pm-text-muted">active</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 pt-4 pb-3">
          <label
            className={`flex items-start gap-2 text-[12px] ${secretKeys.length === 0 ? 'opacity-50' : 'cursor-pointer'}`}
          >
            <input
              type="checkbox"
              checked={includeSecrets && secretKeys.length > 0}
              disabled={secretKeys.length === 0}
              onChange={e => setIncludeSecrets(e.target.checked)}
              className="mt-0.5 accent-[#f26b3a] cursor-pointer"
            />
            <span className="flex-1">
              <span className="text-pm-text">Include secret values</span>
              <span className="block text-[11px] text-pm-text-muted leading-relaxed mt-0.5">
                {secretKeys.length === 0
                  ? 'No secret values in the checked environments.'
                  : `${secretKeys.length} secret(s): ${secretKeys.slice(0, 6).join(', ')}${secretKeys.length > 6 ? ', …' : ''}. Unchecked, whoever opens the page pastes them in.`}
              </span>
            </span>
          </label>
          {includeSecrets && secretKeys.length > 0 && (
            <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-300 leading-relaxed">
              <KeyRound size={12} className="mt-px shrink-0" />
              Anyone with the file can use these credentials. Only for test environments, shared within the team.
            </div>
          )}
        </div>

        <div className="flex gap-2 px-4 py-3 border-t border-pm-border bg-pm-hover/20">
          <button
            onClick={onCancel}
            className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border border-pm-border bg-pm-hover text-pm-text hover:bg-pm-row-active transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="flex-1 h-[32px] rounded-md text-xs font-semibold cursor-pointer border-none bg-[#f26b3a] text-white hover:bg-[#f26b3a]/90 transition-colors"
          >
            Export
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
