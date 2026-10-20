// ─────────────────────────────────────────────────────────────────────────
// Prepara a imagem escolhida pelo usuário para virar avatar.
//
// Redimensiona antes de guardar porque o destino é o localStorage, que tem
// cota compartilhada com o resto do app: uma foto de celular de 4MB em base64
// passa de 5MB e derruba as gravações de OUTRAS features — o mesmo problema
// que tirou o histórico de runs de lá.
//
// Recorte quadrado e centralizado: o avatar é exibido redondo, e uma imagem
// retangular esticada deforma o rosto.
// ─────────────────────────────────────────────────────────────────────────

/** Lado do quadrado final. 128px cobre o badge (32px) e o menu (40px) em
 *  telas de alta densidade sem guardar mais do que se vê. */
export const AVATAR_SIZE = 128;

export const ACCEPTED_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Teto do arquivo de ENTRADA, antes de redimensionar — só pra recusar cedo
 *  um arquivo absurdo em vez de decodificá-lo. */
export const MAX_AVATAR_INPUT_BYTES = 10 * 1024 * 1024;

export interface AvatarError {
  ok: false;
  error: string;
}

export function validateAvatarFile(file: { type: string; size: number }): AvatarError | { ok: true } {
  if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
    return { ok: false, error: 'Choose a PNG, JPEG, WebP or GIF image.' };
  }
  if (file.size > MAX_AVATAR_INPUT_BYTES) {
    return { ok: false, error: 'Image is too large — pick one under 10 MB.' };
  }
  return { ok: true };
}

/**
 * Área quadrada a recortar de uma imagem de `width` x `height`.
 *
 * Pega o maior quadrado possível, centralizado — é o recorte que mais
 * preserva o enquadramento original sem pedir nada ao usuário.
 */
export function squareCrop(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return {
    x: Math.round((width - side) / 2),
    y: Math.round((height - side) / 2),
    side,
  };
}
