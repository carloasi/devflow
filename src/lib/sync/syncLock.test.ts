import { describe, expect, it } from 'vitest';
import { acquireSyncLock, holdsSyncLock, releaseSyncLock, syncLockHolder, withSyncLock } from './syncLock';

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
