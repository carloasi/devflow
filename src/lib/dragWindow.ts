// ─────────────────────────────────────────────────────────────────────────
// Deslocamento de um modal arrastável.
//
// Os modais do app são centralizados pelo CSS (`top-1/2 left-1/2` com
// `-translate-1/2`). Arrastar não muda isso: soma-se um deslocamento por
// cima, e é ele que este módulo mantém dentro de limites razoáveis.
//
// O limite existe porque arrastar um modal para fora da tela o torna
// **inalcançável**: não há barra de tarefas nem atalho para trazê-lo de
// volta, e a única saída seria fechar e reabrir, perdendo o que estava nele.
// ─────────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Quanto do modal precisa continuar visível, em pixels. */
const MARGIN = 48;

/**
 * Limita o deslocamento para que o modal continue agarrável.
 *
 * Na vertical o teto é zero deslocamento negativo além do topo da tela: a
 * barra de arrastar fica no alto do modal, e deixá-la subir acima da janela
 * tiraria justamente a única parte por onde ele volta.
 */
export function clampOffset(offset: Point, element: Size, viewport: Size): Point {
  // Posição da borda esquerda/superior quando o deslocamento é zero — o
  // elemento está centralizado.
  const centeredLeft = (viewport.width - element.width) / 2;
  const centeredTop = (viewport.height - element.height) / 2;

  const minX = MARGIN - element.width - centeredLeft;
  const maxX = viewport.width - MARGIN - centeredLeft;

  const minY = -centeredTop;
  const maxY = viewport.height - MARGIN - centeredTop;

  return {
    x: clamp(offset.x, minX, maxX),
    y: clamp(offset.y, minY, maxY),
  };
}

function clamp(value: number, min: number, max: number): number {
  // Quando o modal é maior que a janela, min passa de max; aí o mínimo vence,
  // porque é ele que garante o topo visível.
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Transform do elemento: **apenas o deslocamento**, sem a centralização.
 *
 * Isto depende de um detalhe do Tailwind 4: `-translate-x-1/2` compila para a
 * propriedade CSS `translate`, que é independente de `transform` — as duas se
 * somam. Repetir o `-50%` aqui aplicava a centralização duas vezes, e o modal
 * saltava uma altura inteira para cima no primeiro pixel de arrasto.
 *
 * Ou seja: quem centraliza é a classe do Tailwind; aqui só se empurra.
 */
export function offsetTransform(offset: Point): string {
  return `translate(${Math.round(offset.x)}px, ${Math.round(offset.y)}px)`;
}
