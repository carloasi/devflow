'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Check, History, RotateCcw, Trash2, List, ChevronLeft, Search, X } from 'lucide-react'
import { useEnvironment } from '@/components/EnvironmentContext'

// ─────────────────────────────────────────────────────────────────────────
// Mesmo popover de variável de environment que a URL/body da REQUEST abrem
// (ver UrlInputWithVariables/HttpBodyEditor) — agora também no chip da URL
// do Runner (VariableText), que até aqui só abria a caixinha simples de
// "trocar o valor" (VariableEditRow, que continua existindo pros chips do
// Payload/Response em JsonBlock — não pedido pra mudar).
//
// Um popover novo, e não o reaproveitamento do de lá: aquele vive dentro de
// UrlInputWithVariables inteiro acoplado ao debounce/commit de quem digita
// na URL de uma request aberta — aqui a edição é só "abriu, trocou um valor,
// fechou", sem nada em comum pra compartilhar além do histórico, que já vem
// do EnvironmentContext (useEnvironment()) direto, sem precisar atravessar
// props.
//
// Trocar o environment no seletor do cabeçalho só muda QUAL environment este
// popover está olhando/editando — nunca o environment do Runner (`activeEnvId`,
// o que a request de fato usa). É só uma forma de espiar ou corrigir o valor
// de outro ambiente sem sair daqui.
// ─────────────────────────────────────────────────────────────────────────

interface Props {
  varKey: string
  /** Valor com que o popover abre — e contra o qual se decide se houve edição. */
  initial: string
  /** Environment que o Runner de fato usa — só editar ESTE aciona `onCommit`
   *  (e o "salvo" piscando no chip da URL); os outros são só consulta/edição
   *  avulsa, gravada direto no environment escolhido. */
  activeEnvId: string | null
  /** Retângulo do chip clicado, pra posicionar o popover logo abaixo dele. */
  anchorRect: DOMRect
  onCommit: (value: string) => void
  onClose: () => void
  /** Troca o TOKEN da URL por outra variável ("switch to variable list" do
   *  popover original) — lista as do environment que está sendo visto no
   *  seletor. Ausente = sem onde escrever de volta, o botão nem aparece. */
  onReplaceWith?: (newKey: string) => void
}

export function VariableQuickPopover({
  varKey,
  initial,
  activeEnvId,
  anchorRect,
  onCommit,
  onClose,
  onReplaceWith,
}: Props) {
  const {
    environments,
    patchEnvironmentVariables,
    recordPreviousVariableValue,
    seedPreviousVariableValueIfMissing,
    getVariableValueHistory,
    removeVariableValueFromHistory,
    clearVariableValueHistory,
  } = useEnvironment()

  const [viewEnvId, setViewEnvId] = useState(activeEnvId)

  const valueInEnv = useCallback(
    (envId: string | null): string =>
      environments.find(e => e.id === envId)?.values.find(v => v.key === varKey && v.enabled)?.value ?? '',
    [environments, varKey]
  )

  const [draft, setDraft] = useState(initial)
  const [showHistory, setShowHistory] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  const [copiedCurrent, setCopiedCurrent] = useState(false)
  const [copiedHistoryIndex, setCopiedHistoryIndex] = useState<number | null>(null)
  const [coords, setCoords] = useState({ x: anchorRect.left, y: anchorRect.bottom + 6 })

  // 'list': trocando o token da URL por outra variável, em vez de editando
  // o valor desta — mesma troca de tela do popover original.
  const [view, setView] = useState<'edit' | 'list'>('edit')
  const [listSearch, setListSearch] = useState('')

  const viewEnvVariables = useMemo(
    () => environments.find(e => e.id === viewEnvId)?.values.filter(v => v.enabled && v.key) ?? [],
    [environments, viewEnvId]
  )
  const filteredListVariables = useMemo(() => {
    const q = listSearch.toLowerCase().trim()
    if (!q) return viewEnvVariables
    return viewEnvVariables.filter(v => v.key.toLowerCase().includes(q) || v.value.toLowerCase().includes(q))
  }, [viewEnvVariables, listSearch])

  const popoverRef = useRef<HTMLDivElement>(null)
  // Só a PRIMEIRA edição de verdade (por environment visitado) vira um passo
  // de histórico — reabrir o popover, ou só trocar de environment e voltar,
  // não deve empilhar várias entradas pelo mesmo gesto.
  const recordedRef = useRef<Record<string, boolean>>({})

  useEffect(() => {
    seedPreviousVariableValueIfMissing(varKey, initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Base de comparação do environment atualmente visto no seletor — o
  // ativo usa `initial` (o que o Runner já tinha resolvido, sem precisar
  // relê-lo de `environments`); qualquer outro vem direto da lista.
  const viewInitial = viewEnvId === activeEnvId ? initial : valueInEnv(viewEnvId)

  const switchEnv = (envId: string) => {
    setViewEnvId(envId)
    setDraft(envId === activeEnvId ? initial : valueInEnv(envId))
  }

  const commit = useCallback(
    (next: string) => {
      if (!viewEnvId || next === viewInitial) return
      if (!recordedRef.current[viewEnvId]) {
        recordedRef.current[viewEnvId] = true
        recordPreviousVariableValue(varKey, viewInitial)
      }
      if (viewEnvId === activeEnvId) {
        // O environment que a request de fato usa: quem chamou (VariableText)
        // já sabe fazer isso e também acende o "salvo" no chip da URL.
        onCommit(next)
      } else {
        patchEnvironmentVariables(viewEnvId, { [varKey]: viewInitial }, { [varKey]: next })
      }
    },
    [viewEnvId, viewInitial, activeEnvId, varKey, recordPreviousVariableValue, patchEnvironmentVariables, onCommit]
  )

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) onClose()
    }
    // mousedown, não click: fecha ANTES do clique em outro chip terminar,
    // senão o segundo clique abriria e esta instância fecharia por cima.
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const historyList = getVariableValueHistory(varKey)

  // Mantém o popover dentro da viewport — mesma lógica do popover da URL da
  // request (inclusive virar pra cima do chip quando não cabe embaixo).
  useLayoutEffect(() => {
    if (!popoverRef.current) return
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    const rect = popoverRef.current.getBoundingClientRect()

    let top = anchorRect.bottom + 6
    if (top + rect.height > vh - margin) {
      const above = anchorRect.top - rect.height - 6
      top = above >= margin ? above : Math.max(margin, vh - rect.height - margin)
    }

    let left = anchorRect.left
    if (left + rect.width > vw - margin) {
      left = Math.max(margin, vw - rect.width - margin)
    }

    setCoords(prev => (prev.x === left && prev.y === top ? prev : { x: left, y: top }))
  }, [anchorRect, showHistory, historyList.length, view, filteredListVariables.length])

  const copyText = async (text: string, flag: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text)
    flag(true)
    setTimeout(() => flag(false), 1500)
  }

  const copyHistoryValue = async (histValue: string, index: number) => {
    await navigator.clipboard.writeText(histValue)
    setCopiedHistoryIndex(index)
    setTimeout(() => setCopiedHistoryIndex(current => (current === index ? null : current)), 1500)
  }

  return createPortal(
    <div
      ref={popoverRef}
      style={{ left: coords.x, top: coords.y }}
      className="fixed z-[100000] w-fit min-w-[300px] max-w-[90vw] overflow-hidden rounded-lg border border-pm-border bg-pm-surface font-sans shadow-[0_12px_36px_rgba(0,0,0,0.6)] animate-in fade-in zoom-in-95 duration-150"
      onClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="flex items-center justify-between gap-4 border-b border-pm-border bg-pm-hover/60 px-3 py-2.5">
        <div className="flex items-center gap-1.5 whitespace-nowrap min-w-0">
          <span className="shrink-0 flex h-[18px] w-[18px] items-center justify-center rounded text-[10px] font-extrabold border border-[rgba(76,175,80,0.3)] bg-[rgba(76,175,80,0.12)] text-[#4caf70]">
            E
          </span>
          {/* Trocar aqui só muda o que ESTE popover mostra/edita — nunca o
              environment que o Runner de fato usa pra rodar a request. */}
          <select
            value={viewEnvId ?? ''}
            onChange={e => switchEnv(e.target.value)}
            title="View or edit this variable in another environment"
            className="min-w-0 max-w-[140px] bg-transparent text-[11px] text-pm-text-muted outline-none cursor-pointer hover:text-pm-text-secondary"
          >
            {environments.length === 0 && <option value="">No environment</option>}
            {environments.map(env => (
              <option key={env.id} value={env.id} className="bg-pm-surface text-pm-text">
                {env.name}
                {env.id === activeEnvId ? ' (active)' : ''}
              </option>
            ))}
          </select>
        </div>

        {view === 'list' ? (
          <button
            type="button"
            onClick={() => setView('edit')}
            title="Back to the value editor"
            className="shrink-0 flex items-center gap-1 p-1 -mr-1 rounded text-[11px] text-pm-text-muted hover:text-pm-text hover:bg-pm-surface transition-colors cursor-pointer"
          >
            <ChevronLeft size={12} />
          </button>
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate whitespace-nowrap font-mono text-[11px] font-bold text-pm-text">{varKey}</span>
            <button
              type="button"
              onClick={() => copyText(varKey, setCopiedKey)}
              title={copiedKey ? 'Copied!' : 'Copy variable name'}
              className="shrink-0 p-1 rounded text-pm-text-muted hover:text-blue-400 hover:bg-pm-surface transition-colors cursor-pointer"
            >
              {copiedKey ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
            </button>
            {onReplaceWith && (
              <button
                type="button"
                onClick={() => setView('list')}
                title="Switch to the variable list — picking one replaces this token"
                className="shrink-0 p-1 rounded text-pm-text-muted hover:text-blue-400 hover:bg-pm-surface transition-colors cursor-pointer"
              >
                <List size={11} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5 p-3">
       {view === 'list' ? (
        <>
          <div className="flex items-center gap-2 bg-pm-hover/60 border border-pm-border rounded-md px-2 h-8">
            <Search size={12} className="text-pm-text-muted shrink-0" />
            <input
              value={listSearch}
              onChange={e => setListSearch(e.target.value)}
              autoFocus
              placeholder="Search variable..."
              spellCheck={false}
              className="bg-transparent flex-1 min-w-0 text-xs text-pm-text outline-none placeholder:text-pm-text-muted font-mono"
            />
          </div>
          <div className="flex flex-col gap-0.5 max-h-[220px] overflow-y-auto">
            {filteredListVariables.length === 0 && (
              <div className="py-4 text-center text-[11px] text-pm-text-muted">No variables found</div>
            )}
            {filteredListVariables.map(v => (
              <button
                key={v.id}
                type="button"
                onClick={() => onReplaceWith?.(v.key)}
                title={`Use {{${v.key}}} here instead`}
                className={`flex items-center justify-between gap-2 h-7 px-2 rounded text-left transition-colors cursor-pointer ${
                  v.key === varKey ? 'bg-blue-500/10' : 'hover:bg-pm-hover'
                }`}
              >
                <span className="truncate font-mono text-[11px] font-semibold text-pm-text">{v.key}</span>
                <span className="truncate font-mono text-[10.5px] text-pm-text-muted max-w-[140px]">{v.value}</span>
              </button>
            ))}
          </div>
        </>
       ) : (
        <>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <input
              type="text"
              value={draft}
              autoFocus
              onChange={e => setDraft(e.target.value)}
              onBlur={() => commit(draft)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  // blur() dispara o onBlur (e o commit) na hora, antes de
                  // continuar — então o fechamento abaixo já vê o valor certo.
                  (e.target as HTMLInputElement).blur()
                  onClose()
                }
              }}
              placeholder="(empty)"
              spellCheck={false}
              className={`w-full h-[32px] rounded-md border border-pm-border bg-pm-hover px-2.5 font-mono text-[12px] text-pm-text outline-none focus:border-[#3c89e0]/50 transition-colors ${
                draft ? 'pr-7' : ''
              }`}
            />
            {draft && (
              <button
                type="button"
                onClick={() => {
                  setDraft('')
                  commit('')
                }}
                title="Clear value"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-row-active transition-colors cursor-pointer"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => copyText(draft, setCopiedCurrent)}
            title={copiedCurrent ? 'Copied!' : 'Copy value'}
            className="shrink-0 p-1.5 rounded text-pm-text-muted hover:text-blue-400 hover:bg-pm-hover transition-colors cursor-pointer"
          >
            {copiedCurrent ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
          </button>
        </div>

        {historyList.length > 0 && (
          <div className="flex flex-col">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setShowHistory(v => !v)}
                className="flex items-center gap-1 px-1 py-0.5 -ml-1 rounded text-[10px] text-pm-text-muted hover:text-pm-text-secondary transition-colors cursor-pointer"
              >
                <History size={10} />
                <span>{showHistory ? 'Hide history' : `Show history (${historyList.length})`}</span>
              </button>

              {showHistory && (
                <button
                  type="button"
                  onClick={() => clearVariableValueHistory(varKey)}
                  title="Clear this variable's whole history"
                  className="flex items-center gap-1 px-1 py-0.5 rounded text-[10px] text-pm-text-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                >
                  <Trash2 size={10} />
                  Clear all
                </button>
              )}
            </div>

            <div
              className={`grid transition-all duration-200 ease-out ${
                showHistory ? 'grid-rows-[1fr] opacity-100 mt-1.5' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="overflow-hidden flex flex-col gap-1">
                {historyList.map((histValue, index) => {
                  const differsFromDraft = histValue !== draft
                  return (
                    <div
                      key={index}
                      className="flex items-center gap-1.5 h-[28px] px-2.5 rounded-md bg-pm-hover/60 border border-pm-border"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-pm-text-muted" title={histValue}>
                        {histValue || <i className="not-italic text-pm-text-muted font-sans">empty</i>}
                      </span>

                      <button
                        type="button"
                        onClick={() => copyHistoryValue(histValue, index)}
                        title={copiedHistoryIndex === index ? 'Copied!' : 'Copy value'}
                        className="shrink-0 p-1 rounded text-pm-text-muted hover:text-blue-400 hover:bg-pm-hover transition-colors cursor-pointer"
                      >
                        {copiedHistoryIndex === index ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
                      </button>

                      {differsFromDraft && (
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(histValue)
                            commit(histValue)
                          }}
                          title="Restore this value"
                          className="shrink-0 p-1 rounded text-pm-text-muted hover:text-amber-400 hover:bg-pm-hover transition-colors cursor-pointer"
                        >
                          <RotateCcw size={11} />
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => removeVariableValueFromHistory(varKey, histValue)}
                        title="Remove from history"
                        className="shrink-0 p-1 rounded text-pm-text-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
        </>
       )}
      </div>
    </div>,
    document.body
  )
}
