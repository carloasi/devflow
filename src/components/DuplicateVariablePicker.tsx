'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search } from 'lucide-react';

export interface DuplicateVariableEntry {
  index: number;
  value: string;
  enabled: boolean;
  description?: string;
}

interface Props {
  variableKey: string;
  x: number;
  y: number;
  entries: DuplicateVariableEntry[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onClose: () => void;
}

// Lista separada das variáveis duplicadas (mesma key em mais de uma
// entrada do environment ativo) — só abre com Ctrl/Cmd+Click em cima de
// uma variável no body, diferente do popover normal de edição de valor
// (clique simples), que agora só edita a entrada já escolhida.
export function DuplicateVariablePicker({
  variableKey,
  x,
  y,
  entries,
  selectedIndex,
  onSelect,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  // Ordenado por descrição — entradas sem descrição vão pro final, pra
  // ajudar a diferenciar duplicatas quando cada uma tem seu próprio
  // propósito anotado (ex.: "5by5" vs "5by5admext").
  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      const descA = (a.description ?? '').trim();
      const descB = (b.description ?? '').trim();
      if (!descA && !descB) return 0;
      if (!descA) return 1;
      if (!descB) return -1;
      return descA.localeCompare(descB);
    });
  }, [entries]);

  // Filtro por valor ou descrição — com muitas duplicatas (um valor por
  // ambiente/cliente) achar a certa rolando ficava lento.
  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sortedEntries;
    return sortedEntries.filter(
      e => e.value.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q)
    );
  }, [sortedEntries, query]);

  const choose = (index: number) => {
    onSelect(index);
    onClose();
  };

  const moveHighlight = (next: number) => {
    setHighlight(next);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-entry-pos="${next}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ left: x, top: y }}
      className="fixed z-[100001] w-fit min-w-[280px] max-w-[90vw] overflow-hidden rounded-lg border border-amber-500/30 bg-pm-surface font-sans shadow-[0_12px_36px_rgba(0,0,0,0.6)] animate-in fade-in zoom-in-95 duration-150"
    >
      <div className="border-b border-pm-border bg-pm-hover/60 px-3 py-2">
        <span className="text-[11px] font-medium text-amber-400/90">
          {entries.length} variables named &ldquo;{variableKey}&rdquo;
        </span>
        <div className="text-[10px] text-pm-text-muted mt-0.5">Choose which one to use</div>
      </div>

      <div className="border-b border-pm-border p-1.5">
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-pm-border bg-pm-hover/60 px-2 focus-within:border-amber-500/40">
          <Search size={12} className="shrink-0 text-pm-text-muted" />
          <input
            autoFocus
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (filteredEntries.length) moveHighlight((highlight + 1) % filteredEntries.length);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (filteredEntries.length) moveHighlight((highlight - 1 + filteredEntries.length) % filteredEntries.length);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const entry = filteredEntries[highlight];
                if (entry) choose(entry.index);
              }
            }}
            placeholder="Filter by value or description..."
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-pm-text outline-none placeholder:font-sans placeholder:text-pm-text-muted"
          />
          {query && (
            <span className="shrink-0 text-[10px] tabular-nums text-pm-text-muted">
              {filteredEntries.length}/{entries.length}
            </span>
          )}
        </div>
      </div>

      <div ref={listRef} className="flex flex-col gap-0.5 p-1.5 max-h-[240px] overflow-y-auto">
        {filteredEntries.length === 0 && (
          <div className="px-2.5 py-3 text-center text-[11px] text-pm-text-muted">No value matches.</div>
        )}
        {filteredEntries.map(({ index, value, enabled, description }, pos) => {
          const isSelected = index === selectedIndex;
          const isHighlighted = pos === highlight;
          return (
            <button
              key={index}
              type="button"
              data-entry-pos={pos}
              onClick={() => choose(index)}
              onPointerMove={() => setHighlight(pos)}
              className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-amber-500/15 text-amber-300'
                  : isHighlighted
                    ? 'bg-pm-hover text-pm-text-secondary'
                    : 'text-pm-text-secondary hover:bg-pm-hover'
              } ${isHighlighted && isSelected ? 'ring-1 ring-inset ring-amber-500/40' : ''}`}
            >
              <span className="w-3 shrink-0 flex items-center justify-center mt-0.5">
                {isSelected && <Check size={11} />}
              </span>
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <span className="flex-1 min-w-0 truncate text-[12px] font-mono">
                    {value ? value : <i className="not-italic text-pm-text-muted">(empty)</i>}
                  </span>
                  {!enabled && (
                    <span className="shrink-0 text-[10px] text-pm-text-muted">disabled</span>
                  )}
                </span>
                {description && (
                  <span className="truncate text-[10px] font-sans text-pm-text-muted">
                    {description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
