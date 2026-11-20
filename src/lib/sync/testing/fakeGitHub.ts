// ─────────────────────────────────────────────────────────────────────────
// GitHub de mentira, em memória, pros testes do sync: refs, blobs, commits,
// árvores (inclusive a listagem recursiva), Contents API com ETag, o
// "Check setup" e respostas forçadas. Usado pelos testes do cliente
// (lib/sync/githubStorage) e pelos de tela do painel do GitHub.
// ─────────────────────────────────────────────────────────────────────────

type Tree = Map<string, string>; // path → sha do blob

export class FakeGitHub {
  /** A branch que este GitHub tem (lida a cada chamada: os testes a trocam). */
  constructor(private branchOf: () => string = () => 'main') {}

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

  tokenValid = true;
  canPush = true;
  rateRemaining = 4999;
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
      if (path !== `/git/ref/heads/${this.branchOf()}`) return res(404, { message: 'Not Found' });
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
      const commitSha = ref.startsWith('t:') ? ref.slice(2) : ref.startsWith('c') ? ref : ref === this.branchOf() ? this.head : null;
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
    // "Check setup" (diagnose).
    if (path === '/user' && method === 'GET') return this.tokenValid ? res(200, { login: 'tester' }) : res(401, {});
    if (path === '' && method === 'GET') return res(200, { permissions: { push: this.canPush } });
    if (path === '/rate_limit' && method === 'GET') {
      return res(200, { resources: { core: { remaining: this.rateRemaining, limit: 5000, reset: 1_900_000_000 } } });
    }
    throw new Error(`fake GitHub: ${method} ${path} not handled`);
  };
  private pendingTrees = new Map<string, Tree>();

  fileAtHead(path: string): unknown {
    const sha = this.treeAt('')?.get(path);
    return sha ? JSON.parse(this.blobs.get(sha)!) : undefined;
  }
}

export function res(status: number, data: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => data,
  };
}

