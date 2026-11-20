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
//
// FILA: quem pede um push ou pull com outro rodando espera a vez
// (acquireSyncLockQueued) em vez de falhar com "outro sync está rodando" —
// em ordem de chegada, e cada um pega a trava no instante em que a anterior
// sai, sem ninguém passar na frente. O que depende do estado de AGORA
// (aplicar uma revisão, descartar, desfazer) continua recusando: rodar
// depois do push gravaria por cima do que ele acabou de registrar.
// ─────────────────────────────────────────────────────────────────────────

export const SYNC_BUSY_MESSAGE = 'Another sync (push or pull) is already running. Wait for it to finish.';

let holder: { token: string; what: string } | null = null;
let counter = 0;
/** Quem espera a vez, em ordem. Cada um pega a trava ao ser chamado. */
const waiters: Array<() => void> = [];

/** Espera máxima na fila: uma trava que nunca saísse não pode travar o app. */
export const SYNC_QUEUE_TIMEOUT_MS = 10 * 60_000;

/** Pega a trava. `null` = outra operação está rodando (ver syncLockHolder). */
export function acquireSyncLock(what: string): string | null {
  if (holder) return null;
  holder = { token: `${what}#${++counter}`, what };
  return holder.token;
}

/** Solta a trava — só quem a pegou (o token) solta. */
export function releaseSyncLock(token: string | null | undefined): void {
  if (!token || holder?.token !== token) return;
  holder = null;
  // O próximo da fila pega a trava agora, antes de qualquer outro código.
  waiters.shift()?.();
}

/**
 * Pega a trava, esperando a vez se outra operação estiver rodando. `onWait`
 * é chamado (com o que está rodando) só quando precisa esperar — pra dizer
 * "esperando o push terminar". `null` = a espera passou de `timeoutMs`.
 */
export function acquireSyncLockQueued(
  what: string,
  options: { onWait?: (running: string) => void; timeoutMs?: number } = {}
): Promise<string | null> {
  const now = acquireSyncLock(what);
  if (now) return Promise.resolve(now);
  options.onWait?.(holder?.what ?? 'sync');
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const turn = () => {
      if (timer) clearTimeout(timer);
      resolve(acquireSyncLock(what));
    };
    waiters.push(turn);
    timer = setTimeout(() => {
      const at = waiters.indexOf(turn);
      if (at >= 0) waiters.splice(at, 1);
      resolve(null);
    }, options.timeoutMs ?? SYNC_QUEUE_TIMEOUT_MS);
  });
}

/** Quantos esperam a vez (pros testes e pro aviso). */
export function syncQueueLength(): number {
  return waiters.length;
}

/** "Esperando o push terminar…" — o aviso de quem entrou na fila. */
export function syncWaitMessage(running: string): string {
  return `Waiting for the ${running} in progress to finish…`;
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
