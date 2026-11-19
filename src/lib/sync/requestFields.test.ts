import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { fieldDiffs } from '@/lib/collectionDiff';
import { matchesSyncBase, nodeHashes, pendingChanges } from '@/lib/syncBase';
import { rebaseCollections } from './rebase';
import { fieldHashKey } from './fieldMerge';

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
