// O que foi salvo LOCALMENTE e ainda não foi enviado pro GitHub.
//
// Antes, salvar uma request (Ctrl+S / botão Save) gravava local E disparava um
// push silencioso — "salvo" e "enviado" eram a mesma coisa. Agora o Save é só
// local e o push é ação explícita, então esse estado intermediário existe e
// precisa ser rastreado: sem isso o app acharia que está tudo sincronizado e
// um Pull sobrescreveria trabalho local sem avisar.
//
// A granularidade é por COLLECTION, não por workspace. Guardar só "o workspace
// tem coisa pendente" responde se há o que enviar, mas não O QUE enviar — e é
// isso que um push seletivo precisa saber.
//
// Fica em localStorage (e não em memória) de propósito: se o app for fechado
// antes do push, o aviso continua valendo na próxima abertura.

const STORAGE_KEY = 'devflow_pending_push';
// Formato antigo: string[] de workspaces. Ainda lido na migração.
const LEGACY_KEY = 'devflow_pending_push_workspaces';

export interface PendingPush {
  /** Ids de collections raiz com alteração local. */
  collections: string[];
  /** Ids de environments com alteração local. */
  environments: string[];
  /**
   * Pendência que o push seletivo não consegue representar: uma collection
   * apagada localmente não tem mais id na árvore, então não há o que marcar —
   * só um push completo reconcilia o remoto. Também é o estado em que a
   * migração do formato antigo deixa tudo, já que lá não se sabia o quê.
   */
  requiresFullPush: boolean;
}

export type PendingPushMap = Record<string, PendingPush>;

export const EMPTY_PENDING: PendingPush = Object.freeze({
  collections: [],
  environments: [],
  requiresFullPush: false,
});

export type PendingKind = 'collections' | 'environments';

// ── Núcleo puro (testável sem localStorage) ──────────────────────────────

export function isPendingEmpty(pending: PendingPush | undefined): boolean {
  if (!pending) return true;
  return (
    !pending.requiresFullPush &&
    pending.collections.length === 0 &&
    pending.environments.length === 0
  );
}

export function addPending(
  pending: PendingPush | undefined,
  kind: PendingKind,
  ids: string[]
): PendingPush {
  const base = pending ?? EMPTY_PENDING;
  const wanted = ids.filter(Boolean);
  if (wanted.length === 0) return base;

  const merged = [...base[kind]];
  for (const id of wanted) {
    if (!merged.includes(id)) merged.push(id);
  }
  return { ...base, [kind]: merged };
}

export function removePending(
  pending: PendingPush | undefined,
  kind: PendingKind,
  ids: string[]
): PendingPush {
  const base = pending ?? EMPTY_PENDING;
  if (ids.length === 0) return base;
  const remaining = base[kind].filter(id => !ids.includes(id));
  return { ...base, [kind]: remaining };
}

/**
 * Lê o que está gravado, aceitando o formato antigo.
 *
 * A migração marca `requiresFullPush` em vez de descartar: o formato antigo
 * dizia "este workspace tem coisa pendente" sem dizer o quê, e tratar isso
 * como "nada pendente" perderia o aviso que já existia — justamente o que ele
 * existe pra evitar.
 */
export function parseStored(raw: string | null, legacyRaw: string | null): PendingPushMap {
  const fromNew = parseNew(raw);
  if (fromNew) return fromNew;
  return parseLegacy(legacyRaw);
}

function parseNew(raw: string | null): PendingPushMap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const out: PendingPushMap = {};
    for (const [workspace, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as Partial<PendingPush> | null;
      if (!v || typeof v !== 'object') continue;
      out[workspace] = {
        collections: toStringArray(v.collections),
        environments: toStringArray(v.environments),
        requiresFullPush: v.requiresFullPush === true,
      };
    }
    return out;
  } catch {
    return null;
  }
}

function parseLegacy(raw: string | null): PendingPushMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const out: PendingPushMap = {};
    for (const workspace of parsed) {
      if (typeof workspace !== 'string' || !workspace) continue;
      out[workspace] = { collections: [], environments: [], requiresFullPush: true };
    }
    return out;
  } catch {
    return {};
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ── Acesso ao localStorage ───────────────────────────────────────────────

function readAll(): PendingPushMap {
  try {
    return parseStored(localStorage.getItem(STORAGE_KEY), localStorage.getItem(LEGACY_KEY));
  } catch (e) {
    console.error('Erro ao ler pendências de push:', e);
    return {};
  }
}

function writeAll(map: PendingPushMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    // Só depois de gravar o formato novo: se a gravação falhar, o aviso antigo
    // continua valendo em vez de sumir.
    localStorage.removeItem(LEGACY_KEY);
  } catch (e) {
    console.error('Erro ao salvar pendências de push:', e);
  }
}

function mutate(workspace: string, fn: (pending: PendingPush) => PendingPush): void {
  if (!workspace) return;
  const all = readAll();
  const next = fn(all[workspace] ?? EMPTY_PENDING);
  if (isPendingEmpty(next)) {
    delete all[workspace];
  } else {
    all[workspace] = next;
  }
  writeAll(all);
}

export function readPendingPush(workspace: string): PendingPush {
  if (!workspace) return EMPTY_PENDING;
  return readAll()[workspace] ?? EMPTY_PENDING;
}

export function markCollectionsPendingPush(workspace: string, collectionIds: string[]): void {
  mutate(workspace, p => addPending(p, 'collections', collectionIds));
}

export function markEnvironmentsPendingPush(workspace: string, environmentIds: string[]): void {
  mutate(workspace, p => addPending(p, 'environments', environmentIds));
}

/** Apagou uma collection/environment: só um push completo reconcilia. */
export function markFullPushRequired(workspace: string): void {
  mutate(workspace, p => ({ ...p, requiresFullPush: true }));
}

export function clearCollectionsPendingPush(workspace: string, collectionIds: string[]): void {
  mutate(workspace, p => removePending(p, 'collections', collectionIds));
}

export function clearEnvironmentsPendingPush(workspace: string, environmentIds: string[]): void {
  mutate(workspace, p => removePending(p, 'environments', environmentIds));
}

/** Depois de um push completo ou de um pull (local == remoto de novo). */
export function clearWorkspacePendingPush(workspace: string): void {
  if (!workspace) return;
  const all = readAll();
  if (!(workspace in all)) return;
  delete all[workspace];
  writeAll(all);
}

export function isWorkspacePendingPush(workspace: string): boolean {
  return !isPendingEmpty(readPendingPush(workspace));
}
