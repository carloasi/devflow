import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/plugin-store', () => ({ LazyStore: class { get() { return null; } set() {} } }));

import { firstRealChange } from './whoChanged';

// Do mais novo pro mais antigo, como a API de commits devolve.
const commits = (...names: string[]) => names.map((name, i) => ({ sha: `s${i}`, author: name }));
const reader = (contents: Record<string, unknown>) => vi.fn(async (sha: string) => contents[sha] ?? null);

describe('firstRealChange', () => {
  it('the latest commit changed the content: it is the one', async () => {
    const read = reader({ s0: { a: 2 }, s1: { a: 1 } });
    expect((await firstRealChange(commits('bia', 'ana'), read))?.author).toBe('bia');
  });

  it('skips commits that only rewrote the same content (another collection was pushed)', async () => {
    const read = reader({ s0: { a: 2 }, s1: { a: 2 }, s2: { a: 2 }, s3: { a: 1 } });
    expect((await firstRealChange(commits('caio', 'dani', 'bia', 'ana'), read))?.author).toBe('bia');
  });

  it('key order does not count as a change', async () => {
    const read = reader({ s0: { a: 1, b: 2 }, s1: { b: 2, a: 1 }, s2: { a: 0, b: 2 } });
    expect((await firstRealChange(commits('caio', 'bia', 'ana'), read))?.author).toBe('bia');
  });

  it('the file was born in the oldest commit listed', async () => {
    const read = reader({ s0: { a: 1 }, s1: { a: 1 } });
    expect((await firstRealChange(commits('caio', 'ana'), read))?.author).toBe('ana');
  });

  it('a version that cannot be read stops the walk there (the old behavior)', async () => {
    const read = reader({ s0: { a: 1 } });
    expect((await firstRealChange(commits('caio', 'ana'), read))?.author).toBe('caio');
  });

  it('reads at most the limit', async () => {
    const same = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, { a: 1 }]));
    const read = reader(same);
    const names = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const found = await firstRealChange(commits(...names), read, 3);
    expect(read).toHaveBeenCalledTimes(3);
    expect(found?.author).toBe('p2');
  });

  it('no commits: null', async () => {
    expect(await firstRealChange([], reader({}))).toBeNull();
  });
});
