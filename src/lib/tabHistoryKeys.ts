// Quais chaves de um update de Tab contam pro histórico de undo/redo
// (Ctrl+Z fora do Monaco) em AppLayout.tsx.
//
// requestBodyValue e scripts ficam de fora: só são editados dentro do
// Monaco (Body raw/GraphQL, Pre-request/Post-response), que já tem seu
// próprio undo/redo nativo. Contar essas duas aqui também criava dois
// históricos brigando pelo mesmo conteúdo — o onChange do Monaco dispara
// pra CADA mudança de valor, inclusive quando a mudança é o PRÓPRIO Ctrl+Z
// do Monaco desfazendo algo, então cada undo nativo empurrava um passo
// NOVO neste histórico (em vez de encolher nada) e zerava o redoStack da
// aba inteira. Resultado: um Ctrl+Z fora do editor (na URL, por exemplo)
// podia trazer de volta um texto que o Monaco tinha acabado de desfazer, e
// qualquer redo pendente de outro campo sumia só por ter digitado no body
// no meio do caminho.
export const HISTORY_IGNORED_KEYS = new Set([
  'response', 'responseTime', 'testResults', 'activeRequestTab', 'isDirty',
  'requestBodyValue', 'scripts',
]);

export function getHistoryKeys(updates: Record<string, unknown>): string[] {
  return Object.keys(updates).filter(k => !HISTORY_IGNORED_KEYS.has(k));
}
