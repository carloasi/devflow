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
  clearRequestCache,
  GitHubRateLimitError,
  GitHubStorageClient,
  requestTiming,
  SEEN_SHAS_MAX_ENTRIES,
  SEEN_SHAS_STORAGE_KEY,
  seenShas,
} from './githubStorage';

// ─── GitHub de mentira ────────────────────────────────────────────────────
type Tree = Map<string, string>; // path → sha do blob

class FakeGitHub {
  blobs = new Map<string, string>();
  commits = new Map<string, { tree: Tree; parent: string | null }>();
  head: string | null = null;
  calls: { method: string; url: string }[] = [];
  /** Roda antes do PATCH da ref (simula alguém enviando no meio). */
  beforeRefMove: (() => void) | null = null;
  private n = 0;
  private id(prefix: string) {
    return `${prefix}${++this.n}`;
  }

  blob(content: string) {
    const sha = this.id('b');
    this.blobs.set(sha, content);
    return sha;
  }
  /** Um commit "de outra pessoa" direto no topo. */
  commit(files: Record<string, string | null>) {
    const tree: Tree = new Map(this.head ? this.commits.get(this.head)!.tree : []);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) tree.delete(path);
      else tree.set(path, this.blob(content));
    }
    const sha = this.id('c');
    this.commits.set(sha, { tree, parent: this.head });
    this.head = sha;
    return sha;
  }
  treeAt(ref: string): Tree | null {
    const sha = ref.startsWith('c') ? ref : this.head;
    return sha ? this.commits.get(sha)!.tree : null;
  }

  /** Respostas forçadas antes do caminho normal (limite, erro temporário). */
  queued: { match: (method: string, url: string) => boolean; response: ReturnType<typeof res> }[] = [];
  notModified = 0;
  /** Simula a árvore grande demais (o GitHub a devolve cortada). */
  truncateTrees = false;

  handle = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init.method ?? 'GET';
    this.calls.push({ method, url });
    const forced = this.queued.findIndex(q => q.match(method, url));
    if (forced >= 0) return this.queued.splice(forced, 1)[0].response;
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/repos\/o\/r/, ''));
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (path.startsWith('/git/ref/heads/') && method === 'GET') {
      if (!this.head) return res(409, { message: 'Git Repository is empty.' });
      if (path !== `/git/ref/heads/${BRANCH}`) return res(404, { message: 'Not Found' });
      return res(200, { object: { sha: this.head } });
    }
    if (path === '/git/blobs' && method === 'POST') return res(201, { sha: this.blob(body.content) });
    if (path.startsWith('/git/commits/') && method === 'GET') {
      const sha = path.slice('/git/commits/'.length);
      return this.commits.has(sha) ? res(200, { tree: { sha: `t:${sha}` } }) : res(404, {});
    }
    if (path === '/git/trees' && method === 'POST') {
      const tree: Tree = new Map(this.commits.get(body.base_tree.slice(2))!.tree);
      for (const entry of body.tree) {
        if (entry.sha === null) tree.delete(entry.path);
        else tree.set(entry.path, entry.sha);
      }
      const sha = this.id('tree');
      this.pendingTrees.set(sha, tree);
      return res(201, { sha });
    }
    if (path === '/git/commits' && method === 'POST') {
      const sha = this.id('c');
      this.commits.set(sha, { tree: this.pendingTrees.get(body.tree)!, parent: body.parents[0] });
      return res(201, { sha });
    }
    if (path.startsWith('/git/refs/heads/') && method === 'PATCH') {
      this.beforeRefMove?.();
      this.beforeRefMove = null;
      const commit = this.commits.get(body.sha)!;
      if (commit.parent !== this.head) return res(422, { message: 'Update is not a fast forward' });
      this.head = body.sha;
      return res(200, { object: { sha: body.sha } });
    }
    if (path.startsWith('/git/trees/') && method === 'GET') {
      const ref = path.slice('/git/trees/'.length);
      const commitSha = ref.startsWith('t:') ? ref.slice(2) : ref.startsWith('c') ? ref : ref === BRANCH ? this.head : null;
      if (!commitSha || !this.commits.has(commitSha)) return res(404, {});
      const files = [...this.commits.get(commitSha)!.tree.entries()];
      const dirs = new Set<string>();
      for (const [p] of files) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      return res(200, {
        truncated: this.truncateTrees,
        tree: [
          ...[...dirs].map(p => ({ path: p, type: 'tree', sha: `tree-${p}` })),
          ...files.map(([p, sha]) => ({ path: p, type: 'blob', sha })),
        ],
      });
    }
    if (path.startsWith('/contents/') && method === 'GET') {
      const target = path.slice('/contents/'.length);
      const tree = this.treeAt(u.searchParams.get('ref') ?? '');
      if (!tree) return res(404, {});
      const file = tree.get(target);
      if (file) {
        const etag = `"${file}"`;
        if (init.headers?.['If-None-Match'] === etag) {
          this.notModified++;
          return res(304, null);
        }
        return res(200, { sha: file, encoding: 'base64', content: btoa(this.blobs.get(file)!) }, { ETag: etag });
      }
      const entries = [...tree.entries()].filter(([p]) => p.startsWith(`${target}/`) && !p.slice(target.length + 1).includes('/'));
      if (entries.length === 0) return res(404, {});
      return res(
        200,
        entries.map(([p, sha]) => ({ type: 'file', path: p, name: p.split('/').pop(), sha }))
      );
    }
    throw new Error(`fake GitHub: ${method} ${path} not handled`);
  };
  private pendingTrees = new Map<string, Tree>();

  fileAtHead(path: string): unknown {
    const sha = this.treeAt('')?.get(path);
    return sha ? JSON.parse(this.blobs.get(sha)!) : undefined;
  }
}

function res(status: number, data: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => data,
  };
}

let BRANCH = 'main';
let gh: FakeGitHub;
const client = (options: { force?: boolean } = {}) =>
  new GitHubStorageClient({ token: 't', owner: 'o', repo: 'r', branch: BRANCH }, 'pass', options);

beforeEach(() => {
  clearRequestCache();
  requestTiming.sleep = vi.fn(async () => undefined);
  BRANCH = `main-${Math.random().toString(36).slice(2)}`; // "visto" é global por branch
  gh = new FakeGitHub();
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
