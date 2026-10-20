'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { X } from 'lucide-react';

interface SlidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  title: string | React.ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function SlidePanel({
  isOpen,
  onClose,
  title,
  defaultWidth = 460,
  minWidth = 320,
  maxWidth = 900,
  headerExtra,
  footer,
  children,
}: SlidePanelProps) {
  const [panelWidth, setPanelWidth] = useState<number>(defaultWidth);
  const isResizingRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setPanelWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [minWidth, maxWidth]);

useEffect(() => {
    if (!isOpen) return;

    // Defesa contra bug conhecido do Radix: qualquer Dropdown/Dialog/Select
    // no app (mesmo já fechado) pode reaplicar pointer-events: none no
    // <body> a cada re-render. Em vez de corrigir uma vez só, vigiamos
    // o <body> continuamente enquanto o painel estiver aberto e desfazemos
    // o bloqueio sempre que ele reaparecer.
    document.body.style.pointerEvents = '';

    const bodyObserver = new MutationObserver(() => {
      if (document.body.style.pointerEvents === 'none') {
        document.body.style.pointerEvents = '';
      }
    });

    bodyObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['style'],
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => {
      bodyObserver.disconnect();
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed top-11 right-0 bottom-0 left-0 z-[10000] flex justify-end font-sans select-none pointer-events-none"
      role="dialog"
      aria-modal="false"
    >
      {/* Painel com Largura Dinâmica */}
      <div
        style={{ width: `${panelWidth}px` }}
        className="pointer-events-auto relative flex h-full animate-in slide-in-from-right flex-col border-l border-pm-border bg-pm-surface text-pm-text-secondary shadow-2xl duration-150 ease-out"
      >
        {/* Handle de Redimensionamento na Borda Esquerda */}
        <div
          onMouseDown={handleMouseDown}
          className="group absolute top-0 bottom-0 -left-1.5 w-3 cursor-col-resize z-50 flex justify-center"
          title="Arraste para redimensionar"
        >
          <div className="h-full w-[1px] bg-transparent group-hover:w-[2px] group-hover:bg-[#007acc] active:w-[2px] active:bg-[#007acc] transition-all duration-150" />
        </div>

        {/* Header estilo Postman Code Snippet */}
        <div className="flex shrink-0 items-center justify-between border-b border-pm-border bg-pm-sidebar px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-pm-text">
            {title}
          </h2>

          <div className="flex items-center gap-2 text-pm-text-muted">
            {headerExtra}

            <button
              onClick={onClose}
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors hover:bg-pm-hover hover:text-pm-text"
              title="Close (Esc)"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Conteúdo com Scroll Customizado */}
        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden bg-pm-surface text-[12px] text-pm-text-secondary scrollbar-thin scrollbar-thumb-[#333] scrollbar-track-transparent">
          {children}
        </div>

        {/* Footer Opcional */}
        {footer && (
          <div className="shrink-0 border-t border-pm-border bg-pm-sidebar">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

