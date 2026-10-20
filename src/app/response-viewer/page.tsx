'use client';

import { Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import type { OnMount, Monaco } from '@monaco-editor/react';
import {
  Copy, Check, ChevronsDownUp, ChevronsUpDown, GitCompare, X, WrapText, ClipboardPaste, Pin, PinOff,
} from 'lucide-react';
import { TitleBar } from '@/components/TitleBar';
import { useAppZoom } from '@/lib/useAppZoom';
import { useTheme } from '@/components/ThemeContext';
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });
const DiffEditor = dynamic(
  () => import('@monaco-editor/react').then((mod) => mod.DiffEditor),
  { ssr: false }
);

function tryFormatJson(text: string): string {
  if (!text.trim()) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function ResponseViewerPage() {
  return (
    <Suspense fallback={null}>
      <ResponseViewerContent />
    </Suspense>
  );
}

function ResponseViewerContent() {
  const searchParams = useSearchParams();
  // Mesmo zoom por Ctrl + roda do mouse da janela principal.
  useAppZoom();
  const { effectiveThemeId } = useTheme();
  const monacoTheme = getMonacoThemeName(effectiveThemeId);
  const handleBeforeMount = useCallback((monaco: Monaco) => {
    registerDevflowMonacoThemes(monaco);
  }, []);
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('Response');
  const [wordWrap, setWordWrap] = useState<'on' | 'off'>('on');
  const [copied, setCopied] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);

  const [compareOpen, setCompareOpen] = useState(false);
  const [comparePanelOpen, setComparePanelOpen] = useState(false);
  const [compareDraft, setCompareDraft] = useState('');
  const [compareValue, setCompareValue] = useState('');

  const editorRef = useRef<any>(null);

  useEffect(() => {
    const key = searchParams.get('key');
    const titleParam = searchParams.get('title');
    if (titleParam) setTitle(titleParam);
    if (key) {
      const stored = localStorage.getItem(key);
      setContent(stored ?? '');
      localStorage.removeItem(key);
    }
  }, [searchParams]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const handleExpandAll = useCallback(() => {
    editorRef.current?.getAction('editor.unfoldAll')?.run();
  }, []);

  const handleCollapseAll = useCallback(() => {
    editorRef.current?.getAction('editor.foldAll')?.run();
  }, []);

  const handleToggleAlwaysOnTop = useCallback(async () => {
    const next = !alwaysOnTop;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setAlwaysOnTop(next);
      setAlwaysOnTop(next);
    } catch (e) {
      console.error('Erro ao fixar janela no topo:', e);
    }
  }, [alwaysOnTop]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('Copy error:', e);
    }
  }, [content]);

  const handlePasteIntoCompare = useCallback(async () => {
    try {
      const clip = await navigator.clipboard.readText();
      setCompareDraft(tryFormatJson(clip));
    } catch (e) {
      console.error('Clipboard read error:', e);
    }
  }, []);

  const handleOpenCompare = useCallback(() => {
    // Sempre abre em branco — antes colava o clipboard automaticamente
    // quando o campo estava vazio, o que fazia o modal "lembrar" conteúdo
    // de uma vez anterior. O usuário agora usa o botão "Paste" manualmente.
    setCompareDraft('');
    setComparePanelOpen(true);
  }, []);

  const handleApplyCompare = useCallback(() => {
    setCompareValue(tryFormatJson(compareDraft));
    setCompareOpen(true);
    setComparePanelOpen(false);
  }, [compareDraft]);

  const handleCloseCompare = useCallback(() => {
    setCompareOpen(false);
    setCompareValue('');
  }, []);

  const sizeBytes = new TextEncoder().encode(content).length;
  const lineCount = content ? content.split('\n').length : 0;

  return (
    <div className="h-screen w-screen flex flex-col bg-pm-bg text-pm-text overflow-hidden font-sans">

      <TitleBar
        leftContent={
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4ff09d] shrink-0" />
            <span className="text-[12px] font-medium text-pm-text-secondary truncate">{title}</span>
          </div>
        }
        rightContent={
          <div className="flex items-center gap-1.5 text-pm-text-muted">
            <span className="text-[10.5px] text-pm-text-muted tabular-nums mr-1">
              {lineCount} linhas · {formatBytes(sizeBytes)}
            </span>

            <div className="w-px h-4 bg-pm-hover mx-1" />

            <button onClick={handleCollapseAll} title="Recolher tudo"
              className="p-1.5 rounded-md hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer">
              <ChevronsDownUp size={14} />
            </button>
            <button onClick={handleExpandAll} title="Expandir tudo"
              className="p-1.5 rounded-md hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer">
              <ChevronsUpDown size={14} />
            </button>
            <button
              onClick={() => setWordWrap((w) => (w === 'on' ? 'off' : 'on'))}
              title="Word wrap"
              className={`p-1.5 rounded-md hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer ${wordWrap === 'on' ? 'text-pm-accent' : ''}`}
            >
              <WrapText size={14} />
            </button>

            <button
              onClick={handleToggleAlwaysOnTop}
              title={alwaysOnTop ? 'Unpin (stop staying on top)' : 'Always on top'}
              className={`p-1.5 rounded-md hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer ${alwaysOnTop ? 'text-pm-accent' : ''}`}
            >
              {alwaysOnTop ? <PinOff size={14} /> : <Pin size={14} />}
            </button>

            <div className="w-px h-4 bg-pm-hover mx-1" />

            <button onClick={handleCopy} title="Copy"
              className="p-1.5 rounded-md hover:bg-pm-hover hover:text-pm-text transition-colors cursor-pointer">
              {copied ? <Check size={14} className="text-[#4ff09d]" /> : <Copy size={14} />}
            </button>

            {!compareOpen ? (
              <button
                onClick={handleOpenCompare}
                title="Compare with another JSON"
                className="flex items-center gap-1.5 px-2 py-1 ml-1 rounded-md border border-pm-border text-[11px] font-medium hover:bg-pm-hover hover:text-pm-text hover:border-pm-border transition-colors cursor-pointer"
              >
                <GitCompare size={13} />
                <span>Compare</span>
              </button>
            ) : (
              <button
                onClick={handleCloseCompare}
                title="Close comparison"
                className="flex items-center gap-1.5 px-2 py-1 ml-1 rounded-md border border-[#5c2a2a] bg-[#3d1a1a] text-[#ff7b7b] text-[11px] font-medium hover:bg-[#4a2020] transition-colors cursor-pointer"
              >
                <X size={13} />
                <span>Close comparison</span>
              </button>
            )}
          </div>
        }
      />

      {/* Corpo */}
      <div className="flex-1 min-h-0 relative">
        {!compareOpen ? (
          <Editor
            height="100%"
            defaultLanguage="json"
            theme={monacoTheme}
            beforeMount={handleBeforeMount}
            value={content}
            onMount={handleEditorMount}
            onChange={(value) => setContent(value ?? '')}
            options={{
              readOnly: false,
              minimap: { enabled: false },
              fontSize: 12,
              padding: { top: 10 },
              wordWrap,
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 10, useShadows: false },
            }}
          />
        ) : (
          <DiffEditor
            height="100%"
            language="json"
            theme={monacoTheme}
            beforeMount={handleBeforeMount}
            original={content}
            modified={compareValue}
            options={{
              readOnly: false,
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap,
              renderSideBySide: true,
              // Por padrão o Monaco troca sozinho pra visão "inline" (um
              // lado só) quando a janela fica estreita — mesmo com
              // renderSideBySide: true. Isso mantém os dois lados sempre
              // visíveis, com scroll horizontal se precisar, mesmo com a
              // janela pequena.
              useInlineViewWhenSpaceIsLimited: false,
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 10, useShadows: false },
            }}
          />
        )}
      </div>

      {/* Painel para colar/inserir o JSON de comparação */}
      {comparePanelOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[560px] max-w-[90vw] bg-pm-sidebar border border-pm-border rounded-xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-pm-border">
              <span className="text-[13px] font-semibold text-pm-text">Compare with JSON</span>
              <button
                onClick={() => setComparePanelOpen(false)}
                className="p-1 rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <div className="p-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] text-pm-text-muted">Paste or type the JSON</span>
                <button
                  onClick={handlePasteIntoCompare}
                  className="flex items-center gap-1 text-[11px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                >
                  <ClipboardPaste size={12} /> Paste
                </button>
              </div>
              <textarea
                autoFocus
                value={compareDraft}
                onChange={(e) => setCompareDraft(e.target.value)}
                placeholder="Paste the JSON you want to compare here..."
                spellCheck={false}
                className="w-full h-56 resize-none rounded-md border border-pm-border bg-pm-surface p-2.5 font-mono text-[12px] text-pm-text outline-none focus:border-pm-accent/60 transition-colors placeholder-pm-text-muted"
              />
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-pm-border bg-pm-hover/40">
              <button
                onClick={() => setComparePanelOpen(false)}
                className="h-[30px] px-3 rounded-md text-[11.5px] font-medium cursor-pointer text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApplyCompare}
                disabled={!compareDraft.trim()}
                className="h-[30px] px-3.5 rounded-md text-[11.5px] font-semibold cursor-pointer bg-pm-accent text-white hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Compare
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}