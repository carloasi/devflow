'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, Copy, Check, RotateCcw, GripVertical, Trash2, List } from 'lucide-react';
import Editor, {
  Monaco,
  OnChange,
  OnMount,
} from '@monaco-editor/react';
import type { editor as MonacoEditorNS, Uri as MonacoUri } from 'monaco-editor';
import { toast } from 'sonner';
import { useEnvironment } from './EnvironmentContext';
import { useTheme } from './ThemeContext';
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes';
// Efeito de módulo: fixa a versão do Monaco antes de qualquer editor subir.
import '@/lib/monacoLoader';
import {
  VAR_REGEX,
  TrackedVarRange,
  ensureVarHighlightStyle,
  findVarAtOffset,
} from '@/lib/monacoVarHighlight';
import { DuplicateVariablePicker, DuplicateVariableEntry } from './DuplicateVariablePicker';
import { EnvironmentValue } from '@/app/types/Environment';
import { isMacPlatform } from '@/lib/platform';


interface SavedPosition {
  lineNumber: number;
  column: number;
}

const bodyPositions = new Map<string, SavedPosition>();

// O destaque de {{variavel}} vive em @/lib/monacoVarHighlight — mesmo padrão
// da URL bar (UrlInputWithVariables.tsx) e dos blocos do Collection Runner:
// azul quando a variável existe e tem valor no environment ativo, vermelho
// quando não existe ou está vazia. Clicar na variável abre o mesmo popover
// de edição rápida da URL bar.

// Detecta um par "chave": valor (formato JSON) na seleção — usado pelo
// Ctrl+Space (ver createVariableFromSelection) pra criar a variável com o
// nome da CHAVE e o valor inicial igual ao VALOR selecionado, em vez de usar
// o texto inteiro como nome. Captura espaços/vírgula ao redor pra preservar
// a formatação original ao substituir só o valor por "{{chave}}".
const KEY_VALUE_REGEX = /^(\s*)"([^"]+)"(\s*:\s*)(.+?)(,?)(\s*)$/;

// "{{ nome }}" → "{{nome}}". Só pega nomes sem espaço no meio, pra não mexer
// em nada que não seja uma referência de variável simples.
const SPACED_VAR_REGEX = /\{\{([ \t]+[^{}\s]+[ \t]*|[ \t]*[^{}\s]+[ \t]+)\}\}/g;


interface Props {
  value: string;
  onChange: (value: string) => void;
  type: 'none' | 'raw' | 'graphql';
  tabId: string;
}

export default function HttpBodyEditor({
  value,
  onChange,
  type,
  tabId,
}: Props) {
  const {
    activeEnv,
    updateEnvironment,
    getPreviousVariableValue,
    recordPreviousVariableValue,
    seedPreviousVariableValueIfMissing,
    getVariableValueHistory,
    removeVariableValueFromHistory,
    clearVariableValueHistory,
  } = useEnvironment();
  const { effectiveThemeId } = useTheme();
  const monacoTheme = getMonacoThemeName(effectiveThemeId);

  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  // Listener global (vive em monaco.editor, não no editor), então some junto
  // com o componente em vez de vazar entre abas.
  const markerFilterRef = useRef<{ dispose(): void } | null>(null);
  const decorationsRef = useRef<MonacoEditorNS.IEditorDecorationsCollection | null>(null);
  const varRangesRef = useRef<TrackedVarRange[]>([]);
  const activeValues = activeEnv?.values || [];

  // ── Popover de edição rápida (mesmo padrão do token editor da URL bar) ──
  const [editingKey, setEditingKey] = useState<string | null>(null);
  // Índice (dentro de activeValues) da entrada sendo editada — necessário
  // pra distinguir entre duplicatas com a mesma key (ver duplicateEntries
  // mais abaixo), já que várias entradas podem compartilhar o mesmo `key`.
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editCoords, setEditCoords] = useState({ x: 0, y: 0 });
  const [tempVarValue, setTempVarValue] = useState('');
  const [originalTokenValue, setOriginalTokenValue] = useState<string | undefined>(undefined);
  const [showHistory, setShowHistory] = useState(false);
  // Índice da entrada do histórico que acabou de ser copiada (até 5 entradas
  // agora, então precisa saber qual linha mostrar o ícone de "copiado").
  const [copiedHistoryIndex, setCopiedHistoryIndex] = useState<number | null>(null);
  const [copiedCurrent, setCopiedCurrent] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const editPopoverRef = useRef<HTMLDivElement>(null);
  const commitDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionOpenValueRef = useRef('');

  // ── Lista de duplicatas (Ctrl/Cmd+Click) — componente à parte, só abre
  // com o modificador segurado; o popover normal (clique simples) volta a
  // só editar o valor da entrada já escolhida.
  const [duplicatePickerKey, setDuplicatePickerKey] = useState<string | null>(null);
  const [duplicatePickerCoords, setDuplicatePickerCoords] = useState({ x: 0, y: 0 });
  const hasEditedInSessionRef = useRef(false);

  // ── Dropdown de sugestão ao digitar "{{" (mesmo padrão da URL bar) ──────
  // Tem um campo de busca próprio dentro do dropdown — filtra a lista sem
  // precisar digitar dentro do JSON (evita mexer no texto/validação
  // enquanto ainda está escolhendo a variável).
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionsCoords, setSuggestionsCoords] = useState({ x: 0, y: 0 });
  const [suggestionQuery, setSuggestionQuery] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const suggestionSearchRef = useRef<HTMLInputElement>(null);
  const showSuggestionsRef = useRef(false);
  useEffect(() => { showSuggestionsRef.current = showSuggestions; }, [showSuggestions]);
  // Token "{{variavel}}" que o dropdown vai substituir quando ele foi aberto
  // por duplo clique numa variável existente (em vez de pelo "{{" digitado).
  // Guarda o texto original pra não sobrescrever nada se o body mudou nesse
  // meio tempo.
  const replaceTargetRef = useRef<{ start: number; end: number; text: string } | null>(null);
  useEffect(() => {
    if (!showSuggestions) replaceTargetRef.current = null;
  }, [showSuggestions]);

  // ── Dica flutuante "Ctrl+Space to create a variable" quando o usuário
  // seleciona texto (ver createVariableFromSelection) — some quando a
  // seleção fica vazia, quando o conteúdo muda (a seleção some junto) ou ao
  // rolar (a posição salva ficaria desatualizada).
  const [selectionHintCoords, setSelectionHintCoords] = useState<{ x: number; y: number } | null>(null);

  const filteredVars = activeValues
    .filter(v => v.enabled && v.key.toLowerCase().includes(suggestionQuery.toLowerCase()))
    .map(v => ({ key: v.key, value: v.value }));

  const updateDecorations = useCallback(() => {
    const ed = editorRef.current;
    const monacoInstance = monacoRef.current;
    if (!ed || !monacoInstance) return;
    const model = ed.getModel();
    if (!model) return;

    const text = model.getValue();
    const decorations: MonacoEditorNS.IModelDeltaDecoration[] = [];
    const ranges: TrackedVarRange[] = [];

    VAR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = VAR_REGEX.exec(text))) {
      const key = match[0].replace(/[{}]/g, '').trim();
      const envVar = activeValues.find(v => v.key === key && v.enabled);
      const hasValue = !!envVar && !!String(envVar.value ?? '').trim();
      const duplicateCount = activeValues.filter(v => v.key === key).length;
      const startPos = model.getPositionAt(match.index);
      const endPos = model.getPositionAt(match.index + match[0].length);

      decorations.push({
        range: new monacoInstance.Range(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column
        ),
        options: {
          inlineClassName: hasValue ? 'body-var-found' : 'body-var-missing',
          hoverMessage: {
            value: [
              hasValue
                ? `**${key}** = \`${envVar!.value}\` — click to edit, double-click to swap variable`
                : `**${key}** is not defined in the active environment — click to set, double-click to swap variable`,
              duplicateCount > 1 ? `${duplicateCount} variables named "${key}" — Ctrl+Click to choose which one` : '',
            ].filter(Boolean).join('\n\n'),
          },
        },
      });

      ranges.push({
        key,
        start: match.index,
        end: match.index + match[0].length,
      });
    }

    varRangesRef.current = ranges;

    if (!decorationsRef.current) {
      decorationsRef.current = ed.createDecorationsCollection(decorations);
    } else {
      decorationsRef.current.set(decorations);
    }
  }, [activeValues]);

  // Evita closure velha dentro dos listeners registrados uma única vez no
  // mount — sem isso, trocar de environment depois de montado não
  // refletiria nas decorações/clique.
  const updateDecorationsRef = useRef(updateDecorations);
  useEffect(() => {
    updateDecorationsRef.current = updateDecorations;
  }, [updateDecorations]);

  useEffect(() => {
    ensureVarHighlightStyle();
    updateDecorations();
  }, [updateDecorations, value]);

  useEffect(() => () => {
    markerFilterRef.current?.dispose();
    markerFilterRef.current = null;
  }, []);

  const commitEditingValue = useCallback((key: string, newValue: string) => {
    if (!activeEnv) return;

    // Quando há duplicatas (mesma key em mais de uma entrada), editingIndex
    // aponta pra QUAL entrada específica está sendo editada — sem isso, o
    // `.map` abaixo atualizaria TODAS as duplicatas de uma vez só.
    if (editingIndex !== null && activeValues[editingIndex]?.key === key) {
      const nextValues = activeValues.map((v, i) => (i === editingIndex ? { ...v, value: newValue } : v));
      updateEnvironment({ ...activeEnv, values: nextValues });
      return;
    }

    const exists = activeValues.some(v => v.key === key);
    const nextValues = exists
      ? activeValues.map(v => (v.key === key ? { ...v, value: newValue } : v))
      : [...activeValues, { key, value: newValue, enabled: true, type: 'default' as const }];
    updateEnvironment({ ...activeEnv, values: nextValues });
  }, [activeEnv, activeValues, editingIndex, updateEnvironment]);

  const scheduleCommit = useCallback((key: string, newValue: string) => {
    if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
    commitDebounceRef.current = setTimeout(() => {
      commitEditingValue(key, newValue);
      commitDebounceRef.current = null;
    }, 250);
  }, [commitEditingValue]);

  const flushPendingCommit = useCallback(() => {
    if (commitDebounceRef.current && editingKey) {
      clearTimeout(commitDebounceRef.current);
      commitDebounceRef.current = null;
      commitEditingValue(editingKey, tempVarValue);
    }
  }, [commitEditingValue, editingKey, tempVarValue]);

  const markEditIfNeeded = useCallback((newValue: string) => {
    if (!editingKey || !activeEnv) return;
    if (hasEditedInSessionRef.current) return;
    if (newValue === sessionOpenValueRef.current) return;

    hasEditedInSessionRef.current = true;
    recordPreviousVariableValue(editingKey, sessionOpenValueRef.current);
    setOriginalTokenValue(sessionOpenValueRef.current);
  }, [editingKey, activeEnv, recordPreviousVariableValue]);

  const closeEditor = useCallback(() => {
    flushPendingCommit();
    setEditingKey(null);
    setEditingIndex(null);
    setShowHistory(false);
  }, [flushPendingCommit]);

  // Fecha ao clicar fora do popover.
  useEffect(() => {
    if (!editingKey) return;
    const onMouseDown = (e: MouseEvent) => {
      if (editPopoverRef.current?.contains(e.target as Node)) return;
      closeEditor();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [editingKey, closeEditor]);

  useEffect(() => {
    return () => {
      if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
    };
  }, []);

  const handleCopyCurrent = useCallback(async () => {
    if (!tempVarValue) return;
    await navigator.clipboard.writeText(tempVarValue);
    setCopiedCurrent(true);
    setTimeout(() => setCopiedCurrent(false), 1500);
  }, [tempVarValue]);

  // Copia o NOME da variável (ex: "origemIda"), não o valor — antes só dava
  // pra copiar o valor, sem jeito rápido de pegar a chave pra colar em outro
  // lugar (outro {{token}}, um script, etc).
  const handleCopyKey = useCallback(async () => {
    if (!editingKey) return;
    await navigator.clipboard.writeText(editingKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 1500);
  }, [editingKey]);

  const handleCopyHistoryValue = useCallback(async (histValue: string, index: number) => {
    await navigator.clipboard.writeText(histValue);
    setCopiedHistoryIndex(index);
    setTimeout(() => setCopiedHistoryIndex(current => (current === index ? null : current)), 1500);
  }, []);

  const handleRestoreHistoryValue = useCallback((histValue: string) => {
    if (!editingKey) return;
    if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
    markEditIfNeeded(histValue);
    setTempVarValue(histValue);
    commitEditingValue(editingKey, histValue);
  }, [editingKey, commitEditingValue, markEditIfNeeded]);

  // Últimas atualizações da variável em edição (mais recente primeiro, no
  // máximo 5) — pedido do usuário: manter uma lista em vez de só o valor
  // anterior.
  const tokenHistoryList = useMemo(() => {
    if (!editingKey || !activeEnv) return [];
    return getVariableValueHistory(editingKey);
  }, [editingKey, activeEnv, getVariableValueHistory]);

  // Remover um item / limpar todo o histórico — mesma lógica do
  // UrlInputWithVariables.tsx.
  const handleRemoveHistoryValue = useCallback((histValue: string) => {
    if (!editingKey || !activeEnv) return;
    removeVariableValueFromHistory(editingKey, histValue);
  }, [editingKey, activeEnv, removeVariableValueFromHistory]);

  const handleClearHistory = useCallback(() => {
    if (!editingKey || !activeEnv) return;
    clearVariableValueHistory(editingKey);
  }, [editingKey, activeEnv, clearVariableValueHistory]);

  const openEditorForKey = useCallback((key: string, clientX: number, clientY: number) => {
    if (!activeEnv) return;

    // Quando há duplicatas (mesma key em várias entradas), prioriza a que
    // já está habilitada — se nenhuma estiver, cai na primeira mesmo.
    const candidates = activeValues
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => v.key === key);
    const chosen = candidates.find(({ v }) => v.enabled) ?? candidates[0];
    const initialValue = chosen?.v.value ?? '';

    setEditCoords({ x: clientX, y: clientY + 16 });
    setEditingKey(key);
    setEditingIndex(chosen?.i ?? null);
    setTempVarValue(initialValue);
    sessionOpenValueRef.current = initialValue;
    hasEditedInSessionRef.current = false;

    seedPreviousVariableValueIfMissing(key, initialValue);
    setOriginalTokenValue(getPreviousVariableValue(key) ?? initialValue);
    setCopiedHistoryIndex(null);
    setShowHistory(false);
  }, [activeEnv, activeValues, seedPreviousVariableValueIfMissing, getPreviousVariableValue]);

  // Troca qual das entradas duplicadas (mesma key) está "ativa" — desabilita
  // as outras com a mesma key e habilita a escolhida, pra resolução real do
  // request (envMap, que agora filtra por `enabled`) ficar consistente com
  // o que foi escolhido aqui, e não ambígua/silenciosa como antes. Recebe a
  // key explicitamente (em vez de ler `editingKey`) porque quem chama isso
  // agora é o DuplicateVariablePicker, que abre via Ctrl+Click e não
  // depende do popover normal estar aberto.
  const handleSelectDuplicate = useCallback((key: string, index: number) => {
    if (!activeEnv) return;
    const chosen = activeValues[index];
    if (!chosen || chosen.key !== key) return;

    const nextValues = activeValues.map((v, i) => {
      if (v.key !== key) return v;
      return { ...v, enabled: i === index };
    });
    updateEnvironment({ ...activeEnv, values: nextValues });

    // Se o popover normal de edição também estiver aberto pra essa mesma
    // variável, sincroniza ele com a entrada recém-escolhida.
    if (editingKey === key) {
      setEditingIndex(index);
      const newValue = chosen.value ?? '';
      setTempVarValue(newValue);
      sessionOpenValueRef.current = newValue;
      hasEditedInSessionRef.current = false;
      setOriginalTokenValue(getPreviousVariableValue(key) ?? newValue);
      setShowHistory(false);
    }
  }, [activeEnv, activeValues, editingKey, updateEnvironment, getPreviousVariableValue]);

  const openDuplicatePickerForKey = useCallback((key: string, clientX: number, clientY: number) => {
    setDuplicatePickerCoords({ x: clientX, y: clientY + 16 });
    setDuplicatePickerKey(key);
  }, []);

  const openDuplicatePickerForKeyRef = useRef(openDuplicatePickerForKey);
  useEffect(() => {
    openDuplicatePickerForKeyRef.current = openDuplicatePickerForKey;
  }, [openDuplicatePickerForKey]);

  // Mesmo motivo do updateDecorationsRef: o listener de clique é registrado
  // uma única vez no onMount do Monaco, então sem essa ref ele ficaria preso
  // pra sempre na versão de openEditorForKey (e do activeEnv) que existia
  // naquele instante — se o environment ainda não tinha carregado no
  // momento do mount, o popover nunca mais abriria.
  const openEditorForKeyRef = useRef(openEditorForKey);
  useEffect(() => {
    openEditorForKeyRef.current = openEditorForKey;
  }, [openEditorForKey]);

  // Converte uma posição do model (linha/coluna) pra coordenadas de tela,
  // pra posicionar os popovers/dropdowns via portal.
  const positionToClientCoords = useCallback((pos: { lineNumber: number; column: number }) => {
    const ed = editorRef.current;
    if (!ed) return { x: 0, y: 0 };
    const domNode = ed.getDomNode();
    const scrolled = ed.getScrolledVisiblePosition(pos);
    if (!domNode || !scrolled) return { x: 0, y: 0 };
    const rect = domNode.getBoundingClientRect();
    return { x: rect.left + scrolled.left, y: rect.top + scrolled.top + scrolled.height };
  }, []);

  // Detecta se o cursor está logo depois de um "{{" ainda não fechado na
  // linha atual — mesma lógica de handleInputChange da URL bar, só que
  // olhando o conteúdo da linha no model do Monaco em vez de um <input>.
  // Só abre o dropdown (não fica reabrindo/resetando a busca a cada
  // digitação) — enquanto o foco está no campo de busca do dropdown, o
  // Monaco não dispara mais esses eventos de qualquer forma.
  // Fica true enquanto a última mudança no conteúdo foi uma deleção pura
  // (backspace/delete, sem inserir texto). Evita reabrir o dropdown quando o
  // usuário está apagando um "{{variavel}}" já existente (ex: apagando o
  // "}}" do fechamento) — nesse caso não faz sentido interromper a edição
  // com o modal de sugestões.
  //
  // Não dá pra confiar só no evento de conteúdo pra setar isso: o check
  // também roda no onDidChangeCursorPosition, e quando o Monaco dispara o
  // evento de cursor ANTES do de conteúdo, o check lia o valor da tecla
  // anterior (uma digitação -> false) e abria o menu no meio de uma deleção.
  // Por isso o próprio check também compara o tamanho do texto com o da
  // última vez (lastModelLengthRef): encolheu = deleção.
  const lastEditWasDeletionRef = useRef(false);
  const lastModelLengthRef = useRef<number | null>(null);

  // Marca qual "{{" (linha + índice) já disparou o popup — dispara só UMA
  // vez, no exato momento em que o "{{" é completado. Antes disso dependia
  // só de showSuggestionsRef, que é setado por um useEffect (assíncrono);
  // digitar rápido ou colar texto logo depois do "{{" podia gerar vários
  // onDidChangeModelContent antes desse ref virar true, cada um passando
  // pelo guard e reabrindo/atualizando o dropdown com o texto já digitado/
  // colado (era isso que reabria o modal ao digitar ou colar depois do
  // "{{"). Comparar direto com esse ref (setado de forma síncrona, sem
  // depender de o React re-renderizar) evita a corrida e garante que só o
  // instante exato do "{{" abre o popup — texto digitado ou colado depois
  // não reabre/atualiza mais nada, mesmo que o usuário feche o dropdown.
  const triggeredForRef = useRef<{ line: number; openIdx: number } | null>(null);

  const checkForVariableTrigger = useCallback((opts?: { force?: boolean }) => {
    const ed = editorRef.current;
    if (!ed) return;

    // Detecta a deleção pelo tamanho do texto, independente da ordem dos
    // eventos do Monaco (ver comentário em lastEditWasDeletionRef). Só uma
    // inserção (texto cresceu) libera o menu de novo — mover o cursor depois
    // de apagar não reabre.
    const currentLength = ed.getModel()?.getValueLength() ?? 0;
    const previousLength = lastModelLengthRef.current;
    if (previousLength !== null && currentLength < previousLength) {
      lastEditWasDeletionRef.current = true;
    } else if (previousLength !== null && currentLength > previousLength) {
      lastEditWasDeletionRef.current = false;
    }
    lastModelLengthRef.current = currentLength;

    if (showSuggestionsRef.current) return;
    if (!opts?.force && lastEditWasDeletionRef.current) return;

    // Enquanto o usuário está selecionando texto (arrastando o mouse ou
    // Shift+seta), o cursor "andando" pela seleção não deve contar como
    // digitação — sem isso, selecionar uma linha que contenha um
    // "{{variavel}}" abria o dropdown de sugestão no meio da seleção.
    const selection = ed.getSelection();
    if (selection && !selection.isEmpty()) return;

    const model = ed.getModel();
    const pos = ed.getPosition();
    if (!model || !pos) return;

    const lineText = model.getLineContent(pos.lineNumber);
    const before = lineText.slice(0, pos.column - 1);
    const openIdx = before.lastIndexOf('{{');
    const closeIdx = before.lastIndexOf('}}');

    if (openIdx === -1 || openIdx <= closeIdx) {
      // Sem "{{" aberto aqui (foi fechado, apagado, ou o cursor saiu da
      // linha) — libera pra um "{{" futuro poder disparar de novo.
      triggeredForRef.current = null;
      return;
    }

    const already = triggeredForRef.current;
    if (already && already.line === pos.lineNumber && already.openIdx === openIdx) return;
    triggeredForRef.current = { line: pos.lineNumber, openIdx };

    const initialQuery = before.slice(openIdx + 2).trim();
    replaceTargetRef.current = null;
    setSuggestionQuery(initialQuery);
    setSuggestionIndex(0);
    setSuggestionsCoords(positionToClientCoords(pos));
    setShowSuggestions(true);
    requestAnimationFrame(() => suggestionSearchRef.current?.focus());
  }, [positionToClientCoords]);

  const checkForVariableTriggerRef = useRef(checkForVariableTrigger);
  useEffect(() => {
    checkForVariableTriggerRef.current = checkForVariableTrigger;
  }, [checkForVariableTrigger]);

  // Ctrl/Cmd+Space com uma SELEÇÃO ativa: cria uma variável no environment
  // ativo com o nome igual ao texto selecionado (valor em branco, pra
  // preencher depois) e substitui a seleção por "{{nome}}" no editor — igual
  // ao "Set as variable" do Postman. Se a seleção inclui as aspas do JSON
  // (ex: usuário selecionou "SDU" com aspas e tudo), tira as aspas do nome
  // da variável mas devolve elas ao redor do token ("{{SDU}}"), senão o JSON
  // quebra. Retorna false quando não há seleção (nesse caso o chamador cai
  // pro comportamento antigo do Ctrl+Space: abrir o dropdown de sugestão).
  const createVariableFromSelection = useCallback((): boolean => {
    const ed = editorRef.current;
    if (!ed) return false;

    const selection = ed.getSelection();
    if (!selection || selection.isEmpty()) return false;

    const model = ed.getModel();
    if (!model) return false;

    // Selecionou (total ou parcialmente) uma "{{variavel}}" já existente —
    // não faz sentido "criar variável" em cima disso (viraria uma variável
    // com nome tipo "{{SDU}}"). Mesmo check usado pra esconder a dica.
    const startOffset = model.getOffsetAt(selection.getStartPosition());
    const endOffset = model.getOffsetAt(selection.getEndPosition());
    const overlapsVariable = varRangesRef.current.some((r) => r.start < endOffset && r.end > startOffset);
    if (overlapsVariable) return true;

    const selectedText = model.getValueInRange(selection);

    if (!activeEnv) {
      toast.error('Select an environment first to create a variable.');
      return true;
    }

    // Selecionou um par "chave": valor (ex: "token": "abc123") — usa a
    // chave como nome da variável e o valor atual como valor inicial, e
    // troca só o VALOR por "{{chave}}" no editor, mantendo a chave e a
    // formatação (vírgula/espaços) intactas.
    const kvMatch = selectedText.match(KEY_VALUE_REGEX);
    if (kvMatch) {
      const [, leading, rawKey, separator, rawValue, trailingComma, trailingSpace] = kvMatch;
      const varName = rawKey.trim();

      if (varName) {
        const valueIsQuotedString = rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"');
        const initialValue = valueIsQuotedString ? rawValue.slice(1, -1) : rawValue;

        const existingIndex = activeEnv.values.findIndex(v => v.key === varName && v.enabled);
        if (existingIndex === -1) {
          const newValue: EnvironmentValue = {
            id: crypto.randomUUID(),
            key: varName,
            value: initialValue,
            type: 'default',
            enabled: true,
          };
          updateEnvironment({ ...activeEnv, values: [...activeEnv.values, newValue] });
        } else {
          // Variável já existe — atualiza o valor pro que acabou de ser
          // selecionado (em vez de manter o valor antigo intocado), guardando
          // o valor anterior no histórico (ver "Show history" no popover).
          const existing = activeEnv.values[existingIndex];
          if (existing.value !== initialValue) {
            recordPreviousVariableValue(varName, existing.value);
            const updatedValues = activeEnv.values.map((v, i) =>
              i === existingIndex ? { ...v, value: initialValue } : v
            );
            updateEnvironment({ ...activeEnv, values: updatedValues });
          }
        }

        const valuePlaceholder = valueIsQuotedString ? `"{{${varName}}}"` : `{{${varName}}}`;
        const replacement = `${leading}"${varName}"${separator}${valuePlaceholder}${trailingComma}${trailingSpace}`;
        ed.executeEdits('create-variable-from-selection', [{ range: selection, text: replacement }]);
        ed.setPosition({ lineNumber: selection.startLineNumber, column: selection.startColumn + replacement.length });
        ed.focus();
        return true;
      }
    }

    const isQuoted = selectedText.length >= 2 && selectedText.startsWith('"') && selectedText.endsWith('"');
    const varName = (isQuoted ? selectedText.slice(1, -1) : selectedText).trim();

    if (!varName) return true;

    const alreadyExists = activeEnv.values.some(v => v.key === varName && v.enabled);
    if (!alreadyExists) {
      const newValue: EnvironmentValue = {
        id: crypto.randomUUID(),
        key: varName,
        value: '',
        type: 'default',
        enabled: true,
      };
      updateEnvironment({ ...activeEnv, values: [...activeEnv.values, newValue] });
    }

    const replacement = isQuoted ? `"{{${varName}}}"` : `{{${varName}}}`;
    ed.executeEdits('create-variable-from-selection', [{ range: selection, text: replacement }]);
    ed.setPosition({ lineNumber: selection.startLineNumber, column: selection.startColumn + replacement.length });
    ed.focus();

    return true;
  }, [activeEnv, updateEnvironment, recordPreviousVariableValue]);

  const createVariableFromSelectionRef = useRef(createVariableFromSelection);
  useEffect(() => {
    createVariableFromSelectionRef.current = createVariableFromSelection;
  }, [createVariableFromSelection]);

  // Duplo clique numa "{{variavel}}": abre o mesmo dropdown do "{{", mas a
  // escolha troca o token inteiro em vez de inserir no cursor.
  const openSuggestionsForToken = useCallback((range: TrackedVarRange, clientX: number, clientY: number) => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const start = model.getPositionAt(range.start);
    const end = model.getPositionAt(range.end);
    const text = model.getValueInRange({
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });

    replaceTargetRef.current = { start: range.start, end: range.end, text };
    setSuggestionQuery('');
    // Já deixa destacada a variável atual, pra Enter manter e ↑↓ trocar.
    const currentIndex = activeValues
      .filter(v => v.enabled)
      .findIndex(v => v.key === range.key);
    setSuggestionIndex(Math.max(0, currentIndex));
    setSuggestionsCoords({ x: clientX, y: clientY + 12 });
    setShowSuggestions(true);
    requestAnimationFrame(() => suggestionSearchRef.current?.focus());
  }, [activeValues]);

  const openSuggestionsForTokenRef = useRef(openSuggestionsForToken);
  useEffect(() => {
    openSuggestionsForTokenRef.current = openSuggestionsForToken;
  }, [openSuggestionsForToken]);

  /**
   * Do popover de volta para a lista de variáveis.
   *
   * O popover mostra UMA variável; a pergunta seguinte costuma ser "qual era
   * mesmo a outra?". Sem isto o caminho é fechar o popover, apagar o token e
   * digitar "{{" de novo só para ver a lista.
   *
   * Reaproveita o mesmo caminho do duplo clique num token, então escolher
   * algo na lista TROCA o token em vez de inserir outro no cursor.
   */
  const switchToVariableList = useCallback(() => {
    if (!editingKey) return;
    // Procura a posição atual pelo nome, em vez de guardar a do momento em
    // que o popover abriu: o texto pode ter mudado desde então, e uma
    // posição velha substituiria o trecho errado.
    const range = varRangesRef.current.find(r => r.key === editingKey);
    if (!range) return;

    const { x, y } = editCoords;
    closeEditor();
    openSuggestionsForTokenRef.current(range, x, y - 16);
  }, [editingKey, editCoords, closeEditor]);

  const selectSuggestion = useCallback((key: string) => {
    const ed = editorRef.current;
    const monacoInstance = monacoRef.current;
    if (!ed || !monacoInstance) return;
    const model = ed.getModel();
    if (!model) return;

    const target = replaceTargetRef.current;
    if (target) {
      replaceTargetRef.current = null;
      const start = model.getPositionAt(target.start);
      const end = model.getPositionAt(target.end);
      const range = new monacoInstance.Range(start.lineNumber, start.column, end.lineNumber, end.column);
      if (model.getValueInRange(range) === target.text) {
        const insertText = `{{${key}}}`;
        ed.executeEdits('replace-variable-suggestion', [{ range, text: insertText }]);
        ed.setPosition(model.getPositionAt(target.start + insertText.length));
      }
      ed.focus();
      setShowSuggestions(false);
      return;
    }

    const pos = ed.getPosition();
    if (!pos) return;

    const lineText = model.getLineContent(pos.lineNumber);
    const before = lineText.slice(0, pos.column - 1);
    const openIdx = before.lastIndexOf('{{');
    if (openIdx === -1) return;

    const insertText = `{{${key}}}`;
    const range = new monacoInstance.Range(pos.lineNumber, openIdx + 1, pos.lineNumber, pos.column);
    ed.executeEdits('insert-variable-suggestion', [{ range, text: insertText }]);

    const newColumn = openIdx + 1 + insertText.length;
    ed.setPosition({ lineNumber: pos.lineNumber, column: newColumn });
    ed.focus();
    setShowSuggestions(false);
  }, []);

  // Mantém o item destacado visível ao navegar com ↑↓ — sem isso a lista não
  // rolava junto e o destaque sumia abaixo da borda. 'nearest' só rola quando
  // o item está fora da área visível (passar o mouse não faz a lista pular).
  useEffect(() => {
    if (!showSuggestions) return;
    suggestionsRef.current
      ?.querySelector<HTMLElement>(`[data-suggestion-index="${suggestionIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [suggestionIndex, showSuggestions]);

  // Fecha o dropdown ao clicar fora dele.
  useEffect(() => {
    if (!showSuggestions) return;
    const onMouseDown = (e: MouseEvent) => {
      if (suggestionsRef.current?.contains(e.target as Node)) return;
      setShowSuggestions(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showSuggestions]);

  // Permite arrastar o popover de edição de variável pelo cabeçalho — útil
  // quando ele abre em cima de algo que o usuário precisa ver por trás.
  //
  // Precisa ficar ANTES do return antecipado abaixo. Estando depois, trocar o
  // body type entre "none" e os outros mudava a quantidade de hooks entre um
  // render e o seguinte, e o React quebra com "rendered fewer hooks than
  // expected" — o editor sumia com a tela de erro.
  const handleEditPopoverDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();

    let lastX = e.clientX;
    let lastY = e.clientY;

    const handleMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      setEditCoords(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  if (type === 'none') {
    return (
      <div className="flex flex-1 items-center justify-center bg-pm-surface text-sm italic text-pm-text-muted">
        This request has no body.
      </div>
    );
  }

  const language = type === 'graphql' ? 'graphql' : 'json';
  const hasChangedToken = originalTokenValue !== undefined && originalTokenValue !== tempVarValue;

  function handleBeforeMount(monaco: Monaco) {
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: true,
      trailingCommas: 'ignore',
    });

    // Registra os 12 temas do app no Monaco (fundo/texto/cursor/seleção
    // espelhando as --color-pm-* de cada [data-theme] em globals.css) — ver
    // src/lib/monacoThemes.ts. Sem isto, todo tema "dark" caía no vs-dark
    // padrão (cinza) e todo "light" no vs padrão, ignorando a paleta real
    // (ex.: Dracula, Monokai, Ayu Dark ficavam todos visualmente iguais).
    registerDevflowMonacoThemes(monaco);
  }

  const handleChange: OnChange = (value) => {
    onChange(value ?? '');
  };

  const handleMount: OnMount = (editorInstance, monacoInstance) => {
    editorRef.current = editorInstance;
    monacoRef.current = monacoInstance;
    decorationsRef.current = null;

    // "{{minhaVar}}" não é JSON válido, então o validador do Monaco sublinha
    // toda variável de vermelho como erro de sintaxe. Desligar a validação
    // inteira resolveria, mas levaria junto os erros REAIS (vírgula faltando,
    // chave não fechada), que são úteis escrevendo body na mão. Então aqui os
    // marcadores são filtrados: cai fora só o que se sobrepõe a um
    // placeholder, e o resto do diagnóstico continua valendo.
    //
    // Não entra em laço: depois da limpeza não sobra marcador sobreposto, o
    // evento seguinte não acha nada pra remover e a função sai antes de
    // escrever. A cada edição o worker revalida e o ciclo se repete uma vez.
    markerFilterRef.current?.dispose();
    markerFilterRef.current = monacoInstance.editor.onDidChangeMarkers((uris: readonly MonacoUri[]) => {
      const model = editorInstance.getModel();
      if (!model) return;
      if (!uris.some((u) => u.toString() === model.uri.toString())) return;

      const text = model.getValue();
      const spans: Array<[number, number]> = [];
      const re = /\{\{[^{}]+\}\}/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        spans.push([match.index, match.index + match[0].length]);
      }
      if (spans.length === 0) return;

      const markers: MonacoEditorNS.IMarker[] =
        monacoInstance.editor.getModelMarkers({ resource: model.uri });
      const owners = new Set<string>(markers.map((m) => m.owner));
      const kept = new Map<string, MonacoEditorNS.IMarkerData[]>();
      let removed = 0;

      for (const marker of markers) {
        const start = model.getOffsetAt({
          lineNumber: marker.startLineNumber,
          column: marker.startColumn,
        });
        const end = model.getOffsetAt({
          lineNumber: marker.endLineNumber,
          column: marker.endColumn,
        });
        // Marcador sem largura (o Monaco usa pra apontar uma posição) não
        // cruzaria nenhum intervalo pela regra normal de sobreposição.
        const insideVariable = spans.some(([s, e]) =>
          start === end ? s <= start && start < e : s < end && e > start
        );

        if (insideVariable) {
          removed++;
          continue;
        }
        const list = kept.get(marker.owner) ?? [];
        list.push(marker);
        kept.set(marker.owner, list);
      }

      if (removed === 0) return;

      // Percorre os owners originais, e não só os que sobraram: um owner que
      // teve TODOS os marcadores removidos precisa receber lista vazia, senão
      // os antigos continuariam desenhados.
      for (const owner of owners) {
        monacoInstance.editor.setModelMarkers(model, owner, kept.get(owner) ?? []);
      }
    });

    const saved = bodyPositions.get(tabId);

    const applyPosition = () => {
      if (!saved) return;
      editorInstance.setPosition({ lineNumber: saved.lineNumber, column: saved.column });
      editorInstance.revealLineInCenter(saved.lineNumber);
    };

    if (saved) {
      const disposable = editorInstance.onDidLayoutChange(() => {
        applyPosition();
        disposable.dispose();
      });
      setTimeout(applyPosition, 150);
    }

    editorInstance.focus();

    const savePosition = () => {
      const position = editorInstance.getPosition();
      if (position) {
        bodyPositions.set(tabId, {
          lineNumber: position.lineNumber,
          column: position.column,
        });
      }
    };

    editorInstance.onDidChangeCursorPosition(savePosition);
    editorInstance.onDidScrollChange(savePosition);
    editorInstance.onDidChangeModelContent((e) => {
      updateDecorationsRef.current();
      const isPureDeletion =
        e.changes.length > 0 && e.changes.every((c) => c.text === '' && c.rangeLength > 0);
      // Só MARCA deleção aqui; quem desmarca é o check, quando o texto cresce
      // (inserção). Antes este evento desmarcava sozinho a cada mudança.
      if (isPureDeletion) lastEditWasDeletionRef.current = true;
      setSelectionHintCoords(null);
    });

    // Limpeza automática dos espaços internos de "{{ variavel }}" — inclusive
    // em bodies salvos antes do app passar a inserir sem espaço. Edita só os
    // trechos dos tokens (cursor e Ctrl+Z continuam funcionando) e roda fora
    // do evento, porque o Monaco não aceita editar o model dentro do próprio
    // onDidChangeModelContent. Depois da edição não sobra match, então para.
    const normalizeSpacedVars = () => {
      const model = editorInstance.getModel();
      if (!model) return;
      const text = model.getValue();
      const edits: MonacoEditorNS.IIdentifiedSingleEditOperation[] = [];

      SPACED_VAR_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SPACED_VAR_REGEX.exec(text))) {
        const start = model.getPositionAt(match.index);
        const end = model.getPositionAt(match.index + match[0].length);
        edits.push({
          range: new monacoInstance.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          text: `{{${match[1].trim()}}}`,
        });
      }

      if (edits.length > 0) editorInstance.executeEdits('normalize-variable-spaces', edits);
    };
    setTimeout(normalizeSpacedVars, 0);
    editorInstance.onDidChangeModelContent(() => setTimeout(normalizeSpacedVars, 0));

    // Dropdown de sugestão de variável ao digitar "{{". A navegação por
    // teclado (↑↓ Enter Esc) acontece no campo de busca do próprio dropdown
    // (o foco sai do Monaco quando ele abre), não aqui.
    editorInstance.onDidChangeModelContent(() => checkForVariableTriggerRef.current());
    editorInstance.onDidChangeCursorPosition(() => checkForVariableTriggerRef.current());
    editorInstance.onDidScrollChange(() => setShowSuggestions(false));
    editorInstance.onDidScrollChange(() => setSelectionHintCoords(null));

    // Dica "Ctrl+Space to create a variable" — aparece perto do fim da
    // seleção sempre que o usuário seleciona algum texto (ver
    // createVariableFromSelection, disparado pelo mesmo atalho).
    editorInstance.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      if (!sel || sel.isEmpty()) {
        setSelectionHintCoords(null);
        return;
      }

      // Não mostra a dica se a seleção já é (ou toca) uma "{{variavel}}"
      // existente — não faz sentido oferecer "criar variável" em cima de
      // algo que já é uma variável. Usa varRangesRef (mesma lista de ranges
      // já calculada pelas decorações azul/vermelho) em vez de checar o
      // texto selecionado direto, porque também cobre selecionar só uma
      // PARTE do token (ex: só o "SDU" de dentro de "{{SDU}}").
      const model = editorInstance.getModel();
      if (model) {
        const startOffset = model.getOffsetAt(sel.getStartPosition());
        const endOffset = model.getOffsetAt(sel.getEndPosition());
        const overlapsVariable = varRangesRef.current.some(
          (r) => r.start < endOffset && r.end > startOffset
        );
        if (overlapsVariable) {
          setSelectionHintCoords(null);
          return;
        }
      }

      setSelectionHintCoords(
        positionToClientCoords({ lineNumber: sel.endLineNumber, column: sel.endColumn })
      );
    });

    // onMouseUp (não onMouseDown) — deixa o Monaco terminar de processar o
    // clique normalmente (posicionar cursor etc) antes de decidir se abre o
    // popover; e comparação por OFFSET no texto em vez de Range.containsPosition
    // (mais simples e evita qualquer ambiguidade de linha/coluna em token
    // wrapado).
    editorInstance.onMouseUp((e) => {
      if (
        e.target.type !== monacoInstance.editor.MouseTargetType.CONTENT_TEXT &&
        e.target.type !== monacoInstance.editor.MouseTargetType.CONTENT_EMPTY
      ) {
        return;
      }

      // Duplo clique numa variável abre a lista pra trocar por outra. Vem
      // antes do check de seleção porque o próprio duplo clique já faz o
      // Monaco selecionar a palavra. O popover de valor aberto pelo primeiro
      // clique já fechou no mousedown do segundo (clique fora dele).
      if (e.event.browserEvent.detail >= 2 && e.target.position) {
        const model = editorInstance.getModel();
        const offset = model?.getOffsetAt(e.target.position);
        const hit = offset === undefined
          ? undefined
          : findVarAtOffset(varRangesRef.current, offset);
        if (hit) {
          openSuggestionsForTokenRef.current(hit, e.event.posx, e.event.posy);
          return;
        }
      }

      // Se o usuário arrastou pra selecionar texto (linha inteira ou
      // qualquer trecho), não abre o popover — só clique "seco" na
      // variável deve abrir. Sem isso, selecionar uma linha que contém
      // uma {{variavel}} abria o editor de valor no mouseup.
      const selection = editorInstance.getSelection();
      if (selection && !selection.isEmpty()) return;

      const pos = e.target.position;
      if (!pos) return;

      const model = editorInstance.getModel();
      if (!model) return;
      const offset = model.getOffsetAt(pos);

      const hit = findVarAtOffset(varRangesRef.current, offset);
      if (!hit) return;

      // Ctrl/Cmd+Click abre a lista de duplicatas (componente à parte);
      // clique simples continua abrindo o popover normal de edição.
      if (e.event.ctrlKey || e.event.metaKey) {
        openDuplicatePickerForKeyRef.current(hit.key, e.event.posx, e.event.posy);
      } else {
        openEditorForKeyRef.current(hit.key, e.event.posx, e.event.posy);
      }
    });

    // Ctrl+Space (Cmd+Space no macOS): com uma seleção ativa, cria uma
    // variável no environment atual a partir do texto selecionado (ver
    // createVariableFromSelection). Sem seleção, mantém o comportamento
    // antigo — abre manualmente o dropdown de variáveis quando o cursor
    // está logo depois de um "{{" ainda não fechado, igual ao IntelliSense
    // de outros editores. Sobrescreve o trigger-suggest padrão do Monaco
    // nesse atalho.
    editorInstance.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Space,
      () => {
        if (createVariableFromSelectionRef.current()) return;
        checkForVariableTriggerRef.current({ force: true });
      }
    );

    updateDecorationsRef.current();
  };

  // Todas as entradas do environment ativo que compartilham a mesma key da
  // variável sendo editada — se tiver mais de uma, o popover mostra um
  // dropdown pra escolher qual delas é "a" usada (ver handleSelectDuplicate).
  const duplicateEntries = editingKey
    ? activeValues.reduce<{ index: number; entry: typeof activeValues[number] }[]>((acc, entry, index) => {
        if (entry.key === editingKey) acc.push({ index, entry });
        return acc;
      }, [])
    : [];

  // Entradas mostradas no DuplicateVariablePicker (aberto via Ctrl+Click).
  const duplicatePickerEntries = duplicatePickerKey
    ? activeValues.reduce<DuplicateVariableEntry[]>((acc, entry, index) => {
        if (entry.key === duplicatePickerKey) {
          acc.push({ index, value: entry.value, enabled: entry.enabled, description: entry.description });
        }
        return acc;
      }, [])
    : [];

  const duplicatePickerSelectedIndex = duplicatePickerEntries.find(e => e.enabled)?.index
    ?? duplicatePickerEntries[0]?.index
    ?? null;

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <Editor
        loading={
          <div className="flex h-full items-center justify-center text-pm-text-muted">
            Loading editor...
          </div>
        }
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        height="100%"
        language={language}
        theme={monacoTheme}
        value={value}
        onChange={handleChange}
        options={{
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: 'Fira Code, Consolas, monospace',
          fontLigatures: true,
          lineNumbers: 'on',
          tabSize: 2,
          insertSpaces: true,
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          roundedSelection: true,
          renderLineHighlight: 'all',
          matchBrackets: 'always',
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true, highlightActiveIndentation: true },
          padding: { top: 0, bottom: 4 },
          smoothScrolling: true,
          scrollbar: {
            vertical: 'auto',
            horizontal: 'auto',
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 10,
            useShadows: false,
          },
          folding: true,
          foldingHighlight: true,
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: 'on',
          snippetSuggestions: 'inline',
          suggest: { showKeywords: true, showSnippets: true },
          renderValidationDecorations: 'on',
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          // Sem isso, o hover widget (tooltip de variável — "username = ...
          // click to edit") fica clipado pelo overflow-hidden do container
          // do editor quando a linha está perto do topo, ficando parcialmente
          // escondido atrás da barra de tabs (Params/Auth/Headers/Body...)
          // acima. Com fixedOverflowWidgets, o Monaco renderiza esses
          // widgets (hover, suggest, etc.) num container fixed no viewport,
          // fora do fluxo clipado.
          fixedOverflowWidgets: true,
        }}
      />

      {/* ── Dica "Ctrl+Space to create a variable" ao selecionar texto ── */}
      {selectionHintCoords &&
        !showSuggestions &&
        createPortal(
          <div
            style={{ left: selectionHintCoords.x, top: selectionHintCoords.y + 4 }}
            className="fixed z-[99999] flex items-center gap-1 rounded-md border border-pm-border bg-pm-surface px-1.5 py-1 font-sans text-[10px] text-pm-text-muted shadow-[0_6px_18px_rgba(0,0,0,0.5)] pointer-events-none animate-in fade-in zoom-in-95 duration-100"
          >
            <kbd className="rounded border border-pm-border bg-pm-hover px-1 py-[1px] font-mono text-[9px] text-pm-text">
              {isMacPlatform ? '⌘' : 'Ctrl'}
            </kbd>
            <span>+</span>
            <kbd className="rounded border border-pm-border bg-pm-hover px-1 py-[1px] font-mono text-[9px] text-pm-text">
              Space
            </kbd>
            <span className="ml-0.5">to create a variable</span>
          </div>,
          document.body
        )}

      {/* ── Dropdown de sugestão ao digitar "{{" — mesmo padrão da URL bar ── */}
      {showSuggestions &&
        createPortal(
          <div
            ref={suggestionsRef}
            style={{ left: suggestionsCoords.x, top: suggestionsCoords.y + 4 }}
            className="fixed z-[99999] flex max-h-[320px] w-[400px] flex-col overflow-hidden rounded-lg border border-pm-border bg-pm-surface font-sans shadow-[0_12px_36px_rgba(0,0,0,0.55)] animate-in fade-in zoom-in-95 duration-100"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-pm-border bg-pm-hover/60 px-3 py-2">
              <span className="text-[11px] text-pm-text-muted">Variables</span>
              <span className="text-[11px] font-bold text-[#3c89e0]">
                {activeEnv?.name ?? 'No env'}
              </span>
            </div>

            <div className="shrink-0 p-2 border-b border-pm-border">
              <input
                ref={suggestionSearchRef}
                type="text"
                value={suggestionQuery}
                placeholder="Search variable..."
                onChange={e => {
                  setSuggestionQuery(e.target.value);
                  setSuggestionIndex(0);
                }}
                onKeyDown={e => {
                  if (filteredVars.length === 0) {
                    if (e.key === 'Escape') { e.preventDefault(); setShowSuggestions(false); }
                    return;
                  }
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSuggestionIndex(i => (i + 1) % filteredVars.length);
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSuggestionIndex(i => (i - 1 + filteredVars.length) % filteredVars.length);
                  } else if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    selectSuggestion(filteredVars[suggestionIndex].key);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setShowSuggestions(false);
                  }
                }}
                className="w-full h-7 px-2 rounded-md bg-pm-hover border border-pm-border text-[12px] font-mono text-pm-text placeholder:text-pm-text-muted outline-none focus:border-[#3c89e0]/50"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {filteredVars.length === 0 && (
                <div className="px-3 py-3 text-[11px] text-pm-text-muted text-center">
                  No variables found.
                </div>
              )}
              {filteredVars.map((v, idx) => (
                <button
                  key={`${v.key}-${idx}`}
                  data-suggestion-index={idx}
                  onClick={() => selectSuggestion(v.key)}
                  onPointerMove={() => setSuggestionIndex(idx)}
                  className={`flex w-full cursor-pointer items-center gap-[10px] border-b border-pm-border px-3 py-[9px] text-left border-none transition-colors ${
                    idx === suggestionIndex ? 'bg-[rgba(60,137,224,0.08)]' : 'bg-transparent'
                  }`}
                >
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border border-[rgba(76,175,80,0.3)] bg-[rgba(76,139,175,0.12)] text-[10px] font-extrabold text-[#4caf70]">
                    E
                  </span>

                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-pm-text">
                    {v.key}
                  </span>

                  <span
                    className={`max-w-[110px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] font-semibold ${
                      v.value ? 'text-[rgb(60,137,224)]' : 'text-pm-text-muted'
                    }`}
                  >
                    {v.value || 'no value'}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex shrink-0 items-center gap-3 border-t border-pm-border bg-pm-hover/40 px-3 py-1.5">
              <span className="text-[10px] text-pm-text-muted">↑↓ navigate</span>
              <span className="text-[10px] text-pm-text-muted">↵ select</span>
            </div>
          </div>,
          document.body
        )}

      {/* ── Popover de edição rápida da variável — mesmo padrão da URL bar ── */}
      {editingKey &&
        createPortal(
          <div
            ref={editPopoverRef}
            style={{ left: editCoords.x, top: editCoords.y }}
            className="fixed z-[100000] w-fit min-w-[300px] max-w-[90vw] overflow-hidden rounded-lg border border-pm-border bg-pm-surface font-sans shadow-[0_12px_36px_rgba(0,0,0,0.6)] animate-in fade-in zoom-in-95 duration-150"
          >
            <div
              onMouseDown={handleEditPopoverDragStart}
              title="Drag to move"
              className="flex cursor-grab select-none items-center justify-between gap-4 border-b border-pm-border bg-pm-hover/60 px-3 py-2.5 active:cursor-grabbing"
            >
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded border border-[rgba(76,175,80,0.3)] bg-[rgba(76,175,80,0.12)] text-[10px] font-extrabold text-[#4caf70]">
                  E
                </span>
                <span className="text-[11px] text-pm-text-muted">Environment</span>
              </div>

              <div className="flex items-center gap-1.5 min-w-0">
                <span className="truncate whitespace-nowrap font-mono text-[11px] font-bold text-pm-text">
                  {editingKey}
                </span>

                <button
                  type="button"
                  // O header inteiro é a alça de arrastar (onMouseDown acima)
                  // — sem isso, clicar aqui também iniciaria um drag em vez
                  // de só copiar.
                  onMouseDown={e => e.stopPropagation()}
                  onClick={handleCopyKey}
                  title={copiedKey ? 'Copied!' : 'Copy variable name'}
                  className="shrink-0 p-1 rounded text-pm-text-muted hover:text-blue-400 hover:bg-pm-surface transition-colors cursor-pointer"
                >
                  {copiedKey ? (
                    <Check size={11} className="text-green-400" />
                  ) : (
                    <Copy size={11} />
                  )}
                </button>

                <button
                  type="button"
                  // O header inteiro é alça de arrastar — sem isto o clique
                  // viraria um drag.
                  onMouseDown={e => e.stopPropagation()}
                  onClick={switchToVariableList}
                  title="Switch to the variable list — picking one replaces this token"
                  className="shrink-0 p-1 rounded text-pm-text-muted hover:text-blue-400 hover:bg-pm-surface transition-colors cursor-pointer"
                >
                  <List size={11} />
                </button>

                {/* Alça visual de arrastar — o cursor "grab" do CSS sozinho
                    nem sempre é óbvio (e em alguns webviews o browser sequer
                    troca o cursor), então mostra um ícone explícito. */}
                <GripVertical size={13} className="shrink-0 text-pm-text-muted/60" />
              </div>
            </div>

            <div className="flex flex-col gap-1.5 p-3">
              {duplicateEntries.length > 1 && (
                <div className="text-[10px] font-medium text-amber-400/90">
                  {duplicateEntries.length} variables named &ldquo;{editingKey}&rdquo; — Ctrl+Click the variable to choose
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <div className="inline-grid flex-1 min-w-0 grid-cols-1 items-center">
                  <span className="col-start-1 row-start-1 h-[32px] w-[290px] overflow-hidden whitespace-nowrap px-2.5 opacity-0 font-mono text-[12px]">
                    {tempVarValue || ' '}
                  </span>

                  <input
                    type="text"
                    value={tempVarValue}
                    autoFocus
                    onChange={e => {
                      const next = e.target.value;
                      setTempVarValue(next);
                      markEditIfNeeded(next);
                      scheduleCommit(editingKey, next);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        closeEditor();
                      }
                      if (e.key === 'Escape') {
                        if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
                        if (sessionOpenValueRef.current !== tempVarValue) {
                          commitEditingValue(editingKey, sessionOpenValueRef.current);
                        }
                        setEditingKey(null);
                        setShowHistory(false);
                      }
                    }}
                    className="col-start-1 row-start-1 z-30 h-[32px] w-full rounded-md border border-pm-border bg-pm-hover px-2.5 font-mono text-[12px] text-pm-text caret-pm-text-muted outline-none transition-colors focus:border-[#3c89e0]/50 focus:bg-pm-hover"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleCopyCurrent}
                  title={copiedCurrent ? 'Copied!' : 'Copy value'}
                  className="shrink-0 p-1.5 rounded text-pm-text-muted hover:text-blue-400 hover:bg-pm-hover transition-colors cursor-pointer"
                >
                  {copiedCurrent ? (
                    <Check size={12} className="text-green-400" />
                  ) : (
                    <Copy size={12} />
                  )}
                </button>
              </div>

              {tokenHistoryList.length > 0 && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setShowHistory(v => !v)}
                      className="flex items-center gap-1 px-1 py-0.5 -ml-1 rounded text-[10px] text-pm-text-muted hover:text-pm-text-secondary transition-colors cursor-pointer"
                    >
                      <History size={10} className={hasChangedToken ? 'text-amber-500/70' : ''} />
                      <span>{showHistory ? 'Hide history' : `Show history (${tokenHistoryList.length})`}</span>
                      {hasChangedToken && !showHistory && (
                        <span className="w-1 h-1 rounded-full bg-amber-500 ml-0.5" />
                      )}
                    </button>

                    {showHistory && (
                      <button
                        type="button"
                        onClick={handleClearHistory}
                        title="Clear this variable's whole history"
                        className="flex items-center gap-1 px-1 py-0.5 rounded text-[10px] text-pm-text-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                      >
                        <Trash2 size={10} />
                        Clear all
                      </button>
                    )}
                  </div>

                  <div
                    className={`grid transition-all duration-200 ease-out ${
                      showHistory ? 'grid-rows-[1fr] opacity-100 mt-1.5' : 'grid-rows-[0fr] opacity-0'
                    }`}
                  >
                    <div className="overflow-hidden flex flex-col gap-1">
                      {tokenHistoryList.map((histValue, index) => {
                        const isDifferentFromCurrent = histValue !== tempVarValue;
                        return (
                          <div
                            key={index}
                            className="flex items-center gap-1.5 h-[28px] px-2.5 rounded-md bg-pm-hover/60 border border-pm-border"
                          >
                            <span
                              className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
                                index === 0 && isDifferentFromCurrent ? 'text-amber-400/90' : 'text-pm-text-muted'
                              }`}
                              title={histValue}
                            >
                              {histValue || (
                                <i className="not-italic text-pm-text-muted font-sans">empty</i>
                              )}
                            </span>

                            <button
                              type="button"
                              onClick={() => handleCopyHistoryValue(histValue, index)}
                              title={copiedHistoryIndex === index ? 'Copied!' : 'Copy value'}
                              className="shrink-0 p-1 rounded text-pm-text-muted hover:text-blue-400 hover:bg-pm-hover transition-colors cursor-pointer"
                            >
                              {copiedHistoryIndex === index ? (
                                <Check size={11} className="text-green-400" />
                              ) : (
                                <Copy size={11} />
                              )}
                            </button>

                            {isDifferentFromCurrent && (
                              <button
                                type="button"
                                onClick={() => handleRestoreHistoryValue(histValue)}
                                title="Restore this value"
                                className="shrink-0 p-1 rounded text-pm-text-muted hover:text-amber-400 hover:bg-pm-hover transition-colors cursor-pointer"
                              >
                                <RotateCcw size={11} />
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => handleRemoveHistoryValue(histValue)}
                              title="Remove from history"
                              className="shrink-0 p-1 rounded text-pm-text-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}

      {/* ── Lista de duplicatas — componente à parte, só abre com Ctrl/Cmd+Click ── */}
      {duplicatePickerKey && duplicatePickerEntries.length > 0 && (
        <DuplicateVariablePicker
          variableKey={duplicatePickerKey}
          x={duplicatePickerCoords.x}
          y={duplicatePickerCoords.y}
          entries={duplicatePickerEntries}
          selectedIndex={duplicatePickerSelectedIndex}
          onSelect={index => handleSelectDuplicate(duplicatePickerKey, index)}
          onClose={() => setDuplicatePickerKey(null)}
        />
      )}
    </div>
  );
}
