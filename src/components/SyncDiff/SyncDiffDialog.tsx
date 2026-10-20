'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, FileText, Folder, Minus, Plus, Pencil, Search, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { DiffNode, FieldDiff } from '@/lib/collectionDiff'
import type { NodeHashes } from '@/lib/syncBase'
import {
  formatFieldValue,
  isEditableField,
  parseFieldValue,
  type OverrideMap,
} from '@/lib/diffFields'
import { groupByRoot } from '@/lib/collectionDiff'
import {
  conflictingIds,
  defaultSelection,
  countByRisk,
  rootState,
  selectWithin,
  summarize,
  toggleNode,
  toggleRoot,
} from '@/lib/diffSelection'
import {
  applyFilter,
  groupByParent,
  isFiltering,
  labelOf,
  NO_FILTER,
  type ChangeFilter,
  type DiffFilter,
} from '@/lib/diffList'
import { useDraggableDialog } from '@/components/helper/useDraggableDialog'
import { EntryDiffTable } from './EntryDiffTable'
import { diffEntries, entriesFromText } from '@/lib/entryDiff'

interface Props {
  open: boolean
  nodes: DiffNode[]
  /** Collections com alteração local ainda não enviada (storage/pendingPushStore). */
  pendingCollectionIds: ReadonlySet<string>
  /** Estado da última sincronização. Sem ela, o conflito recai no critério
   *  por collection, que avisa demais. */
  base?: NodeHashes | null
  collectionNames: Map<string, string>
  onClose: () => void
  onApply: (selectedIds: Set<string>, overrides: OverrideMap) => void
}

// Chave do grupo "direto na raiz da collection". Caractere que nome de pasta
// não contém, pra não colidir com uma pasta de verdade chamada "root".
const ROOT_GROUP_KEY = '\u0000root'

const CHANGE_STYLE: Record<DiffNode['change'], { color: string; label: string; Icon: typeof Plus }> = {
  added: { color: 'text-[#4ff09d]', label: 'only on GitHub', Icon: Plus },
  removed: { color: 'text-[#ff7b7b]', label: 'only here', Icon: Minus },
  modified: { color: 'text-amber-400', label: 'changed', Icon: Pencil },
}

// Valor de campo como texto legível. JSON cru numa linha só (headers, auth)
// é ilegível no painel estreito, e é justamente onde a diferença costuma estar.
function renderValue(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value || '(empty)'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

interface FieldRowProps {
  field: FieldDiff
  /** Texto na caixa de resultado. Vazio = ainda não editado. */
  draft: string | undefined
  error: string | undefined
  onDraftChange: (text: string | undefined) => void
}

function FieldRow({ field, draft, error, onDraftChange }: FieldRowProps) {
  const editable = isEditableField(field.field)
  // Enquanto ninguém editou, a caixa mostra o valor do GitHub: aceitar o nó
  // sem mexer em nada tem que continuar significando exatamente isso.
  const value = draft ?? formatFieldValue(field.field, field.remote)
  const edited = draft !== undefined

  // Headers e variáveis viram uma linha por entrada. Os outros campos
  // (`auth`, `example`, `order`) não são lista de chave/valor e seguem no
  // JSON lado a lado — é o que `diffEntries` devolvendo null quer dizer.
  const entryRows = useMemo(
    () => diffEntries(field.local, field.remote),
    [field.local, field.remote]
  )
  // null aqui = o texto da caixa não é uma lista (JSON pela metade enquanto
  // se digita). A tabela ainda compara; só não dá pra escolher por linha.
  const entries = entryRows ? entriesFromText(value) : null

  return (
    <div className="rounded-md border border-pm-border bg-pm-hover/50 p-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-pm-text-muted">
          {field.field}
        </span>
        {edited && <span className="text-[9.5px] text-[#63b3ed]">edited</span>}
        {editable && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => onDraftChange(formatFieldValue(field.field, field.local))}
              className="text-[9.5px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
            >
              Use here
            </button>
            <button
              onClick={() => onDraftChange(undefined)}
              className="text-[9.5px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
            >
              Use GitHub
            </button>
          </div>
        )}
      </div>

      {entryRows ? (
        <EntryDiffTable
          rows={entryRows}
          entries={entries}
          onEntriesChange={next => onDraftChange(JSON.stringify(next, null, 2))}
        />
      ) : (
        <div className="grid grid-cols-2 gap-2 mb-1.5">
          <div>
            <div className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70 mb-0.5">Here</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-red-300/80 max-h-32 overflow-y-auto">
              {renderValue(field.local)}
            </pre>
          </div>
          <div>
            <div className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70 mb-0.5">GitHub</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-[#4ff09d]/80 max-h-32 overflow-y-auto">
              {renderValue(field.remote)}
            </pre>
          </div>
        </div>
      )}

      {editable ? (
        <>
          <div className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70 mb-0.5">
            Result — what gets saved
          </div>
          <textarea
            value={value}
            onChange={e => onDraftChange(e.target.value)}
            spellCheck={false}
            rows={Math.min(10, Math.max(2, value.split('\n').length))}
            className={`w-full rounded border bg-pm-bg px-2 py-1.5 font-mono text-[10.5px] text-pm-text outline-none resize-y ${
              error ? 'border-rose-500/60' : 'border-pm-border focus:border-[#007acc]/60'
            }`}
          />
          {error && <p className="mt-0.5 text-[10px] text-rose-400">Invalid JSON: {error}</p>}
        </>
      ) : (
        // `order` é a sequência dos filhos, derivada — não há texto que
        // devolva o resultado pros nós certos.
        <p className="text-[10px] text-pm-text-muted/70">
          This one can&apos;t be edited here — accept it or leave it as is.
        </p>
      )}
    </div>
  )
}

export function SyncDiffDialog({
  open,
  nodes,
  pendingCollectionIds,
  base = null,
  collectionNames,
  onClose,
  onApply,
}: Props) {
  const conflicts = useMemo(
    () => conflictingIds(nodes, pendingCollectionIds, base),
    [nodes, pendingCollectionIds, base]
  )

  // A chave reinicia a seleção quando um diff novo chega: sem isso ids de uma
  // comparação anterior continuariam marcados numa lista que já é outra.
  const diffKey = useMemo(() => nodes.map(n => `${n.id}:${n.change}`).join('|'), [nodes])
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(nodes, conflicts))
  const [appliedKey, setAppliedKey] = useState(diffKey)
  if (appliedKey !== diffKey) {
    setAppliedKey(diffKey)
    setSelected(defaultSelection(nodes, conflicts))
  }

  const drag = useDraggableDialog()

  const [focusedId, setFocusedId] = useState<string | null>(null)

  // Texto das caixas de resultado, por nó e campo. Guardado como TEXTO, não
  // como valor: enquanto o JSON está pela metade ele não converte, e perder o
  // que foi digitado a cada tecla inválida tornaria a edição inviável.
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})

  const setDraft = (nodeId: string, field: string, text: string | undefined) => {
    setDrafts(prev => {
      const node = { ...(prev[nodeId] ?? {}) }
      if (text === undefined) delete node[field]
      else node[field] = text
      const next = { ...prev }
      if (Object.keys(node).length === 0) delete next[nodeId]
      else next[nodeId] = node
      return next
    })
    // Editar é decisão mais forte que a caixinha: marca o nó, pra ninguém
    // acabar editando algo que não seria aplicado.
    if (text !== undefined) setSelected(prev => (prev.has(nodeId) ? prev : new Set(prev).add(nodeId)))
  }

  // Converte os textos em valores, separando os que não são JSON válido. Os
  // inválidos bloqueiam o aplicar: gravar lixo numa request só apareceria no
  // próximo Send, longe daqui.
  const { overrides, errors } = useMemo(() => {
    const parsed: OverrideMap = {}
    const invalid: Record<string, Record<string, string>> = {}
    for (const [nodeId, fields] of Object.entries(drafts)) {
      for (const [field, text] of Object.entries(fields)) {
        const result = parseFieldValue(field, text)
        if (result.ok) {
          parsed[nodeId] = { ...(parsed[nodeId] ?? {}), [field]: result.value }
        } else {
          invalid[nodeId] = { ...(invalid[nodeId] ?? {}), [field]: result.error }
        }
      }
    }
    return { overrides: parsed, errors: invalid }
  }, [drafts])

  const errorCount = Object.values(errors).reduce((acc, f) => acc + Object.keys(f).length, 0)
  const focused = nodes.find(n => n.id === focusedId) ?? null

  // O filtro recorta o que se VÊ, nunca o que se aplica: o rodapé e o Apply
  // continuam contando a seleção inteira, porque é ela que vai pro disco.
  // Esconder itens selecionados do total faria o botão mentir.
  const [filter, setFilter] = useState<DiffFilter>(NO_FILTER)
  const filtering = isFiltering(filter)
  const visible = useMemo(() => applyFilter(nodes, conflicts, filter), [nodes, conflicts, filter])
  const hidden = nodes.length - visible.length

  const groups = useMemo(() => groupByRoot(visible), [visible])
  const summary = summarize(nodes, selected, conflicts)
  // Contagens do que está na TELA: a barra fala dos botões logo ao lado dela,
  // e eles agem sobre o visível.
  const risk = countByRisk(visible, conflicts)

  return (
    // modal={false}: com o padrão do Radix, o resto da tela fica inerte —
    // foco preso e cliques bloqueados —, e o painel do Claude ficava
    // inutilizável enquanto este modal estivesse aberto. Agora ele flutua
    // sobre o app sem desligá-lo.
    <Dialog open={open} modal={false} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent
        showCloseButton={false}
        showOverlay={false}
        // Clique fora NÃO fecha: estes modais seguram trabalho (um run em
        // andamento, uma seleção de mudanças) e ficam abertos junto da
        // árvore, então o clique fora é quase sempre pra olhar outra coisa —
        // não pra descartar. Fecha só no X ou no Esc.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        {...drag.contentProps}
        className="bg-pm-bg border border-pm-border text-pm-text sm:max-w-4xl max-h-[85vh] p-0 flex flex-col overflow-hidden rounded-2xl gap-0"
      >
        <div
          {...drag.handleProps}
          onDoubleClick={drag.reset}
          title="Drag to move — double-click to recenter"
          className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-pm-border select-none"
        >
          <DialogTitle className="text-sm font-semibold text-pm-text">
            Review changes from GitHub
          </DialogTitle>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        {nodes.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-16 text-xs text-pm-text-muted">
            Everything here matches GitHub.
          </div>
        ) : (
          <>
          {/* Com centenas de itens, revisar um a um não é opção. Esta linha diz
              quanto é seguro e quanto precisa de decisão, e deixa voltar
              rapidamente a cada recorte. */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-pm-border bg-pm-hover/30 text-[11px]">
            <span className="text-pm-text-secondary">
              <span className="text-[#4ff09d] font-semibold">{risk.safe}</span> safe
            </span>
            {risk.conflicting > 0 && (
              <span className="text-pm-text-secondary">
                <span className="text-amber-400 font-semibold">{risk.conflicting}</span> need your decision
              </span>
            )}
            {hidden > 0 && (
              <span className="text-pm-text-muted">{hidden} hidden by the filter</span>
            )}

            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => setSelected(prev => selectWithin(prev, visible, 'safe', conflicts))}
                disabled={risk.safe === 0}
                title="Select everything here that can be accepted without losing local work"
                className="rounded px-2 py-1 text-[10.5px] text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer border-none bg-transparent disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Select safe
              </button>
              <button
                onClick={() => setSelected(prev => selectWithin(prev, visible, 'all'))}
                className="rounded px-2 py-1 text-[10.5px] text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer border-none bg-transparent"
              >
                All
              </button>
              <button
                onClick={() => setSelected(prev => selectWithin(prev, visible, 'none'))}
                className="rounded px-2 py-1 text-[10.5px] text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer border-none bg-transparent"
              >
                None
              </button>
            </div>
          </div>

          {/* A busca casa no caminho inteiro, então o nome da pasta traz o que
              está dentro dela — é assim que se procura "aquele fluxo de token"
              sem lembrar o nome exato da request. */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-pm-border">
            <div className="relative flex-1">
              <Search
                size={12}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-pm-text-muted pointer-events-none"
              />
              <input
                value={filter.text}
                onChange={e => setFilter(f => ({ ...f, text: e.target.value }))}
                placeholder="Filter by name or folder"
                spellCheck={false}
                className="w-full h-7 rounded-md border border-pm-border bg-pm-bg pl-7 pr-2 text-[11px] text-pm-text placeholder:text-pm-text-muted outline-none focus:border-[#007acc]/60"
              />
            </div>

            <select
              value={filter.change}
              onChange={e => setFilter(f => ({ ...f, change: e.target.value as ChangeFilter }))}
              className="h-7 rounded-md border border-pm-border bg-pm-bg px-1.5 text-[11px] text-pm-text outline-none cursor-pointer focus:border-[#007acc]/60"
            >
              <option value="all">Any change</option>
              <option value="modified">Changed</option>
              <option value="added">Only on GitHub</option>
              <option value="removed">Only here</option>
            </select>

            <button
              onClick={() => setFilter(f => ({ ...f, conflictsOnly: !f.conflictsOnly }))}
              title="Show only what changed on both sides"
              className={`h-7 flex items-center gap-1 rounded-md border px-2 text-[11px] transition-colors cursor-pointer ${
                filter.conflictsOnly
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                  : 'border-pm-border bg-transparent text-pm-text-secondary hover:bg-pm-hover'
              }`}
            >
              <AlertTriangle size={11} />
              Conflicts
            </button>

            {filtering && (
              <button
                onClick={() => setFilter(NO_FILTER)}
                className="h-7 px-2 rounded-md text-[11px] text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer border-none bg-transparent"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex-1 flex min-h-[320px] overflow-hidden">
            {/* Lista */}
            <div className="w-1/2 overflow-y-auto border-r border-pm-border p-2 flex flex-col gap-2">
              {visible.length === 0 && (
                <p className="px-2 py-6 text-center text-[11px] text-pm-text-muted">
                  Nothing matches this filter.
                </p>
              )}
              {[...groups.entries()].map(([rootId, rootNodes]) => {
                const state = rootState(selected, visible, rootId)
                const name = collectionNames.get(rootId) ?? rootNodes[0]?.path[0] ?? rootId
                const rootPending = pendingCollectionIds.has(rootId)
                return (
                  <div key={rootId} className="rounded-md border border-pm-border/70 bg-pm-hover/30">
                    <label className="flex items-center gap-2 px-2.5 py-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={state === 'all'}
                        ref={el => { if (el) el.indeterminate = state === 'partial' }}
                        onChange={() => setSelected(prev => toggleRoot(prev, visible, rootId))}
                        className="accent-[#f26b3a] cursor-pointer"
                      />
                      <Folder size={13} className="text-pm-text-muted shrink-0" />
                      <span className="text-xs font-semibold text-pm-text truncate flex-1">{name}</span>
                      {rootPending && (
                        <span
                          title="You have local changes here that were never pushed"
                          className="shrink-0 w-[6px] h-[6px] rounded-full bg-amber-400"
                        />
                      )}
                      <span className="text-[10px] tabular-nums text-pm-text-muted shrink-0">
                        {rootNodes.length}
                      </span>
                    </label>

                    <div className="flex flex-col pb-1">
                      {[...groupByParent(rootNodes).entries()].map(([parents, folderNodes]) => (
                        <div key={parents || ROOT_GROUP_KEY}>
                          {/* Cabeçalho de pasta só quando há pasta: na raiz da
                              collection o cabeçalho de cima já diz onde se está. */}
                          {parents && (
                            <div
                              title={parents}
                              className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-0.5 text-[9.5px] uppercase tracking-wide text-pm-text-muted/80"
                            >
                              <Folder size={9} className="shrink-0" />
                              <span className="truncate">{parents}</span>
                            </div>
                          )}

                          {folderNodes.map(node => {
                            const style = CHANGE_STYLE[node.change]
                            const isConflict = conflicts.has(node.id)
                            return (
                              <div
                                key={node.id}
                                onClick={() => setFocusedId(node.id)}
                                title={node.path.join(' / ')}
                                className={`flex items-center gap-2 px-2.5 py-1 cursor-pointer ${
                                  focusedId === node.id ? 'bg-pm-row-active' : 'hover:bg-pm-hover'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={selected.has(node.id)}
                                  onChange={() => setSelected(prev => toggleNode(prev, node.id))}
                                  onClick={e => e.stopPropagation()}
                                  className="accent-[#f26b3a] cursor-pointer"
                                />
                                <style.Icon size={11} className={`${style.color} shrink-0`} />
                                {node.kind === 'folder'
                                  ? <Folder size={11} className="text-pm-text-muted shrink-0" />
                                  : <FileText size={11} className="text-pm-text-muted shrink-0" />}
                                <span className="text-[11px] text-pm-text truncate flex-1">
                                  {labelOf(node).name}
                                </span>
                                {isConflict && (
                                  <AlertTriangle
                                    size={11}
                                    className="text-amber-400 shrink-0"
                                    aria-label="Accepting this discards your unpushed change"
                                  />
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Detalhe */}
            <div className="w-1/2 overflow-y-auto p-3">
              {!focused ? (
                <p className="text-[11px] text-pm-text-muted">Pick an item to see what changed.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  <div>
                    <div className="text-xs font-semibold text-pm-text">{focused.path.join(' / ')}</div>
                    <div className={`text-[10.5px] ${CHANGE_STYLE[focused.change].color}`}>
                      {CHANGE_STYLE[focused.change].label}
                    </div>
                  </div>

                  {conflicts.has(focused.id) && (
                    <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10.5px] text-amber-300">
                      <AlertTriangle size={12} className="mt-px shrink-0" />
                      <span>
                        You have changes in this collection that were never pushed. Accepting the
                        GitHub version replaces your copy, and there is no undo.
                      </span>
                    </div>
                  )}

                  {focused.change === 'modified' ? (
                    focused.fields.map((field, i) => (
                      <FieldRow
                        key={i}
                        field={field}
                        draft={drafts[focused.id]?.[field.field]}
                        error={errors[focused.id]?.[field.field]}
                        onDraftChange={text => setDraft(focused.id, field.field, text)}
                      />
                    ))
                  ) : (
                    <p className="text-[11px] text-pm-text-muted">
                      {focused.change === 'added'
                        ? 'This exists only on GitHub — accepting adds it here.'
                        : 'This exists only here — accepting removes it.'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          </>
        )}

        <div className="h-12 shrink-0 flex items-center justify-between px-4 border-t border-pm-border">
          <span className="text-[11px] text-pm-text-muted">
            {summary.selected}/{summary.total} selected
            {summary.conflicts > 0 && (
              <span className="text-amber-400"> · {summary.conflicts} discard local work</span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-7 px-3 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:bg-pm-hover transition-colors cursor-pointer"
            >
              Close
            </button>
            <button
              onClick={() => onApply(selected, overrides)}
              disabled={summary.selected === 0 || errorCount > 0}
              title={errorCount > 0 ? `Fix ${errorCount} invalid JSON value(s) first` : undefined}
              className="h-7 px-3 rounded-md text-xs font-semibold bg-[#f26b3a] text-white hover:bg-[#f26b3a]/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply {summary.selected}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
