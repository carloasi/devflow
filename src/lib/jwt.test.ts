import { describe, expect, it } from 'vitest'
import { isSessionToken, sameForSync, withoutSessionTokens } from './jwt'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'

describe('isSessionToken', () => {
  it('is a JWT in a variable named like a token', () => {
    expect(isSessionToken('accessToken', JWT)).toBe(true)
    expect(isSessionToken('bearer', JWT)).toBe(true)
    expect(isSessionToken('Authorization', JWT)).toBe(true)
  })

  it('leaves a fixed JWT service key and plain values alone', () => {
    expect(isSessionToken('serviceKey', JWT)).toBe(false)
    expect(isSessionToken('accessToken', 'not-a-jwt')).toBe(false)
  })
})

describe('withoutSessionTokens', () => {
  it('empties only the session tokens, keeping the variable', () => {
    const envs = [
      {
        id: 'e1',
        values: [
          { key: 'accessToken', value: JWT, enabled: true },
          { key: 'serviceKey', value: JWT, enabled: true },
          { key: 'baseUrl', value: 'https://x', enabled: true },
        ],
      },
    ]
    const out = withoutSessionTokens(envs)
    expect(out[0].values.map(v => v.value)).toEqual(['', JWT, 'https://x'])
    // Não mexe no original.
    expect(envs[0].values[0].value).toBe(JWT)
  })

  it('returns the same object when there is nothing to remove', () => {
    const env = { id: 'e1', values: [{ key: 'baseUrl', value: 'https://x' }] }
    expect(withoutSessionTokens([env])[0]).toBe(env)
  })
})

const syncEnv = (vals: Record<string, string>, isDirty = false) => ({
  id: 'e1',
  name: 'Dev',
  isDirty,
  values: Object.entries(vals).map(([key, value]) => ({ key, value, enabled: true, type: 'default' })),
})

describe('sameForSync', () => {
  it('token de sessão novo não conta como mudança', () => {
    expect(sameForSync(syncEnv({ url: 'a', bearerToken: '' }), syncEnv({ url: 'a', bearerToken: JWT }))).toBe(true)
  })
  it('qualquer outra mudança conta', () => {
    expect(sameForSync(syncEnv({ url: 'a' }), syncEnv({ url: 'b' }))).toBe(false)
    // JWT numa variável sem nome de token não é token de sessão: conta.
    expect(sameForSync(syncEnv({ serviceKey: '' }), syncEnv({ serviceKey: JWT }))).toBe(false)
  })
  it('ignora o isDirty', () => {
    expect(sameForSync(syncEnv({ url: 'a' }, true), syncEnv({ url: 'a' }, false))).toBe(true)
  })
})
