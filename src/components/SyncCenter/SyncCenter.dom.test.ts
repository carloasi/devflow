// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SyncOverview, SyncItem } from '@/lib/sync/syncOverview';
import { closeSyncCenter, openSyncCenter, type SyncActionResult } from '@/lib/sync/syncCenterStore';

// Testes de TELA da Central de Sincronização: ela abre, mostra o que vem e o
// que vai, e os botões de cada linha chamam a ação certa, com o escopo do
// item — o que até aqui só era conferido à mão no app.

import { SyncCenter } from './SyncCenter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (id: string, path: string[], over: Partial<SyncItem> = {}): SyncItem => ({
  id,
  path,
  change: 'changed',
  conflict: false,
  fields: [],
  rootId: 'c1',
  existsHere: true,
  kind: 'request',
  ...over,
});

const overview = (over: Partial<SyncOverview> = {}): SyncOverview => ({
  incoming: [item('a', ['API', 'Login'])],
  outgoing: [item('b', ['API', 'Checkout'])],
  conflicts: [],
  envIncoming: [],
  envOutgoing: [],
  envKeptMine: [],
  envSessionTokens: [],
  envValues: {},
  markers: { added: [], changed: [], removed: [] },
  ...over,
});

let container: HTMLDivElement;
let root: Root;
const done: SyncActionResult = { result: 'done', messages: [{ type: 'success', message: 'Done.' }] };
let props: {
  workspace: string;
  loadOverview: ReturnType<typeof vi.fn>;
  lastChangeOf: ReturnType<typeof vi.fn>;
  runAction: ReturnType<typeof vi.fn>;
  discard: ReturnType<typeof vi.fn>;
  openItem: ReturnType<typeof vi.fn>;
};

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function mount(tab?: 'incoming' | 'outgoing') {
  await act(async () => {
    root.render(React.createElement(SyncCenter, props));
  });
  await act(async () => {
    openSyncCenter(tab ? { tab } : {});
  });
  await flush();
}

const byTitle = (title: string) => [...document.querySelectorAll<HTMLButtonElement>(`button[title="${title}"]`)];
const text = () => document.body.textContent ?? '';

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    workspace: 'W',
    loadOverview: vi.fn(async () => overview()),
    lastChangeOf: vi.fn(async () => ({ authorName: 'Bia', date: new Date().toISOString() })),
    runAction: vi.fn(async () => done),
    discard: vi.fn(async () => done),
    openItem: vi.fn(),
  };
});

afterEach(async () => {
  await act(async () => {
    closeSyncCenter();
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('Sync Center', () => {
  it('opens and reads GitHub once, showing what is coming in', async () => {
    await mount('incoming');
    expect(props.loadOverview).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Login');
  });

  it('"Receive only this" on a row receives that item only', async () => {
    await mount('incoming');
    const [receive] = byTitle('Bring only this item from GitHub — the rest stays as it is');
    expect(receive).toBeTruthy();
    await click(receive);
    expect(props.runAction).toHaveBeenCalledTimes(1);
    const [action, scope] = props.runAction.mock.calls[0];
    expect(action).toBe('receive');
    expect(scope).toMatchObject({ itemId: 'a' });
  });

  it('"Send only this" on a row sends that item only', async () => {
    await mount('outgoing');
    expect(text()).toContain('Checkout');
    const [send] = byTitle('Send only this item');
    expect(send).toBeTruthy();
    await click(send);
    const [action, scope] = props.runAction.mock.calls[0];
    expect(action).toBe('send');
    expect(scope).toMatchObject({ itemId: 'b' });
  });

  it('while an action runs, the row buttons are disabled (no second action on top)', async () => {
    let finish: (r: SyncActionResult) => void = () => undefined;
    props.runAction = vi.fn(() => new Promise<SyncActionResult>(resolve => (finish = resolve)));
    await mount('outgoing');
    const [send] = byTitle('Send only this item');
    await click(send);
    expect(byTitle('Send only this item').every(b => b.disabled)).toBe(true);
    await act(async () => finish(done));
    await flush();
  });

  it('a failed read shows the error instead of "nothing to do"', async () => {
    props.loadOverview = vi.fn(async () => {
      throw new Error('Could not read GitHub.');
    });
    await mount();
    expect(text()).toContain('Could not read GitHub.');
  });
});
