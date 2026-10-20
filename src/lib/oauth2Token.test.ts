import { describe, expect, it } from 'vitest';
import { describeToken, readOAuth2Config } from './oauth2Token';

const b64url = (obj: object) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: object) => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;

describe('describeToken', () => {
  it('lê validade, usuário, audience e scopes sem expor o token', () => {
    const now = Date.UTC(2026, 9, 9, 12, 0, 0);
    const token = jwt({
      exp: now / 1000 + 3600,
      upn: 'carlos@example.com',
      name: 'Carlos',
      aud: 'api://grupos',
      scp: 'Quote.Read Quote.Write',
      tid: 'tenant-1',
      azp: 'app-1',
    });
    const info = describeToken(token, now);
    expect(info).toMatchObject({
      readable: true,
      expiresInSeconds: 3600,
      user: 'carlos@example.com',
      audience: 'api://grupos',
      scopes: ['Quote.Read', 'Quote.Write'],
      tenantId: 'tenant-1',
      appId: 'app-1',
    });
    expect(JSON.stringify(info)).not.toContain(token);
  });

  it('token opaco (não JWT) só é marcado como ilegível', () => {
    expect(describeToken('abc123')).toEqual({ readable: false });
  });
});

describe('readOAuth2Config', () => {
  it('resolve variáveis e aponta o que falta', () => {
    const auth = {
      type: 'oauth2' as const,
      oauth2: [
        { key: 'authUrl', value: '{{authBase}}/authorize', enabled: true },
        { key: 'clientId', value: 'abc', enabled: true },
        { key: 'accessToken', value: '{{msalToken}}', enabled: true },
      ],
    };
    const { config, accessTokenField, missing } = readOAuth2Config(auth, t =>
      t.replace('{{authBase}}', 'https://login.example.com')
    );
    expect(config.authUrl).toBe('https://login.example.com/authorize');
    expect(accessTokenField).toBe('{{msalToken}}');
    expect(missing).toEqual(['Access Token URL', 'Client Secret', 'Callback URL']);
  });
});
