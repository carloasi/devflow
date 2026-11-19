import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import { applyEnvironmentChanges, diffEnvironments } from '@/lib/environmentDiff';
import { mergeTabSave } from './tabSaveMerge';
import { REST } from './fieldMerge';

const req = (o: { url?: string; body?: string; headers?: { key: string; value: string; enabled: boolean }[]; description?: string; bodyType?: 'raw' | 'none' } = {}): CollectionItem => ({
  id: 'r',
  name: 'R',
  type: 'request',
  method: 'POST',
  ...(o.description ? { description: o.description } : {}),
  request: {
    url: o.url ?? '/x',
    urlexport: { host: [], path: [], raw: o.url ?? '/x' },
    headers: o.headers ?? [],
    body: o.body ?? 'b0',
    ...(o.bodyType ? { bodyType: o.bodyType } : {}),
  },
});

describe('saving a tab whose request changed in a sync', () => {
  const base = req();

  it("keeps your edit AND the colleague's change in another field", () => {
    const r = mergeTabSave({ base, mineBase: base, mine: req({ body: 'mine' }), theirs: req({ url: '/theirs' }) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.request!.body).toBe('mine');
    expect(r.item.request!.url).toBe('/theirs');
    expect(r.incoming).toEqual(['url']);
  });

  it('keeps what the tab does not edit (description) from the sync', () => {
    const r = mergeTabSave({ base, mineBase: base, mine: req({ body: 'mine' }), theirs: req({ description: 'doc' }) });
    expect(r.ok && r.item.description).toBe('doc');
  });

  it('the same field changed on both sides is a conflict, not an overwrite', () => {
    const r = mergeTabSave({ base, mineBase: base, mine: req({ body: 'mine' }), theirs: req({ body: 'theirs' }) });
    expect(r).toEqual({ ok: false, conflicts: ['body'] });
  });

  it('both sides making the same change is not a conflict', () => {
    const r = mergeTabSave({ base, mineBase: base, mine: req({ body: 'same' }), theirs: req({ body: 'same' }) });
    expect(r.ok && r.item.request!.body).toBe('same');
  });

  it('a field the tab only normalized is not counted as yours', () => {
    // A conversão aba → request troca a representação de algo que você
    // não editou: comparado com `mineBase`, isso não é "seu".
    const normalized = req({ headers: [{ key: 'X', value: '1', enabled: true }] });
    const r = mergeTabSave({
      base,
      mineBase: normalized,
      mine: { ...normalized, request: { ...normalized.request!, body: 'mine' } },
      theirs: req({ headers: [{ key: 'Y', value: '2', enabled: true }] }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.request!.headers).toEqual([{ key: 'Y', value: '2', enabled: true }]);
    expect(r.item.request!.body).toBe('mine');
  });

  it('the rest (body type…) changed on both sides is a conflict', () => {
    // A base não grava bodyType; cada lado gravou um diferente.
    const r = mergeTabSave({ base, mineBase: base, mine: req({ bodyType: 'none' }), theirs: req({ bodyType: 'raw' }) });
    expect(r.ok === false && r.conflicts).toEqual([REST]);
  });
});

const env = (values: Environment['values']): Environment => ({ id: 'e', name: 'dev', values });

describe('a variable disabled on GitHub', () => {
  it('is disabled here, not deleted', () => {
    const local = env([{ id: '1', key: 'token', value: 'abc', enabled: true, type: 'default' }]);
    const remote = env([{ id: '2', key: 'token', value: 'abc', enabled: false, type: 'default' }]);
    const nodes = diffEnvironments([local], [remote]);
    const merged = applyEnvironmentChanges([local], [remote], new Set(nodes.map(n => n.id)));
    expect(merged[0].values).toEqual([{ id: '1', key: 'token', value: 'abc', enabled: false, type: 'default' }]);
  });

  it('a variable really deleted on GitHub is still removed', () => {
    const local = env([{ id: '1', key: 'old', value: 'x', enabled: true, type: 'default' }]);
    const remote = env([]);
    const nodes = diffEnvironments([local], [remote]);
    expect(applyEnvironmentChanges([local], [remote], new Set(nodes.map(n => n.id)))[0].values).toEqual([]);
  });

  it('a variable marked secret on GitHub arrives as secret', () => {
    const local = env([{ id: '1', key: 'k', value: 'a', enabled: true, type: 'default' }]);
    const remote = env([{ id: '2', key: 'k', value: 'b', enabled: true, type: 'secret' }]);
    const nodes = diffEnvironments([local], [remote]);
    const merged = applyEnvironmentChanges([local], [remote], new Set(nodes.map(n => n.id)));
    expect(merged[0].values[0]).toMatchObject({ value: 'b', type: 'secret' });
  });
});
