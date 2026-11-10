import { LazyStore } from '@tauri-apps/plugin-store';

// ─────────────────────────────────────────────────────────────────────────
// Versão de cada arquivo remoto na ÚLTIMA sincronização desta máquina.
//
// É o que responde "tem coisa nova no GitHub?" sem baixar nada: a listagem
// da pasta do workspace já traz o sha de cada arquivo, e basta comparar com
// o sha que estava lá quando este app sincronizou pela última vez. Um arquivo
// com sha diferente (ou que apareceu, ou que sumiu) foi mexido por outra
// pessoa desde então.
//
// "Sincronizou" = o conteúdo daqui e o de lá passaram a ser o mesmo, ou a
// pessoa viu a diferença e decidiu:
//   • push que gravou o arquivo;
//   • pull que o baixou e aplicou;
//   • revisão aplicada (o que foi recusado vira pendência de push, não
//     "novidade no GitHub" — a pessoa já viu).
//
// Uma checagem que só OLHA (sem aplicar) não conta: senão o contador
// zeraria sem nada ter chegado aqui.
//
// Chave por repositório + branch: o mesmo path em outro repo é outro arquivo.
// ─────────────────────────────────────────────────────────────────────────

/** path → sha do blob. */
export type FileShas = Record<string, string>;

/** `null` = o arquivo deixou de existir (apagado no push, ou sumiu no pull). */
export type ShaChanges = Record<string, string | null>;

export function repoKeyOf(config: { owner: string; repo: string; branch: string }): string {
  return `${config.owner}/${config.repo}@${config.branch}`;
}

// ── Núcleo puro ──────────────────────────────────────────────────────────

export function applyShaChanges(current: FileShas, changes: ShaChanges): FileShas {
  const next = { ...current };
  for (const [path, sha] of Object.entries(changes)) {
    if (sha) next[path] = sha;
    else delete next[path];
  }
  return next;
}

/**
 * Quantos arquivos mudaram no GitHub desde a última sincronização.
 *
 * `null` quando esta máquina nunca sincronizou nada nesse escopo — não dá
 * pra dizer "está em dia" sem uma referência, e dizer "tudo mudou" seria
 * falso para quem acabou de atualizar o app.
 *
 * `tracked` restringe aos arquivos que a listagem conhece (collections e
 * environments): o catálogo de marcadores, por exemplo, é gravado mas não é
 * listado, e contaria sempre como "sumiu de lá".
 */
export function countBehind(
  remote: FileShas,
  synced: FileShas,
  prefix: string,
  tracked: (path: string) => boolean = () => true
): number | null {
  const inScope = (path: string) => path.startsWith(prefix) && tracked(path);
  const syncedPaths = Object.keys(synced).filter(inScope);
  if (syncedPaths.length === 0) return null;

  let behind = 0;
  for (const [path, sha] of Object.entries(remote)) {
    if (inScope(path) && synced[path] !== sha) behind++; // mudou ou apareceu lá
  }
  for (const path of syncedPaths) {
    if (!(path in remote)) behind++; // apagado lá
  }
  return behind;
}

/**
 * QUAIS arquivos mudaram no GitHub desde a última sincronização — a mesma
 * conta do countBehind, com os paths, pro aviso em segundo plano dizer o
 * quê. Vazio quando esta máquina nunca sincronizou nada nesse escopo.
 */
export function behindPaths(
  remote: FileShas,
  synced: FileShas,
  prefix: string,
  tracked: (path: string) => boolean = () => true
): { changed: string[]; added: string[]; deleted: string[] } {
  const out = { changed: [] as string[], added: [] as string[], deleted: [] as string[] };
  const inScope = (path: string) => path.startsWith(prefix) && tracked(path);
  const syncedPaths = Object.keys(synced).filter(inScope);
  if (syncedPaths.length === 0) return out;

  for (const [path, sha] of Object.entries(remote)) {
    if (!inScope(path) || synced[path] === sha) continue;
    if (path in synced) out.changed.push(path);
    else out.added.push(path);
  }
  for (const path of syncedPaths) {
    if (!(path in remote)) out.deleted.push(path);
  }
  return out;
}

/**
 * Mudanças para registrar um workspace inteiro como sincronizado: grava os
 * shas vistos e esquece os paths do mesmo escopo que não vieram — esses
 * foram apagados lá, e a exclusão também já chegou aqui.
 */
export function workspaceShaChanges(
  seen: FileShas,
  synced: FileShas,
  inScope: (path: string) => boolean
): ShaChanges {
  const changes: ShaChanges = { ...seen };
  for (const path of Object.keys(synced)) {
    if (inScope(path) && !(path in seen)) changes[path] = null;
  }
  return changes;
}

// ── Persistência ─────────────────────────────────────────────────────────

const store = new LazyStore('sync-remote-versions.json', { autoSave: 300 });
const cache = new Map<string, FileShas>();

/**
 * `remoteToo`: o sha registrado também é o que está no GitHub AGORA (push,
 * pull do topo da branch, revisão). Falso ao restaurar um commit antigo — aí
 * o local fica numa versão velha, e o remoto continua o que era.
 */
export type ShaListener = (repoKey: string, changes: ShaChanges, remoteToo: boolean) => void;
const listeners = new Set<ShaListener>();

export async function loadSyncedShas(repoKey: string): Promise<FileShas> {
  const cached = cache.get(repoKey);
  if (cached) return cached;
  let loaded: FileShas = {};
  try {
    const stored = await store.get<FileShas>(repoKey);
    if (stored && typeof stored === 'object') loaded = { ...stored };
  } catch (e) {
    console.log('Could not read the remote versions:', e);
  }
  // Outra chamada pode ter preenchido o cache enquanto esta esperava.
  if (!cache.has(repoKey)) cache.set(repoKey, loaded);
  return cache.get(repoKey)!;
}

export async function recordSyncedShas(
  repoKey: string,
  changes: ShaChanges,
  options: { remoteToo?: boolean } = {}
): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  await loadSyncedShas(repoKey);
  // Lido DEPOIS do await e aplicado sem novo await: duas gravações seguidas
  // (push de vários arquivos) não podem partir do mesmo estado e uma apagar
  // a outra.
  const next = applyShaChanges(cache.get(repoKey) ?? {}, changes);
  cache.set(repoKey, next);
  for (const listener of listeners) listener(repoKey, changes, options.remoteToo ?? true);
  try {
    await store.set(repoKey, next);
  } catch (e) {
    // Perder isto só faz o contador errar até a próxima sincronização.
    console.log('Could not record the remote versions:', e);
  }
}

export function subscribeSyncedShas(listener: ShaListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
