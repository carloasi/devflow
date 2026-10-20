'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Gauge, Play, Square, X, AlertTriangle, Plus, Trash2, ChevronDown, ChevronUp, Check, History, Download, Eye, ArrowLeft, FileText } from 'lucide-react'
import { buildEnvMap } from '@/lib/envMap';
import { useDraggableDialog } from '@/components/helper/useDraggableDialog'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CollectionItem } from '@/app/types/CollectionItem'
import { useEnvironment } from '@/components/EnvironmentContext'
import { flattenRequests } from '@/components/CollectionRunner/runCollectionRequest'
import { buildFlowSteps } from './buildFlowSteps'
import {
  appendLoadTestHistory,
  deleteLoadTestHistoryRecord,
  exportLoadTestRecord,
  loadLoadTestHistory,
} from './loadTestHistory'
import { exportLoadTestRecordAsPdf } from './loadTestPdfReport'
import {
  LoadTestConfig,
  LoadTestMode,
  LoadTestRunRecord,
  LoadTestSnapshot,
  LoadTestStage,
  LoadTestThreshold,
  THRESHOLD_METRICS,
  THRESHOLD_OPERATORS,
} from './types'

interface Props {
  item: CollectionItem | null
  open: boolean
  onClose: () => void
}

const ACCENT = '#097bed'

const DEFAULT_STAGES: LoadTestStage[] = [
  { targetVus: 10, durationSecs: 30 },
  { targetVus: 10, durationSecs: 60 },
  { targetVus: 0, durationSecs: 15 },
]

function formatMs(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return v < 10 ? v.toFixed(2) : Math.round(v).toString()
}

export function LoadTestPanel({ item, open, onClose }: Props) {
  const { environments, selectedEnvId } = useEnvironment()

  const [vus, setVus] = useState(10)
  const [mode, setMode] = useState<LoadTestMode>('duration')
  const [durationSecs, setDurationSecs] = useState(30)
  const [iterationsPerVu, setIterationsPerVu] = useState(100)
  const [stages, setStages] = useState<LoadTestStage[]>(DEFAULT_STAGES)
  const [runEnvId, setRunEnvId] = useState<string | null>(null)

  const [thresholds, setThresholds] = useState<LoadTestThreshold[]>([])
  const [showThresholds, setShowThresholds] = useState(false)

  const [running, setRunning] = useState(false)
  const [testId, setTestId] = useState<string | null>(null)
  const [snapshots, setSnapshots] = useState<LoadTestSnapshot[]>([])
  const [summary, setSummary] = useState<LoadTestSnapshot | null>(null)
  const drag = useDraggableDialog()

  const [error, setError] = useState<string | null>(null)
  const [ranWithRamp, setRanWithRamp] = useState(false)

  // Fase 4: histórico de runs por item (persistido em settings.json).
  const [history, setHistory] = useState<LoadTestRunRecord[]>([])
  // Registro salvo pra run ao vivo mais recente — permite exportar sem
  // precisar reconstruir a config (e sem depender do save no histórico ter
  // funcionado, já que isso é best-effort/assíncrono).
  const [currentRecord, setCurrentRecord] = useState<LoadTestRunRecord | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [viewingRecordId, setViewingRecordId] = useState<string | null>(null)

  const unlistenRef = useRef<(() => void) | null>(null)
  const testIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)

  // Alvo do teste: uma request única ou, se for uma pasta, o fluxo completo
  // achatado na ordem visual da árvore (mesmo helper do Collection Runner).
  const requests = useMemo(() => {
    if (!item) return []
    if (item.type === 'folder') return flattenRequests(item.item || [])
    return item.request ? [item] : []
  }, [item])

  useEffect(() => {
    if (!open) return
    setSnapshots([])
    setSummary(null)
    setRunning(false)
    setTestId(null)
    setError(null)
    setRunEnvId(selectedEnvId ?? null)
    setViewingRecordId(null)
    setShowHistory(false)
    setHistory([])
    setCurrentRecord(null)
    if (item) {
      loadLoadTestHistory(item.id)
        .then(setHistory)
        .catch(() => setHistory([]))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id])

  useEffect(() => {
    return () => {
      unlistenRef.current?.()
    }
  }, [])

  const stopIfRunning = () => {
    unlistenRef.current?.()
    unlistenRef.current = null
    if (testIdRef.current && runningRef.current) {
      const id = testIdRef.current
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('stop_load_test', { testId: id }).catch(() => {})
      })
    }
  }

  const handleClose = () => {
    stopIfRunning()
    onClose()
  }

  const addStage = () => {
    setStages(prev => [...prev, { targetVus: 10, durationSecs: 30 }])
  }
  const removeStage = (idx: number) => {
    setStages(prev => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))
  }
  const updateStage = (idx: number, patch: Partial<LoadTestStage>) => {
    setStages(prev => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  }

  const addThreshold = () => {
    setThresholds(prev => [...prev, { metric: 'p95', operator: '<', value: 500 }])
  }
  const removeThreshold = (idx: number) => {
    setThresholds(prev => prev.filter((_, i) => i !== idx))
  }
  const updateThreshold = (idx: number, patch: Partial<LoadTestThreshold>) => {
    setThresholds(prev => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
  }

  const handleStart = async () => {
    if (!item) return
    setError(null)

    if (requests.length === 0) {
      setError('This item has no request to test.')
      return
    }

    const baseEnv = environments.find(e => e.id === runEnvId)
    // Faltava o filtro de `enabled` aqui: uma duplicata DESABILITADA entrava
    // no mapa e, por vir depois no array, sobrescrevia a habilitada — o teste
    // de carga rodava com o valor que o usuário tinha justamente arquivado.
    const envMap: Record<string, string> = buildEnvMap(baseEnv?.values)

    const flow = buildFlowSteps(requests)
    if (flow.some(step => !step.url.trim())) {
      setError('One of the flow requests has an empty URL.')
      return
    }

    const isRamp = mode === 'ramp'
    const config: LoadTestConfig = {
      flow,
      environment: envMap,
      vus: isRamp ? undefined : vus,
      durationSecs: isRamp ? undefined : mode === 'duration' ? durationSecs : undefined,
      iterationsPerVu: isRamp ? undefined : mode === 'iterations' ? iterationsPerVu : undefined,
      stages: isRamp ? stages : undefined,
      thresholds: thresholds.length > 0 ? thresholds : undefined,
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const { listen } = await import('@tauri-apps/api/event')

      const id = await invoke<string>('start_load_test', { config })
      const startedAt = new Date().toISOString()

      setTestId(id)
      testIdRef.current = id
      setSnapshots([])
      setSummary(null)
      setRunning(true)
      runningRef.current = true
      setRanWithRamp(isRamp)
      setViewingRecordId(null)
      setCurrentRecord(null)

      const unlistenProgress = await listen<LoadTestSnapshot>('load-test-progress', (event) => {
        if (event.payload.testId !== id) return
        setSnapshots(prev => [...prev.slice(-119), event.payload])
      })

      const unlistenDone = await listen<LoadTestSnapshot>('load-test-done', (event) => {
        if (event.payload.testId !== id) return
        setSummary(event.payload)
        setRunning(false)
        runningRef.current = false

        if (item) {
          const record: LoadTestRunRecord = {
            id: crypto.randomUUID(),
            itemId: item.id,
            itemName: item.name,
            startedAt,
            mode,
            config,
            summary: event.payload,
          }
          setCurrentRecord(record)
          appendLoadTestHistory(record)
            .then(setHistory)
            .catch(e => console.log('Falha ao salvar histórico do load test:', e))
        }
      })

      unlistenRef.current = () => {
        unlistenProgress()
        unlistenDone()
      }
    } catch (e: any) {
      setError(typeof e === 'string' ? e : e?.message || 'Failed to start the load test.')
      setRunning(false)
      runningRef.current = false
    }
  }

  const handleStop = async () => {
    if (!testId) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('stop_load_test', { testId })
    } catch (e: any) {
      setError(typeof e === 'string' ? e : e?.message || 'Failed to stop the load test.')
    }
  }

  const viewingRecord = viewingRecordId ? history.find(r => r.id === viewingRecordId) ?? null : null

  // Histórico só guarda o resumo final (evita inchar o settings.json com a
  // série temporal inteira) — então visualizar uma run antiga mostra as
  // métricas agregadas, mas não os gráficos ao longo do tempo.
  const latest = viewingRecord ? viewingRecord.summary : summary ?? snapshots[snapshots.length - 1] ?? null
  const isDone = viewingRecord ? true : !!summary
  const effectiveRanWithRamp = viewingRecord ? viewingRecord.mode === 'ramp' : ranWithRamp

  const chartData = useMemo(
    () =>
      viewingRecord
        ? []
        : snapshots.map(s => ({
            t: Math.round(s.elapsedMs / 1000),
            rps: Math.round(s.rpsCurrent * 10) / 10,
            avg: Math.round(s.latencyAvgMs * 10) / 10,
            p95: Math.round(s.latencyP95Ms * 10) / 10,
            p99: Math.round(s.latencyP99Ms * 10) / 10,
            vus: s.vusActive,
          })),
    [snapshots, viewingRecord]
  )

  // Não chama stopIfRunning aqui de propósito: navegar pro histórico não deve
  // matar um teste ao vivo em andamento, só troca o que é exibido — voltar
  // com "Back to live" mostra o progresso acumulado normalmente.
  const handleViewRecord = (id: string) => {
    setViewingRecordId(id)
    setShowHistory(false)
  }

  const handleBackToLive = () => {
    setViewingRecordId(null)
  }

  const handleExportRecord = async (record: LoadTestRunRecord) => {
    try {
      await exportLoadTestRecord(record)
    } catch (e: any) {
      setError(typeof e === 'string' ? e : e?.message || 'Failed to export the result.')
    }
  }

  const handleExportRecordPdf = async (record: LoadTestRunRecord) => {
    try {
      await exportLoadTestRecordAsPdf(record)
    } catch (e: any) {
      setError(typeof e === 'string' ? e : e?.message || 'Failed to generate the PDF report.')
    }
  }

  const handleDeleteRecord = async (id: string) => {
    if (!item) return
    const updated = await deleteLoadTestHistoryRecord(item.id, id)
    setHistory(updated)
    if (viewingRecordId === id) setViewingRecordId(null)
  }

  const statusEntries = useMemo(() => {
    if (!latest) return []
    return Object.entries(latest.statusCodes).sort((a, b) => b[1] - a[1])
  }, [latest])

  const errorRatePct = useMemo(() => {
    if (!latest || latest.requestsTotal === 0) return 0
    return (latest.requestsFailed / latest.requestsTotal) * 100
  }, [latest])

  if (!item) return null

  const disabledInputs = running
  const totalStageSecs = stages.reduce((acc, s) => acc + (s.durationSecs || 0), 0)

  return (
    // modal={false}: com o padrão do Radix, o resto da tela fica inerte —
    // foco preso e cliques bloqueados —, e o painel do Claude ficava
    // inutilizável enquanto este modal estivesse aberto. Agora ele flutua
    // sobre o app sem desligá-lo.
    <Dialog open={open} modal={false} onOpenChange={o => { if (!o) handleClose() }}>
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
        className="bg-pm-bg border border-pm-border text-pm-text sm:max-w-3xl max-h-[85vh] p-0 flex flex-col overflow-hidden rounded-2xl gap-0"
      >
        {/* Header */}
        <div
          {...drag.handleProps}
          onDoubleClick={drag.reset}
          title="Drag to move — double-click to recenter"
          className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-pm-border select-none"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Gauge size={14} style={{ color: ACCENT }} className="shrink-0" />
            <DialogTitle className="text-sm font-semibold truncate text-pm-text">
              Load Test: {item.name}
            </DialogTitle>
          </div>
          <button
            onClick={handleClose}
            className="h-7 w-7 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        {requests.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-pm-text-muted py-16">
            <p className="text-xs">This item has no request to test.</p>
          </div>
        ) : (
          <>
            {/* Config */}
            <div className="px-4 py-3 border-b border-pm-border flex flex-col gap-2.5 shrink-0">
              {requests.length > 1 && (
                <span className="self-start text-[10px] text-pm-text-muted uppercase tracking-wide">
                  Flow · {requests.length} requests
                </span>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1 rounded-md border border-pm-border bg-pm-surface p-0.5">
                  {(['duration', 'iterations', 'ramp'] as LoadTestMode[]).map(m => (
                    <button
                      key={m}
                      type="button"
                      disabled={disabledInputs}
                      onClick={() => setMode(m)}
                      className={`h-6 px-2 rounded text-[11px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                        mode === m ? 'bg-[#097bed] text-white' : 'text-pm-text-muted hover:text-pm-text'
                      }`}
                    >
                      {m === 'duration' ? 'Duration' : m === 'iterations' ? 'Iterations/VU' : 'Ramp (stages)'}
                    </button>
                  ))}
                </div>

                {mode !== 'ramp' && (
                  <div className="flex items-center gap-1.5">
                    <label className="text-[11px] text-pm-text-muted">VUs</label>
                    <input
                      type="number"
                      min={1}
                      max={2000}
                      value={vus}
                      disabled={disabledInputs}
                      onChange={e => setVus(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))}
                      className="w-16 h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#097bed]/60 disabled:opacity-50"
                    />
                  </div>
                )}

                {mode === 'duration' && (
                  <div className="flex items-center gap-1.5">
                    <label className="text-[11px] text-pm-text-muted">Seconds</label>
                    <input
                      type="number"
                      min={1}
                      max={3600}
                      value={durationSecs}
                      disabled={disabledInputs}
                      onChange={e => setDurationSecs(Math.max(1, Math.min(3600, Number(e.target.value) || 1)))}
                      className="w-16 h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#097bed]/60 disabled:opacity-50"
                    />
                  </div>
                )}

                {mode === 'iterations' && (
                  <div className="flex items-center gap-1.5">
                    <label className="text-[11px] text-pm-text-muted">Iterations</label>
                    <input
                      type="number"
                      min={1}
                      max={100000}
                      value={iterationsPerVu}
                      disabled={disabledInputs}
                      onChange={e =>
                        setIterationsPerVu(Math.max(1, Math.min(100000, Number(e.target.value) || 1)))
                      }
                      className="w-20 h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#097bed]/60 disabled:opacity-50"
                    />
                  </div>
                )}

                <div className="flex items-center gap-1.5">
                  <label className="text-[11px] text-pm-text-muted">Environment</label>
                  <select
                    value={runEnvId ?? ''}
                    disabled={disabledInputs}
                    onChange={e => setRunEnvId(e.target.value || null)}
                    className="h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#097bed]/60 disabled:opacity-50 max-w-[160px]"
                  >
                    <option value="">No Environment</option>
                    {environments.map(env => (
                      <option key={env.id} value={env.id}>
                        {env.name}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={() => setShowThresholds(v => !v)}
                  className="flex items-center gap-1 h-7 px-2 rounded-md border border-pm-border bg-pm-surface text-[11px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                >
                  Thresholds {thresholds.length > 0 && `(${thresholds.length})`}
                  {showThresholds ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>

                <button
                  type="button"
                  onClick={() => setShowHistory(v => !v)}
                  className="flex items-center gap-1 h-7 px-2 rounded-md border border-pm-border bg-pm-surface text-[11px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                >
                  <History size={12} />
                  History {history.length > 0 && `(${history.length})`}
                  {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>

                <div className="ml-auto flex items-center gap-2">
                  {(currentRecord || viewingRecord) && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleExportRecord(viewingRecord ?? currentRecord!)}
                        title="Export result as JSON"
                        className="flex items-center gap-1.5 h-7 px-2 rounded-md border border-pm-border bg-pm-surface text-[11px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                      >
                        <Download size={12} /> JSON
                      </button>
                      <button
                        type="button"
                        onClick={() => handleExportRecordPdf(viewingRecord ?? currentRecord!)}
                        title="Export result as PDF report"
                        className="flex items-center gap-1.5 h-7 px-2 rounded-md border border-pm-border bg-pm-surface text-[11px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                      >
                        <FileText size={12} /> PDF
                      </button>
                    </>
                  )}
                  {running ? (
                    <button
                      onClick={handleStop}
                      className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-semibold bg-red-900/40 border border-red-800/60 text-red-300 hover:bg-red-900/60 transition-colors cursor-pointer"
                    >
                      <Square size={12} /> Stop
                    </button>
                  ) : (
                    <button
                      onClick={handleStart}
                      className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-semibold text-white transition-colors cursor-pointer"
                      style={{ backgroundColor: ACCENT }}
                    >
                      <Play size={12} /> Start
                    </button>
                  )}
                </div>
              </div>

              {/* History panel */}
              {showHistory && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-pm-border bg-pm-hover/30 p-2.5 max-h-56 overflow-y-auto">
                  <span className="text-[10px] text-pm-text-muted uppercase tracking-wide">
                    Past runs for this {requests.length > 1 ? 'flow' : 'request'}
                  </span>
                  {history.length === 0 ? (
                    <p className="text-[11px] text-pm-text-muted">No runs saved yet — completed tests show up here.</p>
                  ) : (
                    history.map(record => {
                      const allPassed = record.summary.thresholdResults.every(t => t.passed)
                      const hasThresholds = record.summary.thresholdResults.length > 0
                      const recordErrorRate =
                        record.summary.requestsTotal > 0
                          ? (record.summary.requestsFailed / record.summary.requestsTotal) * 100
                          : 0
                      return (
                        <div
                          key={record.id}
                          className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-[11px] ${
                            viewingRecordId === record.id
                              ? 'border-[#097bed]/50 bg-[#097bed]/10'
                              : 'border-pm-border bg-pm-surface'
                          }`}
                        >
                          {hasThresholds && (
                            <span className={allPassed ? 'text-[#4ff09d]' : 'text-[#ff7b7b]'}>
                              {allPassed ? <Check size={12} /> : <X size={12} />}
                            </span>
                          )}
                          <span className="text-pm-text-muted shrink-0">
                            {new Date(record.startedAt).toLocaleString()}
                          </span>
                          <span className="text-pm-text-muted">·</span>
                          <span className="text-pm-text-muted shrink-0">
                            {record.mode === 'ramp' ? 'ramp' : `${record.config.vus ?? '?'} VUs`}
                          </span>
                          <span className="text-pm-text-muted">·</span>
                          <span className="text-pm-text-secondary shrink-0">{record.summary.rpsAvg.toFixed(1)} rps</span>
                          <span className="text-pm-text-muted">·</span>
                          <span className="text-pm-text-secondary shrink-0">p95 {formatMs(record.summary.latencyP95Ms)}ms</span>
                          <span className={`shrink-0 ${recordErrorRate > 0 ? 'text-[#ff7b7b]' : 'text-pm-text-muted'}`}>
                            · {recordErrorRate.toFixed(1)}% err
                          </span>
                          <div className="ml-auto flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              title="View this run"
                              onClick={() => handleViewRecord(record.id)}
                              className="h-6 w-6 flex items-center justify-center rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
                            >
                              <Eye size={12} />
                            </button>
                            <button
                              type="button"
                              title="Export as JSON"
                              onClick={() => handleExportRecord(record)}
                              className="h-6 w-6 flex items-center justify-center rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
                            >
                              <Download size={12} />
                            </button>
                            <button
                              type="button"
                              title="Export as PDF report"
                              onClick={() => handleExportRecordPdf(record)}
                              className="h-6 w-6 flex items-center justify-center rounded text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
                            >
                              <FileText size={12} />
                            </button>
                            <button
                              type="button"
                              title="Delete"
                              onClick={() => handleDeleteRecord(record.id)}
                              className="h-6 w-6 flex items-center justify-center rounded text-pm-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              )}

              {/* Stage editor */}
              {mode === 'ramp' && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-pm-border bg-pm-hover/30 p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-pm-text-muted uppercase tracking-wide">
                      Stages · total {totalStageSecs}s
                    </span>
                  </div>
                  {stages.map((stage, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="text-[10px] text-pm-text-muted w-4 text-right">{idx + 1}</span>
                      <label className="text-[11px] text-pm-text-muted">Target VUs</label>
                      <input
                        type="number"
                        min={0}
                        max={2000}
                        value={stage.targetVus}
                        disabled={disabledInputs}
                        onChange={e =>
                          updateStage(idx, { targetVus: Math.max(0, Math.min(2000, Number(e.target.value) || 0)) })
                        }
                        className="w-16 h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#097bed]/60 disabled:opacity-50"
                      />
                      <label className="text-[11px] text-pm-text-muted">over</label>
                      <input
                        type="number"
                        min={0}
                        max={3600}
                        value={stage.durationSecs}
                        disabled={disabledInputs}
                        onChange={e =>
                          updateStage(idx, { durationSecs: Math.max(0, Math.min(3600, Number(e.target.value) || 0)) })
                        }
                        className="w-16 h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#097bed]/60 disabled:opacity-50"
                      />
                      <span className="text-[11px] text-pm-text-muted">s</span>
                      <button
                        type="button"
                        disabled={disabledInputs || stages.length <= 1}
                        onClick={() => removeStage(idx)}
                        className="ml-auto h-6 w-6 flex items-center justify-center rounded text-pm-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={disabledInputs}
                    onClick={addStage}
                    className="flex items-center gap-1 self-start h-6 px-2 rounded-md text-[11px] text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Plus size={11} /> Add stage
                  </button>
                </div>
              )}

              {/* Threshold editor */}
              {showThresholds && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-pm-border bg-pm-hover/30 p-2.5">
                  <span className="text-[10px] text-pm-text-muted uppercase tracking-wide">
                    Pass/fail thresholds (optional)
                  </span>
                  {thresholds.length === 0 && (
                    <p className="text-[11px] text-pm-text-muted">No thresholds configured — add one below.</p>
                  )}
                  {thresholds.map((t, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={t.metric}
                        disabled={disabledInputs}
                        onChange={e => updateThreshold(idx, { metric: e.target.value as LoadTestThreshold['metric'] })}
                        className="h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#097bed]/60 disabled:opacity-50"
                      >
                        {THRESHOLD_METRICS.map(m => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                      <select
                        value={t.operator}
                        disabled={disabledInputs}
                        onChange={e => updateThreshold(idx, { operator: e.target.value as LoadTestThreshold['operator'] })}
                        className="h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#097bed]/60 disabled:opacity-50"
                      >
                        {THRESHOLD_OPERATORS.map(op => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        value={t.value}
                        disabled={disabledInputs}
                        onChange={e => updateThreshold(idx, { value: Number(e.target.value) || 0 })}
                        className="w-20 h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#097bed]/60 disabled:opacity-50"
                      />
                      <span className="text-[11px] text-pm-text-muted">
                        {t.metric === 'errorRate' ? '%' : t.metric === 'rps' ? 'req/s' : 'ms'}
                      </span>
                      <button
                        type="button"
                        disabled={disabledInputs}
                        onClick={() => removeThreshold(idx)}
                        className="ml-auto h-6 w-6 flex items-center justify-center rounded text-pm-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={disabledInputs}
                    onClick={addThreshold}
                    className="flex items-center gap-1 self-start h-6 px-2 rounded-md text-[11px] text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Plus size={11} /> Add threshold
                  </button>
                </div>
              )}
            </div>

            {error && (
              <div className="px-4 py-2 border-b border-pm-border flex items-center gap-2 text-[11px] text-[#ff7b7b] bg-[#3d1a1a]/40 shrink-0">
                <AlertTriangle size={12} className="shrink-0" />
                <span className="truncate">{error}</span>
              </div>
            )}

            {/* Body */}
            <div className="flex-1 overflow-y-auto min-h-[200px] px-4 py-3">
              {!latest ? (
                <div className="h-full flex items-center justify-center text-pm-text-muted text-xs">
                  Configure and start the load test to see live metrics here.
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {viewingRecord && (
                    <div className="flex items-center gap-2 rounded-md border border-[#097bed]/40 bg-[#097bed]/10 px-2.5 py-1.5 text-[11px] text-pm-text-secondary">
                      <History size={12} className="shrink-0 text-[#097bed]" />
                      <span>Viewing run from {new Date(viewingRecord.startedAt).toLocaleString()}</span>
                      <button
                        type="button"
                        onClick={handleBackToLive}
                        className="ml-auto flex items-center gap-1 text-[#097bed] hover:underline cursor-pointer"
                      >
                        <ArrowLeft size={11} /> Back to live
                      </button>
                    </div>
                  )}

                  {/* Stat strip */}
                  <div className="grid grid-cols-4 gap-2">
                    <Stat label="Requests" value={latest.requestsTotal.toLocaleString()} />
                    <Stat label={isDone ? 'RPS (avg)' : 'RPS'} value={(isDone ? latest.rpsAvg : latest.rpsCurrent).toFixed(1)} />
                    <Stat
                      label="Error rate"
                      value={`${errorRatePct.toFixed(1)}%`}
                      warn={errorRatePct > 0}
                    />
                    <Stat label={isDone ? 'Status' : 'VUs active'} value={isDone ? 'Done' : String(latest.vusActive)} />
                  </div>

                  {latest.scriptErrors > 0 && (
                    <div className="flex items-center gap-1.5 text-[11px] text-[#e5c07b]">
                      <AlertTriangle size={12} className="shrink-0" />
                      {latest.scriptErrors} post-response script error{latest.scriptErrors === 1 ? '' : 's'} — correlation may be broken.
                    </div>
                  )}

                  {/* Thresholds */}
                  {latest.thresholdResults.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {latest.thresholdResults.map((t, i) => (
                        <span
                          key={i}
                          className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold tabular-nums ${
                            t.passed ? 'bg-[#0f3d2a] text-[#4ff09d]' : 'bg-[#3d1a1a] text-[#ff7b7b]'
                          }`}
                        >
                          {t.passed ? <Check size={10} /> : <X size={10} />}
                          {t.metric} {t.operator} {t.value}
                          <span className="text-pm-text-muted font-normal">(actual {formatMs(t.actual)})</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Charts — indisponíveis pra runs do histórico (só o resumo final é salvo) */}
                  {chartData.length > 1 && (
                    <div className={`grid gap-3 ${effectiveRanWithRamp ? 'grid-cols-3' : 'grid-cols-2'}`}>
                      <ChartBox title="RPS">
                        <LineChart data={chartData}>
                          <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" />
                          <XAxis dataKey="t" stroke="#666" fontSize={10} unit="s" />
                          <YAxis stroke="#666" fontSize={10} />
                          <Tooltip contentStyle={tooltipStyle} />
                          <Line type="monotone" dataKey="rps" stroke={ACCENT} dot={false} strokeWidth={1.5} />
                        </LineChart>
                      </ChartBox>

                      <ChartBox title="Latency (ms)">
                        <LineChart data={chartData}>
                          <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" />
                          <XAxis dataKey="t" stroke="#666" fontSize={10} unit="s" />
                          <YAxis stroke="#666" fontSize={10} />
                          <Tooltip contentStyle={tooltipStyle} />
                          <Line type="monotone" dataKey="avg" name="avg" stroke="#6bc46d" dot={false} strokeWidth={1.5} />
                          <Line type="monotone" dataKey="p95" name="p95" stroke="#e5c07b" dot={false} strokeWidth={1.5} />
                          <Line type="monotone" dataKey="p99" name="p99" stroke="#e06c75" dot={false} strokeWidth={1.5} />
                        </LineChart>
                      </ChartBox>

                      {effectiveRanWithRamp && (
                        <ChartBox title="VUs">
                          <LineChart data={chartData}>
                            <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" />
                            <XAxis dataKey="t" stroke="#666" fontSize={10} unit="s" />
                            <YAxis stroke="#666" fontSize={10} />
                            <Tooltip contentStyle={tooltipStyle} />
                            <Line type="monotone" dataKey="vus" stroke="#c586c0" dot={false} strokeWidth={1.5} />
                          </LineChart>
                        </ChartBox>
                      )}
                    </div>
                  )}

                  {/* Latency table */}
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                    <Metric label="min" value={formatMs(latest.latencyMinMs)} />
                    <Metric label="avg" value={formatMs(latest.latencyAvgMs)} />
                    <Metric label="p50" value={formatMs(latest.latencyP50Ms)} />
                    <Metric label="p90" value={formatMs(latest.latencyP90Ms)} />
                    <Metric label="p95" value={formatMs(latest.latencyP95Ms)} />
                    <Metric label="p99" value={formatMs(latest.latencyP99Ms)} />
                  </div>

                  {/* Status codes */}
                  {statusEntries.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {statusEntries.map(([code, count]) => (
                        <span
                          key={code}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums ${
                            code === 'error'
                              ? 'bg-[#3d1a1a] text-[#ff7b7b]'
                              : code.startsWith('2')
                              ? 'bg-[#0f3d2a] text-[#4ff09d]'
                              : 'bg-pm-hover text-pm-text-secondary'
                          }`}
                        >
                          {code}: {count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-pm-border bg-pm-hover/40 px-3 py-2">
      <div className="text-[10px] text-pm-text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${warn ? 'text-[#ff7b7b]' : 'text-pm-text'}`}>
        {value}
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-pm-border bg-pm-hover/30 px-2 py-1.5 text-center">
      <div className="text-[9px] text-pm-text-muted uppercase tracking-wide">{label}</div>
      <div className="text-[12px] font-semibold text-pm-text tabular-nums">{value} ms</div>
    </div>
  )
}

function ChartBox({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <div className="rounded-lg border border-pm-border bg-pm-hover/30 p-2">
      <div className="text-[10px] text-pm-text-muted uppercase tracking-wide mb-1 px-1">{title}</div>
      <div className="h-[140px]">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

const tooltipStyle: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #333',
  borderRadius: 8,
  fontSize: 11,
  color: '#ddd',
}
