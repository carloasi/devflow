import { describe, it, expect } from 'vitest';
import {
  squareCrop,
  validateAvatarFile,
  MAX_AVATAR_INPUT_BYTES,
} from './avatarImage';

describe('squareCrop', () => {
  it('imagem já quadrada não é recortada', () => {
    expect(squareCrop(200, 200)).toEqual({ x: 0, y: 0, side: 200 });
  });

  // O avatar é redondo; esticar um retângulo deforma o rosto.
  it('paisagem recorta nas laterais, centralizado', () => {
    expect(squareCrop(400, 200)).toEqual({ x: 100, y: 0, side: 200 });
  });

  it('retrato recorta em cima e embaixo, centralizado', () => {
    expect(squareCrop(200, 400)).toEqual({ x: 0, y: 100, side: 200 });
  });

  it('arredonda dimensão ímpar sem sair da imagem', () => {
    const crop = squareCrop(101, 50);
    expect(crop.side).toBe(50);
    expect(crop.x + crop.side).toBeLessThanOrEqual(101);
  });

  it('imagem de 1px não quebra', () => {
    expect(squareCrop(1, 1)).toEqual({ x: 0, y: 0, side: 1 });
  });
});

describe('validateAvatarFile', () => {
  it('aceita os formatos comuns', () => {
    expect(validateAvatarFile({ type: 'image/png', size: 1000 }).ok).toBe(true);
    expect(validateAvatarFile({ type: 'image/jpeg', size: 1000 }).ok).toBe(true);
    expect(validateAvatarFile({ type: 'image/webp', size: 1000 }).ok).toBe(true);
  });

  // Um PDF renomeado pra .png chegaria aqui; decodificar daria erro feio.
  it('recusa o que não é imagem', () => {
    const result = validateAvatarFile({ type: 'application/pdf', size: 1000 });
    expect(result.ok).toBe(false);
  });

  it('recusa arquivo grande demais antes de decodificar', () => {
    const result = validateAvatarFile({ type: 'image/png', size: MAX_AVATAR_INPUT_BYTES + 1 });
    expect(result.ok).toBe(false);
  });

  it('aceita exatamente no limite', () => {
    expect(validateAvatarFile({ type: 'image/png', size: MAX_AVATAR_INPUT_BYTES }).ok).toBe(true);
  });
});
