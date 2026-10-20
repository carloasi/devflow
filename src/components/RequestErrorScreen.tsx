'use client';

import React from 'react';
import { AlertTriangle, Sparkles, History } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ResponseHistoryEntry } from '@/storage/responseHistoryStore';

interface RequestErrorScreenProps {
  errorMessage: string;
  onDebugWithAI: () => void;
  isDebugging: boolean;
  aiDebugResult: string | null;
  onViewConsole: () => void;
  // Respostas anteriores bem-sucedidas desta aba. Os botões normais do
  // header de response (Save/Copy/History etc) só aparecem quando
  // activeTab.response está preenchido — como essa tela substitui o body
  // inteiro quando o último envio falha, sem isso o usuário ficava sem
  // nenhuma forma de recuperar uma resposta antiga enquanto o erro atual
  // está sendo exibido.
  responseHistory?: ResponseHistoryEntry[];
  onLoadFromHistory?: (entry: ResponseHistoryEntry) => void;
}

export function RequestErrorScreen({
  errorMessage,
  onDebugWithAI,
  isDebugging,
  aiDebugResult,
  onViewConsole,
  responseHistory = [],
  onLoadFromHistory,
}: RequestErrorScreenProps) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-5 px-6 ">
      <svg width="90" height="110" viewBox="0 0 90 110" fill="none" className="text-pm-text-muted">
        <circle cx="45" cy="10" r="4" fill="currentColor" />
        <line x1="45" y1="14" x2="45" y2="24" stroke="currentColor" strokeWidth="2" />
        <circle cx="45" cy="40" r="18" stroke="currentColor" strokeWidth="2" />
        <circle cx="39" cy="38" r="2.2" fill="currentColor" />
        <path d="M30 58 L20 78 M20 78 L28 92" stroke="currentColor" strokeWidth="2" fill="none" />
        <path d="M60 58 L68 78" stroke="currentColor" strokeWidth="2" />
        <rect x="63" y="76" width="10" height="12" rx="2" fill="#f97316" opacity="0.85" />
        <path d="M68 88 Q72 100 64 108" stroke="currentColor" strokeWidth="2" fill="none" />
        <path d="M30 58 L45 62 L60 58 L58 100 L32 100 Z" stroke="currentColor" strokeWidth="2" fill="none" />
      </svg>

      <span className="text-[13px] text-pm-text-muted">Could not send request</span>

      <div className="w-full max-w-xl flex items-center justify-between gap-3 bg-[#3d1a1a] border border-red-900/60 rounded-lg px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle size={15} className="text-red-400 shrink-0" />
          <span className="text-[12px] text-red-200 truncate">
            <span className="font-bold">Error:</span> {errorMessage}
          </span>
        </div>
        <button
          onClick={onDebugWithAI}
          disabled={isDebugging}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-red-700/60 text-[11px] font-medium text-red-200 hover:bg-red-900/40 transition-colors shrink-0 disabled:opacity-50"
        >
          <Sparkles size={12} />
          {isDebugging ? 'Analisando…' : 'Debug with AI'}
        </button>
      </div>

      {aiDebugResult && (
        <div className="w-full max-w-xl bg-pm-hover/50 border border-pm-border rounded-lg px-4 py-3 text-[12px] text-pm-text-secondary leading-relaxed">
          {aiDebugResult}
        </div>
      )}

      {responseHistory.length > 0 && onLoadFromHistory && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-pm-border text-[11px] font-medium text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer"
            >
              <History size={12} />
              View last {responseHistory.length} response{responseHistory.length > 1 ? 's' : ''}
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="center" className="w-80 bg-pm-surface border border-pm-border rounded-xl p-1">
            <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-pm-text-muted">
              Last {responseHistory.length} responses
            </div>
            {responseHistory.map((entry, index) => {
              const ok = entry.status >= 200 && entry.status < 300;
              return (
                <DropdownMenuItem
                  key={entry.savedAt}
                  onClick={() => onLoadFromHistory(entry)}
                  className="flex flex-col items-stretch gap-1 rounded-lg text-xs cursor-pointer py-2 px-2.5 outline-none focus:bg-pm-hover"
                >
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        ok ? 'bg-[#4ff09d]/15 text-[#4ff09d]' : 'bg-[#ff7b7b]/15 text-[#ff7b7b]'
                      }`}>
                        {entry.status}
                      </span>
                      <span className="text-[11px] text-pm-text-muted truncate">
                        {new Date(entry.savedAt).toLocaleTimeString()}
                      </span>
                      {index === 0 && (
                        <span className="shrink-0 rounded-full bg-pm-hover px-1.5 py-0.5 text-[9px] font-semibold text-pm-text-muted">
                          latest
                        </span>
                      )}
                    </div>
                    {typeof entry.responseTime === 'number' && (
                      <span className="shrink-0 text-[10px] text-pm-text-muted tabular-nums">
                        {entry.responseTime}ms
                      </span>
                    )}
                  </div>
                  {entry.request && (
                    <div className="flex items-center gap-1.5 min-w-0 pl-0.5">
                      <span className="shrink-0 text-[10px] font-bold text-pm-accent">
                        {entry.request.method}
                      </span>
                      <span className="text-[11px] text-pm-text-muted truncate font-mono">
                        {entry.request.urlInput || '(empty URL)'}
                      </span>
                    </div>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

    </div>
  );
}
