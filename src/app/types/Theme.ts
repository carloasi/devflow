// Catálogo de temas visuais, no estilo da tela "Themes" do Postman.
//
// Todos os 12 são reais agora — cada um tem uma paleta completa em
// globals.css (bloco [data-theme='<id>']) além das cores de preview daqui
// (usadas só pelo mini-mockup do card). `implemented` continua existindo
// como trava de segurança: se um tema for adicionado aqui no futuro sem
// paleta pronta em globals.css, basta deixar false que a UI mostra "Soon" e
// não deixa selecionar.
//
// As cores de `preview` não precisam ser pixel-perfect em relação à paleta
// real do editor de código (Monaco não tem um tema pronto pra cada um destes
// — ver getThemeMode/monacoTheme nos componentes de editor, que usam
// vs-dark/light conforme o `mode` do tema). Servem só pra dar uma ideia
// visual no card.

export type ThemeMode = 'light' | 'dark';

export interface ThemePreviewColors {
  /** fundo da "janela" do mockup */
  windowBg: string;
  /** fundo da barra de título do mockup */
  titleBarBg: string;
  /** fundo da área de conteúdo abaixo da barra de título */
  contentBg: string;
  /** cor das linhas de "texto" fake */
  textBar: string;
  /** cor de borda do input fake */
  inputBorder: string;
  /** cor de destaque (botão colorido no mockup) */
  accent: string;
  /** segunda cor de destaque (barrinha extra embaixo, como no Postman) */
  accentSecondary: string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  mode: ThemeMode;
  preview: ThemePreviewColors;
  /** true = realmente muda as cores do app; false = só aparece na grade */
  implemented: boolean;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'light',
    name: 'Light',
    mode: 'light',
    implemented: true,
    preview: {
      windowBg: '#ffffff',
      titleBarBg: '#f4f4f5',
      contentBg: '#ffffff',
      textBar: '#d4d4d8',
      inputBorder: '#e4e4e7',
      accent: '#2f67cc',
      accentSecondary: '#ff6c37',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#1c1c1c',
      titleBarBg: '#212121',
      contentBg: '#181818',
      textBar: '#3f3f46',
      inputBorder: '#303030',
      accent: '#2f67cc',
      accentSecondary: '#ff6c37',
    },
  },
  {
    id: 'high-contrast-light',
    name: 'High Contrast Light',
    mode: 'light',
    implemented: true,
    preview: {
      windowBg: '#ffffff',
      titleBarBg: '#000000',
      contentBg: '#ffffff',
      textBar: '#000000',
      inputBorder: '#000000',
      accent: '#c92a2a',
      accentSecondary: '#000000',
    },
  },
  {
    id: 'high-contrast-dark',
    name: 'High Contrast Dark',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#000000',
      titleBarBg: '#000000',
      contentBg: '#000000',
      textBar: '#ffffff',
      inputBorder: '#ffffff',
      accent: '#ff6c37',
      accentSecondary: '#ff6c37',
    },
  },
  {
    id: 'ayu-light',
    name: 'Ayu Light',
    mode: 'light',
    implemented: true,
    preview: {
      windowBg: '#fafafa',
      titleBarBg: '#f3f3f3',
      contentBg: '#fafafa',
      textBar: '#e0e0e0',
      inputBorder: '#e6e6e6',
      accent: '#ff9940',
      accentSecondary: '#ff9940',
    },
  },
  {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#0d1017',
      titleBarBg: '#131721',
      contentBg: '#0d1017',
      textBar: '#2a2f3a',
      inputBorder: '#2a2f3a',
      accent: '#ffcc66',
      accentSecondary: '#ffcc66',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#282a36',
      titleBarBg: '#21222c',
      contentBg: '#282a36',
      textBar: '#44475a',
      inputBorder: '#44475a',
      accent: '#ff79c6',
      accentSecondary: '#bd93f9',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#272822',
      titleBarBg: '#1e1f1a',
      contentBg: '#272822',
      textBar: '#49483e',
      inputBorder: '#49483e',
      accent: '#66d9ef',
      accentSecondary: '#a6e22e',
    },
  },
  {
    id: 'night-owl-light',
    name: 'Night Owl Light',
    mode: 'light',
    implemented: true,
    preview: {
      windowBg: '#ffffff',
      titleBarBg: '#f0f0f0',
      contentBg: '#ffffff',
      textBar: '#d3e0e9',
      inputBorder: '#e0e6ea',
      accent: '#2aa298',
      accentSecondary: '#2aa298',
    },
  },
  {
    id: 'night-owl-dark',
    name: 'Night Owl Dark',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#011627',
      titleBarBg: '#01111d',
      contentBg: '#011627',
      textBar: '#1d3b53',
      inputBorder: '#1d3b53',
      accent: '#c792ea',
      accentSecondary: '#7fdbca',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    implemented: true,
    preview: {
      windowBg: '#fdf6e3',
      titleBarBg: '#eee8d5',
      contentBg: '#fdf6e3',
      textBar: '#e4dcc4',
      inputBorder: '#dcd3b5',
      accent: '#b58900',
      accentSecondary: '#b58900',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#002b36',
      titleBarBg: '#00212b',
      contentBg: '#002b36',
      textBar: '#0a4b5c',
      inputBorder: '#0a4b5c',
      accent: '#2aa198',
      accentSecondary: '#2aa198',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#2e3440',
      titleBarBg: '#2b303b',
      contentBg: '#2e3440',
      textBar: '#434c5e',
      inputBorder: '#3b4252',
      accent: '#88c0d0',
      accentSecondary: '#81a1c1',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#282828',
      titleBarBg: '#1d2021',
      contentBg: '#282828',
      textBar: '#504945',
      inputBorder: '#3c3836',
      accent: '#fe8019',
      accentSecondary: '#b8bb26',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#1a1b26',
      titleBarBg: '#16161e',
      contentBg: '#1a1b26',
      textBar: '#292e42',
      inputBorder: '#292e42',
      accent: '#7aa2f7',
      accentSecondary: '#bb9af7',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#1e1e2e',
      titleBarBg: '#181825',
      contentBg: '#1e1e2e',
      textBar: '#45475a',
      inputBorder: '#313244',
      accent: '#cba6f7',
      accentSecondary: '#f5c2e7',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#282c34',
      titleBarBg: '#21252b',
      contentBg: '#282c34',
      textBar: '#3e4451',
      inputBorder: '#3e4451',
      accent: '#61afef',
      accentSecondary: '#98c379',
    },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    mode: 'dark',
    implemented: true,
    preview: {
      windowBg: '#0d1117',
      titleBarBg: '#010409',
      contentBg: '#0d1117',
      textBar: '#30363d',
      inputBorder: '#30363d',
      accent: '#58a6ff',
      accentSecondary: '#3fb950',
    },
  },
];

export const DEFAULT_THEME_ID = 'dark';

// Usado pelos editores Monaco (HttpBodyEditor, CodeEditor, response-viewer,
// AppLayout) pra decidir entre a variante clara/escura do editor —
// Monaco não tem um tema pronto pra Dracula/Monokai/etc., então todo tema
// "dark" cai no vs-dark e todo "light" cai no vs (claro) como aproximação.
export function getThemeMode(themeId: string): ThemeMode {
  return THEMES.find(t => t.id === themeId)?.mode ?? 'dark';
}
