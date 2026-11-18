import { describe, expect, it } from 'vitest';
import type { Environment } from '@/app/types/Environment';
import { withLocalOnlyValues } from './pulledEnvironments';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
const v = (key: string, value: string) => ({ key, value, type: 'default', enabled: true });
const env = (id: string, values: Environment['values'], extra: Partial<Environment> = {}): Environment => ({
  id,
  name: id,
  values,
  ...extra,
});

describe('withLocalOnlyValues', () => {
  it('keeps the local session token when GitHub sent it empty', () => {
    const local = [env('dev', [v('accessToken', JWT), v('baseUrl', 'https://old')])];
    const incoming = [env('dev', [v('accessToken', ''), v('baseUrl', 'https://new')])];
    const out = withLocalOnlyValues(incoming, local);
    expect(out[0].values).toEqual([v('accessToken', JWT), v('baseUrl', 'https://new')]);
  });

  it('keeps a real value that came from GitHub', () => {
    const other = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.b3V0cmE';
    const out = withLocalOnlyValues([env('dev', [v('accessToken', other)])], [env('dev', [v('accessToken', JWT)])]);
    expect(out[0].values[0].value).toBe(other);
  });

  it('does not bring back a plain variable emptied on GitHub', () => {
    const out = withLocalOnlyValues([env('dev', [v('baseUrl', '')])], [env('dev', [v('baseUrl', 'https://x')])]);
    expect(out[0].values[0].value).toBe('');
  });

  it('keeps the local color and matches by name when the ids differ', () => {
    const local = [{ ...env('local-id', [v('accessToken', JWT)], { color: 3 }), name: 'Dev' }];
    const incoming = [{ ...env('remote-id', [v('accessToken', '')]), name: 'Dev' }];
    const out = withLocalOnlyValues(incoming, local);
    expect(out[0]).toMatchObject({ id: 'remote-id', color: 3 });
    expect(out[0].values[0].value).toBe(JWT);
  });
});
