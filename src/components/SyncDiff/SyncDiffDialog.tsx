'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, FileText, Folder, GitCommitHorizontal, Maximize2, Minimize2, Minus, Plus, Pencil, Search, Sparkles, X, Eye, EyeOff } from 'lucide-react'
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
  nodesOfRoot,
  selectWithin,
  summarize,
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
import { classifyNode, countByOrigin, type NodeOrigin, type NodeStatus, type StatusKey } from '@/lib/diffOrigin'
import { useDraggableDialog } from '@/components/helper/useDraggableDialog'
import { useResizableDialog, type ResizeEdge } from '@/components/helper/useResizableDialog'
import { MIN_LEFT, MIN_RIGHT, useSplitRatio } from '@/components/helper/useSplitRatio'
import { autoMerge, mergePrefill, selectionAfter, TEXT_MERGE_FIELDS, type AutoMergeSummary, type NodeResolution } from '@/lib/sync/autoMerge'
import {
  composeMerge,
  conflictMarkerCount,
  defaultPicks,
  inferPicks,
  mergeChunks,
  sidePicks,
  type ChunkPick,
  type MergeChunk,
} from '@/lib/sync/mergeChunks'
import { ThreeWayMergeView } from './ThreeWayMergeView'
import {
  clearPreparedEdits,
  draftsFromPreparedEdits,
  preparedEditsFor,
  preparedEditStamp,
} from '@/lib/sync/preparedMergeEdits'
import { REST, restOf } from '@/lib/sync/fieldMerge'
import { sameContent } from '@/lib/canonicalCompare'
import { useSyncDiffStrings, type SyncDiffStrings } from '@/lib/i18n/syncDiffStrings'
import { useLanguage } from '@/lib/i18n/language'
import { fieldOrigin, fieldValue, MERGE_FIELDS, type FieldOrigin, type MergeField } from '@/lib/sync/fieldMerge'
import { diffableText } from '@/lib/textDiff'
import type { CollectionItem } from '@/app/types/CollectionItem'
import { TextDiffView } from './TextDiffView'
import { EntryDiffTable } from './EntryDiffTable'
import { diffEntries, entriesFromText } from '@/lib/entryDiff'
import { redactAuthForDisplay } from '@/lib/secretScan'
import type { Marker } from '@/lib/markers'

export interface RemoteChange {
  authorName: string
  date: string
  message: string
}

/** O último commit que mexeu num ITEM (não só no arquivo da collection). */
export interface ItemChange extends RemoteChange {
  kind: 'changed' | 'created' | 'deleted'
  fields: string[]
}

/** Uma decisão tomada nesta revisão, pro histórico de conflitos. */
export interface ReviewDecision {
  item: string
  choice: 'mine' | 'github' | 'merged'
  fields: string[]
}

/** "5 min ago" / "há 5 min" — no idioma escolhido nas configurações. */
function timeAgo(iso: string, t: SyncDiffStrings, locale: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const min = Math.round(ms / 60000)
  if (min < 1) return t.justNow
  if (min < 60) return t.minAgo(min)
  const h = Math.round(min / 60)
  if (h < 24) return t.hoursAgo(h)
  const d = Math.round(h / 24)
  if (d < 30) return t.daysAgo(d)
  return new Date(iso).toLocaleDateString(locale)
}

// ─── Escolha por item: Mine | GitHub | Merged ────────────────────────────
//
// Antes era uma caixinha: marcada = aceitar o GitHub, desmarcada = manter o
// seu. Isso não estava escrito em lugar nenhum, e "desmarcar pra manter uma
// exclusão sua" era o oposto do que a caixinha sugere. Dois botões com o nome
// do lado escolhido dizem a decisão em vez de pedir pra adivinhá-la.
//
// "Merged" não é um terceiro estado guardado: é GitHub + campos editados à
// mão no detalhe (os drafts). Só aparece onde dá pra editar campo a campo.
export type Choice = 'mine' | 'github' | 'merged' | 'mixed'

function ChoiceToggle({
  choice,
  onMine,
  onGitHub,
  onMerge,
  size = 'sm',
}: {
  choice: Choice
  onMine: () => void
  onGitHub: () => void
  /** Ausente = este item não tem campo editável. */
  onMerge?: () => void
  size?: 'sm' | 'md'
}) {
  const t = useSyncDiffStrings()
  const pad = size === 'md' ? 'px-2.5 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[9.5px]'
  const seg = (active: boolean, activeClass: string) =>
    `${pad} font-semibold transition-colors cursor-pointer border-none ${
      active ? activeClass : 'bg-transparent text-pm-text-muted hover:text-pm-text hover:bg-pm-hover'
    }`
  return (
    <div
      role="group"
      onClick={e => e.stopPropagation()}
      className="shrink-0 inline-flex rounded-md border border-pm-border overflow-hidden bg-pm-bg"
    >
      <button
        type="button"
        onClick={onMine}
        title={t.mineTitle}
        aria-pressed={choice === 'mine'}
        className={seg(choice === 'mine', 'bg-[#007acc]/25 text-[#9fd3f7]')}
      >
        {t.mine}
      </button>
      <button
        type="button"
        onClick={onGitHub}
        title={t.githubTitle}
        aria-pressed={choice === 'github'}
        className={`${seg(choice === 'github', 'bg-[#f26b3a]/25 text-[#ffb08f]')} border-l border-pm-border`}
      >
        {t.github}
      </button>
      {(onMerge || choice === 'merged') && (
        <button
          type="button"
          onClick={onMerge}
          title={t.mergeTitle}
          aria-pressed={choice === 'merged'}
          className={`${seg(choice === 'merged', 'bg-[#4ff09d]/20 text-[#4ff09d]')} border-l border-pm-border`}
        >
          {t.merge}
        </button>
      )}
    </div>
  )
}

interface Props {
  open: boolean
  nodes: DiffNode[]
  /** Collections com alteração local ainda não enviada (storage/pendingPushStore). */
  pendingCollectionIds: ReadonlySet<string>
  /** Estado da última sincronização. Sem ela, o conflito recai no critério
   *  por collection, que avisa demais. */
  base?: NodeHashes | null
  collectionNames: Map<string, string>
  /** Pra resolver id de marcador -> nome/cor nos campos `markers`/`markerNotes`. */
  markerCatalog?: Marker[]
  /**
   * `push`: a revisão foi aberta por um envio, que continua sozinho depois
   * de aplicar. Os botões precisam dizer isso — em especial que não aceitar
   * nada do GitHub ENVIA a versão daqui por cima da de lá.
   */
  mode?: 'pull' | 'push'
  /** Restaurar um commit antigo: o sha curto — vira o título ("Restore from commit abc1234"). */
  restoreCommit?: string
  /**
   * Abre já filtrada no que pede decisão — quando o merge automático do push
   * resolveu o resto sozinho (lib/sync/rebase) e só sobrou o conflito.
   */
  initialConflictsOnly?: boolean
  /**
   * Mais itens que começam em "Mine" além dos que a base indica — a revisão
   * de environments (sem base de nó) usa pra proteger as variáveis suas.
   */
  extraConflictIds?: ReadonlySet<string>
  /**
   * A collection raiz como estava na última sincronização (lida do GitHub
   * pelo sha registrado) — dá a terceira coluna da revisão: o que cada lado
   * mudou. Ausente = não dá pra saber (environments, restaurar commit).
   */
  baseVersionOf?: (rootId: string) => Promise<CollectionItem | null>
  /**
   * Último commit no GitHub do arquivo de uma collection raiz (ou de um
   * environment) — quem mexeu e quando. `null` = não deu pra saber.
   */
  lastChangeOf?: (rootId: string) => Promise<RemoteChange | null>
  onClose: () => void
  onApply: (selectedIds: Set<string>, overrides: OverrideMap, decisions: ReviewDecision[]) => void
  /** "Histórico" no cabeçalho: as decisões de conflito já tomadas. */
  onShowHistory?: () => void
  /**
   * Quem mexeu por último NESTE item — percorre o histórico do arquivo e
   * compara as versões. `searched` = quantos commits olhou.
   */
  whoChangedItem?: (rootId: string, nodeId: string) => Promise<{ change: ItemChange | null; searched: number } | null>
  /** Workspace revisado — só as edições preparadas na prévia DELE entram aqui. */
  workspace?: string
}

// Chave do grupo "direto na raiz da collection". Caractere que nome de pasta
// não contém, pra não colidir com uma pasta de verdade chamada "root".
const ROOT_GROUP_KEY = '\u0000root'

// Ícone e cor dizem O QUE mudou (adicionado/removido/alterado, visto do
// GitHub); o rótulo de QUEM mexeu vem de classifyNode (lib/diffOrigin).
const CHANGE_STYLE: Record<DiffNode['change'], { color: string; Icon: typeof Plus }> = {
  added: { color: 'text-[#4ff09d]', Icon: Plus },
  removed: { color: 'text-[#ff7b7b]', Icon: Minus },
  modified: { color: 'text-amber-400', Icon: Pencil },
}

// Com a base dá pra dizer QUEM mexeu, e o ícone segue isso: "+" pra o que
// foi criado (azul se aqui, verde se no GitHub), "−" pra o que foi apagado
// (azul se aqui, vermelho se no GitHub). Antes era sempre do ponto de vista
// do GitHub — um item que você acabou de criar aparecia com um "−" vermelho,
// como se estivesse sendo apagado.
const STATUS_STYLE: Partial<Record<StatusKey, { color: string; Icon: typeof Plus }>> = {
  newHere: { color: 'text-[#63b3ed]', Icon: Plus },
  deletedHere: { color: 'text-[#63b3ed]', Icon: Minus },
  changedHere: { color: 'text-[#63b3ed]', Icon: Pencil },
  newOnGithub: { color: 'text-[#4ff09d]', Icon: Plus },
  deletedOnGithub: { color: 'text-[#ff7b7b]', Icon: Minus },
  deletedHereChangedOnGithub: { color: 'text-amber-400', Icon: Minus },
  changedHereDeletedOnGithub: { color: 'text-amber-400', Icon: Minus },
}

function styleOf(node: DiffNode, status: NodeStatus | undefined) {
  return (status && STATUS_STYLE[status.key]) ?? CHANGE_STYLE[node.change]
}

// Caixa do detalhe, por origem: azul pro que é seu (desmarcado = mantém),
// âmbar pro que pede decisão.
const ORIGIN_BOX: Record<NodeOrigin, string> = {
  github: '',
  here: 'border-[#007acc]/30 bg-[#007acc]/10 text-[#7cc4f2]',
  both: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  unknown: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
}

// Valor de campo como texto legível. JSON cru numa linha só (headers, auth)
// é ilegível no painel estreito, e é justamente onde a diferença costuma estar.
function renderValue(value: unknown, empty: string): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value || empty
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// ─── Marcadores: id -> nome/cor, em vez do UUID cru ────────────────────────
//
// `markers`/`markerNotes` guardam só ids (ver lib/markers.ts) — sem resolver
// contra o catálogo, o conflito aparecia como `["00417124-9f35-..."]`, que
// não diz nada sobre QUAL marcador é esse.

function markerOf(id: string, catalog: Marker[]): Marker | undefined {
  return catalog.find(m => m.id === id)
}

/** O item `id` dentro da árvore de `root` (a versão da última sincronização). */
function findItem(root: CollectionItem, id: string): CollectionItem | undefined {
  if (root.id === id) return root
  for (const child of root.item ?? []) {
    const found = findItem(child, id)
    if (found) return found
  }
  return undefined
}

/** Resultado do Auto merge, guardado pra tela (marcas, filtro e resumo). */
interface AutoMergeState {
  resolutions: Map<string, NodeResolution>
  summary: AutoMergeSummary
  /** Itens com mescla à mão, que o Auto merge não tocou. */
  skipped: number
  /** Alguma collection ficou sem a versão da última sincronização. */
  baseFailed: boolean
}

// Alças de tamanho: as quatro bordas e os quatro cantos.
const RESIZE_HANDLES: { edge: ResizeEdge; className: string }[] = [
  { edge: 'n', className: 'top-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 's', className: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 'e', className: 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'w', className: 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'nw', className: 'top-0 left-0 h-2.5 w-2.5 cursor-nwse-resize' },
  { edge: 'ne', className: 'top-0 right-0 h-2.5 w-2.5 cursor-nesw-resize' },
  { edge: 'sw', className: 'bottom-0 left-0 h-2.5 w-2.5 cursor-nesw-resize' },
]

function MarkerDot({ color }: { color?: string }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ backgroundColor: color ?? '#8b96a8' }}
    />
  )
}

function markerIdsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
}

function markerNotesOf(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {}
}

function MarkerChips({ value, catalog }: { value: unknown; catalog: Marker[] }) {
  const t = useSyncDiffStrings()
  const ids = markerIdsOf(value)
  if (ids.length === 0) return <span className="text-[10.5px] text-pm-text-muted/60 italic">{t.none}</span>
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map(id => {
        const marker = markerOf(id, catalog)
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 bg-pm-bg border border-pm-border text-[10px] text-pm-text-secondary"
          >
            <MarkerDot color={marker?.color} />
            {marker?.name ?? id}
          </span>
        )
      })}
    </div>
  )
}

function MarkerNoteLines({ value, catalog }: { value: unknown; catalog: Marker[] }) {
  const t = useSyncDiffStrings()
  const entries = Object.entries(markerNotesOf(value))
  if (entries.length === 0) return <span className="text-[10.5px] text-pm-text-muted/60 italic">{t.none}</span>
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([id, note]) => {
        const marker = markerOf(id, catalog)
        return (
          <div key={id} className="text-[10.5px] text-pm-text-secondary">
            <span className="inline-flex items-center gap-1 font-semibold text-pm-text align-middle">
              <MarkerDot color={marker?.color} />
              {marker?.name ?? id}:
            </span>{' '}
            &quot;{note}&quot;
          </div>
        )
      })}
    </div>
  )
}

/** União dos dois lados — "Keep both" dos conflitos de marcador. */
function unionMarkerIds(local: unknown, remote: unknown): string[] {
  return [...new Set([...markerIdsOf(local), ...markerIdsOf(remote)])]
}

/** Idem pras notas; a de cá vence quando os dois têm nota no MESMO marcador. */
function mergeMarkerNotes(local: unknown, remote: unknown): Record<string, string> {
  return { ...markerNotesOf(remote), ...markerNotesOf(local) }
}

interface FieldRowProps {
  field: FieldDiff
  /** Texto na caixa de resultado. Vazio = ainda não editado. */
  draft: string | undefined
  error: string | undefined
  onDraftChange: (text: string | undefined) => void
  markerCatalog: Marker[]
  /** Quem mudou este campo desde a última sincronização (lib/sync/fieldMerge). */
  origin?: FieldOrigin
  /**
   * O valor na ÚLTIMA SINCRONIZAÇÃO: o que dá pra saber o que cada lado
   * mudou. 'loading' enquanto busca; 'unavailable' sem como saber; 'absent'
   * = o item não existia ainda.
   */
  base?: 'loading' | 'unavailable' | 'absent' | { value: unknown }
  /** O Auto merge achou conflito real neste campo: destaque. */
  conflict?: boolean
  /** O Auto merge juntou as mudanças dos dois lados neste campo. */
  autoCombined?: boolean
  /** A escolha do item: diz o que a caixa de resultado mostra quando ninguém editou. */
  choice?: Choice
  /**
   * Em Mine, a caixa não pode virar Merge sem perder algo seu (ordem dos
   * filhos ou configurações sem campo próprio): fica só pra leitura.
   */
  readOnly?: boolean
  /** Editor de três painéis (campos de texto): substitui comparação e resultado. */
  mergeEditor?: React.ReactNode
}

// Diff ou lado a lado — lembrado entre itens e aberturas.
const FIELD_VIEW_KEY = 'devflow_sync_field_view'
function loadFieldView(): 'diff' | 'side' {
  try {
    return localStorage.getItem(FIELD_VIEW_KEY) === 'side' ? 'side' : 'diff'
  } catch {
    return 'diff'
  }
}

// Selo de quem mudou o campo. Sem selo quando não dá pra saber (sem base) ou
// quando os dois lados chegaram ao mesmo valor.
const FIELD_ORIGIN_STYLE: Partial<Record<FieldOrigin, string>> = {
  here: 'text-[#63b3ed] bg-[#007acc]/15',
  github: 'text-[#4ff09d] bg-[#4ff09d]/10',
  both: 'text-amber-300 bg-amber-500/15',
}

function FieldRow({ field, draft, error, onDraftChange, markerCatalog, origin, base = 'unavailable', conflict = false, autoCombined = false, choice = 'github', readOnly = false, mergeEditor }: FieldRowProps) {
  const t = useSyncDiffStrings()
  const [view, setView] = useState<'diff' | 'side'>(loadFieldView)
  const chooseView = (next: 'diff' | 'side') => {
    setView(next)
    try { localStorage.setItem(FIELD_VIEW_KEY, next) } catch { /* ok */ }
  }
  const editable = isEditableField(field.field)
  const isMarkerField = field.field === 'markers' || field.field === 'markerNotes'
  const isAuthField = field.field === 'auth'
  // `auth` pode trazer bearer/basic/apikey/oauth2 em texto puro no JSON cru
  // abaixo — mascarado por padrão, igual ao header na EntryDiffTable; quem
  // está mesclando de propósito ainda pode revelar pra conferir o valor.
  const [revealAuth, setRevealAuth] = useState(false)
  // A caixa mostra o que vai ser salvo: em Mine, a sua versão; em GitHub,
  // a de lá; em Merge, o editado (ou a de lá, no campo que não foi mexido).
  // Antes mostrava sempre a do GitHub — com o item em Mine, o "resultado"
  // exibia justamente o que NÃO ia ser salvo.
  const value = draft ?? formatFieldValue(field.field, choice === 'mine' ? field.local : field.remote)
  // "editado" = diferente dos dois lados, não só "tem rascunho": ao editar a
  // partir de Mine, os outros campos ganham rascunho com o seu valor.
  const edited =
    draft !== undefined &&
    draft !== formatFieldValue(field.field, field.local) &&
    draft !== formatFieldValue(field.field, field.remote)
  const resultSource: 'edited' | 'mine' | 'github' =
    edited ? 'edited'
      : choice === 'mine' || (draft !== undefined && draft === formatFieldValue(field.field, field.local))
        ? 'mine'
        : 'github'

  // Headers e variáveis viram uma linha por entrada. Os outros campos
  // (`auth`, `example`, `order`) não são lista de chave/valor e seguem no
  // JSON lado a lado — é o que `diffEntries` devolvendo null quer dizer.
  const entryRows = useMemo(
    () => diffEntries(field.local, field.remote),
    [field.local, field.remote]
  )
  // null aqui = o texto da caixa não é uma lista (JSON pela metade enquanto
  // se digita). A tabela ainda compara; só não dá pra escolher por linha.
  // `isMarkerField` nunca cai aqui — diffEntries já devolve null pra um
  // array de ids simples ou um Record, mas checar explícito deixa claro que
  // essa rota (EntryDiffTable, pensada pra headers/variáveis) não é a dela.
  const entries = !isMarkerField && entryRows && !readOnly ? entriesFromText(value) : null

  // Resolve o valor atual do box de resultado pra marcador — se o usuário
  // digitasse algo inválido na caixa (não acontece pelos botões, mas por
  // garantia) cai pro remoto em vez de quebrar a tela.
  const resultValue = isMarkerField
    ? (() => {
        try {
          return JSON.parse(value || (field.field === 'markers' ? '[]' : '{}'))
        } catch {
          return field.remote
        }
      })()
    : null

  return (
    <div
      className={`rounded-md border p-2 ${
        conflict ? 'border-amber-500/60 bg-amber-500/5 ring-1 ring-amber-500/30' : 'border-pm-border bg-pm-hover/50'
      }`}
    >
      {autoCombined && (
        <div className="mb-1.5 flex items-center gap-1 text-[10px] text-[#4ff09d]">
          <Sparkles size={10} className="shrink-0" />
          {t.autoCombinedNote}
        </div>
      )}
      {conflict && (
        <div className="mb-1.5 text-[10px] font-semibold text-amber-300">{t.conflictFieldNote}</div>
      )}
      <div className="flex items-center gap-2 mb-1.5">
        {conflict && <AlertTriangle size={11} className="text-amber-400 shrink-0" aria-label={t.conflictLabel} />}
        <span className="text-[10px] font-semibold uppercase tracking-wide text-pm-text-muted">
          {field.field}
        </span>
        {origin && FIELD_ORIGIN_STYLE[origin] && (
          <span className={`rounded px-1 text-[9px] ${FIELD_ORIGIN_STYLE[origin]}`}>
            {origin === 'here' ? t.fieldChangedHere : origin === 'github' ? t.fieldChangedGithub : t.fieldChangedBoth}
          </span>
        )}
        {edited && <span className="text-[9.5px] text-[#63b3ed]">{t.edited}</span>}
        {isAuthField && (
          <button
            onClick={() => setRevealAuth(r => !r)}
            title={revealAuth ? t.hideSensitive : t.showSensitive}
            className="flex items-center gap-1 text-[9.5px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
          >
            {revealAuth ? <EyeOff size={10} /> : <Eye size={10} />}
            {revealAuth ? t.hide : t.show}
          </button>
        )}
        {editable && !readOnly && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => onDraftChange(formatFieldValue(field.field, field.local))}
              className="text-[9.5px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
            >
              {t.useMine}
            </button>
            <button
              onClick={() => onDraftChange(undefined)}
              className="text-[9.5px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
            >
              {t.useGithub}
            </button>
            {/* Só pra marcador: ao contrário de nome/URL/corpo, duas listas
                de ids dá pra combinar sem inventar conteúdo — "um dos dois"
                não é menos certo que "só um dos lados". */}
            {isMarkerField && (
              <button
                onClick={() =>
                  onDraftChange(
                    JSON.stringify(
                      field.field === 'markers'
                        ? unionMarkerIds(field.local, field.remote)
                        : mergeMarkerNotes(field.local, field.remote)
                    )
                  )
                }
                className="text-[9.5px] text-[#4ff09d] hover:text-[#4ff09d]/80 transition-colors cursor-pointer"
              >
                {t.keepBoth}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Campo de texto com o editor de três painéis (layout do merge do
          Visual Studio): ele substitui a comparação e a caixa de resultado. */}
      {mergeEditor ?? (<>
      {isMarkerField ? (
        <div className="grid grid-cols-2 gap-2 mb-1.5">
          <div>
            <div className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70 mb-0.5">{t.yourVersion}</div>
            {field.field === 'markers' ? (
              <MarkerChips value={field.local} catalog={markerCatalog} />
            ) : (
              <MarkerNoteLines value={field.local} catalog={markerCatalog} />
            )}
          </div>
          <div>
            <div className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70 mb-0.5">{t.github}</div>
            {field.field === 'markers' ? (
              <MarkerChips value={field.remote} catalog={markerCatalog} />
            ) : (
              <MarkerNoteLines value={field.remote} catalog={markerCatalog} />
            )}
          </div>
        </div>
      ) : entryRows ? (
        <EntryDiffTable
          rows={entryRows}
          entries={entries}
          onEntriesChange={next => onDraftChange(JSON.stringify(next, null, 2))}
        />
      ) : (
        (() => {
          // auth mascarado por padrão também no diff.
          const shown = (v: unknown) => (isAuthField && !revealAuth ? redactAuthForDisplay(v) : v)
          const hasBase = typeof base === 'object'
          const baseValue = hasBase ? shown(base.value) : undefined
          const toggle = (
            <div className="flex items-center gap-1 mb-1">
              {(['diff', 'side'] as const).map(option => (
                <button
                  key={option}
                  onClick={() => chooseView(option)}
                  className={`rounded px-1.5 py-px text-[9.5px] transition-colors cursor-pointer ${
                    view === option ? 'bg-pm-row-active text-pm-text' : 'text-pm-text-muted hover:text-pm-text'
                  }`}
                >
                  {option === 'diff' ? t.viewDiff : t.viewSideBySide}
                </button>
              ))}
              {base === 'loading' && <span className="ml-1 text-[9.5px] text-pm-text-muted/70">{t.loadingLastSync}</span>}
              {base === 'absent' && <span className="ml-1 text-[9.5px] text-pm-text-muted/70">{t.notInLastSync}</span>}
            </div>
          )
          if (view === 'diff') {
            const diffProps = { emptyText: '', collapsedText: t.collapsedLines }
            return (
              <div className="mb-1.5 flex flex-col gap-2">
                {toggle}
                {hasBase ? (
                  // Com a versão da última sincronização: o que CADA lado mudou
                  // — é isso que diz se as duas mudanças conflitam de verdade.
                  <>
                    <div>
                      <div className="text-[9.5px] font-semibold text-[#63b3ed] mb-0.5">{t.whatYouChanged}</div>
                      <TextDiffView
                        {...diffProps}
                        before={diffableText(baseValue)}
                        after={diffableText(shown(field.local))}
                        beforeLabel={t.lastSync}
                        afterLabel={t.yourVersion}
                        emptyText={t.noChangeHere}
                      />
                    </div>
                    <div>
                      <div className="text-[9.5px] font-semibold text-[#4ff09d] mb-0.5">{t.whatGithubChanged}</div>
                      <TextDiffView
                        {...diffProps}
                        before={diffableText(baseValue)}
                        after={diffableText(shown(field.remote))}
                        beforeLabel={t.lastSync}
                        afterLabel={t.github}
                        emptyText={t.noChangeGithub}
                      />
                    </div>
                  </>
                ) : (
                  <TextDiffView
                    {...diffProps}
                    before={diffableText(shown(field.local))}
                    after={diffableText(shown(field.remote))}
                    beforeLabel={t.yourVersion}
                    afterLabel={t.github}
                  />
                )}
              </div>
            )
          }
          return (
            <div className="mb-1.5">
              {toggle}
              <div className={`grid gap-2 ${hasBase ? 'grid-cols-3' : 'grid-cols-2'}`}>
                {hasBase && (
                  <div>
                    <div className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70 mb-0.5">{t.lastSync}</div>
                    <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-pm-text-muted max-h-32 overflow-y-auto">
                      {renderValue(baseValue, t.empty)}
                    </pre>
                  </div>
                )}
                <div>
                  <div className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70 mb-0.5">{t.yourVersion}</div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-red-300/80 max-h-32 overflow-y-auto">
                    {renderValue(shown(field.local), t.empty)}
                  </pre>
                </div>
                <div>
                  <div className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70 mb-0.5">{t.github}</div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] text-[#4ff09d]/80 max-h-32 overflow-y-auto">
                    {renderValue(shown(field.remote), t.empty)}
                  </pre>
                </div>
              </div>
            </div>
          )
        })()
      )}

      {isMarkerField ? (
        <>
          <div className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70 mb-0.5">
            {t.result}
          </div>
          {field.field === 'markers' ? (
            <MarkerChips value={resultValue} catalog={markerCatalog} />
          ) : (
            <MarkerNoteLines value={resultValue} catalog={markerCatalog} />
          )}
        </>
      ) : editable ? (
        <>
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[9.5px] uppercase tracking-wide text-pm-text-muted/70">{t.result}</span>
            {/* De onde vem o que está na caixa — sem isto, "Result" com a sua
                versão e com a do GitHub eram indistinguíveis. */}
            <span
              className={`rounded px-1 text-[9px] ${
                resultSource === 'mine'
                  ? 'text-[#63b3ed] bg-[#007acc]/15'
                  : resultSource === 'github'
                    ? 'text-[#ffb08f] bg-[#f26b3a]/15'
                    : 'text-[#4ff09d] bg-[#4ff09d]/10'
              }`}
            >
              {{ mine: t.resultMine, github: t.resultGithub, edited: t.resultEdited }[resultSource]}
            </span>
          </div>
          {isAuthField && !revealAuth ? (
            // O auth na caixa de resultado vinha em texto puro (token,
            // senha, client secret) mesmo com o diff acima mascarado. Oculto
            // por padrão aqui também; pra editar, Mostrar.
            <>
              <pre className="w-full max-h-40 overflow-auto rounded border border-pm-border bg-pm-bg px-2 py-1.5 font-mono text-[10.5px] text-pm-text-secondary whitespace-pre-wrap break-words">
                {(() => {
                  try {
                    return formatFieldValue('auth', redactAuthForDisplay(value.trim() ? JSON.parse(value) : undefined)) || t.empty
                  } catch {
                    return '••••••'
                  }
                })()}
              </pre>
              <p className="mt-0.5 text-[10px] text-pm-text-muted/70">{t.authMaskedResult}</p>
            </>
          ) : (
            <textarea
              value={value}
              onChange={e => onDraftChange(e.target.value)}
              readOnly={readOnly}
              title={readOnly ? t.resultReadOnly : undefined}
              spellCheck={false}
              rows={Math.min(10, Math.max(2, value.split('\n').length))}
              className={`w-full rounded border bg-pm-bg px-2 py-1.5 font-mono text-[10.5px] text-pm-text outline-none resize-y ${
                error ? 'border-rose-500/60' : 'border-pm-border focus:border-[#007acc]/60'
              }`}
            />
          )}
          {error && <p className="mt-0.5 text-[10px] text-rose-400">{t.invalidJson(error)}</p>}
          {readOnly && <p className="mt-0.5 text-[10px] text-pm-text-muted/70">{t.resultReadOnly}</p>}
        </>
      ) : field.field === 'order' ? (
        // `order` é a sequência dos filhos, derivada — não há texto que
        // devolva o resultado pros nós certos.
        <p className="text-[10px] text-pm-text-muted/70">
          {t.orderNote}
        </p>
      ) : (
        <p className="text-[10px] text-pm-text-muted/70">
          {t.notEditable}
        </p>
      )}
      </>)}
    </div>
  )
}

export function SyncDiffDialog({
  open,
  nodes,
  pendingCollectionIds,
  base = null,
  collectionNames,
  markerCatalog = [],
  mode = 'pull',
  restoreCommit,
  initialConflictsOnly = false,
  extraConflictIds,
  baseVersionOf,
  lastChangeOf,
  onClose,
  onApply,
  onShowHistory,
  whoChangedItem,
  workspace,
}: Props) {
  const isPush = mode === 'push'
  const t = useSyncDiffStrings()
  const locale = useLanguage()
  const conflicts = useMemo(
    () => {
      const out = conflictingIds(nodes, pendingCollectionIds, base)
      for (const id of extraConflictIds ?? []) out.add(id)
      return out
    },
    [nodes, pendingCollectionIds, base, extraConflictIds]
  )
  // Quem mexeu em cada item — "novo no GitHub" e "apagado aqui" aparecem
  // iguais num diff de duas vias, e pedem decisões opostas.
  const statuses = useMemo(
    () => new Map(nodes.map(n => [n.id, classifyNode(n, base)])),
    [nodes, base]
  )

  // A chave reinicia a seleção quando um diff novo chega: sem isso ids de uma
  // comparação anterior continuariam marcados numa lista que já é outra.
  const diffKey = useMemo(() => nodes.map(n => `${n.id}:${n.change}`).join('|'), [nodes])
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(nodes, conflicts))

  // O filtro recorta o que se VÊ, nunca o que se aplica: o rodapé e o Apply
  // continuam contando a seleção inteira, porque é ela que vai pro disco.
  // Esconder itens selecionados do total faria o botão mentir.
  const startFilter = (): DiffFilter => ({ ...NO_FILTER, conflictsOnly: initialConflictsOnly })
  const [filter, setFilter] = useState<DiffFilter>(startFilter)

  // Diff novo (ou aberto por outro motivo): seleção e filtro recomeçam.
  const openKey = `${diffKey}#${initialConflictsOnly}`
  // Resultado do último Auto merge (null = não rodou neste diff).
  const [auto, setAuto] = useState<AutoMergeState | null>(null)
  const [autoBanner, setAutoBanner] = useState(false)
  const [autoRunning, setAutoRunning] = useState(false)
  // O que o Auto merge leva junto e não tem caixa na tela: o urlexport da
  // URL daqui (ver fieldMergePlan). Vale enquanto a mescla do item existir.
  const [autoExtras, setAutoExtras] = useState<OverrideMap>({})
  // Do "Merge" à mão: campos juntados dos dois lados e os que não deu pra
  // juntar (destacados no detalhe). Some quando o item volta a Mine/GitHub.
  const [mergeMarks, setMergeMarks] = useState<Record<string, { combined: string[]; conflicts: string[] }>>({})
  // Editor de três painéis: as caixinhas marcadas em cada campo (chave
  // `nodeId|campo`) e quantos conflitos ficaram sem decisão. Sem entrada
  // aqui, as marcas são deduzidas do texto (inferPicks).
  const [fieldPicks, setFieldPicks] = useState<Record<string, { picks: ChunkPick[]; unresolved: number }>>({})
  // Campos cujo resultado foi editado à mão (as caixinhas deixam de valer).
  const [manualFields, setManualFields] = useState<Set<string>>(new Set())

  const [appliedKey, setAppliedKey] = useState(openKey)
  if (appliedKey !== openKey) {
    setAppliedKey(openKey)
    setSelected(defaultSelection(nodes, conflicts))
    setFilter(startFilter())
    setAuto(null)
    setAutoBanner(false)
    setAutoExtras({})
    setMergeMarks({})
    setFieldPicks({})
    setManualFields(new Set())
  }

  const drag = useDraggableDialog()
  const resize = useResizableDialog('devflow_sync_diff_size', { minWidth: 640, minHeight: 420 })
  const split = useSplitRatio('devflow_sync_diff_split')
  const toggleMaximized = () => {
    // Maximizado ocupa a tela toda: o deslocamento do arrasto o tiraria dela.
    if (!resize.maximized) drag.reset()
    resize.toggleMaximized()
  }

  const [focusedId, setFocusedId] = useState<string | null>(null)

  // Resultado editado à mão na janela de diferença (prévia do aviso / da
  // Central): entra aqui como rascunho do campo, igual a digitar nesta tela —
  // marca o item, aparece como "editado" e dá pra voltar atrás. Os textos são
  // os reais (ver lib/sync/preparedMergeEdits). Só as deste workspace e
  // feitas sobre as MESMAS versões do campo (as daqui e do GitHub): se uma
  // mudou desde a prévia, a edição já não vale. Saem do store só ao aplicar.
  useEffect(() => {
    if (!open) return
    const byId = new Map(nodes.map(n => [n.id, n]))
    const prepared = preparedEditsFor(workspace, (id, fieldName) => {
      const node = byId.get(id)
      if (node?.change !== 'modified') return undefined
      const field = node.fields.find(f => f.field === fieldName)
      return field ? preparedEditStamp(diffableText(field.local), diffableText(field.remote)) : undefined
    })
    if (!prepared.length) return
    const seeded = draftsFromPreparedEdits(prepared, id => byId.get(id), {
      isEditable: isEditableField,
      format: formatFieldValue,
      inMine: id => !selected.has(id),
      canEditFromMine: id => canEditFromMine(byId.get(id)!),
    })
    const ids = Object.keys(seeded)
    if (!ids.length) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- edições de fora (store de módulo), lidas uma vez por abertura
    setDrafts(prev => {
      const next = { ...prev }
      for (const id of ids) next[id] = { ...(prev[id] ?? {}), ...seeded[id] }
      return next
    })
    setSelected(prev => new Set([...prev, ...ids]))
    // Caixinhas deixam de valer nos campos editados à mão.
    setManualFields(prev => {
      const next = new Set(prev)
      for (const edit of prepared) if (seeded[edit.itemId]?.[edit.field] !== undefined) next.add(`${edit.itemId}|${edit.field}`)
      return next
    })
    setFocusedId(ids[0])
    // Uma vez por abertura (openKey muda a cada comparação nova).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openKey])

  // Texto das caixas de resultado, por nó e campo. Guardado como TEXTO, não
  // como valor: enquanto o JSON está pela metade ele não converte, e perder o
  // que foi digitado a cada tecla inválida tornaria a edição inviável.
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  // Itens com "Merge" esperando a versão da última sincronização. Editar um
  // campo ou escolher um lado nesse meio-tempo cancela o preenchimento —
  // vale o que a pessoa fez.
  const pendingMerges = useRef(new Set<string>())

  /** Esquece as marcas do editor de três painéis — elas voltam a ser deduzidas do texto. */
  const dropFieldMarks = (keyMatches: (key: string) => boolean) => {
    setFieldPicks(prev => {
      const keys = Object.keys(prev).filter(keyMatches)
      if (!keys.length) return prev
      const next = { ...prev }
      for (const key of keys) delete next[key]
      return next
    })
    setManualFields(prev => {
      const keys = [...prev].filter(keyMatches)
      if (!keys.length) return prev
      const next = new Set(prev)
      for (const key of keys) next.delete(key)
      return next
    })
  }
  const dropNodeMarks = (nodeIds: string[]) => dropFieldMarks(key => nodeIds.some(id => key.startsWith(`${id}|`)))

  const setDraft = (nodeId: string, field: string, text: string | undefined) => {
    pendingMerges.current.delete(nodeId)
    dropFieldMarks(key => key === `${nodeId}|${field}`)
    setDrafts(prev => {
      const node = { ...(prev[nodeId] ?? {}) }
      if (text === undefined) delete node[field]
      else node[field] = text
      const next = { ...prev }
      if (Object.keys(node).length === 0) delete next[nodeId]
      else next[nodeId] = node
      return next
    })
    // A URL editada à mão não pode levar o urlexport que o Auto merge
    // guardou pra URL de antes.
    if (field === 'url') dropAutoExtras([nodeId])
    // Editar é decisão mais forte que a caixinha: marca o nó, pra ninguém
    // acabar editando algo que não seria aplicado.
    if (text !== undefined) setSelected(prev => (prev.has(nodeId) ? prev : new Set(prev).add(nodeId)))
  }

  // Editar um campo com o item em Mine. Mesclar parte da versão do GitHub, e
  // antes a edição de UM campo trocava o item inteiro pra ela: os outros
  // campos que você mudou sumiam sem aviso. Agora os campos editáveis
  // começam com o seu valor, e só o campo mexido muda.
  // Só dá quando tudo o que difere tem caixa (ver canEditFromMine); senão a
  // caixa fica só pra leitura em Mine.
  const canEditFromMine = (node: DiffNode) =>
    !!node.local && !!node.remote &&
    node.fields.every(f => isEditableField(f.field)) &&
    sameContent(restOf(node.local), restOf(node.remote))
  /** `false` = não deu pra editar (item em Mine sem poder virar Merge). */
  const editField = (node: DiffNode, field: string, text: string | undefined): boolean => {
    if (choiceOf(node.id) !== 'mine' || drafts[node.id]) {
      setDraft(node.id, field, text)
      return true
    }
    if (!canEditFromMine(node)) return false
    dropNodeMarks([node.id])
    const seed: Record<string, string> = {}
    for (const f of node.fields) seed[f.field] = formatFieldValue(f.field, f.local)
    if (text === undefined) delete seed[field]
    else seed[field] = text
    pendingMerges.current.delete(node.id)
    setDrafts(prev => ({ ...prev, [node.id]: seed }))
    // A URL daqui leva junto o urlexport (ver fieldMergePlan).
    if (seed.url !== undefined && node.local?.request?.urlexport) {
      setAutoExtras(prev => ({ ...prev, [node.id]: { urlexport: node.local!.request!.urlexport } }))
    }
    setSelected(prev => (prev.has(node.id) ? prev : new Set(prev).add(node.id)))
    return true
  }

  // ── Editor de três painéis ─────────────────────────────────────────────
  // Marcar um trecho monta o texto do campo (composeMerge) e grava como
  // rascunho, pelo mesmo caminho de editar a caixa (editField). As marcas
  // ficam guardadas pra a tela mostrar o que foi escolhido e quantos
  // conflitos faltam.
  const markKey = (nodeId: string, field: string) => `${nodeId}|${field}`
  const pickChunks = (node: DiffNode, field: string, chunks: MergeChunk[], picks: ChunkPick[], crlf: boolean) => {
    const composed = composeMerge(chunks, picks, crlf)
    if (!editField(node, field, composed.text)) return
    const key = markKey(node.id, field)
    // Depois do editField (que limpa as marcas do campo): as atualizações
    // de estado rodam em ordem, então estas ficam.
    setFieldPicks(prev => ({ ...prev, [key]: { picks, unresolved: composed.unresolved } }))
  }
  const editMergeResult = (node: DiffNode, field: string, text: string) => {
    if (!editField(node, field, text)) return
    const key = markKey(node.id, field)
    setManualFields(prev => (prev.has(key) ? prev : new Set(prev).add(key)))
  }

  // Escolher Mine ou GitHub descarta a mescla à mão daquele item: senão a
  // edição ficaria guardada e invisível, pronta pra voltar num clique errado.
  const dropAutoExtras = (nodeIds: string[]) =>
    setAutoExtras(prev => {
      if (!nodeIds.some(id => prev[id])) return prev
      const next = { ...prev }
      for (const id of nodeIds) delete next[id]
      return next
    })
  const clearDrafts = (nodeIds: string[]) => {
    for (const id of nodeIds) pendingMerges.current.delete(id)
    dropNodeMarks(nodeIds)
    setMergeMarks(prev => {
      if (!nodeIds.some(id => prev[id])) return prev
      const next = { ...prev }
      for (const id of nodeIds) delete next[id]
      return next
    })
    setDrafts(prev => {
      if (!nodeIds.some(id => prev[id])) return prev
      const next = { ...prev }
      for (const id of nodeIds) delete next[id]
      return next
    })
    dropAutoExtras(nodeIds)
  }
  const choose = (nodeIds: string[], side: 'mine' | 'github') => {
    clearDrafts(nodeIds)
    setSelected(prev => {
      const next = new Set(prev)
      for (const id of nodeIds) {
        if (side === 'github') next.add(id)
        else next.delete(id)
      }
      return next
    })
  }
  const choiceOf = (nodeId: string): Choice =>
    !selected.has(nodeId) ? 'mine' : drafts[nodeId] ? 'merged' : 'github'
  const canMerge = (node: DiffNode) =>
    node.change === 'modified' && node.fields.some(f => isEditableField(f.field))

  // Valor do campo na última sincronização (ver baseRoots acima).
  const baseOfField = (node: DiffNode, field: FieldDiff): FieldRowProps['base'] => {
    if (!baseVersionOf) return 'unavailable'
    const root = baseRoots[`${diffKey}|${node.rootId}`]
    if (root === undefined) return 'loading'
    if (root === null || !(MERGE_FIELDS as readonly string[]).includes(field.field)) return 'unavailable'
    const baseNode = findItem(root, node.id)
    return baseNode ? { value: fieldValue(baseNode, field.field as MergeField) } : 'absent'
  }

  const originOfField = (node: DiffNode, field: FieldDiff): FieldOrigin | undefined =>
    field.field === 'order' ? undefined : fieldOrigin(base, node.id, field.field, field.local, field.remote)

  // Mesclar = a versão do GitHub com os campos que SÓ VOCÊ mudou por cima, e
  // os mudados dos dois lados já juntados quando dá (merge de três vias, o
  // mesmo do Auto merge). Antes um body mudado dos dois lados começava igual
  // ao do GitHub, e quem confirmava sem editar perdia o próprio lado.
  // O que não deu pra juntar fica destacado no campo.
  const startMerge = async (node: DiffNode) => {
    setFocusedId(node.id)
    setSelected(prev => (prev.has(node.id) ? prev : new Set(prev).add(node.id)))
    if (drafts[node.id] || pendingMerges.current.has(node.id)) return
    pendingMerges.current.add(node.id)
    const root = await loadBaseRoot(node.rootId)
    if (!pendingMerges.current.delete(node.id)) return
    const baseItem = root === undefined || root === null ? undefined : findItem(root, node.id) ?? null
    const prefill = mergePrefill(node, base, baseItem)
    const fields: Record<string, string> = {}
    const extras: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(prefill.overrides)) {
      if (isEditableField(field)) fields[field] = formatFieldValue(field, value)
      else extras[field] = value
    }
    // Campo de texto que não deu pra juntar sozinho: abre no editor de três
    // painéis com o conflito pendente (o Apply espera a decisão), em vez de
    // ficar com a versão do GitHub sem avisar.
    const picksNow: Record<string, { picks: ChunkPick[]; unresolved: number }> = {}
    for (const field of prefill.conflicts) {
      const diff = node.fields.find(f => f.field === field)
      if (!diff || !TEXT_MERGE_FIELDS.has(field)) continue
      const baseText = baseItem ? diffableText(fieldValue(baseItem, field as MergeField)) : null
      const chunks = mergeChunks(baseText, diffableText(diff.local), diffableText(diff.remote))
      if (!chunks) continue
      const picks = defaultPicks(chunks)
      const composed = composeMerge(chunks, picks, diffableText(diff.local).includes('\r\n'))
      fields[field] = composed.text
      picksNow[markKey(node.id, field)] = { picks, unresolved: composed.unresolved }
    }
    dropNodeMarks([node.id])
    if (Object.keys(picksNow).length) setFieldPicks(prev => ({ ...prev, ...picksNow }))
    setDrafts(prev => (prev[node.id] ? prev : { ...prev, [node.id]: fields }))
    if (Object.keys(extras).length) setAutoExtras(prev => ({ ...prev, [node.id]: extras }))
    setMergeMarks(prev => ({ ...prev, [node.id]: { combined: prefill.combined, conflicts: prefill.conflicts } }))
  }

  // Quem mexeu no GitHub, e quando — pela collection raiz do item focado
  // (o arquivo remoto é por raiz). Uma busca por raiz, guardada.
  // Ausente do mapa = ainda buscando (ou nunca pedido). A busca em curso
  // fica num ref, pra o efeito não disparar duas vezes a mesma.
  const [lastChanges, setLastChanges] = useState<Record<string, RemoteChange | null>>({})
  const lastChangeInFlight = useRef(new Set<string>())
  // Chave inclui o diff: uma comparação nova pode ter outro "último commit".
  const focusedRoot = nodes.find(n => n.id === focusedId)?.rootId ?? null
  const lastChangeKey = focusedRoot ? `${diffKey}|${focusedRoot}` : null
  useEffect(() => {
    if (!lastChangeOf || !focusedRoot || !lastChangeKey) return
    if (lastChanges[lastChangeKey] !== undefined || lastChangeInFlight.current.has(lastChangeKey)) return
    lastChangeInFlight.current.add(lastChangeKey)
    lastChangeOf(focusedRoot)
      .then(info => setLastChanges(prev => ({ ...prev, [lastChangeKey]: info })))
      .catch(() => setLastChanges(prev => ({ ...prev, [lastChangeKey]: null })))
  }, [focusedRoot, lastChangeKey, lastChangeOf, lastChanges])

  // Versão da última sincronização da collection do item focado — uma busca
  // por raiz, guardada (mesma ideia do lastChanges acima).
  const [baseRoots, setBaseRoots] = useState<Record<string, CollectionItem | null>>({})
  // Uma busca por raiz, compartilhada entre o item focado, o Merge e o Auto
  // merge — antes os dois últimos podiam ler (e decifrar) o mesmo arquivo de
  // novo enquanto a primeira busca ainda corria.
  const baseRequests = useRef(new Map<string, Promise<CollectionItem | null>>())
  /** A raiz na última sincronização; `undefined` = esta revisão não tem como saber. */
  const loadBaseRoot = (rootId: string): Promise<CollectionItem | null | undefined> => {
    if (!baseVersionOf) return Promise.resolve(undefined)
    const key = `${diffKey}|${rootId}`
    if (baseRoots[key] !== undefined) return Promise.resolve(baseRoots[key])
    let request = baseRequests.current.get(key)
    if (!request) {
      request = baseVersionOf(rootId).catch(() => null)
      baseRequests.current.set(key, request)
      void request.then(root => setBaseRoots(prev => ({ ...prev, [key]: root })))
    }
    return request
  }
  useEffect(() => {
    if (focusedRoot) void loadBaseRoot(focusedRoot)
    // loadBaseRoot muda a cada render; o que importa é a raiz e o diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedRoot, diffKey, baseVersionOf])

  // "Quem mudou este item?" — sob demanda (lê várias versões do arquivo).
  const [whoChanged, setWhoChanged] = useState<
    Record<string, 'loading' | { change: ItemChange | null; searched: number } | null>
  >({})
  const askWhoChanged = (node: DiffNode) => {
    if (!whoChangedItem) return
    const key = `${diffKey}|${node.id}`
    if (whoChanged[key]) return
    setWhoChanged(prev => ({ ...prev, [key]: 'loading' }))
    whoChangedItem(node.rootId, node.id)
      .then(result => setWhoChanged(prev => ({ ...prev, [key]: result })))
      .catch(() => setWhoChanged(prev => ({ ...prev, [key]: null })))
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

  // O que vai pro Apply: as caixas + o que o Auto merge leva sem caixa (só
  // enquanto a mescla daquele item continuar de pé).
  const appliedOverrides = useMemo(() => {
    const out: OverrideMap = { ...overrides }
    for (const [id, extra] of Object.entries(autoExtras)) {
      if (drafts[id]) out[id] = { ...(out[id] ?? {}), ...extra }
    }
    return out
  }, [overrides, autoExtras, drafts])

  const errorCount = Object.values(errors).reduce((acc, f) => acc + Object.keys(f).length, 0)
  // Conflitos sem decisão no editor de três painéis, nos itens em Merge: o
  // texto deles ainda tem a linha da base no lugar do conflito, então o
  // Apply espera (como o "Accept merge" do Visual Studio).
  const unresolvedCount =
    Object.entries(fieldPicks).reduce((acc, [key, { unresolved }]) => {
      const [nodeId, field] = key.split('|')
      return choiceOf(nodeId) === 'merged' && drafts[nodeId]?.[field] !== undefined ? acc + unresolved : acc
    }, 0) +
    // Editado à mão: o conflito pendente fica marcado no texto
    // (composeForEditing) e conta até a marca sair.
    [...manualFields].reduce((acc, key) => {
      const [nodeId, field] = key.split('|')
      const draft = drafts[nodeId]?.[field]
      return choiceOf(nodeId) === 'merged' && draft !== undefined ? acc + conflictMarkerCount(draft) : acc
    }, 0)
  const focused = nodes.find(n => n.id === focusedId) ?? null

  // Trechos do editor de três painéis, por campo de texto do item aberto.
  // Memorizado: a comparação é linha a linha (LCS) e não precisa refazer a
  // cada tecla. 'loading' = esperando a versão da última sincronização.
  const focusedChunks = useMemo(() => {
    const out = new Map<string, { chunks: MergeChunk[]; twoWay: boolean } | 'loading'>()
    if (!focused || focused.change !== 'modified') return out
    for (const field of focused.fields) {
      if (!TEXT_MERGE_FIELDS.has(field.field)) continue
      const known = baseOfField(focused, field)
      if (known === 'loading') {
        out.set(field.field, 'loading')
        continue
      }
      // Sem base = merge de duas vias (toda diferença é decisão); item que
      // não existia na base = base vazia.
      const baseText = typeof known === 'object' ? diffableText(known.value) : known === 'absent' ? '' : null
      const chunks = mergeChunks(baseText, diffableText(field.local), diffableText(field.remote))
      if (chunks) out.set(field.field, { chunks, twoWay: baseText === null })
    }
    return out
    // baseOfField lê baseRoots/diffKey/baseVersionOf, que estão na lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, baseRoots, diffKey, baseVersionOf])

  /** O editor de três painéis de um campo do item aberto (ou nada, se não se aplica). */
  const mergeEditorFor = (node: DiffNode, field: FieldDiff): React.ReactNode => {
    const entry = focusedChunks.get(field.field)
    if (!entry) return undefined
    if (entry === 'loading') return <p className="text-[10px] text-pm-text-muted/70">{t.loadingLastSync}</p>
    const { chunks, twoWay } = entry
    const key = markKey(node.id, field.field)
    const choice = choiceOf(node.id)
    const draft = drafts[node.id]?.[field.field]
    const local = diffableText(field.local)
    const crlf = local.includes('\r\n')
    // Marcas: as guardadas; senão, as que reproduzem o texto atual (a sua
    // versão em Minha, a do GitHub sem rascunho, ou o rascunho); senão o
    // texto foi editado à mão.
    const picks = manualFields.has(key)
      ? null
      : fieldPicks[key]?.picks ??
        (draft === undefined ? sidePicks(chunks, choice === 'mine' ? 'mine' : 'theirs') : inferPicks(chunks, draft))
    const manualText = draft ?? (choice === 'mine' ? local : diffableText(field.remote))
    return (
      <ThreeWayMergeView
        chunks={chunks}
        picks={picks}
        manualText={manualText}
        twoWay={twoWay}
        readOnly={choice === 'mine' && !canEditFromMine(node)}
        crlf={crlf}
        onPicks={next => pickChunks(node, field.field, chunks, next, crlf)}
        onManualText={text => editMergeResult(node, field.field, text)}
        onBackToBoxes={() => pickChunks(node, field.field, chunks, defaultPicks(chunks), crlf)}      />
    )
  }

  // "Conflitos" = o que pede decisão: fora o que é só seu (origem "here"),
  // que já fica em Minha e segue no push sem perguntar nada.
  const decisionIds = useMemo(
    () => new Set([...conflicts].filter(id => statuses.get(id)?.origin !== 'here')),
    [conflicts, statuses]
  )
  // Depois do Auto merge, "Conflitos" passa a ser só o que ele não resolveu.
  const pendingDecisionIds = useMemo(() => {
    if (!auto) return decisionIds
    return new Set([...decisionIds].filter(id => {
      const resolution = auto.resolutions.get(id)
      return !resolution || resolution.kind === 'conflict'
    }))
  }, [auto, decisionIds])
  const filtering = isFiltering(filter)
  const visible = useMemo(() => applyFilter(nodes, pendingDecisionIds, filter), [nodes, pendingDecisionIds, filter])
  const hidden = nodes.length - visible.length

  const groups = useMemo(() => groupByRoot(visible), [visible])
  const summary = summarize(nodes, selected, conflicts)
  // Esc fecha a revisão e, no push, cancela o envio: com escolhas ou merges
  // feitos, o primeiro Esc só avisa; o segundo (em até 4s) fecha.
  const initialSelection = useMemo(() => defaultSelection(nodes, conflicts), [nodes, conflicts])
  const dirty =
    Object.keys(drafts).length > 0 ||
    auto !== null ||
    selected.size !== initialSelection.size ||
    [...selected].some(id => !initialSelection.has(id))
  const [escArmed, setEscArmed] = useState(false)
  useEffect(() => {
    if (!escArmed) return
    const timer = setTimeout(() => setEscArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [escArmed])
  const onEscapeKeyDown = (e: KeyboardEvent) => {
    if (!dirty || escArmed) return
    e.preventDefault()
    setEscArmed(true)
  }

  // "Descartam trabalho local" = só o que vai com a versão do GitHub inteira.
  // O item em Merge leva a sua parte junto — contá-lo aqui fazia o rodapé
  // avisar de perda justamente no item que foi mesclado pra não perder nada.
  const discardCount = nodes.filter(n => conflicts.has(n.id) && choiceOf(n.id) === 'github').length
  // Contagens do que está na TELA: a barra fala dos botões logo ao lado dela,
  // e eles agem sobre o visível.
  const risk = countByRisk(visible, conflicts)
  const origins = countByOrigin(visible, statuses, conflicts)
  const decideCount = auto ? visible.filter(n => pendingDecisionIds.has(n.id)).length : origins.decide

  // A marca "auto" e o destaque de conflito só valem enquanto a escolha do
  // item continuar a que o Auto merge fez — mexer à mão tira a marca.
  const autoResolutionOf = (nodeId: string): NodeResolution | undefined => {
    const resolution = auto?.resolutions.get(nodeId)
    if (!resolution || resolution.kind === 'conflict') return resolution
    return resolution.kind === choiceOf(nodeId) ? resolution : undefined
  }
  const fieldLabel = (field: string) => (field === REST ? t.restField : field)

  // Auto merge: resolve o que dá sem adivinhar (lib/sync/autoMerge) e deixa
  // só o conflito real. Age sobre o que está na lista, como os outros
  // atalhos, e não toca em item que a pessoa já mesclou à mão. Só mexe na
  // seleção e nas caixas de Merge: nada sai sem o botão de confirmar.
  const runAutoMerge = async () => {
    if (autoRunning) return
    setAutoRunning(true)
    try {
      const scope = visible.filter(n => !drafts[n.id])
      // A versão da última sincronização, das collections com item mudado
      // dos dois lados — é ela que deixa juntar o body linha a linha.
      const roots = baseVersionOf
        ? [...new Set(scope.filter(n => decisionIds.has(n.id) && n.change === 'modified').map(n => n.rootId))]
        : []
      const loaded: Record<string, CollectionItem | null> = {}
      await Promise.all(roots.map(async rootId => {
        loaded[rootId] = (await loadBaseRoot(rootId)) ?? null
      }))

      const result = autoMerge(scope, {
        conflicts,
        base,
        baseItemOf: node => {
          const root = loaded[node.rootId]
          if (!root) return undefined
          return findItem(root, node.id) ?? null
        },
      })

      const nextDrafts: Record<string, Record<string, string>> = {}
      const nextExtras: OverrideMap = {}
      for (const [id, resolution] of result.resolutions) {
        if (resolution.kind !== 'merged') continue
        const fields: Record<string, string> = {}
        for (const [field, value] of Object.entries(resolution.overrides)) {
          if (isEditableField(field)) fields[field] = formatFieldValue(field, value)
          else nextExtras[id] = { ...(nextExtras[id] ?? {}), [field]: value }
        }
        nextDrafts[id] = fields
      }
      const scopeIds = scope.map(n => n.id)
      // O Auto merge assume estes itens: um Merge à mão ainda carregando
      // não pode chegar depois e passar por cima.
      for (const id of scopeIds) pendingMerges.current.delete(id)
      dropNodeMarks(scopeIds)
      setMergeMarks(prev => {
        const next = { ...prev }
        for (const id of scopeIds) delete next[id]
        return next
      })
      setDrafts(prev => ({ ...prev, ...nextDrafts }))
      setAutoExtras(prev => {
        const next = { ...prev }
        for (const id of scopeIds) delete next[id]
        return { ...next, ...nextExtras }
      })
      setSelected(prev => selectionAfter(prev, result.resolutions))
      setAuto({
        resolutions: new Map([...(auto?.resolutions ?? []), ...result.resolutions]),
        summary: result.summary,
        skipped: visible.length - scope.length,
        baseFailed: roots.some(r => loaded[r] === null),
      })
      setAutoBanner(true)

      // O que sobrou fica à vista: filtro de conflitos e o primeiro aberto.
      const firstConflict = result.summary.conflicts[0]
      if (firstConflict) {
        setFilter(f => ({ ...f, conflictsOnly: true }))
        setFocusedId(firstConflict)
      } else {
        setFilter(f => (f.conflictsOnly ? { ...f, conflictsOnly: false } : f))
      }
    } finally {
      setAutoRunning(false)
    }
  }

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
        onEscapeKeyDown={onEscapeKeyDown}
        {...drag.contentProps}
        style={{ ...drag.contentProps.style, ...resize.style }}
        className={`bg-pm-bg border border-pm-border text-pm-text sm:max-w-4xl max-h-[85vh] p-0 flex flex-col overflow-hidden rounded-lg gap-0 ${resize.resizing || split.dragging ? 'select-none' : ''}`}
      >
        {/* Alças de tamanho: as quatro bordas e os cantos. Ficam por cima do
            conteúdo (z-10) e são finas o bastante pra não roubar o clique
            dos botões do cabeçalho e do rodapé. */}
        {RESIZE_HANDLES.map(({ edge, className }) => (
          <div key={edge} {...resize.handleProps(edge)} title={t.resizeTitle}
            className={`absolute z-10 hover:bg-[#007acc]/30 ${className}`} />
        ))}
        <div {...resize.handleProps('se')} title={t.resizeTitle}
          className="absolute bottom-0 right-0 z-20 h-3.5 w-3.5 cursor-nwse-resize">
          <svg viewBox="0 0 10 10" className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 text-pm-text-muted/70">
            <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
        <div
          {...drag.handleProps}
          onDoubleClick={drag.reset}
          title={t.dragTitle}
          className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-pm-border select-none"
        >
          <DialogTitle className="text-sm font-semibold text-pm-text">
            {restoreCommit ? t.titleRestore(restoreCommit) : isPush ? t.titlePush : t.titlePull}
          </DialogTitle>
          {onShowHistory && (
            <button
              onClick={onShowHistory}
              className="ml-auto mr-1 h-7 px-2 rounded-md text-[11px] text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
            >
              {t.historyButton}
            </button>
          )}
          <button
            onClick={toggleMaximized}
            title={resize.maximized ? t.restore : t.maximize}
            aria-label={resize.maximized ? t.restore : t.maximize}
            className={`${onShowHistory ? '' : 'ml-auto '}mr-1 h-7 w-7 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer`}
          >
            {resize.maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            onClick={onClose}
            title={t.close}
            className="h-7 w-7 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        {/* Quem chegou aqui clicando em Push não pediu pra revisar nada — sem
            esta linha, a tela parece um pull no meio do caminho e não fica
            claro que o envio continua depois. */}
        {isPush && nodes.length > 0 && (
          <div className="shrink-0 flex items-start gap-2 px-4 py-2 border-b border-pm-border bg-[#007acc]/10 text-[11px] text-[#9fd3f7] leading-snug">
            <AlertTriangle size={12} className="mt-px shrink-0" />
            <span>{t.pushBanner()}</span>
          </div>
        )}

        {nodes.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-16 text-xs text-pm-text-muted">
            {t.allMatch}
          </div>
        ) : (
          <>
          {/* Com centenas de itens, revisar um a um não é opção. Esta linha diz
              quanto é seguro e quanto precisa de decisão, e deixa voltar
              rapidamente a cada recorte. */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-pm-border bg-pm-hover/30 text-[11px]">
            <span className="text-pm-text-secondary" title={t.fromGithubTitle}>
              <span className="text-[#4ff09d] font-semibold">{origins.github}</span> {t.fromGithub}
            </span>
            {origins.here > 0 && (
              <span
                className="text-pm-text-secondary"
                title={t.yoursTitle}
              >
                <span className="text-[#63b3ed] font-semibold">{origins.here}</span> {t.yours}
              </span>
            )}
            {decideCount > 0 && (
              <span className="text-pm-text-secondary" title={t.needDecisionTitle}>
                <span className="text-amber-400 font-semibold">{decideCount}</span> {t.needDecision}
              </span>
            )}
            {hidden > 0 && (
              <span className="text-pm-text-muted">{t.hiddenByFilter(hidden)}</span>
            )}

            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => { void runAutoMerge() }}
                disabled={autoRunning || visible.length === 0}
                title={t.autoMergeTitle}
                className="flex items-center gap-1 rounded-md border border-[#4ff09d]/40 bg-[#4ff09d]/10 px-2 py-1 text-[10.5px] font-semibold text-[#4ff09d] hover:bg-[#4ff09d]/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Sparkles size={11} />
                {autoRunning ? t.autoMerging : t.autoMerge}
              </button>
              <button
                // Limpa os merges do que está na lista, como "Tudo GitHub" e
                // "Tudo meu": senão o item voltava a Minha com o texto do
                // Merge guardado e invisível, pronto pra voltar num clique.
                onClick={() => { clearDrafts(visible.map(n => n.id)); setSelected(prev => selectWithin(prev, visible, 'safe', conflicts)) }}
                disabled={risk.safe === 0}
                title={t.safeDefaultsTitle}
                className="rounded px-2 py-1 text-[10.5px] text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer border-none bg-transparent disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t.safeDefaults}
              </button>
              <button
                onClick={() => { clearDrafts(visible.map(n => n.id)); setSelected(prev => selectWithin(prev, visible, 'all')) }}
                title={t.allGithubTitle}
                className="rounded px-2 py-1 text-[10.5px] text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer border-none bg-transparent"
              >
                {t.allGithub}
              </button>
              <button
                onClick={() => { clearDrafts(visible.map(n => n.id)); setSelected(prev => selectWithin(prev, visible, 'none')) }}
                title={t.allMineTitle}
                className="rounded px-2 py-1 text-[10.5px] text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer border-none bg-transparent"
              >
                {t.allMine}
              </button>
            </div>
          </div>

          {/* Resumo do Auto merge: o que ele resolveu e o que sobrou. */}
          {auto && autoBanner && (() => {
            const left = auto.summary.conflicts.length
            return (
              <div
                className={`shrink-0 flex items-start gap-2 px-3 py-1.5 border-b border-pm-border text-[11px] leading-snug ${
                  left > 0 ? 'bg-amber-500/10 text-amber-200' : 'bg-[#4ff09d]/10 text-[#b5f5d3]'
                }`}
              >
                {left > 0
                  ? <AlertTriangle size={12} className="mt-px shrink-0 text-amber-400" />
                  : <Check size={12} className="mt-px shrink-0 text-[#4ff09d]" />}
                <span className="flex-1">
                  {t.autoMergeSummary(auto.summary)}{' '}
                  <span className="font-semibold">{left > 0 ? t.autoMergeConflictsLeft(left) : t.autoMergeNoConflicts}</span>
                  {auto.skipped > 0 && <span className="opacity-80"> {t.autoMergeSkipped(auto.skipped)}</span>}
                  {auto.baseFailed && <span className="block opacity-80">{t.autoMergeFailed}</span>}
                </span>
                {left > 0 && !filter.conflictsOnly && (
                  <button
                    onClick={() => setFilter(f => ({ ...f, conflictsOnly: true }))}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-300 hover:bg-amber-500/15 cursor-pointer border-none bg-transparent"
                  >
                    {t.showConflicts}
                  </button>
                )}
                <button
                  onClick={() => setAutoBanner(false)}
                  title={t.dismiss}
                  aria-label={t.dismiss}
                  className="shrink-0 h-5 w-5 flex items-center justify-center rounded text-current opacity-70 hover:opacity-100 hover:bg-pm-hover cursor-pointer border-none bg-transparent"
                >
                  <X size={11} />
                </button>
              </div>
            )
          })()}

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
                placeholder={t.filterPlaceholder}
                spellCheck={false}
                className="w-full h-7 rounded-md border border-pm-border bg-pm-bg pl-7 pr-2 text-[11px] text-pm-text placeholder:text-pm-text-muted outline-none focus:border-[#007acc]/60"
              />
            </div>

            <select
              value={filter.change}
              onChange={e => setFilter(f => ({ ...f, change: e.target.value as ChangeFilter }))}
              className="h-7 rounded-md border border-pm-border bg-pm-bg px-1.5 text-[11px] text-pm-text outline-none cursor-pointer focus:border-[#007acc]/60"
            >
              <option value="all">{t.anyChange}</option>
              <option value="modified">{t.changedOption}</option>
              <option value="added">{t.onlyOnGithubOption}</option>
              <option value="removed">{t.onlyHereOption}</option>
            </select>

            <button
              onClick={() => setFilter(f => ({ ...f, conflictsOnly: !f.conflictsOnly }))}
              title={t.conflictsTitle}
              className={`h-7 flex items-center gap-1 rounded-md border px-2 text-[11px] transition-colors cursor-pointer ${
                filter.conflictsOnly
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                  : 'border-pm-border bg-transparent text-pm-text-secondary hover:bg-pm-hover'
              }`}
            >
              <AlertTriangle size={11} />
              {t.conflicts}
            </button>

            {filtering && (
              <button
                onClick={() => setFilter(NO_FILTER)}
                className="h-7 px-2 rounded-md text-[11px] text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer border-none bg-transparent"
              >
                {t.clear}
              </button>
            )}
          </div>

          <div ref={split.containerRef} className="flex-1 flex min-h-[320px] overflow-hidden">
            {/* Lista */}
            <div
              // A fração salva vale pra largura de agora; os mínimos de cada
              // lado (useSplitRatio) seguem valendo quando a janela encolhe.
              style={{
                width: `${split.ratio * 100}%`,
                minWidth: `min(${MIN_LEFT}px, 45%)`,
                maxWidth: `calc(100% - min(${MIN_RIGHT}px, 55%))`,
              }}
              className="shrink-0 overflow-y-auto p-2 flex flex-col gap-2"
            >
              {visible.length === 0 && (
                <p className="px-2 py-6 text-center text-[11px] text-pm-text-muted">
                  {t.nothingMatches}
                </p>
              )}
              {[...groups.entries()].map(([rootId, rootNodes]) => {
                const state = rootState(selected, visible, rootId)
                const name = collectionNames.get(rootId) ?? rootNodes[0]?.path[0] ?? rootId
                const rootPending = pendingCollectionIds.has(rootId)
                return (
                  <div key={rootId} className="rounded-md border border-pm-border/70 bg-pm-hover/30">
                    <div className="flex items-center gap-2 px-2.5 py-2">
                      <Folder size={13} className="text-pm-text-muted shrink-0" />
                      <span className="text-xs font-semibold text-pm-text truncate flex-1">{name}</span>
                      {rootPending && (
                        <span
                          title={t.rootPendingTitle}
                          className="shrink-0 w-[6px] h-[6px] rounded-full bg-amber-400"
                        />
                      )}
                      <span className="text-[10px] tabular-nums text-pm-text-muted shrink-0">
                        {rootNodes.length}
                      </span>
                      {/* A collection inteira de uma vez. Misturado = nenhum
                          dos dois acende; clicar põe tudo daquele lado. */}
                      <ChoiceToggle
                        choice={state === 'all' ? 'github' : state === 'none' ? 'mine' : 'mixed'}
                        onMine={() => choose(nodesOfRoot(visible, rootId).map(n => n.id), 'mine')}
                        onGitHub={() => choose(nodesOfRoot(visible, rootId).map(n => n.id), 'github')}
                      />
                    </div>

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
                            const nodeStatus = statuses.get(node.id)
                            const style = styleOf(node, nodeStatus)
                            const isYours = conflicts.has(node.id) && nodeStatus?.origin === 'here'
                            const autoResolution = autoResolutionOf(node.id)
                            const realConflict = autoResolution?.kind === 'conflict'
                            // Depois do Auto merge, o aviso fica só no que ele não resolveu.
                            const isConflict = conflicts.has(node.id) && !isYours && (!auto || pendingDecisionIds.has(node.id))
                            return (
                              <div
                                key={node.id}
                                onClick={() => setFocusedId(node.id)}
                                title={`${node.path.join(' / ')} — ${nodeStatus ? t.status[nodeStatus.key].label : ''}`}
                                className={`flex items-center gap-2 px-2.5 py-1 cursor-pointer border-l-2 ${
                                  realConflict ? 'border-amber-400' : 'border-transparent'
                                } ${
                                  focusedId === node.id ? 'bg-pm-row-active' : realConflict ? 'bg-amber-500/10 hover:bg-amber-500/15' : 'hover:bg-pm-hover'
                                }`}
                              >
                                <style.Icon size={11} className={`${style.color} shrink-0`} />
                                {node.kind === 'folder'
                                  ? <Folder size={11} className="text-pm-text-muted shrink-0" />
                                  : <FileText size={11} className="text-pm-text-muted shrink-0" />}
                                <span className="text-[11px] text-pm-text truncate flex-1">
                                  {labelOf(node).name}
                                </span>
                                {isYours && (
                                  <span
                                    className="shrink-0 rounded px-1 text-[9px] uppercase tracking-wide text-[#63b3ed] bg-[#007acc]/15"
                                    aria-label={t.yoursTagLabel}
                                  >
                                    {t.yoursTag}
                                  </span>
                                )}
                                {autoResolution && autoResolution.kind !== 'conflict' && (
                                  <span
                                    title={t.autoTagTitle}
                                    className="shrink-0 inline-flex items-center gap-0.5 rounded px-1 text-[9px] uppercase tracking-wide text-[#4ff09d] bg-[#4ff09d]/10"
                                  >
                                    <Sparkles size={8} />
                                    {t.autoTag}
                                  </span>
                                )}
                                {isConflict && (
                                  <AlertTriangle
                                    size={11}
                                    className="text-amber-400 shrink-0"
                                    aria-label={t.conflictLabel}
                                  />
                                )}
                                <ChoiceToggle
                                  choice={choiceOf(node.id)}
                                  onMine={() => choose([node.id], 'mine')}
                                  onGitHub={() => choose([node.id], 'github')}
                                  onMerge={canMerge(node) ? () => startMerge(node) : undefined}
                                />
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

            {/* Divisória: arrastar (ou as setas, com foco nela) muda a largura
                dos dois painéis; duplo clique volta ao meio. A área de pegar
                tem 10px, mas a linha visível continua de 1px. A área avança
                só sobre o padding do painel de merge (margem negativa à
                direita): à esquerda fica a barra de rolagem da lista. */}
            <div
              {...split.handleProps}
              title={t.splitterTitle}
              aria-label={t.splitterTitle}
              className="group relative z-[5] -mr-2 w-2.5 shrink-0 cursor-col-resize outline-none"
            >
              <div
                className={`absolute inset-y-0 left-0 w-px transition-colors ${
                  split.dragging
                    ? 'w-0.5 bg-[#007acc]'
                    : 'bg-pm-border group-hover:w-0.5 group-hover:bg-[#007acc]/70 group-focus-visible:w-0.5 group-focus-visible:bg-[#007acc]'
                }`}
              />
              {/* Puxador no meio: mostra que a linha se arrasta. */}
              <div
                className={`absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-[3px] rounded-sm border px-[2px] py-1 transition-colors ${
                  split.dragging
                    ? 'border-[#007acc] bg-[#007acc]/30'
                    : 'border-pm-border bg-pm-bg group-hover:border-[#007acc]/70'
                }`}
              >
                {[0, 1, 2].map(i => (
                  <span key={i} className="block h-[3px] w-[3px] rounded-full bg-pm-text-muted" />
                ))}
              </div>
            </div>

            {/* Detalhe */}
            <div className="flex-1 min-w-0 overflow-y-auto p-3">
              {!focused ? (
                <p className="text-[11px] text-pm-text-muted">{t.pickItem}</p>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-pm-text">{focused.path.join(' / ')}</div>
                      <div className={`text-[10.5px] ${styleOf(focused, statuses.get(focused.id)).color}`}>
                        {(() => { const st = statuses.get(focused.id); return st ? t.status[st.key].label : null })()}
                      </div>
                      {/* Por arquivo (collection raiz), não por request: o
                          GitHub só sabe o histórico do arquivo cifrado. */}
                      {(() => {
                        const info = lastChanges[`${diffKey}|${focused.rootId}`]
                        if (info === null || !lastChangeOf) return null
                        if (info === undefined) {
                          return <div className="mt-0.5 text-[10px] text-pm-text-muted/70">{t.checkingWho}</div>
                        }
                        return (
                          <div
                            className="mt-0.5 flex items-center gap-1 text-[10px] text-pm-text-muted"
                            title={t.lastCommitTitle(info.message.split('\n')[0], new Date(info.date).toLocaleString(locale))}
                          >
                            <GitCommitHorizontal size={11} className="shrink-0" />
                            <span className="truncate">
                              {t.lastChangedBy}{' '}
                              <span className="font-semibold text-pm-text-secondary">{info.authorName}</span>
                              {info.date ? ` · ${timeAgo(info.date, t, locale)}` : ''}
                            </span>
                          </div>
                        )
                      })()}
                      {/* Por ITEM: o "último commit da collection" acima é do
                          arquivo inteiro, e pode ser de outra request. */}
                      {whoChangedItem && (() => {
                        const result = whoChanged[`${diffKey}|${focused.id}`]
                        if (!result) {
                          return (
                            <button
                              onClick={() => askWhoChanged(focused)}
                              className="mt-0.5 text-[10px] text-[#63b3ed] hover:underline cursor-pointer"
                            >
                              {t.whoChanged}
                            </button>
                          )
                        }
                        if (result === 'loading') {
                          return <div className="mt-0.5 text-[10px] text-pm-text-muted/70">{t.whoChangedLoading}</div>
                        }
                        if (!result.change) {
                          return <div className="mt-0.5 text-[10px] text-pm-text-muted">{t.whoChangedNotFound(result.searched)}</div>
                        }
                        const c = result.change
                        const ago = c.date ? timeAgo(c.date, t, locale) : ''
                        const line =
                          c.kind === 'created' ? t.whoCreatedBy(c.authorName, ago)
                            : c.kind === 'deleted' ? t.whoDeletedBy(c.authorName, ago)
                              : t.whoChangedBy(c.authorName, ago)
                        return (
                          <div className="mt-0.5 text-[10px] text-pm-text-secondary" title={c.message}>
                            <span className="font-semibold">{line}</span>
                            {c.fields.length > 0 && <span className="text-pm-text-muted"> · {t.whoChangedFields(c.fields.join(', '))}</span>}
                            {c.message && <div className="text-pm-text-muted truncate">“{c.message.split('\n')[0]}”</div>}
                          </div>
                        )
                      })()}
                    </div>
                    <ChoiceToggle
                      size="md"
                      choice={choiceOf(focused.id)}
                      onMine={() => choose([focused.id], 'mine')}
                      onGitHub={() => choose([focused.id], 'github')}
                      onMerge={canMerge(focused) ? () => startMerge(focused) : undefined}
                    />
                  </div>

                  {/* O que marcar/desmarcar faz com ESTE item, dito por quem mexeu
                      nele (lib/diffOrigin). Sem destaque quando só o GitHub
                      mudou: aceitar ali não perde nada. */}
                  {(() => {
                    const st = statuses.get(focused.id)
                    if (!st) return null
                    // Sem base, "unknown" só ganha destaque quando cai no
                    // critério antigo de conflito (collection com pendência).
                    const pendingFallback = st.origin === 'unknown' && conflicts.has(focused.id)
                    const highlight = st.origin === 'here' || st.origin === 'both' || pendingFallback
                    const detail =
                      pendingFallback && focused.change === 'modified'
                        ? t.pendingFallbackDetail
                        : t.status[st.key].detail
                    return highlight ? (
                      <div className={`flex items-start gap-1.5 rounded-md border p-2 text-[10.5px] ${ORIGIN_BOX[st.origin]}`}>
                        <AlertTriangle size={12} className="mt-px shrink-0" />
                        <span>
                          {detail}{' '}
                          <span className="opacity-80">
                            {{ mine: t.nowMine, github: t.nowGithub, merged: t.nowMerged, mixed: t.nowMine }[choiceOf(focused.id)]}
                          </span>
                        </span>
                      </div>
                    ) : (
                      <p className="text-[11px] text-pm-text-muted">{detail}</p>
                    )
                  })()}

                  {/* O que o Auto merge não resolveu, e onde. */}
                  {(() => {
                    const resolution = autoResolutionOf(focused.id)
                    if (resolution?.kind !== 'conflict') return null
                    return (
                      <div className="flex items-start gap-1.5 rounded-md border border-amber-500/60 bg-amber-500/15 p-2 text-[10.5px] font-semibold text-amber-300">
                        <AlertTriangle size={12} className="mt-px shrink-0" />
                        <span>
                          {resolution.fields.length > 0
                            ? t.conflictFields(resolution.fields.map(fieldLabel).join(', '))
                            : t.conflictWholeItem}
                        </span>
                      </div>
                    )
                  })()}

                  {focused.change === 'modified' &&
                    focused.fields.map(field => {
                      const resolution = autoResolutionOf(focused.id)
                      const marks = mergeMarks[focused.id]
                      return (
                        <FieldRow
                          // Por item e campo: o estado da linha (mostrar o
                          // auth, por exemplo) não pode passar pro próximo item.
                          key={`${focused.id}:${field.field}`}
                          field={field}
                          draft={drafts[focused.id]?.[field.field]}
                          error={errors[focused.id]?.[field.field]}
                          onDraftChange={text => editField(focused, field.field, text)}
                          choice={choiceOf(focused.id)}
                          readOnly={choiceOf(focused.id) === 'mine' && !canEditFromMine(focused)}
                          mergeEditor={mergeEditorFor(focused, field)}
                          markerCatalog={markerCatalog}
                          origin={originOfField(focused, field)}
                          base={baseOfField(focused, field)}
                          conflict={
                            (resolution?.kind === 'conflict' && resolution.fields.includes(field.field)) ||
                            (choiceOf(focused.id) === 'merged' && !!marks?.conflicts.includes(field.field))
                          }
                          autoCombined={
                            (resolution?.kind === 'merged' && resolution.combined.includes(field.field)) ||
                            (choiceOf(focused.id) === 'merged' && !!marks?.combined.includes(field.field))
                          }
                        />
                      )
                    })}
                </div>
              )}
            </div>
          </div>
          </>
        )}

        {/* Também alça de arrastar, igual ao cabeçalho — se ele ficar fora de
            alcance (modal mais alto que a janela), esta barra, na outra
            ponta, costuma continuar visível. Só onMouseDown/style, não o
            `ref`: ele é o mesmo objeto do cabeçalho, que precisa continuar
            apontando só pra lá. */}
        <div
          onMouseDown={drag.handleProps.onMouseDown}
          style={drag.handleProps.style}
          onDoubleClick={drag.reset}
          title={t.dragTitle}
          className="h-12 shrink-0 flex items-center justify-between px-4 border-t border-pm-border select-none"
        >
          {escArmed ? (
            <span role="alert" className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-300">
              <AlertTriangle size={12} className="shrink-0" />
              {t.escapeArmed}
            </span>
          ) : (
            <span className="text-[11px] text-pm-text-muted">
              {t.footerSummary(summary.selected, summary.total - summary.selected)}
              {discardCount > 0 && (
                <span className="text-amber-400">{t.discardLocal(discardCount)}</span>
              )}
              {unresolvedCount > 0 && (
                <span className="text-amber-400"> · {t.mvResolveFirst(unresolvedCount)}</span>
              )}
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              title={isPush ? t.cancelPushTitle : undefined}
              className="h-7 px-3 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:bg-pm-hover transition-colors cursor-pointer"
            >
              {isPush ? t.cancelPush : t.close}
            </button>
            <button
              onClick={() => {
                // As edições da prévia destes itens entraram (ou foram trocadas).
                clearPreparedEdits(workspace, nodes.map(n => n.id))
                onApply(
                  selected,
                  appliedOverrides,
                  // O que precisava de decisão, e o que foi escolhido — vai
                  // pro histórico de conflitos.
                  nodes
                    .filter(node => decisionIds.has(node.id))
                    .map(node => {
                      const choice = choiceOf(node.id)
                      return {
                        item: node.path.join(' / '),
                        choice: choice === 'merged' ? 'merged' : choice === 'github' ? 'github' : 'mine',
                        fields: node.fields.map(f => f.field),
                      }
                    })
                )
              }}
              disabled={errorCount > 0 || unresolvedCount > 0}
              title={
                errorCount > 0
                  ? t.fixJsonFirst(errorCount)
                  : unresolvedCount > 0
                  ? t.mvResolveFirst(unresolvedCount)
                  : isPush
                  ? summary.selected === 0
                    ? t.pushMineTitle
                    : t.mergePushTitle(summary.selected)
                  : summary.selected === 0
                  ? t.keepAsIsTitle
                  : undefined
              }
              className={`h-7 px-3 rounded-md text-xs font-semibold text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                // Push sem aceitar nada é a única saída daqui que apaga
                // trabalho de outra pessoa — cor de ação destrutiva.
                isPush && summary.selected === 0
                  ? 'bg-rose-600 hover:bg-rose-600/90'
                  : 'bg-[#f26b3a] hover:bg-[#f26b3a]/90'
              }`}
            >
              {/* 0 selecionados não é "nada a fazer" — é uma decisão válida
                  (manter tudo como está aqui), e precisa continuar clicável:
                  travar o botão nesse caso era a armadilha de quem tinha só
                  um item novo (ainda não enviado) pra revisar — a única
                  opção que sobrava era marcar a caixa, que APAGA o item. */}
              {isPush
                ? summary.selected === 0
                  ? t.pushMine
                  : t.mergePush(summary.selected)
                : summary.selected === 0
                ? t.keepAsIs
                : t.apply(summary.selected)}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
