'use client'

import React, { useMemo, useState, useRef, useEffect } from 'react'
import { findAmbiguousKeys } from '@/lib/envMap'
import {
  Plus,
  Download,
  DownloadCloud,
  Lock,
  Search,
  Trash2,
  History,
  Copy,
  Check,
  RotateCcw,
  UploadCloud,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Send,
  X,
  Minus,
} from 'lucide-react'
import { toast } from 'sonner'

import { Environment, EnvironmentValue } from '@/app/types/Environment'
import { useEnvironment } from '../EnvironmentContext'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && (
    '__TAURI_INTERNALS__' in window || '__TAURI__' in window
  )
}

async function saveFileViaTauri(fileName: string, content: string): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { writeTextFile } = await import('@tauri-apps/plugin-fs')

  const filePath = await save({
    defaultPath: fileName,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })

  if (!filePath) return false

  await writeTextFile(filePath, content)
  return true
}

function saveFileViaBrowser(fileName: string, content: string) {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 100)
}

async function saveJsonFile(fileName: string, content: string): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await saveFileViaTauri(fileName, content)
      return
    } catch (err) {
      console.error('Falha ao salvar via API do Tauri, tentando fallback do navegador:', err)
    }
  }
  saveFileViaBrowser(fileName, content)
}

// Ordenação da tabela — só muda a exibição, a ordem salva no environment
// continua a mesma.
type SortField = 'key' | 'value' | 'description'
type SortDir = 'asc' | 'desc'
const SORT_STORAGE_KEY = 'devflow_env_vars_sort'

function loadSort(): { field: SortField; dir: SortDir } | null {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (['key', 'value', 'description'].includes(parsed?.field) && ['asc', 'desc'].includes(parsed?.dir)) {
      return parsed
    }
  } catch {
    // Sem storage (ou valor inválido): começa na ordem original.
  }
  return null
}

const sortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// Nunca mutado: quem altera a seleção sempre cria um Set novo.
const EMPTY_SELECTION = new Set<string>()

// Entrada que recebe o valor quando a key já existe no destino: a ativa
// (keys duplicadas são permitidas, só uma fica enabled), senão a primeira.
function findTargetIndex(values: EnvironmentValue[], key: string): number {
  const enabled = values.findIndex(v => v.key === key && v.enabled)
  return enabled !== -1 ? enabled : values.findIndex(v => v.key === key)
}

// Copia as variáveis selecionadas pro environment de destino. Key que já
// existe lá é sobrescrita (valor, tipo e descrição); o resto é criado.
function copyVariablesInto(
  target: Environment,
  variables: EnvironmentValue[]
): { values: EnvironmentValue[]; added: number; overwritten: number } {
  const values = [...target.values]
  let added = 0
  let overwritten = 0

  for (const source of variables) {
    const idx = findTargetIndex(values, source.key)
    if (idx === -1) {
      values.push({
        id: crypto.randomUUID(),
        key: source.key,
        value: source.value,
        type: source.type || 'default',
        enabled: true,
        description: source.description ?? '',
      })
      added++
    } else {
      values[idx] = {
        ...values[idx],
        value: source.value,
        type: source.type || values[idx].type || 'default',
        // Não apaga a documentação do destino se a origem não tem nenhuma.
        description: source.description || values[idx].description || '',
      }
      overwritten++
    }
  }

  return { values, added, overwritten }
}

// Checkbox no visual do app — o nativo saía branco e chapado no tema escuro.
// Continua sendo um <input type="checkbox"> (teclado, foco e leitor de tela
// de graça); só a aparência é desenhada por cima.
function TableCheckbox({
  checked,
  indeterminate = false,
  onChange,
  disabled,
  title,
  ariaLabel,
  subtle = false,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  disabled?: boolean
  title?: string
  ariaLabel?: string
  // Desmarcado fica mais apagado até passar o mouse na linha.
  subtle?: boolean
}) {
  const filled = checked || indeterminate
  return (
    <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center align-middle">
      <input
        type="checkbox"
        checked={checked}
        ref={el => {
          if (el) el.indeterminate = indeterminate
        }}
        onChange={onChange}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        className={`peer h-4 w-4 appearance-none rounded-[5px] border outline-none transition-all cursor-pointer
          focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-1 focus-visible:ring-offset-pm-bg
          disabled:cursor-not-allowed disabled:opacity-40 ${
            filled
              ? 'border-blue-500 bg-blue-500 hover:bg-blue-400 hover:border-blue-400'
              : `border-pm-text-muted/40 bg-pm-bg/40 hover:border-blue-400/70 hover:bg-blue-500/10 ${
                  subtle ? 'opacity-60 group-hover:opacity-100 focus-visible:opacity-100' : ''
                }`
          }`}
      />
      {indeterminate ? (
        <Minus size={11} strokeWidth={3.5} className="pointer-events-none absolute text-white" />
      ) : (
        <Check
          size={11}
          strokeWidth={3.5}
          className={`pointer-events-none absolute text-white transition-transform duration-100 ${
            checked ? 'scale-100' : 'scale-0'
          }`}
        />
      )}
    </span>
  )
}

interface QuickViewProps {
  activeEnv: Environment
  onClose: () => void
  onSave?: (env: Environment) => Promise<void> | void
  /** Abre a comparação com o GitHub. Ausente = painel sem sync. */
  onPull?: () => void
}

export function EnvironmentVariablesQuickView({ activeEnv, onClose, onSave, onPull }: QuickViewProps) {
  const {
  environments,
  updateEnvironment,
  recordPreviousVariableValue,
  seedPreviousVariableValueIfMissing,
  getVariableValueHistory,
} = useEnvironment()
  const [quickSearch, setQuickSearch] = useState('')
  const [sort, setSort] = useState<{ field: SortField; dir: SortDir } | null>(() => loadSort())
  // Seleção pra "copiar pra outro environment" (ids de activeVariablesNormalized).
  // Guardada junto com o environment de origem: trocar de environment zera
  // a seleção sem precisar de efeito.
  const [selection, setSelection] = useState<{ envId: string; ids: Set<string> }>({ envId: '', ids: new Set() })
  const selectedIds = selection.envId === activeEnv.id ? selection.ids : EMPTY_SELECTION
  const setSelectedIds = (update: Set<string> | ((prev: Set<string>) => Set<string>)) =>
    setSelection(prev => {
      const current = prev.envId === activeEnv.id ? prev.ids : EMPTY_SELECTION
      return { envId: activeEnv.id, ids: typeof update === 'function' ? update(current) : update }
    })
  const [copyTargetId, setCopyTargetId] = useState('')
  // Chave composta "id:índice" da entrada do histórico copiada por último —
  // até 5 entradas por variável agora, então precisa saber qual linha
  // mostrar o ícone de "copiado".
  const [copiedHistoryKey, setCopiedHistoryKey] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // ── Histórico "um passo atrás", por variável (chave = id) ───────────────

  const activeEnvIdRef = useRef<string | null>(null)
  const focusValueRef = useRef<Record<string, string>>({})
  const editedInSessionRef = useRef<Record<string, boolean>>({})

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopyHistoryValue = async (rowKey: string, value: string) => {
    await navigator.clipboard.writeText(value)
    setCopiedHistoryKey(rowKey)
    setTimeout(() => setCopiedHistoryKey(current => (current === rowKey ? null : current)), 1500)
  }

  // ID estável por posição pra dados legados sem `id` — usar crypto.randomUUID()
  // aqui dentro do useMemo gerava um id NOVO a cada recálculo, trocando a key
  // do React e remontando a linha (perdendo foco/cursor enquanto digitava).
  const ambiguousKeys = useMemo(() => findAmbiguousKeys(activeEnv.values), [activeEnv.values])

  const activeVariablesNormalized = useMemo(() => {
    return activeEnv.values.map((v, idx) => ({
      ...v,
      id: v.id || `__legacy_${idx}`,
    }))
  }, [activeEnv])

useEffect(() => {
  if (activeEnvIdRef.current !== activeEnv.id) {
    activeEnvIdRef.current = activeEnv.id
    activeEnv.values.forEach((v) => {
      if (v.key) seedPreviousVariableValueIfMissing(v.key, v.value)
    })
    focusValueRef.current = {}
    editedInSessionRef.current = {}
  }
}, [activeEnv, seedPreviousVariableValueIfMissing])

  // Clique no cabeçalho: crescente → decrescente → ordem original.
  const toggleSort = (field: SortField) => {
    setSort(prev => {
      const next: { field: SortField; dir: SortDir } | null =
        prev?.field !== field ? { field, dir: 'asc' } : prev.dir === 'asc' ? { field, dir: 'desc' } : null
      try {
        if (next) localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(next))
        else localStorage.removeItem(SORT_STORAGE_KEY)
      } catch {
        // Preferência só desta sessão se não der pra gravar.
      }
      return next
    })
  }

  // A ordem é calculada quando o critério muda ou variáveis entram/saem —
  // NÃO a cada tecla. Senão, editar a key/valor de uma linha com a tabela
  // ordenada fazia a linha pular de lugar no meio da digitação.
  const idsSignature = activeVariablesNormalized.map(v => v.id).join('|')
  const sortedIds = useMemo(() => {
    if (!sort) return null
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...activeVariablesNormalized]
      .sort((a, b) => {
        const av = (a[sort.field] ?? '').trim()
        const bv = (b[sort.field] ?? '').trim()
        // Vazios sempre no fim, nos dois sentidos.
        if (!av && !bv) return 0
        if (!av) return 1
        if (!bv) return -1
        return sortCollator.compare(av, bv) * dir
      })
      .map(v => v.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, idsSignature])

  const sortedVariables = useMemo(() => {
    if (!sortedIds) return activeVariablesNormalized
    const rank = new Map(sortedIds.map((id, i) => [id, i]))
    // Variável criada depois da ordenação vai pro fim, onde o usuário a criou.
    return [...activeVariablesNormalized].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    )
  }, [activeVariablesNormalized, sortedIds])

  const filteredVariables = useMemo(() => {
    const q = quickSearch.toLowerCase().trim()
    if (!q) return sortedVariables

    return sortedVariables.filter(
      (v) =>
        v.key.toLowerCase().includes(q) ||
        v.value.toLowerCase().includes(q) ||
        (v.description ?? '').toLowerCase().includes(q)
    )
  }, [sortedVariables, quickSearch])

  // Só conta o que ainda existe (variável apagada sai da seleção).
  const selectedVariables = useMemo(
    () => activeVariablesNormalized.filter(v => selectedIds.has(v.id)),
    [activeVariablesNormalized, selectedIds]
  )

  // O que de fato vai ser copiado: sem key vazia e uma entrada por key
  // (a ativa, se a origem tiver duplicadas).
  const variablesToCopy = useMemo(() => {
    const byKey = new Map<string, EnvironmentValue>()
    for (const v of selectedVariables) {
      const key = v.key.trim()
      if (!key) continue
      const current = byKey.get(key)
      if (!current || (!current.enabled && v.enabled)) byKey.set(key, { ...v, key })
    }
    return [...byKey.values()]
  }, [selectedVariables])

  const otherEnvironments = environments.filter(env => env.id !== activeEnv.id)
  const copyTarget = otherEnvironments.find(env => env.id === copyTargetId)
  const conflictCount = copyTarget
    ? variablesToCopy.filter(v => findTargetIndex(copyTarget.values, v.key) !== -1).length
    : 0

  const visibleIds = filteredVariables.map(v => v.id)
  const selectedVisibleCount = visibleIds.filter(id => selectedIds.has(id)).length
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Cabeçalho: marca/desmarca só o que está visível (respeita a busca).
  const toggleSelectAllVisible = () => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) visibleIds.forEach(id => next.delete(id))
      else visibleIds.forEach(id => next.add(id))
      return next
    })
  }

  const handleCopyToEnvironment = () => {
    if (!copyTarget || variablesToCopy.length === 0) return
    const { values, added, overwritten } = copyVariablesInto(copyTarget, variablesToCopy)
    updateEnvironment({ ...copyTarget, values })

    const parts = [
      added ? `${added} added` : '',
      overwritten ? `${overwritten} overwritten` : '',
    ].filter(Boolean)
    toast.success(`Copied to "${copyTarget.name}" — ${parts.join(', ')}.`)
    setSelectedIds(new Set())
  }

  const updateVariable = (targetId: string, fields: Partial<EnvironmentValue>) => {
    const updatedValues = activeVariablesNormalized.map((item) =>
      item.id === targetId ? { ...item, ...fields } : item
    )
    updateEnvironment({ ...activeEnv, values: updatedValues })
  }

  // Avança o histórico apenas na PRIMEIRA edição de valor de cada
  // sessão de foco. Sessões seguintes (novo foco no mesmo campo)
  // avançam o histórico mais uma vez, uma edição por vez.
const commitValueEdit = (
  id: string,
  key: string,
  newValue: string,
  valueBeforeThisEdit: string
) => {
  if (key && !editedInSessionRef.current[id] && newValue !== valueBeforeThisEdit) {
    editedInSessionRef.current[id] = true
    recordPreviousVariableValue(key, valueBeforeThisEdit)
  }
  updateVariable(id, { value: newValue })
}

const handleValueFocus = (id: string, currentValue: string) => {
  focusValueRef.current[id] = currentValue
  editedInSessionRef.current[id] = false
}

const handleRevertToPrevious = (
  id: string,
  key: string,
  previousValue: string,
  currentValue: string
) => {
  if (key && !editedInSessionRef.current[id]) {
    editedInSessionRef.current[id] = true
    recordPreviousVariableValue(key, currentValue)
  }
  updateVariable(id, { value: previousValue })
}

  const deleteVariable = (targetId: string) => {
    const updatedValues = activeVariablesNormalized.filter((item) => item.id !== targetId)
    updateEnvironment({ ...activeEnv, values: updatedValues })
  }

  const addVariable = () => {
    const newVar: EnvironmentValue = {
      id: crypto.randomUUID(),
      key: '',
      value: '',
      type: 'default',
      enabled: true,
      description: '',
    }
    updateEnvironment({ ...activeEnv, values: [...activeVariablesNormalized, newVar] })
  }

  // Exporta no formato padrão de Postman Environment Export — sem nenhuma
  // ofuscação de valor (antes toda variável, incluindo as normais, saía
  // como "OBFv1$..." em vez do valor real, o que não é um formato que o
  // Postman ou qualquer outra ferramenta reconhece; só esse app conseguia
  // reabrir). Import continua aceitando arquivos antigos ofuscados
  // normalmente (EnvironmentSelector.tsx faz o pass-through se o valor não
  // tiver o prefixo OBFv1$).
  const handleExportEnvironment = async () => {
    try {
      const dataToExport = {
        id: activeEnv.id,
        name: activeEnv.name,
        values: activeEnv.values.map((v) => ({
          key: v.key,
          value: v.value,
          type: v.type || 'default',
          enabled: v.enabled ?? true,
          description: v.description || '',
        })),
        // Não existe no formato oficial do Postman (a cor lá é metadado do
        // workspace, não viaja no arquivo exportado) — incluímos aqui só
        // pra a cor sobreviver a um export/import dentro do próprio DevFlow.
        // EnvironmentSelector.tsx já lê esse campo na importação.
        ...(activeEnv.color !== undefined ? { color: activeEnv.color } : {}),
        _postman_variable_scope: activeEnv._postman_variable_scope || 'environment',
        _postman_exported_at: new Date().toISOString(),
        _postman_exported_using: 'DevFlow',
      }

      const jsonString = JSON.stringify(dataToExport, null, 2)
      const fileName = `env-${activeEnv.name.toLowerCase().replace(/\s+/g, '-')}.json`

      await saveJsonFile(fileName, jsonString)
    } catch (err) {
      console.error(err)
      alert('Could not export the environment.')
    }
  }

  const handleSaveToGitHub = async () => {
    if (!onSave || isSaving || !activeEnv.isDirty) return
    setIsSaving(true)
    try {
      await onSave(activeEnv)
    } catch (err) {
      console.error('Falha ao sincronizar environment com GitHub:', err)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-pm-bg text-pm-text">

      {/* SEARCH BAR */}
      <div className="px-4 py-3.5 border-b border-pm-border bg-pm-bg shrink-0">
        <div className="flex items-center gap-2 bg-pm-hover/60 border border-pm-border rounded-xl px-3 h-9 transition-colors focus-within:border-blue-500/40 focus-within:bg-pm-hover">
          <Search size={14} className="text-pm-text-muted shrink-0" />
          <input
            value={quickSearch}
            onChange={(e) => setQuickSearch(e.target.value)}
            placeholder="Search variable key or value..."
            className="bg-transparent flex-1 text-xs text-pm-text outline-none placeholder:text-pm-text-muted font-mono"
          />
          {quickSearch && (
            <span className="text-[10px] text-pm-text-muted font-mono shrink-0">
              {filteredVariables.length} / {activeVariablesNormalized.length}
            </span>
          )}
        </div>
      </div>

      {/* Duas entradas habilitadas com a mesma key: a execução tem que escolher
          uma (fica com a primeira), então editar a outra não muda nada — e nada
          na tabela denunciava isso, porque as duas linhas parecem igualmente
          válidas. */}
      {ambiguousKeys.length > 0 && (
        <div className="px-4 py-2 border-b border-pm-border bg-amber-500/10 text-[11px] text-amber-300/90 shrink-0">
          Enabled more than once: <span className="font-mono">{ambiguousKeys.join(', ')}</span>. Requests
          use the first enabled entry — disable the others so there is no doubt about which value runs.
        </div>
      )}

      {/* TABLE CONTENT */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4 scrollbar-thin scrollbar-thumb-[var(--color-pm-border)]">
        <table className="w-full table-fixed border-separate border-spacing-y-1">
          <thead>
            <tr className="text-[10px] font-semibold text-pm-text-muted uppercase tracking-wider text-left">
              <th className="w-9 pb-2 pl-2.5">
                <TableCheckbox
                  checked={allVisibleSelected}
                  indeterminate={selectedVisibleCount > 0 && !allVisibleSelected}
                  onChange={toggleSelectAllVisible}
                  disabled={visibleIds.length === 0}
                  title={allVisibleSelected ? 'Unselect all' : 'Select all visible variables'}
                  ariaLabel="Select all visible variables"
                />
              </th>
              {([
                ['key', 'Key', 'w-[22%]'],
                ['value', 'Value', 'w-[32%]'],
                ['description', 'Description', 'w-[26%]'],
              ] as const).map(([field, label, width]) => {
                const active = sort?.field === field
                const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown
                return (
                  <th
                    key={field}
                    className={`${width} px-3 pb-2 font-semibold`}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(field)}
                      title={
                        !active
                          ? `Sort by ${label.toLowerCase()} (A → Z)`
                          : sort.dir === 'asc'
                            ? `Sort by ${label.toLowerCase()} (Z → A)`
                            : 'Back to original order'
                      }
                      className={`group inline-flex items-center gap-1 uppercase tracking-wider cursor-pointer transition-colors ${
                        active ? 'text-blue-400' : 'hover:text-pm-text'
                      }`}
                    >
                      {label}
                      <Icon
                        size={11}
                        className={active ? '' : 'opacity-0 group-hover:opacity-60 transition-opacity'}
                      />
                    </button>
                  </th>
                )
              })}
              <th className="w-[16%] pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {filteredVariables.length === 0 && (
              <tr>
                <td colSpan={5} className="py-16 text-center">
                  <div className="flex flex-col items-center gap-2 text-pm-text-muted">
                    <Search size={20} />
                    <span className="text-xs">
                      {quickSearch ? 'No variables found' : 'No variables added yet'}
                    </span>
                  </div>
                </td>
              </tr>
            )}

          {filteredVariables.map((v) => {
            const historyList = getVariableValueHistory(v.key)
            const previousValue = historyList[0]
            const hasChanged = previousValue !== undefined && previousValue !== v.value
            const isExpanded = expandedIds.has(v.id)

              return (
                <React.Fragment key={v.id}>
                  <tr className="group">
                    {/* SELEÇÃO */}
                    <td
                      className={`h-8 pl-2.5 pr-0 py-0 border-y border-l border-pm-border rounded-l-lg transition-colors ${
                        selectedIds.has(v.id) ? 'bg-blue-500/10' : 'bg-pm-surface group-hover:bg-pm-hover'
                      }`}
                    >
                      <TableCheckbox
                        checked={selectedIds.has(v.id)}
                        onChange={() => toggleSelected(v.id)}
                        ariaLabel={`Select ${v.key || 'variable'}`}
                        subtle
                      />
                    </td>

                    {/* KEY */}
                    <td className="h-8 text-xs font-mono px-0 py-0 bg-pm-surface group-hover:bg-pm-hover border-y border-pm-border transition-colors">
                      <input
                        value={v.key}
                        onChange={(e) => updateVariable(v.id, { key: e.target.value })}
                        placeholder="VARIABLE_NAME"
                        className="w-full h-8 bg-transparent px-3 text-xs font-mono text-[#e8a488] font-semibold outline-none focus:bg-pm-hover focus:ring-1 focus:ring-inset focus:ring-blue-500/40 transition-all placeholder:text-pm-text-muted placeholder:font-normal"
                      />
                    </td>

                    {/* VALUE */}
                    <td className="h-8 text-xs font-mono px-0 py-0 bg-pm-surface group-hover:bg-pm-hover border-y border-pm-border transition-colors">
                      <input
                        value={v.value}
                        onFocus={() => handleValueFocus(v.id, v.value)}
                        onChange={(e) =>
                          commitValueEdit(v.id, v.key, e.target.value, focusValueRef.current[v.id] ?? v.value)
                        }
                        placeholder="empty"
                        className="w-full h-8 bg-transparent px-3 text-xs font-mono text-pm-text-secondary outline-none focus:bg-pm-hover focus:ring-1 focus:ring-inset focus:ring-blue-500/40 transition-all placeholder:text-pm-text-muted placeholder:italic"
                      />
                    </td>

                    {/* DESCRIPTION */}
                    <td className="h-8 text-xs font-mono px-0 py-0 bg-pm-surface group-hover:bg-pm-hover border-y border-pm-border transition-colors">
                      <input
                        value={v.description ?? ''}
                        onChange={(e) => updateVariable(v.id, { description: e.target.value })}
                        placeholder="What is this for?"
                        className="w-full h-8 bg-transparent px-3 text-xs font-sans text-pm-text-muted outline-none focus:bg-pm-hover focus:ring-1 focus:ring-inset focus:ring-blue-500/40 transition-all placeholder:text-pm-text-muted placeholder:italic"
                      />
                    </td>

                    {/* ACTIONS */}
                    <td className="h-8 px-1.5 text-center align-middle bg-pm-surface group-hover:bg-pm-hover border-y border-r border-pm-border rounded-r-lg transition-colors">
                      <div className="flex items-center justify-end gap-0.5">
                        {historyList.length > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(v.id)}
                            title={isExpanded ? 'Hide history' : `Show history (${historyList.length})`}
                            className={`relative p-1.5 rounded-md transition-all cursor-pointer ${
                              isExpanded
                                ? 'text-blue-400 bg-blue-500/10'
                                : 'text-pm-text-muted hover:text-pm-text-secondary hover:bg-pm-hover opacity-0 group-hover:opacity-100'
                            }`}
                          >
                            <History size={12} className={hasChanged && !isExpanded ? 'text-amber-500/80' : ''} />
                            {hasChanged && !isExpanded && (
                              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500 ring-2 ring-pm-bg" />
                            )}
                          </button>
                        )}

                        <button
                          onClick={() => deleteVariable(v.id)}
                          title="Remove variable"
                          className="opacity-0 group-hover:opacity-100 text-pm-text-muted hover:text-red-400 p-1.5 rounded-md hover:bg-red-500/10 transition-all cursor-pointer"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>

                  {/* HISTÓRICO — expandível, até 5 valores anteriores (mais recente primeiro) */}
                  {historyList.length > 0 && (
                    <tr className={isExpanded ? '' : 'hidden'}>
                      <td colSpan={5} className="px-0 pt-0.5 pb-0">
                        <div className="flex flex-col gap-1 ml-1 w-fit max-w-full">
                          {historyList.map((histValue, index) => {
                            const rowKey = `${v.id}:${index}`
                            const isDifferentFromCurrent = histValue !== v.value
                            return (
                              <div
                                key={rowKey}
                                className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-pm-hover/60 border border-pm-border"
                              >
                                {index === 0 && <History size={10} className="text-amber-500/70 shrink-0" />}
                                <span
                                  className={`min-w-0 max-w-[240px] truncate font-mono text-[11px] ${
                                    index === 0 && hasChanged ? 'text-amber-400/90' : 'text-pm-text-muted'
                                  }`}
                                  title={histValue}
                                >
                                  {histValue || <i className="not-italic text-pm-text-muted font-sans">empty</i>}
                                </span>

                                <button
                                  type="button"
                                  onClick={() => handleCopyHistoryValue(rowKey, histValue)}
                                  title={copiedHistoryKey === rowKey ? 'Copied!' : 'Copy value'}
                                  className="shrink-0 p-1 rounded text-pm-text-muted hover:text-blue-400 hover:bg-pm-hover transition-colors cursor-pointer"
                                >
                                  {copiedHistoryKey === rowKey ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
                                </button>

                                {isDifferentFromCurrent && (
                                  <button
                                    type="button"
                                    onClick={() => handleRevertToPrevious(v.id, v.key, histValue, v.value)}
                                    title="Restore this value"
                                    className="shrink-0 p-1 rounded text-pm-text-muted hover:text-amber-400 hover:bg-pm-hover transition-colors cursor-pointer"
                                  >
                                    <RotateCcw size={11} />
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* COPIAR SELECIONADAS PRA OUTRO ENVIRONMENT */}
      {selectedVariables.length > 0 && (
        <div className="shrink-0 border-t border-blue-500/30 bg-blue-500/5 px-4 py-2.5 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-semibold text-blue-400 shrink-0">
              {selectedVariables.length} selected
            </span>
            <select
              value={copyTargetId}
              onChange={e => setCopyTargetId(e.target.value)}
              disabled={otherEnvironments.length === 0}
              className="min-w-0 flex-1 h-8 rounded-lg border border-pm-border bg-pm-surface px-2 text-xs text-pm-text outline-none focus:border-blue-500/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">
                {otherEnvironments.length === 0 ? 'No other environment' : 'Copy to environment...'}
              </option>
              {otherEnvironments.map(env => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleCopyToEnvironment}
              disabled={!copyTarget || variablesToCopy.length === 0}
              className="h-8 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={12} />
              Copy
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              title="Clear selection"
              className="h-8 w-8 flex items-center justify-center rounded-lg text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer shrink-0"
            >
              <X size={14} />
            </button>
          </div>

          {copyTarget && (
            <span className="text-[10.5px] text-pm-text-muted">
              {variablesToCopy.length - conflictCount} new
              {conflictCount > 0 && (
                <span className="text-amber-400">
                  {' · '}{conflictCount} will overwrite existing value{conflictCount === 1 ? '' : 's'} in &quot;{copyTarget.name}&quot;
                </span>
              )}
              {variablesToCopy.length < selectedVariables.length && (
                <span>{' · '}{selectedVariables.length - variablesToCopy.length} skipped (empty or repeated key)</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* FOOTER */}
      <div className="shrink-0 border-t border-pm-border bg-pm-bg">
        <div className="h-14 px-5 flex items-center justify-between gap-3">
          <button
            onClick={addVariable}
            className="h-9 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm shrink-0"
          >
            <Plus size={14} />
            Add Variable
          </button>

          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] text-pm-text-muted font-mono shrink-0">
              {activeVariablesNormalized.length} variables
            </span>

            {onSave && (
              <button
                onClick={handleSaveToGitHub}
                disabled={!activeEnv.isDirty || isSaving}
                title={activeEnv.isDirty ? "Save changes to GitHub" : "No pending changes"}
                className={`h-9 px-3 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm shrink-0 ${
                  activeEnv.isDirty
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                    : 'bg-pm-hover border border-pm-border text-pm-text-muted cursor-not-allowed'
                }`}
              >
                {isSaving ? (
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <UploadCloud size={13} />
                )}
                <span>{isSaving ? 'Sending...' : 'Save to GitHub'}</span>
              </button>
            )}

            {/* Par do "Save to GitHub": traz o que mudou lá, mas passando
                pela tela de comparação em vez de substituir tudo — num
                environment de 155 variáveis, aceitar em bloco é o que faz
                perder um valor local sem perceber. */}
            {onPull && (
              <button
                onClick={onPull}
                title="Pull from GitHub — review each change before applying"
                className="h-9 px-3 rounded-xl border border-pm-border bg-pm-hover/50 hover:bg-pm-hover text-xs text-pm-text-secondary flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
              >
                <DownloadCloud size={13} />
                <span>Pull</span>
              </button>
            )}

            <button
              onClick={handleExportEnvironment}
              disabled={activeVariablesNormalized.length === 0}
              title="Export environment as JSON"
              className="h-9 px-3 rounded-xl border border-pm-border bg-pm-hover/50 hover:bg-pm-hover disabled:opacity-40 disabled:cursor-not-allowed text-xs text-pm-text-secondary flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
            >
              <Download size={13} />
              <span>Export</span>
              <Lock size={10} className="text-blue-400" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
