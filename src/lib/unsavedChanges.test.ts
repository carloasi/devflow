import { describe, it, expect } from 'vitest';
import { changedFieldLabels, describeChanges } from './unsavedChanges';
import type { CollectionItem } from '@/app/types/CollectionItem';

const item = (patch: Partial<NonNullable<CollectionItem['request']>> = {}, extra: Partial<CollectionItem> = {}): CollectionItem =>
  ({
    id: 'r1',
    name: 'AirSearch v1',
    type: 'request',
    method: 'POST',
    request: {
      url: '{{urlShopping}}/api/v1/airSearch',
      urlexport: { host: [], path: [], raw: '{{urlShopping}}/api/v1/airSearch' },
      headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
      body: '{"a":1}',
      ...patch,
    },
    ...extra,
  }) as CollectionItem;

describe('changedFieldLabels', () => {
  it('nada mudou, lista vazia', () => {
    expect(changedFieldLabels(item(), item())).toEqual([]);
  });

  // Os nomes são os da tela, não os do modelo.
  it('traduz o campo para o rótulo da interface', () => {
    expect(changedFieldLabels(item(), item({ url: '{{urlShopping}}/api/v2/airSearch' }))).toEqual(['URL']);
    expect(changedFieldLabels(item(), item({ body: '{"a":2}' }))).toEqual(['Body']);
  });

  it('vários campos de uma vez', () => {
    const next = item({ url: 'outra', body: '{"b":1}' });
    expect(changedFieldLabels(item(), next).sort()).toEqual(['Body', 'URL']);
  });

  it('header alterado conta', () => {
    const next = item({ headers: [{ key: 'Accept', value: 'text/xml', enabled: true }] });
    expect(changedFieldLabels(item(), next)).toEqual(['Headers']);
  });

  it('renomear conta', () => {
    expect(changedFieldLabels(item(), item({}, { name: 'AirSearch v2' }))).toEqual(['Name']);
  });

  it('script conta com o nome certo', () => {
    const next = item({ scripts: { preRequest: 'pm.environment.set("x", 1)', postResponse: '' } });
    expect(changedFieldLabels(item(), next)).toEqual(['Pre-request script']);
  });

  // Request que saiu da árvore: não há com o que comparar, e inventar "nada
  // mudou" seria pior que não dizer nada.
  it('sem o lado salvo, lista vazia', () => {
    expect(changedFieldLabels(undefined, item())).toEqual([]);
    expect(changedFieldLabels(item(), undefined)).toEqual([]);
  });
});

describe('describeChanges', () => {
  it('nenhum', () => {
    expect(describeChanges([])).toBe('');
  });

  it('um', () => {
    expect(describeChanges(['URL'])).toBe('URL');
  });

  it('dois', () => {
    expect(describeChanges(['URL', 'Body'])).toBe('URL and Body');
  });

  it('três', () => {
    expect(describeChanges(['URL', 'Headers', 'Body'])).toBe('URL, Headers and Body');
  });

  // Com muitos campos a frase vira parede e deixa de informar.
  it('corta o excesso', () => {
    expect(describeChanges(['A', 'B', 'C', 'D', 'E', 'F'], 4)).toBe('A, B, C, D and 2 more');
  });

  it('exatamente no limite não corta', () => {
    expect(describeChanges(['A', 'B', 'C', 'D'], 4)).toBe('A, B, C and D');
  });
});

describe('ruído que não conta como alteração', () => {
  // A aba sempre manda `scripts: { preRequest, postResponse }`. Num request
  // salvo sem scripts, editar só o de pré-requisição fazia o outro aparecer
  // como alterado — num aviso cuja função é ser preciso.
  it('campo ausente que virou vazio não é alteração', () => {
    const next = item({ scripts: { preRequest: '', postResponse: '' } });
    expect(changedFieldLabels(item(), next)).toEqual([]);
  });

  it('mas ausente que virou conteúdo é', () => {
    const next = item({ scripts: { preRequest: 'console.log(1)', postResponse: '' } });
    expect(changedFieldLabels(item(), next)).toEqual(['Pre-request script']);
  });

  it('conteúdo que virou vazio continua sendo alteração', () => {
    const base = item({ body: '{"a":1}' });
    expect(changedFieldLabels(base, item({ body: '' }))).toEqual(['Body']);
  });
});
