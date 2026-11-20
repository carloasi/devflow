import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import { diffEnvironments } from '@/lib/environmentDiff';
import { withoutSessionTokens } from '@/lib/jwt';
import { compareWorkspaces } from '@/lib/remoteComparison';

// ─────────────────────────────────────────────────────────────────────────
// As decisões do estado de sync de um workspace que antes moravam dentro do
// AppLayout e do GitHubSync, sem teste: Desfazer, Descartar, apagar e
// renomear a pasta no GitHub. Funções puras — quem chama aplica o resultado
// (grava, marca pendência, mostra o aviso).
// ─────────────────────────────────────────────────────────────────────────

/** Por quanto tempo o Desfazer de um pull vale. */
export const UNDO_WINDOW_MS = 10 * 60_000;

export interface UndoSnapshotInfo {
  workspace: string;
  /** Quando o snapshot foi tirado. */
  at: number;
}

export type UndoDecision =
  /** Sem snapshot e nada a dizer. */
  | { kind: 'nothing' }
  /** Um push depois do pull anulou o Desfazer. */
  | { kind: 'voided' }
  /** Passou do prazo, ou o workspace aberto é outro. */
  | { kind: 'expired' }
  /** Houve edição depois do pull: perguntar antes (ela seria descartada). */
  | { kind: 'confirmEdits' }
  | { kind: 'run' };

/**
 * O que o Desfazer de um pull deve fazer agora. `lastLocalEdit`: a última
 * edição local de verdade; `force`: a pessoa já confirmou descartar as
 * edições feitas depois do pull.
 */
export function undoDecision(input: {
  snapshot: UndoSnapshotInfo | null;
  voidedByPush: boolean;
  now: number;
  currentWorkspace: string;
  lastLocalEdit: number;
  force: boolean;
}): UndoDecision {
  const { snapshot } = input;
  if (!snapshot) return input.voidedByPush ? { kind: 'voided' } : { kind: 'nothing' };
  if (input.now - snapshot.at > UNDO_WINDOW_MS || snapshot.workspace !== input.currentWorkspace) return { kind: 'expired' };
  if (!input.force && input.lastLocalEdit > snapshot.at) return { kind: 'confirmEdits' };
  return { kind: 'run' };
}

/**
 * Um push que deu certo anula o Desfazer do pull DESTE workspace: voltar ao
 * de antes do pull deixaria a base de antes, com o GitHub já tendo o que
 * veio e o que subiu — o sync seguinte traria tudo de volta.
 */
export function pushVoidsUndo(snapshot: UndoSnapshotInfo | null, pushedWorkspace: string): boolean {
  return !!snapshot && snapshot.workspace === pushedWorkspace;
}

/**
 * Esquecer a base mantendo o daqui (a pasta no GitHub foi apagada, ou o
 * renomear não a moveu): os ids a marcar como "para enviar", pro próximo
 * push recriar o workspace inteiro lá.
 */
export function pendingIdsToKeepLocal(
  collections: unknown,
  environments: unknown
): { collectionIds: string[]; environmentIds: string[] } {
  const idsOf = (list: unknown) =>
    (Array.isArray(list) ? (list as { id?: unknown }[]) : [])
      .map(x => x?.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
  return { collectionIds: idsOf(collections), environmentIds: idsOf(environments) };
}

/**
 * Apagada a pasta de um workspace no GitHub: os arquivos dele que saem do
 * registro de sincronizados (null = não existe mais lá). `remotePath` sem a
 * barra final; a barra no prefixo evita pegar "W2" ao apagar "W".
 */
export function syncedPathsToForget(synced: Record<string, string>, remotePath: string): Record<string, null> {
  const prefix = `${remotePath.replace(/\/+$/, '')}/`;
  const out: Record<string, null> = {};
  for (const path of Object.keys(synced)) if (path.startsWith(prefix)) out[path] = null;
  return out;
}

export type RemoteRenameOutcome = 'renamed' | 'nothing' | 'failed';

/**
 * Por que a pasta no GitHub não foi renomeada — `null` = foi (ou não havia o
 * que mover). Com motivo, o nome novo esquece a base (pendingIdsToKeepLocal)
 * e a pessoa é avisada.
 */
export function remoteRenameFailure(outcome: RemoteRenameOutcome | undefined, error?: unknown): string | null {
  if (error !== undefined) return error instanceof Error ? error.message : String(error);
  if (outcome === 'failed') return 'Outro sync estava rodando, ou falta a senha de sincronização.';
  return null;
}

export type PendingChange = 'mark' | 'clear' | 'keep';

/**
 * Depois de Descartar um item: a collection dele ainda tem algo a enviar?
 * `mark` = sim; `clear` = ficou igual ao GitHub (ou sumiu dos dois lados);
 * `keep` = não dá pra dizer (só existe de um lado), a pendência fica.
 */
export function pendingAfterDiscard(
  tree: CollectionItem[],
  remoteTree: CollectionItem[],
  rootId: string | undefined
): PendingChange {
  if (!rootId) return 'keep';
  const mine = tree.find(c => c.id === rootId);
  const theirs = remoteTree.find(c => c.id === rootId);
  if (mine && theirs) {
    const still = compareWorkspaces([mine], [theirs]);
    return still.modified.length + still.onlyLocal.length > 0 ? 'mark' : 'clear';
  }
  if (!mine && !theirs) return 'clear';
  return 'keep';
}

/**
 * O mesmo pra um environment descartado: ainda difere do GitHub? Tokens de
 * sessão não contam (não sobem, lib/jwt).
 */
export function envPendingAfterDiscard(env: Environment, theirs: Environment | undefined): 'mark' | 'clear' {
  if (!theirs) return 'mark';
  return diffEnvironments(withoutSessionTokens([env]), withoutSessionTokens([theirs])).length > 0 ? 'mark' : 'clear';
}
