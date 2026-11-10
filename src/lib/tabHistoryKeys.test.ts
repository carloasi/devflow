import { describe, expect, it } from 'vitest';
import { getHistoryKeys } from './tabHistoryKeys';

describe('getHistoryKeys', () => {
  it('mantém chaves de conteúdo editável de verdade (URL, headers, auth...)', () => {
    expect(getHistoryKeys({ urlInput: 'https://x' })).toEqual(['urlInput']);
    expect(getHistoryKeys({ requestHeadersValue: 'a: b' })).toEqual(['requestHeadersValue']);
    expect(getHistoryKeys({ name: 'Login', method: 'POST' }).sort()).toEqual(['method', 'name']);
  });

  it('tira requestBodyValue e scripts — só são editados dentro do Monaco, que já tem o próprio undo/redo', () => {
    expect(getHistoryKeys({ requestBodyValue: '{"a":1}' })).toEqual([]);
    expect(getHistoryKeys({ scripts: { preRequest: '', postResponse: '' } })).toEqual([]);
  });

  it('tira campos derivados/navegação (response, isDirty, etc.)', () => {
    expect(getHistoryKeys({ response: {}, responseTime: 120, testResults: [], activeRequestTab: 'body', isDirty: true })).toEqual([]);
  });

  it('num update misto, mantém só as chaves que contam — o body sai, o resto fica', () => {
    expect(getHistoryKeys({ requestBodyValue: 'x', bodyType: 'raw' })).toEqual(['bodyType']);
  });

  it('update vazio não gera nenhuma chave', () => {
    expect(getHistoryKeys({})).toEqual([]);
  });
});
