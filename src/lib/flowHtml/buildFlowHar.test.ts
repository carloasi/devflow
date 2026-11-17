import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { buildFlowData } from './buildFlowHtml';
import { buildFlowHar } from './buildFlowHar';

const folder = {
  id: 'f',
  name: 'Flow 106',
  type: 'folder',
  item: [
    {
      id: 't', name: '00 - Login', type: 'request',
      request: { url: '', urlexport: { host: [], path: [], raw: '' }, headers: [], auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: '{{msal}}', enabled: true }] } },
    },
    {
      id: 'a', name: '01 - Token v1', type: 'request', method: 'POST', description: 'Gets a token',
      request: {
        url: '{{urlAuthorization}}/api/v1/token?scope=b2b&x=a%20b', urlexport: { host: [], path: [], raw: '' },
        headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }, { key: 'Ocp-Apim-Subscription-Key', value: '{{apiKey}}', enabled: true }],
        body: '{"user":"{{user}}"}',
        scripts: { preRequest: '', postResponse: 'pm.environment.set("bearerToken", pm.response.json().token);' },
      },
    },
  ],
} as unknown as CollectionItem;

describe('buildFlowHar', () => {
  const envs = [
    { name: 'tst-internal', envMap: { urlAuthorization: 'https://general-api-tst.azul.corp/auth', apiKey: 'internal-key-123', user: 'ana' } },
    { name: 'tst-public', envMap: { urlAuthorization: 'https://general-api-tst.voeazul.com.br/auth', apiKey: 'public-key-456', user: 'bia' } },
  ];

  it('describes the HTTP steps with the chosen environment resolved', () => {
    const flow = buildFlowData(folder, { path: ['Sprints', 'Flow 106'], environments: envs, includeSecrets: true });
    const har = buildFlowHar(flow, { envName: 'tst-public', now: new Date('2026-11-05T12:00:00Z') });

    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(1);
    const { request, comment } = har.log.entries[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://general-api-tst.voeazul.com.br/auth/api/v1/token?scope=b2b&x=a%20b');
    expect(request.queryString).toEqual([{ name: 'scope', value: 'b2b' }, { name: 'x', value: 'a b' }]);
    expect(request.headers).toContainEqual({ name: 'Ocp-Apim-Subscription-Key', value: 'public-key-456' });
    expect(request.postData).toEqual({ mimeType: 'application/json', text: '{"user":"bia"}' });
    expect(comment).toContain('Post-response script');
    expect(har.log.comment).toContain('Left out (no HTTP request to describe): 00 - Login');
  });

  it('keeps secrets out unless they were included', () => {
    const flow = buildFlowData(folder, { path: [], environments: envs });
    const header = buildFlowHar(flow).log.entries[0].request.headers.find(h => h.name === 'Ocp-Apim-Subscription-Key');
    expect(header?.value).toBe('');
  });

  it('builds the basic auth header from the resolved username and password', () => {
    const basic = {
      id: 'f', name: 'F', type: 'folder',
      item: [{ id: 'b', name: 'Basic', type: 'request', method: 'GET',
        request: { url: 'https://a/x', urlexport: { host: [], path: [], raw: '' }, headers: [], auth: { type: 'basic', username: '{{user}}', password: '{{pass}}' } } }],
    } as unknown as CollectionItem;
    // "pass" é nome de credencial: secreta, só vai pro arquivo com includeSecrets.
    const flow = buildFlowData(basic, { path: [], environments: [{ name: 'tst', envMap: { user: 'ana', pass: 'ção' } }], includeSecrets: true });
    const header = buildFlowHar(flow).log.entries[0].request.headers.find(h => h.name === 'Authorization');
    expect(header?.value).toBe(`Basic ${Buffer.from('ana:ção', 'utf8').toString('base64')}`);
  });
});
