import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-store', () => ({ LazyStore: class { get() { return null; } set() {} } }));

import { appendDecisions, type ConflictDecision } from './conflictHistory';

const entry = (item: string): ConflictDecision => ({ at: '2026-11-06T10:00:00Z', workspace: 'ws', item, choice: 'mine' });

describe('appendDecisions', () => {
  it('puts the newest first', () => {
    expect(appendDecisions([entry('old')], [entry('new')]).map(e => e.item)).toEqual(['new', 'old']);
  });

  it('keeps only the latest 300', () => {
    const many = Array.from({ length: 300 }, (_, i) => entry(`old ${i}`));
    const out = appendDecisions(many, [entry('new')]);
    expect(out).toHaveLength(300);
    expect(out[0].item).toBe('new');
    expect(out[299].item).toBe('old 298');
  });
});
