'use client';

import dynamic from 'next/dynamic';
import { loader } from '@monaco-editor/react';
import type { OnChange, OnMount, Monaco } from '@monaco-editor/react';
import { useTheme } from './ThemeContext';
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes';
import { PM_API_TYPES } from '@/lib/pmApiTypes';
//import * as monaco from 'monaco-editor';

// `addExtraLib` precisa rodar só uma vez por instância do Monaco (é global
// ao editor, não por componente) — sem essa guarda, cada montagem de um
// novo CodeEditor (troca de aba, novo request, etc.) registraria a mesma
// lib de novo, acumulando entradas duplicadas no language service.
let pmApiLibRegistered = false;

// Configura o Monaco para usar os recursos locais em vez do CDN padrão
//loader.config({ monaco });

const MonacoEditor = dynamic(
  () => import('@monaco-editor/react'),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
       Loading...
      </div>
    ),
  }
);

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
  height?: string | number;
  onMount?: OnMount;
  readOnly?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  language = 'javascript',
  height = '100%',
  onMount,
  readOnly = false,
}: CodeEditorProps) {
  const { effectiveThemeId } = useTheme();
  const handleChange: OnChange = (val) => {
    onChange(val ?? '');
  };
  const handleBeforeMount = (monaco: Monaco) => {
    registerDevflowMonacoThemes(monaco);

    // Ensina o Monaco sobre a API `pm.*` (e globais legadas tipo
    // `tests`/`postman.*`) usada nos scripts de Pre-request/Post-response —
    // sem isso, o autocomplete não sabia que `pm` existia e não sugeria
    // nada além do JS puro. Só afeta editores com language="javascript"
    // (o editor de body usa "json", então não é impactado).
    if (!pmApiLibRegistered) {
      monaco.languages.typescript.javascriptDefaults.addExtraLib(
        PM_API_TYPES,
        'file:///node_modules/@types/devflow-pm-api/index.d.ts'
      );
      pmApiLibRegistered = true;
    }
  };

  return (
    <div className="h-full w-full overflow-hidden rounded-lg bg-pm-bg">
      <MonacoEditor
        height={height}
        language={language}
        theme={getMonacoThemeName(effectiveThemeId)}
        beforeMount={handleBeforeMount}
        value={value}
        onChange={handleChange}
        onMount={onMount}
        options={{
          readOnly,
          // Aparência
          fontSize: 14,
          fontFamily: 'Fira Code, Consolas, monospace',
          fontLigatures: true,
          lineNumbers: 'on',
          roundedSelection: true,
          renderLineHighlight: 'all',
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',

          // Layout
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          wrappingIndent: 'indent',
          padding: {
            top: 12,
            bottom: 12,
          },

          // Editor
          tabSize: 2,
          insertSpaces: true,
          formatOnPaste: true,
          formatOnType: true,

          // Minimap
          minimap: {
            enabled: false,
          },

          // Scroll
          smoothScrolling: true,
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            useShadows: false,
          },

          // Sugestões
          quickSuggestions: true,
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: 'on',
          snippetSuggestions: 'inline',

          // Guias
          guides: {
            indentation: true,
            highlightActiveIndentation: true,
          },

          // Diversos
          folding: true,
          foldingHighlight: true,
          bracketPairColorization: {
            enabled: true,
          },
          matchBrackets: 'always',
        }}
      />
    </div>
  );
}