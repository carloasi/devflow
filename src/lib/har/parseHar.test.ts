import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { buildFlowData } from '@/lib/flowHtml/buildFlowHtml';
import { buildFlowHar } from '@/lib/flowHtml/buildFlowHar';
import { isHar, parseHar } from './parseHar';

// Recorte de um HAR exportado pelo Chrome DevTools (HTTP/2, com recursos da página).
const chromeHar = {
  log: {
    version: '1.2',
    creator: { name: 'WebInspector', version: '537.36' },
    pages: [],
    entries: [
      {
        _resourceType: 'fetch',
        request: {
          method: 'GET',
          url: 'https://api.example.com/v1/users?page=2&q=a%20b',
          httpVersion: 'http/2.0',
          headers: [
            { name: ':authority', value: 'api.example.com' },
            { name: ':method', value: 'GET' },
            { name: ':path', value: '/v1/users?page=2&q=a%20b' },
            { name: ':scheme', value: 'https' },
            { name: 'accept', value: 'application/json' },
            { name: 'authorization', value: 'Bearer abc' },
            { name: 'cookie', value: 'sid=1' },
          ],
          queryString: [{ name: 'page', value: '2' }, { name: 'q', value: 'a%20b' }],
          cookies: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: { status: 200 },
      },
      {
        _resourceType: 'image',
        request: { method: 'GET', url: 'https://cdn.example.com/logo.png', headers: [] },
      },
      {
        _resourceType: 'script',
        request: { method: 'GET', url: 'https://cdn.example.com/app.js', headers: [] },
      },
      {
        request: { method: 'GET', url: 'data:image/png;base64,AAAA', headers: [] },
      },
      {
        _resourceType: 'xhr',
        request: {
          method: 'POST',
          url: 'https://api.example.com/v1/users',
          headers: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Content-Length', value: '15' },
          ],
          postData: { mimeType: 'application/json', text: '{"name":"Ana"}' },
        },
      },
      {
        _resourceType: 'document',
        request: {
          method: 'POST',
          url: 'https://auth.example.com/login',
          headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
          postData: {
            mimeType: 'application/x-www-form-urlencoded',
            params: [{ name: 'user', value: 'ana' }, { name: 'pass', value: 'a&b c' }],
          },
        },
      },
      {
        _resourceType: 'fetch',
        request: {
          method: 'PUT',
          url: 'https://auth.example.com/upload',
          headers: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=XyZ' }],
          postData: {
            mimeType: 'multipart/form-data; boundary=XyZ',
            params: [{ name: 'title', value: 'hi' }, { name: 'file', fileName: 'a.txt', contentType: 'text/plain', value: 'hello' }],
          },
        },
      },
    ],
  },
};

const requestsOf = (item: CollectionItem): CollectionItem[] =>
  item.type === 'request' ? [item] : (item.item ?? []).flatMap(requestsOf);

describe('parseHar', () => {
  it('recognises a HAR by its content', () => {
    expect(isHar(chromeHar)).toBe(true);
    expect(isHar({ info: {}, item: [] })).toBe(false);
    expect(parseHar({ openapi: '3.0.0' }).collection).toBeNull();
  });

  it('imports a Chrome DevTools HAR, one request per API entry, grouped by host', () => {
    const { collection, warnings } = parseHar(chromeHar, 'session');
    expect(collection?.name).toBe('session');
    expect(collection?.item?.map(f => f.name)).toEqual(['api.example.com', 'auth.example.com']);
    expect(warnings.join()).toContain('3 entries left out');

    const [list, create, login, upload] = requestsOf(collection!);
    expect(list.name).toBe('GET /v1/users');
    expect(list.method).toBe('GET');
    expect(list.request?.url).toBe('https://api.example.com/v1/users?page=2&q=a%20b');
    expect(list.request?.headers).toEqual([
      { key: 'accept', value: 'application/json', enabled: true },
      { key: 'authorization', value: 'Bearer abc', enabled: true },
      { key: 'cookie', value: 'sid=1', enabled: true },
    ]);
    expect(list.request?.body).toBe('');
    expect(list.request?.bodyType).toBe('none');

    expect(create.name).toBe('POST /v1/users');
    expect(create.request?.headers).toEqual([{ key: 'Content-Type', value: 'application/json', enabled: true }]);
    expect(create.request?.body).toBe('{"name":"Ana"}');
    expect(create.request?.bodyType).toBe('raw');

    expect(login.request?.body).toBe('user=ana&pass=a%26b%20c');

    expect(upload.method).toBe('PUT');
    expect(upload.request?.body).toBe(
      '--XyZ\r\nContent-Disposition: form-data; name="title"\r\n\r\nhi\r\n' +
        '--XyZ\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n' +
        '--XyZ--\r\n',
    );
  });

  it('keeps a single host flat and appends queryString when the URL has none', () => {
    const { collection } = parseHar({
      log: { entries: [{ request: { method: 'delete', url: 'https://x.io/a/b', queryString: [{ name: 'id', value: '1 2' }] } }] },
    });
    expect(collection?.item).toHaveLength(1);
    const [req] = collection!.item!;
    expect(req.type).toBe('request');
    expect(req.name).toBe('DELETE /a/b');
    expect(req.request?.url).toBe('https://x.io/a/b?id=1%202');
  });

  it('reports a HAR with no HTTP request', () => {
    const result = parseHar({ log: { entries: [] } });
    expect(result.collection).toBeNull();
    expect(result.warnings).toContain('No HTTP request found in this HAR.');
  });

  it('round-trips a HAR generated by buildFlowHar', () => {
    const folder = {
      id: 'f', name: 'Flow', type: 'folder',
      item: [
        {
          id: 'a', name: 'Token', type: 'request', method: 'POST',
          request: {
            url: '{{base}}/api/v1/token?scope=b2b&x=a%20b', urlexport: { host: [], path: [], raw: '' },
            headers: [
              { key: 'Content-Type', value: 'application/json', enabled: true },
              { key: 'Ocp-Apim-Subscription-Key', value: '{{apiKey}}', enabled: true },
            ],
            body: '{"user":"{{user}}"}',
          },
        },
        {
          id: 'b', name: 'Me', type: 'request', method: 'GET',
          request: { url: '{{base}}/api/v1/me', urlexport: { host: [], path: [], raw: '' }, headers: [{ key: 'Accept', value: '*/*', enabled: true }] },
        },
      ],
    } as unknown as CollectionItem;
    const flow = buildFlowData(folder, {
      path: ['Flow'],
      environments: [{ name: 'tst', envMap: { base: 'https://api.test.io', apiKey: 'k-1', user: 'ana' } }],
      includeSecrets: true,
    });
    const har = buildFlowHar(flow);
    const imported = requestsOf(parseHar(JSON.parse(JSON.stringify(har)), 'Flow').collection!);

    expect(imported).toHaveLength(har.log.entries.length);
    imported.forEach((item, i) => {
      const { request } = har.log.entries[i];
      expect(item.method).toBe(request.method);
      expect(item.request?.url).toBe(request.url);
      expect(item.request?.headers.map(h => ({ name: h.key, value: h.value }))).toEqual(request.headers);
      expect(item.request?.body).toBe(request.postData?.text ?? '');
    });
    expect(imported[0].request?.body).toBe('{"user":"ana"}');
  });
});
