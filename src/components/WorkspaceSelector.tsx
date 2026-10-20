'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  listWorkspaces,
  createWorkspace,
  renameWorkspace as renameWorkspaceStore,
  WorkspaceInfo,
} from '@/storage/workspaceStore';
import { loadGithubConfig, listGithubDirectory, workspaceRemotePath } from '@/lib/githubDirectory';

const WorkspaceIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.85 }}>
    <path d="M2 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3zm0 7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-4zm7-7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V3zm0 7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4z" />
  </svg>
);

const ChevronDownIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 6l4 4 4-4H4z" />
  </svg>
);

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" strokeLinecap="round" />
  </svg>
);

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M8 2.5v11M2.5 8h11" strokeLinecap="round" />
  </svg>
);

const EditIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M11 2l3 3-8 8-3.5 1 1-3.5 8-8z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CheckDotIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const MissingDotIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
  </svg>
);

const TrashIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M2.5 4h11M6 4V2.5h4V4M4.5 4v9.5A1.5 1.5 0 0 0 6 15h4a1.5 1.5 0 0 0 1.5-1.5V4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// Pull de um único workspace (baixar do GitHub) — usado no menu de troca de
// workspace, pra atualizar só o item selecionado sem baixar todos os outros.
const PullDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M8 2.5v8M8 10.5L5 7.5M8 10.5l3-3M3 13.5h10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Push de um único workspace (enviar pro GitHub) — mesma ideia do PullDownIcon,
// só que na direção contrária.
const PushUpIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M8 13.5v-8M8 5.5L5 8.5M8 5.5l3 3M3 2.5h10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Anel girando, mostrado no lugar da seta enquanto o pull/push daquela linha
// está rodando. Girar a própria seta não lia como "carregando" — parecia um
// glitch do ícone.
const BusySpinner = () => (
  <span className="relative block w-3 h-3">
    <span className="absolute inset-0 border-[1.5px] border-pm-border rounded-full" />
    <span className="absolute inset-0 border-[1.5px] border-transparent border-t-current rounded-full animate-spin" />
  </span>
);

// "…" — abre o menu com as ações menos frequentes (histórico, renomear,
// excluir). Só Pull e Push ficam inline; com 5 ícones na linha o nome do
// workspace era espremido pra ~80px e aparecia truncado em toda linha.
const MoreIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="3" cy="8" r="1.3" />
    <circle cx="8" cy="8" r="1.3" />
    <circle cx="13" cy="8" r="1.3" />
  </svg>
);

// Histórico de commits do workspace (escolher qual versão baixar).
const HistoryIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2.2 1.8v2.6h2.6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 5v3.2l2.2 1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface WorkspaceSelectorProps {
  selectedWorkspace: string;
  isSynced?: boolean; // ✅ novo
  // Usuário escolheu um workspace já existente no dropdown.
  onSelectWorkspace: (path: string) => void | Promise<void>;
  // Um workspace novo (vazio) foi criado — o pai deve limpar
  // tabs/collections/environments e apontar pro path novo.
  onCreateWorkspace: (workspace: WorkspaceInfo) => void | Promise<void>;
  // Um workspace existente foi renomeado — o pai deve migrar os
  // dados de oldPath para o path novo antes de trocar a seleção.
  onRenameWorkspace: (oldPath: string, newWorkspace: WorkspaceInfo) => void | Promise<void>;
  // Exclui o workspace local por completo (dados salvos + registro na lista).
   onDeleteWorkspace?: (path: string) => void | Promise<void>;
  // Baixa (Pull) só esse workspace do GitHub, sobrescrevendo os dados locais
  // dele — sem afetar os outros workspaces da lista.
  onPullWorkspace?: (path: string) => void | Promise<void>;
  // Envia (Push) só esse workspace pro GitHub, sem mexer nos outros —
  // funciona mesmo se esse workspace não for o selecionado no momento.
  onPushWorkspace?: (path: string) => void | Promise<void>;
  // Abre a janela de histórico de commits desse workspace no GitHub, onde
  // dá pra escolher qual versão baixar (em vez de sempre a mais recente).
  onOpenCommitHistory?: (path: string) => void;
}

export default function WorkspaceSelector({
  selectedWorkspace,
  isSynced = false,
  onSelectWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
    onDeleteWorkspace,
  onPullWorkspace,
  onPushWorkspace,
  onOpenCommitHistory,
}: WorkspaceSelectorProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmClearId, setConfirmClearId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pullingId, setPullingId] = useState<string | null>(null);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [isAdding, setIsAdding] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Linha sob o mouse. Os botões de ação só são RENDERIZADOS nessa linha —
  // antes eles existiam em todas as linhas com opacity-0, e mesmo
  // invisíveis continuavam ocupando ~140px do flex, o que truncava o nome
  // de todo mundo ("Barrame…", "Middle…") mesmo sem hover.
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  // Menu "…" da linha (histórico / renomear / excluir), em portal com
  // position fixed porque a lista tem overflow-y-auto e recortaria um
  // popup posicionado dentro dela.
  const [overflowMenu, setOverflowMenu] = useState<
    { path: string; name: string; synced: boolean; x: number; y: number } | null
  >(null);
  // Tooltip próprio do nome — só aparece quando o texto está realmente
  // truncado, e fica à direita do menu pra não cobrir as linhas de baixo
  // (o title nativo aparecia por cima da lista).
  const [nameTooltip, setNameTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Status de sincronização de CADA workspace da lista (não só o selecionado),
  // checado sob demanda no GitHub toda vez que o menu abre — key = ws.path.
  const [syncedMap, setSyncedMap] = useState<Record<string, boolean>>({});

  const showStatus = useCallback((message: string) => {
    setStatusMessage(message);
    setTimeout(() => setStatusMessage(null), 4000);
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    const list = await listWorkspaces();
    setWorkspaces(list);
    return list;
  }, []);

  // Carrega a lista de workspaces locais no mount — sem depender de rede/GitHub.
  useEffect(() => {
    (async () => {
      await refreshWorkspaces();
      setLoading(false);
    })();
  }, [refreshWorkspaces]);

  useEffect(() => {
    if (renamingPath) {
      setTimeout(() => renameInputRef.current?.focus(), 0);
    }
  }, [renamingPath]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && menuOpen) setMenuOpen(false);
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      // Workspaces podem ter sido criados fora deste componente (ex: Pull de
      // todos os workspaces do GitHub) — recarrega a lista sempre que o
      // dropdown abre, pra eles aparecerem sem precisar reiniciar o app.
      refreshWorkspaces();
      window.addEventListener('keydown', handleKeyDown);
      document.addEventListener('mousedown', handleClickOutside);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    } else {
      setSearch('');
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [menuOpen, refreshWorkspaces]);

  // Ao abrir o menu, checa no GitHub (lista de diretório, sem baixar conteúdo)
  // se cada workspace tem uma pasta correspondente no repositório configurado.
  // Se o GitHub sync não estiver configurado (sem token salvo), não faz nada
  // e os ícones ficam todos cinza, como antes.
  useEffect(() => {
    if (!menuOpen || workspaces.length === 0) return;
    let cancelled = false;

    (async () => {
      const config = await loadGithubConfig();
      if (!config || cancelled) return;

      await Promise.all(
        workspaces.map(async (ws) => {
          const items = await listGithubDirectory(config, workspaceRemotePath(ws.path));
          if (cancelled) return;
          setSyncedMap(prev => ({ ...prev, [ws.path]: items.length > 0 }));
        })
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [menuOpen, workspaces]);

  const handleSelect = useCallback(async (path: string) => {
    setMenuOpen(false);
    if (path === selectedWorkspace) return;
    await onSelectWorkspace(path);
  }, [selectedWorkspace, onSelectWorkspace]);

  const handlePullClick = useCallback(async (path: string) => {
    if (!onPullWorkspace || pullingId) return;
    setPullingId(path);
    try {
      await onPullWorkspace(path);
    } finally {
      setPullingId(null);
    }
  }, [onPullWorkspace, pullingId]);

  const handlePushClick = useCallback(async (path: string) => {
    if (!onPushWorkspace || pushingId) return;
    setPushingId(path);
    try {
      await onPushWorkspace(path);
    } finally {
      setPushingId(null);
    }
  }, [onPushWorkspace, pushingId]);

  // Fecha o menu "…" ao clicar fora, apertar Esc ou fechar o dropdown.
  useEffect(() => {
    if (!overflowMenu) return;
    const close = () => setOverflowMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [overflowMenu]);

  useEffect(() => {
    if (!menuOpen) {
      setOverflowMenu(null);
      setNameTooltip(null);
      setHoveredPath(null);
    }
  }, [menuOpen]);

  // Só mostra tooltip se o nome estiver de fato cortado — nome curto não
  // precisa de balão nenhum.
  const handleNameMouseEnter = useCallback((e: React.MouseEvent<HTMLElement>, name: string) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    const rect = el.getBoundingClientRect();
    setNameTooltip({ text: name, x: rect.right + 12, y: rect.top - 2 });
  }, []);

  const handleCreate = useCallback(async () => {
    const trimmed = newWorkspaceName.trim();
    if (!trimmed) return;

    const created = await createWorkspace(trimmed);
    if (!created) {
      showStatus('✗ Invalid or already existing workspace name.');
      return;
    }

    await refreshWorkspaces();
    setIsAdding(false);
    setNewWorkspaceName('');
    await onCreateWorkspace(created);
  }, [newWorkspaceName, refreshWorkspaces, onCreateWorkspace, showStatus]);

  const handleRename = useCallback(async () => {
    if (!renamingPath) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;

    const oldPath = renamingPath;
    const renamed = await renameWorkspaceStore(oldPath, trimmed);
    if (!renamed) {
      showStatus('✗ Invalid or already existing workspace name.');
      return;
    }

    await refreshWorkspaces();
    setRenamingPath(null);
    setRenameValue('');

    if (renamed.path !== oldPath) {
      await onRenameWorkspace(oldPath, renamed);
    }
  }, [renamingPath, renameValue, refreshWorkspaces, onRenameWorkspace, showStatus]);

  const selectedLabel = useMemo(() => {
    if (!selectedWorkspace) return 'Select a workspace';
    const found = workspaces.find(w => w.path === selectedWorkspace);
    return found?.name ?? selectedWorkspace;
  }, [selectedWorkspace, workspaces]);

  const filteredWorkspaces = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter(w => w.name.toLowerCase().includes(q));
  }, [workspaces, search]);

  return (
    <div className="relative inline-block text-pm-text font-sans">
      {isAdding ? (
        <div className="flex items-center gap-1.5">
          <input
            className="w-[190px] h-[30px] bg-pm-hover border border-blue-500 text-pm-text px-2.5 py-1.5 rounded-md text-xs outline-none focus:border-blue-500"
            autoFocus
            placeholder="workspace name"
            value={newWorkspaceName}
            onChange={(e) => setNewWorkspaceName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') {
                setIsAdding(false);
                setNewWorkspaceName('');
              }
            }}
          />
          <button
            className="w-[30px] h-[30px] bg-pm-hover border border-pm-border text-pm-text-muted rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-pm-row-active hover:text-pm-text"
            title="Confirm"
            onClick={handleCreate}
          >
            <CheckDotIcon />
          </button>
          <button
            className="w-[30px] h-[30px] bg-pm-hover border border-pm-border text-pm-text-muted rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-pm-row-active hover:text-pm-text"
            title="Cancel"
            onClick={() => {
              setIsAdding(false);
              setNewWorkspaceName('');
            }}
          >
            <MissingDotIcon />
          </button>
        </div>
      ) : (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            className={`inline-flex items-center gap-2 bg-pm-bg border text-pm-text pl-2 pr-0.5 rounded-md text-xs font-medium h-[30px] min-w-[90px] w-fit cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              menuOpen ? 'border-[#007acc]' : 'border-pm-bg hover:bg-pm-hover'
            }`}
            disabled={loading}
            onClick={() => setMenuOpen(v => !v)}
          >
            <span className="flex text-pm-text-muted shrink-0">


              <span
                className={`flex shrink-0 ${isSynced ? 'text-[#007acc]' : 'text-pm-text-muted'}`}
                title={isSynced ? 'Workspace synced with GitHub' : 'Workspace not synced'}
              >
                            <WorkspaceIcon />
             </span>
            </span>
            <span
              className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap"
              title={loading ? undefined : selectedLabel}
            >
            {loading ? 'Loading...' : selectedLabel}
            </span>

            <span className="flex text-pm-text-muted shrink-0">
            <ChevronDownIcon />
            </span>

          </button>

          {menuOpen && (
            <div className="absolute top-[calc(100%+6px)] left-0 w-[320px] bg-pm-surface border border-pm-border rounded-lg shadow-2xl z-[10000] flex flex-col overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
              <div className="p-2 border-b border-pm-border">
                <div className="relative flex items-center">
                  <span className="absolute left-2 flex text-pm-text-muted pointer-events-none">
                    <SearchIcon />
                  </span>
                  <input
                    ref={searchInputRef}
                    className="w-full bg-pm-hover border border-pm-border text-pm-text pl-6.5 pr-2 py-1.5 rounded-md text-xs outline-none focus:border-[#007acc]"
                    placeholder="Search workspaces..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>

              <div className="max-h-[260px] overflow-y-auto p-1 flex flex-col">
                {filteredWorkspaces.length === 0 ? (
                  <div className="py-2.5 px-2 text-[11.5px] text-pm-text-muted text-center">
                    {workspaces.length === 0 ? 'No workspaces' : 'No results'}
                  </div>
                ) : (
                  filteredWorkspaces.map((ws) => {
                    const isSelected = ws.path === selectedWorkspace;
                    const isRenaming = renamingPath === ws.path;
                    const isConfirmingClear = confirmClearId === ws.path;

                    if (isRenaming) {
                      return (
                        <div key={ws.path} className="flex items-center gap-1.5 pl-3.5 pr-1.5 py-1">
                          <input
                            ref={renameInputRef}
                            className="flex-1 min-w-0 bg-pm-hover border border-[#007acc] text-pm-text px-2 py-1.5 rounded-md text-[12.5px] outline-none"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRename();
                              if (e.key === 'Escape') {
                                setRenamingPath(null);
                                setRenameValue('');
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="w-[26px] h-[26px] shrink-0 bg-pm-hover border border-pm-border text-pm-text-muted rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-pm-row-active hover:text-pm-text"
                            title="Confirm"
                            onClick={(e) => { e.stopPropagation(); handleRename(); }}
                          >
                            <CheckDotIcon />
                          </button>
                          <button
                            type="button"
                            className="w-[26px] h-[26px] shrink-0 bg-pm-hover border border-pm-border text-pm-text-muted rounded-md flex items-center justify-center cursor-pointer transition-colors hover:bg-pm-row-active hover:text-pm-text"
                            title="Cancel"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenamingPath(null);
                              setRenameValue('');
                            }}
                          >
                            <MissingDotIcon />
                          </button>

                        </div>
                      );
                    }

                    const wsSynced = syncedMap[ws.path] ?? (isSelected ? isSynced : false);

                    // Ações só existem no DOM da linha sob o mouse (ou da que
                    // está com o menu "…" aberto) — nas demais o nome ocupa a
                    // linha inteira.
                    // ...e também enquanto houver um pull/push em curso nela,
                    // senão tirar o mouse da linha desmontava o botão no meio
                    // da operação e levava junto o indicador de progresso.
                    const wsBusy = pullingId === ws.path || pushingId === ws.path;
                    const showActions =
                      !isConfirmingClear &&
                      (hoveredPath === ws.path || overflowMenu?.path === ws.path || wsBusy);

                    return (
                      <div
                        key={ws.path}
                        onMouseEnter={() => setHoveredPath(ws.path)}
                        onMouseLeave={() => setHoveredPath(current => (current === ws.path ? null : current))}
                        className={`group flex items-center gap-2 pl-3.5 pr-2 py-1.5 rounded-md text-[12.5px] transition-colors ${
                          isSelected ? 'bg-[#1a8ad4]/15 text-pm-text' : 'text-pm-text hover:bg-pm-hover'
                        }`}
                      >
                        <button
                          type="button"
                          className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer border-none bg-transparent text-left"
                          onClick={() => handleSelect(ws.path)}
                        >
                          <span
                            className={`flex shrink-0 ${wsSynced ? 'text-[#007acc]' : 'text-pm-text-muted'}`}
                            title={wsSynced ? 'Workspace synced with GitHub' : 'Workspace not synced'}
                          >
                            <WorkspaceIcon />
                          </span>
                          <span
                            className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
                            onMouseEnter={(e) => handleNameMouseEnter(e, ws.name)}
                            onMouseLeave={() => setNameTooltip(null)}
                          >
                            {ws.name}
                          </span>
                        </button>

                        {isSelected && (
                          <span className="flex text-[#007acc] shrink-0">
                            <CheckDotIcon />
                          </span>
                        )}

                        {showActions && onPullWorkspace && wsSynced && (
                          <button
                            type="button"
                            disabled={pullingId === ws.path}
                            className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-pm-text-muted cursor-pointer transition-all hover:bg-[#007acc]/20 hover:text-[#3c9be0] disabled:cursor-wait"
                            title="Pull updates for this workspace from GitHub"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePullClick(ws.path);
                            }}
                          >
                            {pullingId === ws.path ? <BusySpinner /> : <PullDownIcon />}
                          </button>
                        )}

                        {showActions && onPushWorkspace && (
                          <button
                            type="button"
                            disabled={pushingId === ws.path}
                            className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-pm-text-muted cursor-pointer transition-all hover:bg-emerald-500/20 hover:text-emerald-400 disabled:cursor-wait"
                            title="Push this workspace's content to GitHub"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePushClick(ws.path);
                            }}
                          >
                            {pushingId === ws.path ? <BusySpinner /> : <PushUpIcon />}
                          </button>
                        )}

                        {showActions && (
                          <button
                            type="button"
                            className={`shrink-0 w-5 h-5 flex items-center justify-center rounded cursor-pointer transition-all hover:bg-pm-row-active hover:text-pm-text ${
                              overflowMenu?.path === ws.path ? 'bg-pm-row-active text-pm-text' : 'text-pm-text-muted'
                            }`}
                            title="More actions"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setOverflowMenu(current =>
                                current?.path === ws.path
                                  ? null
                                  : {
                                      path: ws.path,
                                      name: ws.name,
                                      synced: wsSynced,
                                      x: Math.min(rect.right - 168, window.innerWidth - 176),
                                      y: rect.bottom + 4,
                                    }
                              );
                            }}
                          >
                            <MoreIcon />
                          </button>
                        )}

                        {isConfirmingClear && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              disabled={deletingId === ws.path}
                              onClick={async (e) => {
                                e.stopPropagation();
                                setDeletingId(ws.path);
                                try {
                                  await onDeleteWorkspace?.(ws.path);
                                  await refreshWorkspaces();
                                } finally {
                                  setDeletingId(null);
                                  setConfirmClearId(null);
                                }
                              }}
                              className="h-5 px-1.5 rounded bg-rose-500 hover:bg-rose-400 text-[10px] font-medium text-white cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                            >
                              {deletingId === ws.path ? 'Deleting...' : 'Delete'}
                            </button>
                            <button
                              disabled={deletingId === ws.path}
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmClearId(null);
                              }}
                              className="h-5 px-1.5 rounded bg-pm-hover hover:bg-pm-row-active text-[10px] text-pm-text-secondary cursor-pointer disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <div className="h-[1px] bg-pm-border my-1 mx-1" />

              <button
                type="button"
                className="flex items-center gap-2 pl-3.5 pr-3 py-2 text-[12.5px] font-semibold text-[#007acc] cursor-pointer bg-transparent border-none w-full text-left transition-colors hover:bg-[#1a8ad4]/15"
                onClick={() => {
                  setMenuOpen(false);
                  setIsAdding(true);
                }}
              >
                <PlusIcon /> New workspace
              </button>
            </div>
          )}
        </div>
      )}

      {statusMessage && (
        <div className="absolute top-[calc(100%+6px)] left-0 whitespace-nowrap text-[11px] text-rose-400 bg-pm-surface border border-rose-500/30 rounded-md px-2 py-1 shadow-lg z-[10001]">
          {statusMessage}
        </div>
      )}

      {/* Menu "…" da linha — em portal porque a lista tem overflow-y-auto */}
      {overflowMenu && typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{ left: overflowMenu.x, top: overflowMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            className="fixed z-[10002] w-[168px] bg-pm-surface border border-pm-border rounded-lg shadow-2xl p-1 font-sans animate-in fade-in zoom-in-95 duration-100"
          >
            {onOpenCommitHistory && overflowMenu.synced && (
              <button
                type="button"
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-[12px] text-pm-text-secondary bg-transparent border-none text-left cursor-pointer transition-colors hover:bg-pm-hover hover:text-pm-text"
                onClick={() => {
                  onOpenCommitHistory(overflowMenu.path);
                  setOverflowMenu(null);
                }}
              >
                <HistoryIcon />
                Commit history
              </button>
            )}

            <button
              type="button"
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-[12px] text-pm-text-secondary bg-transparent border-none text-left cursor-pointer transition-colors hover:bg-pm-hover hover:text-pm-text"
              onClick={() => {
                setRenamingPath(overflowMenu.path);
                setRenameValue(overflowMenu.name);
                setOverflowMenu(null);
              }}
            >
              <EditIcon />
              Rename
            </button>

            <button
              type="button"
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-[12px] text-rose-400 bg-transparent border-none text-left cursor-pointer transition-colors hover:bg-rose-500/10"
              onClick={() => {
                setConfirmClearId(overflowMenu.path);
                setOverflowMenu(null);
              }}
            >
              <TrashIcon />
              Delete workspace
            </button>
          </div>,
          document.body
        )}

      {/* Tooltip do nome — só quando truncado, e ao lado do menu (não por
          cima das linhas de baixo, como fazia o title nativo) */}
      {nameTooltip && typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{ left: nameTooltip.x, top: nameTooltip.y }}
            className="fixed z-[10002] max-w-[280px] pointer-events-none rounded-md bg-pm-surface border border-pm-border px-2 py-1 text-[11.5px] text-pm-text shadow-xl font-sans"
          >
            {nameTooltip.text}
          </div>,
          document.body
        )}
    </div>
  );
}