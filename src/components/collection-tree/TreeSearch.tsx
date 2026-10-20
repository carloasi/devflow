'use client'

import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'

interface Props {
  value: string
  onChange: (value: string) => void
  // Seta pra baixo no campo -> passa o foco pra árvore (navegação por teclado).
  onArrowDown?: () => void
}

// Ctrl/Cmd+F foca o filtro — exceto quando o foco está num campo de texto ou
// no Monaco (lá o Ctrl+F é o "localizar" do próprio editor).
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.monaco-editor')) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

export function TreeSearch({ value, onChange, onArrowDown }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 'f') return
      if (isEditableTarget(e.target)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="px-2 py-2">
      <div className="flex items-center bg-pm-surface rounded px-2 h-7 border border-transparent focus-within:border-blue-700">
        <Search size={12} className="text-pm-text-muted shrink-0" />

        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              // 1º Esc limpa; com o campo já vazio, devolve o foco.
              if (value) onChange('')
              else inputRef.current?.blur()
            } else if (e.key === 'ArrowDown' && onArrowDown) {
              e.preventDefault()
              onArrowDown()
            }
          }}
          placeholder="Filter (e.g. groups, post groups, /api/v1)"
          title="Searches names. A method word (post, get…) also matches the method; start with / to search URLs. Ctrl+F"
          className="
            bg-transparent
            outline-none
            text-[12px]
            text-pm-text
            px-2
            w-full
            min-w-0
          "
        />

        {value && (
          <button
            type="button"
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            title="Clear filter (Esc)"
            className="shrink-0 rounded p-0.5 text-pm-text-muted hover:text-pm-text hover:bg-pm-hover cursor-pointer"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
