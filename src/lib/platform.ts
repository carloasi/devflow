// Só pra rotular atalhos de teclado certo na UI (Cmd no macOS, Ctrl em
// Windows/Linux) — monaco.KeyMod.CtrlCmd já mapeia isso automaticamente pro
// atalho de verdade, isso aqui é só o texto exibido em dicas/tooltips.
export const isMacPlatform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent ?? '');
