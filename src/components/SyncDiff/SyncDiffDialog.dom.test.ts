// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CollectionItem } from '@/app/types/CollectionItem';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { diffTrees } from '@/lib/collectionDiff';
import { acquireSyncLock, releaseSyncLock } from '@/lib/sync/syncLock';
import { SyncDiffDialog } from './SyncDiffDialog';

// Testes de TELA da revisão: Aplicar com outro sync rodando não aplica nada
// (gravaria por cima do push que está em andamento) e a revisão fica aberta.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const req = (id: string, body: string): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});
const col = (children: CollectionItem[]): CollectionItem[] => [
  { id: 'c1', name: 'API', type: 'folder', item: children } as CollectionItem,
];

let container: HTMLDivElement;
let root: Root;
const onApply = vi.fn();

async function mount() {
  const local = col([req('a', 'mine')]);
  const remote = col([req('a', 'theirs'), req('n', 'new')]);
  await act(async () => {
    root.render(
      React.createElement(SyncDiffDialog, {
        open: true,
        nodes: diffTrees(local, remote),
        pendingCollectionIds: new Set<string>(),
        collectionNames: new Map([['c1', 'API']]),
        onClose: () => undefined,
        onApply,
        workspace: 'W',
      })
    );
  });
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

const applyButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => /^(Apply|Aplicar)\b/.test(b.textContent?.trim() ?? ''));

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  onApply.mockClear();
  toast.error.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('review dialog — Apply and the sync lock', () => {
  it('with another sync running, Apply applies nothing and says why', async () => {
    await mount();
    const push = acquireSyncLock('push');
    try {
      const button = applyButton();
      expect(button).toBeTruthy();
      await click(button!);
      expect(onApply).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalled();
      // A revisão continua aberta, com o botão ainda lá.
      expect(applyButton()).toBeTruthy();
    } finally {
      releaseSyncLock(push);
    }
  });

  it('with nothing running, Apply applies', async () => {
    await mount();
    await click(applyButton()!);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
