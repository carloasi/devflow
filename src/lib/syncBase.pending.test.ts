import { describe, it, expect, vi } from 'vitest';
vi.mock('@tauri-apps/plugin-store', () => ({ LazyStore: class {} }));
import { nodeHashes, pendingChanges } from './syncBase';
import type { CollectionItem } from '@/app/types/CollectionItem';

const col = (): CollectionItem => ({
  id: 'col', name: 'Col', type: 'folder',
  item: [
    { id: 'r1', name: 'R1', type: 'request', method: 'GET' },
    { id: 'r2', name: 'R2', type: 'request', method: 'GET' },
  ],
}) as CollectionItem;

describe('pendingChanges', () => {
  it('nada mudou: lista vazia', () => {
    const base = nodeHashes([col()]);
    expect(pendingChanges(base, col())).toEqual({ changed: [], deleted: 0 });
  });

  it('renomear marca só o item', () => {
    const base = nodeHashes([col()]);
    const now = col();
    now.item![0] = { ...now.item![0], name: 'Outro' };
    expect(pendingChanges(base, now)).toEqual({ changed: ['r1'], deleted: 0 });
  });

  it('criado conta como mudado; apagado conta à parte', () => {
    const base = nodeHashes([col()]);
    const now = col();
    now.item = [now.item![0], { id: 'r3', name: 'R3', type: 'request' } as CollectionItem];
    const result = pendingChanges(base, now)!;
    expect(result.changed).toEqual(expect.arrayContaining(['col', 'r3']));
    expect(result.deleted).toBe(1);
  });

  it('sem base: null', () => {
    expect(pendingChanges(null, col())).toBeNull();
  });
});
