import { describe, it, expect } from 'vitest';
import { toPostmanCollection, exportFileName, countSkippedGrpc } from './postmanExport';
import type { CollectionItem, RequestDetails } from '@/app/types/CollectionItem';

const req = (patch: Partial<RequestDetails> = {}): RequestDetails => ({
  url: 'https://api.test/x',
  urlexport: { raw: 'https://api.test/x', host: [], path: [] },
  headers: [],
  ...patch,
});
const collection = (request: RequestDetails, extra: Partial<CollectionItem> = {}): CollectionItem =>
  ({
    id: 'col', name: 'Col', type: 'folder',
    item: [{ id: 'r', name: 'R', type: 'request', method: 'POST', request, ...extra } as CollectionItem],
  }) as CollectionItem;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const firstRequest = (c: CollectionItem): any => (toPostmanCollection(c).item[0] as any).request;

describe('export Postman v2.1', () => {
  it('corpo com tipo "none" não vai: o app não o envia, o Postman enviaria', () => {
    const r = firstRequest(collection(req({ bodyType: 'none', body: '{"a":1}' })));
    expect(r.body).toBeUndefined();
  });

  it('OAuth2: leva todos os campos guardados, não só uma lista fixa', () => {
    const r = firstRequest(collection(req({
      auth: {
        type: 'oauth2',
        oauth2: [
          { key: 'grantType', value: 'client_credentials', enabled: true },
          { key: 'client_authentication', value: 'body', enabled: true },
          { key: 'addTokenTo', value: 'header', enabled: true },
        ],
      },
    })));
    const keys = r.auth.oauth2.map((e: { key: string }) => e.key);
    expect(keys).toEqual(['grantType', 'client_authentication', 'addTokenTo']);
  });

  it('OAuth2: não inventa campos vazios que a request não tem', () => {
    const r = firstRequest(collection(req({
      auth: { type: 'oauth2', oauth2: [{ key: 'clientId', value: 'abc', enabled: true }] },
    })));
    expect(r.auth.oauth2).toEqual([{ key: 'clientId', value: 'abc', type: 'string' }]);
  });

  it('OAuth2: campo desligado fica de fora, como no app', () => {
    const r = firstRequest(collection(req({
      auth: { type: 'oauth2', oauth2: [{ key: 'clientSecret', value: 's', enabled: false }] },
    })));
    expect(r.auth.oauth2).toEqual([]);
  });

  it('header sem "enabled" (vindo de import antigo) continua ligado', () => {
    const headers = [{ key: 'X-A', value: '1' }] as RequestDetails['headers'];
    const r = firstRequest(collection(req({ headers })));
    expect(r.header[0].disabled).toBe(false);
  });

  it('linha de header vazia não vai pro arquivo', () => {
    const r = firstRequest(collection(req({
      headers: [{ key: '', value: '', enabled: true }, { key: 'X-A', value: '1', enabled: true }],
    })));
    expect(r.header.map((h: { key: string }) => h.key)).toEqual(['X-A']);
  });
});

describe('exportFileName', () => {
  it('troca caracteres que o Windows não aceita em nome de arquivo', () => {
    expect(exportFileName('Order/Groups: v2?')).toBe('Order-Groups- v2-.json');
  });
  it('nome vazio vira "collection"', () => {
    expect(exportFileName('   ')).toBe('collection.json');
  });
});

describe('exportFileName: barra invertida e espaços', () => {
  it('troca \ também e mantém espaços e hífens do nome', () => {
    expect(exportFileName('Flow 99 - Reserva\\B2B')).toBe('Flow 99 - Reserva-B2B.json');
  });
});

describe('countSkippedGrpc', () => {
  it('conta as gRPC em qualquer nível', () => {
    const c = {
      id: 'c', name: 'C', type: 'folder',
      item: [
        { id: 'g1', name: 'G1', type: 'request', protocol: 'grpc' },
        { id: 'f', name: 'F', type: 'folder', item: [{ id: 'g2', name: 'G2', type: 'request', protocol: 'grpc' }] },
        { id: 'h', name: 'H', type: 'request' },
      ],
    } as CollectionItem;
    expect(countSkippedGrpc(c)).toBe(2);
  });
});
