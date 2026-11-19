'use client'

import { buildJUnitXml } from '@/lib/junitReport'
import { buildRunReport } from '@/lib/runReport'
import { acceptTestExpectation } from '@/lib/acceptTestExpectation'
import { toast } from 'sonner'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, Square, X, CheckCircle2, XCircle, ChevronDown, ChevronUp, Copy, Check, Terminal, Braces, Download, FileJson, History, Trash2, ArrowUpRight , Table2, Timer, RotateCw, BadgeCheck, ExternalLink, Sparkles, WandSparkles, Undo2, Pencil } from 'lucide-react'
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
import { CodeEditor } from '@/components/CodeEditor'
import { requestHasBody } from '@/lib/defaultHeaders'
import { hasFailureReason, failureReason, isExpectedErrorStatus } from './runVerdict'
import { buildEnvMap } from '@/lib/envMap';
import { envForRow, parseDataFile, rowLabel, type DataSet } from '@/lib/runnerData'
import {
  applyEnvChanges,
  effectiveBodyOverride,
  isBodyEdited,
  prettyBodyPreservingTemplates,
} from './payloadOverride'

// Spinner neutro do Runner: um anel girando, sem o ícone do app (o
// DevFlowSpinner traz a marca no meio e parecia o logo na lista de requests).
function RunSpinner({ size }: { size: number }) {
  return (
    <span
      role="status"
      aria-label="Running"
      className="inline-block shrink-0 rounded-full border-[1.5px] border-pm-border border-t-pm-text-muted animate-spin"
      style={{ width: size, height: size }}
    />
  )
}

interface Props {
  item: CollectionItem | null
  open: boolean
  onClose: () => void
  onUpdateRequestScript?: (requestId: string, phase: 'preRequest' | 'postResponse', value: string) => void
  // Usado pelo popover de variável da URL (VariableText) pra trocar um token
  // {{var}} por outro direto dali — "switch to variable list" do popover
  // original. Mesma ideia do onUpdateRequestScript: o Runner só tem o id.
  onUpdateRequestUrl?: (requestId: string, url: string) => void
  // Abre um texto (o script OU a resposta desta linha, cada um com seu
  // próprio botão) numa janela de editor separada, maior — o Runner só
  // manda o conteúdo; quem sabe abrir janela é o AppLayout.
  onOpenTextInNewWindow?: (content: string, title: string, lang?: 'json' | 'javascript') => void
  // Mesma ideia, mas pro painel do Claude: manda a pergunta já pronta (sem
  // enviar sozinho) — quem decide abrir o painel/mandar é o AppLayout.
  onAskAiAboutScript?: (prompt: string) => void
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
  /** true = o passo APAGOU a variável (pm.environment.unset). */
  removed?: boolean;
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
    out.push({ key: v.key, phase: v.phase, runValue: v.value, removed: v.removed })
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

// O body cru (template) do passo, quando a request manda body — é o que o
// bloco Payload mostra e o que o rascunho editado substitui.
function rawBodyOf(item: CollectionItem | undefined): string {
  const req = item?.request
  return requestHasBody(req?.bodyType, req?.body) ? req?.body ?? '' : ''
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

export function CollectionRunnerPanel({
  item, open, onClose, onUpdateRequestScript, onUpdateRequestUrl,
  onOpenTextInNewWindow, onAskAiAboutScript,
}: Props) {
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

  // ── Pause/Resume ────────────────────────────────────────────────────────
  //
  // Diferente do Stop, o Pause não cancela a request em andamento — ela
  // termina normalmente, e o laço só não começa a próxima. Tudo que o laço
  // precisa pra continuar de onde parou (as entries da iteração atual, o
  // environment já atualizado pelas requests anteriores, a seleção de
  // linhas/requests congelada no momento do Run) fica neste ref: variáveis
  // locais de handleRun somem quando a função retorna no Pause, então não
  // dá pra confiar nelas pro Resume continuar depois.
  const [paused, setPaused] = useState(false)
  const pauseRef = useRef(false)
  // Estado (não ref): o rótulo "Paused · X/Y" lê este valor durante o render,
  // e refs não podem ser lidas aí (ver react-hooks/refs).
  const [pausedAtIndex, setPausedAtIndex] = useState(0)
  const runContextRef = useRef<{
    runEntries: RunEntry[];
    selected: CollectionItem[];
    envId: string | null;
    baseEnvMap: Record<string, string>;
    rows: Record<string, string>[] | null;
    environmentName: string | undefined;
    runStartedAt: string;
    envMap: Record<string, string>;
    finalized: Map<string, RunEntry>;
  } | null>(null)
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

  // Qual fase (Pre-request/Post-response) a seção Scripts mostra, por linha
  // — igual ao rascunho de variável acima, tem que ser por `entry.id`
  // porque várias linhas podem estar expandidas ao mesmo tempo.
  const [scriptTabByEntry, setScriptTabByEntry] = useState<Record<string, 'preRequest' | 'postResponse'>>({})
  // Payload entra CRU por padrão (ver o comentário no bloco de Payload) e
  // Response entra bonito por padrão (prettyBody já roda sempre) — o botão
  // de cada um inverte só o próprio lado, por isso dois mapas separados.
  const [payloadPrettyIds, setPayloadPrettyIds] = useState<Set<string>>(new Set())
  const [responseRawIds, setResponseRawIds] = useState<Set<string>>(new Set())

  // ── Payload editado só nesta execução ────────────────────────────────────
  //
  // Rascunho do body por REQUEST (itemId), em TEMPLATE — ver payloadOverride.ts
  // para a decisão sobre {{variaveis}}. Nunca vai para a collection: a request
  // salva continua igual. Vale para tudo que roda neste painel — Send, Run
  // from here, Run / Run again e todas as iterações — até Reset, Discard ou
  // fechar o painel.
  //
  // Por request, e não por linha: antes era por entry.id e o Run again
  // descartava o rascunho, então "editar o payload e rodar de novo" saía com
  // o body antigo; e a edição feita na iteração #1 não valia na #2.
  // O ref existe porque o laço de runFrom é uma closure longa: editar outra
  // request enquanto o run anda tem que valer quando o laço chegar nela.
  const [bodyDrafts, setBodyDrafts] = useState<Record<string, string>>({})
  const bodyDraftsRef = useRef(bodyDrafts)
  useEffect(() => {
    bodyDraftsRef.current = bodyDrafts
  }, [bodyDrafts])
  // Linha rodando sozinha (reexecução de um passo), fora do laço do run.
  const [stepRunningId, setStepRunningId] = useState<string | null>(null)
  const busy = running || stepRunningId !== null

  const setBodyDraft = (itemId: string, value: string | undefined) =>
    setBodyDrafts(prev => {
      const next = { ...prev }
      if (value === undefined) delete next[itemId]
      else next[itemId] = value
      return next
    })

  const bodyOverrideFor = (reqItem: CollectionItem): string | undefined =>
    effectiveBodyOverride(rawBodyOf(reqItem), bodyDraftsRef.current[reqItem.id])

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
    setPaused(false)
    pauseRef.current = false
    runContextRef.current = null
    setBodyDrafts({})
  }

  useEffect(() => {
    if (!open) return
    setChecked(Object.fromEntries(requests.map(r => [r.id, true])))
    setRunning(false)
    stopRef.current = false
    setPaused(false)
    pauseRef.current = false
    runContextRef.current = null

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
    // Payload editado vale só para a execução que estava na tela.
    setBodyDrafts({})
    setStepRunningId(null)

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

  // Fecha o run: marca como não-rodando/não-pausado, grava o relatório com o
  // que já tinha rodado (as pendentes ficam 'pending' — ver o comentário mais
  // abaixo) e limpa o runMeta com o horário final. Chamado tanto pelo fim
  // natural/Stop do laço em `runFrom` quanto pelo Stop enquanto PAUSADO, caso
  // em que não há laço nenhum rodando pra chegar nesse ponto sozinho.
  const finishRun = () => {
    const ctx = runContextRef.current
    if (!ctx) return
    setRunning(false)
    setPaused(false)
    const runFinishedAt = new Date().toISOString()
    setRunMeta({ startedAt: ctx.runStartedAt, finishedAt: runFinishedAt, environmentName: ctx.environmentName })

    // Guarda as linhas que não chegaram a rodar (Pause ou Stop no meio) com o
    // estado 'pending' que tinham: sem isso o placar ao reabrir viraria
    // "10/10" e o run interrompido pareceria completo.
    if (item) {
      saveLastRun({
        collectionId: item.id,
        collectionName: item.name,
        finishedAt: runFinishedAt,
        startedAt: ctx.runStartedAt,
        environmentName: ctx.environmentName,
        entries: ctx.runEntries.map(e => ctx.finalized.get(e.id) ?? e),
      })
    }
  }

  // Continua o laço do run a partir de `startIdx` — usado tanto pelo Run
  // (sempre com startIdx 0, logo depois de montar runContextRef) quanto pelo
  // Resume (com o índice onde o Pause parou). O contexto todo vem do ref
  // porque, no Pause, esta função RETORNA — as variáveis locais de uma
  // chamada anterior já teriam sumido quando o Resume precisar delas.
  const runFrom = async (startIdx: number) => {
    const ctx = runContextRef.current
    if (!ctx) return
    const { runEntries, selected, envId, baseEnvMap, rows, finalized } = ctx
    let envMap = ctx.envMap

    setRunning(true)
    setPaused(false)

    for (let idx = startIdx; idx < runEntries.length; idx++) {
      if (stopRef.current) break

      // Pause: a request anterior já terminou e teve seu resultado aplicado
      // normalmente — só não deixa esta próxima começar. Guarda o ponto
      // exato (índice + environment já atualizado) pro Resume continuar daqui.
      if (pauseRef.current) {
        ctx.envMap = envMap
        setPausedAtIndex(idx)
        setRunning(false)
        setPaused(true)

        // Grava o que já rodou até aqui (igual ao finishRun) MESMO pausado:
        // sem isso, o get_last_run do MCP não via nada deste run enquanto
        // pausado e voltava com o último run SALVO de outra collection —
        // quem perguntasse "analise o teste que está na tela" recebia o
        // resultado de um teste diferente.
        if (item) {
          saveLastRun({
            collectionId: item.id,
            collectionName: item.name,
            finishedAt: new Date().toISOString(),
            startedAt: ctx.runStartedAt,
            environmentName: ctx.environmentName,
            entries: ctx.runEntries.map(e => ctx.finalized.get(e.id) ?? e),
          })
        }
        return
      }

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
      // Payload editado no Runner vale também no "Run from here": é o
      // caminho natural de quem mudou o body e quer ver o efeito dali pra frente.
      const outcome = await runCollectionRequest(reqItem, envMap, {
        requestId,
        bodyOverride: bodyOverrideFor(reqItem),
      })
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

    finishRun()
  }

  const handleRun = async () => {
    if (busy) return
    const selected = requests.filter(r => checked[r.id])
    if (selected.length === 0) return

    // O payload editado NÃO é descartado aqui: "editar e rodar de novo" é o
    // uso principal (antes o Run again limpava o rascunho e mandava o body
    // antigo). A linha mostra "edited" e o Reset volta ao salvo.

    const envId = runEnvId
    const baseEnv = environments.find(e => e.id === envId)
    // buildEnvMap, e não um Object.fromEntries local: ele descarta as
    // duplicatas desabilitadas (ver DuplicateVariablePicker) e, quando há mais
    // de uma habilitada, fica com a MESMA entrada em que a escrita mexe. O
    // Runner tem que resolver variável igual ao resto do app.
    const baseEnvMap: Record<string, string> = buildEnvMap(baseEnv?.values)

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

    runContextRef.current = {
      runEntries,
      selected,
      envId,
      baseEnvMap,
      rows,
      environmentName,
      runStartedAt,
      envMap: baseEnvMap,
      finalized: new Map(),
    }

    setEntries(runEntries)
    setRestoredAt(null)
    setRestoredTruncated(false)
    setRunMeta({ startedAt: runStartedAt, environmentName })
    stopRef.current = false
    pauseRef.current = false

    await runFrom(0)
  }

  const handlePause = () => {
    pauseRef.current = true
  }

  const handleResume = async () => {
    if (busy) return
    stopRef.current = false
    pauseRef.current = false
    // Variável editada enquanto pausado ("Editing writes to … — the next run
    // picks it up") tem que valer no Resume. Antes ele seguia do environment
    // copiado no Run, e a edição só pegava num run novo. O environment atual
    // já tem tudo o que os passos rodados gravaram (cada passo grava nele),
    // então relê-lo não perde nada; a linha de dados vai por cima, como no Run.
    //
    // Sem environment escolhido não há onde a edição tenha ido — e o que os
    // passos gravaram só existe no contexto do run: aí não relê nada. A base
    // das PRÓXIMAS linhas de dados (ctx.baseEnvMap) fica a do Run: trocá-la
    // pelo atual levaria o que a linha 1 gravou pra linha 2.
    const ctx = runContextRef.current
    const env = ctx?.envId ? environments.find(e => e.id === ctx.envId) : undefined
    if (ctx && env) {
      const current = buildEnvMap(env.values)
      const next = ctx.runEntries[pausedAtIndex]
      const row = ctx.rows && next ? ctx.rows[next.iteration - 1] : undefined
      ctx.envMap = row ? envForRow(current, row) : current
    }
    await runFrom(pausedAtIndex)
  }

  // Diferente do Resume (que só continua de onde o Pause parou), este deixa
  // escolher QUALQUER linha já exibida — um run inteiro, um pausado ou um
  // interrompido — e refaz dali pra frente. As linhas ANTES do ponto
  // escolhido ficam como estavam (não são refeitas); o environment de
  // partida é o ATUAL (buildEnvMap), não um reconstruído: é o que essas
  // linhas mantidas já gravaram de verdade, mais qualquer ajuste manual
  // feito nesse meio tempo pelo painel de Environment.
  const handleRunFrom = async (entryId: string) => {
    if (busy) return
    const startIdx = entries.findIndex(e => e.id === entryId)
    if (startIdx === -1) return

    const envId = runEnvId
    const baseEnv = environments.find(e => e.id === envId)
    const baseEnvMap: Record<string, string> = buildEnvMap(baseEnv?.values)
    const environmentName = baseEnv?.name
    const runStartedAt = new Date().toISOString()
    const rows = dataSet?.rows ?? null

    // Mantém o resultado de quem já rodou antes do ponto escolhido; dali pra
    // frente volta a 'pending' — é o que vai ser refeito agora.
    const runEntries: RunEntry[] = entries.map((e, idx) =>
      idx < startIdx
        ? e
        : { id: e.id, itemId: e.itemId, iteration: e.iteration, rowLabel: e.rowLabel, name: e.name, method: e.method, state: 'pending' }
    )

    const finalized = new Map<string, RunEntry>()
    for (let i = 0; i < startIdx; i++) finalized.set(runEntries[i].id, runEntries[i])

    // Reentrar no meio de uma linha de dados (tabela): a primeira request
    // dessa linha já teria aplicado a sobreposição da linha por cima do
    // environment base — sem isso, o laço só faz essa troca na PRIMEIRA
    // request da linha (ver runFrom), e reentrar depois dela deixaria a
    // sobreposição de fora.
    const startEntry = runEntries[startIdx]
    const startEnvMap = rows ? envForRow(baseEnvMap, rows[startEntry.iteration - 1]) : baseEnvMap

    runContextRef.current = {
      runEntries,
      selected: requests,
      envId,
      baseEnvMap,
      rows,
      environmentName,
      runStartedAt,
      envMap: startEnvMap,
      finalized,
    }

    setEntries(runEntries)
    setRestoredAt(null)
    setRestoredTruncated(false)
    setRunMeta({ startedAt: runStartedAt, environmentName })
    stopRef.current = false
    pauseRef.current = false

    await runFrom(startIdx)
  }

  // Reexecuta SÓ esta linha — com o payload editado, quando houver — e deixa
  // as outras como estão. O environment de partida é o atual (o mesmo
  // raciocínio do handleRunFrom): já tem o token e o que os passos anteriores
  // gravaram. Os scripts do passo rodam como num run normal, e o que eles
  // gravarem vai pro environment do mesmo jeito.
  const handleRunStep = async (entryId: string) => {
    if (busy) return
    const entry = entries.find(e => e.id === entryId)
    const reqItem = entry && requests.find(r => r.id === entry.itemId)
    if (!entry || !reqItem) return

    const envId = runEnvId
    const baseEnv = environments.find(e => e.id === envId)
    const baseEnvMap: Record<string, string> = buildEnvMap(baseEnv?.values)
    const row = dataSet?.rows?.[entry.iteration - 1]
    const envMap = row ? envForRow(baseEnvMap, row) : baseEnvMap

    setStepRunningId(entryId)
    setEntries(prev => prev.map(e => (e.id === entryId ? { ...e, state: 'running' } : e)))

    const startedAt = new Date().toISOString()
    let outcome: Awaited<ReturnType<typeof runCollectionRequest>>
    try {
      outcome = await runCollectionRequest(reqItem, envMap, {
        bodyOverride: bodyOverrideFor(reqItem),
      })
    } catch (e) {
      // runCollectionRequest já transforma falha em outcome de erro; isto é
      // só pra linha não ficar girando para sempre se algo escapar.
      outcome = {
        itemId: reqItem.id, status: 'error', responseTime: 0, tests: [],
        errorMessage: String((e as Error)?.message ?? e), envAfter: envMap, logs: [], variablesSet: [],
      }
    } finally {
      setStepRunningId(null)
    }
    const finishedAt = new Date().toISOString()

    const done: RunEntry = { ...entry, state: outcome.status, outcome, startedAt, finishedAt }
    setEntries(prev => prev.map(e => (e.id === entryId ? done : e)))
    if (envId) patchEnvironmentVariables(envId, envMap, outcome.envAfter)

    // Run pausado: o Resume continua do contexto guardado, que precisa ver
    // este resultado e o que o passo gravou (ex.: um token novo).
    const ctx = runContextRef.current
    if (ctx) {
      if (ctx.runEntries.some(e => e.id === entryId)) ctx.finalized.set(entryId, done)
      ctx.envMap = applyEnvChanges(ctx.envMap, envMap, outcome.envAfter)
    }

    if (item) {
      saveLastRun({
        collectionId: item.id,
        collectionName: item.name,
        finishedAt,
        startedAt: runMeta.startedAt ?? startedAt,
        environmentName: runMeta.environmentName ?? baseEnv?.name,
        entries: entries.map(e => (e.id === entryId ? done : e)),
      })
    }
  }

  const handleStop = () => {
    stopRef.current = true
    pauseRef.current = false

    // Pausado não tem nenhum laço do runFrom rodando pra notar o stopRef e
    // fechar o run sozinho — fecha aqui mesmo, com o que já tinha rodado.
    if (paused) {
      finishRun()
      return
    }

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
        // O DialogContent base vem com "ring-1 ring-foreground/10" do preset
        // shadcn importado em globals.css — sem token "pm-*" próprio, esse
        // "foreground" cai no cinza quase branco do tema shadcn padrão,
        // sobrando como um halo claro em volta do painel escuro. ring-0
        // cancela isso (border-pm-border já dá o contorno certo).
        className="bg-pm-bg border border-pm-border ring-0 text-pm-text sm:max-w-2xl max-h-[85vh] p-0 flex flex-col overflow-hidden rounded-lg gap-0"
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
                  disabled={running || paused || !!dataSet}
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
                      disabled={running || paused}
                      title="Remove the data file"
                      className="shrink-0 text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer border-none bg-transparent disabled:opacity-40"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handlePickDataFile}
                    disabled={running || paused}
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
                  disabled={running || paused}
                  onChange={e => setDelayMs(Math.max(0, Number(e.target.value) || 0))}
                  className="w-16 h-7 px-2 rounded-md bg-pm-surface border border-pm-border text-xs text-pm-text outline-none focus:border-[#f26b3a]/60 disabled:opacity-50"
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-pm-text-muted">Environment</label>
                <select
                  value={runEnvId ?? ''}
                  disabled={running || paused}
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
                {running && (
                  <>
                    <button
                      onClick={handlePause}
                      title="Finish the request in flight, then hold — Resume picks up from the next one"
                      className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-semibold bg-pm-surface border border-pm-border text-pm-text-secondary hover:text-pm-text hover:border-[#f26b3a]/60 transition-colors cursor-pointer"
                    >
                      <Pause size={12} /> Pause
                    </button>
                    <button
                      onClick={handleStop}
                      className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-semibold bg-red-900/40 border border-red-800/60 text-red-300 hover:bg-red-900/60 transition-colors cursor-pointer"
                    >
                      <Square size={12} /> Stop
                    </button>
                  </>
                )}
                {!running && paused && (
                  <>
                    <button
                      onClick={handleResume}
                      className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-semibold bg-[#f26b3a] text-white hover:bg-[#f26b3a]/90 transition-colors cursor-pointer"
                    >
                      <Play size={12} /> Resume
                    </button>
                    <button
                      onClick={handleStop}
                      title="Give up on resuming — keep the results so far"
                      className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-semibold bg-red-900/40 border border-red-800/60 text-red-300 hover:bg-red-900/60 transition-colors cursor-pointer"
                    >
                      <Square size={12} /> Stop
                    </button>
                  </>
                )}
                {!running && !paused && (
                  <button
                    onClick={handleRun}
                    disabled={selectedCount === 0 || busy}
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

            {paused && (
              <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-pm-border bg-pm-hover/40 text-[11px] text-pm-text-muted">
                <Pause size={11} className="shrink-0 text-[#f26b3a]" />
                <span className="truncate">
                  Paused · {pausedAtIndex}/{entries.length} done — Resume continues from the next request
                </span>
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
                    const variablesRemovedCount = variablesSet.filter(v => v.removed).length
                    const variablesSetCount = variablesSet.length - variablesRemovedCount
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
                    const scriptableRequest = source?.request
                    const rawUrl = source?.request?.url ?? ''
                    const rawBody = rawBodyOf(source)
                    const bodyDraft = bodyDrafts[entry.itemId]
                    const bodyEdited = !!rawBody.trim() && isBodyEdited(rawBody, bodyDraft)
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
                        className={`group rounded-md border ${
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
                            <RunSpinner size={14} />
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
                              title={
                                // Apagadas contam separado: um passo de limpeza
                                // que apaga 28 variáveis aparecia como "28" num
                                // chip que diz "set", e era a leitura errada.
                                [
                                  variablesSetCount > 0 && `${variablesSetCount} set`,
                                  variablesRemovedCount > 0 && `${variablesRemovedCount} deleted`,
                                ]
                                  .filter(Boolean)
                                  .join(' · ') + " by this request's scripts"
                              }
                              className={`flex items-center gap-0.5 px-1.5 py-0 rounded text-[10px] font-bold tabular-nums shrink-0 ${
                                variablesRemovedCount > 0
                                  ? 'bg-[#3d1515] text-red-300'
                                  : 'bg-[#0f2e3d] text-[#63b3ed]'
                              }`}
                            >
                              <Braces size={10} />
                              {variablesSetCount > 0 && variablesSetCount}
                              {variablesRemovedCount > 0 && (
                                <span className={variablesSetCount > 0 ? 'pl-1' : ''}>
                                  −{variablesRemovedCount}
                                </span>
                              )}
                            </span>
                          )}
                          {/* Qualquer linha já exibida — não só onde o Pause
                              parou — vira um ponto de partida: refaz dali
                              pra frente, mantendo o resultado das anteriores.
                              Também disponível pausado: permite retomar de
                              uma linha diferente da que parou, não só da
                              próxima (handleRunFrom já reseta o pause). */}
                          {bodyEdited && (
                            <span
                              title="Payload edited in the Runner — used by every run here until Reset; the saved request is unchanged"
                              className="flex items-center gap-0.5 px-1.5 py-0 rounded text-[10px] font-bold bg-amber-500/15 text-amber-400 shrink-0"
                            >
                              <Pencil size={9} /> edited
                            </span>
                          )}
                          {!busy && (
                            <button
                              onClick={e => { e.stopPropagation(); handleRunFrom(entry.id) }}
                              title={
                                (paused ? 'Resume from here — restart from this request' : 'Run from here — redo this request and everything after it') +
                                (bodyEdited ? ' (with the edited payload)' : '')
                              }
                              className="shrink-0 opacity-0 group-hover:opacity-100 text-pm-text-muted hover:text-[#f26b3a] transition-opacity cursor-pointer"
                            >
                              <RotateCw size={12} />
                            </button>
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
                                        <>
                                          <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[10.5px] text-red-300/80">
                                            {t.message}
                                          </pre>
                                          {/* A API às vezes responde algo diferente do que a
                                              asserção previa de propósito — "Order.Incompatible"
                                              não é bug, é a API dizendo que esse método não serve
                                              pra esse pedido. Em vez de reabrir o editor e caçar a
                                              linha certa, isto reescreve o pm.test(...) sozinho pra
                                              aceitar o valor que chegou (ver acceptTestExpectation). */}
                                          {onUpdateRequestScript && (
                                            <button
                                              onClick={e => {
                                                e.stopPropagation()
                                                const scripts = scriptableRequest?.scripts
                                                const attempt =
                                                  (scripts?.postResponse && { phase: 'postResponse' as const, script: scripts.postResponse }) ||
                                                  (scripts?.preRequest && { phase: 'preRequest' as const, script: scripts.preRequest })
                                                const updated = attempt && acceptTestExpectation(attempt.script, t.name, t.message)
                                                if (attempt && updated) {
                                                  onUpdateRequestScript(entry.itemId, attempt.phase, updated)
                                                  toast.success('Test updated — accepted as the expected result.', {
                                                    description: 'Run it again to see it pass.',
                                                  })
                                                } else {
                                                  toast.error('Could not update the script automatically.', {
                                                    description: 'Edit the Post-response script below to accept this result.',
                                                  })
                                                }
                                              }}
                                              className="mt-1 inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-semibold cursor-pointer border border-[#4ff09d]/30 bg-[#4ff09d]/10 text-[#4ff09d] hover:bg-[#4ff09d]/20 hover:border-[#4ff09d]/50 transition-colors"
                                              title="Update the test script so this exact result is treated as expected from now on"
                                            >
                                              <BadgeCheck size={11} /> Accept as expected
                                            </button>
                                          )}
                                        </>
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
                                  <VariableText
                                    text={rawUrl}
                                    valueOf={currentEnvValue}
                                    onCommit={commitVariable}
                                    activeEnvId={runEnvId}
                                    onReplaceToken={
                                      onUpdateRequestUrl &&
                                      ((oldToken, newKey) =>
                                        onUpdateRequestUrl(entry.itemId, rawUrl.replace(oldToken, `{{${newKey}}}`)))
                                    }
                                  />
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
                              <div
                                className={`rounded-md border bg-pm-hover p-2 flex flex-col gap-1.5 ${
                                  bodyEdited ? 'border-amber-500/50' : 'border-pm-border'
                                }`}
                              >
                                <div className="flex items-center gap-1.5">
                                  <span className="flex items-center gap-1 text-[10px] font-semibold text-pm-text-muted uppercase tracking-wide">
                                    <ArrowUpRight size={10} /> Payload
                                  </span>
                                  {bodyEdited && (
                                    <span className="flex items-center gap-0.5 text-[10px] font-semibold text-amber-400">
                                      <Pencil size={9} /> edited
                                    </span>
                                  )}
                                  {!!rawBody.trim() && (
                                    <div className="ml-auto flex items-center gap-2.5">
                                      {bodyEdited && (
                                        <button
                                          onClick={e => { e.stopPropagation(); setBodyDraft(entry.itemId, undefined) }}
                                          disabled={entry.state === 'running'}
                                          title="Discard the edit and go back to the payload saved in the request"
                                          className="flex items-center gap-1 text-[10px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                          <Undo2 size={11} /> Reset
                                        </button>
                                      )}
                                      <button
                                        onClick={e => {
                                          e.stopPropagation()
                                          // Com rascunho, formatar É mexer no
                                          // texto que está sendo editado; sem
                                          // ele, só alterna a exibição do salvo.
                                          if (bodyDraft !== undefined) {
                                            setBodyDraft(entry.itemId, prettyBodyPreservingTemplates(bodyDraft))
                                            return
                                          }
                                          setPayloadPrettyIds(prev => {
                                            const next = new Set(prev)
                                            if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id)
                                            return next
                                          })
                                        }}
                                        title={
                                          bodyDraft !== undefined
                                            ? 'Pretty-print the edited JSON'
                                            : payloadPrettyIds.has(entry.id) ? 'Show raw (as stored in the request)' : 'Pretty-print this JSON'
                                        }
                                        className={`flex items-center gap-1 text-[10px] transition-colors cursor-pointer ${
                                          bodyDraft === undefined && payloadPrettyIds.has(entry.id) ? 'text-[#097bed]' : 'text-pm-text-muted hover:text-pm-text'
                                        }`}
                                      >
                                        <WandSparkles size={11} />{' '}
                                        {bodyDraft === undefined && payloadPrettyIds.has(entry.id) ? 'Pretty' : 'Prettify'}
                                      </button>
                                      {!busy && (
                                        <button
                                          onClick={e => { e.stopPropagation(); handleRunStep(entry.id) }}
                                          title={
                                            bodyEdited
                                              ? 'Send only this request again, with the edited payload'
                                              : 'Send only this request again'
                                          }
                                          className="flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-semibold cursor-pointer border border-[#f26b3a]/40 bg-[#f26b3a]/10 text-[#f26b3a] hover:bg-[#f26b3a]/20 transition-colors"
                                        >
                                          <Play size={10} /> Send
                                        </button>
                                      )}
                                      {stepRunningId === entry.id && (
                                        <RunSpinner size={12} />
                                      )}
                                    </div>
                                  )}
                                </div>
                                {rawBody.trim() ? (
                                  // Cru por padrão: é o que está guardado na
                                  // request, e reformatar sem pedir mostraria
                                  // um payload diferente do que o editor de
                                  // Body mostra. Bonito é opt-in, ver o botão
                                  // acima — mantém os {{tokens}} clicáveis
                                  // (prettyBodyPreservingTemplates só reindenta).
                                  //
                                  // Editável: o que se digita vira o rascunho
                                  // desta linha (template, com {{vars}} — ver
                                  // payloadOverride.ts) e é o que o Send / Run
                                  // from here mandam. Travado só enquanto a
                                  // própria linha está no ar.
                                  <>
                                    <JsonBlock
                                      value={
                                        bodyDraft ??
                                        (payloadPrettyIds.has(entry.id) ? prettyBodyPreservingTemplates(rawBody) : rawBody)
                                      }
                                      maxHeight={224}
                                      variableValue={currentEnvValue}
                                      onCommitVariable={commitVariable}
                                      onChange={entry.state === 'running' ? undefined : next => setBodyDraft(entry.itemId, next)}
                                    />
                                    {bodyEdited && (
                                      <span className="text-[10px] text-pm-text-muted">
                                        Edited in the Runner — Send, Run again and every iteration here use it until Reset;
                                        the saved request is unchanged. {'{{variables}}'} are resolved from the current
                                        environment when sent.
                                      </span>
                                    )}
                                  </>
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

                            {/* Editar o script aqui dispensa abrir a aba da
                                request — ela já está aberta justamente para
                                comparar com o que o run fez. */}
                            {scriptableRequest && (() => {
                              const activePhase = scriptTabByEntry[entry.id] ?? 'preRequest'
                              const activeScript = scriptableRequest.scripts?.[activePhase] ?? ''
                              // Autossuficiente mesmo com o MCP desligado: em vez de
                              // pedir pro Claude ir buscar o run, já manda o script,
                              // o placar dos testes e um recorte da resposta direto
                              // no texto — é tudo que já está na tela.
                              const buildAiPrompt = () => {
                                const label = activePhase === 'preRequest' ? 'pre-request' : 'post-response'
                                const parts = [
                                  `Explique o resultado deste script de ${label} da request "${entry.name}"` +
                                    (entry.rowLabel ? ` (${entry.rowLabel})` : '') + '.',
                                  '',
                                  'Script:',
                                  '```js',
                                  activeScript || '(vazio)',
                                  '```',
                                ]
                                if (entry.outcome) {
                                  parts.push(
                                    '',
                                    `Resposta: HTTP ${entry.outcome.httpStatus ?? entry.outcome.errorMessage ?? '?'} em ${entry.outcome.responseTime}ms`
                                  )
                                }
                                if (tests.length > 0) {
                                  parts.push('', 'Testes:', ...tests.map(t =>
                                    `${t.passed ? '✓' : '✗'} ${t.name}${!t.passed && t.message ? ` — ${t.message}` : ''}`
                                  ))
                                }
                                if (entry.outcome?.scriptError) {
                                  parts.push('', `Erro no script: ${entry.outcome.scriptError}`)
                                }
                                if (responseBody) {
                                  parts.push('', 'Corpo da resposta (pode estar truncado):', responseBody.slice(0, 2000))
                                }
                                return parts.join('\n')
                              }

                              return (
                                <details className="rounded-md border border-pm-border bg-pm-hover p-2">
                                  <summary className="flex items-center cursor-pointer text-[10px] font-semibold text-pm-text-muted uppercase tracking-wide">
                                    <span className="flex-1">Scripts</span>
                                    {onOpenTextInNewWindow && (
                                      <button
                                        onClick={e => {
                                          e.preventDefault()
                                          e.stopPropagation()
                                          const phaseLabel = activePhase === 'preRequest' ? 'Pre-request' : 'Post-response'
                                          onOpenTextInNewWindow(activeScript, `${phaseLabel} script — ${entry.name}`, 'javascript')
                                        }}
                                        title="Open this script in a new window"
                                        className="normal-case font-normal p-0.5 rounded text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                                      >
                                        <ExternalLink size={11} />
                                      </button>
                                    )}
                                    {onAskAiAboutScript && (
                                      <button
                                        onClick={e => { e.preventDefault(); e.stopPropagation(); onAskAiAboutScript(buildAiPrompt()) }}
                                        title="Ask Claude about this script's result"
                                        className="normal-case font-normal p-0.5 ml-0.5 rounded text-pm-text-muted hover:text-[#f26b3a] transition-colors cursor-pointer"
                                      >
                                        <Sparkles size={11} />
                                      </button>
                                    )}
                                  </summary>
                                  <div className="mt-1.5 flex flex-col gap-1.5" onClick={e => e.stopPropagation()}>
                                    <div className="flex gap-1">
                                      {(['preRequest', 'postResponse'] as const).map(phase => {
                                        const active = activePhase === phase
                                        return (
                                          <button
                                            key={phase}
                                            onClick={() => setScriptTabByEntry(prev => ({ ...prev, [entry.id]: phase }))}
                                            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors cursor-pointer ${
                                              active
                                                ? 'bg-[#097bed]/20 text-[#097bed]'
                                                : 'text-pm-text-muted hover:text-pm-text'
                                            }`}
                                          >
                                            {phase === 'preRequest' ? 'Pre-request' : 'Post-response'}
                                          </button>
                                        )
                                      })}
                                    </div>
                                    <div className="h-40 rounded border border-pm-border overflow-hidden">
                                      <CodeEditor
                                        key={`${entry.id}-${activePhase}`}
                                        value={activeScript}
                                        onChange={value => onUpdateRequestScript?.(entry.itemId, activePhase, value)}
                                      />
                                    </div>
                                    <span className="text-[10px] text-pm-text-muted">
                                      Saved to the request — the next Send or Run uses it.
                                    </span>
                                  </div>
                                </details>
                              )
                            })()}

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
                                    onClick={e => {
                                      e.stopPropagation()
                                      setResponseRawIds(prev => {
                                        const next = new Set(prev)
                                        if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id)
                                        return next
                                      })
                                    }}
                                    title={responseRawIds.has(entry.id) ? 'Pretty-print this JSON' : 'Show raw (exactly as received)'}
                                    className={`ml-auto flex items-center gap-1 text-[10px] transition-colors cursor-pointer ${
                                      responseRawIds.has(entry.id) ? 'text-pm-text-muted hover:text-pm-text' : 'text-[#097bed]'
                                    }`}
                                  >
                                    <WandSparkles size={11} /> {responseRawIds.has(entry.id) ? 'Prettify' : 'Pretty'}
                                  </button>
                                  {onOpenTextInNewWindow && (
                                    <button
                                      onClick={e => {
                                        e.stopPropagation()
                                        const shown = responseRawIds.has(entry.id) ? responseBody : prettyBody(responseBody)
                                        onOpenTextInNewWindow(shown, `Response — ${entry.name}`, 'json')
                                      }}
                                      title="Open this response in a new window"
                                      className="flex items-center text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                                    >
                                      <ExternalLink size={11} />
                                    </button>
                                  )}
                                  <button
                                    onClick={e => { e.stopPropagation(); copyBody(entry) }}
                                    className="flex items-center gap-1 text-[10px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                                  >
                                    {copiedBodyId === entry.id ? <Check size={11} className="text-[#4ff09d]" /> : <Copy size={11} />}
                                    {copiedBodyId === entry.id ? 'Copied' : 'Copy'}
                                  </button>
                                </div>
                                <JsonBlock
                                  value={responseRawIds.has(entry.id) ? responseBody : prettyBody(responseBody)}
                                  maxHeight={288}
                                />
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
                                          className={`shrink-0 pt-1 ${v.removed ? 'text-red-400' : 'text-pm-text-muted/70'}`}
                                          title={
                                            v.removed
                                              ? 'Deleted by this request (pm.environment.unset)'
                                              : v.phase
                                                ? 'Set by this request'
                                                : 'Read by this request'
                                          }
                                        >
                                          [{v.removed ? 'del' : v.phase ? (v.phase === 'pre-request' ? 'pre' : 'post') : 'in'}]
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
                                            v.removed
                                              ? `This request deleted it. It held: ${v.runValue}. Type a value to put it back.`
                                              : changed
                                                ? `This run set: ${v.runValue}`
                                                : 'Edit to change the environment variable, then Run again'
                                          }
                                          className={`flex-1 min-w-0 rounded border bg-pm-bg px-1.5 py-0.5 font-mono text-[11px] outline-none ${
                                            savedVarKey === draftKey
                                              ? 'border-[#4ff09d]/60 text-[#4ff09d]'
                                              : v.removed
                                                ? 'border-red-500/40 text-red-300/80 line-through decoration-red-400/50'
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

            {/* Summary footer — também alça de arrastar: se o cabeçalho ficar
                fora de alcance (modal mais alto que a janela), esta barra,
                na outra ponta do modal, costuma continuar visível. Os botões
                dentro continuam clicáveis — o mesmo guard do cabeçalho exclui
                `button/input/select/textarea/a` do início do arrasto. */}
            {entries.length > 0 && (
              <div
                // Só onMouseDown/style — não o `ref`: ele é o mesmo objeto do
                // cabeçalho, que precisa continuar apontando SÓ pra lá (é o
                // que a medição "nasceu fora da tela" usa, e essa barra some
                // quando `entries` está vazio, o cabeçalho nunca).
                onMouseDown={drag.handleProps.onMouseDown}
                style={drag.handleProps.style}
                onDoubleClick={drag.reset}
                title="Drag to move — double-click to recenter"
                className="h-11 shrink-0 flex items-center justify-between px-4 border-t border-pm-border text-[11px] text-pm-text-muted select-none"
              >
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
                      onClick={() => {
                        setEntries([])
                        setRestoredAt(null)
                        setRestoredTruncated(false)
                        setRunMeta({})
                        setPaused(false)
                        pauseRef.current = false
                        runContextRef.current = null
                      }}
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
