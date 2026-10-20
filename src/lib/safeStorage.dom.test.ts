// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { safeSetItem, sweepDeadKeys, measurePrefix } from './safeStorage';

// A varredura é o que desentope uma instalação JÁ cheia: sem ela o app abre,
// não quebra mais, e continua sem espaço. Por isso ela tem teste de verdade,
// contra um localStorage real, e não só as funções puras ao redor.
beforeEach(() => {
  window.localStorage.clear();
});

describe('sweepDeadKeys', () => {
  it('remove os restos e devolve quanto liberou', () => {
    window.localStorage.setItem('devflow_runner_last', 'x'.repeat(100));
    window.localStorage.setItem('devflow_runner_last_run:abc', 'y'.repeat(50));
    window.localStorage.setItem('response-viewer:uuid-1', 'z'.repeat(10));

    const result = sweepDeadKeys();

    expect(result.removed).toBe(3);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(window.localStorage.length).toBe(0);
  });

  // O que ainda se usa não pode sair junto — em especial o histórico de
  // respostas, que é orçado e não varrido.
  it('não encosta no que está em uso', () => {
    window.localStorage.setItem('devflow_response_history_abc', '[]');
    window.localStorage.setItem('postman_clone_panel_sizes', '{}');
    window.localStorage.setItem('devflow_theme_id', 'dark');

    expect(sweepDeadKeys().removed).toBe(0);
    expect(window.localStorage.length).toBe(3);
  });

  it('localStorage vazio não quebra', () => {
    expect(sweepDeadKeys()).toEqual({ removed: 0, freedBytes: 0 });
  });
});

describe('safeSetItem', () => {
  it('grava e confirma', () => {
    expect(safeSetItem('k', 'v')).toBe(true);
    expect(window.localStorage.getItem('k')).toBe('v');
  });

  // O ponto inteiro: cota estourada devolve false em vez de derrubar a tela.
  it('devolve false em vez de lançar quando a gravação falha', () => {
    // Troca o objeto inteiro: no happy-dom o localStorage é um Proxy, e
    // espiar o método pelo prototype não intercepta a chamada.
    const real = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        setItem() {
          throw new DOMException('quota', 'QuotaExceededError');
        },
      },
    });

    expect(() => safeSetItem('k', 'v')).not.toThrow();
    expect(safeSetItem('k', 'v')).toBe(false);

    Object.defineProperty(window, 'localStorage', { configurable: true, value: real });
  });
});

describe('measurePrefix', () => {
  it('mede só o prefixo pedido', () => {
    window.localStorage.setItem('devflow_response_history_a', '12345');
    window.localStorage.setItem('outra_coisa', '12345');

    const items = measurePrefix('devflow_response_history_');
    expect(items.map(i => i.key)).toEqual(['devflow_response_history_a']);
    expect(items[0].bytes).toBe(('devflow_response_history_a'.length + 5) * 2);
  });
});
