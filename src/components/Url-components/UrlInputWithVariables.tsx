'use client';

import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from 'react';
import { createPortal } from 'react-dom';
import { History, Copy, Check, RotateCcw, X, Trash2 } from 'lucide-react';
import { useEnvironment } from '@/components/EnvironmentContext';
import { QueryParam } from '@/app/types/QueryParam';
import { getPathParameterValue, getLegacyStoredTabs } from '@/lib/utils';
import { DuplicateVariablePicker, DuplicateVariableEntry } from '../DuplicateVariablePicker';

// O texto real do input fica transparente por baixo da camada visual
// colorida. Com essa camada por cima, o texto SELECIONADO do input também tem
// que ficar transparente (só o fundo da seleção aparece) — senão ele é
// desenhado por baixo da camada, levemente fora de posição por causa do
// respiro em volta das variáveis ("//" duplicadas). Durante o arraste a
// camada some e o texto selecionado volta a aparecer.
//
// O background é explícito de propósito: no Chromium, definir ::selection só
// com `color` zera o fundo da seleção. Fica num <style> do próprio componente
// (e não no globals.css) pra não depender do CSS global ser recompilado.
const URL_INPUT_SELECTION_CSS = `
.url-var-input::selection { color: transparent; background: #264f78; }
.url-var-input[data-selecting='true']::selection { color: #d4d4d4; background: #264f78; }
`;

interface UrlInputProps {
  value: string;
  onChange: (val: string) => void;
  params?: QueryParam[];
  onPathParamsChange?: (params: QueryParam[]) => void;
  placeholder?: string;
  className?: string;
}

export const UrlInputWithVariables: React.FC<UrlInputProps> = ({
  value,
  onChange,
  params = [],
  onPathParamsChange,
  placeholder = 'Enter URL or paste text',
  className = '',
}) => {
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
  const visualLayerRef  = useRef<HTMLDivElement>(null);
  const containerRef    = useRef<HTMLDivElement>(null);
  const inputRef        = useRef<HTMLInputElement>(null);
  const suggestionsRef  = useRef<HTMLDivElement>(null);
  const editModalRef    = useRef<HTMLDivElement>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSelectingRef  = useRef(false);
  const commitDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeValues = activeEnv?.values || [];

  const [popoverCoords, setPopoverCoords] = useState({ x: 0, y: 0 });
  const [showSuggestions, setShowSuggestions]     = useState(false);
  const [suggestionsCoords, setSuggestionsCoords] = useState({ x: 0, y: 0 });
  const [suggestionQuery, setSuggestionQuery]     = useState('');
  const [suggestionIndex, setSuggestionIndex]     = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const suggestionSearchRef = useRef<HTMLInputElement>(null);

  // Filtra pelo campo de busca dedicado do dropdown, não mais pelo texto
  // digitado direto na URL (que fica livre pra edição normal enquanto o
  // menu está aberto).
  const filteredVars = activeValues
    .filter(v => v.enabled && v.key.toLowerCase().includes(suggestionQuery.toLowerCase()))
    .map(v => ({ key: v.key, value: v.value }));

  const [activeTabId, setActiveTabId] = useState<string>('');

  const [hoveredToken, setHoveredToken] = useState<{
    type: 'env' | 'path';
    key: string;
    value: string;
    found: boolean;
  } | null>(null);

  const [editingToken, setEditingToken] = useState<{
    type: 'env' | 'path';
    key: string;
    originalPart: string;
  } | null>(null);
  const [editCoords, setEditCoords]     = useState({ x: 0, y: 0 });
  const [tempVarValue, setTempVarValue] = useState('');

  const [originalTokenValue, setOriginalTokenValue] = useState<string | undefined>(undefined);
  const [copiedCurrent, setCopiedCurrent] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  // Índice da entrada do histórico que acabou de ser copiada (mostra o
  // ícone de "copiado" só naquela linha, já que agora há até 5 entradas).
  const [copiedHistoryIndex, setCopiedHistoryIndex] = useState<number | null>(null);

  // ── Lista de duplicatas (Ctrl/Cmd+Click) — mesmo componente e mesma
  // lógica usados no HttpBodyEditor.tsx (só se aplica a variáveis de
  // environment {{...}}, não a path params — path params não têm o
  // conceito de "múltiplas entradas com a mesma key").
  const [duplicatePickerKey, setDuplicatePickerKey] = useState<string | null>(null);
  const [duplicatePickerCoords, setDuplicatePickerCoords] = useState({ x: 0, y: 0 });

  const envHistoryRef = useRef<Record<string, string>>({});
  const historyEnvIdRef = useRef<string | undefined>(undefined);

  const pathHistoryRef = useRef<Record<string, string>>({});
  const historyTabIdRef = useRef<string | undefined>(undefined);

  const sessionOpenValueRef = useRef<string>('');
  const hasEditedInSessionRef = useRef(false);

  // Rect do token clicado — guardado à parte de `editCoords` pra dar pra
  // reposicionar o popover (inclusive "virando" pra cima do token) sempre
  // que o tamanho dele mudar (ex: abrir o histórico), sem perder a
  // referência de onde o token realmente está na tela.
  const editAnchorRectRef = useRef<{ top: number; bottom: number; left: number; right: number } | null>(null);

  const setSelectingVisuals = useCallback((selecting: boolean) => {
    if (visualLayerRef.current) {
      visualLayerRef.current.style.opacity    = selecting ? '0' : '1';
      visualLayerRef.current.style.visibility = selecting ? 'hidden' : 'visible';
    }
    if (inputRef.current) {
      inputRef.current.style.color  = selecting ? '#d4d4d4' : 'transparent';
      inputRef.current.style.zIndex = selecting ? '50' : '30';
      // Controla a cor do texto SELECIONADO (ver URL_INPUT_SELECTION_CSS):
      // fora do arraste a camada visual volta por cima, e o
      // texto selecionado do input não pode aparecer por baixo dela — com o
      // respiro em volta das variáveis os dois não coincidem mais e surgiam
      // "//" duplicadas.
      inputRef.current.dataset.selecting = selecting ? 'true' : 'false';
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem('postman_clone_active_tab') || '';
    setActiveTabId(stored);

    const onStorage = (e: StorageEvent) => {
      if (e.key === 'postman_clone_active_tab') {
        setActiveTabId(e.newValue || '');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
  if (activeEnv?.id !== historyEnvIdRef.current) {
    historyEnvIdRef.current = activeEnv?.id;
    const map: Record<string, string> = {};
    (activeEnv?.values || []).forEach(v => { map[v.key] = v.value; });
    envHistoryRef.current = map;
  }
}, [activeEnv?.id]);

useEffect(() => {
  if (activeTabId !== historyTabIdRef.current) {
    historyTabIdRef.current = activeTabId;
    const map: Record<string, string> = {};
    (params || []).forEach(p => { map[p.key.trim()] = p.value || ''; });
    pathHistoryRef.current = map;
  }
}, [activeTabId]);

  const abas = useMemo(() => getLegacyStoredTabs(), [activeTabId, params]);

  const pathParamsMap = useMemo(
    () => new Map((params || []).map(p => [p.key.trim().replace(/\s+/g, ''), p.value || ''])),
    [params]
  );

  // A camada desenhada precisa estar rolada EXATAMENTE como o <input> por
  // baixo dela, senão o texto visível se descola do cursor real.
  //
  // Antes isso só acontecia no evento `scroll` do input — só que o Chromium
  // rola o input sozinho em vários casos sem disparar esse evento: ao apagar
  // do fim de uma URL longa (o conteúdo encolhe e a rolagem é recortada), ao
  // mudar o valor por fora (colar, inserir variável pelo dropdown), ao perder
  // o foco (volta pro início) e quando o painel muda de largura. Em qualquer
  // um desses a camada ficava com a rolagem antiga e o cursor aparecia longe
  // do texto — o "às vezes" do bug.
  //
  // Lê sempre do input em vez do evento, pra poder ser chamada de qualquer
  // lugar.
  const syncScroll = useCallback(() => {
    const input = inputRef.current;
    const layer = visualLayerRef.current;
    if (!input || !layer) return;
    if (layer.scrollLeft !== input.scrollLeft) {
      layer.scrollLeft = input.scrollLeft;
    }
  }, []);

  // O navegador ajusta a rolagem do input DEPOIS de revelar o cursor, que
  // pode vir depois do commit do React — por isso o segundo sync num frame
  // seguinte, além do imediato.
  const syncScrollSoon = useCallback(() => {
    syncScroll();
    requestAnimationFrame(syncScroll);
  }, [syncScroll]);

  // Todo render pode ter mudado o conteúdo da camada (valor novo, variável
  // que passou de "faltando" pra "encontrada"...), então sincroniza sempre.
  // É só uma comparação de número quando nada mudou.
  useLayoutEffect(() => {
    syncScroll();
    const frame = requestAnimationFrame(syncScroll);
    return () => cancelAnimationFrame(frame);
  });

  // Largura do input mudou (painel redimensionado, janela, zoom): o
  // navegador recorta a rolagem sem avisar.
  useEffect(() => {
    const input = inputRef.current;
    if (!input || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => syncScroll());
    observer.observe(input);
    return () => observer.disconnect();
  }, [syncScroll]);

  const clearHoverTimeout = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  

  useEffect(() => () => clearHoverTimeout(), [clearHoverTimeout]);

  useEffect(() => {
    const onMouseUp = () => {
      setTimeout(() => {
        isSelectingRef.current = false;
        setSelectingVisuals(false);
      }, 200);
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, [setSelectingVisuals]);

  const handleMouseEnter = (
    e: React.MouseEvent<HTMLSpanElement>,
    type: 'env' | 'path',
    key: string,
    tokenValue: string,
    found: boolean
  ) => {
    if (editingToken || isSelectingRef.current) return;
    clearHoverTimeout();

    const rect = e.currentTarget.getBoundingClientRect();
    hoverTimeoutRef.current = setTimeout(() => {
      if (isSelectingRef.current) return;
      setPopoverCoords({ x: rect.left, y: rect.bottom + 6 });
      setHoveredToken({ type, key, value: tokenValue, found });
    }, 350);
  };

  const handleMouseLeave = useCallback(() => {
    clearHoverTimeout();
    setHoveredToken(null);
  }, [clearHoverTimeout]);

  // Avança o histórico em um passo — só na PRIMEIRA edição real de cada
// sessão de abertura do editor. Chamadas subsequentes na mesma sessão
// não fazem nada (o "anterior" fica congelado até a próxima abertura+edição).
const markEditIfNeeded = useCallback((newValue: string) => {
  if (!editingToken) return;
  if (hasEditedInSessionRef.current) return;
  if (newValue === sessionOpenValueRef.current) return;

  hasEditedInSessionRef.current = true;

  if (editingToken.type === 'env' && activeEnv) {
    recordPreviousVariableValue(editingToken.key, sessionOpenValueRef.current);
  } else {
    pathHistoryRef.current[editingToken.key] = sessionOpenValueRef.current;
  }
  setOriginalTokenValue(sessionOpenValueRef.current);
}, [editingToken, activeEnv, recordPreviousVariableValue]);

// Troca qual das entradas duplicadas (mesma key) do environment ativo está
// "ativa" — desabilita as outras com a mesma key e habilita a escolhida.
// Mesma lógica/semântica do HttpBodyEditor.tsx (a escolha é uma propriedade
// do environment, não algo local desse input — então fica consistente em
// qualquer editor que resolva {{variavel}}).
const handleSelectDuplicate = (key: string, index: number) => {
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
  if (editingToken?.type === 'env' && editingToken.key === key) {
    const newValue = chosen.value ?? '';
    setTempVarValue(newValue);
    sessionOpenValueRef.current = newValue;
    hasEditedInSessionRef.current = false;
    setOriginalTokenValue(getPreviousVariableValue(key) ?? newValue);
    setShowHistory(false);
  }
};

const openDuplicatePickerForKey = (key: string, clientX: number, clientY: number) => {
  clearHoverTimeout();
  setHoveredToken(null);
  setDuplicatePickerCoords({ x: clientX, y: clientY + 16 });
  setDuplicatePickerKey(key);
};

const handleTokenClick = (
  e: React.MouseEvent,
  type: 'env' | 'path',
  key: string,
  currentValue: string,
  originalPart: string
) => {
  e.preventDefault();
  e.stopPropagation();

  // Ctrl/Cmd+Click numa variável de environment abre a lista de duplicatas
  // em vez do popover normal de edição — só faz sentido pra 'env' (path
  // params não têm múltiplas entradas com a mesma key).
  if (type === 'env' && (e.ctrlKey || e.metaKey)) {
    openDuplicatePickerForKey(key, e.clientX, e.clientY);
    return;
  }

  clearHoverTimeout();
  setHoveredToken(null);

  const rect = e.currentTarget.getBoundingClientRect();
  editAnchorRectRef.current = { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  setEditCoords({ x: rect.left, y: rect.bottom + 6 });
  setEditingToken({ type, key, originalPart });

  let initialValue = currentValue;
  if (type === 'path') {
    const fromStore = !currentValue ? getPathParameterValue(abas, activeTabId, key) : '';
    initialValue = currentValue || fromStore || '';
  }

  setTempVarValue(initialValue);
  sessionOpenValueRef.current = initialValue;
  hasEditedInSessionRef.current = false;

  if (type === 'env' && activeEnv) {
    seedPreviousVariableValueIfMissing(key, initialValue);
    setOriginalTokenValue(getPreviousVariableValue(key) ?? initialValue);
  } else {
    if (!(key in pathHistoryRef.current)) {
      pathHistoryRef.current[key] = initialValue;
    }
    setOriginalTokenValue(pathHistoryRef.current[key]);
  }

  setCopiedHistoryIndex(null);
  setShowHistory(false);
};

  // Baseline de variáveis de environment: reseta só quando troca de environment,
// não a cada abertura do editor rápido.
useEffect(() => {
  if (activeEnv?.id !== historyEnvIdRef.current) {
    historyEnvIdRef.current = activeEnv?.id;
    const map: Record<string, string> = {};
    (activeEnv?.values || []).forEach(v => { map[v.key] = v.value; });
    envHistoryRef.current = map;
  }
}, [activeEnv?.id]);

// Baseline de path params: reseta só quando troca de aba.
useEffect(() => {
  if (activeTabId !== historyTabIdRef.current) {
    historyTabIdRef.current = activeTabId;
    const map: Record<string, string> = {};
    (params || []).forEach(p => { map[p.key.trim()] = p.value || ''; });
    pathHistoryRef.current = map;
  }
}, [activeTabId]);

  // ── Commit / debounce / flush ───────────────────────────────────────────
  // Ordem importante: commitEditingValue -> scheduleCommit -> flushPendingCommit
  // precisam existir ANTES de qualquer useEffect/handler que os referencie.

  const commitEditingValue = useCallback((newValue: string) => {
    if (!editingToken) return;

    if (editingToken.type === 'env') {
      if (!activeEnv) return;
      const exists = activeValues.some(v => v.key === editingToken.key);
      const nextValues = exists
        ? activeValues.map(v => (v.key === editingToken.key ? { ...v, value: newValue } : v))
        : [
            ...activeValues,
            { key: editingToken.key, value: newValue, enabled: true, type: 'default' as const },
          ];
      updateEnvironment({ ...activeEnv, values: nextValues });
    } else {
      if (!onPathParamsChange) return;
      const exists = params.some(p => p.key.trim() === editingToken.key.trim());
      const nextParams = exists
        ? params.map(p => (p.key.trim() === editingToken.key.trim() ? { ...p, value: newValue } : p))
        : [
            ...params,
            { id: crypto.randomUUID(), key: editingToken.key, value: newValue, enabled: true },
          ];
      onPathParamsChange(nextParams);
    }
  }, [editingToken, activeEnv, activeValues, onPathParamsChange, params, updateEnvironment]);

  // Salva conforme digita, com debounce de 250ms.
  const scheduleCommit = useCallback((newValue: string) => {
    if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
    commitDebounceRef.current = setTimeout(() => {
      commitEditingValue(newValue);
      commitDebounceRef.current = null;
    }, 250);
  }, [commitEditingValue]);

  // Força o commit imediato do que estiver pendente (Enter, clique fora, etc).
  const flushPendingCommit = useCallback(() => {
    if (commitDebounceRef.current) {
      clearTimeout(commitDebounceRef.current);
      commitDebounceRef.current = null;
      commitEditingValue(tempVarValue);
    }
  }, [commitEditingValue, tempVarValue]);

  useEffect(() => {
    return () => {
      if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
    };
  }, []);

  // Copia o nome sem os delimitadores: o que se cola noutro lugar é a chave,
  // e `{{` / `:` variam conforme onde ela vai ser usada.
  const handleCopyKey = useCallback(async () => {
    if (!editingToken) return;
    await navigator.clipboard.writeText(editingToken.key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 1500);
  }, [editingToken]);

  const handleCopyCurrent = useCallback(async () => {
    if (!tempVarValue) return;
    await navigator.clipboard.writeText(tempVarValue);
    setCopiedCurrent(true);
    setTimeout(() => setCopiedCurrent(false), 1500);
  }, [tempVarValue]);

  const handleCopyHistoryValue = useCallback(async (histValue: string, index: number) => {
    await navigator.clipboard.writeText(histValue);
    setCopiedHistoryIndex(index);
    setTimeout(() => setCopiedHistoryIndex(current => (current === index ? null : current)), 1500);
  }, []);

const handleRestoreHistoryValue = useCallback((histValue: string) => {
  if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
  markEditIfNeeded(histValue);
  setTempVarValue(histValue);
  commitEditingValue(histValue);
}, [commitEditingValue, markEditIfNeeded]);

// Limpar histórico só existe pra variável de environment: o "histórico" de
// path param é só o valor anterior mantido localmente, sem lista pra apagar.
const canEditHistory = editingToken?.type === 'env' && !!activeEnv;

const handleRemoveHistoryValue = useCallback((histValue: string) => {
  if (!editingToken || editingToken.type !== 'env' || !activeEnv) return;
  removeVariableValueFromHistory(editingToken.key, histValue);
}, [editingToken, activeEnv, removeVariableValueFromHistory]);

const handleClearHistory = useCallback(() => {
  if (!editingToken || editingToken.type !== 'env' || !activeEnv) return;
  clearVariableValueHistory(editingToken.key);
}, [editingToken, activeEnv, clearVariableValueHistory]);

// Últimas atualizações da variável (mais recente primeiro, no máximo 5) —
// path params não passam pelo histórico compartilhado do EnvironmentContext,
// então caem de volta pro único valor anterior que já era guardado localmente.
const tokenHistoryList = useMemo(() => {
  if (!editingToken) return [];
  if (editingToken.type === 'env' && activeEnv) {
    return getVariableValueHistory(editingToken.key);
  }
  return originalTokenValue !== undefined ? [originalTokenValue] : [];
}, [editingToken, activeEnv, getVariableValueHistory, originalTokenValue]);

// Mantém o popover dentro da viewport — reposiciona (inclusive virando pra
// cima do token, quando não cabe embaixo) sempre que o conteúdo dele muda
// de tamanho (ex: abrir/fechar o histórico), em vez de deixar o popover
// vazar pra fora da tela perto das bordas.
useLayoutEffect(() => {
  if (!editingToken || !editModalRef.current || !editAnchorRectRef.current) return;

  const modalEl = editModalRef.current;
  const anchor = editAnchorRectRef.current;
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const modalRect = modalEl.getBoundingClientRect();

  let top = anchor.bottom + 6;
  if (top + modalRect.height > vh - margin) {
    const above = anchor.top - modalRect.height - 6;
    top = above >= margin ? above : Math.max(margin, vh - modalRect.height - margin);
  }

  let left = anchor.left;
  if (left + modalRect.width > vw - margin) {
    left = Math.max(margin, vw - modalRect.width - margin);
  }

  setEditCoords(prev => (prev.x === left && prev.y === top ? prev : { x: left, y: top }));
}, [editingToken, showHistory, tokenHistoryList.length]);

  // Abre o dropdown de variáveis com o campo de busca focado — usado tanto
  // ao digitar "{{" quanto pelo atalho Ctrl+Space.
  const openSuggestionsAt = (initialQuery: string) => {
    setSuggestionQuery(initialQuery);
    setSuggestionIndex(0);
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect();
      setSuggestionsCoords({ x: r.left + 12, y: r.bottom + 4 });
    }
    setShowSuggestions(true);
    requestAnimationFrame(() => suggestionSearchRef.current?.focus());
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    const isDeletion = text.length < value.length;
    onChange(text);

    // Dropdown já aberto — digitação continua indo pro campo de busca, não
    // pra URL. Apagar texto (ex: removendo "}}" de uma variável já
    // existente) também não deve reabrir o menu.
    if (showSuggestions || isDeletion) return;

    const sel      = e.target.selectionStart || 0;
    const before   = text.slice(0, sel);
    const openIdx  = before.lastIndexOf('{{');
    const closeIdx = before.lastIndexOf('}}');

    if (openIdx !== -1 && openIdx > closeIdx) {
      openSuggestionsAt(before.slice(openIdx + 2).trim());
    }
  };

  const selectSuggestion = (key: string) => {
    if (!inputRef.current) return;
    const sel       = inputRef.current.selectionStart || 0;
    const before    = value.slice(0, sel);
    const after     = value.slice(sel);
    const openIdx   = before.lastIndexOf('{{');
    const newBefore = before.slice(0, openIdx) + `{{${key}}}`;
    onChange(newBefore + after);
    setShowSuggestions(false);
    requestAnimationFrame(() => {
      if (!inputRef.current) return;
      inputRef.current.focus();
      const pos = newBefore.length;
      inputRef.current.setSelectionRange(pos, pos);
    });
  };

  // Ctrl+Space (Cmd+Space no macOS) — abre manualmente o dropdown quando o
  // cursor está logo depois de um "{{" ainda não fechado.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSuggestions) return;
    if (!(e.ctrlKey || e.metaKey) || e.code !== 'Space') return;

    const sel      = inputRef.current?.selectionStart ?? value.length;
    const before   = value.slice(0, sel);
    const openIdx  = before.lastIndexOf('{{');
    const closeIdx = before.lastIndexOf('}}');

    if (openIdx !== -1 && openIdx > closeIdx) {
      e.preventDefault();
      openSuggestionsAt(before.slice(openIdx + 2).trim());
    }
  };

  // Mantém o item destacado visível ao navegar com ↑↓ — sem isso a lista não
  // rolava junto e o destaque sumia abaixo da borda. 'nearest' só rola quando
  // o item está fora da área visível (passar o mouse não faz a lista pular).
  useEffect(() => {
    if (!showSuggestions) return;
    suggestionsRef.current
      ?.querySelector<HTMLElement>(`[data-suggestion-index="${suggestionIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [suggestionIndex, showSuggestions]);

  const handleSuggestionSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (filteredVars.length === 0) {
      if (e.key === 'Escape') { e.preventDefault(); setShowSuggestions(false); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestionIndex(i => (i + 1) % filteredVars.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestionIndex(i => (i - 1 + filteredVars.length) % filteredVars.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); selectSuggestion(filteredVars[suggestionIndex].key); }
    else if (e.key === 'Escape') { e.preventDefault(); setShowSuggestions(false); }
  };

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        !containerRef.current?.contains(t) &&
        !editModalRef.current?.contains(t) &&
        !suggestionsRef.current?.contains(t)
      ) {
        setShowSuggestions(false);
        if (editingToken) {
          flushPendingCommit();
          setEditingToken(null);
        }
      }
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [editingToken, flushPendingCommit]);

  const formattedUrl = useMemo(() => {
    if (!value) {
      return (
        <span className="select-none font-mono text-[12px] text-pm-text-muted">
          {placeholder}
        </span>
      );
    }

    const parts = value.split(/(\{\{[^{}]+\}\}|\/:[a-zA-Z0-9_]+)/g);

    // ── Respiro visual em volta das variáveis ──────────────────────────────
    // Esta camada fica POR CIMA de um <input> transparente, então cada
    // caractere tem que ocupar exatamente a mesma largura que no input —
    // margin/padding de verdade desalinharia o cursor de tudo que vem depois.
    // Em vez disso, o caractere vizinho de cada variável (ex: a "/") é só
    // deslocado alguns px pra longe com position:relative, que não mexe no
    // layout: abre um espaço entre a "/" e o destaque sem tirar nada do lugar.
    // No split com grupo de captura, tokens sempre caem nos índices ímpares.
    const TOKEN_GAP = 2;
    const isPathToken = (i: number) => i % 2 === 1 && parts[i].startsWith('/:');

    const renderText = (text: string, index: number) => {
      const textClass = 'whitespace-pre font-mono text-[12px] text-pm-text-secondary';
      if (!text) return null;

      // Vizinho à esquerda de uma variável {{...}}. (Antes de um path param o
      // vizinho é a própria "/" do token, deslocada lá embaixo.)
      const shiftLast = index + 1 < parts.length && !isPathToken(index + 1) && !!parts[index + 1];
      // Vizinho à direita de qualquer variável.
      const shiftFirst = index > 0 && !!parts[index - 1];

      if (!shiftFirst && !shiftLast) {
        return <span key={index} className={textClass}>{text}</span>;
      }

      const chars = Array.from(text);
      const first = shiftFirst ? chars.shift()! : '';
      const last = shiftLast && chars.length > 0 ? chars.pop()! : '';

      return (
        <span key={index} className={textClass}>
          {first && <span style={{ position: 'relative', left: TOKEN_GAP }}>{first}</span>}
          {chars.join('')}
          {last && <span style={{ position: 'relative', left: -TOKEN_GAP }}>{last}</span>}
        </span>
      );
    };

    return (
      <div className="flex h-full flex-nowrap items-center">
        {parts.map((part, index) => {
          const isEnvVar    = part.startsWith('{{') && part.endsWith('}}');
          const isPathParam = !isEnvVar && /^\/:[a-zA-Z0-9_]+$/.test(part);

          if (isEnvVar) {
            const key      = part.replace(/[{}]/g, '').trim();
            const envVar   = activeValues.find(v => v.key === key && v.enabled);
            const resolved = envVar ? envVar.value : undefined;
            const found    = !!envVar;
            const hasValue = found && !!resolved?.trim();

            return (
              <span
                key={index}
                onMouseEnter={e => handleMouseEnter(e, 'env', key, resolved?.trim() ? resolved : 'Not defined', hasValue)}
                onMouseLeave={handleMouseLeave}
                onClick={e => handleTokenClick(e, 'env', key, resolved ?? '', part)}
                // whitespace-pre, não nowrap: nowrap colapsa espaços repetidos,
                // e "{{  nome  }}" perderia largura do mesmo jeito.
                className={`relative pointer-events-auto mr-0 inline-flex cursor-pointer whitespace-pre rounded-[3px] py-[1px] px-0 font-mono text-[12px] font-semibold leading-[1.0] outline-[1px] transition-colors ${
                  hasValue
                    ? 'bg-[rgba(60,137,224,0.12)] text-[#3c89e0] outline-[rgba(60,137,224,0.35)] hover:bg-[rgba(60,137,224,0.18)]'
                    : 'bg-[rgba(224,108,117,0.12)] text-[#e06c75] outline-[rgba(224,108,117,0.35)] hover:bg-[rgba(224,108,117,0.18)]'
                }`}
              >
                {/* O texto CRU do token, e não "{{" + key + "}}": o key passa
                    por trim() pra achar a variável, e desenhá-lo aparado
                    encolhia o chip em relação ao input por baixo. Com
                    "{{ nome }}" eram 2 caracteres a menos, e tudo depois da
                    variável — inclusive onde o cursor aparece — ficava
                    deslocado. A busca continua usando o key aparado. */}
                {part}
              </span>
            );
          }

          if (isPathParam) {
            const key       = part.replace(/^\/:/, '').trim().replace(/\s+/g, '');
            const fromProps = pathParamsMap.get(key);
            const fromStore = getPathParameterValue(abas, activeTabId, key);
            const pathValue = fromProps !== undefined ? fromProps : (fromStore || '');

            // O valor do path param pode conter {{variavel}} de environment
            // (ex: :quoteNumber = {{recordLocator}}) — resolve pra mostrar o
            // valor real no hover, e marca como sem valor se alguma variável
            // não existir no environment ativo.
            let hasUnresolvedVar = false;
            const resolvedPathValue = (pathValue || '').replace(/\{\{([^{}]+)\}\}/g, (match, rawKey: string) => {
              const envVar = activeValues.find(v => v.key === rawKey.trim() && v.enabled);
              if (!envVar || !envVar.value?.trim()) {
                hasUnresolvedVar = true;
                return match;
              }
              return envVar.value;
            });
            const hasValue  = !!resolvedPathValue.trim() && !hasUnresolvedVar;

            return (
              <div key={index} className="inline-flex items-center">
                <span
                  className="font-mono text-[12px] text-pm-text-secondary"
                  style={{ position: 'relative', left: -TOKEN_GAP }}
                >
                  /
                </span>
                <span
                  onMouseEnter={e => handleMouseEnter(e, 'path', key, resolvedPathValue || `Sem valor para :${key}`, hasValue)}
                  onMouseLeave={handleMouseLeave}
                  onClick={e => handleTokenClick(e, 'path', key, pathValue || '', part)}
                  className={`relative pointer-events-auto inline-flex cursor-pointer whitespace-nowrap rounded-[3px] py-[1px] px-0 font-mono text-[12px] font-semibold leading-[1.0] outline-[1px] transition-colors ${
                    hasValue
                      ? 'bg-[rgba(209,154,102,0.12)] text-[#3c89e0] outline-[rgba(60,137,224,0.35)] hover:bg-[rgba(209,154,102,0.18)]'
                      : 'bg-[rgba(224,108,117,0.12)] text-[#e06c75] outline-[rgba(224,108,117,0.35)] hover:bg-[rgba(224,108,117,0.18)]'
                  }`}
                >
                  :{key}
                </span>
              </div>
            );
          }

          return renderText(part, index);
        })}
      </div>
    );
  }, [value, activeValues, placeholder, abas, activeTabId, pathParamsMap, editingToken, handleMouseLeave]);

  const hasChangedToken = originalTokenValue !== undefined && originalTokenValue !== tempVarValue;

  // Entradas mostradas no DuplicateVariablePicker (aberto via Ctrl+Click),
  // mesmo padrão do HttpBodyEditor.tsx.
  const duplicatePickerEntries: DuplicateVariableEntry[] = duplicatePickerKey
    ? activeValues.reduce<DuplicateVariableEntry[]>((acc, entry, index) => {
        if (entry.key === duplicatePickerKey) {
          acc.push({ index, value: entry.value, enabled: entry.enabled, description: entry.description });
        }
        return acc;
      }, [])
    : [];

  const duplicatePickerSelectedIndex =
    duplicatePickerEntries.find((e) => e.enabled)?.index
    ?? duplicatePickerEntries[0]?.index
    ?? null;

  return (
    <>
      <style>{URL_INPUT_SELECTION_CSS}</style>
      <div
        ref={containerRef}
        className={`relative flex h-full w-full items-center overflow-hidden ${className}`}
      >
        <div
          ref={visualLayerRef}
          className="absolute inset-0 z-[35] pointer-events-none flex items-center overflow-hidden text-[#3c89e0]"
        >
          <div className="flex h-full min-w-full items-center whitespace-nowrap">
            {formattedUrl}
          </div>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onScroll={syncScroll}
          // Movimentos de cursor que não mudam o valor (setas, Home/End,
          // clique, seleção) também podem rolar o input sem `scroll`.
          onSelect={syncScrollSoon}
          onMouseUp={syncScrollSoon}
          onMouseDown={() => {
            isSelectingRef.current = true;
            setSelectingVisuals(true);
            clearHoverTimeout();
            setHoveredToken(null);
          }}
          onFocus={() => {
            isSelectingRef.current = false;
            setSelectingVisuals(false);
            setHoveredToken(null);
            if (inputRef.current) inputRef.current.style.zIndex = '30';
            syncScrollSoon();
          }}
          // Ao perder o foco o Chromium volta a rolagem do input pro início.
          onBlur={syncScrollSoon}
          onKeyUp={e => {
            if (e.key === 'Escape') setEditingToken(null);
            syncScrollSoon();
          }}
          autoComplete="off"
          spellCheck={false}
          className={`url-var-input relative z-[30] h-full w-full border-none bg-transparent px-0 font-mono text-[12px] tracking-normal text-transparent caret-pm-text-muted outline-none ${
            editingToken ? 'pointer-events-none' : 'pointer-events-auto'
          }`}
        />
      </div>

      {/* ── Suggestions Dropdown ──────────────────────────────────────────── */}
      {showSuggestions &&
        createPortal(
          <div
            ref={suggestionsRef}
            style={{ left: suggestionsCoords.x, top: suggestionsCoords.y }}
            className="fixed z-[99999] flex max-h-[320px] w-[400px] flex-col overflow-hidden rounded-lg border border-pm-border bg-pm-surface font-sans shadow-[0_12px_36px_rgba(0,0,0,0.55)] animate-in fade-in zoom-in-95 duration-100"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-pm-border bg-pm-hover/60 px-3 py-2">
              <span className="text-[11px] text-pm-text-muted">Variables</span>
              <span className="text-[11px] font-bold text-[#3c89e0]">
                {activeEnv?.name ?? 'No env'}
              </span>
            </div>

            <div className="shrink-0 border-b border-pm-border p-2">
              <input
                ref={suggestionSearchRef}
                type="text"
                value={suggestionQuery}
                placeholder="Search variable..."
                onChange={e => {
                  setSuggestionQuery(e.target.value);
                  setSuggestionIndex(0);
                }}
                onKeyDown={handleSuggestionSearchKeyDown}
                className="h-7 w-full rounded-md border border-pm-border bg-pm-hover px-2 font-mono text-[12px] text-pm-text outline-none placeholder:text-pm-text-muted focus:border-[#3c89e0]/50"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {filteredVars.length === 0 && (
                <div className="px-3 py-3 text-center text-[11px] text-pm-text-muted">
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

      {/* ── Tooltip ──────────────────────────────────────────── */}
      {hoveredToken &&
        !editingToken &&
        createPortal(
          <div
            style={{ left: popoverCoords.x, top: popoverCoords.y }}
            className="fixed z-[100000] w-fit min-w-[280px] max-w-[90vw] overflow-hidden rounded-lg border border-pm-border bg-pm-surface font-sans shadow-[0_12px_36px_rgba(0,0,0,0.6)] animate-in fade-in zoom-in-95 duration-100"
          >
            <div className="flex items-center justify-between gap-4 border-b border-pm-border bg-pm-hover/60 px-3 py-2">
              <div className="flex items-center gap-[6px]">
                <span
                  className={`flex h-[18px] w-[18px] items-center justify-center rounded text-[10px] font-extrabold ${
                    hoveredToken.type === 'env'
                      ? 'border border-[rgba(76,175,80,0.3)] bg-[rgba(76,175,80,0.12)] text-[#4caf70]'
                      : 'border border-[rgba(209,154,102,0.3)] bg-[rgba(209,154,102,0.12)] text-[#d19a66]'
                  }`}
                >
                  {hoveredToken.type === 'env' ? 'E' : 'P'}
                </span>

                <span className="text-[11px] text-pm-text-muted">
                  {hoveredToken.type === 'env' ? 'Environment' : 'Path param'}
                </span>
              </div>
            </div>

            <div
              className={`break-all px-3 py-[7px] font-mono text-[12px] leading-[1.5] ${
                hoveredToken.found ? 'text-pm-text' : 'text-[#e06c75]'
              }`}
            >
              {hoveredToken.value || <span className="italic text-pm-text-muted">No value</span>}
            </div>

            {hoveredToken.type === 'env' && activeValues.filter(v => v.key === hoveredToken.key).length > 1 && (
              <div className="border-t border-pm-border px-3 py-[6px] text-[10px] text-amber-400/80">
                {activeValues.filter(v => v.key === hoveredToken.key).length} variables named &ldquo;{hoveredToken.key}&rdquo; — Ctrl+Click to choose which one
              </div>
            )}
          </div>,
          document.body
        )}

      {/* ── Token Quick Editor Modal ──────────────────────────────────────────── */}
      {editingToken &&
        createPortal(
          <div
            ref={editModalRef}
            style={{ left: editCoords.x, top: editCoords.y }}
            className="fixed z-[100000] w-fit min-w-[300px] max-w-[90vw] overflow-hidden rounded-lg border border-pm-border bg-pm-surface font-sans shadow-[0_12px_36px_rgba(0,0,0,0.6)] animate-in fade-in zoom-in-95 duration-150"
          >
            <div className="flex items-center justify-between gap-4 border-b border-pm-border bg-pm-hover/60 px-3 py-2.5">
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span
                  className={`flex h-[18px] w-[18px] items-center justify-center rounded text-[10px] font-extrabold ${
                    editingToken.type === 'env'
                      ? 'border border-[rgba(76,175,80,0.3)] bg-[rgba(76,175,80,0.12)] text-[#4caf70]'
                      : 'border border-[rgba(209,154,102,0.3)] bg-[rgba(209,154,102,0.12)] text-[#d19a66]'
                  }`}
                >
                  {editingToken.type === 'env' ? 'E' : 'P'}
                </span>
                <span className="text-[11px] text-pm-text-muted">
                  {editingToken.type === 'env' ? 'Environment' : 'Path param'}
                </span>
              </div>

              <div className="flex items-center gap-1.5 min-w-0">
                <span className="truncate whitespace-nowrap font-mono text-[11px] font-bold text-pm-text">
                  {editingToken.type === 'env' ? editingToken.key : `:${editingToken.key}`}
                </span>

                {/* Mesmo botão do popover do body (HttpBodyEditor): copia o
                    NOME da variável, que é o que se cola num script ou numa
                    outra request. O valor tem o seu próprio botão abaixo. */}
                <button
                  type="button"
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
              </div>
            </div>

            <div className="flex flex-col gap-1.5 p-3">
            <div className="flex items-center gap-1.5">
              <div className="group/valuefield inline-grid flex-1 min-w-0 grid-cols-1 items-center">
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
                    scheduleCommit(next);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      flushPendingCommit();
                      setEditingToken(null);
                    }
                    if (e.key === 'Escape') {
                      if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
                      if (sessionOpenValueRef.current !== tempVarValue) {
                        commitEditingValue(sessionOpenValueRef.current);
                      }
                      setEditingToken(null);
                    }
                  }}
                  className={`col-start-1 row-start-1 z-30 h-[32px] w-full rounded-md border border-pm-border bg-pm-hover px-2.5 font-mono text-[12px] text-pm-text caret-pm-text-muted outline-none transition-colors focus:border-[#3c89e0]/50 focus:bg-pm-hover ${
                    tempVarValue ? 'pr-7' : ''
                  }`}
                  onFocus={() => {
                    isSelectingRef.current = false;
                    setSelectingVisuals(false);
                    setHoveredToken(null);
                    if (inputRef.current) inputRef.current.style.zIndex = '30';
                  }}
                />

                {tempVarValue && (
                  <button
                    type="button"
                    onClick={() => {
                      if (commitDebounceRef.current) clearTimeout(commitDebounceRef.current);
                      markEditIfNeeded('');
                      setTempVarValue('');
                      commitEditingValue('');
                    }}
                    title="Clear value"
                    className="col-start-1 row-start-1 z-40 mr-1.5 h-[18px] w-[18px] shrink-0 justify-self-end rounded text-pm-text-muted opacity-0 transition-opacity hover:text-pm-text hover:bg-pm-row-active cursor-pointer group-hover/valuefield:opacity-100 flex items-center justify-center"
                  >
                    <X size={12} />
                  </button>
                )}
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

            {/* ── Toggle discreto de histórico (últimas 5 atualizações) ─────────── */}
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

                  {/* Limpar tudo só aparece com o histórico aberto: fechado,
                      o clique erraria o alvo (o botão de expandir é logo ao
                      lado) e apagaria sem o usuário ver o que perdeu. */}
                  {showHistory && canEditHistory && (
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

                          {canEditHistory && (
                            <button
                              type="button"
                              onClick={() => handleRemoveHistoryValue(histValue)}
                              title="Remove from history"
                              className="shrink-0 p-1 rounded text-pm-text-muted hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                            >
                              <Trash2 size={11} />
                            </button>
                          )}
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
    </>
  );
};

