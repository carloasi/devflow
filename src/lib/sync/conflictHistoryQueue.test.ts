import { describe, expect, it, vi } from 'vitest';

// Store em memória com espera, pra duas gravações se cruzarem como no app.
vi.mock('@tauri-apps/plugin-store', () => {
  let saved: unknown = null;
  const later = <T,>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 5));
  return {
    LazyStore: class {
      get() {
        return later(saved);
      }
      async set(_key: string, value: unknown) {
        await later(null);
        saved = value;
      }
    },
  };
});

import { loadConflictHistory, recordConflictDecisions, type ConflictDecision } from './conflictHistory';

const entry = (item: string): ConflictDecision => ({ at: '2026-11-13T10:00:00Z', workspace: 'ws', item, choice: 'mine' });

describe('recordConflictDecisions', () => {
  it('duas gravações seguidas não perdem decisões', async () => {
    // Sem a fila, a segunda lia o histórico antes de a primeira gravar.
    void recordConflictDecisions([entry('primeira')]);
    await recordConflictDecisions([entry('segunda')]);
    expect((await loadConflictHistory()).map(e => e.item).sort()).toEqual(['primeira', 'segunda']);
  });
});
