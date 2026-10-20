'use client'

import React, { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Environment } from '@/app/types/Environment'

// Combobox do painel de variáveis: escolhe QUAL environment o painel mostra.
// Não troca o environment ativo das requests — isso continua sendo o
// seletor do topo (ou o botão "Set active" ao lado deste combobox).

interface Props {
  environments: Environment[]
  value: Environment
  activeEnvId: string | null
  onChange: (envId: string) => void
}

function ColorDot({ color }: { color?: number }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color !== undefined ? `hsl(${color},50%,55%)` : 'var(--color-pm-text-muted)' }}
    />
  )
}

export function EnvironmentCombobox({ environments, value, activeEnvId, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? environments.filter(env => env.name.toLowerCase().includes(q)) : environments
  }, [environments, query])

  const choose = (envId: string) => {
    onChange(envId)
    setOpen(false)
  }

  const moveHighlight = (next: number) => {
    setHighlight(next)
    listRef.current
      ?.querySelector<HTMLElement>(`[data-env-index="${next}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) {
          setQuery('')
          setHighlight(Math.max(0, environments.findIndex(env => env.id === value.id)))
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Choose which environment to view"
          className="flex h-7 min-w-0 max-w-[260px] cursor-pointer items-center gap-2 rounded-lg border border-pm-border bg-pm-hover/60 px-2.5 text-left transition-colors hover:bg-pm-hover"
        >
          <ColorDot color={value.color} />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-pm-text">{value.name || 'Untitled'}</span>
          {value.id === activeEnvId && (
            <span className="shrink-0 rounded bg-emerald-500/15 px-1 text-[9px] font-bold uppercase tracking-wide text-emerald-400">
              active
            </span>
          )}
          <ChevronDown size={13} className="shrink-0 text-pm-text-muted" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        // Acima do SlidePanel (z-[10000]).
        className="z-[10010] w-72 gap-1.5 rounded-xl border border-pm-border bg-pm-surface p-2 text-pm-text shadow-2xl ring-0"
        onOpenAutoFocus={e => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input')?.focus()
        }}
      >
        <div className="flex h-8 items-center gap-2 rounded-lg border border-pm-border bg-pm-hover/60 px-2.5 focus-within:border-blue-500/40">
          <Search size={12} className="shrink-0 text-pm-text-muted" />
          <input
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                if (filtered.length) moveHighlight((highlight + 1) % filtered.length)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                if (filtered.length) moveHighlight((highlight - 1 + filtered.length) % filtered.length)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const env = filtered[highlight]
                if (env) choose(env.id)
              } else if (e.key === 'Escape') {
                // Fecha só a lista — sem isso o Esc chegava no listener do
                // SlidePanel (window) e fechava o painel inteiro junto.
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
              }
            }}
            placeholder="Search environments..."
            className="flex-1 bg-transparent text-xs text-pm-text outline-none placeholder:text-pm-text-muted"
          />
        </div>

        <div ref={listRef} className="max-h-72 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-[11px] text-pm-text-muted">No environment found</div>
          )}
          {filtered.map((env, index) => (
            <button
              key={env.id}
              type="button"
              data-env-index={index}
              onClick={() => choose(env.id)}
              onPointerMove={() => setHighlight(index)}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                index === highlight ? 'bg-pm-hover' : ''
              }`}
            >
              <ColorDot color={env.color} />
              <span className="min-w-0 flex-1 truncate text-xs text-pm-text">{env.name || 'Untitled'}</span>
              {env.id === activeEnvId && (
                <span className="shrink-0 rounded bg-emerald-500/15 px-1 text-[9px] font-bold uppercase tracking-wide text-emerald-400">
                  active
                </span>
              )}
              {env.isDirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes" />}
              <span className="shrink-0 font-mono text-[10px] text-pm-text-muted">{env.values.length}</span>
              <Check size={12} className={`shrink-0 text-blue-400 ${env.id === value.id ? '' : 'invisible'}`} />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
