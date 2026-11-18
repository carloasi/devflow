// ─────────────────────────────────────────────────────────────────────────
// Fila das ferramentas do MCP que mexem na árvore.
//
// Cada ferramenta lê a árvore do contexto (o estado do React na hora da
// chamada) e grava um nó inteiro calculado a partir dela. Duas escritas ao
// mesmo tempo na mesma request — set_request_script e update_request, por
// exemplo — liam a mesma árvore velha, e a segunda apagava o que a primeira
// gravou. O mesmo valia pra uma escrita logo depois da outra, antes de o
// React re-renderizar: a segunda ainda via a árvore de antes.
//
// Aqui as escritas rodam uma de cada vez, e cada uma só termina (e só libera
// a próxima) depois que a árvore do contexto mudou de verdade — ou seja,
// depois que o React aplicou a escrita. Leituras não entram na fila.
// ─────────────────────────────────────────────────────────────────────────

/** Ferramentas que gravam na árvore de collections. */
export const TREE_WRITE_TOOLS = new Set([
  'create_folder',
  'create_request',
  'duplicate_request',
  'create_flow',
  'create_flow_from_recipe',
  'set_request_script',
  'update_request',
  'rename_item',
  'move_item',
  'delete_item',
]);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForChange(read: () => unknown, before: unknown, timeoutMs: number, pollMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (read() === before && Date.now() < deadline) await sleep(pollMs);
}

/**
 * `readTree` devolve a árvore atual (por identidade: o React troca o array a
 * cada escrita). Uma escrita que não mudou nada (ex. `ok: false`, ou o mesmo
 * nome no rename) espera no máximo `timeoutMs`.
 */
export function createWriteQueue(readTree: () => unknown, options: { timeoutMs?: number; pollMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 800;
  const pollMs = options.pollMs ?? 10;
  let chain: Promise<unknown> = Promise.resolve();

  return function run<T>(write: () => Promise<T>): Promise<T> {
    const task = chain.then(async () => {
      const before = readTree();
      const result = await write();
      const changedNothing = (result as { ok?: unknown } | null)?.ok === false;
      if (!changedNothing) await waitForChange(readTree, before, timeoutMs, pollMs);
      return result;
    });
    // Uma escrita que falhou não trava as seguintes.
    chain = task.catch(() => undefined);
    return task;
  };
}
