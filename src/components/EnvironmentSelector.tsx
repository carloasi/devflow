
'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Search,
  Upload,
  Eye,
  Trash2,
  Ban,
  Plus,
  Save,
  Loader2,
  Copy,
  Pencil,
  GripVertical,
} from 'lucide-react'

import { Environment, EnvironmentValue } from '@/app/types/Environment'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { useEnvironment } from './EnvironmentContext'
import { EnvironmentVariablesQuickView } from './SlidePanel/EnvironmentVariablesQuickView'
import { SlidePanel } from './SlidePanel/SlidePanel'
import { EnvironmentCombobox } from './SlidePanel/EnvironmentCombobox'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { safeSetItem } from '@/lib/safeStorage';


const OBF_PREFIX = 'OBFv1$'
const OBF_KEY = 'postmannext::env-export::v1'

// Paleta de cores pra marcar ambientes (estilo Postman: clica na bolinha ao
// lado do nome do ambiente e escolhe uma cor entre opções fixas). `color`
// é salvo como o hue (0-360) usado em hsl(hue,70%,50%) — ver renderização
// do dot mais abaixo.
// Hues calibrados visualmente a partir de um print do seletor real do
// Postman (badges "Enterprise Cache-TST"/env-tst em verde musgo, "5by5" em
// azul, "Enterprise Cache-PRD"/env-prd em vermelho tijolo, "Enterprise
// Cache-STG"/env-stg em dourado escuro) — sem hex oficial documentado, mas
// a saturação/luminosidade abaixo (ver hsl(...) nos usos) foi reduzida pra
// bater com o tom mais "queimado"/dessaturado do Postman em vez de cores
// vivas.
const ENV_COLOR_PRESETS: { hue: number; name: string }[] = [
  { hue: 358, name: 'Red' },
  { hue: 15, name: 'Vermillion' },
  { hue: 25, name: 'Orange' },
  { hue: 42, name: 'Amber' },
  { hue: 55, name: 'Yellow' },
  { hue: 90, name: 'Lime' },
  { hue: 142, name: 'Green' },
  { hue: 155, name: 'Emerald' },
  { hue: 175, name: 'Teal' },
  { hue: 190, name: 'Cyan' },
  { hue: 205, name: 'Sky' },
  { hue: 217, name: 'Blue' },
  { hue: 235, name: 'Indigo' },
  { hue: 265, name: 'Violet' },
  { hue: 280, name: 'Purple' },
  { hue: 305, name: 'Magenta' },
  { hue: 330, name: 'Pink' },
  { hue: 350, name: 'Rose' },
]

interface ImportedValue {
  id?: string
  key?: string
  value?: string
  type?: 'default' | 'secret'
  enabled?: boolean
  // O export sempre gravou este campo; o import é que o descartava.
  description?: string
}

interface ImportedEnvironment {
  id?: string
  name?: string
  values?: ImportedValue[]
  color?: number
  _postman_variable_scope?: string
}

function xorCipher(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    out += String.fromCharCode(text.charCodeAt(i) ^ OBF_KEY.charCodeAt(i % OBF_KEY.length))
  }
  return out
}

function isObfuscated(value: string): boolean {
  return typeof value === 'string' && value.startsWith(OBF_PREFIX)
}

function deobfuscateValue(encoded: string): string {
  if (!isObfuscated(encoded)) return encoded
  try {
    const base64Data = encoded.slice(OBF_PREFIX.length)
    const binaryString = atob(base64Data)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const decodedText = new TextDecoder().decode(bytes)
    return xorCipher(decodedText)
  } catch (err) {
    console.error('Falha ao decodificar valor ofuscado', err)
    return encoded
  }
}

// Linha arrastável da lista de environments. A alça fica FORA do
// DropdownMenuItem: dentro dele, soltar o arraste contava como clique e o
// Radix selecionava a env e fechava o menu.
function SortableEnvRow({
  id,
  disabled,
  children,
}: {
  id: string
  disabled: boolean
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative group/env ${isDragging ? 'z-30 opacity-80 shadow-xl shadow-black/40 rounded-xl' : ''}`}
    >
      {!disabled && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          onClick={e => e.stopPropagation()}
          title="Drag to reorder (only on this computer)"
          aria-label="Drag to reorder"
          className={`absolute left-0.5 top-1/2 z-[5] -translate-y-1/2 flex h-7 w-5 items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-row-active transition-opacity ${
            isDragging ? 'cursor-grabbing opacity-100' : 'cursor-grab opacity-0 group-hover/env:opacity-100 focus-visible:opacity-100'
          }`}
        >
          <GripVertical size={12} />
        </button>
      )}
      {children}
    </div>
  )
}

interface EnvironmentSelectorProps {
  onSaveEnvironment?: (env: Environment) => Promise<void> | void // ✅ novo
  // Abre a comparação com o GitHub (mesma tela do pull de collection).
  onPullEnvironments?: () => void
  // Path do workspace ativo — usado só pra isolar por workspace a última
  // env selecionada (senão trocar de workspace e voltar restaura a env
  // errada, já que antes essa chave era global pro app inteiro).
  workspace?: string
}

export default function EnvironmentSelector({ onSaveEnvironment, onPullEnvironments, workspace = '' }: EnvironmentSelectorProps) {
  const {
    environments,
    selectedEnvId,
    activeEnv,
    setSelectedEnvId,
    importEnvironment,
    deleteEnvironment,
    updateEnvironment,
    cloneEnvironment,
  } = useEnvironment()

  const [searchQuery, setSearchQuery] = useState('')
  const [isSlidePanelOpen, setIsSlidePanelOpen] = useState(false)
  // Environment mostrado no painel de variáveis — começa no ativo, mas o
  // combobox do painel deixa ver/editar outro sem trocar o das requests.
  const [panelEnvId, setPanelEnvId] = useState<string | null>(null)
  const [isRenamingPanelEnv, setIsRenamingPanelEnv] = useState(false)
  const panelEnv = environments.find(env => env.id === panelEnvId) ?? activeEnv
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [colorPickerForId, setColorPickerForId] = useState<string | null>(null)
  const [isSavingEnv, setIsSavingEnv] = useState(false)
  // Renomear direto na lista (double-click no nome) — mesmo padrão de
  // "double-click to rename" já usado na árvore de collections (TreeNode.tsx).
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  // Chave isolada por workspace (fallback "default" quando não há workspace
  // resolvido ainda, ex: GitHub Sync não configurado).
  const LAST_SELECTED_ENV_STORAGE_KEY = `postman_clone_last_selected_env_id:${workspace || 'default'}`
  const fileInputRef = useRef<HTMLInputElement>(null)
  const prevEnvIdsRef = useRef<string[]>([])
  // Guarda a chave atual num ref só pra leitura no efeito de persistência
  // abaixo — de propósito NÃO entra nas deps desse efeito (ver comentário lá).
  const lastSelectedKeyRef = useRef(LAST_SELECTED_ENV_STORAGE_KEY)
  lastSelectedKeyRef.current = LAST_SELECTED_ENV_STORAGE_KEY

  // DEPOIS:
useEffect(() => {
  const currentIds = environments.map(e => e.id)
  const storedId = localStorage.getItem(LAST_SELECTED_ENV_STORAGE_KEY)
  const selectedStillExists = selectedEnvId
    ? currentIds.includes(selectedEnvId)
    : true

  if (!selectedStillExists) {
    const fallbackId =
      storedId && currentIds.includes(storedId)
        ? storedId
        : currentIds.length > 0
          ? currentIds[currentIds.length - 1]
          : null
    setSelectedEnvId(fallbackId)
  } else if (!selectedEnvId && currentIds.length > 0) {
    if (storedId && currentIds.includes(storedId)) {
      setSelectedEnvId(storedId)
    } else {
      const newIds = currentIds.filter(id => !prevEnvIdsRef.current.includes(id))
      if (newIds.length > 0) {
        setSelectedEnvId(newIds[newIds.length - 1])
      }
    }
  }

  prevEnvIdsRef.current = currentIds
}, [environments, selectedEnvId, setSelectedEnvId, LAST_SELECTED_ENV_STORAGE_KEY])

// NOVO — persiste toda vez que a seleção mudar (clique manual ou fallback acima).
// Depende só de selectedEnvId (não da chave) de propósito: ao trocar de
// workspace, o prop `workspace` (e portanto a chave) muda ANTES de
// `selectedEnvId` ser atualizado pro valor do novo workspace (gap de um
// render). Se esse efeito reagisse à mudança da chave, ele gravaria o id
// (ainda antigo) da env do workspace anterior na chave do workspace novo,
// sobrescrevendo o valor certo que já estava salvo ali. Usando a ref, o
// efeito só roda quando selectedEnvId de fato muda, e nesse ponto a chave
// (lida via ref) já está correta pro workspace atual.
// safeSetItem: isto roda a cada troca de environment, de dentro de um
// efeito. Com a cota cheia o setItem cru lançava, e lançar num efeito sobe
// pro React, que desmonta a árvore — selecionar um environment derrubava a
// janela. Lembrar a última escolha é conveniência; nunca vale a tela.
useEffect(() => {
  if (selectedEnvId) {
    safeSetItem(lastSelectedKeyRef.current, selectedEnvId)
  }
}, [selectedEnvId])

  // Ordem da lista definida arrastando — só desta máquina e só da exibição:
  // o array de environments (e o que vai pro GitHub) não muda. Por
  // workspace, igual a última env selecionada.
  const ENV_ORDER_STORAGE_KEY = `devflow_env_order:${workspace || 'default'}`
  const [envOrder, setEnvOrder] = useState<string[]>([])
  const [loadedOrderKey, setLoadedOrderKey] = useState<string | null>(null)
  if (loadedOrderKey !== ENV_ORDER_STORAGE_KEY) {
    // Lê na troca de workspace durante o render (sem efeito), pra a lista
    // já aparecer na ordem certa.
    let saved: string[] = []
    try {
      const raw = localStorage.getItem(ENV_ORDER_STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      saved = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
      // Sem storage: ordem original.
    }
    setLoadedOrderKey(ENV_ORDER_STORAGE_KEY)
    setEnvOrder(saved)
  }

  // Envs com posição salva primeiro, na ordem salva; as que ainda não têm
  // (criadas/importadas/puxadas depois) vão pro fim, na ordem original.
  const orderedEnvironments = useMemo(() => {
    const rank = new Map(envOrder.map((id, i) => [id, i]))
    return environments
      .map((env, i) => ({ env, i }))
      .sort((a, b) => {
        const ra = rank.get(a.env.id)
        const rb = rank.get(b.env.id)
        if (ra !== undefined && rb !== undefined) return ra - rb
        if (ra !== undefined) return -1
        if (rb !== undefined) return 1
        return a.i - b.i
      })
      .map(({ env }) => env)
  }, [environments, envOrder])

  const filteredEnvironments = useMemo(() => {
    return orderedEnvironments.filter(env =>
      env.name.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }, [orderedEnvironments, searchQuery])

  const dragSensors = useSensors(
    // 4px antes de começar: um clique na alça não vira arraste.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleEnvDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = orderedEnvironments.map(env => env.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    const next = arrayMove(ids, from, to)
    setEnvOrder(next)
    try {
      localStorage.setItem(ENV_ORDER_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Sem storage: vale só até fechar o app.
    }
  }

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const json: ImportedEnvironment = JSON.parse(event.target?.result as string)

        if (!json.name || !Array.isArray(json.values)) {
          alert('Invalid environment file format.')
          return
        }

        const importedEnv: Environment = {
          id: json.id || crypto.randomUUID(),
          name: json.name,
            values: json.values.map((v): EnvironmentValue => ({
              id: v.id || crypto.randomUUID(),
              key: v.key || '',
              value: deobfuscateValue(v.value ?? ''),
              type: v.type || 'default',
              enabled: v.enabled !== undefined ? v.enabled : true,
              description: v.description
            })),
          color: json.color,
          _postman_variable_scope: json._postman_variable_scope
        }
        importEnvironment(importedEnv)
      } catch (err) {
        console.error(err)
        alert('Could not read the JSON file.')
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    }
    reader.readAsText(file)
  }

  const handleDeleteEnvironment = (id: string) => {
    deleteEnvironment(id)
    setConfirmDeleteId(null)
    if (selectedEnvId === id) setSelectedEnvId(null)
  }

  const startRenaming = (env: Environment, e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmDeleteId(null)
    setColorPickerForId(null)
    setRenamingId(env.id)
    setRenameValue(env.name)
    // O input só existe depois desse render — espera o próximo tick pra
    // focar/selecionar, senão renameInputRef.current ainda é null.
    setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 0)
  }

  const commitRename = (env: Environment) => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== env.name) {
      updateEnvironment({ ...env, name: trimmed })
    }
    setRenamingId(null)
  }

  const cancelRenaming = () => {
    setRenamingId(null)
  }

  const handleCreateEnvironment = () => {
    const newEnv: Environment = {
      id: crypto.randomUUID(),
      name: 'New Environment',
      values: [],
    }
    importEnvironment(newEnv)
  }

  // Sobe as alterações do ambiente ativo pro GitHub (mesmo mecanismo do
  // botão Save dentro do painel de variáveis — ver onSaveEnvironment prop),
  // só que direto na barra, sem precisar abrir o painel.
  const handleSaveEnvironment = async () => {
    if (!activeEnv || !onSaveEnvironment || isSavingEnv) return
    setIsSavingEnv(true)
    try {
      await onSaveEnvironment(activeEnv)
    } catch (err) {
      console.error(err)
    } finally {
      setIsSavingEnv(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileImport}
        accept=".json"
        className="hidden"
      />

      {/* DROPDOWN SELECTOR */}
      <DropdownMenu modal={false} onOpenChange={(open) => { if (!open) { setConfirmDeleteId(null); setColorPickerForId(null); setRenamingId(null) } }}>
        <div
          className={`
            h-7 rounded-lg border flex items-center
            transition-colors duration-150
            ${activeEnv?.color === undefined ? 'border-pm-border bg-pm-hover' : ''}
          `}
          style={
            activeEnv?.color !== undefined
              ? {
                  borderColor: `hsl(${activeEnv.color},50%,38%,0.5)`,
                  backgroundColor: `hsl(${activeEnv.color},50%,42%,0.12)`,
                }
              : undefined
          }
        >
          <DropdownMenuTrigger asChild>
            <button
              className="
                h-full pl-2 pr-2 rounded-l-lg
                flex items-center gap-2
                cursor-pointer outline-none ring-0
                focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0
              "
            >
              <span
                className={`text-xs max-w-[140px] truncate ${activeEnv?.color === undefined ? 'text-pm-text-secondary' : ''}`}
                style={activeEnv?.color !== undefined ? { color: `hsl(${activeEnv.color},35%,60%)` } : undefined}
              >
                {activeEnv ? activeEnv.name : 'No Environment'}
              </span>

              <ChevronDown
                size={13}
                className={activeEnv?.color === undefined ? 'text-pm-text-muted' : ''}
                style={activeEnv?.color !== undefined ? { color: `hsl(${activeEnv.color},35%,60%)` } : undefined}
              />
            </button>
          </DropdownMenuTrigger>

          {/* Barra + botão de salvar — só aparece quando o ambiente ativo
              tem alteração não sincronizada com o GitHub (isDirty). Ambientes
              "apenas local" nunca mostram esse botão, já que não há nada
              pra sincronizar. */}
          {activeEnv?.isDirty && onSaveEnvironment && (
            <>
              <div
                className="w-px h-4 shrink-0 bg-pm-border"
                style={
                  activeEnv.color !== undefined
                    ? { backgroundColor: `hsl(${activeEnv.color},50%,38%,0.4)` }
                    : undefined
                }
              />
              <button
                type="button"
                onClick={handleSaveEnvironment}
                disabled={isSavingEnv}
                title="Save environment changes to GitHub"
                className={`h-full pl-1.5 pr-2 rounded-r-lg flex items-center justify-center hover:bg-emerald-500/10 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${
                  activeEnv.color === undefined ? 'text-emerald-400 hover:text-emerald-300' : ''
                }`}
                style={activeEnv.color !== undefined ? { color: `hsl(${activeEnv.color},35%,60%)` } : undefined}
              >
                {isSavingEnv ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              </button>
            </>
          )}
        </div>

        <DropdownMenuContent
          align="end"
          className="
            w-80 p-2 bg-pm-surface border border-pm-border
            rounded-2xl shadow-2xl shadow-black/40 outline-none ring-0 focus:outline-none
          "
        >
          {/* SEARCH & IMPORT */}
          <div className="flex items-center gap-2 bg-pm-hover/60 border border-pm-border rounded-xl px-3 h-9 transition-colors focus-within:border-blue-500/40 focus-within:bg-pm-hover">
            <Search size={13} className="text-pm-text-muted shrink-0" />

            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search environments..."
              className="
                bg-transparent flex-1 text-xs text-pm-text
                outline-none border-none ring-0 focus:outline-none
                placeholder:text-pm-text-muted
              "
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              title="Import environment (.json)"
              className="text-pm-text-muted hover:text-blue-400 transition-colors outline-none cursor-pointer shrink-0"
            >
              <Upload size={13} />
            </button>
          </div>

          <div className="flex items-center justify-between px-1 pt-3 pb-1.5">
            <span className="text-[10px] font-semibold text-pm-text-muted uppercase tracking-wider">
              Environments
            </span>
            <button
              type="button"
              onClick={handleCreateEnvironment}
              title="Add new environment"
              className="flex items-center gap-1 text-[10px] font-medium text-pm-accent hover:text-pm-text px-1.5 py-0.5 rounded-md hover:bg-pm-hover transition-colors cursor-pointer"
            >
              <Plus size={12} />
              New
            </button>
          </div>

          {/* LIST */}
          <div className="max-h-72 overflow-y-auto pr-1 space-y-0.5 scrollbar-thin scrollbar-thumb-[var(--color-pm-border)]">
            {filteredEnvironments.length === 0 && (
              <div className="px-3 py-10 text-center">
                <Search size={20} className="text-pm-text-muted mx-auto mb-2" />
                <span className="text-[11px] text-pm-text-muted">
                  No environment found
                </span>
              </div>
            )}

            <DndContext
              sensors={dragSensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={handleEnvDragEnd}
            >
            <SortableContext items={filteredEnvironments.map(env => env.id)} strategy={verticalListSortingStrategy}>
            {filteredEnvironments.map((env) => (
              <SortableEnvRow key={env.id} id={env.id} disabled={!!searchQuery.trim()}>
                {confirmDeleteId === env.id && (
                  <div className="absolute inset-0 z-10 bg-pm-surface rounded-xl flex items-center justify-between px-3 gap-2 border border-red-500/30 shadow-lg">
                    <span className="text-[11px] text-pm-text truncate">
                      Delete <span className="font-semibold text-pm-text">{env.name}</span>?
                    </span>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          handleDeleteEnvironment(env.id)
                        }}
                        className="h-6 px-2.5 rounded-lg bg-red-500 hover:bg-red-400 text-[11px] cursor-pointer text-white font-medium transition-colors"
                      >
                        Delete
                      </button>

                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmDeleteId(null)
                        }}
                        className="h-6 px-2.5 rounded-lg cursor-pointer bg-pm-hover hover:bg-pm-row-active text-[11px] text-pm-text-secondary transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {renamingId === env.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute inset-0 z-10 bg-pm-surface rounded-xl flex items-center gap-2 px-3 border border-blue-500/40 shadow-lg"
                  >
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') commitRename(env)
                        else if (e.key === 'Escape') cancelRenaming()
                      }}
                      onBlur={() => commitRename(env)}
                      className="flex-1 h-7 min-w-0 bg-pm-hover border border-pm-border rounded-md px-2 text-xs text-pm-text outline-none focus:border-blue-500/60"
                    />
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); commitRename(env) }}
                        className="h-6 px-2.5 rounded-lg bg-pm-accent hover:brightness-110 text-[11px] cursor-pointer text-white font-medium transition-colors"
                      >
                        Save
                      </button>
                      <button
                        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); cancelRenaming() }}
                        className="h-6 px-2.5 rounded-lg cursor-pointer bg-pm-hover hover:bg-pm-row-active text-[11px] text-pm-text-secondary transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <DropdownMenuItem
                  onClick={() => setSelectedEnvId(env.id)}
                  className={`
                    rounded-xl text-xs cursor-pointer h-12 pl-6 pr-2.5 outline-none group transition-colors
                    ${selectedEnvId === env.id
                      ? (env.color === undefined ? 'bg-pm-accent/[0.08]' : '')
                      : 'focus:bg-[var(--env-hover-bg)]'}
                  `}
                  style={{
                    ...(selectedEnvId === env.id && env.color !== undefined
                      ? { backgroundColor: `hsl(${env.color},50%,42%,0.12)` }
                      : {}),
                    ...({ '--env-hover-bg': env.color !== undefined ? `hsl(${env.color},50%,42%,0.14)` : 'var(--color-pm-hover)' } as React.CSSProperties),
                  }}
                >
                  <div className="flex items-center justify-between w-full min-w-0">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmDeleteId(null)
                          setRenamingId(null)
                          setColorPickerForId((cur) => (cur === env.id ? null : env.id))
                        }}
                        title="Set environment color"
                        className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 cursor-pointer transition-all"
                        style={{
                          backgroundColor: env.color !== undefined ? `hsl(${env.color},50%,42%,0.18)` : 'var(--color-pm-hover)',
                        }}
                      >
                        {env.color !== undefined ? (
                          <div
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: `hsl(${env.color},50%,42%)` }}
                          />
                        ) : (
                          <div className="w-2 h-2 rounded-full border border-pm-text-muted/50" />
                        )}
                      </button>

                      <div className="flex flex-col min-w-0 gap-0.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {/* O nome seleciona o ambiente, como o resto da
                              linha. Antes ele renomeava no duplo-clique e, pra
                              isso funcionar, precisava engolir o clique simples
                              — o Radix seleciona E fecha o menu no 1º clique, e
                              a linha sumia antes do 2º. O efeito colateral era
                              que clicar no nome, o alvo mais óbvio da linha,
                              não fazia nada. Renomear virou um botão próprio. */}
                          <span
                            className={`truncate ${
                              selectedEnvId === env.id
                                ? `font-medium ${env.color === undefined ? 'text-pm-text' : ''}`
                                : 'text-pm-text-secondary'
                            }`}
                            style={
                              selectedEnvId === env.id && env.color !== undefined
                                ? { color: `hsl(${env.color},35%,60%)` }
                                : undefined
                            }
                          >
                            {env.name}
                          </span>
                          {env.isDirty && (
                            <span
                              className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 ring-2 ring-emerald-400/20"
                              title="Changes not synced with GitHub"
                            />
                          )}
                        </div>
                        <span className="text-[10px] text-pm-text-muted font-mono">
                          {env.values.length} {env.values.length === 1 ? 'variable' : 'variables'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => startRenaming(env, e)}
                        title="Rename this environment"
                        className="opacity-0 group-hover:opacity-100 text-pm-text-muted hover:text-pm-text hover:bg-pm-row-active p-1.5 rounded-lg transition-all"
                      >
                        <Pencil size={12} />
                      </button>

                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          cloneEnvironment(env.id)
                        }}
                        title="Duplicate this environment"
                        className="opacity-0 group-hover:opacity-100 text-pm-text-muted hover:text-pm-text hover:bg-pm-row-active p-1.5 rounded-lg transition-all"
                      >
                        <Copy size={12} />
                      </button>

                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenamingId(null)
                          setConfirmDeleteId(env.id)
                        }}
                        title="Delete environment"
                        className="opacity-0 group-hover:opacity-100 text-pm-text-muted hover:text-red-400 hover:bg-red-500/10 p-1.5 rounded-lg transition-all"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </DropdownMenuItem>

                {colorPickerForId === env.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="absolute left-2.5 top-[calc(100%+2px)] z-20 flex flex-wrap items-center gap-1.5 w-[196px] p-2 rounded-xl bg-pm-surface border border-pm-border shadow-2xl shadow-black/40"
                  >
                    {ENV_COLOR_PRESETS.map((preset) => (
                      <button
                        key={preset.hue}
                        type="button"
                        title={preset.name}
                        onClick={(e) => {
                          e.stopPropagation()
                          updateEnvironment({ ...env, color: preset.hue })
                          setColorPickerForId(null)
                        }}
                        className={`w-5 h-5 rounded-full shrink-0 cursor-pointer transition-transform hover:scale-110 ${
                          env.color === preset.hue ? 'ring-2 ring-pm-text/70' : ''
                        }`}
                        style={{ backgroundColor: `hsl(${preset.hue},50%,42%)` }}
                      />
                    ))}

                    <button
                      type="button"
                      title="No color"
                      onClick={(e) => {
                        e.stopPropagation()
                        updateEnvironment({ ...env, color: undefined })
                        setColorPickerForId(null)
                      }}
                      className="w-5 h-5 rounded-full shrink-0 cursor-pointer flex items-center justify-center bg-pm-hover border border-pm-border hover:bg-pm-row-active transition-colors"
                    >
                      <Ban size={11} className="text-pm-text-muted" />
                    </button>
                  </div>
                )}
              </SortableEnvRow>
            ))}
            </SortableContext>
            </DndContext>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* BOTÃO PARA ABRIR O PAINEL DE VARIÁVEIS */}
      <button
        disabled={!activeEnv}
        onClick={() => {
          setPanelEnvId(activeEnv?.id ?? null)
          setIsRenamingPanelEnv(false)
          setIsSlidePanelOpen(true)
        }}
        className={`
          h-7 px-3 rounded-lg border transition-colors duration-150
          flex items-center gap-2 outline-none cursor-pointer
          ${
            activeEnv
              ? 'bg-pm-hover border-pm-border hover:bg-pm-hover hover:border-pm-border text-pm-text-secondary hover:text-pm-text'
              : 'bg-pm-hover/60 border-pm-border/60 text-pm-text-muted cursor-not-allowed'
          }
        `}
      >
        <Eye size={14} />
        <span className="text-xs">Variables</span>
      </button>

      {/* PAINEL DESLIZANTE (SLIDE PANEL) */}
{/* PAINEL DESLIZANTE (SLIDE PANEL) */}
<SlidePanel
  isOpen={isSlidePanelOpen}
  onClose={() => setIsSlidePanelOpen(false)}
  title={
    panelEnv ? (
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-[10px] font-semibold text-pm-text-muted uppercase tracking-wider">
          ENVIRONMENT VARIABLES
        </span>
        <div className="flex items-center gap-1.5 min-w-0">
          {isRenamingPanelEnv ? (
            <input
              autoFocus
              value={panelEnv.name}
              onChange={(e) => updateEnvironment({ ...panelEnv, name: e.target.value })}
              onBlur={() => setIsRenamingPanelEnv(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setIsRenamingPanelEnv(false)
                }
              }}
              className="h-7 min-w-0 max-w-[260px] flex-1 rounded-lg border border-blue-500/40 bg-pm-hover px-2.5 text-xs font-semibold text-pm-text outline-none"
            />
          ) : (
            <EnvironmentCombobox
              environments={environments}
              value={panelEnv}
              activeEnvId={selectedEnvId}
              onChange={setPanelEnvId}
            />
          )}
          {!isRenamingPanelEnv && (
            <button
              type="button"
              onClick={() => setIsRenamingPanelEnv(true)}
              title="Rename environment"
              className="h-7 w-7 shrink-0 flex items-center justify-center rounded-lg text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
            >
              <Pencil size={12} />
            </button>
          )}
          {panelEnv.id !== selectedEnvId && !isRenamingPanelEnv && (
            <button
              type="button"
              onClick={() => setSelectedEnvId(panelEnv.id)}
              title="Use this environment for requests"
              className="h-7 px-2 shrink-0 rounded-lg border border-pm-border bg-pm-hover/60 hover:bg-pm-hover text-[11px] font-medium text-pm-text-secondary hover:text-pm-text transition-colors cursor-pointer"
            >
              Set active
            </button>
          )}
        </div>
      </div>
    ) : (
      "Environment Variables"
    )
  }
  defaultWidth={550}
>
  {panelEnv && (
    <EnvironmentVariablesQuickView
      activeEnv={panelEnv}
      onClose={() => setIsSlidePanelOpen(false)}
      onSave={onSaveEnvironment}
      onPull={onPullEnvironments}
    />
  )}
</SlidePanel>
    </div>
  )
}
