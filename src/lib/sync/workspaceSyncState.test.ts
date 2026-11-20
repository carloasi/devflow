import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import {
  envPendingAfterDiscard,
  pendingAfterDiscard,
  pendingIdsToKeepLocal,
  pushVoidsUndo,
  remoteRenameFailure,
  syncedPathsToForget,
  UNDO_WINDOW_MS,
  undoDecision,
} from './workspaceSyncState';

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});
const col = (id: string, children: CollectionItem[]): CollectionItem => ({ id, name: id, type: 'folder', item: children });
const env = (vars: Record<string, string>, id = 'e1'): Environment => ({
  id,
  name: id,
  values: Object.entries(vars).map(([key, value]) => ({ key, value, enabled: true, type: 'default' })),
});

describe('undoDecision (T, U)', () => {
  const snapshot = { workspace: 'W', at: 1_000 };
  const base = { snapshot, voidedByPush: false, now: 2_000, currentWorkspace: 'W', lastLocalEdit: 0, force: false };

  it('runs within the window, in the same workspace, with no edit after the pull', () => {
    expect(undoDecision(base)).toEqual({ kind: 'run' });
  });

  it('after a push voided it, says so instead of doing nothing silently', () => {
    expect(undoDecision({ ...base, snapshot: null, voidedByPush: true })).toEqual({ kind: 'voided' });
    expect(undoDecision({ ...base, snapshot: null })).toEqual({ kind: 'nothing' });
  });

  it('expires after the window or in another workspace', () => {
    expect(undoDecision({ ...base, now: snapshot.at + UNDO_WINDOW_MS + 1 })).toEqual({ kind: 'expired' });
    expect(undoDecision({ ...base, currentWorkspace: 'Other' })).toEqual({ kind: 'expired' });
  });

  it('asks before discarding edits made after the pull, unless confirmed', () => {
    expect(undoDecision({ ...base, lastLocalEdit: 1_500 })).toEqual({ kind: 'confirmEdits' });
    expect(undoDecision({ ...base, lastLocalEdit: 1_500, force: true })).toEqual({ kind: 'run' });
  });

  it('a push voids the undo of the same workspace only', () => {
    expect(pushVoidsUndo(snapshot, 'W')).toBe(true);
    expect(pushVoidsUndo(snapshot, 'Other')).toBe(false);
    expect(pushVoidsUndo(null, 'W')).toBe(false);
  });
});

describe('keeping the workspace here when its GitHub folder is gone (X, Z)', () => {
  it('marks every collection and environment as pending', () => {
    expect(pendingIdsToKeepLocal([col('c1', []), col('c2', [])], [env({}, 'e1')])).toEqual({
      collectionIds: ['c1', 'c2'],
      environmentIds: ['e1'],
    });
  });

  it('tolerates missing data and items without id', () => {
    expect(pendingIdsToKeepLocal(undefined, null)).toEqual({ collectionIds: [], environmentIds: [] });
    expect(pendingIdsToKeepLocal([{ name: 'no id' }, null], [{ id: '' }])).toEqual({ collectionIds: [], environmentIds: [] });
  });
});

describe('syncedPathsToForget (Y)', () => {
  it('forgets only the deleted workspace — not one whose name starts the same', () => {
    const synced = {
      'Postman/W/a.postman_collection.json': 's1',
      'Postman/W/environments/dev.postman_environment.json': 's2',
      'Postman/W2/b.postman_collection.json': 's3',
    };
    expect(syncedPathsToForget(synced, 'Postman/W')).toEqual({
      'Postman/W/a.postman_collection.json': null,
      'Postman/W/environments/dev.postman_environment.json': null,
    });
    expect(syncedPathsToForget(synced, 'Postman/W/')).toEqual(syncedPathsToForget(synced, 'Postman/W'));
  });
});

describe('remoteRenameFailure (Z)', () => {
  it('renamed or nothing to move: no failure', () => {
    expect(remoteRenameFailure('renamed')).toBeNull();
    expect(remoteRenameFailure('nothing')).toBeNull();
    expect(remoteRenameFailure(undefined)).toBeNull();
  });

  it('the silent cases (busy, no passphrase) are a failure too', () => {
    expect(remoteRenameFailure('failed')).toMatch(/sync/);
  });

  it('an error gives its message', () => {
    expect(remoteRenameFailure(undefined, new Error('A workspace named "X" already exists'))).toBe('A workspace named "X" already exists');
    expect(remoteRenameFailure(undefined, 'boom')).toBe('boom');
  });
});

describe('pending after Discard (AA)', () => {
  const remote = [col('c1', [req('a', 'theirs'), req('b')])];

  it('the collection is equal to GitHub again: clear', () => {
    expect(pendingAfterDiscard([col('c1', [req('a', 'theirs'), req('b')])], remote, 'c1')).toBe('clear');
  });

  it('something else in it still differs: mark', () => {
    expect(pendingAfterDiscard([col('c1', [req('a', 'theirs'), req('b', 'mine')])], remote, 'c1')).toBe('mark');
  });

  it('gone from both sides: clear; only on one side: keep', () => {
    expect(pendingAfterDiscard([], [], 'c1')).toBe('clear');
    expect(pendingAfterDiscard([col('c1', [])], [], 'c1')).toBe('keep');
    expect(pendingAfterDiscard([], remote, undefined)).toBe('keep');
  });

  it('an environment still different from GitHub stays pending', () => {
    expect(envPendingAfterDiscard(env({ url: 'u' }), env({ url: 'u' }))).toBe('clear');
    expect(envPendingAfterDiscard(env({ url: 'mine' }), env({ url: 'u' }))).toBe('mark');
    expect(envPendingAfterDiscard(env({ url: 'u' }), undefined)).toBe('mark');
  });
});
