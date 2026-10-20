import { describe, it, expect } from 'vitest';
import { clampOffset, offsetTransform } from './dragWindow';

const viewport = { width: 1200, height: 800 };
const modal = { width: 600, height: 400 };
// Centralizado: left = 300, top = 200.

describe('clampOffset', () => {
  it('deixa passar um deslocamento pequeno', () => {
    expect(clampOffset({ x: 50, y: -30 }, modal, viewport)).toEqual({ x: 50, y: -30 });
  });

  it('sem deslocamento, nada muda', () => {
    expect(clampOffset({ x: 0, y: 0 }, modal, viewport)).toEqual({ x: 0, y: 0 });
  });

  // Um modal arrastado pra fora não tem como voltar: não há barra de tarefas
  // nem atalho pra trazê-lo.
  describe('não deixa sair da tela', () => {
    it('limita à direita, mantendo uma faixa visível', () => {
      const result = clampOffset({ x: 99999, y: 0 }, modal, viewport);
      // left final = 300 + x; precisa ficar abaixo de 1200 - 48.
      expect(300 + result.x).toBeLessThanOrEqual(viewport.width - 48);
    });

    it('limita à esquerda', () => {
      const result = clampOffset({ x: -99999, y: 0 }, modal, viewport);
      // A borda direita (left + 600) precisa continuar além de 48.
      expect(300 + result.x + modal.width).toBeGreaterThanOrEqual(48);
    });

    it('limita embaixo', () => {
      const result = clampOffset({ x: 0, y: 99999 }, modal, viewport);
      expect(200 + result.y).toBeLessThanOrEqual(viewport.height - 48);
    });

    // A barra de arrastar fica no topo do modal: deixá-la subir acima da
    // janela tiraria a única parte por onde ele volta.
    it('não deixa o topo subir acima da janela', () => {
      const result = clampOffset({ x: 0, y: -99999 }, modal, viewport);
      expect(200 + result.y).toBe(0);
    });
  });

  describe('modal maior que a janela', () => {
    const grande = { width: 1400, height: 1000 };

    it('ainda garante o topo visível', () => {
      const result = clampOffset({ x: 0, y: -99999 }, grande, viewport);
      const centeredTop = (viewport.height - grande.height) / 2;
      expect(centeredTop + result.y).toBe(0);
    });

    it('não produz NaN nem inverte os limites', () => {
      const result = clampOffset({ x: 500, y: 500 }, grande, viewport);
      expect(Number.isFinite(result.x)).toBe(true);
      expect(Number.isFinite(result.y)).toBe(true);
    });
  });
});

describe('offsetTransform', () => {
  it('leva só o deslocamento', () => {
    expect(offsetTransform({ x: 10, y: -20 })).toBe('translate(10px, -20px)');
  });

  // O Tailwind 4 centraliza pela propriedade `translate`, que é somada ao
  // `transform`. Repetir o -50% aqui centralizava duas vezes, e o modal
  // saltava uma altura inteira pra cima no primeiro pixel de arrasto.
  it('não repete a centralização', () => {
    expect(offsetTransform({ x: 0, y: 0 })).not.toContain('50%');
    expect(offsetTransform({ x: 5, y: 5 })).not.toContain('calc');
  });

  // Fração de pixel vinda do arrasto deixa o texto borrado em alguns webviews.
  it('arredonda', () => {
    expect(offsetTransform({ x: 10.7, y: 0.2 })).toBe('translate(11px, 0px)');
  });
});
