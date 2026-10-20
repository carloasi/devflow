import { describe, it, expect } from 'vitest';
import {
  isEditableField,
  isJsonField,
  formatFieldValue,
  parseFieldValue,
  applyFieldOverride,
  applyOverrides,
} from './diffFields';
import type { CollectionItem } from '@/app/types/CollectionItem';

const node = (over: Partial<CollectionItem> = {}): CollectionItem => ({
  id: 'r1',
  name: 'Token',
  type: 'request',
  method: 'GET',
  request: {
    url: '/antigo',
    urlexport: { host: [], path: [], raw: '/antigo' },
    headers: [{ key: 'A', value: '1', enabled: true }],
    body: 'antigo',
    scripts: { preRequest: 'pre', postResponse: 'post' },
  },
  ...over,
});

describe('isEditableField', () => {
  it('aceita texto e JSON', () => {
    expect(isEditableField('body')).toBe(true);
    expect(isEditableField('headers')).toBe(true);
  });

  // `order` é derivado da sequência dos filhos, não um campo guardado:
  // editar a lista de nomes não teria como voltar pros nós certos.
  it('recusa order', () => {
    expect(isEditableField('order')).toBe(false);
  });

  it('distingue JSON de texto', () => {
    expect(isJsonField('auth')).toBe(true);
    expect(isJsonField('body')).toBe(false);
  });
});

describe('parseFieldValue', () => {
  it('texto passa como está', () => {
    expect(parseFieldValue('body', '{"nao":"interpretado"}')).toEqual({
      ok: true,
      value: '{"nao":"interpretado"}',
    });
  });

  it('JSON válido vira objeto', () => {
    expect(parseFieldValue('auth', '{"type":"bearer"}')).toEqual({ ok: true, value: { type: 'bearer' } });
  });

  // Sem validar, um JSON quebrado entraria como lixo na request e só
  // apareceria no próximo Send.
  it('JSON inválido devolve erro', () => {
    const result = parseFieldValue('headers', '[{');
    expect(result.ok).toBe(false);
  });

  // Vazio é legítimo: "este nó não tem auth".
  it('JSON vazio vira undefined', () => {
    expect(parseFieldValue('auth', '   ')).toEqual({ ok: true, value: undefined });
  });
});

describe('formatFieldValue', () => {
  it('string sai como está', () => {
    expect(formatFieldValue('body', 'abc')).toBe('abc');
  });

  it('objeto sai identado, pra ser legível na caixa', () => {
    expect(formatFieldValue('auth', { type: 'bearer' })).toContain('\n');
  });

  it('ausente vira string vazia', () => {
    expect(formatFieldValue('auth', undefined)).toBe('');
  });
});

describe('applyFieldOverride', () => {
  it('grava name', () => {
    expect(applyFieldOverride(node(), 'name', 'Novo').name).toBe('Novo');
  });

  it('grava body sem tocar no resto', () => {
    const result = applyFieldOverride(node(), 'body', 'novo');
    expect(result.request!.body).toBe('novo');
    expect(result.request!.headers).toHaveLength(1);
  });

  // Os dois guardam a mesma URL; deixá-los divergentes é inconsistência que
  // só aparece na exportação.
  it('url atualiza também o urlexport.raw', () => {
    const result = applyFieldOverride(node(), 'url', '/novo');
    expect(result.request!.url).toBe('/novo');
    expect(result.request!.urlexport.raw).toBe('/novo');
  });

  it('grava headers', () => {
    const headers = [{ key: 'B', value: '2', enabled: true }];
    expect(applyFieldOverride(node(), 'headers', headers).request!.headers).toEqual(headers);
  });

  it('headers que não é lista cai pra vazio', () => {
    expect(applyFieldOverride(node(), 'headers', 'nao-e-lista').request!.headers).toEqual([]);
  });

  it('script preserva a outra fase', () => {
    const result = applyFieldOverride(node(), 'postResponseScript', 'novo-post');
    expect(result.request!.scripts!.postResponse).toBe('novo-post');
    expect(result.request!.scripts!.preRequest).toBe('pre');
  });

  // Inventar uma chave corromperia a request com um campo que o resto do app
  // não lê; não ter efeito é o mal menor.
  it('campo desconhecido devolve o nó intacto', () => {
    const original = node();
    expect(applyFieldOverride(original, 'inexistente', 'x')).toBe(original);
  });

  it('não altera o nó recebido', () => {
    const original = node();
    applyFieldOverride(original, 'body', 'novo');
    expect(original.request!.body).toBe('antigo');
  });
});

describe('applyOverrides', () => {
  it('aplica vários campos de uma vez', () => {
    const result = applyOverrides(node(), { name: 'N', body: 'B' });
    expect(result.name).toBe('N');
    expect(result.request!.body).toBe('B');
  });

  it('sem overrides devolve o mesmo nó', () => {
    const original = node();
    expect(applyOverrides(original, undefined)).toBe(original);
  });
});
