import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { fieldDiffs } from '@/lib/collectionDiff';
import { matchesSyncBase, nodeHashes, pendingChanges } from '@/lib/syncBase';
import { rebaseCollections } from './rebase';
import { fieldHashKey, fieldMergePlan, withLegacyFieldHashes } from './fieldMerge';
import { resolveNode } from './autoMerge';
import type { DiffNode } from '@/lib/collectionDiff';

// Partes da request que o diff não comparava: path param (com a mesma URL),
// tipo do body, gRPC, variáveis da collection, headers padrão desligados.
// O pull não trazia a mudança do colega e o push seguinte a desfazia.

const req = (id: string, opts: { path?: string; body?: string; url?: string; extra?: Partial<CollectionItem> } = {}): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'GET',
  request: {
    url: opts.url ?? '/u/:id',
    urlexport: { host: [], path: [], raw: opts.url ?? '/u/:id', variable: [{ id: 'p1', key: 'id', value: opts.path ?? '5', enabled: true }] },
    headers: [],
    body: opts.body ?? '',
  },
  ...opts.extra,
});
const grpc = (message: string): Partial<CollectionItem> =>
  ({ protocol: 'grpc', grpc: { target: 'svc:443', method: 'pkg.S/M', message } }) as unknown as Partial<CollectionItem>;
const col = (children: CollectionItem[], vars = '1') =>
  [{ id: 'c', name: 'C', type: 'folder', item: children, variable: [{ key: 'v', value: vars }] } as CollectionItem];

const synced = () => col([req('a'), req('g', { extra: grpc('{}') })]);
const base = nodeHashes(synced());

describe('request fields beyond url/headers/body', () => {
  it("the colleague's path param, gRPC message and collection variable come in", () => {
    const remote = col([req('a', { path: '7' }), req('g', { extra: grpc('{"x":1}') })], '2');
    const r = rebaseCollections(synced(), remote, base, new Set());
    expect(r.conflicts).toEqual([]);
    const m = r.merged[0];
    expect(m.item![0].request!.urlexport.variable![0].value).toBe('7');
    expect((m.item![1] as unknown as { grpc: { message: string } }).grpc.message).toBe('{"x":1}');
    expect(m.variable![0].value).toBe('2');
  });

  it('your path param change is pushed over an untouched GitHub version', () => {
    const local = col([req('a', { path: '9' }), req('g', { extra: grpc('{}') })]);
    const r = rebaseCollections(local, synced(), base, new Set(['c']));
    expect(r.conflicts).toEqual([]);
    expect(r.merged[0].item![0].request!.urlexport.variable![0].value).toBe('9');
  });

  it('your path param and their body merge field by field', () => {
    const local = col([req('a', { path: '9' }), req('g', { extra: grpc('{}') })]);
    const remote = col([req('a', { body: 'theirs' }), req('g', { extra: grpc('{}') })]);
    const r = rebaseCollections(local, remote, base, new Set(['c']));
    expect(r.conflicts).toEqual([]);
    const a = r.merged[0].item![0];
    expect(a.request!.urlexport.variable![0].value).toBe('9');
    expect(a.request!.body).toBe('theirs');
  });

  it('your URL against their path param is a conflict, not a silent overwrite', () => {
    const local = col([req('a', { url: '/v2/u/:id' }), req('g', { extra: grpc('{}') })]);
    const remote = col([req('a', { path: '7' }), req('g', { extra: grpc('{}') })]);
    const r = rebaseCollections(local, remote, base, new Set(['c']));
    expect(r.conflicts).toEqual(['a']);
  });

  it('absent, empty and default values are not a difference', () => {
    const a = req('a');
    const b: CollectionItem = {
      ...a,
      variable: [],
      protocol: 'http',
      request: { ...a.request!, bodyType: 'raw', disabledDefaultHeaders: [] },
    };
    expect(fieldDiffs(a, b)).toEqual([]);
  });

  it('a base recorded before pathParams existed does not light up every item', () => {
    const old = { ...base };
    for (const key of Object.keys(old)) if (key.endsWith('#pathParams')) delete old[key];
    expect(old[fieldHashKey('a', 'pathParams')]).toBeUndefined();
    expect(matchesSyncBase(old, synced()[0])).toBe(true);
    expect(pendingChanges(old, synced()[0])?.changed).toEqual([]);
  });
});

// Primeira sincronização depois da atualização: a base não tem
// `id#pathParams`, mas o hash do nó inteiro diz qual era o valor.
describe('base recorded before pathParams existed — first sync after the update', () => {
  const legacy = () => {
    const old = { ...base };
    for (const key of Object.keys(old)) if (key.endsWith('#pathParams')) delete old[key];
    return old;
  };

  it("your path param and their body merge, instead of falling into the review", () => {
    const local = col([req('a', { path: '9' }), req('g', { extra: grpc('{}') })]);
    const remote = col([req('a', { body: 'theirs' }), req('g', { extra: grpc('{}') })]);
    const r = rebaseCollections(local, remote, legacy(), new Set(['c']));
    expect(r.conflicts).toEqual([]);
    const a = r.merged[0].item![0];
    expect(a.request!.urlexport.variable![0].value).toBe('9');
    expect(a.request!.body).toBe('theirs');
  });

  it("their path param and your body merge too", () => {
    const local = col([req('a', { body: 'mine' }), req('g', { extra: grpc('{}') })]);
    const remote = col([req('a', { path: '7' }), req('g', { extra: grpc('{}') })]);
    const r = rebaseCollections(local, remote, legacy(), new Set(['c']));
    expect(r.conflicts).toEqual([]);
    const a = r.merged[0].item![0];
    expect(a.request!.urlexport.variable![0].value).toBe('7');
    expect(a.request!.body).toBe('mine');
  });

  it("the deduced value is the base's, whichever side changed it", () => {
    const old = legacy();
    const original = req('a');
    const fromLocal = withLegacyFieldHashes(old, req('a', { path: '9', body: 'x' }), original);
    const fromRemote = withLegacyFieldHashes(old, original, req('a', { path: '9', body: 'x' }));
    expect(fromLocal[fieldHashKey('a', 'pathParams')]).toBe(base[fieldHashKey('a', 'pathParams')]);
    expect(fromRemote[fieldHashKey('a', 'pathParams')]).toBe(base[fieldHashKey('a', 'pathParams')]);
  });

  it('both sides changing the path params is still a conflict', () => {
    const local = col([req('a', { path: '9' }), req('g', { extra: grpc('{}') })]);
    const remote = col([req('a', { path: '7' }), req('g', { extra: grpc('{}') })]);
    const r = rebaseCollections(local, remote, legacy(), new Set(['c']));
    expect(r.conflicts).toEqual(['a']);
  });

  it('without a matching node hash nothing is deduced (still the review)', () => {
    const old = { ...legacy(), a: 'not-the-real-hash' };
    const local = req('a', { path: '9' });
    const remote = req('a', { body: 'theirs' });
    expect(withLegacyFieldHashes(old, local, remote)).toBe(old);
    expect(fieldMergePlan(local, remote, old)).toBeNull();
  });

  it('Auto merge in the review also takes your path param and their body', () => {
    const local = req('a', { path: '9' });
    const remote = req('a', { body: 'theirs' });
    const node = {
      id: 'a',
      change: 'modified',
      local,
      remote,
      fields: fieldDiffs(local, remote),
    } as unknown as DiffNode;
    const r = resolveNode(node, { base: legacy(), conflicts: new Set(['a']) } as never);
    expect(r.kind).not.toBe('conflict');
  });
});
