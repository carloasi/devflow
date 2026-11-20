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
vi.stubGlobal('localStorage', {
  getItem: () => 'tester',
  setItem: () => undefined,
  removeItem: () => undefined,
});

import { GitHubStorageClient } from './githubStorage';

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

  handle = async (url: string, init: { method?: string; body?: string }) => {
    const method = init.method ?? 'GET';
    this.calls.push({ method, url });
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
    if (path.startsWith('/contents/') && method === 'GET') {
      const target = path.slice('/contents/'.length);
      const tree = this.treeAt(u.searchParams.get('ref') ?? '');
      if (!tree) return res(404, {});
      const file = tree.get(target);
      if (file) {
        return res(200, { sha: file, encoding: 'base64', content: btoa(this.blobs.get(file)!) });
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

function res(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

let BRANCH = 'main';
let gh: FakeGitHub;
const client = (options: { force?: boolean } = {}) =>
  new GitHubStorageClient({ token: 't', owner: 'o', repo: 'r', branch: BRANCH }, 'pass', options);

beforeEach(() => {
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
