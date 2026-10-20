'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ZoomIn } from 'lucide-react';
import { MAX_ZOOM, MIN_ZOOM } from '@/lib/useAppZoom';

// Níveis oferecidos na lista. Ficam dentro de MIN_ZOOM/MAX_ZOOM porque o
// clamp do useAppZoom recortaria qualquer coisa fora — oferecer um nível que
// o app não aplica só faria o usuário clicar e não ver o valor pedido.
const PRESETS = [50, 75, 90, 100, 110, 125, 150, 175, 200, 250].filter(
  p => p >= MIN_ZOOM * 100 && p <= MAX_ZOOM * 100
);

interface ZoomControlProps {
  zoom: number;
  onChange: (factor: number) => void;
}

export function ZoomControl({ zoom, onChange }: ZoomControlProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentPercent = Math.round(zoom * 100);

  const openMenu = () => {
    setDraft(String(currentPercent));
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen) return;
    // Já vem com o valor atual selecionado: digitar substitui direto, sem
    // precisar apagar antes.
    const id = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(id);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    // stopPropagation pra que fechar este menu não dispare também o Esc de
    // outros componentes montados (dropdowns da barra superior, popovers).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setIsOpen(false);
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const apply = (percent: number) => {
    if (!Number.isFinite(percent) || percent <= 0) return;
    onChange(percent / 100);
    setIsOpen(false);
  };

  // Aceita "130", "130%" ou "1,3 0" — só os dígitos e o separador importam.
  const submitDraft = () => {
    const parsed = Number(draft.replace(/[^\d.]/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(String(currentPercent));
      return;
    }
    apply(parsed);
  };

  return (
    <div ref={containerRef} className="relative h-full">
      <button
        type="button"
        onClick={() => (isOpen ? setIsOpen(false) : openMenu())}
        title="Zoom level — click to pick or type a percentage (Ctrl+0 resets)"
        className={`h-full px-2 flex items-center gap-1 cursor-pointer transition-colors tabular-nums ${
          isOpen
            ? 'bg-pm-hover text-pm-text-secondary'
            : 'text-pm-text-muted hover:bg-pm-hover hover:text-pm-text-secondary'
        }`}
      >
        <ZoomIn size={11} />
        {currentPercent}%
      </button>

      {isOpen && (
        <div className="absolute bottom-full right-0 mb-1.5 z-50 w-36 rounded-lg border border-pm-border bg-pm-surface p-1 shadow-xl shadow-black/50 animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center gap-1 px-1 pb-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitDraft();
              }}
              inputMode="numeric"
              aria-label="Zoom percentage"
              className="w-full h-6 bg-pm-hover border border-[#007acc] rounded px-1.5 text-[11px] text-pm-text tabular-nums outline-none"
            />
            <span className="text-[11px] text-pm-text-muted">%</span>
          </div>

          <div className="max-h-[188px] overflow-y-auto">
            {PRESETS.map(preset => {
              const isCurrent = preset === currentPercent;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => apply(preset)}
                  className={`flex items-center justify-between w-full h-6 px-1.5 rounded text-[11px] tabular-nums cursor-pointer transition-colors ${
                    isCurrent
                      ? 'bg-pm-row-active text-pm-text'
                      : 'text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text'
                  }`}
                >
                  <span>{preset}%</span>
                  {isCurrent && <Check size={11} className="text-[#3794ff]" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
