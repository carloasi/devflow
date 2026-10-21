'use client';

import { useState } from 'react';
import { Bot, Bug, Database, Globe, Palette, Puzzle, Shield, X } from 'lucide-react';
import { SecuritySettingsSection } from './SecuritySettingsSection';
import { DataSettingsSection } from './DataSettingsSection';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { ErrorReportSettingsSection } from './ErrorReportSettingsSection';
import { AppearanceSettingsSection } from './AppearanceSettingsSection';
import { NetworkSettingsSection } from './NetworkSettingsSection';
import { McpSettingsSection } from './McpSettingsSection';
import { ExtensionsSettingsSection } from './ExtensionsSettingsSection';
import { UseMcpServerResult } from '@/mcp/useMcpServer';
import { UseExtensionHostResult } from '@/extensions/useExtensionHost';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  // O servidor MCP vive no AppLayout (precisa das collections e do
  // engine de execução), então o estado dele chega por prop.
  mcp?: UseMcpServerResult;
  // Mesma razão do mcp: o host de extensões vive no AppLayout porque
  // precisa do contexto de execução.
  extensionHost?: UseExtensionHostResult;
  // Árvore do workspace, para a varredura de credenciais escritas à mão.
  collections?: CollectionItem[];
  onApplySecrets?: (
    roots: CollectionItem[],
    variables: { key: string; value: string }[]
  ) => Promise<void> | void;
}

type SectionId = 'appearance' | 'security' | 'network' | 'mcp' | 'extensions' | 'data' | 'report';

const LAST_SECTION_KEY = 'devflow_settings_section';

function loadLastSection(): SectionId {
  try {
    return (localStorage.getItem(LAST_SECTION_KEY) as SectionId) || 'appearance';
  } catch {
    return 'appearance';
  }
}

// Layout: menu de seções à esquerda + UMA seção por vez à direita. Antes era
// um modal de 440px com as 7 seções empilhadas numa rolagem só — tudo ficava
// espremido (botões quebrando linha, descrições apertadas ao lado dos
// botões) e achar uma opção exigia rolar bastante.
export function SettingsModal({ isOpen, onClose, mcp, extensionHost, collections, onApplySecrets }: SettingsModalProps) {
  const [active, setActive] = useState<SectionId>(loadLastSection);

  if (!isOpen) return null;

  const sections: Array<{ id: SectionId; label: string; icon: React.ReactNode; render: () => React.ReactNode }> = [
    { id: 'appearance', label: 'Appearance', icon: <Palette size={14} />, render: () => <AppearanceSettingsSection /> },
    { id: 'security', label: 'Security', icon: <Shield size={14} />, render: () => <SecuritySettingsSection collections={collections} onApplySecrets={onApplySecrets} /> },
    { id: 'network', label: 'Network', icon: <Globe size={14} />, render: () => <NetworkSettingsSection /> },
    ...(mcp
      ? [{ id: 'mcp' as const, label: 'Claude Code (MCP)', icon: <Bot size={14} />, render: () => <McpSettingsSection mcp={mcp} /> }]
      : []),
    ...(extensionHost
      ? [{ id: 'extensions' as const, label: 'Extensions', icon: <Puzzle size={14} />, render: () => <ExtensionsSettingsSection host={extensionHost} /> }]
      : []),
    { id: 'data', label: 'Data', icon: <Database size={14} />, render: () => <DataSettingsSection /> },
    { id: 'report', label: 'Report a problem', icon: <Bug size={14} />, render: () => <ErrorReportSettingsSection /> },
  ];

  // Seção salva que não existe mais (ex: MCP indisponível) cai na primeira.
  const current = sections.find(s => s.id === active) ?? sections[0];

  const select = (id: SectionId) => {
    setActive(id);
    try { localStorage.setItem(LAST_SECTION_KEY, id); } catch {}
  };

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[80vh] max-h-[640px] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-pm-border bg-pm-bg shadow-2xl shadow-black/70"
      >
        <div className="flex shrink-0 items-center justify-between px-4 py-3 border-b border-pm-border">
          <h2 className="text-[13px] font-semibold text-pm-text">Settings</h2>
          <button
            onClick={onClose}
            title="Close"
            className="p-1 rounded-md text-pm-text-muted hover:text-pm-text hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="w-[190px] shrink-0 overflow-y-auto border-r border-pm-border p-2">
            {sections.map(section => {
              const isActive = section.id === current.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => select(section.id)}
                  className={`mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px] transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-pm-row-active font-medium text-pm-text'
                      : 'text-pm-text-secondary hover:bg-pm-hover hover:text-pm-text'
                  }`}
                >
                  <span className={isActive ? 'text-pm-text' : 'text-pm-text-muted'}>{section.icon}</span>
                  <span className="truncate">{section.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Cada seção traz seu próprio separador de topo (mt-5 pt-5
              border-t), feito pra quando elas ficavam empilhadas. Aqui só uma
              aparece por vez, então o separador é anulado e o h3 da seção
              vira o título da página. */}
          <div
            key={current.id}
            className="min-w-0 flex-1 overflow-y-auto px-6 py-5 [&>div]:mt-0 [&>div]:border-t-0 [&>div]:pt-0 [&>div>h3]:mb-3 [&>div>h3]:text-[15px]"
          >
            {current.render()}
          </div>
        </div>
      </div>
    </div>
  );
}
