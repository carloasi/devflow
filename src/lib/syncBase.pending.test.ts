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
    // A collection não conta à parte: a mudança dela é o r3 entrar e o r2 sair.
    expect(result.changed).toEqual(['r3']);
    expect(result.deleted).toBe(1);
  });

  it('sem base: null', () => {
    expect(pendingChanges(null, col())).toBeNull();
  });
});

describe('pendingChanges: contagem honesta', () => {
  const tree = (): CollectionItem => ({
    id: 'col', name: 'Col', type: 'folder',
    item: [
      { id: 'f1', name: 'F1', type: 'folder', item: [{ id: 'r1', name: 'R1', type: 'request' }] },
      { id: 'f2', name: 'F2', type: 'folder', item: [{ id: 'r2', name: 'R2', type: 'request' }] },
    ],
  }) as CollectionItem;

  it('mover um item conta 1, não 3 (item + as duas pastas)', () => {
    const base = nodeHashes([tree()]);
    const now = tree();
    const r1 = now.item![0].item!.pop()!;
    now.item![1].item!.push(r1);
    expect(pendingChanges(base, now)!.changed).toEqual(['r1']);
  });

  it('reordenar irmãos conta a pasta', () => {
    const base = nodeHashes([tree()]);
    const now = tree();
    now.item!.reverse();
    expect(pendingChanges(base, now)!.changed).toEqual(['col']);
  });

  it('apagar uma pasta com conteúdo conta 1', () => {
    const base = nodeHashes([tree()]);
    const now = tree();
    now.item!.shift();
    expect(pendingChanges(base, now)).toEqual({ changed: [], deleted: 1 });
  });
});
