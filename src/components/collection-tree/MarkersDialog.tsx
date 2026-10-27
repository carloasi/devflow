'use client'

import { useMemo, useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { MarkerGlyph } from './MarkerGlyph'
import {
  MARKER_COLORS,
  MAX_MARKER_NAME,
  type Marker,
  createMarker,
  deleteMarker,
  pickColor,
  recolorMarker,
  renameMarker,
} from '@/lib/markers'

// ─────────────────────────────────────────────────────────────────────────
// Gerenciar o catálogo de marcadores do workspace.
//
// O menu da árvore cria e aplica; o que NÃO cabe lá é o que exige ver o
// catálogo inteiro de uma vez — renomear sem colidir com outro nome, e
// apagar sabendo quantos itens vão perder a marca.
// ─────────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  catalog: Marker[]
  /** Quantos nós da árvore usam cada marcador. */
  counts: Map<string, number>
  onChange: (catalog: Marker[]) => void
  /** Apagar tira o marcador do catálogo E da árvore — daí o callback separado. */
  onDelete: (markerId: string) => void
  onClose: () => void
}

export function MarkersDialog({ open, catalog, counts, onChange, onDelete, onClose }: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<string | null>(null)

  const suggested = useMemo(() => pickColor(catalog), [catalog])

  // Nome que colide com OUTRO marcador: o renameMarker recusa em silêncio
  // (devolve o catálogo intacto), então o aviso tem que vir daqui — senão a
  // caixa fecha e parece que gravou.
  const collides = useMemo(() => {
    const clean = draftName.trim().toLowerCase()
    if (!clean) return false
    return catalog.some(m => m.id !== editing && m.name.toLowerCase() === clean)
  }, [draftName, catalog, editing])

  const commitRename = () => {
    if (!editing || collides || !draftName.trim()) {
      setEditing(null)
      return
    }
    onChange(renameMarker(catalog, editing, draftName))
    setEditing(null)
  }

  const commitCreate = () => {
    if (!newName.trim()) return
    try {
      const { catalog: next, existed } = createMarker(catalog, newName, {
        color: newColor ?? undefined,
      })
      if (!existed) onChange(next)
    } catch {
      return
    }
    setNewName('')
    setNewColor(null)
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent showCloseButton={false} className="max-w-[460px] gap-0 p-0">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-pm-border px-4">
          <DialogTitle className="text-sm font-semibold text-pm-text">Markers</DialogTitle>
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text"
          >
            <X size={15} />
          </button>
        </div>

        <div className="max-h-[320px] overflow-y-auto px-2 py-2">
          {catalog.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-pm-text-muted">
              No markers yet.
            </p>
          ) : (
            catalog.map(marker => {
              const used = counts.get(marker.id) ?? 0

              if (confirmingDelete === marker.id) {
                return (
                  <div
                    key={marker.id}
                    className="flex items-center gap-2 rounded-md bg-red-500/10 px-2 py-2 text-[12px]"
                  >
                    <span className="min-w-0 flex-1 text-pm-text">
                      {/* O número é o ponto: apagar um marcador usado em 40
                          itens desfaz 40 marcações de uma vez, e isso não dá
                          pra desfazer pelo Ctrl+Z da árvore. */}
                      Delete <strong>{marker.name}</strong>
                      {used > 0 && ` and remove it from ${used} item${used === 1 ? '' : 's'}`}?
                    </span>
                    <button
                      onClick={() => setConfirmingDelete(null)}
                      className="shrink-0 rounded px-2 py-1 text-pm-text-muted hover:text-pm-text"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        onDelete(marker.id)
                        onChange(deleteMarker(catalog, marker.id))
                        setConfirmingDelete(null)
                      }}
                      className="shrink-0 rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-500"
                    >
                      Delete
                    </button>
                  </div>
                )
              }

              return (
                <div
                  key={marker.id}
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-pm-hover"
                >
                  <ColorPicker
                    value={marker.color}
                    onPick={color => onChange(recolorMarker(catalog, marker.id, color))}
                  />

                  {editing === marker.id ? (
                    <input
                      autoFocus
                      value={draftName}
                      maxLength={MAX_MARKER_NAME}
                      onChange={e => setDraftName(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={e => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') {
                          e.nativeEvent.stopImmediatePropagation()
                          setEditing(null)
                        }
                      }}
                      spellCheck={false}
                      className={`min-w-0 flex-1 rounded border bg-pm-bg px-1.5 py-0.5 text-[12px] text-pm-text outline-none ${
                        collides ? 'border-red-500/70' : 'border-pm-border focus:border-[#f26b3a]/60'
                      }`}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[12px] text-pm-text">
                      {marker.name}
                    </span>
                  )}

                  {editing === marker.id && collides ? (
                    <span className="shrink-0 text-[10px] text-red-400">name already used</span>
                  ) : (
                    <span className="shrink-0 text-[10.5px] tabular-nums text-pm-text-muted">
                      {used === 0 ? 'unused' : `${used} item${used === 1 ? '' : 's'}`}
                    </span>
                  )}

                  <button
                    onClick={() => {
                      setEditing(marker.id)
                      setDraftName(marker.name)
                    }}
                    title="Rename"
                    className="flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-pm-bg group-hover:opacity-100"
                  >
                    <Pencil size={12} className="text-pm-text-muted" />
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(marker.id)}
                    title="Delete"
                    className="flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-red-500/15 group-hover:opacity-100"
                  >
                    <Trash2 size={12} className="text-red-400" />
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-pm-border px-3 py-2">
          <ColorPicker value={newColor ?? suggested} onPick={setNewColor} />
          <input
            value={newName}
            maxLength={MAX_MARKER_NAME}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitCreate()
            }}
            placeholder="New marker…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-pm-border bg-pm-bg px-2 py-1 text-[12px] text-pm-text outline-none focus:border-[#f26b3a]/60"
          />
          <button
            onClick={commitCreate}
            disabled={!newName.trim()}
            className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={13} />
            Add
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Quadradinho que abre a paleta ao clicar. Popover próprio em vez do
// componente de popover do app: são dez alvos de 16px, e o overlay/portal
// do Radix dentro de um Dialog custa mais do que isto resolve.
function ColorPicker({ value, onPick }: { value: string; onPick: (color: string) => void }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative shrink-0">
      {/* A etiqueta mostra a cor atual e abre a paleta. Na paleta os alvos
          voltam a ser quadrados: lá se está escolhendo uma COR, e o
          quadrado mostra mais cor por pixel que a etiqueta. */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Change color"
        className="flex size-4 items-center justify-center transition-transform hover:scale-110"
      >
        <MarkerGlyph color={value} size={15} />
      </button>
      {open && (
        <>
          {/* Captura o clique fora sem bloquear o Dialog em volta. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-6 z-20 flex w-[108px] flex-wrap gap-1 rounded-lg border border-pm-border bg-pm-surface p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.55)]">
            {MARKER_COLORS.map(color => (
              <button
                key={color}
                onClick={() => {
                  onPick(color)
                  setOpen(false)
                }}
                className="flex size-4 items-center justify-center rounded-[3px] transition-transform hover:scale-110"
                style={{ backgroundColor: color }}
              >
                {color === value && <Check size={10} className="text-black/70" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
