'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────
// A caixinha de "corrigir o valor desta variável aqui mesmo", usada pelos
// chips da URL (VariableText) e pelos blocos de Payload/Response do Runner
// (JsonBlock). Uma só porque o comportamento tem detalhe demais pra viver em
// duas cópias — o Esc, em especial.
// ─────────────────────────────────────────────────────────────────────────

interface Props {
  /** Variável aberta para edição. */
  varKey: string
  /** Valor com que a caixa abre — e contra o qual se decide se houve mudança. */
  initial: string
  /** Fecha sem gravar. */
  onCancel: () => void
  /** Fecha gravando. Só é chamado quando o valor mudou de verdade. */
  onCommit: (value: string) => void
}

export function VariableEditRow({ varKey, initial, onCancel, onCommit }: Props) {
  const [draft, setDraft] = useState(initial)

  const commit = () => {
    if (draft === initial) {
      onCancel()
      return
    }
    onCommit(draft)
  }

  return (
    <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
      <span className="shrink-0 font-mono text-[10px] text-[#63b3ed]">{varKey}</span>
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            // No evento nativo: o Radix escuta keydown no document, e só o
            // stopPropagation do React deixaria o modal fechar.
            e.nativeEvent.stopImmediatePropagation()
            onCancel()
          }
        }}
        spellCheck={false}
        placeholder="(empty)"
        className="flex-1 min-w-0 rounded border border-pm-border bg-pm-bg px-1.5 py-0.5 font-mono text-[10.5px] text-pm-text outline-none focus:border-[#f26b3a]/60"
      />
      <Check size={11} className="shrink-0 text-pm-text-muted/60" />
    </div>
  )
}
