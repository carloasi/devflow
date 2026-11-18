import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { REDACTED } from './redactSecrets';
import { applyRequestPatch, moveItem } from './treeEdit';

const req = (id: string, extra: Partial<NonNullable<CollectionItem['request']>> = {}): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'GET',
  request: {
    url: '{{baseUrl}}/x/:id',
    urlexport: { host: [], path: [], raw: '', variable: [{ id: 'v1', key: 'id', value: '1', enabled: true }] },
    headers: [{ key: 'Ocp-Apim-Subscription-Key', value: 'segredo-real', enabled: true }],
    auth: { type: 'basic', username: 'u', password: 'senha-real' },
    ...extra,
  },
});
const folder = (id: string, items: CollectionItem[]): CollectionItem => ({ id, name: id, type: 'folder', item: items });
const ids = (tree: CollectionItem[]): string[] => tree.flatMap(i => [i.id, ...(i.item ? ids(i.item) : [])]);

describe('applyRequestPatch', () => {
  it('muda só os campos enviados', () => {
    const { item, changed } = applyRequestPatch(req('r'), { method: 'post', url: '{{baseUrl}}/y', body: '{"a":1}', bodyType: 'raw' });
    expect(changed).toEqual(['method', 'url', 'body', 'bodyType']);
    expect(item.method).toBe('POST');
    expect(item.request!.url).toBe('{{baseUrl}}/y');
    expect(item.request!.headers[0].value).toBe('segredo-real');
    expect(item.request!.auth!.password).toBe('senha-real');
  });

  it('o texto mascarado do get_request mantém o segredo de verdade', () => {
    const { item } = applyRequestPatch(req('r'), {
      headers: [
        { key: 'ocp-apim-subscription-key', value: REDACTED },
        { key: 'Content-Type', value: 'application/json' },
      ],
      auth: { type: 'basic', username: 'u2', password: REDACTED },
    });
    expect(item.request!.headers.map(h => h.value)).toEqual(['segredo-real', 'application/json']);
    expect(item.request!.auth).toMatchObject({ username: 'u2', password: 'senha-real' });
  });

  it('mascarado sem valor atual pra manter é recusado', () => {
    expect(() => applyRequestPatch(req('r'), { headers: [{ key: 'X-Api-Key', value: REDACTED }] })).toThrow(/no current value/);
  });

  it('trocar o tipo de auth começa do zero', () => {
    const { item } = applyRequestPatch(req('r'), { auth: { type: 'bearer', token: '{{bearerToken}}' } });
    expect(item.request!.auth).toEqual({ type: 'bearer', token: '{{bearerToken}}' });
  });

  it('path params: a lista enviada vira a lista, mantendo o id dos que já existiam', () => {
    const { item } = applyRequestPatch(req('r'), { pathParams: { id: '{{orderId}}', extra: 'x' } });
    expect(item.request!.urlexport.variable).toEqual([
      { id: 'v1', key: 'id', value: '{{orderId}}', enabled: true },
      expect.objectContaining({ key: 'extra', value: 'x' }),
    ]);
  });

  it('recusa: nada a mudar, método inválido, URL vazia fora de passo de token', () => {
    expect(() => applyRequestPatch(req('r'), {})).toThrow(/Nothing to change/);
    expect(() => applyRequestPatch(req('r'), { method: 'FETCH' })).toThrow(/Invalid method/);
    expect(() => applyRequestPatch(req('r'), { url: ' ' })).toThrow(/url cannot be empty/);
    expect(() => applyRequestPatch(folder('f', []), { url: '/x' })).toThrow(/not a request/);
  });
});

describe('moveItem', () => {
  const tree = [folder('S', [folder('A', [req('a1'), req('a2'), req('a3')]), folder('B', [])])];

  it('reordena dentro da mesma pasta (inserir passo no meio de um flow)', () => {
    const { tree: out } = moveItem(tree, 'a3', 'A', 1);
    expect(ids(out)).toEqual(['S', 'A', 'a3', 'a1', 'a2', 'B']);
  });

  it('move para outra pasta, no fim quando não há posição', () => {
    const { tree: out, from } = moveItem(tree, 'a2', 'B');
    expect(from).toBe('A');
    expect(ids(out)).toEqual(['S', 'A', 'a1', 'a3', 'B', 'a2']);
  });

  it('recusa mover pasta pra dentro dela mesma, request para a raiz e alvo que não é pasta', () => {
    expect(() => moveItem(tree, 'S', 'A')).toThrow(/into itself/);
    expect(() => moveItem(tree, 'a1', null)).toThrow(/only folders/);
    expect(() => moveItem(tree, 'a1', 'a2')).toThrow(/not a folder/);
  });
});
