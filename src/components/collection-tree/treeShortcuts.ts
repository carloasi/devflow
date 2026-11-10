// ─────────────────────────────────────────────────────────────────────────
// Atalhos de teclado da árvore de collections.
//
// Uma tabela só, lida pelos dois lados: o menu "…" (TreeActionMenu) mostra a
// tecla ao lado de cada ação, e a árvore (CollectionTree.handleTreeKeyDown)
// executa. Sem isto, o rótulo e o comportamento divergiam na primeira
// mudança de um dos dois.
//
// Valem com a árvore em foco e uma linha selecionada pelo teclado — fora
// dela, letras soltas continuam sendo só letras.
// ─────────────────────────────────────────────────────────────────────────

export type TreeShortcut =
  | 'favorite'
  | 'run'
  | 'addRequest'
  | 'addFolder'
  | 'rename'
  | 'markers'
  | 'description'
  | 'duplicate'
  | 'delete'
  | 'menu';

interface Combo {
  /** `KeyboardEvent.key` em minúsculas (letras) ou o nome da tecla (F2, Delete). */
  key: string;
  shift?: boolean;
  /** Ctrl no Windows/Linux, ⌘ no macOS. */
  mod?: boolean;
}

export const TREE_SHORTCUTS: Record<TreeShortcut, Combo> = {
  favorite: { key: 'f' },
  run: { key: 'r' },
  addRequest: { key: 'n' },
  addFolder: { key: 'n', shift: true },
  rename: { key: 'F2' },
  markers: { key: 'm' },
  description: { key: 'm', shift: true },
  duplicate: { key: 'd', mod: true },
  delete: { key: 'Delete' },
  menu: { key: 'F10', shift: true },
};

const KEY_LABEL: Record<string, string> = { Delete: 'Del' };

/** Rótulo da tecla pro menu: "Ctrl+D" / "⌘D", "Shift+N" / "⇧N", "F2", "Del". */
export function shortcutLabel(shortcut: TreeShortcut, isMac: boolean): string {
  const { key, shift, mod } = TREE_SHORTCUTS[shortcut];
  const name = KEY_LABEL[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (isMac) return `${mod ? '⌘' : ''}${shift ? '⇧' : ''}${name}`;
  return [mod && 'Ctrl', shift && 'Shift', name].filter(Boolean).join('+');
}

interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** Qual atalho a tecla pressionada aciona (ou null). Alt nunca entra: é do sistema. */
export function shortcutFor(e: KeyLike): TreeShortcut | null {
  if (e.altKey) return null;
  const pressed = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = e.ctrlKey || e.metaKey;
  for (const [name, combo] of Object.entries(TREE_SHORTCUTS) as [TreeShortcut, Combo][]) {
    if (combo.key === pressed && !!combo.shift === e.shiftKey && !!combo.mod === mod) return name;
  }
  // A tecla de menu do teclado (ao lado do Ctrl direito) faz o mesmo que Shift+F10.
  if (e.key === 'ContextMenu' && !mod) return 'menu';
  return null;
}
