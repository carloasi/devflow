import { describe, expect, it } from 'vitest'
import { isSessionToken, withoutSessionTokens } from './jwt'

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
