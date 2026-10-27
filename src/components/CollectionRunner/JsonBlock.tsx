'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditorNS } from 'monaco-editor'
import { useTheme } from '@/components/ThemeContext'
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes'
import {
  TrackedVarRange,
  scanVars,
  ensureVarHighlightStyle,
  findVarAtOffset,
} from '@/lib/monacoVarHighlight'
// Efeito de módulo: fixa a versão do Monaco antes de qualquer editor subir.
import '@/lib/monacoLoader'
import { VariableEditRow } from './VariableEditRow'

// ─────────────────────────────────────────────────────────────────────────
// Payload e Response da linha do Runner, no MESMO editor do Body.
//
// Antes eram <pre> cru: 10 KB de JSON numa caixa estreita, sem cor, sem
// dobrar bloco, sem busca. O Monaco traz tudo isso de graça — e, com as
// decorações de {{variavel}}, o texto continua sendo o CRU, que é o que
// permite ver de qual variável veio cada pedaço e corrigi-la ali mesmo.
// ─────────────────────────────────────────────────────────────────────────

// Fixo pra que a altura do bloco possa ser calculada; o padrão do Monaco
// varia com o fontSize e deixaria o cálculo chutado.
const LINE_HEIGHT = 17
const FONT_SIZE = 11.5
// Tem que bater com o `padding` passado ao Monaco (top + bottom).
const PADDING = 12
const MIN_HEIGHT = LINE_HEIGHT + PADDING

interface Props {
  /** Texto a mostrar, já formatado por quem chama. */
  value: string
  /** Teto da caixa em px — passado o teto, o editor rola por dentro. */
  maxHeight?: number
  /**
   * Liga as {{variaveis}} clicáveis. Sem isto o bloco é só leitura — é o
   * caso da Response, onde não há variável por resolver.
   */
  variableValue?: (key: string) => string | undefined
  onCommitVariable?: (key: string, value: string) => void
}

// JSON ganha cor e dobra de bloco; qualquer outra coisa (HTML, texto de
// erro, corpo cortado no meio) iria piscar de vermelho com o validador do
// JSON ligado, então entra como texto puro.
function detectLanguage(text: string): 'json' | 'plaintext' {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 'plaintext'
  try {
    JSON.parse(trimmed)
    return 'json'
  } catch {
    return 'plaintext'
  }
}

export function JsonBlock({ value, maxHeight = 288, variableValue, onCommitVariable }: Props) {
  const { effectiveThemeId } = useTheme()

  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const decorationsRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(null)
  const varRangesRef = useRef<TrackedVarRange[]>([])

  // O handler de clique do Monaco é registrado uma vez, no mount, e por isso
  // congelaria a primeira versão de variableValue/onCommitVariable — que são
  // redefinidas a cada render do painel. O ref é a ponte.
  const varsRef = useRef<Pick<Props, 'variableValue' | 'onCommitVariable'>>({})
  useEffect(() => {
    varsRef.current = { variableValue, onCommitVariable }
  })

  const [mounted, setMounted] = useState(false)
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState<string | null>(null)

  const language = useMemo(() => detectLanguage(value), [value])

  // O que as decorações dependem, reduzido a uma string: assim o efeito que
  // as aplica só roda quando o texto ou algum valor REALMENTE mudou, e não a
  // cada render do painel (que é a cada tecla digitada em qualquer campo).
  const varsSignature = useMemo(() => {
    if (!variableValue) return ''
    const keys = new Set(scanVars(value).map(v => v.key))
    return Array.from(keys)
      .map(key => `${key}=${variableValue(key) ?? ''}`)
      .join('|')
  }, [value, variableValue])

  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    const collection = decorationsRef.current
    const readValue = varsRef.current.variableValue
    if (!editor || !monaco || !collection || !readValue) return
    const model = editor.getModel()
    if (!model) return

    const decorations: MonacoEditorNS.IModelDeltaDecoration[] = []
    const ranges: TrackedVarRange[] = []

    for (const { key, start: from, end: to } of scanVars(model.getValue())) {
      const resolved = readValue(key)
      const hasValue = !!resolved?.trim()
      const start = model.getPositionAt(from)
      const end = model.getPositionAt(to)

      decorations.push({
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: {
          inlineClassName:
            justSaved === key
              ? 'body-var-saved'
              : hasValue
                ? 'body-var-found'
                : 'body-var-missing',
          hoverMessage: {
            value: hasValue
              ? `**${key}** = \`${resolved}\` — click to edit`
              : `**${key}** is not defined in this environment — click to set`,
          },
        },
      })
      ranges.push({ key, start: from, end: to })
    }

    varRangesRef.current = ranges
    collection.set(decorations)
  }, [value, varsSignature, justSaved, mounted])

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    decorationsRef.current = editor.createDecorationsCollection([])
    ensureVarHighlightStyle()

    // A altura vem do próprio Monaco e não da contagem de linhas: com
    // wordWrap ligado, uma linha longa ocupa várias e o cálculo por \n
    // cortaria o fim do conteúdo.
    setContentHeight(editor.getContentHeight())
    editor.onDidContentSizeChange(() => setContentHeight(editor.getContentHeight()))

    editor.onMouseDown(e => {
      if (!varsRef.current.variableValue) return
      const position = e.target.position
      const model = editor.getModel()
      if (!position || !model) return
      const hit = findVarAtOffset(varRangesRef.current, model.getOffsetAt(position))
      if (hit) setEditing(hit.key)
    })

    setMounted(true)
  }

  // Antes de o editor medir, o palpite por linhas evita que a caixa nasça
  // com 0px e pule de tamanho na frente de quem está lendo.
  const estimated = value.split('\n').length * LINE_HEIGHT + PADDING
  const natural = Math.min(maxHeight, contentHeight ?? estimated)
  // No teto, corta num múltiplo de linha: meia linha aparecendo na borda lê
  // como se o conteúdo estivesse corrompido, não como "tem mais, role".
  const height = Math.max(
    MIN_HEIGHT,
    natural >= maxHeight
      ? Math.floor((maxHeight - PADDING) / LINE_HEIGHT) * LINE_HEIGHT + PADDING
      : natural
  )

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="overflow-hidden rounded border border-pm-border/60"
        style={{ height }}
        // O clique dentro do editor não é "clicar na linha do Runner": sem
        // isto, selecionar um trecho do JSON fecharia/abriria o passo.
        onClick={e => e.stopPropagation()}
      >
        <Editor
          height="100%"
          language={language}
          theme={getMonacoThemeName(effectiveThemeId)}
          beforeMount={(monaco: Monaco) => registerDevflowMonacoThemes(monaco)}
          value={value}
          onMount={handleMount}
          options={{
            readOnly: true,
            // Sem isto o Monaco mantém um textarea escondido com foco, e o
            // teclado do modal (Esc pra fechar) para de funcionar depois de
            // um clique no bloco.
            domReadOnly: true,
            fontSize: FONT_SIZE,
            lineHeight: LINE_HEIGHT,
            fontFamily: 'Fira Code, Consolas, monospace',
            lineNumbers: 'on',
            lineNumbersMinChars: 3,
            lineDecorationsWidth: 4,
            glyphMargin: false,
            folding: true,
            wordWrap: 'on',
            wrappingIndent: 'indent',
            automaticLayout: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            minimap: { enabled: false },
            stickyScroll: { enabled: false },
            padding: { top: 6, bottom: 6 },
            scrollbar: {
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8,
              alwaysConsumeMouseWheel: false,
              useShadows: false,
            },
          }}
        />
      </div>

      {editing && (
        <VariableEditRow
          varKey={editing}
          initial={variableValue?.(editing) ?? ''}
          onCancel={() => setEditing(null)}
          onCommit={next => {
            const key = editing
            setEditing(null)
            onCommitVariable?.(key, next)
            setJustSaved(key)
            setTimeout(() => setJustSaved(prev => (prev === key ? null : prev)), 1200)
          }}
        />
      )}
    </div>
  )
}
