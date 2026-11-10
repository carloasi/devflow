// ─────────────────────────────────────────────────────────────────────────
// Separa o texto que o sandbox Rust devolve (ver execute_script_backend em
// src-tauri/src/lib.rs) em "summary" — uma linha, pronta pra tela — e
// "detail" — o texto completo, com o stack trace quando houver.
//
// O formato vem de lá:
//   "❌ <NomeDoErro>: <mensagem>\n📜 Stack Trace:\n<pilha>"   — throw de um Error
//   "❌ Thrown value: <texto>"                                 — throw de outra coisa
//
// O parser não depende de mais nada do formato além dessas duas âncoras —
// tolerante ao Rust mudar a palavra do nome do erro, só não a sair do
// padrão "primeira linha = resumo". Se o Rust mudar de vez, o pior caso é
// a primeira linha inteira virar o resumo, nunca um "undefined" na tela.
// ─────────────────────────────────────────────────────────────────────────

const STACK_MARKER = '\n📜 Stack Trace:\n';

export function parseScriptError(raw: string): { summary: string; detail: string } {
  const detail = raw.trim();
  if (!detail) return { summary: 'Script error', detail: 'Script error' };

  const stackIdx = detail.indexOf(STACK_MARKER);
  const firstLine = (stackIdx === -1 ? detail : detail.slice(0, stackIdx))
    .replace(/^❌\s*/, '')
    .trim();

  return {
    summary: firstLine || 'Script error',
    detail,
  };
}
