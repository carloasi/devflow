// ─────────────────────────────────────────────────────────────────────────
// Uma operação de sync por vez — push, pull, receber um item, restaurar um
// commit, renomear ou apagar o workspace no GitHub.
//
// A trava cobria só as GRAVAÇÕES no GitHub (dentro do GitHubSync). Um pull
// podia rodar no meio de um push: o push mesclava e aplicava aqui a árvore
// que leu antes, o pull aplicava a dele — o que chegasse por último
// sobrescrevia o outro, e a base da sincronização ficava de um sem a árvore
// do outro (o próximo sync lia como mudança sua o que tinha vindo de lá).
//
// Módulo, e não estado de componente: o AppLayout (push, pull com revisão,
// receber um item) e o GitHubSync (pull de todos, restaurar commit, rename,
// exclusão) precisam da MESMA trava, e ela vale na hora, sem esperar render.
//
// Quem pega a trava recebe um token. Uma etapa que roda DENTRO de uma
// operação já travada (a gravação do push, chamada pelo próprio push)
// recebe o token e segue — sem isso ela esbarraria na trava do próprio push.
// ─────────────────────────────────────────────────────────────────────────

export const SYNC_BUSY_MESSAGE = 'Another sync (push or pull) is already running. Wait for it to finish.';

let holder: { token: string; what: string } | null = null;
let counter = 0;

/** Pega a trava. `null` = outra operação está rodando (ver syncLockHolder). */
export function acquireSyncLock(what: string): string | null {
  if (holder) return null;
  holder = { token: `${what}#${++counter}`, what };
  return holder.token;
}

/** Solta a trava — só quem a pegou (o token) solta. */
export function releaseSyncLock(token: string | null | undefined): void {
  if (token && holder?.token === token) holder = null;
}

/** O token vale pra trava de agora? (a etapa de dentro de uma operação já travada) */
export function holdsSyncLock(token: string | null | undefined): boolean {
  return !!token && holder?.token === token;
}

/** O que está rodando agora (`null` = nada). */
export function syncLockHolder(): string | null {
  return holder?.what ?? null;
}

/**
 * Roda `run` com a trava. Ocupada: não roda e devolve `{ busy: true }`.
 * A trava sai mesmo se `run` falhar.
 */
export async function withSyncLock<T>(
  what: string,
  run: (token: string) => Promise<T>
): Promise<{ busy: true } | { busy: false; value: T }> {
  const token = acquireSyncLock(what);
  if (!token) return { busy: true };
  try {
    return { busy: false, value: await run(token) };
  } finally {
    releaseSyncLock(token);
  }
}
