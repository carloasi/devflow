import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { nodeHashes } from '@/lib/syncBase';
import { rebaseCollections } from './rebase';
import { buildRemoteChangePreview, commitChangeItems, detailItems, initialsOf, safeFieldText } from './remoteChangeAlert';

const req = (id: string, patch: Partial<NonNullable<CollectionItem['request']>> = {}): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'POST',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body: '', ...patch },
});
// `raw` é uma função (texto real, só pra edição à mão): fora da comparação de forma.
const withoutRaw = <T extends { raw?: unknown }>({ raw: _raw, ...rest }: T) => rest;
const col = (items: CollectionItem[]): CollectionItem[] => [{ id: 'root', name: 'Barramento B2B - Dev', type: 'folder', item: items }];

describe('buildRemoteChangePreview', () => {
  it('lists what changed on GitHub with a before/after per field', () => {
    const baseTree = col([req('pay', { body: 'a' }), req('ord')]);
    const local = col([req('pay', { body: 'a' }), req('ord')]);
    const remote = col([req('pay', { body: 'b' }), req('ord'), req('new')]);
    const result = rebaseCollections(local, remote, nodeHashes(baseTree), new Set());
    const preview = buildRemoteChangePreview(result);

    expect(preview.conflicts).toEqual([]);
    const pay = preview.items.find(i => i.id === 'pay')!;
    expect(pay.change).toBe('changed');
    expect(pay.fields.map(withoutRaw)).toEqual([{ field: 'body', before: 'a', after: 'b', base: null }]);
    expect(preview.items.find(i => i.id === 'new')?.change).toBe('new');
  });

  it('puts conflicts first, with every differing field', () => {
    const baseTree = col([req('pay', { body: 'a' })]);
    const local = col([req('pay', { body: 'mine' })]);
    const remote = col([req('pay', { body: 'theirs' })]);
    const result = rebaseCollections(local, remote, nodeHashes(baseTree), new Set(['root']));
    const preview = buildRemoteChangePreview(result);
    expect(preview.conflicts).toEqual(['Barramento B2B - Dev / pay']);
    expect(preview.items[0]).toMatchObject({ id: 'pay', conflict: true, fields: [{ field: 'body', before: 'mine', after: 'theirs' }] });
  });
});

describe('raw field text (hand editing in the preview)', () => {
  it('is masked in the preview, real in raw(), and never serialized', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
    const auth = (t: string) => ({ type: 'bearer', token: t }) as never;
    const baseTree = col([req('pay', { auth: auth('') })]);
    const local = col([req('pay', { auth: auth('') })]);
    const remote = col([req('pay', { auth: auth(token) })]);
    const result = rebaseCollections(local, remote, nodeHashes(baseTree), new Set());
    const field = buildRemoteChangePreview(result).items[0].fields.find(f => f.field === 'auth')!;
    expect(field.after).not.toContain('payload');
    expect(field.raw?.().after).toContain(token);
    expect(JSON.stringify(field)).not.toContain('payload');
  });

  it('is not clipped', () => {
    const long = 'x'.repeat(7000);
    const result = rebaseCollections(col([req('pay')]), col([req('pay', { body: long })]), nodeHashes(col([req('pay')])), new Set());
    const field = buildRemoteChangePreview(result).items[0].fields[0];
    expect(field.after.length).toBeLessThan(long.length);
    expect(field.raw?.().after).toBe(long);
  });
});

describe('safeFieldText', () => {
  it('hides secrets in auth and in credential-like headers', () => {
    const auth = safeFieldText('auth', { type: 'bearer', token: 'eyJhbGciOiJIUzI1NiJ9.payload.signature' });
    expect(auth).not.toContain('payload');
    const headers = safeFieldText('headers', [{ key: 'Authorization', value: 'Bearer super-secret-token-123456' }]);
    expect(headers).not.toContain('super-secret-token-123456');
  });
});

describe('initialsOf', () => {
  it('makes avatar initials', () => {
    expect(initialsOf('Matheus Rodrigues')).toBe('MR');
    expect(initialsOf('carlos.silva')).toBe('CS');
    expect(initialsOf('octocat')).toBe('OC');
    expect(initialsOf('')).toBe('?');
  });
});

describe('base text for the three-pane view', () => {
  it('fills the last synced value when the base item is known', () => {
    const baseTree = col([req('pay', { body: 'base' })]);
    const local = col([req('pay', { body: 'base' })]);
    const remote = col([req('pay', { body: 'theirs' })]);
    const result = rebaseCollections(local, remote, nodeHashes(baseTree), new Set());
    const baseItem = baseTree[0].item![0];
    const preview = buildRemoteChangePreview(result, [], node => (node.id === 'pay' ? baseItem : undefined));
    expect(withoutRaw(preview.items[0].fields[0])).toEqual({ field: 'body', before: 'base', after: 'theirs', base: 'base' });
    expect(preview.items[0].fields[0].raw?.()).toEqual({ before: 'base', after: 'theirs', base: 'base' });
  });

  it('detailItems builds the same items from a merge report', () => {
    const baseTree = col([req('pay', { body: 'a' })]);
    const result = rebaseCollections(col([req('pay', { body: 'a' })]), col([req('pay', { body: 'b' })]), nodeHashes(baseTree), new Set());
    const items = detailItems(result.incomingDetails, result.nodes);
    expect(items[0]).toMatchObject({ id: 'pay', change: 'changed', fields: [{ field: 'body', before: 'a', after: 'b', base: null }] });
  });
});

describe('commitChangeItems', () => {
  it('shows what the commit changed, with the local value beside it', () => {
    const older = col([req('pay', { body: 'a' }), req('ord')]);
    const newer = col([req('pay', { body: 'b' }), req('ord')]);
    const local = col([req('pay', { body: 'mine' }), req('ord')]);
    const items = commitChangeItems(older, newer, local);
    expect(items).toEqual([
      { id: 'pay', path: ['Barramento B2B - Dev', 'pay'], change: 'changed', conflict: false, fields: [{ field: 'body', before: 'mine', after: 'b', base: 'a' }] },
    ]);
  });

  it('a request added by the commit diffs against an empty base', () => {
    const older = col([req('pay')]);
    const newer = col([req('pay'), req('copy', { body: 'x' })]);
    const items = commitChangeItems(older, newer, newer);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'copy', change: 'new' });
    const body = items[0].fields.find(f => f.field === 'body')!;
    // Já está aqui: a sua versão é igual à do GitHub.
    expect(body).toEqual({ field: 'body', before: 'x', after: 'x', base: '' });
    expect(items[0].fields.every(f => f.base === '')).toBe(true);
  });

  it('a request deleted by the commit diffs to an empty GitHub side', () => {
    const items = commitChangeItems(col([req('pay', { body: 'a' })]), col([]), col([]));
    expect(items[0]).toMatchObject({ id: 'pay', change: 'deleted' });
    expect(items[0].fields.find(f => f.field === 'body')).toEqual({ field: 'body', before: '', after: '', base: 'a' });
  });

  it('a file created by the commit lists everything as new', () => {
    const items = commitChangeItems(null, col([req('pay')]), []);
    expect(items.map(i => [i.id, i.change])).toEqual([['root', 'new']]);
  });
});
