'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────
// Texto com as {{variáveis}} como chips clicáveis, para a URL e o payload da
// linha do Runner.
//
// Mostra o texto CRU, não o resolvido: a resolução é o que se quer conferir,
// e um valor já substituído não diz de qual variável veio nem dá onde
// corrigi-la. O valor resolvido aparece no chip (e inteiro no title), que é
// onde ele é útil.
//
// Mesmo código de cor do resto do app: azul quando a variável tem valor,
// vermelho quando não tem — ali "não definida" costuma ser a causa da falha.
// ─────────────────────────────────────────────────────────────────────────

interface Props {
  /** Texto cru, com {{nome}} ainda por resolver. */
  text: string
  /** Valor atual de uma variável no environment em uso. */
  valueOf: (key: string) => string | undefined
  /** Grava o novo valor. */
  onCommit: (key: string, value: string) => void
  /** Quebra em várias linhas (payload) ou mantém em linha (URL). */
  multiline?: boolean
}

const TOKEN = /(\{\{\s*[\w.-]+\s*\}\})/g

export function VariableText({ text, valueOf, onCommit, multiline = false }: Props) {
  // Variável aberta para edição, e o rascunho. Uma por vez: duas caixas
  // abertas na mesma linha competiriam pelo espaço, que já é estreito.
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [justSaved, setJustSaved] = useState<string | null>(null)

  const open = (key: string) => {
    setEditing(key)
    setDraft(valueOf(key) ?? '')
  }

  const commit = () => {
    if (!editing) return
    const key = editing
    setEditing(null)
    if (draft === (valueOf(key) ?? '')) return
    onCommit(key, draft)
    setJustSaved(key)
    setTimeout(() => setJustSaved(prev => (prev === key ? null : prev)), 1200)
  }

  const parts = text.split(TOKEN)

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={`font-mono text-[10.5px] text-pm-text-secondary ${
          multiline ? 'whitespace-pre-wrap break-words max-h-56 overflow-y-auto' : 'break-all'
        }`}
      >
        {parts.map((part, i) => {
          const name = part.match(/^\{\{\s*([\w.-]+)\s*\}\}$/)?.[1]
          if (!name) return <span key={i}>{part}</span>

          const value = valueOf(name)
          const hasValue = !!value?.trim()
          return (
            <span
              key={i}
              onClick={e => { e.stopPropagation(); open(name) }}
              title={hasValue ? `${name} = ${value}` : `${name} is not defined in this environment`}
              className={`cursor-pointer whitespace-pre rounded-[3px] px-[1px] font-semibold outline-[1px] transition-colors ${
                justSaved === name
                  ? 'bg-[rgba(79,240,157,0.14)] text-[#4ff09d] outline-[rgba(79,240,157,0.4)]'
                  : hasValue
                    ? 'bg-[rgba(60,137,224,0.12)] text-[#3c89e0] outline-[rgba(60,137,224,0.35)] hover:bg-[rgba(60,137,224,0.18)]'
                    : 'bg-[rgba(224,108,117,0.12)] text-[#e06c75] outline-[rgba(224,108,117,0.35)] hover:bg-[rgba(224,108,117,0.18)]'
              }`}
            >
              {part}
            </span>
          )
        })}
      </div>

      {editing && (
        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
          <span className="shrink-0 font-mono text-[10px] text-[#63b3ed]">{editing}</span>
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') {
                // No evento nativo: o Radix escuta keydown no document, e só
                // o stopPropagation do React deixaria o modal fechar.
                e.nativeEvent.stopImmediatePropagation()
                setEditing(null)
              }
            }}
            spellCheck={false}
            placeholder="(empty)"
            className="flex-1 min-w-0 rounded border border-pm-border bg-pm-bg px-1.5 py-0.5 font-mono text-[10.5px] text-pm-text outline-none focus:border-[#f26b3a]/60"
          />
          <Check size={11} className="shrink-0 text-pm-text-muted/60" />
        </div>
      )}
    </div>
  )
}
