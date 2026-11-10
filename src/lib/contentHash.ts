import { canonicalString } from './canonicalCompare';

/**
 * FNV-1a. Não é criptográfico, e nem precisa: uma colisão aqui faria um nó
 * alterado passar por intocado, e o custo disso é um aviso de conflito a
 * menos — não perda de dado, porque o conteúdo em si nunca sai daqui.
 */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Hash do conteúdo, depois da normalização de lib/canonicalCompare (ordem de
 * chave e ids gerados não contam). `undefined` vira `null` pra ter hash.
 */
export function hashContent(value: unknown): string {
  return hashText(canonicalString(value === undefined ? null : value));
}
