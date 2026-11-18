// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CollectionItem } from '@/app/types/CollectionItem';

// A árvore lê o environment ativo pra copiar URL/cURL; aqui não importa.
vi.mock('@/components/EnvironmentContext', () => ({
  useEnvironment: () => ({ activeEnv: null, environments: [] }),
}));

import { CollectionTree } from './CollectionTree';
import { findNodeById } from './utils/tree.utils';

// Testes de INTERFACE da árvore: clique, Ctrl/Shift+Click, teclado e Esc,
// recortar e colar — o que as funções puras não cobrem e que até aqui só
// era conferido à mão. O arraste fica de fora: o dnd-kit mede o layout,
// que o happy-dom não calcula (a lógica do drop tem teste próprio).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: id, type: 'folder', item: children }) as CollectionItem;
const request = (id: string): CollectionItem =>
  ({ id, name: id, type: 'request', method: 'GET' }) as CollectionItem;

const tree = (): CollectionItem[] => [
  folder('ColA', [request('a1'), request('a2'), request('a3'), folder('Sub', [request('d1')])]),
  folder('ColB', [request('b1')]),
];

let container: HTMLDivElement;
let root: Root;
let items: CollectionItem[];
const onUpdateItems = vi.fn((next: CollectionItem[]) => {
  items = next;
  render();
});

function render() {
  act(() => {
    root.render(React.createElement(CollectionTree, { items, onUpdateItems }));
  });
}

const row = (id: string) => container.querySelector<HTMLElement>(`[data-tree-row="${id}"]`);
const nameButton = (id: string) => row(id)!.querySelector('button[title]') as HTMLButtonElement;
const treeEl = () => container.querySelector<HTMLElement>('[role="tree"]')!;
const selected = () =>
  [...container.querySelectorAll('[role="treeitem"][aria-selected="true"]')].map(
    el => el.closest('[data-tree-row]')?.getAttribute('data-tree-row') ?? el.getAttribute('data-tree-row')
  );

function click(id: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  const btn = nameButton(id);
  act(() => {
    row(id)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ...mods }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...mods }));
  });
}

function key(k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
  act(() => {
    treeEl().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
  });
}

function focusTree() {
  act(() => {
    treeEl().focus();
    treeEl().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  // Pastas abertas: o estado de abertura é lido do localStorage.
  localStorage.setItem('devflow_tree_expanded', JSON.stringify(['ColA', 'Sub', 'ColB']));
  items = tree();
  onUpdateItems.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('árvore: seleção', () => {
  it('Ctrl+Click marca várias; clique comum desfaz', () => {
    click('a1', { ctrlKey: true });
    click('a3', { ctrlKey: true });
    expect(selected()).toEqual(['a1', 'a3']);

    click('b1');
    expect(selected()).toEqual([]);
  });

  it('Shift+Click seleciona o intervalo a partir do último clicado', () => {
    click('a1');
    click('a3', { shiftKey: true });
    expect(selected()).toEqual(['a1', 'a2', 'a3']);
  });

  it('Shift+seta estende pelo teclado; Esc limpa', () => {
    click('a1');
    focusTree();
    key('ArrowDown', { shiftKey: true });
    key('ArrowDown', { shiftKey: true });
    expect(selected()).toEqual(['a1', 'a2', 'a3']);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(selected()).toEqual([]);
  });

  it('Espaço marca e desmarca a linha com foco', () => {
    click('a2');
    focusTree();
    key(' ');
    expect(selected()).toEqual(['a2']);
    key(' ');
    expect(selected()).toEqual([]);
  });
});

describe('árvore: recortar e colar', () => {
  it('Ctrl+X e Ctrl+V numa pasta movem (não copiam)', () => {
    click('a1', { ctrlKey: true });
    click('a2', { ctrlKey: true });
    focusTree();
    key('x', { ctrlKey: true });
    // Esmaecidas enquanto esperam o colar.
    expect(row('a1')!.style.opacity).toBe('0.5');

    click('Sub');
    focusTree();
    key('v', { ctrlKey: true });

    expect(onUpdateItems).toHaveBeenCalled();
    expect(findNodeById(items, 'Sub')!.item!.map(i => i.id)).toEqual(['d1', 'a1', 'a2']);
    expect(findNodeById(items, 'ColA')!.item!.map(i => i.id)).toEqual(['a3', 'Sub']);
  });
});

describe('árvore: teclado', () => {
  it('Shift+← fecha a collection inteira do item', () => {
    click('d1');
    focusTree();
    key('ArrowLeft', { shiftKey: true });
    expect(row('a1')).toBeNull();
    expect(row('ColA')).not.toBeNull();
    expect(row('b1')).not.toBeNull();
  });
});

describe('árvore: caminho da aba aberta', () => {
  it('mostra Collection › Pasta › Item acima da árvore', () => {
    act(() => {
      root.render(React.createElement(CollectionTree, { items, onUpdateItems, activeRequestId: 'd1' }));
    });
    const nav = container.querySelector('nav[aria-label="Open item location"]');
    expect([...nav!.querySelectorAll('button')].map(b => b.textContent)).toEqual(['ColA', 'Sub', 'd1']);
  });
});

describe('árvore: bugs das melhorias', () => {
  it('Shift+seta parte da linha a que se chegou com as setas, não de um clique antigo', () => {
    click('a1');
    focusTree();
    key('ArrowDown'); // a2
    key('ArrowDown'); // a3
    key('ArrowDown', { shiftKey: true }); // a3..Sub
    expect(selected()).toEqual(['a3', 'Sub']);
  });

  it('espaço no meio da busca por digitação continua a busca', () => {
    items = [folder('ColA', [request('Order Groups'), request('Order Seats')])];
    render();
    focusTree();
    key('o');
    key('r');
    key(' ');
    expect(selected()).toEqual([]);
  });

  it('depois de colar um recorte, o Ctrl+V seguinte não cola cópias', () => {
    click('a1');
    focusTree();
    key('x', { ctrlKey: true });
    click('Sub');
    focusTree();
    key('v', { ctrlKey: true });
    const calls = onUpdateItems.mock.calls.length;
    key('v', { ctrlKey: true });
    expect(onUpdateItems.mock.calls.length).toBe(calls);
  });
});
