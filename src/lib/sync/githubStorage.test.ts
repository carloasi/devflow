import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// commitFiles contra um GitHub de mentira (em memória): é o caminho que grava
// tudo no repositório e não tinha teste nenhum. Cobre o que já quebrou: a
// checagem de versão (conflito sem gravar nada), o retry quando alguém
// envia no meio, branch com "/", repositório vazio e branch inexistente.
// ─────────────────────────────────────────────────────────────────────────

const http = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: http.fetch }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private data = new Map<string, unknown>();
    async get(key: string) {
      return this.data.get(key);
    }
    async set(key: string, value: unknown) {
      this.data.set(key, value);
    }
  },
}));
// Sem criptografia de verdade (PBKDF2 é lento e não é o que está em teste).
vi.mock('@/lib/syncCrypto', () => ({
  encryptData: async (data: unknown) => JSON.stringify(data),
  decryptData: async (text: string) => JSON.parse(text),
}));

// O nome do autor do commit vem do usuário do Windows guardado aqui.
// O resto (versões vistas) é um storage de verdade, em memória.
const storage = new Map<string, string>([['app_win_username', 'tester']]);
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
});

import {
  clearContentCache,
  clearRequestCache,
  GitHubRateLimitError,
  GitHubStorageClient,
  requestTiming,
  SEEN_SHAS_MAX_ENTRIES,
  SEEN_SHAS_STORAGE_KEY,
  seenShas,
} from './githubStorage';

import { FakeGitHub, res } from './testing/fakeGitHub';

let BRANCH = 'main';
let gh: FakeGitHub;
const client = (options: { force?: boolean } = {}) =>
  new GitHubStorageClient({ token: 't', owner: 'o', repo: 'r', branch: BRANCH }, 'pass', options);

beforeEach(() => {
  clearRequestCache();
  clearContentCache(); // os shas do GitHub de mentira se repetem entre testes
  requestTiming.sleep = vi.fn(async () => undefined);
  BRANCH = `main-${Math.random().toString(36).slice(2)}`; // "visto" é global por branch
  gh = new FakeGitHub(() => BRANCH);
  http.fetch.mockReset();
  http.fetch.mockImplementation((url: string, init: { method?: string; body?: string }) => gh.handle(url, init));
});

describe('commitFiles', () => {
  it('writes every file in ONE commit', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const c = client();
    await c.getFile('Postman/W/a.json');
    const before = gh.head;
    const result = await c.commitFiles(
      [
        { path: 'Postman/W/a.json', content: 'a1' },
        { path: 'Postman/W/b.json', content: 'b1' },
      ],
      'push'
    );
    expect(result.ok).toBe(true);
    expect(gh.commits.get(gh.head!)!.parent).toBe(before);
    expect(gh.fileAtHead('Postman/W/a.json')).toBe('a1');
    expect(gh.fileAtHead('Postman/W/b.json')).toBe('b1');
  });

  it('a file changed on GitHub since it was read is a conflict, and NOTHING is written', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"', 'Postman/W/b.json': '"b0"' });
    const c = client();
    await c.getFile('Postman/W/a.json');
    await c.getFile('Postman/W/b.json');
    gh.commit({ 'Postman/W/a.json': '"a-theirs"' }); // o colega enviou
    const head = gh.head;
    const result = await c.commitFiles(
      [
        { path: 'Postman/W/a.json', content: 'a-mine' },
        { path: 'Postman/W/b.json', content: 'b-mine' },
      ],
      'push'
    );
    expect(result).toEqual({ ok: false, conflicts: ['Postman/W/a.json'] });
    expect(gh.head).toBe(head);
    expect(gh.fileAtHead('Postman/W/a.json')).toBe('a-theirs');
  });

  it('a file never read that exists on GitHub is a conflict (someone created it)', async () => {
    gh.commit({ 'Postman/W/new.json': '"theirs"' });
    const result = await client().commitFiles([{ path: 'Postman/W/new.json', content: 'mine' }], 'push');
    expect(result).toEqual({ ok: false, conflicts: ['Postman/W/new.json'] });
  });

  it('someone pushing ANOTHER file in the middle: retries on the new top and keeps theirs', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const c = client();
    await c.getFile('Postman/W/a.json');
    gh.beforeRefMove = () => gh.commit({ 'Postman/W/other.json': '"other"' });
    const result = await c.commitFiles([{ path: 'Postman/W/a.json', content: 'a1' }], 'push');
    expect(result.ok).toBe(true);
    expect(gh.fileAtHead('Postman/W/a.json')).toBe('a1');
    expect(gh.fileAtHead('Postman/W/other.json')).toBe('other');
  });

  it('someone pushing THE SAME file in the middle: conflict on the retry', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const c = client();
    await c.getFile('Postman/W/a.json');
    gh.beforeRefMove = () => gh.commit({ 'Postman/W/a.json': '"a-theirs"' });
    const result = await c.commitFiles([{ path: 'Postman/W/a.json', content: 'a-mine' }], 'push');
    expect(result).toEqual({ ok: false, conflicts: ['Postman/W/a.json'] });
    expect(gh.fileAtHead('Postman/W/a.json')).toBe('a-theirs');
  });

  it('deletes go in the same commit; deleting what is already gone is a no-op', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"', 'Postman/W/old.json': '"x"' });
    const c = client();
    await c.getFile('Postman/W/old.json');
    const result = await c.commitFiles(
      [
        { path: 'Postman/W/old.json', delete: true },
        { path: 'Postman/W/never.json', delete: true },
      ],
      'push'
    );
    expect(result.ok).toBe(true);
    expect(gh.fileAtHead('Postman/W/old.json')).toBeUndefined();
    expect(gh.fileAtHead('Postman/W/a.json')).toBe('a0');
  });

  it('force writes over a changed file', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    await client().getFile('Postman/W/a.json');
    gh.commit({ 'Postman/W/a.json': '"a-theirs"' });
    const result = await client({ force: true }).commitFiles([{ path: 'Postman/W/a.json', content: 'a-mine' }], 'push');
    expect(result.ok).toBe(true);
    expect(gh.fileAtHead('Postman/W/a.json')).toBe('a-mine');
  });

  it('a branch with "/" is addressed segment by segment', async () => {
    BRANCH = `feature/${Math.random().toString(36).slice(2)}`;
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const c = client();
    await c.getFile('Postman/W/a.json');
    const result = await c.commitFiles([{ path: 'Postman/W/a.json', content: 'a1' }], 'push');
    expect(result.ok).toBe(true);
    const refCall = gh.calls.find(call => call.url.includes('/git/ref/heads/'))!;
    expect(refCall.url).toContain(`/git/ref/heads/${BRANCH}`);
    expect(refCall.url).not.toContain('%2F');
  });

  it('a branch that does not exist is a clear error, not one commit per file', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const c = new GitHubStorageClient({ token: 't', owner: 'o', repo: 'r', branch: 'nope' }, 'pass');
    await expect(c.commitFiles([{ path: 'Postman/W/a.json', content: 'a1' }], 'push')).rejects.toThrow(/HTTP 404.*nope/);
    expect(gh.calls.some(call => call.method === 'PUT')).toBe(false);
  });
});

describe('githubRequest — rate limit, temporary errors, conditional reads', () => {
  it('rate limit with a short wait: waits and retries by itself', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    gh.queued.push({ match: (m, u) => m === 'GET' && u.includes('/contents/'), response: res(429, {}, { 'Retry-After': '2' }) });
    const file = await client().getFile('Postman/W/a.json');
    expect(file?.content).toBe('a0');
    expect(requestTiming.sleep).toHaveBeenCalledWith(2000);
  });

  it('secondary rate limit (403 + Retry-After) also waits and retries', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    gh.queued.push({ match: (m, u) => m === 'GET' && u.includes('/contents/'), response: res(403, {}, { 'Retry-After': '1' }) });
    expect((await client().getFile('Postman/W/a.json'))?.content).toBe('a0');
  });

  it('hourly limit with a long wait is an error saying how long, without waiting', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const reset = String(Math.floor(Date.now() / 1000) + 30 * 60);
    gh.queued.push({ match: (m, u) => m === 'GET' && u.includes('/contents/'), response: res(403, {}, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': reset }) });
    await expect(client().listDirectoryStrict('Postman/W')).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(requestTiming.sleep).not.toHaveBeenCalled();
  });

  it('a 403 that is not a rate limit is not retried', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    gh.queued.push({ match: (m, u) => m === 'GET' && u.includes('/contents/'), response: res(403, { message: 'Forbidden' }) });
    await expect(client().listDirectoryStrict('Postman/W')).rejects.toThrow(/HTTP 403/);
    expect(requestTiming.sleep).not.toHaveBeenCalled();
  });

  it('a temporary GitHub error on a READ is retried', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    gh.queued.push({ match: (m, u) => m === 'GET' && u.includes('/contents/'), response: res(503, {}) });
    expect((await client().getFile('Postman/W/a.json'))?.content).toBe('a0');
  });

  it('a temporary GitHub error on a WRITE is not repeated', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const c = client();
    await c.getFile('Postman/W/a.json');
    gh.queued.push({ match: (m, u) => m === 'POST' && u.endsWith('/git/blobs'), response: res(503, {}) });
    await expect(c.commitFiles([{ path: 'Postman/W/a.json', content: 'a1' }], 'push')).rejects.toThrow(/HTTP 503/);
    expect(gh.calls.filter(call => call.method === 'POST' && call.url.endsWith('/git/blobs'))).toHaveLength(1);
  });

  it('reading a file that did not change asks "changed since?" and gets it back without spending quota', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const c = client();
    expect((await c.getFile('Postman/W/a.json'))?.content).toBe('a0');
    expect((await c.getFile('Postman/W/a.json'))?.content).toBe('a0');
    expect(gh.notModified).toBe(1);
    // Mudou lá: a resposta nova vem inteira.
    gh.commit({ 'Postman/W/a.json': '"a1"' });
    expect((await c.getFile('Postman/W/a.json'))?.content).toBe('a1');
  });
});

describe('listing — one call for the whole repository', () => {
  const files = {
    'Postman/W/api.postman_collection.json': '"api"',
    'Postman/W/environments/dev.postman_environment.json': '"dev"',
    'Postman/W/devflow-markers.json': '"m"',
    'Postman/Other/x.postman_collection.json': '"x"',
  };

  it('a workspace (collections, environments, shas) comes from ONE call', async () => {
    gh.commit(files);
    const listing = await client().workspaceListing('Postman/W');
    expect(listing.exists).toBe(true);
    expect(listing.collectionPaths).toEqual(['Postman/W/api.postman_collection.json']);
    expect(listing.envPaths).toEqual(['Postman/W/environments/dev.postman_environment.json']);
    expect(Object.keys(listing.shas)).toHaveLength(2);
    expect(gh.calls.filter(c => c.method === 'GET')).toHaveLength(1);
    expect(gh.calls[0].url).toContain('/git/trees/');
  });

  it('a folder with more than 1,000 files is listed whole', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 1200; i++) many[`Postman/Big/c${i}.postman_collection.json`] = '"c"';
    gh.commit(many);
    const listing = await client().workspaceListing('Postman/Big');
    expect(listing.collectionPaths).toHaveLength(1200);
  });

  it('workspaces and every file of one (rename/delete) also come from the tree', async () => {
    gh.commit(files);
    const c = client();
    expect((await c.listFolders('Postman')).map(f => f.name).sort()).toEqual(['Other', 'W']);
    expect((await c.listAllFilesRecursive('Postman/W')).map(f => f.path).sort()).toEqual([
      'Postman/W/api.postman_collection.json',
      'Postman/W/devflow-markers.json',
      'Postman/W/environments/dev.postman_environment.json',
    ]);
  });

  it('a branch with "/" also lists in one call (through the commit at its top)', async () => {
    BRANCH = `feature/${Math.random().toString(36).slice(2)}`;
    gh.commit(files);
    gh.calls = [];
    const listing = await client().workspaceListing('Postman/W');
    expect(listing.collectionPaths).toEqual(['Postman/W/api.postman_collection.json']);
    expect(gh.calls.some(c => c.url.includes('/contents/'))).toBe(false);
    expect(gh.calls.filter(c => c.url.includes('/git/trees/'))).toHaveLength(1);
  });

  it('a tree too big (cut by GitHub) falls back to the per-folder listing', async () => {
    gh.commit(files);
    gh.truncateTrees = true;
    const listing = await client().workspaceListing('Postman/W');
    expect(listing.collectionPaths).toEqual(['Postman/W/api.postman_collection.json']);
    expect(gh.calls.some(c => c.url.includes('/contents/Postman/W'))).toBe(true);
  });

  it('the commit reads the current versions from the tree, not one listing per folder', async () => {
    gh.commit(files);
    const c = client();
    await c.getFile('Postman/W/api.postman_collection.json');
    await c.getFile('Postman/W/environments/dev.postman_environment.json');
    gh.calls = [];
    const result = await c.commitFiles(
      [
        { path: 'Postman/W/api.postman_collection.json', content: 'api2' },
        { path: 'Postman/W/environments/dev.postman_environment.json', content: 'dev2' },
      ],
      'push'
    );
    expect(result.ok).toBe(true);
    expect(gh.calls.some(c => c.url.includes('/contents/'))).toBe(false);
  });
});

describe('last seen version survives closing the app', () => {
  /** Fechar e abrir o app: o que estava em memória some; fica o storage. */
  const reopenApp = () => {
    seenShas.flush();
    seenShas.reload();
  };

  it('a file changed on GitHub while the app was closed is still a conflict', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    await client().getFile('Postman/W/a.json');
    reopenApp();
    gh.commit({ 'Postman/W/a.json': '"a-theirs"' }); // o colega enviou com o app fechado
    const head = gh.head;
    const result = await client().commitFiles([{ path: 'Postman/W/a.json', content: 'a-mine' }], 'push');
    expect(result).toEqual({ ok: false, conflicts: ['Postman/W/a.json'] });
    expect(gh.head).toBe(head);
  });

  it('a file unchanged on GitHub since the last opening is written normally', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    await client().getFile('Postman/W/a.json');
    reopenApp();
    const result = await client().commitFiles([{ path: 'Postman/W/a.json', content: 'a1' }], 'push');
    expect(result.ok).toBe(true);
    expect(gh.fileAtHead('Postman/W/a.json')).toBe('a1');
  });

  it('the version written by this app is also remembered', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    await client().getFile('Postman/W/a.json');
    await client().commitFiles([{ path: 'Postman/W/a.json', content: 'a1' }], 'push');
    reopenApp();
    const result = await client().commitFiles([{ path: 'Postman/W/a.json', content: 'a2' }], 'push');
    expect(result.ok).toBe(true);
    expect(gh.fileAtHead('Postman/W/a.json')).toBe('a2');
  });

  it('a listing of many files is saved in one write', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    for (let i = 0; i < 50; i++) seenShas.set(`batch:${i}`, `s${i}`);
    await new Promise(r => setTimeout(r, 0));
    expect(setItem.mock.calls.filter(([k]) => k === SEEN_SHAS_STORAGE_KEY)).toHaveLength(1);
    setItem.mockRestore();
  });

  it('unreadable storage starts empty instead of breaking', () => {
    storage.set(SEEN_SHAS_STORAGE_KEY, '{not json');
    seenShas.reload();
    expect(seenShas.get('anything')).toBeUndefined();
    seenShas.set('k', 'v');
    expect(seenShas.get('k')).toBe('v');
  });

  it('keeps at most the limit, dropping the oldest', () => {
    seenShas.clear();
    for (let i = 0; i < SEEN_SHAS_MAX_ENTRIES + 10; i++) seenShas.set(`k${i}`, 's');
    expect(seenShas.size).toBe(SEEN_SHAS_MAX_ENTRIES);
    expect(seenShas.get('k0')).toBeUndefined();
    expect(seenShas.get(`k${SEEN_SHAS_MAX_ENTRIES + 9}`)).toBe('s');
  });
});

describe('commitFiles — unchanged files are not rewritten', () => {
  it('a file with the same content as on GitHub stays as it is (no new version)', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"', 'Postman/W/b.json': '"b0"' });
    const c = client();
    const a = await c.getFile('Postman/W/a.json');
    await c.getFile('Postman/W/b.json');
    const result = await c.commitFiles(
      [
        { path: 'Postman/W/a.json', content: 'a0' },
        { path: 'Postman/W/b.json', content: 'b1' },
      ],
      'push'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // a: o mesmo blob de antes; b: o novo.
    expect(result.written['Postman/W/a.json']).toBe(a!.sha);
    expect(gh.fileAtHead('Postman/W/b.json')).toBe('b1');
    expect(gh.calls.filter(x => x.method === 'POST' && x.url.endsWith('/git/blobs'))).toHaveLength(1);
  });

  it('nothing changed: no commit at all', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const c = client();
    await c.getFile('Postman/W/a.json');
    const head = gh.head;
    const result = await c.commitFiles([{ path: 'Postman/W/a.json', content: 'a0' }], 'push');
    expect(result.ok).toBe(true);
    expect(gh.head).toBe(head);
  });

  it('the version this app just wrote is also known: pushing it again writes nothing', async () => {
    gh.commit({ 'Postman/W/a.json': '"a0"' });
    const c = client();
    await c.getFile('Postman/W/a.json');
    await c.commitFiles([{ path: 'Postman/W/a.json', content: { x: 1, y: [1, 2] } }], 'push');
    const head = gh.head;
    // Mesmo conteúdo, chaves em outra ordem.
    const again = await c.commitFiles([{ path: 'Postman/W/a.json', content: { y: [1, 2], x: 1 } }], 'push');
    expect(again.ok).toBe(true);
    expect(gh.head).toBe(head);
  });
});

describe('diagnose — "Check setup"', () => {
  const byId = (checks: { id: string; ok: boolean | null; detail: string }[]) =>
    Object.fromEntries(checks.map(c => [c.id, c]));

  it('everything right: every item is ok', async () => {
    gh.commit({ 'Postman/W/a.postman_collection.json': '"a"' });
    const checks = byId(await client().diagnose('Postman'));
    expect(checks.token.ok).toBe(true);
    expect(checks.token.detail).toContain('tester');
    expect(checks.repository.ok).toBe(true);
    expect(checks.branch.ok).toBe(true);
    expect(checks.passphrase.ok).toBe(true);
    expect(checks.rateLimit).toMatchObject({ ok: true });
    expect(checks.rateLimit.detail).toContain('4999 of 5000');
  });

  it('an invalid token says so, and the items that depend on it are not checked', async () => {
    gh.tokenValid = false;
    const checks = byId(await client().diagnose('Postman'));
    expect(checks.token.ok).toBe(false);
    expect(checks.token.detail).toMatch(/invalid or has expired/);
    expect(checks.repository.ok).toBeNull();
    expect(checks.branch.ok).toBeNull();
  });

  it('a token that can only read: pushes would fail, and it says how to fix', async () => {
    gh.canPush = false;
    gh.commit({ 'Postman/W/a.postman_collection.json': '"a"' });
    const checks = byId(await client().diagnose('Postman'));
    expect(checks.repository.ok).toBe(false);
    expect(checks.repository.detail).toMatch(/cannot write/);
  });

  it('a branch that does not exist', async () => {
    gh.commit({ 'Postman/W/a.postman_collection.json': '"a"' });
    const c = new GitHubStorageClient({ token: 't', owner: 'o', repo: 'r', branch: 'nope' }, 'pass');
    expect(byId(await c.diagnose('Postman')).branch.ok).toBe(false);
  });

  it('an empty repository is fine (the first push creates it)', async () => {
    const checks = byId(await client().diagnose('Postman'));
    expect(checks.branch.ok).toBe(true);
    expect(checks.passphrase.ok).toBeNull();
  });

  it('no passphrase: pushes are blocked', async () => {
    gh.commit({ 'Postman/W/a.postman_collection.json': '"a"' });
    const c = new GitHubStorageClient({ token: 't', owner: 'o', repo: 'r', branch: BRANCH }, null);
    expect(byId(await c.diagnose('Postman')).passphrase.ok).toBe(false);
  });

  it('few requests left is flagged', async () => {
    gh.rateRemaining = 3;
    expect(byId(await client().diagnose('Postman')).rateLimit.ok).toBe(false);
  });
});

