import { describe, it, expect } from 'vitest';
import { createSecretRedactor, isSecretVariable } from './redactSecrets';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

describe('isSecretVariable', () => {
  it('reconhece credencial pelo nome', () => {
    expect(isSecretVariable('accessToken', 'abc123opaque')).toBe(true);
    expect(isSecretVariable('apiKey', 'k-998877')).toBe(true);
    expect(isSecretVariable('clientSecret', 's3cr3t!!')).toBe(true);
  });

  it('reconhece JWT pelo valor, qualquer que seja o nome', () => {
    expect(isSecretVariable('msal', JWT)).toBe(true);
  });

  it('não trata como segredo valores curtos, referências e URLs sem query', () => {
    expect(isSecretVariable('useAuth', 'true')).toBe(false);
    expect(isSecretVariable('token', '{{msal}}')).toBe(false);
    expect(isSecretVariable('authUrl', 'https://login.microsoftonline.com/tenant/oauth2')).toBe(false);
    expect(isSecretVariable('bookingId', 'BK-123456')).toBe(false);
  });

  it('URL com query string em nome de credencial continua segredo', () => {
    expect(isSecretVariable('authUrl', 'https://x/cb?code=abcdef')).toBe(true);
  });
});

describe('createSecretRedactor', () => {
  it('troca toda ocorrência do segredo pelo nome da variável', () => {
    const redact = createSecretRedactor([{ msal: JWT, baseUrl: 'https://api' }]);
    expect(redact(`Bearer ${JWT} e de novo ${JWT}`)).toBe('Bearer {{msal}} e de novo {{msal}}');
    expect(redact('https://api/x')).toBe('https://api/x');
  });

  it('usa também o que os scripts gravaram e o env de saída', () => {
    const redact = createSecretRedactor([{}, { apiKey: 'k-998877' }], [{ key: 'token', value: 'opaque-zzz' }]);
    expect(redact('?api_key=k-998877&t=opaque-zzz')).toBe('?api_key={{apiKey}}&t={{token}}');
  });

  it('troca o segredo maior antes do que está contido nele', () => {
    const redact = createSecretRedactor([{ token: 'abcdef', fullToken: 'abcdef-123456' }]);
    expect(redact('abcdef-123456 / abcdef')).toBe('{{fullToken}} / {{token}}');
  });

  it('aceita texto vazio ou ausente', () => {
    const redact = createSecretRedactor([{ token: 'abcdef' }]);
    expect(redact(undefined)).toBe('');
    expect(redact('')).toBe('');
  });
});
