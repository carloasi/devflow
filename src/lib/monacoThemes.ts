// Registro de temas do Monaco Editor espelhando a paleta real do app (ver
// [data-theme='...'] em globals.css). Antes disto, todos os editores só
// trocavam entre os dois temas embutidos do Monaco ('vs' claro / 'vs-dark'
// escuro), então os 12 temas da tela Themes viravam só 2 dentro do editor
// (ex.: Dracula, Monokai, Ayu Dark e Night Owl Dark todos ficavam idênticos,
// com o cinza padrão do vs-dark, em vez da cor de fundo real de cada um).
//
// Aqui definimos um tema Monaco de verdade por id (base 'vs'/'vs-dark' pra
// herdar a coloração de sintaxe, mais as cores de UI do editor — fundo,
// linha ativa, cursor, seleção, guias, scrollbar etc. — usando os MESMOS
// hex das variáveis --color-pm-* de cada bloco [data-theme] em globals.css,
// pra o editor combinar visualmente com o resto do app).
import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditorNS } from 'monaco-editor';

interface MonacoThemePalette {
  mode: 'light' | 'dark';
  bg: string;
  sidebar: string;
  border: string;
  accent: string;
  text: string;
  textMuted: string;
  hover: string;
  surface: string;
}

// Espelha 1:1 os valores de src/app/globals.css — se um tema mudar lá,
// atualize aqui também.
const PALETTES: Record<string, MonacoThemePalette> = {
  dark: {
    mode: 'dark', bg: '#1c1c1c', sidebar: '#212121', border: '#303030',
    accent: '#2f67cc', text: '#e3e3e3', textMuted: '#9a9a9a', hover: '#252525', surface: '#232323',
  },
  light: {
    mode: 'light', bg: '#ffffff', sidebar: '#f4f4f5', border: '#e4e4e7',
    accent: '#ff6c37', text: '#18181b', textMuted: '#71717a', hover: '#ececed', surface: '#f4f4f5',
  },
  'high-contrast-light': {
    mode: 'light', bg: '#ffffff', sidebar: '#f0f0f0', border: '#000000',
    accent: '#d32f2f', text: '#000000', textMuted: '#292929', hover: '#e0e0e0', surface: '#ffffff',
  },
  'high-contrast-dark': {
    mode: 'dark', bg: '#000000', sidebar: '#000000', border: '#ffffff',
    accent: '#ff6c37', text: '#ffffff', textMuted: '#cccccc', hover: '#1a1a1a', surface: '#000000',
  },
  'ayu-light': {
    mode: 'light', bg: '#fafafa', sidebar: '#f3f3f3', border: '#e6e6e6',
    accent: '#ff9940', text: '#5c6166', textMuted: '#8a9199', hover: '#efefef', surface: '#f3f3f3',
  },
  'ayu-dark': {
    mode: 'dark', bg: '#0d1017', sidebar: '#131721', border: '#2a2f3a',
    accent: '#ffb454', text: '#bfbdb6', textMuted: '#6c7380', hover: '#1a1f2b', surface: '#131721',
  },
  dracula: {
    mode: 'dark', bg: '#282a36', sidebar: '#21222c', border: '#44475a',
    accent: '#bd93f9', text: '#f8f8f2', textMuted: '#6272a4', hover: '#343746', surface: '#21222c',
  },
  monokai: {
    mode: 'dark', bg: '#272822', sidebar: '#1e1f1a', border: '#49483e',
    accent: '#66d9ef', text: '#f8f8f2', textMuted: '#75715e', hover: '#3e3d32', surface: '#1e1f1a',
  },
  'night-owl-light': {
    mode: 'light', bg: '#ffffff', sidebar: '#f0f0f0', border: '#e0e6ea',
    accent: '#2aa298', text: '#403f53', textMuted: '#90a7b2', hover: '#f5f5f5', surface: '#f0f0f0',
  },
  'night-owl-dark': {
    mode: 'dark', bg: '#011627', sidebar: '#01111d', border: '#1d3b53',
    accent: '#7fdbca', text: '#d6deeb', textMuted: '#5f7e97', hover: '#0b2942', surface: '#01111d',
  },
  'solarized-light': {
    mode: 'light', bg: '#fdf6e3', sidebar: '#eee8d5', border: '#dcd3b5',
    accent: '#b58900', text: '#657b83', textMuted: '#93a1a1', hover: '#f5efdc', surface: '#eee8d5',
  },
  'solarized-dark': {
    mode: 'dark', bg: '#002b36', sidebar: '#00212b', border: '#0a4b5c',
    accent: '#2aa198', text: '#839496', textMuted: '#586e75', hover: '#073642', surface: '#00212b',
  },
};

const DEFAULT_PALETTE_ID = 'dark';

/** Nome do tema registrado no Monaco pra um dado id de tema do app. */
export function getMonacoThemeName(themeId: string): string {
  return `devflow-${PALETTES[themeId] ? themeId : DEFAULT_PALETTE_ID}`;
}

function buildThemeData(palette: MonacoThemePalette): MonacoEditorNS.IStandaloneThemeData {
  return {
    base: palette.mode === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    // Sem overrides de token — herda a coloração de sintaxe do base
    // vs/vs-dark (aproximação razoável pra todos os temas; refinar por
    // linguagem/tema exigiria uma grammar completa por tema).
    rules: palette.mode === 'dark'
      ? [{ token: 'comment', foreground: palette.textMuted.replace('#', '') }]
      : [],
    colors: {
      'editor.background': palette.bg,
      'editor.foreground': palette.text,
      'editorLineNumber.foreground': palette.textMuted,
      'editorLineNumber.activeForeground': palette.text,
      'editor.lineHighlightBackground': palette.hover,
      'editor.lineHighlightBorder': palette.hover,
      'editorCursor.foreground': palette.accent,
      'editor.selectionBackground': `${palette.accent}40`,
      'editor.inactiveSelectionBackground': `${palette.accent}25`,
      'editor.wordHighlightBackground': `${palette.accent}20`,
      'editorIndentGuide.background1': palette.border,
      'editorIndentGuide.activeBackground1': `${palette.accent}90`,
      'editorWidget.background': palette.surface,
      'editorWidget.border': palette.border,
      'editorSuggestWidget.background': palette.surface,
      'editorSuggestWidget.border': palette.border,
      'editorSuggestWidget.selectedBackground': palette.hover,
      'editorHoverWidget.background': palette.surface,
      'editorHoverWidget.border': palette.border,
      'editorBracketMatch.background': `${palette.accent}30`,
      'editorBracketMatch.border': palette.accent,
      'scrollbarSlider.background': `${palette.border}90`,
      'scrollbarSlider.hoverBackground': `${palette.border}c0`,
      'scrollbarSlider.activeBackground': `${palette.accent}80`,
      'editorGutter.background': palette.bg,
      'diffEditor.insertedTextBackground': '#4ff09d20',
      'diffEditor.removedTextBackground': '#ff7b7b20',
    },
  };
}

let registered = false;

/** Registra todos os 12 temas Monaco de uma vez (idempotente — chame no
 * beforeMount de cada Editor/DiffEditor, é seguro chamar mais de uma vez). */
export function registerDevflowMonacoThemes(monaco: Monaco): void {
  if (registered) return;
  Object.entries(PALETTES).forEach(([id, palette]) => {
    monaco.editor.defineTheme(`devflow-${id}`, buildThemeData(palette));
  });
  registered = true;
}
