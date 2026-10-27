'use client'

import { buildJUnitXml } from '@/lib/junitReport'
import { buildRunReport } from '@/lib/runReport'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, X, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronUp, Copy, Check, Terminal, Braces, Download, FileJson, History, Trash2, ArrowUpRight , Table2, Timer} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CollectionItem } from '@/app/types/CollectionItem'
import { useEnvironment } from '@/components/EnvironmentContext'
import { invoke } from '@tauri-apps/api/core'
import { flattenRequests, runCollectionRequest, RunEntry, REQUEST_CANCELLED } from './runCollectionRequest'
import { saveLastRun, loadLastRun, clearLastRun } from './runHistory'
import { safeSetItem, safeRemoveItem } from '@/lib/safeStorage'
import { useDraggableDialog } from '@/components/helper/useDraggableDialog'
import { VariableText } from './VariableText'
import { JsonBlock } from './JsonBlock'
import { requestHasBody } from '@/lib/defaultHeaders'
import { hasFailureReason, failureReason, isExpectedErrorStatus } from './runVerdict'
import { buildEnvMap } from '@/lib/envMap';
import { envForRow, parseDataFile, rowLabel, type DataSet } from '@/lib/runnerData'

interface Props {
  item: CollectionItem | null
  open: boolean
  onClose: () => void
}

const METHOD_COLORS: Record<string, string> = {
  GET: '#6BCB77',
  POST: '#F0883E',
  PUT: '#5BA4CF',
  DELETE: '#E06C75',
  PATCH: '#E5C07B',
}

interface RowVariable {
  key: string;
  /** Fase em que o passo gravou a variável; ausente = ele só leu. */
  phase?: 'pre-request' | 'post-response';
  /** Valor que o run gravou, quando gravou. */
  runValue?: string;
}

/**
 * Variáveis que a linha oferece para editar: as que o passo GRAVOU, primeiro,
 * seguidas das que ele apenas LEU.
 *
 * As gravadas vêm antes porque são as que costumam explicar a falha do passo
 * seguinte; as lidas importam porque a request que quebra por causa de um
 * valor errado raramente é a mesma que o produziu.
 */
function mergeRowVariables(entry: RunEntry): RowVariable[] {
  const out: RowVariable[] = []
  const seen = new Set<string>()

  for (const v of entry.outcome?.variablesSet ?? []) {
    if (seen.has(v.key)) continue
    seen.add(v.key)
    out.push({ key: v.key, phase: v.phase, runValue: v.value })
  }
  for (const key of entry.outcome?.usedVariables ?? []) {
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key })
  }
  return out
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Data do último run, curta — o ano só aparece quando não é o atual, porque
// a linha é estreita e "2026" não acrescenta nada no uso do dia a dia.
function formatRunTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: sameYear ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// A maioria das APIs devolve JSON numa linha só, que é ilegível numa caixa
// estreita. Formatar aqui evita ter que copiar a resposta pra outro lugar só
// pra conseguir lê-la.
function prettyBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return body
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    // Esperado: o snippet é cortado em 2000 caracteres, então um corpo grande
    // chega com o JSON pela metade. Mostrar o texto cru é melhor que esconder
    // a resposta porque ela não pôde ser formatada.
    return body
  }
}

// Preferências do Runner que valem entre sessões. localStorage, e não o
// store em arquivo: são bytes, e lê-las é síncrono na abertura do painel —
// esperar I/O pra decidir qual environment mostrar piscaria a tela.
const ENV_KEY = 'devflow_runner_env'
const DELAYS_KEY = 'devflow_runner_delays:'

function loadRunnerEnvId(): string | null {
  try {
    return localStorage.getItem(ENV_KEY)
  } catch {
    return null
  }
}

function loadStepDelays(collectionId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(DELAYS_KEY + collectionId)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    // Entrada a entrada: o conteúdo pode ser de uma versão anterior, e um
    // valor estranho aqui vira uma espera infinita no meio do run.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0
      )
    )
  } catch {
    return {}
  }
}

export function CollectionRunnerPanel({ item, open, onClose }: Props) {
  const { environments, selectedEnvId, patchEnvironmentVariables } = useEnvironment()

  const requests = useMemo(() => (item ? flattenRequests(item.item ?? []) : []), [item])

  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [iterations, setIterations] = useState(1)

  // Tabela de dados: cada linha é uma iteração com suas variáveis.
  // Nasceu de um padrão real — cinco sessões "BPE bloqueio pagamento …"
  // apontando para as MESMAS cinco requests, duplicadas só pra variar um
  // campo (ver lib/runnerData.ts).
  const [dataSet, setDataSet] = useState<DataSet | null>(null)
  const [dataFileName, setDataFileName] = useState('')
  const [dataError, setDataError] = useState<string | null>(null)
  const [delayMs, setDelayMs] = useState(0)
  const [runEnvId, setRunEnvId] = useState<string | null>(null)

  // Espera por passo, sobrepondo a global. Guardada por collection: "esperar
  // 3s depois do Checkout" é propriedade DAQUELE fluxo, e ter que redigitar
  // a cada abertura é o que faria ninguém usar.
  const [stepDelays, setStepDelays] = useState<Record<string, number>>({})

  // Só grava depois que o painel carregou o que estava guardado. Sem isso, o
  // primeiro render (com os defaults vazios) sobrescreveria o que havia.
  const hydratedRef = useRef(false)

  const setStepDelay = (requestId: string, value: number) =>
    setStepDelays(prev => ({ ...prev, [requestId]: value }))

  const clearStepDelay = (requestId: string) =>
    setStepDelays(prev =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => id !== requestId))
    )
  const [entries, setEntries] = useState<RunEntry[]>([])
  const [running, setRunning] = useState(false)
  const stopRef = useRef(false)
  // Id do envio em andamento — o Stop manda o Rust interromper ele.
  const currentRequestIdRef = useRef<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [copiedBodyId, setCopiedBodyId] = useState<string | null>(null)
  const [copiedReport, setCopiedReport] = useState(false)
  // Quando preenchido, o que está na tela veio do armazenamento, não desta
  // sessão — o painel precisa dizer isso, senão um resultado de ontem passa
  // por recém-executado.
  const [restoredAt, setRestoredAt] = useState<string | null>(null)
  const [restoredTruncated, setRestoredTruncated] = useState(false)
  // Quando e contra qual environment o run que está na tela rodou — vai pro
  // export. Guardado à parte porque o seletor de environment pode ter mudado
  // depois do run.
  const [runMeta, setRunMeta] = useState<{ startedAt?: string; finishedAt?: string; environmentName?: string }>({})
  const drag = useDraggableDialog()

  // ── Edição das variáveis que o run gravou ──────────────────────────────
  //
  // O caso: o fluxo falhou por causa de um valor que um script extraiu
  // (recordLocator, quoteNumber...). Antes era preciso abrir o painel de
  // Environment, achar a variável no meio das outras e voltar — com o Runner
  // mostrando exatamente quais foram, editar aqui tira o caminho inteiro.
  //
  // O rascunho é por linha (`entryId:key`), e não por key: a mesma variável
  // pode aparecer em vários passos, e um rascunho global faria o que você
  // digita num deles aparecer nos outros.
  const [varDrafts, setVarDrafts] = useState<Record<string, string | undefined>>({})
  const [savedVarKey, setSavedVarKey] = useState<string | null>(null)

  const setVarDraft = (draftKey: string, value: string | undefined) => {
    setVarDrafts(prev => ({ ...prev, [draftKey]: value }))
  }

  const currentEnvValue = (key: string): string | undefined =>
    environments.find(e => e.id === runEnvId)?.values.find(v => v.key === key && v.enabled)?.value

  // Gravação direta de uma variável, sem passar por rascunho — usada pelos
  // chips da URL e do payload, que já têm o próprio campo de edição.
  const commitVariable = (key: string, value: string) => {
    if (!runEnvId) return
    patchEnvironmentVariables(runEnvId, { [key]: currentEnvValue(key) ?? '' }, { [key]: value })
  }

  const commitVarDraft = (draftKey: string, key: string) => {
    const draft = varDrafts[draftKey]
    if (draft === undefined) return
    const current = currentEnvValue(key)
    // Sai do rascunho de qualquer forma: mantê-lo faria a caixa parar de
    // acompanhar o environment depois de um run novo.
    setVarDraft(draftKey, undefined)
    if (draft === current || !runEnvId) return

    // patchEnvironmentVariables (e não um setEnvironments direto) porque é ele
    // que respeita a entrada HABILITADA quando a key tem duplicatas — a mesma
    // regra que o resto do app usa.
    patchEnvironmentVariables(runEnvId, { [key]: current ?? '' }, { [key]: draft })
    setSavedVarKey(draftKey)
    setTimeout(() => setSavedVarKey(prev => (prev === draftKey ? null : prev)), 1200)
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const copyReason = async (entry: RunEntry) => {
    try {
      await navigator.clipboard.writeText(failureReason(entry))
      setCopiedId(entry.id)
      setTimeout(() => setCopiedId(prev => (prev === entry.id ? null : prev)), 1200)
    } catch (e) { console.log('Copy failure reason error:', e) }
  }

  const copyBody = async (entry: RunEntry) => {
    try {
      // Mesmo corpo que a tela mostra — copiar o snippet enquanto o painel
      // exibe o completo entregaria menos do que está à vista.
      await navigator.clipboard.writeText(
        entry.outcome?.fullResponseBody || entry.outcome?.responseBodySnippet || ''
      )
      setCopiedBodyId(entry.id)
      setTimeout(() => setCopiedBodyId(prev => (prev === entry.id ? null : prev)), 1200)
    } catch (e) { console.log('Copy response body error:', e) }
  }

  const discardLastRun = () => {
    if (item) clearLastRun(item.id)
    setEntries([])
    setRestoredAt(null)
    setRestoredTruncated(false)
    setRunMeta({})
  }

  useEffect(() => {
    if (!open) return
    setChecked(Object.fromEntries(requests.map(r => [r.id, true])))
    setRunning(false)
    stopRef.current = false

    // Último environment escolhido AQUI, não o selecionado no app: quem roda
    // a collection costuma rodar sempre contra o mesmo ambiente, e não é
    // necessariamente aquele em que se está editando request.
    //
    // Cai no do app quando o guardado não existe mais (environment apagado,
    // ou puxado de outra máquina) — senão o Runner abriria apontando pra um
    // id morto, que resolve variável nenhuma.
    const remembered = loadRunnerEnvId()
    setRunEnvId(
      remembered && environments.some(e => e.id === remembered)
        ? remembered
        : selectedEnvId ?? null
    )

    setStepDelays(item ? loadStepDelays(item.id) : {})
    hydratedRef.current = true

    // Limpa antes de buscar: a leitura virou assíncrona (arquivo, não
    // localStorage), e sem isto o run da collection ANTERIOR ficaria na tela
    // durante o instante da busca.
    setEntries([])
    setRestoredAt(null)
    setRestoredTruncated(false)
    setRunMeta({})

    // Restaura o último run em vez de deixar a tela vazia: um fluxo de 12
    // requests encadeadas leva meio minuto, e antes fechar o painel sem
    // copiar o relatório significava ter que rodar tudo de novo pra reler
    // um corpo.
    //
    // `cancelled` evita a corrida de abrir, fechar e abrir outra collection
    // antes da primeira leitura terminar.
    let cancelled = false
    if (item) {
      loadLastRun(item.id)
        .then(stored => {
          if (cancelled || !stored) return
          setEntries(stored.entries)
          setRestoredAt(stored.finishedAt)
          setRestoredTruncated(!!stored.truncated)
          setRunMeta({
            startedAt: stored.startedAt,
            finishedAt: stored.finishedAt,
            environmentName: stored.environmentName,
          })
        })
        .catch(e => console.log('Could not restore the last run:', e))
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id])

  // Fechar o painel invalida a hidratação: na próxima abertura tudo é lido
  // de novo, e até lá nada pode gravar por cima.
  useEffect(() => {
    if (!open) hydratedRef.current = false
  }, [open])

  useEffect(() => {
    if (!open || !hydratedRef.current) return
    if (runEnvId) safeSetItem(ENV_KEY, runEnvId)
    else safeRemoveItem(ENV_KEY)
  }, [open, runEnvId])

  useEffect(() => {
    if (!open || !hydratedRef.current || !item) return
    const key = DELAYS_KEY + item.id
    // Sem nenhuma espera própria a chave sai do storage em vez de guardar
    // "{}" por collection aberta — a cota é compartilhada com o histórico de
    // respostas e os rascunhos de aba.
    if (Object.keys(stepDelays).length === 0) safeRemoveItem(key)
    else safeSetItem(key, JSON.stringify(stepDelays))
  }, [open, item, stepDelays])

  const selectedCount = useMemo(
    () => requests.filter(r => checked[r.id]).length,
    [requests, checked]
  )

  const toggleAll = (value: boolean) => {
    setChecked(Object.fromEntries(requests.map(r => [r.id, value])))
  }

  const handlePickDataFile = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Data file', extensions: ['csv', 'json', 'tsv', 'txt'] }],
    })
    if (typeof picked !== 'string') return

    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    let text: string
    try {
      text = await readTextFile(picked)
    } catch (e) {
      setDataError(`Could not read the file: ${(e as Error).message}`)
      return
    }

    const name = picked.split(/[\\/]/).pop() ?? picked
    const parsed = parseDataFile(text, name)
    if (!parsed.ok) {
      setDataSet(null)
      setDataFileName(name)
      setDataError(parsed.error)
      return
    }

    setDataSet(parsed.data)
    setDataFileName(name)
    setDataError(null)
  }

  const clearDataFile = () => {
    setDataSet(null)
    setDataFileName('')
    setDataError(null)
  }

  const handleRun = async () => {
    const selected = requests.filter(r => checked[r.id])
    if (selected.length === 0) return

    const envId = runEnvId
    const baseEnv = environments.find(e => e.id === envId)
    // buildEnvMap, e não um Object.fromEntries local: ele descarta as
    // duplicatas desabilitadas (ver DuplicateVariablePicker) e, quando há mais
    // de uma habilitada, fica com a MESMA entrada em que a escrita mexe. O
    // Runner tem que resolver variável igual ao resto do app.
    const baseEnvMap: Record<string, string> = buildEnvMap(baseEnv?.values)
    let envMap: Record<string, string> = baseEnvMap

    // Com tabela, a quantidade de iterações é o número de linhas: cada uma é
    // um caso, e inventar um número à parte só criaria combinação sem
    // sentido ("3 iterações sobre 5 linhas").
    const rows = dataSet?.rows ?? null
    const totalIterations = rows ? rows.length : iterations

    const runEntries: RunEntry[] = []
    for (let i = 1; i <= totalIterations; i++) {
      const label = rows ? rowLabel(rows[i - 1], dataSet!.columns, i - 1) : undefined
      for (const req of selected) {
        runEntries.push({
          id: `${req.id}-${i}`,
          itemId: req.id,
          iteration: i,
          rowLabel: label,
          name: req.name,
          method: req.method,
          state: 'pending',
        })
      }
    }

    const runStartedAt = new Date().toISOString()
    const environmentName = baseEnv?.name
    setEntries(runEntries)
    setRunning(true)
    setRestoredAt(null)
    setRestoredTruncated(false)
    setRunMeta({ startedAt: runStartedAt, environmentName })
    stopRef.current = false

    // O estado final precisa ser montado aqui, em paralelo: as atualizações de
    // tela usam `setEntries(prev => ...)`, cujo resultado só existe depois do
    // próximo render — tarde demais pra gravar quando o laço termina.
    const finalized = new Map<string, RunEntry>()

    for (let idx = 0; idx < runEntries.length; idx++) {
      if (stopRef.current) break
      const entry = runEntries[idx]
      setEntries(prev => prev.map(e => (e.id === entry.id ? { ...e, state: 'running' } : e)))

      const reqItem = selected.find(r => r.id === entry.itemId)!

      // Primeira request da linha: o ambiente recomeça da base, com a linha
      // por cima. Sem isso o que a linha 1 gravou via script vazaria pra
      // linha 2, e o resultado passaria a depender da ordem — um caso
      // passando por causa do anterior é pior que um caso falhando.
      if (rows && (idx === 0 || runEntries[idx - 1].iteration !== entry.iteration)) {
        envMap = envForRow(baseEnvMap, rows[entry.iteration - 1])
      }

      const envBefore = envMap
      const requestId = crypto.randomUUID()
      currentRequestIdRef.current = requestId
      const startedAt = new Date().toISOString()
      const outcome = await runCollectionRequest(reqItem, envMap, { requestId })
      const finishedAt = new Date().toISOString()
      currentRequestIdRef.current = null

      // Interrompida pelo Stop: registra como cancelada e não aplica nada
      // dela no environment (nem o que o pre-request gravou).
      if (stopRef.current && outcome.status === 'error' && outcome.errorMessage === REQUEST_CANCELLED) {
        const cancelled: RunEntry = {
          ...entry,
          state: 'error',
          startedAt,
          finishedAt,
          outcome: { ...outcome, errorMessage: 'Cancelled (Stop)' },
        }
        finalized.set(entry.id, cancelled)
        setEntries(prev => prev.map(e => (e.id === entry.id ? cancelled : e)))
        break
      }

      envMap = outcome.envAfter

      const done: RunEntry = { ...entry, state: outcome.status, outcome, startedAt, finishedAt }
      finalized.set(entry.id, done)
      setEntries(prev => prev.map(e => (e.id === entry.id ? done : e)))

      if (envId) patchEnvironmentVariables(envId, envBefore, envMap)

      // A espera do passo manda na global quando existe — inclusive quando
      // é 0, que é como se diz "nesta aqui não espera".
      const wait = stepDelays[entry.itemId] ?? delayMs
      if (wait > 0 && idx < runEntries.length - 1 && !stopRef.current) {
        await new Promise(res => setTimeout(res, wait))
      }
    }

    setRunning(false)
    const runFinishedAt = new Date().toISOString()
    setRunMeta({ startedAt: runStartedAt, finishedAt: runFinishedAt, environmentName })

    // Guarda as linhas que não chegaram a rodar (um Stop no meio) com o estado
    // 'pending' que tinham: sem isso o placar ao reabrir viraria "10/10" e o
    // run interrompido pareceria completo.
    if (item) {
      saveLastRun({
        collectionId: item.id,
        collectionName: item.name,
        finishedAt: runFinishedAt,
        startedAt: runStartedAt,
        environmentName,
        entries: runEntries.map(e => finalized.get(e.id) ?? e),
      })
    }
  }

  const handleStop = () => {
    stopRef.current = true
    // Interrompe também a request que está no ar (antes ela ia até o fim e o
    // resultado ainda era aplicado ao environment).
    const requestId = currentRequestIdRef.current
    if (requestId) invoke('cancel_http_request', { requestId }).catch(() => {})
  }

  const summary = useMemo(() => {
    const done = entries.filter(e => e.state === 'success' || e.state === 'error')
    // Antes só contava state === 'error' (falha de transporte/rede) — deixava
    // de fora requests que responderam com 4xx/5xx ou cujo script quebrou,
    // que na prática também são "falhas" pro usuário.
    const failedRequests = done.filter(hasFailureReason).length
    const testsTotal = done.reduce((acc, e) => acc + (e.outcome?.tests.length ?? 0), 0)
    const testsPassed = done.reduce(
      (acc, e) => acc + (e.outcome?.tests.filter(t => t.passed).length ?? 0),
      0
    )
    return { done: done.length, total: entries.length, failedRequests, testsTotal, testsPassed }
  }, [entries])

  const failedEntries = useMemo(() => entries.filter(hasFailureReason), [entries])

  // Num run restaurado o campo Iterations mostra o valor atual (1), mas as
  // linhas podem vir de um run de 3 — usar o campo apagaria os rótulos "#2"
  // e "#3" e deixaria as repetições indistinguíveis. O que vale é o que as
  // linhas dizem.
  const shownIterations = useMemo(
    () => entries.reduce((max, e) => Math.max(max, e.iteration), 1),
    [entries]
  )

  const copyFailureReport = async () => {
    const report = failedEntries
      .map(e => {
        const suffix = e.rowLabel ? ` [${e.rowLabel}]` : shownIterations > 1 ? ` (#${e.iteration})` : ''
        const label = `${e.method ?? ''} ${e.name}${suffix}`.trim()
        return `${label}\n${failureReason(e)}`
      })
      .join('\n\n---\n\n')
    try {
      await navigator.clipboard.writeText(report)
      setCopiedReport(true)
      setTimeout(() => setCopiedReport(false), 1500)
    } catch (e) { console.log('Copy failure report error:', e) }
  }

  const exportRun = async () => {
    const report = buildRunReport({
      collectionName: item?.name ?? 'Collection run',
      environmentName: runMeta.environmentName,
      startedAt: runMeta.startedAt,
      finishedAt: runMeta.finishedAt,
      entries,
      isFailure: hasFailureReason,
      failureReason: e => failureReason(e),
    })
    // Data e hora no nome: exports do mesmo fluxo se acumulam na pasta, e
    // sem isso um sobrescreveria o outro.
    const stamp = (report.startedAt ?? report.exportedAt).slice(0, 19).replace(/[:T]/g, '-')
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const { writeTextFile } = await import('@tauri-apps/plugin-fs')
      const filePath = await save({
        title: 'Export run',
        defaultPath: `${(item?.name ?? 'run').replace(/[\\/:*?"<>|]/g, '-')}.run-${stamp}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (filePath) await writeTextFile(filePath, JSON.stringify(report, null, 2))
    } catch (e) { console.log('Run export error:', e) }
  }

  if (!item) return null

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
        className="bg-pm-bg border border-pm-border text-pm-text sm:max-w-2xl max-h-[85vh] p-0 flex flex-col overflow-hidden rounded-2xl gap-0"
      >
        {/* Header — também a alça de arrastar: um run longo costuma precisar
            ficar visível junto da request que está sendo depurada. */}
        <div
          {...drag.handleProps}
          onDoubleClick={drag.reset}
          title="Drag to move — double-click to recenter"
          className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-pm-border select-none"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Play size={14} className="text-[#f26b3a] shrink-0" />
            <DialogTitle className="text-sm font-semibold truncate text-pm-text">
              Run: {item.name}
            </DialogTitle>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        {requests.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-pm-text-muted py-16">
            <p className="text-xs">This folder has no requests.</p>
          </div>
        ) : (
          <>
            {/* Config */}
            <div className="px-4 py-3 border-b border-pm-border flex flex-wrap items-center gap-3 shrink-0">
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-pm-text-muted">Iterations</label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={dataSet ? dataSet.rows.length : iterations}
                  // Com tabela, quem manda é o número de linhas: cada uma é um
                  // caso, e um número à parte criaria combinação sem sentido.
                  disabled={running || !!dataSet}
                  title={dataSet ? 'One iteration per row of the data file' : undefined}
                  onChange={e => setIterations(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  className="w-14 h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#f26b3a]/60 disabled:opacity-50"
                />
              </div>

              {/* Tabela de dados: um caso por linha, em vez de duplicar o
                  fluxo inteiro pra variar um campo. */}
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-pm-text-muted">Data</label>
                {dataSet ? (
                  <div className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-pm-surface border border-pm-border">
                    <Table2 size={12} className="text-[#4ff09d] shrink-0" />
                    <span className="text-[11px] text-pm-text max-w-[150px] truncate" title={dataFileName}>
                      {dataFileName}
                    </span>
                    <span className="text-[10px] text-pm-text-muted shrink-0">
                      {dataSet.rows.length} row{dataSet.rows.length === 1 ? '' : 's'} ·{' '}
                      {dataSet.columns.length} col{dataSet.columns.length === 1 ? '' : 's'}
                    </span>
                    <button
                      onClick={clearDataFile}
                      disabled={running}
                      title="Remove the data file"
                      className="shrink-0 text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer border-none bg-transparent disabled:opacity-40"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handlePickDataFile}
                    disabled={running}
                    title="Run the flow once per row of a CSV or JSON file — each column becomes a variable"
                    className="flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-pm-surface border border-pm-border text-[11px] text-pm-text-secondary hover:text-pm-text hover:border-[#f26b3a]/60 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Table2 size={12} />
                    Choose file
                  </button>
                )}
              </div>

              {dataError && (
                <span className="text-[10.5px] text-rose-400 max-w-[260px]" title={dataError}>
                  {dataError}
                </span>
              )}

              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-pm-text-muted">Delay (ms)</label>
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={delayMs}
                  disabled={running}
                  onChange={e => setDelayMs(Math.max(0, Number(e.target.value) || 0))}
                  className="w-16 h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#f26b3a]/60 disabled:opacity-50"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-pm-text-muted">Environment</label>
                <select
                  value={runEnvId ?? ''}
                  disabled={running}
                  onChange={e => setRunEnvId(e.target.value || null)}
                  className="h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#f26b3a]/60 disabled:opacity-50 max-w-[160px]"
                >
                  <option value="">No Environment</option>
                  {environments.map(env => (
                    <option key={env.id} value={env.id}>
                      {env.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="ml-auto flex items-center gap-2">
                {running ? (
                  <button
                    onClick={handleStop}
                    className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-semibold bg-red-900/40 border border-red-800/60 text-red-300 hover:bg-red-900/60 transition-colors cursor-pointer"
                  >
                    <Square size={12} /> Stop
                  </button>
                ) : (
                  <button
                    onClick={handleRun}
                    disabled={selectedCount === 0}
                    className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-semibold bg-[#f26b3a] text-white hover:bg-[#f26b3a]/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Play size={12} /> Run
                  </button>
                )}
              </div>
            </div>

            {/* Um resultado restaurado é indistinguível de um recém-executado
                olhando só as linhas; sem esta faixa, um run de ontem passa por
                run de agora. */}
            {restoredAt && !running && (
              <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-pm-border bg-pm-hover/40 text-[11px] text-pm-text-muted">
                <History size={11} className="shrink-0" />
                <span className="truncate">
                  Last run · {formatRunTime(restoredAt)}
                  {restoredTruncated && (
                    <span className="text-amber-400/90"> · too large to store in full, some rows were dropped</span>
                  )}
                </span>
                <button
                  onClick={discardLastRun}
                  title="Discard this stored result"
                  className="ml-auto flex items-center gap-1 shrink-0 hover:text-pm-text transition-colors cursor-pointer"
                >
                  <Trash2 size={11} /> Discard
                </button>
              </div>
            )}

            {/* Checklist ou resultados */}
            <div className="flex-1 overflow-y-auto min-h-[200px]">
              {entries.length === 0 ? (
                <div className="p-2">
                  <label className="flex items-center gap-2 text-[11px] text-pm-text-muted cursor-pointer px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={selectedCount === requests.length}
                      onChange={e => toggleAll(e.target.checked)}
                      className="accent-[#f26b3a]"
                    />
                    {selectedCount}/{requests.length} selected
                  </label>

                  {requests.map(req => {
                    const stepDelay = stepDelays[req.id]
                    return (
                      // div, e não label na linha inteira: o campo de delay
                      // mora aqui dentro, e dentro de um label clicar nele
                      // alternaria o checkbox.
                      <div
                        key={req.id}
                        className="group flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-pm-hover"
                      >
                        <label className="flex min-w-0 flex-1 items-center gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!checked[req.id]}
                            onChange={e => setChecked(prev => ({ ...prev, [req.id]: e.target.checked }))}
                            className="accent-[#f26b3a]"
                          />
                          <span
                            className="text-[10px] font-bold w-10 text-right shrink-0"
                            style={{ color: METHOD_COLORS[req.method ?? ''] ?? '#888' }}
                          >
                            {req.method}
                          </span>
                          <span className="text-xs text-pm-text-secondary truncate">{req.name}</span>
                        </label>

                        {/* Espera DEPOIS desta request, no lugar da global.
                            É por passo porque o motivo é por passo: um
                            Checkout que precisa de 3s pro pedido assentar
                            não justifica 3s entre todas as 19. */}
                        {stepDelay === undefined ? (
                          <button
                            onClick={() => setStepDelay(req.id, delayMs > 0 ? delayMs : 1000)}
                            title="Wait a specific time after this request"
                            className="flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-pm-bg group-hover:opacity-100 cursor-pointer"
                          >
                            <Timer size={13} className="text-pm-text-muted" />
                          </button>
                        ) : (
                          <span
                            className="flex shrink-0 items-center gap-1 rounded border border-pm-border bg-pm-bg pl-1.5 text-[10px] text-pm-text-muted"
                            title="Wait after this request, instead of the run delay"
                          >
                            <Timer size={11} className="shrink-0 text-[#f26b3a]" />
                            <input
                              type="number"
                              min={0}
                              step={100}
                              value={stepDelay}
                              onChange={e => setStepDelay(req.id, Math.max(0, Number(e.target.value) || 0))}
                              className="w-12 bg-transparent py-0.5 text-right text-[11px] tabular-nums text-pm-text outline-none"
                            />
                            <span className="pr-1">ms</span>
                            <button
                              onClick={() => clearStepDelay(req.id)}
                              title="Use the run delay for this request"
                              className="flex size-5 items-center justify-center rounded-r text-pm-text-muted hover:bg-pm-hover hover:text-pm-text cursor-pointer"
                            >
                              <X size={11} />
                            </button>
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="flex flex-col gap-1 p-2">
                  {entries.map(entry => {
                    const tests = entry.outcome?.tests ?? []
                    const testsPassed = tests.filter(t => t.passed).length
                    const failed = hasFailureReason(entry)
                    const scriptLogs = entry.outcome?.logs ?? []
                    const variablesSet = entry.outcome?.variablesSet ?? []
                    // Não é só falha que pode expandir — uma request de sucesso
                    // com console.log(...) ou pm.environment.set(...) nos
                    // scripts também precisa dar pra abrir e ver o que foi
                    // logado/atribuído, sem precisar do Console global (que
                    // mistura tudo de todas as requests do app) ou abrir o
                    // painel de Environment pra conferir o valor.
                    // Teste falhando também abre a linha: sem isso dava pra ver "2/3" e não ter
                    // como descobrir qual asserção quebrou.
                    const hasFailedTest = tests.some(t => !t.passed)
                    // O corpo da resposta abre a linha mesmo numa request que
                    // deu 200 e passou em tudo: ver o que a API devolveu é
                    // metade do motivo de rodar o fluxo.
                    // fullResponseBody primeiro: o snippet é um recorte de 2000
                    // caracteres feito pro texto da falha, não pra leitura. Um
                    // run restaurado pode só ter o snippet (ver runHistory).
                    const responseBody = entry.outcome?.fullResponseBody || entry.outcome?.responseBodySnippet
                    const shownBytes = responseBody ? new TextEncoder().encode(responseBody).length : 0
                    const totalBytes = entry.outcome?.responseSize
                    const bodyTruncated = totalBytes !== undefined && totalBytes > shownBytes
                    // 4xx/5xx que as asserções declararam esperado — passa,
                    // mas não é um 200 e a linha não deve fingir que é.
                    const expectedError = isExpectedErrorStatus(entry)
                    const sentHeaderEntries = Object.entries(entry.outcome?.sentHeaders ?? {})
                    // O texto cru vem da collection, não do histórico do run:
                    // guardá-lo duplicaria o que já está na árvore, e é a
                    // árvore que a edição altera.
                    const source = requests.find(r => r.id === entry.itemId)
                    const rawUrl = source?.request?.url ?? ''
                    const rawBody = requestHasBody(source?.request?.bodyType, source?.request?.body)
                      ? source?.request?.body ?? ''
                      : ''
                    // Variáveis desta linha: as que o passo gravou mais as que
                    // ele leu. Sem as lidas, a request que FALHA por causa de
                    // um valor errado não oferecia onde corrigi-lo — só a que
                    // o tinha gravado, passos antes.
                    const editableVars = mergeRowVariables(entry)
                    const canExpand =
                      failed || hasFailedTest || tests.length > 0 || scriptLogs.length > 0 ||
                      editableVars.length > 0 || !!responseBody?.trim() || !!entry.outcome?.resolvedUrl
                    const isExpanded = expandedIds.has(entry.id)
                    return (
                      <div
                        key={entry.id}
                        className={`rounded-md border ${
                          failed ? 'bg-[#2a1414]/40 border-red-900/40' : 'bg-pm-hover/50 border-pm-border/70'
                        }`}
                      >
                        <div
                          className={`flex items-center gap-2.5 px-2.5 py-2 ${canExpand ? 'cursor-pointer' : ''}`}
                          onClick={() => canExpand && toggleExpanded(entry.id)}
                        >
                          {entry.state === 'pending' && (
                            <div className="w-3.5 h-3.5 rounded-full border border-pm-border shrink-0" />
                          )}
                          {entry.state === 'running' && (
                            <Loader2 size={14} className="animate-spin text-[#097bed] shrink-0" />
                          )}
                          {entry.state === 'success' && !failed && (
                            <CheckCircle2 size={14} className="text-[#4ff09d] shrink-0" />
                          )}
                          {(entry.state === 'error' || (entry.state === 'success' && failed)) && (
                            <XCircle size={14} className="text-[#ff7b7b] shrink-0" />
                          )}

                          <span
                            className="text-[10px] font-bold w-10 text-right shrink-0"
                            style={{ color: METHOD_COLORS[entry.method ?? ''] ?? '#888' }}
                          >
                            {entry.method}
                          </span>

                          <span className="text-xs text-pm-text-secondary truncate flex-1">
                            {entry.name}
                            {/* O nome do cenário diz mais que "#3" — é o
                                que a primeira coluna da tabela traz. */}
                            {entry.rowLabel ? (
                              <span className="text-[#4ff09d]/80"> · {entry.rowLabel}</span>
                            ) : (
                              shownIterations > 1 && <span className="text-pm-text-muted"> · #{entry.iteration}</span>
                            )}
                          </span>

                          {entry.outcome?.status === 'success' && (
                            <span
                              // Âmbar, nem verde nem vermelho: o 4xx era o
                              // resultado pretendido, mas esconder que houve um
                              // 4xx tornaria o fluxo negativo indistinguível de
                              // um caminho feliz na hora de ler o relatório.
                              title={expectedError ? 'Error status asserted by this request’s tests' : undefined}
                              className={`text-[11px] font-semibold tabular-nums ${
                                expectedError
                                  ? 'text-amber-400'
                                  : entry.outcome.httpStatus && entry.outcome.httpStatus < 300
                                    ? 'text-[#4ff09d]'
                                    : 'text-[#ff7b7b]'
                              }`}
                            >
                              {entry.outcome.httpStatus}
                            </span>
                          )}
                          {entry.outcome?.status === 'error' && (
                            <span className="text-[11px] text-[#ff7b7b] truncate max-w-[160px]">
                              {entry.outcome.errorMessage}
                            </span>
                          )}
                          {entry.outcome && (
                            <span className="text-[11px] text-pm-text-muted tabular-nums">
                              {entry.outcome.responseTime}ms
                            </span>
                          )}
                          {tests.length > 0 && (
                            <span
                              className={`px-1.5 py-0 rounded text-[10px] font-bold tabular-nums ${
                                testsPassed === tests.length
                                  ? 'bg-[#0f3d2a] text-[#4ff09d]'
                                  : 'bg-[#3d1a1a] text-[#ff7b7b]'
                              }`}
                            >
                              {testsPassed}/{tests.length}
                            </span>
                          )}
                          {entry.outcome?.scriptError && (
                            <span className="px-1.5 py-0 rounded text-[10px] font-bold bg-[#3d1a1a] text-[#ff7b7b] shrink-0">
                              script error
                            </span>
                          )}
                          {scriptLogs.length > 0 && (
                            <span
                              title={`${scriptLogs.length} console log${scriptLogs.length === 1 ? '' : 's'} from this request's scripts`}
                              className="flex items-center gap-0.5 px-1.5 py-0 rounded text-[10px] font-bold tabular-nums bg-pm-hover text-pm-text-muted shrink-0"
                            >
                              <Terminal size={10} />
                              {scriptLogs.length}
                            </span>
                          )}
                          {variablesSet.length > 0 && (
                            <span
                              title={`${variablesSet.length} variable${variablesSet.length === 1 ? '' : 's'} set by this request's scripts`}
                              className="flex items-center gap-0.5 px-1.5 py-0 rounded text-[10px] font-bold tabular-nums bg-[#0f2e3d] text-[#63b3ed] shrink-0"
                            >
                              <Braces size={10} />
                              {variablesSet.length}
                            </span>
                          )}
                          {canExpand && (
                            <span className="shrink-0 text-pm-text-muted">
                              {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                            </span>
                          )}
                        </div>

                        {canExpand && isExpanded && (
                          <div className="px-2.5 pb-2.5 pt-0.5 flex flex-col gap-2">
                            {/* Antes a linha só mostrava "2/3": dava pra ver que
                                algo falhou, mas não QUAL asserção — justamente
                                o que se precisa saber. */}
                            {tests.length > 0 && (
                              <div className="rounded-md border border-pm-border bg-pm-hover/60 p-2 flex flex-col gap-1">
                                {tests.map((t, i) => (
                                  <div key={i} className="flex items-start gap-1.5 text-[11px]">
                                    <span className={`mt-px shrink-0 font-bold ${t.passed ? 'text-[#4ff09d]' : 'text-[#ff7b7b]'}`}>
                                      {t.passed ? '✓' : '✗'}
                                    </span>
                                    <div className="min-w-0">
                                      <span className={t.passed ? 'text-pm-text-secondary' : 'text-pm-text'}>{t.name}</span>
                                      {!t.passed && t.message && (
                                        <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[10.5px] text-red-300/80">
                                          {t.message}
                                        </pre>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}

                            {failed && (
                              <div className="rounded-md border border-pm-border bg-pm-hover p-2 flex flex-col gap-1.5">
                                {/* Sem o corpo: ele aparece logo abaixo, na
                                    seção Response. O texto copiado continua
                                    trazendo tudo, porque lá não há tela junto. */}
                                <pre className="whitespace-pre-wrap break-words text-[11px] font-mono text-red-300/90 max-h-64 overflow-y-auto">
                                  {failureReason(entry, false)}
                                </pre>
                                <button
                                  onClick={e => { e.stopPropagation(); copyReason(entry) }}
                                  className="self-start flex items-center gap-1 text-[10px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                                >
                                  {copiedId === entry.id ? <Check size={11} className="text-[#4ff09d]" /> : <Copy size={11} />}
                                  {copiedId === entry.id ? 'Copied' : 'Copy reason'}
                                </button>
                              </div>
                            )}

                            {/* O que foi ENVIADO. Quando a resposta vem errada,
                                a primeira pergunta é o que entrou — e antes
                                isso só dava pra reconstruir abrindo a request
                                e resolvendo as variáveis de cabeça. */}
                            {/* URL e payload em blocos separados, e com o
                                texto CRU: ver {{variavel}} é o que permite
                                corrigir o valor errado ali mesmo — resolvida,
                                a URL não diz de onde cada pedaço veio. */}
                            {(rawUrl || entry.outcome?.resolvedUrl) && (
                              <div className="rounded-md border border-pm-border bg-pm-hover p-2 flex flex-col gap-1.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="flex items-center gap-1 text-[10px] font-semibold text-pm-text-muted uppercase tracking-wide">
                                    <ArrowUpRight size={10} /> URL
                                  </span>
                                  <span
                                    className="text-[10px] font-bold"
                                    style={{ color: METHOD_COLORS[entry.outcome?.sentMethod ?? entry.method ?? ''] ?? '#888' }}
                                  >
                                    {entry.outcome?.sentMethod ?? entry.method}
                                  </span>
                                </div>

                                {rawUrl ? (
                                  <VariableText text={rawUrl} valueOf={currentEnvValue} onCommit={commitVariable} />
                                ) : (
                                  // Request apagada depois do run: sem o texto
                                  // cru sobra a URL resolvida, sem chips.
                                  <span className="font-mono text-[10.5px] text-pm-text-secondary break-all">
                                    {entry.outcome?.resolvedUrl}
                                  </span>
                                )}

                                {!!entry.outcome?.resolvedUrl && rawUrl && rawUrl !== entry.outcome.resolvedUrl && (
                                  <span className="font-mono text-[10px] text-pm-text-muted/70 break-all">
                                    → {entry.outcome.resolvedUrl}
                                  </span>
                                )}
                              </div>
                            )}

                            {(rawBody?.trim() || entry.outcome?.sentBody?.trim()) && (
                              <div className="rounded-md border border-pm-border bg-pm-hover p-2 flex flex-col gap-1.5">
                                <span className="flex items-center gap-1 text-[10px] font-semibold text-pm-text-muted uppercase tracking-wide">
                                  <ArrowUpRight size={10} /> Payload
                                </span>
                                {rawBody?.trim() ? (
                                  // Texto CRU, não o formatado: é o que está
                                  // guardado na request, e reformatar aqui
                                  // mostraria um payload diferente do que o
                                  // editor de Body mostra.
                                  <JsonBlock
                                    value={rawBody}
                                    maxHeight={224}
                                    variableValue={currentEnvValue}
                                    onCommitVariable={commitVariable}
                                  />
                                ) : (
                                  // Request apagada depois do run: sobra o que
                                  // foi enviado, já resolvido — sem variável
                                  // para clicar.
                                  <JsonBlock value={prettyBody(entry.outcome!.sentBody!)} maxHeight={224} />
                                )}
                              </div>
                            )}

                            {!!sentHeaderEntries.length && (
                              <details className="rounded-md border border-pm-border bg-pm-hover p-2">
                                <summary className="cursor-pointer text-[10px] font-semibold text-pm-text-muted uppercase tracking-wide">
                                  {sentHeaderEntries.length} header{sentHeaderEntries.length === 1 ? '' : 's'} sent
                                </summary>
                                <div className="mt-1.5 flex flex-col gap-0.5 max-h-40 overflow-y-auto">
                                  {sentHeaderEntries.map(([key, value]) => (
                                    <div key={key} className="flex items-start gap-1.5 font-mono text-[10px]">
                                      <span className="text-[#63b3ed] shrink-0">{key}:</span>
                                      <span className="text-pm-text-muted break-all">{value}</span>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}

                            {!!responseBody?.trim() && (
                              <div className="rounded-md border border-pm-border bg-pm-hover p-2 flex flex-col gap-1">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className="flex items-center gap-1 text-[10px] font-semibold text-pm-text-muted uppercase tracking-wide">
                                    <FileJson size={10} /> Response
                                  </span>
                                  {entry.outcome?.responseSize !== undefined && (
                                    <span className="text-[10px] text-pm-text-muted/70 tabular-nums">
                                      {formatBytes(entry.outcome.responseSize)}
                                    </span>
                                  )}
                                  <button
                                    onClick={e => { e.stopPropagation(); copyBody(entry) }}
                                    className="ml-auto flex items-center gap-1 text-[10px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                                  >
                                    {copiedBodyId === entry.id ? <Check size={11} className="text-[#4ff09d]" /> : <Copy size={11} />}
                                    {copiedBodyId === entry.id ? 'Copied' : 'Copy'}
                                  </button>
                                </div>
                                <JsonBlock value={prettyBody(responseBody)} maxHeight={288} />
                                {/* Só quando é recorte de verdade, e dizendo
                                    quanto ficou de fora: o aviso fixo de "2000
                                    caracteres" aparecia até em resposta inteira. */}
                                {bodyTruncated && (
                                  <span className="text-[10px] text-pm-text-muted/70">
                                    Showing {formatBytes(shownBytes)} of {formatBytes(totalBytes!)}.
                                  </span>
                                )}
                              </div>
                            )}

                            {editableVars.length > 0 && (
                              <div className="rounded-md border border-pm-border bg-pm-hover p-2 flex flex-col gap-1">
                                <span className="flex items-center gap-1 text-[10px] font-semibold text-pm-text-muted uppercase tracking-wide mb-0.5">
                                  <Braces size={10} /> Variables
                                </span>
                                <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                                  {editableVars.map((v, i) => {
                                    const draftKey = `${entry.id}:${v.key}`
                                    // O que está na caixa: o rascunho, se
                                    // houver, senão o valor que o environment
                                    // tem AGORA — que pode já não ser o que o
                                    // script gravou naquele run.
                                    const live = currentEnvValue(v.key)
                                    const shown = varDrafts[draftKey] ?? live ?? v.runValue ?? ''
                                    // Só compara quando o passo gravou algo: numa
                                    // variável que ele apenas leu não há 'antes'
                                    // deste run pra divergir.
                                    const changed = v.runValue !== undefined && (live ?? v.runValue) !== v.runValue
                                    return (
                                      <div key={i} className="flex items-start gap-1.5 text-[11px] font-mono">
                                        <span
                                          className="text-pm-text-muted/70 shrink-0 pt-1"
                                          title={v.phase ? 'Set by this request' : 'Read by this request'}
                                        >
                                          [{v.phase ? (v.phase === 'pre-request' ? 'pre' : 'post') : 'in'}]
                                        </span>
                                        <span className="text-[#63b3ed] shrink-0 pt-1">{v.key}:</span>
                                        <input
                                          value={shown}
                                          onChange={e => setVarDraft(draftKey, e.target.value)}
                                          onBlur={() => commitVarDraft(draftKey, v.key)}
                                          onKeyDown={e => {
                                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                            // Esc devolve o valor vigente em vez
                                            // de fechar o modal: dentro de um
                                            // campo, desfazer é o que se espera.
                                            //
                                            // stopImmediatePropagation no evento
                                            // NATIVO: o Radix escuta keydown no
                                            // document, e o stopPropagation do
                                            // React só interrompe a propagação
                                            // sintética — o modal fecharia
                                            // mesmo assim.
                                            if (e.key === 'Escape') {
                                              e.nativeEvent.stopImmediatePropagation()
                                              setVarDraft(draftKey, undefined)
                                            }
                                          }}
                                          onClick={e => e.stopPropagation()}
                                          spellCheck={false}
                                          title={
                                            changed
                                              ? `This run set: ${v.runValue}`
                                              : 'Edit to change the environment variable, then Run again'
                                          }
                                          className={`flex-1 min-w-0 rounded border bg-pm-bg px-1.5 py-0.5 font-mono text-[11px] outline-none ${
                                            savedVarKey === draftKey
                                              ? 'border-[#4ff09d]/60 text-[#4ff09d]'
                                              : changed
                                                ? 'border-amber-500/50 text-pm-text'
                                                : 'border-pm-border text-pm-text-secondary focus:border-[#f26b3a]/60'
                                          }`}
                                        />
                                      </div>
                                    )
                                  })}
                                </div>
                                <span className="text-[10px] text-pm-text-muted/70">
                                  Editing writes to &ldquo;{environments.find(e => e.id === runEnvId)?.name ?? 'the environment'}&rdquo; — the next run picks it up.
                                </span>
                              </div>
                            )}

                            {scriptLogs.length > 0 && (
                              <div className="rounded-md border border-pm-border bg-pm-hover p-2 flex flex-col gap-1">
                                <span className="flex items-center gap-1 text-[10px] font-semibold text-pm-text-muted uppercase tracking-wide mb-0.5">
                                  <Terminal size={10} /> Console
                                </span>
                                <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                                  {scriptLogs.map((log, i) => (
                                    <div key={i} className="flex items-start gap-1.5 text-[11px] font-mono">
                                      <span className="text-pm-text-muted/70 shrink-0">
                                        [{log.phase === 'pre-request' ? 'pre' : 'post'}]
                                      </span>
                                      <span
                                        className={`whitespace-pre-wrap break-words ${
                                          log.level === 'error'
                                            ? 'text-red-300'
                                            : log.level === 'warn'
                                              ? 'text-amber-300'
                                              : log.level === 'info'
                                                ? 'text-[#63b3ed]'
                                                : 'text-pm-text-secondary'
                                        }`}
                                      >
                                        {log.message}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Summary footer */}
            {entries.length > 0 && (
              <div className="h-11 shrink-0 flex items-center justify-between px-4 border-t border-pm-border text-[11px] text-pm-text-muted">
                <span>
                  {summary.done}/{summary.total} requests
                  {summary.failedRequests > 0 && (
                    <span className="text-[#ff7b7b]"> · {summary.failedRequests} failed</span>
                  )}
                  {summary.testsTotal > 0 && (
                    <span>
                      {' '}
                      · tests {summary.testsPassed}/{summary.testsTotal}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-3">
                  {!running && summary.done > 0 && (
                    <button
                      onClick={exportRun}
                      title="Export the whole flow as JSON — each step with request, response, tests, variables and when it ran"
                      className="flex items-center gap-1 text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                    >
                      <Download size={11} />
                      Export
                    </button>
                  )}
                  {!running && summary.done > 0 && (
                    <button
                      onClick={async () => {
                        const xml = buildJUnitXml({
                          suiteName: item?.name ?? 'Collection run',
                          requests: entries
                            .filter(e => e.outcome)
                            .map(e => ({
                              name: e.name,
                              method: e.method,
                              iteration: e.iteration,
                              durationMs: e.outcome!.responseTime,
                              tests: e.outcome!.tests,
                              failure: hasFailureReason(e) ? failureReason(e) : undefined,
                              httpStatus: e.outcome!.httpStatus,
                              resolvedUrl: e.outcome!.resolvedUrl,
                            })),
                        })
                        try {
                          const { save } = await import('@tauri-apps/plugin-dialog')
                          const { writeTextFile } = await import('@tauri-apps/plugin-fs')
                          const filePath = await save({
                            title: 'Export JUnit report',
                            defaultPath: `${(item?.name ?? 'run').replace(/[\\/:*?"<>|]/g, '-')}.junit.xml`,
                            filters: [{ name: 'JUnit XML', extensions: ['xml'] }],
                          })
                          if (filePath) await writeTextFile(filePath, xml)
                        } catch (e) { console.log('JUnit export error:', e) }
                      }}
                      title="Export the run as JUnit XML — the format CI tools read natively"
                      className="flex items-center gap-1 text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                    >
                      <Download size={11} />
                      JUnit
                    </button>
                  )}
                  {!running && summary.failedRequests > 0 && (
                    <button
                      onClick={copyFailureReport}
                      className="flex items-center gap-1 text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                    >
                      {copiedReport ? <Check size={11} className="text-[#4ff09d]" /> : <Copy size={11} />}
                      {copiedReport ? 'Copied' : `Copy ${summary.failedRequests} failure${summary.failedRequests === 1 ? '' : 's'}`}
                    </button>
                  )}
                  {!running && (
                    <button
                      onClick={() => { setEntries([]); setRestoredAt(null); setRestoredTruncated(false); setRunMeta({}) }}
                      className="text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                    >
                      Run again
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
