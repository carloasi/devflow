// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Testes de TELA do painel do GitHub, contra o GitHub de mentira dos testes
// do cliente: o "Check setup" e as pastas que só existem no GitHub (marcar e
// apagar). O que antes só dava pra conferir no app, com um repositório de
// verdade.

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
    async delete(key: string) {
      this.data.delete(key);
    }
  },
}));
const kv = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/tauriStore', () => ({
  storeGet: async (key: string) => kv.get(key) ?? null,
  storeSet: async (key: string, value: unknown) => void kv.set(key, value),
  storeDelete: async (key: string) => void kv.delete(key),
}));
vi.mock('@/lib/secureStorage', () => ({
  getSecret: async (key: string) => (key === 'gh_sync_token' ? 't' : 'pass'),
  saveSecret: async () => undefined,
  deleteSecret: async () => undefined,
}));
vi.mock('@/lib/syncCrypto', () => ({
  encryptData: async (data: unknown) => JSON.stringify(data),
  decryptData: async (text: string) => JSON.parse(text),
  clearDerivedKeyCache: () => undefined,
  MissingPassphraseError: class extends Error {},
}));
const workspaces = vi.hoisted(() => ({ list: [{ path: 'W' }] as { path: string }[] }));
vi.mock('@/storage/workspaceStore', () => ({ listWorkspaces: async () => workspaces.list }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), custom: vi.fn(), dismiss: vi.fn() }),
}));

import { FakeGitHub } from '@/lib/sync/testing/fakeGitHub';
import { clearRequestCache } from '@/lib/sync/githubStorage';
import GitHubSync from './GitHubStorageClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let gh: FakeGitHub;
const onRemoteWorkspaceDeleted = vi.fn();

async function flush(times = 10) {
  await act(async () => {
    for (let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 0));
  });
}

async function mount() {
  await act(async () => {
    root.render(
      React.createElement(GitHubSync, {
        workspace: 'W',
        currentCollections: [],
        currentEnvironments: [],
        onPullCollections: () => undefined,
        onPullEnvironments: () => undefined,
        onImportWorkspace: () => undefined,
        onRemoteWorkspaceDeleted,
      })
    );
  });
  await flush();
  // Abre o painel (o botão "GitHub Sync" da barra).
  const toggle = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.title.startsWith('GitHub Sync'));
  await click(toggle!);
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

const button = (label: string | RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(b =>
    typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent?.trim() ?? '')
  );

beforeEach(() => {
  localStorage.clear();
  kv.clear();
  kv.set('gh_sync_config', { owner: 'o', repo: 'r', branch: 'main' });
  workspaces.list = [{ path: 'W' }];
  clearRequestCache();
  onRemoteWorkspaceDeleted.mockClear();
  gh = new FakeGitHub(() => 'main');
  http.fetch.mockReset();
  http.fetch.mockImplementation((url: string, init: { method?: string; body?: string }) => gh.handle(url, init));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('GitHub panel — Check setup', () => {
  it('lists each item with ✓ when everything is right', async () => {
    gh.commit({ 'Postman/W/api.postman_collection.json': '"a"' });
    await mount();
    await click(button('Check setup')!);
    const items = [...document.querySelectorAll<HTMLElement>('[data-testid="setup-checks"] [data-check]')];
    const state = Object.fromEntries(items.map(li => [li.dataset.check, li.dataset.ok]));
    expect(state).toMatchObject({ token: 'true', repository: 'true', branch: 'true', passphrase: 'true', rateLimit: 'true' });
  });

  it('a token without write access shows ✗ on the repository, with how to fix', async () => {
    gh.canPush = false;
    gh.commit({ 'Postman/W/api.postman_collection.json': '"a"' });
    await mount();
    await click(button('Check setup')!);
    const repo = document.querySelector<HTMLElement>('[data-check="repository"]')!;
    expect(repo.dataset.ok).toBe('false');
    expect(repo.textContent).toMatch(/cannot write/);
  });
});

describe('GitHub panel — folders only on GitHub', () => {
  it('are marked, and Delete removes them from GitHub (keeping the others)', async () => {
    gh.commit({
      'Postman/W/api.postman_collection.json': '"a"',
      'Postman/Old/x.postman_collection.json': '"x"',
      'Postman/Old/environments/dev.postman_environment.json': '"d"',
    });
    await mount();
    await click(button('List')!);
    expect(document.body.textContent).toContain('only on GitHub');
    const del = document.querySelector<HTMLButtonElement>('button[aria-label=\'Delete "Old" from GitHub\']');
    expect(del).toBeTruthy();
    // O workspace que existe aqui não ganha o botão.
    expect(document.querySelector('button[aria-label=\'Delete "W" from GitHub\']')).toBeNull();

    await click(del!);
    expect(document.body.textContent).toContain('Delete workspace from GitHub?');
    await click(button('Delete permanently')!);

    expect(gh.fileAtHead('Postman/Old/x.postman_collection.json')).toBeUndefined();
    expect(gh.fileAtHead('Postman/Old/environments/dev.postman_environment.json')).toBeUndefined();
    expect(gh.fileAtHead('Postman/W/api.postman_collection.json')).toBe('a');
    expect(onRemoteWorkspaceDeleted).toHaveBeenCalledWith('Old');
    // E sai da lista.
    expect(document.querySelector('button[aria-label=\'Delete "Old" from GitHub\']')).toBeNull();
  });
});
