import { describe, it, expect } from 'vitest';
import { capBody, isOmittedBody } from './responseHistoryStore';

describe('capBody', () => {
  it('deixa passar o que cabe', () => {
    const body = { ok: true, items: [1, 2, 3] };
    expect(capBody(body, 1024)).toBe(body);
  });

  // O que está na tela nunca passa por aqui: isto é só a cópia que sobrevive
  // ao restart, e uma resposta de megabytes tira o espaço de dezenas de
  // outras.
  it('troca o que não cabe por uma marca', () => {
    const grande = { data: 'x'.repeat(5000) };
    const capped = capBody(grande, 1024);
    expect(isOmittedBody(capped)).toBe(true);
  });

  // Cortar produziria um JSON inválido que o viewer tentaria interpretar.
  it('a marca diz o tamanho, e não finge ser a resposta', () => {
    const capped = capBody({ data: 'x'.repeat(5000) }, 1024);
    expect(isOmittedBody(capped) && capped.reason).toMatch(/too large.*KB/i);
    expect(capped).not.toHaveProperty('data');
  });

  it('mede em UTF-16, como a cota', () => {
    // 600 caracteres serializados ≈ 1200 bytes: passa de 1000, não de 2000.
    const body = 'y'.repeat(600);
    expect(isOmittedBody(capBody(body, 1000))).toBe(true);
    expect(capBody(body, 2000)).toBe(body);
  });

  it('o que não serializa também vira marca, em vez de estourar', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const capped = capBody(circular, 1024);
    expect(isOmittedBody(capped)).toBe(true);
  });

  it('null e undefined passam', () => {
    expect(capBody(null, 1024)).toBeNull();
    expect(capBody(undefined, 1024)).toBeUndefined();
  });
});

describe('isOmittedBody', () => {
  it('reconhece a marca', () => {
    expect(isOmittedBody({ __devflowOmitted: true, reason: 'x' })).toBe(true);
  });

  it('não confunde com resposta de verdade', () => {
    expect(isOmittedBody({ data: 1 })).toBe(false);
    expect(isOmittedBody(null)).toBe(false);
    expect(isOmittedBody('texto')).toBe(false);
    expect(isOmittedBody({ __devflowOmitted: false })).toBe(false);
  });
});
