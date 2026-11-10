import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { nodeHashes } from '@/lib/syncBase';
import { fieldMergePlan, fieldOrigin } from './fieldMerge';

const req = (patch: Partial<NonNullable<CollectionItem['request']>> = {}, extra: Partial<CollectionItem> = {}): CollectionItem => ({
  id: 'r',
  name: 'Token',
  type: 'request',
  method: 'POST',
  request: { url: '/token', urlexport: { host: [], path: [], raw: '/token' }, headers: [], body: '{}', ...patch },
  ...extra,
});

const base = nodeHashes([req()]);

describe('fieldOrigin', () => {
  it('tells who changed a field since the base', () => {
    expect(fieldOrigin(base, 'r', 'body', '{"a":1}', '{}')).toBe('here');
    expect(fieldOrigin(base, 'r', 'body', '{}', '{"b":2}')).toBe('github');
    expect(fieldOrigin(base, 'r', 'body', '{"a":1}', '{"b":2}')).toBe('both');
    expect(fieldOrigin(base, 'r', 'body', '{"a":1}', '{"a":1}')).toBe('same');
    expect(fieldOrigin(null, 'r', 'body', '{"a":1}', '{}')).toBe('unknown');
  });
});

describe('fieldMergePlan', () => {
  it('lists the fields only I changed, with the URL carrying its urlexport', () => {
    const local = req({ url: '/v2/token', urlexport: { host: [], path: ['v2', 'token'], raw: '/v2/token' } });
    const remote = req({ body: '{"grant":"x"}' });

    expect(fieldMergePlan(local, remote, base)).toEqual({
      url: '/v2/token',
      urlexport: { host: [], path: ['v2', 'token'], raw: '/v2/token' },
    });
  });

  it('returns null when one field changed on both sides', () => {
    expect(fieldMergePlan(req({ body: 'mine' }), req({ body: 'theirs' }), base)).toBeNull();
  });

  it('allows both sides reaching the same value', () => {
    expect(fieldMergePlan(req({ body: 'same' }, { name: 'Mine' }), req({ body: 'same' }), base)).toEqual({ name: 'Mine' });
  });

  it('returns null when something outside the known fields changed here', () => {
    expect(fieldMergePlan(req({ bodyType: 'graphql' }), req({ body: 'theirs' }), base)).toBeNull();
  });
});
