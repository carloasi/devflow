import { describe, expect, it, vi } from 'vitest';

// Store em memória e LENTO: cada leitura/gravação leva um tempo, como o
// arquivo do Tauri — é aí que ler antes de a gravação terminar aparece.
vi.mock('@tauri-apps/plugin-store', () => {
  const data = new Map<string, unknown>();
  const later = <T,>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 5));
  return {
    LazyStore: class {
      get(key: string) {
        return later(data.get(key) ?? null);
      }
      set(key: string, value: unknown) {
        return later(undefined).then(() => void data.set(key, value));
      }
      delete(key: string) {
        return later(undefined).then(() => void data.delete(key));
      }
    },
  };
});

import { clearSyncBase, loadSyncBase, recordSyncBase } from './syncBase';

describe('sync base — reads wait for queued writes', () => {
  it('a read right after a write that was not awaited sees the write', async () => {
    void recordSyncBase('w1', { a: '1' });
    void recordSyncBase('w1', { b: '2' });
    expect(await loadSyncBase('w1')).toEqual({ a: '1', b: '2' });
  });

  it('a clear queued after a write is not undone by it', async () => {
    void recordSyncBase('w2', { a: '1' });
    void clearSyncBase('w2');
    expect(await loadSyncBase('w2')).toBeNull();
  });

  it('a write queued after a clear lands on an empty base', async () => {
    await recordSyncBase('w3', { old: '1' });
    void clearSyncBase('w3');
    void recordSyncBase('w3', { fresh: '1' });
    expect(await loadSyncBase('w3')).toEqual({ fresh: '1' });
  });

  it('another workspace is not held up', async () => {
    await recordSyncBase('w4', { a: '1' });
    expect(await loadSyncBase('w4')).toEqual({ a: '1' });
    expect(await loadSyncBase('w5')).toBeNull();
  });
});
