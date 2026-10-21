'use client';

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { ChevronDown, Save, FolderOpen, Pencil, Trash2, Check, X, RefreshCw, Copy, Search, AlertTriangle, Pin, PinOff, Workflow, FilePlus, LogOut } from 'lucide-react';
import { Tab } from '@/app/types/Tab';
import type { TabGroup } from '@/lib/tabGroups';

export interface TabSession {
  id: string;
  name: string;
  tabs: Tab[];
  activeTabId: string | null;
  savedAt: number;
  pinned?: boolean;
  /**
   * Workspace em que a sessão foi salva.
   *
   * Abas apontam para requests por id, e id só existe dentro de um
   * workspace. Sem este campo não havia como saber que uma sessão pertence a
   * outro lugar — restaurá-la abria abas órfãs, e salvar uma delas não
   * gravava em canto nenhum.
   *
   * Opcional porque sessões salvas antes disto não têm: elas aparecem sempre,
   * sem filtro, até serem salvas de novo.
   */
  workspace?: string;
  /**
   * Grupos de aba no momento em que a sessão foi salva.
   *
   * Sem isto, restaurar uma sessão de doze abas devolvia as doze soltas: os
   * grupos viviam só no workspace, fora da sessão, e a organização montada à
   * mão evaporava na restauração.
   *
   * Opcional: sessões anteriores a este campo restauram sem grupos, como
   * antes.
   */
  groups?: TabGroup[];
}

interface TabSessionSelectorProps {
  sessions: TabSession[];
  currentSessionId: string | null;
  isCurrentSessionDirty?: boolean;
  onUpdateCurrentSession: () => void;
  onLoadSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newName: string) => void;
  onDuplicateSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void; // ✅ novo
  // Converte um tab group numa pasta de collection: cria uma pasta nova
  // (com o nome do grupo) dentro de uma pasta escolhida na árvore, e
  // adiciona um request salvo pra cada aba do grupo (ver AppLayout.tsx).
  onConvertToFlow?: (session: TabSession) => void;
  // "New session": cria um grupo novo com o `name` digitado, que entra no topo
  // da lista e vira o grupo atual.
  //
  // `keepTabs` decide de onde ele nasce: true leva as abas abertas agora pro
  // grupo, sem fechar nada; false começa vazio e fecha tudo. Só o caminho que
  // fecha pode perder trabalho, e é o único onde `save` importa — com ele as
  // abas alteradas são gravadas nas suas requests antes (o mesmo que Ctrl+S).
  // Nenhum dos dois mexe em grupo já existente.
  onNewSession?: (save: boolean, name: string, keepTabs: boolean) => void;
  // Só pra dizer quantas abas serão fechadas na confirmação.
  currentTabCount?: number;
  // Alguma aba aberta tem alteração não salva na collection.
  hasUnsavedTabs?: boolean;
  // Workspace atual: a lista mostra as sessões daqui por padrão.
  workspace?: string;
  // Sair da sessão sem fechar nada: as abas continuam abertas, e o que for
  // feito daqui pra frente deixa de pertencer a ela.
  onLeaveSession?: () => void;
}

function formatSavedAt(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit' }) +
    ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function TabSessionSelector({
  sessions,
  currentSessionId,
  isCurrentSessionDirty = false,
  onUpdateCurrentSession,
  onLoadSession,
  onDeleteSession,
  onRenameSession,
  onDuplicateSession,
  onTogglePinSession,
  onConvertToFlow,
  onNewSession,
  currentTabCount = 0,
  hasUnsavedTabs = false,
  workspace,
  onLeaveSession,
}: TabSessionSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [search, setSearch] = useState('');
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmNewSession, setConfirmNewSession] = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);
  // Fluxo do "New session": primeiro o nome do grupo novo, e só depois (se
  // houver aba com alteração não salva) a confirmação de salvar/descartar. O
  // nome fica guardado aqui até o fim, porque a confirmação acontece entre
  // digitar e executar.
  const [isNamingSession, setIsNamingSession] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');

  const containerRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const newSessionInputRef = useRef<HTMLInputElement>(null);

  const currentSession = sessions.find(s => s.id === currentSessionId) ?? null;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setIsOpen(false);
        setEditingId(null);
        setConfirmDeleteId(null);
        setConfirmNewSession(false);
        setIsNamingSession(false);
        setNewSessionName('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);


  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  useEffect(() => {
    if (isOpen) setTimeout(() => searchInputRef.current?.focus(), 0);
    else {
      setSearch('');
      setConfirmDeleteId(null);
      setConfirmNewSession(false);
      setIsNamingSession(false);
      setNewSessionName('');
      setConfirmLeave(false);
    }

  }, [isOpen]);

  useEffect(() => {
    if (isNamingSession) newSessionInputRef.current?.focus();
  }, [isNamingSession]);

  const submitRename = (id: string) => {
    const trimmed = editingName.trim();
    if (trimmed) onRenameSession(id, trimmed);
    setEditingId(null);
  };

  // Só pergunta quando há de fato o que perder: alguma aba com alteração não
  // salva na collection. Com tudo salvo, fechar as abas não perde nada e o
  // clique vai direto.
  const newSessionNeedsConfirm = currentTabCount > 0 && hasUnsavedTabs;

  const closeNewSessionPrompt = () => {
    setConfirmNewSession(false);
    setIsNamingSession(false);
    setNewSessionName('');
  };

  const runNewSession = (save: boolean, keepTabs: boolean) => {
    const trimmed = newSessionName.trim();
    if (!trimmed) return;
    onNewSession?.(save, trimmed, keepTabs);
    closeNewSessionPrompt();
    setIsOpen(false);
  };

  // Criar o grupo COM as abas que já estão abertas: nada é fechado, então não
  // há edição não salva pra perder e a confirmação não se aplica.
  const createWithCurrentTabs = () => {
    if (!newSessionName.trim()) return;
    runNewSession(false, true);
  };

  // Começar limpo: aí sim as abas são fechadas, e se houver edição não salva
  // nelas o usuário precisa decidir antes.
  const createEmptySession = () => {
    if (!newSessionName.trim()) return;
    if (newSessionNeedsConfirm) setConfirmNewSession(true);
    else runNewSession(false, false);
  };

  // Esc fecha o dropdown — mas primeiro desfaz o que estiver aberto DENTRO
  // dele. Sem essa ordem, desistir de um rename ou de uma confirmação de
  // exclusão fecharia o menu inteiro junto, e o usuário perderia o lugar por
  // ter cancelado uma subação. Um Esc por camada, de dentro pra fora.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();

      if (editingId) setEditingId(null);
      else if (isNamingSession || confirmNewSession) closeNewSessionPrompt();
      else if (confirmDeleteId) setConfirmDeleteId(null);
      else setIsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, editingId, isNamingSession, confirmNewSession, confirmDeleteId]);

  const handleUpdateClick = () => {
    onUpdateCurrentSession();
    setJustUpdated(true);
    setTimeout(() => setJustUpdated(false), 1500);
  };

// Sessões de OUTRO workspace ficam escondidas por padrão: restaurá-las abre
// abas que não existem aqui. As antigas (sem workspace gravado) aparecem
// sempre — esconder o que a pessoa já tem seria pior que mostrar demais.
const foreignCount = useMemo(
  () => (workspace ? sessions.filter(s => s.workspace && s.workspace !== workspace).length : 0),
  [sessions, workspace]
);

const filteredSessions = useMemo(() => {
  const q = search.trim().toLowerCase();
  const byWorkspace =
    workspace && !showAllWorkspaces
      ? sessions.filter(s => !s.workspace || s.workspace === workspace)
      : sessions;
  const base = q ? byWorkspace.filter(s => s.name.toLowerCase().includes(q)) : byWorkspace;
  return base.slice().sort((a, b) => {
    const aPinned = !!a.pinned;
    const bPinned = !!b.pinned;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    return b.savedAt - a.savedAt;
  });
}, [sessions, search, workspace, showAllWorkspaces]);

  return (
    <div ref={containerRef} className="relative inline-block font-sans select-none">
      {/* Botão Trigger */}
      <button
        onClick={() => setIsOpen(v => !v)}
        className="flex items-center gap-2 h-7 px-2.5 rounded-md text-[12px] text-pm-text-secondary hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
        // Aqui o nome também é cortado (max-w-[120px]), então o título traz o
        // nome inteiro em vez de só repetir o rótulo do botão.
        title={currentSession ? `Session group: ${currentSession.name}` : 'Session groups'}
      >
        <FolderOpen size={13} className="text-pm-text-muted" />
        <span className="max-w-[120px] truncate">
          {currentSession ? currentSession.name : 'No group'}
        </span>
        {currentSession && isCurrentSessionDirty && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
            title="Unsaved changes in this group"
          />
        )}
        <ChevronDown size={12} className={`text-pm-text-muted transition-transform duration-100 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Menu Dropdown */}
      {isOpen && (
        <div className="absolute top-[calc(100%+4px)] left-0 z-50 w-72 rounded-lg bg-pm-surface border border-pm-border shadow-xl shadow-black/50 p-1.5 text-[12px] text-pm-text-secondary">

          {/* Cabeçalho */}
          <div className="px-2 py-1 mb-1 border-b border-pm-border flex items-center justify-between">
            <span className="text-[10px] uppercase font-semibold text-pm-text-muted tracking-wider">
              Session groups
            </span>
            {currentSession && (
              <button
                onClick={handleUpdateClick}
                className={`flex items-center gap-1 text-[11px] transition-colors cursor-pointer ${
                  justUpdated ? 'text-emerald-400' : 'text-[#3794ff] hover:underline'
                }`}
                title="Update this session with the tabs open right now"
              >
                {justUpdated ? <Check size={10} /> : <RefreshCw size={10} />}
                {justUpdated ? 'Updated!' : 'Update session'}
              </button>
            )}
          </div>

          {/* Busca — só aparece se houver sessões suficientes pra justificar */}
          {sessions.length > 4 && (
            <div className="flex items-center gap-1.5 bg-pm-hover border border-pm-border rounded-md px-2 h-7 mb-1.5">
              <Search size={11} className="text-pm-text-muted shrink-0" />
              <input
                ref={searchInputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search group..."
                className="flex-1 bg-transparent text-[11px] text-pm-text outline-none placeholder:text-pm-text-muted"
              />
            </div>
          )}

          {/* Sessões de outro workspace ficam fora por padrão. O contador
              existe pra que esconder não vire sumiço: você vê que há mais. */}
          {foreignCount > 0 && (
            <button
              onClick={() => setShowAllWorkspaces(v => !v)}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10.5px] text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer border-none bg-transparent text-left"
            >
              <Workflow size={11} className="shrink-0" />
              {showAllWorkspaces
                ? 'Showing every workspace — show only this one'
                : `${foreignCount} session${foreignCount === 1 ? '' : 's'} from other workspaces — show`}
            </button>
          )}

          {/* Lista de Sessões */}
          <div className="max-h-[260px] overflow-y-auto space-y-0.5">
            {sessions.length === 0 && (
              <div className="px-3 py-6 text-center">
                <FolderOpen size={18} className="text-pm-text-muted mx-auto mb-2" />
                <p className="text-[11px] text-pm-text-muted leading-relaxed">
                  Start a new session to group the tabs you open and switch context quickly.
                </p>
              </div>
            )}

            {filteredSessions.length === 0 && sessions.length > 0 && (
              <div className="px-2 py-4 text-center text-[11px] text-pm-text-muted">
                No group found
              </div>
            )}

            {filteredSessions.map(session => {
              const isActive = session.id === currentSessionId;
              const isEditing = editingId === session.id;
              const isPinned = !!session.pinned; // ✅ lido direto da sessão
              const isConfirmingDelete = confirmDeleteId === session.id;

              if (isConfirmingDelete) {
                return (
                  <div
                    key={session.id}
                    className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-red-500/10 border border-red-500/25"
                  >
                    <div className="flex items-center gap-1.5 min-w-0 text-[11px] text-pm-text">
                      <AlertTriangle size={11} className="text-red-400 shrink-0" />
                      {/* Confirmar exclusão com o nome cortado é o pior caso:
                          é onde mais importa ter certeza de qual sessão é. */}
                      <span className="truncate" title={session.name}>
                        Delete &ldquo;{session.name}&rdquo;?
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => { onDeleteSession(session.id); setConfirmDeleteId(null); }}
                        className="h-6 px-2 rounded-md bg-red-500 hover:bg-red-400 text-[10px] font-medium text-white cursor-pointer"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="h-6 px-2 rounded-md bg-pm-hover hover:bg-pm-row-active text-[10px] text-pm-text-secondary cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={session.id}
                  className={`group flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors ${
                    isActive
                      ? 'bg-pm-row-active text-pm-text'
                      : 'hover:bg-pm-hover text-pm-text-secondary hover:text-pm-text'
                  }`}
                >
                  {isEditing ? (
                    <div className="flex items-center gap-1 w-full">
                      <input
                        ref={editInputRef}
                        value={editingName}
                        onChange={e => setEditingName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') submitRename(session.id);
                        }}
                        className="flex-1 h-6 bg-pm-hover border border-[#007acc] text-pm-text text-[12px] px-1.5 rounded outline-none"
                      />
                      <button onClick={() => submitRename(session.id)} className="text-[#4ec9b0] hover:text-pm-text p-0.5 cursor-pointer">
                        <Check size={12} />
                      </button>
                      <button onClick={() => setEditingId(null)} className="text-pm-text-muted hover:text-pm-text p-0.5 cursor-pointer">
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                      {isPinned && (
                        <Pin size={10} className="text-amber-400 shrink-0 fill-amber-400/30" />
                      )}

                      <button
                        onClick={() => { onLoadSession(session.id); setIsOpen(false); }}
                        // O nome é cortado com reticências e a lista é
                        // estreita: sem o título, descobrir qual sessão é qual
                        // obrigava a entrar em modo rename só pra ler o texto.
                        title={session.name}
                        className="flex-1 min-w-0 text-left cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className={`truncate ${isActive ? 'font-medium text-pm-text' : ''}`}>
                            {session.name}
                          </span>
                          {isActive && isCurrentSessionDirty && (
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Unsaved changes" />
                          )}
                        </div>
                        <div className="text-[10px] text-pm-text-muted">
                          {session.tabs.length} {session.tabs.length === 1 ? 'tab' : 'tabs'} · {formatSavedAt(session.savedAt)}
                        </div>
                      </button>

                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        {onConvertToFlow && (
                          <button
                            onClick={() => { onConvertToFlow(session); setIsOpen(false); }}
                            className="text-pm-text-muted hover:text-pm-accent p-0.5 cursor-pointer"
                            title="Convert to Flow (create a collection folder from this group's tabs)"
                          >
                            <Workflow size={11} />
                          </button>
                        )}
                        <button
                           onClick={() => onTogglePinSession(session.id)}
                          className="text-[#858585] hover:text-amber-400 p-0.5 cursor-pointer"
                          title={isPinned ? 'Unpin' : 'Pin'}
                        >
                          {isPinned ? <PinOff size={11} /> : <Pin size={11} />}
                        </button>
                        <button
                          onClick={() => onDuplicateSession(session.id)}
                          className="text-pm-text-muted hover:text-pm-text p-0.5 cursor-pointer"
                          title="Duplicate"
                        >
                          <Copy size={11} />
                        </button>
                        <button
                          onClick={() => { setEditingId(session.id); setEditingName(session.name); }}
                          className="text-pm-text-muted hover:text-pm-text p-0.5 cursor-pointer"
                          title="Rename"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(session.id)}
                          className="text-[#858585] hover:text-[#f14c4c] p-0.5 cursor-pointer"
                          title="Delete"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Rodapé */}
          <div className="border-t border-pm-border mt-1 pt-1 space-y-1">
            {onNewSession && (
              confirmNewSession ? (
                <div className="rounded-md bg-amber-500/10 border border-amber-500/25 px-2 py-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-pm-text">
                    <AlertTriangle size={11} className="text-amber-400 shrink-0" />
                    <span className="truncate">
                      There are unsaved changes in the open tabs
                    </span>
                  </div>
                  <div
                    className="text-[10px] text-pm-text-muted mt-0.5 truncate"
                    title={newSessionName.trim()}
                  >
                    New group: &ldquo;{newSessionName.trim()}&rdquo;
                  </div>
                  <div className="flex items-center gap-1 mt-1.5">
                    <button
                      onClick={() => runNewSession(true, false)}
                      title="Save each changed tab into its request in the collection, then close them"
                      className="h-6 px-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-[10px] font-medium text-white cursor-pointer"
                    >
                      <span className="flex items-center gap-1">
                        <Save size={10} />
                        Save and close
                      </span>
                    </button>
                    <button
                      onClick={() => runNewSession(false, false)}
                      title="Close the tabs and throw the changes away"
                      className="h-6 px-2 rounded-md bg-amber-500 hover:bg-amber-400 text-[10px] font-medium text-black cursor-pointer"
                    >
                      Discard
                    </button>
                    <button
                      onClick={closeNewSessionPrompt}
                      className="h-6 px-2 rounded-md bg-pm-hover hover:bg-pm-row-active text-[10px] text-pm-text-secondary cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : isNamingSession ? (
                <div className="px-1 py-0.5">
                  <div className="flex items-center gap-1">
                    <input
                      ref={newSessionInputRef}
                      value={newSessionName}
                      onChange={e => setNewSessionName(e.target.value)}
                      onKeyDown={e => {
                        // Enter faz o que o botão em destaque faz: com abas
                        // abertas, agrupá-las é o caminho que não perde nada.
                        if (e.key !== 'Enter') return;
                        if (currentTabCount > 0) createWithCurrentTabs();
                        else createEmptySession();
                      }}
                      placeholder="New session name..."
                      className="w-full h-6 bg-pm-hover border border-[#007acc] text-pm-text text-[12px] px-1.5 rounded outline-none placeholder:text-[#6e6e6e]"
                    />
                    <button onClick={closeNewSessionPrompt} title="Cancel" className="text-pm-text-muted hover:text-pm-text p-0.5 cursor-pointer">
                      <X size={12} />
                    </button>
                  </div>

                  <div className="mt-1.5 flex items-center gap-1">
                    {currentTabCount > 0 && (
                      <button
                        onClick={createWithCurrentTabs}
                        disabled={!newSessionName.trim()}
                        title="Create the group already containing the tabs open right now — nothing is closed"
                        className="h-6 flex-1 rounded-md bg-[#007acc] px-2 text-[10px] font-medium text-white hover:bg-[#3794ff] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Use the {currentTabCount} open {currentTabCount === 1 ? 'tab' : 'tabs'}
                      </button>
                    )}
                    <button
                      onClick={createEmptySession}
                      disabled={!newSessionName.trim()}
                      title="Close every open tab and start the group empty"
                      className="h-6 flex-1 rounded-md bg-pm-hover px-2 text-[10px] text-pm-text-secondary hover:text-pm-text cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Start empty
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setIsNamingSession(true)}
                    title="Create a new group — either from the tabs open right now, or empty"
                    className="flex items-center justify-center gap-1.5 flex-1 h-7 rounded-md text-[11px] font-medium text-pm-text-secondary hover:text-pm-text bg-pm-hover hover:bg-pm-row-active border border-pm-border transition-colors cursor-pointer"
                  >
                    <FilePlus size={12} />
                    New session
                  </button>

                  {/* Sair sem fechar nada. Antes a única forma de não estar
                      numa sessão era APAGAR a sessão — o estado "sem sessão"
                      existia (o botão diz "No group") e não havia caminho até
                      ele. */}
                  {currentSessionId && onLeaveSession && (
                    <button
                      onClick={() => {
                        // Com alteração pendente, sair abandona o que não foi
                        // gravado NA SESSÃO — por isso pergunta antes.
                        if (isCurrentSessionDirty && !confirmLeave) {
                          setConfirmLeave(true);
                          return;
                        }
                        onLeaveSession();
                        setConfirmLeave(false);
                        setIsOpen(false);
                      }}
                      title={
                        isCurrentSessionDirty
                          ? 'Leave this session — the tabs stay open, and the session keeps its last saved state'
                          : 'Leave this session — the tabs stay open'
                      }
                      className={`flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                        confirmLeave
                          ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                          : 'border-pm-border bg-pm-hover text-pm-text-secondary hover:text-pm-text hover:bg-pm-row-active'
                      }`}
                    >
                      <LogOut size={12} />
                      {confirmLeave ? 'Leave anyway?' : 'Leave'}
                    </button>
                  )}
                </div>
              )
            )}

          </div>

        </div>
      )}
    </div>
  );
}


