import { describe, expect, it, vi } from 'vitest';
import {
  acquireSyncLock,
  acquireSyncLockQueued,
  holdsSyncLock,
  releaseSyncLock,
  syncLockHolder,
  syncQueueLength,
  withSyncLock,
} from './syncLock';

describe('sync lock', () => {
  it('one operation at a time: a pull cannot start during a push', async () => {
    const push = acquireSyncLock('push');
    expect(push).not.toBeNull();
    expect(acquireSyncLock('pull')).toBeNull();
    expect(syncLockHolder()).toBe('push');
    releaseSyncLock(push);
    const pull = acquireSyncLock('pull');
    expect(pull).not.toBeNull();
    releaseSyncLock(pull);
  });

  it('only the holder releases it', () => {
    const push = acquireSyncLock('push');
    releaseSyncLock('someone-else');
    expect(syncLockHolder()).toBe('push');
    releaseSyncLock(push);
    expect(syncLockHolder()).toBeNull();
  });

  it('a step inside the locked operation is recognized by the token', () => {
    const push = acquireSyncLock('push');
    expect(holdsSyncLock(push)).toBe(true);
    expect(holdsSyncLock('other')).toBe(false);
    expect(holdsSyncLock(undefined)).toBe(false);
    releaseSyncLock(push);
    expect(holdsSyncLock(push)).toBe(false);
  });

  it('withSyncLock releases even when the operation fails, and reports busy', async () => {
    await expect(
      withSyncLock('pull', async () => {
        expect(await withSyncLock('push', async () => 'ran')).toEqual({ busy: true });
        throw new Error('network');
      })
    ).rejects.toThrow('network');
    expect(syncLockHolder()).toBeNull();
    expect(await withSyncLock('push', async () => 'ran')).toEqual({ busy: false, value: 'ran' });
  });
});

describe('sync lock — queue', () => {
  it('free: takes it right away, without waiting', async () => {
    const onWait = vi.fn();
    const token = await acquireSyncLockQueued('push', { onWait });
    expect(token).not.toBeNull();
    expect(onWait).not.toHaveBeenCalled();
    releaseSyncLock(token);
  });

  it('a pull asked during a push waits and runs right after it, in order', async () => {
    const push = acquireSyncLock('push');
    const onWait = vi.fn();
    const order: string[] = [];
    const pull = acquireSyncLockQueued('pull', { onWait }).then(t => {
      order.push('pull');
      return t;
    });
    const receive = acquireSyncLockQueued('receive').then(t => {
      order.push('receive');
      return t;
    });
    expect(onWait).toHaveBeenCalledWith('push');
    expect(syncQueueLength()).toBe(2);

    releaseSyncLock(push);
    // O primeiro da fila já tem a trava, antes de qualquer outro código.
    expect(syncLockHolder()).toBe('pull');
    expect(acquireSyncLock('someone else')).toBeNull();
    const pullToken = await pull;
    releaseSyncLock(pullToken);
    const receiveToken = await receive;
    expect(order).toEqual(['pull', 'receive']);
    expect(syncLockHolder()).toBe('receive');
    releaseSyncLock(receiveToken);
    expect(syncLockHolder()).toBeNull();
  });

  it('a wait longer than the limit gives up (null) and leaves the queue', async () => {
    vi.useFakeTimers();
    try {
      const push = acquireSyncLock('push');
      const waiting = acquireSyncLockQueued('pull', { timeoutMs: 1000 });
      vi.advanceTimersByTime(1001);
      expect(await waiting).toBeNull();
      expect(syncQueueLength()).toBe(0);
      releaseSyncLock(push);
      expect(syncLockHolder()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

