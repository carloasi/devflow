import { describe, it, expect } from 'vitest';
import { parsePostmanImport } from './usePostmanImport';
import type { CollectionItem } from '@/app/types/CollectionItem';

const collection = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  info: { name: 'Grupos B2B', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: items,
  ...extra,
});
const first = (raw: unknown) => parsePostmanImport(raw).collections![0] as CollectionItem;

describe('import Postman: URL sem "raw"', () => {
  it('mantém protocolo, porta e query', () => {
    const r = first(collection([{
      name: 'R',
      request: {
        method: 'GET',
        url: {
          protocol: 'http', host: ['localhost'], port: '8080', path: ['api', 'v1'],
          query: [{ key: 'a', value: '1' }, { key: 'off', value: 'x', disabled: true }],
        },
      },
    }]));
    expect(r.request!.url).toBe('http://localhost:8080/api/v1?a=1');
  });

  it('host com variável fica como está, sem https:// na frente', () => {
    const r = first(collection([{ name: 'R', request: { url: { host: ['{{baseUrl}}'], path: ['x'] } } }]));
    expect(r.request!.url).toBe('{{baseUrl}}/x');
  });
});

describe('import Postman v2.0: request como texto', () => {
  it('"request": "https://..." vira um GET com essa URL', () => {
    const r = first(collection([{ name: 'R', request: 'https://api.test/ping' }]));
    expect(r.type).toBe('request');
    expect(r.method).toBe('GET');
    expect(r.request!.url).toBe('https://api.test/ping');
  });
});

describe('import Postman: corpo urlencoded', () => {
  it('vira o texto a=1&b=2 com o Content-Type do formulário', () => {
    const r = first(collection([{
      name: 'R',
      request: {
        method: 'POST', url: 'https://x',
        body: { mode: 'urlencoded', urlencoded: [
          { key: 'a', value: '1' }, { key: 'b', value: 'c d' }, { key: 'off', value: '2', disabled: true },
        ] },
      },
    }]));
    expect(r.request!.body).toBe('a=1&b=c%20d');
    expect(r.request!.headers).toContainEqual({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true });
  });
});

describe('import Postman: variáveis da collection', () => {
  it('vêm no resultado (iam pro lixo e {{baseUrl}} parava de resolver)', () => {
    const result = parsePostmanImport(collection([], {
      variable: [{ key: 'baseUrl', value: 'https://api.test' }, { key: 'off', value: 'x', disabled: true }],
    }));
    expect(result.collectionVariables).toEqual([
      { key: 'baseUrl', value: 'https://api.test', enabled: true, type: 'default' },
      { key: 'off', value: 'x', enabled: false, type: 'default' },
    ]);
    expect(result.collectionName).toBe('Grupos B2B');
  });
});

describe('import Postman: o que o DevFlow não suporta vira aviso', () => {
  it('auth digest, API key na query, form-data e scripts de pasta/collection', () => {
    const result = parsePostmanImport(collection([
      { name: 'Digest', request: { url: 'https://x', auth: { type: 'digest', digest: [] } } },
      { name: 'Key', request: { url: 'https://x', auth: { type: 'apikey', apikey: [
        { key: 'key', value: 'k' }, { key: 'value', value: 'v' }, { key: 'in', value: 'query' },
      ] } } },
      { name: 'Upload', request: { url: 'https://x', body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file' }] } } },
      { name: 'Pasta', event: [{ listen: 'prerequest', script: { exec: ['x()'] } }], item: [] },
    ], { event: [{ listen: 'test', script: { exec: ['y()'] } }] }));
    const text = result.warnings.join('\n');
    expect(text).toMatch(/Digest.*digest/);
    expect(text).toMatch(/Key.*query/);
    expect(text).toMatch(/Upload.*form-data/);
    expect(text).toMatch(/Pasta.*script/);
    expect(text).toMatch(/collection.*script/i);
  });
});
