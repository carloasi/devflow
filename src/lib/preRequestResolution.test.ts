import { describe, expect, it } from 'vitest';
import { resolveAfterPreRequest, RequestParts } from './preRequestResolution';

const resolve = (text: string, env: Record<string, string>) =>
  text.replace(/\{\{(.*?)\}\}/g, (_, key) => env[key.trim()] ?? `{{${key.trim()}}}`);

const template = {
  url: '{{baseUrl}}/quote?d={{departure}}',
  headers: { Authorization: 'Bearer {{token}}' } as Record<string, string>,
  body: '{"departure":"{{departure}}","name":"{{eventName}}"}',
};

const rebuild = (env: Record<string, string>): RequestParts => ({
  url: resolve(template.url, env),
  headers: Object.fromEntries(Object.entries(template.headers).map(([k, v]) => [k, resolve(v, env)])),
  body: resolve(template.body, env),
});

describe('resolveAfterPreRequest', () => {
  const oldEnv = { baseUrl: 'https://api', token: 'abc', eventName: 'Festa' };
  const before = rebuild(oldEnv);

  it('variável criada no pre-request vale na mesma request', () => {
    const env = { ...oldEnv, departure: '2026-11-10' };
    // O script só fez pm.environment.set — não mexeu em pm.request.
    const result = resolveAfterPreRequest({ before, after: { ...before }, rebuild, env, resolve });
    expect(result.url).toBe('https://api/quote?d=2026-11-10');
    expect(result.body).toBe('{"departure":"2026-11-10","name":"Festa"}');
  });

  it('variável alterada no pre-request troca o valor antigo', () => {
    const env = { ...oldEnv, token: 'novo' };
    const result = resolveAfterPreRequest({ before, after: { ...before }, rebuild, env, resolve });
    expect(result.headers.Authorization).toBe('Bearer novo');
  });

  it('o que o script reescreveu fica, só resolvendo os {{...}} que sobraram', () => {
    const env = { ...oldEnv, departure: '2026-12-01' };
    const after = { ...before, body: '{"departure":"{{departure}}","name":"Trocado pelo script"}' };
    const result = resolveAfterPreRequest({ before, after, rebuild, env, resolve });
    expect(result.body).toBe('{"departure":"2026-12-01","name":"Trocado pelo script"}');
  });

  it('header adicionado pelo script é mantido', () => {
    const after = { ...before, headers: { ...before.headers, 'X-Trace': '{{eventName}}' } };
    const result = resolveAfterPreRequest({ before, after, rebuild, env: oldEnv, resolve });
    expect(result.headers['X-Trace']).toBe('Festa');
    expect(result.headers.Authorization).toBe('Bearer abc');
  });

  it('URL vazia devolvida pelo script conta como "não mexeu"', () => {
    const result = resolveAfterPreRequest({ before, after: { url: '' }, rebuild, env: oldEnv, resolve });
    expect(result.url).toBe(before.url);
  });

  it('se remontar falhar, fica o que foi montado antes', () => {
    const result = resolveAfterPreRequest({
      before,
      after: undefined,
      rebuild: () => {
        throw new Error('GraphQL variables inválidas');
      },
      env: oldEnv,
      resolve,
    });
    expect(result).toEqual(before);
  });
});
