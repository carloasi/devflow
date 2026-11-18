import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { consumedVariables, validateFlow } from './flowValidation';

const step = (name: string, request: Partial<NonNullable<CollectionItem['request']>> = {}): CollectionItem => ({
  id: name,
  name,
  type: 'request',
  method: 'POST',
  request: { url: '{{baseUrl}}/x', urlexport: { host: [], path: [], raw: '' }, headers: [], ...request },
});
const post = (code: string) => ({ scripts: { preRequest: '', postResponse: code } });
const pre = (code: string) => ({ scripts: { preRequest: code, postResponse: '' } });
const codes = (r: ReturnType<typeof validateFlow>, i: number) => r.steps[i].problems.map(p => `${p.code}:${p.variable ?? ''}`);

describe('validateFlow', () => {
  it('flow encadeado certo passa limpo', () => {
    const r = validateFlow(
      [
        step('01 - Token', { auth: { type: 'bearer', token: '{{tokenB2b}}' }, ...post('pm.environment.set("bearerToken", pm.response.json().data.token);') }),
        step('02 - Search', { auth: { type: 'bearer', token: '{{bearerToken}}' }, ...post("pm.environment.set('journeyKey', 'x');") }),
        step('03 - Order', { body: '{"journeyKey":"{{journeyKey}}"}', bodyType: 'raw', auth: { type: 'bearer', token: '{{bearerToken}}' } }),
      ],
      ['baseUrl', 'tokenB2b']
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toBe(0);
    expect(r.steps[1].produces).toEqual(['journeyKey']);
  });

  it('variável que ninguém produz e não existe no environment', () => {
    const r = validateFlow([step('01', { body: '{"k":"{{fareKey}}"}', bodyType: 'raw' })], ['baseUrl']);
    expect(r.ok).toBe(false);
    expect(codes(r, 0)).toEqual(['missing-variable:fareKey']);
    expect(r.missingVariables).toEqual(['fareKey']);
  });

  it('variável produzida só depois do passo que a usa', () => {
    const r = validateFlow(
      [step('01', { body: '{"k":"{{recordLocator}}"}', bodyType: 'raw' }), step('02', post('pm.environment.set("recordLocator", 1);'))],
      ['baseUrl']
    );
    expect(codes(r, 0)).toEqual(['produced-later:recordLocator']);
  });

  it('o que o pre-request grava vale no próprio passo; body "none" não conta', () => {
    const r = validateFlow(
      [
        step('01', { body: '{"d":"{{flowDeparture}}"}', bodyType: 'raw', ...pre('pm.environment.set("flowDeparture", "2026-01-01");') }),
        step('02', { body: '{"x":"{{naoUsada}}"}', bodyType: 'none' }),
      ],
      ['baseUrl']
    );
    expect(r.ok).toBe(true);
  });

  it('passo de token produz a variável do Access Token, e URL vazia nele é normal', () => {
    const token: CollectionItem = step('01 - Gerar token MSAL', {
      url: '',
      auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: '{{msal}}', enabled: true }, { key: 'clientId', value: '{{clientId}}', enabled: true }] },
    });
    const r = validateFlow([token, step('02', { auth: { type: 'bearer', token: '{{msal}}' } })], ['baseUrl', 'clientId']);
    expect(r.ok).toBe(true);
    expect(r.steps[0].tokenStep).toBe(true);
    expect(r.steps[0].produces).toEqual(['msal']);
    expect(consumedVariables(token)).toEqual(['clientId']);
  });

  it('URL vazia fora de passo de token, script que não compila e segredo literal', () => {
    const r = validateFlow(
      [step('01', { url: '', headers: [{ key: 'Ocp-Apim-Subscription-Key', value: 'abc123', enabled: true }], ...post('pm.environment.set("a", ') })],
      []
    );
    expect(codes(r, 0).sort()).toEqual(['empty-url:', 'literal-secret:', 'script-syntax:']);
    expect(r.warnings).toBe(1);
  });

  it('body JSON sem Content-Type só quando o header automático foi desligado', () => {
    const base = { body: '{"a":1}', bodyType: 'raw' as const };
    expect(validateFlow([step('01', base)], ['baseUrl']).warnings).toBe(0);
    const off = validateFlow([step('01', { ...base, disabledDefaultHeaders: ['Content-type'] })], ['baseUrl']);
    expect(codes(off, 0)).toEqual(['json-body-without-content-type:']);
  });

  it('variáveis dinâmicas ({{$guid}}) e headers desligados não contam', () => {
    const r = validateFlow(
      [step('01', { headers: [{ key: 'X-Id', value: '{{$guid}}', enabled: true }, { key: 'X-Off', value: '{{nada}}', enabled: false }] })],
      ['baseUrl']
    );
    expect(r.ok).toBe(true);
  });
});
