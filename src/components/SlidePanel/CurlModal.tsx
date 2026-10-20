'use client';

import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Check, Copy, Download, Hash, Loader2 } from 'lucide-react';
import { SlidePanel } from './SlidePanel';
import { generateSnippet, SNIPPET_LANGUAGES, type SnippetLanguage, type SnippetRequest } from '@/lib/codeSnippets';

interface CurlModalProps {
  isOpen: boolean;
  onClose: () => void;
  // Request já resolvida (variáveis, path params, headers de auth e body).
  // O texto de cada linguagem sai daqui, via generateSnippet.
  request: SnippetRequest | null;
  // Mesma request, mas preservando os comentários que estão no body do
  // editor. Opcional: só difere quando o body realmente tem comentários.
  requestWithComments?: SnippetRequest;
  onCurlChange?: (newCommand: string) => void;
  // Nome da aba ativa — vira o nome sugerido do arquivo ao baixar.
  requestName?: string;
}

// Extensão sugerida ao salvar em arquivo, por linguagem.
const FILE_EXTENSION: Record<SnippetLanguage, string> = {
  curl: 'sh',
  javascript: 'js',
  python: 'py',
  csharp: 'cs',
  powershell: 'ps1',
};

/*
 * ============================================================
 * SYNTAX HIGHLIGHT (leve, sem dependência externa)
 * ============================================================
 */
function highlightCurl(command: string) {
  const lines = command.split('\n');

  return lines.map((line, i) => {
    const tokens: { text: string; className: string }[] = [];
    let rest = line;

    // Guarda a continuação EXATAMENTE como está no texto (a barra e os
    // espaços depois dela). A camada colorida fica embaixo do textarea e as
    // duas precisam ter os mesmos caracteres — antes ela somava um espaço
    // antes da barra, a linha ficava 1 caractere maior, quebrava em outro
    // ponto e a seleção aparecia deslocada do texto.
    const continuation = rest.match(/\\\s*$/)?.[0] ?? '';
    const endsWithBackslash = continuation !== '';
    if (endsWithBackslash) {
      rest = rest.slice(0, rest.length - continuation.length);
    }

    const regex = /(--?[a-zA-Z0-9-]+)|('[^']*'|"[^"]*")|(https?:\/\/[^\s'"]+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(rest)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({ text: rest.slice(lastIndex, match.index), className: 'text-pm-text' });
      }
      if (match[1]) {
        // Flags / Opções (ex: --location, --request, -H, -d)
        tokens.push({ text: match[1], className: 'text-[#ce9178] font-medium' });
      } else if (match[2]) {
        // Strings / Valores de Headers e Body
        tokens.push({ text: match[2], className: 'text-[#ce9178]' });
      } else if (match[3]) {
        // URLs
        tokens.push({ text: match[3], className: 'text-[#4fc1ff]' });
      }
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < rest.length) {
      tokens.push({ text: rest.slice(lastIndex), className: 'text-pm-text' });
    }

    return { tokens, endsWithBackslash, continuation, key: i };
  });
}

// Nome sugerido pro arquivo: o nome da aba (ex: "3 - AirSearch v1" →
// "3 - AirSearch v1.sh"), com os caracteres que o Windows não aceita em
// nome de arquivo trocados por "-".
function suggestedFileName(requestName?: string): string {
  const sanitized = requestName?.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
  return sanitized || 'request-snippet';
}

export function CurlModal({
  isOpen,
  onClose,
  request,
  requestWithComments,
  onCurlChange,
  requestName,
}: CurlModalProps) {
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState<SnippetLanguage>('curl');
  // Desligado por padrão: o comando sai igual ao que é realmente enviado.
  // Manter os comentários é útil pra documentar (ex: credenciais
  // alternativas comentadas no body), mas o comando deixa de ser JSON
  // válido — daí não poder ser o padrão.
  const [keepComments, setKeepComments] = useState(false);

  // Só faz sentido oferecer a opção quando o body tem comentários — se as
  // duas versões são iguais, o botão não teria efeito nenhum.
  const hasComments = !!requestWithComments && requestWithComments.body !== request?.body;
  const sourceRequest = keepComments && requestWithComments ? requestWithComments : request;

  const sourceCommand = useMemo(
    () => (sourceRequest ? generateSnippet(sourceRequest, language) : ''),
    [sourceRequest, language]
  );

  const [code, setCode] = useState(sourceCommand);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  // Sincroniza o estado interno quando a request muda ou quando a opção de
  // comentários é alternada (o comando é regerado, então edições manuais
  // feitas aqui são descartadas de propósito).
  useEffect(() => {
    setCode(sourceCommand);
  }, [sourceCommand]);

  const highlightedLines = useMemo(() => highlightCurl(code), [code]);

  const handleCodeChange = (newText: string) => {
    setCode(newText);
    if (onCurlChange) {
      onCurlChange(newText);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Salva o comando em arquivo. Usa o diálogo nativo do Tauri (mesmo caminho
  // do "Save response" no painel de resposta) em vez do download do
  // navegador, que dentro do WebView não deixa escolher a pasta.
  const handleDownload = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');

      const filePath = await save({
        title: 'Save code snippet',
        defaultPath: `${suggestedFileName(requestName)}.${FILE_EXTENSION[language]}`,
        filters: [
          { name: 'Snippet', extensions: [FILE_EXTENSION[language]] },
          { name: 'Text file', extensions: ['txt'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });

      if (!filePath) return;
      await writeTextFile(filePath, code);
    } catch (e) {
      console.log('cURL download error:', e);
    } finally {
      setSaving(false);
    }
  };

  // Sincroniza o scroll vertical do textarea com a camada de highlight
  const handleScroll = () => {
    if (textareaRef.current && preRef.current) {
      preRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  // Suporte a indentação com a tecla TAB no Textarea
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      const newValue = code.substring(0, start) + '  ' + code.substring(end);
      handleCodeChange(newValue);

      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }, 0);
    }
  };

  return (
    <SlidePanel isOpen={isOpen} onClose={onClose} title="Code snippet" defaultWidth={540}>
      {/* Subheader: Seletor de Linguagem + Ações */}
      <div className="flex items-center justify-between bg-pm-sidebar px-4 py-2">
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value as SnippetLanguage)}
          title="Language"
          className="cursor-pointer rounded border border-pm-border bg-pm-hover px-2 py-1 text-[11px] font-medium text-pm-text outline-none focus:border-[#007acc]"
        >
          {SNIPPET_LANGUAGES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          {hasComments && (
            <>
              <button
                onClick={() => setKeepComments(v => !v)}
                className={`flex h-7 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors cursor-pointer ${
                  keepComments
                    ? 'bg-amber-400/15 text-amber-400'
                    : 'text-pm-text-muted hover:bg-pm-hover hover:text-pm-text'
                }`}
                title={
                  keepComments
                    ? 'Keeping the body comments — the command is not valid JSON anymore'
                    : 'Body comments removed, same as what is actually sent'
                }
              >
                <Hash size={13} />
                Comments
              </button>

              <div className="mx-0.5 h-4 w-px bg-pm-border" />
            </>
          )}

          <button
            onClick={handleDownload}
            disabled={saving}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text disabled:cursor-wait"
            title="Download snippet as a file"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          </button>

          <button
            onClick={handleCopy}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text"
            title="Copy snippet"
          >
            {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
          </button>
        </div>
      </div>


      {keepComments && (
        <div className="border-b border-pm-border bg-amber-400/10 px-4 py-1.5 text-[11px] text-amber-300/90">
          Comments kept for reference — this command won&apos;t run as-is, the body is no longer valid JSON.
        </div>
      )}

      <div className="relative h-[calc(100vh-100px)] w-full bg-pm-sidebar font-mono text-[12px] leading-[20px]">
        <div className="relative h-full w-full overflow-hidden">
          {/* Camada de Destaque (Renderização) */}
          <pre
            ref={preRef}
            aria-hidden="true"
            // Mesma largura útil do textarea: ele tem barra de rolagem e a
            // <pre> não, então as linhas longas quebravam em pontos
            // diferentes. O gutter estável reserva o espaço nas duas.
            className="absolute inset-0 pointer-events-none m-0 h-full w-full overflow-hidden [scrollbar-gutter:stable] scrollbar-thin p-3 font-mono text-[12px] leading-[20px] whitespace-pre-wrap break-all border-0"
          >
            <code>
              {highlightedLines.map((line) => (
                // min-h: linha vazia também ocupa uma linha, igual no textarea.
                <div key={line.key} className="min-h-[20px] whitespace-pre-wrap break-all">
                  {line.tokens.map((t, j) => (
                    <span key={j} className={t.className}>
                      {t.text}
                    </span>
                  ))}
                  {line.endsWithBackslash && <span className="text-pm-text-muted">{line.continuation}</span>}
                </div>
              ))}
              {/* Folga no fim: sem ela, rolando o textarea até o final a
                  camada colorida batia no limite antes e desalinhava. */}
              <div className="h-[20px]" />
            </code>
          </pre>

          {/* Camada de Edição (Textarea Transparente) */}
          <textarea
            ref={textareaRef}
            value={code}
            onChange={(e) => handleCodeChange(e.target.value)}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            className="absolute inset-0 h-full w-full resize-none bg-transparent p-3 font-mono text-[12px] leading-[20px] text-transparent caret-[#db7f4d] outline-none whitespace-pre-wrap break-all overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] scrollbar-thin scrollbar-thumb-[var(--color-pm-border)] selection:bg-[#3a7bd5]/45 border-0"
          />
        </div>
      </div>
      
    </SlidePanel>
  );
}

