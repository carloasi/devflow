'use client'

import { useState } from 'react'
import { VariableQuickPopover } from './VariableQuickPopover'

// ─────────────────────────────────────────────────────────────────────────
// Texto com as {{variáveis}} como chips clicáveis, para a URL da linha do
// Runner.
//
// Mostra o texto CRU, não o resolvido: a resolução é o que se quer conferir,
// e um valor já substituído não diz de qual variável veio nem dá onde
// corrigi-la. O valor resolvido aparece no chip (e inteiro no title), que é
// onde ele é útil.
//
// Mesmo código de cor do resto do app: azul quando a variável tem valor,
// vermelho quando não tem — ali "não definida" costuma ser a causa da falha.
//
// Clicar abre o MESMO popover de environment que a URL/body da request aberta
// usam (histórico, copiar nome/valor) — ver VariableQuickPopover.
// ─────────────────────────────────────────────────────────────────────────

interface Props {
  /** Texto cru, com {{nome}} ainda por resolver. */
  text: string
  /** Valor atual de uma variável no environment em uso. */
  valueOf: (key: string) => string | undefined
  /** Grava o novo valor. */
  onCommit: (key: string, value: string) => void
  /** Environment que o Runner de fato usa — repassado ao popover pra ele
   *  saber distinguir "editando o que a request usa" de "só espiando outro". */
  activeEnvId: string | null
  /** Troca o token clicado ("{{antiga}}") por outra variável ("{{nova}}") no
   *  texto cru — "switch to variable list" do popover. Ausente = sem URL
   *  editável pra escrever de volta (o popover então não mostra a opção). */
  onReplaceToken?: (oldToken: string, newKey: string) => void
  /** Quebra em várias linhas (payload) ou mantém em linha (URL). */
  multiline?: boolean
}

const TOKEN = /(\{\{\s*[\w.-]+\s*\}\})/g

export function VariableText({ text, valueOf, onCommit, activeEnvId, onReplaceToken, multiline = false }: Props) {
  // Variável aberta para edição, de onde o clique veio (pra posicionar o
  // popover) e o texto literal do token ("{{nome}}", pra trocar por outra
  // variável mantendo espaços internos exatamente como estavam). Uma por
  // vez: duas caixas abertas na mesma linha competiriam pelo espaço, que já
  // é estreito.
  const [editing, setEditing] = useState<{ key: string; token: string; anchorRect: DOMRect } | null>(null)
  const [justSaved, setJustSaved] = useState<string | null>(null)

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
              onClick={e => {
                e.stopPropagation()
                setEditing({ key: name, token: part, anchorRect: e.currentTarget.getBoundingClientRect() })
              }}
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
        <VariableQuickPopover
          varKey={editing.key}
          initial={valueOf(editing.key) ?? ''}
          activeEnvId={activeEnvId}
          anchorRect={editing.anchorRect}
          onClose={() => setEditing(null)}
          onCommit={next => {
            const key = editing.key
            onCommit(key, next)
            setJustSaved(key)
            setTimeout(() => setJustSaved(prev => (prev === key ? null : prev)), 1200)
          }}
          onReplaceWith={
            onReplaceToken &&
            (newKey => {
              onReplaceToken(editing.token, newKey)
              setEditing(null)
            })
          }
        />
      )}
    </div>
  )
}
