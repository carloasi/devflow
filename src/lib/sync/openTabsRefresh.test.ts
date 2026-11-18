import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Tab } from '@/app/types/Tab';
import { tabsAfterSync } from './openTabsRefresh';

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'POST',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});
const tree = (...items: CollectionItem[]): CollectionItem[] => [{ id: 'root', name: 'Col', type: 'folder', item: items }];

// Versão mínima do buildTabFromItem do AppLayout: só o que os testes leem.
const build = (item: CollectionItem): Tab =>
  ({ id: item.id, name: item.name, method: item.method ?? 'GET', requestBodyValue: item.request?.body ?? '' }) as Tab;

const tab = (id: string, body: string, extra: Partial<Tab> = {}): Tab =>
  ({ ...build(req(id, body)), ...extra }) as Tab;

describe('tabsAfterSync', () => {
  it('reloads an open tab whose item the merge changed, keeping its response', () => {
    const response = { status: 200 } as Tab['response'];
    const tabs = [tab('pay', 'old', { response, activeRequestTab: 'body', groupId: 'g1' })];
    const result = tabsAfterSync(tabs, tree(req('pay', 'old')), tree(req('pay', 'new')), build);
    expect(result.reloaded.map(t => t.id)).toEqual(['pay']);
    expect(result.tabs[0]).toMatchObject({
      requestBodyValue: 'new',
      response,
      activeRequestTab: 'body',
      groupId: 'g1',
      isDirty: false,
    });
  });

  it('leaves a tab with unsaved edits alone and reports it', () => {
    const tabs = [tab('pay', 'typing…', { isDirty: true })];
    const result = tabsAfterSync(tabs, tree(req('pay', 'old')), tree(req('pay', 'new')), build);
    expect(result.reloaded).toEqual([]);
    expect(result.dirty.map(t => t.id)).toEqual(['pay']);
    expect(result.tabs).toBe(tabs);
  });

  it('does not touch tabs whose item did not change', () => {
    const tabs = [tab('pay', 'a'), tab('ord', 'b')];
    const result = tabsAfterSync(tabs, tree(req('pay', 'a'), req('ord', 'b')), tree(req('pay', 'a'), req('ord', 'B')), build);
    expect(result.reloaded.map(t => t.id)).toEqual(['ord']);
    expect(result.tabs[0]).toBe(tabs[0]);
  });

  it('keeps the tab of an item the merge deleted', () => {
    const tabs = [tab('pay', 'a')];
    const result = tabsAfterSync(tabs, tree(req('pay', 'a')), tree(), build);
    expect(result).toEqual({ tabs, reloaded: [], dirty: [] });
  });

  it('ignores changes to children only (an example under the request)', () => {
    const before = tree({ ...req('pay', 'a'), item: [] });
    const after = tree({ ...req('pay', 'a'), item: [{ id: 'ex', name: 'ex', type: 'example' }] });
    const result = tabsAfterSync([tab('pay', 'a')], before, after, build);
    expect(result.reloaded).toEqual([]);
  });
});
