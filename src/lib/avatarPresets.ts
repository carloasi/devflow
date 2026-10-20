// ─────────────────────────────────────────────────────────────────────────
// Avatares de personagem, desenhados em SVG no próprio código.
//
// Gerados em vez de empacotados como PNG por três razões: não acrescentam
// arquivo nenhum ao bundle, ficam nítidos em qualquer densidade de tela, e
// cabem no localStorage como texto curto — enquanto uma foto carregada
// precisa ser redimensionada pra não estourar a cota (ver avatarImage).
//
// Todos partem do MESMO busto — fundo claro, ombros com roupa, pescoço,
// cabeça e feições — e a variação vem de cor de pele, cabelo, roupa e
// acessório. É o que faz o conjunto parecer uma família em vez de doze
// desenhos avulsos, e o que permite acrescentar o décimo terceiro mudando
// só algumas cores.
// ─────────────────────────────────────────────────────────────────────────

export interface AvatarPreset {
  id: string;
  name: string;
  /** Fundo claro atrás do busto. */
  background: string;
  skin: string;
  /** Cabelo, sobrancelha e barba. */
  hair: string;
  /** Roupa dos ombros. */
  shirt: string;
  /** Cabelo desenhado SOBRE a cabeça. Fragmento SVG, não dado de path. */
  hairStyle: string;
  /** Cabelo/chapéu atrás da cabeça, desenhado antes dela. */
  behind?: string;
  /** Barba — entra antes das feições, pra boca ficar por cima. */
  beard?: string;
  /** Óculos, boné, gravata: por cima de tudo. */
  accessory?: string;
}

const SIZE = 128;

const INK = '#3b2f2a';

// ── Peças reaproveitadas ─────────────────────────────────────────────────

/** Cabelo curto: massa entre o topo da cabeça e a linha da testa. */
// sweep-flag 1: o arco sobe por cima dos dois pontos; com 0 ele desce e o
// cabelo vira uma máscara no meio do rosto.
const SHORT = '<path d="M39 54 A25 29 0 0 1 89 54 Q64 36 39 54 Z" />';
/** Mesma massa, com um topete deslocado pra um lado. */
const SWOOP = '<path d="M39 54 A25 29 0 0 1 89 54 Q76 34 52 42 Q43 45 39 54 Z" />';
/** Cabelo cheio, mais alto. */
const VOLUME = '<path d="M37 52 A27 31 0 0 1 91 52 Q64 30 37 52 Z" />';

export const AVATAR_PRESETS: AvatarPreset[] = [
  {
    id: 'ada', name: 'Ada', background: '#fbeee6', skin: '#f3c9a4', hair: '#c98b3a',
    shirt: '#9cc3e0', hairStyle: SWOOP,
    accessory:
      '<g fill="none" stroke="#4a4a4a" stroke-width="2.4">' +
      '<circle cx="55" cy="59" r="8" /><circle cx="73" cy="59" r="8" />' +
      '<path d="M63 59 h2 M47 57 l-7 -2 M81 57 l7 -2" /></g>',
  },
  {
    id: 'bruno', name: 'Bruno', background: '#fbeee6', skin: '#eab891', hair: '#7a4a24',
    shirt: '#7fb2d4', hairStyle: SWOOP,
    beard: '<path d="M39 60 q0 34 25 34 t25 -34 q-4 24 -25 24 t-25 -24 Z" />',
  },
  {
    id: 'cleo', name: 'Cleo', background: '#f7ece4', skin: '#9c6033', hair: '#2e1c10',
    shirt: '#49bcd6', hairStyle: VOLUME,
    behind: '<circle cx="46" cy="34" r="11" /><circle cx="64" cy="28" r="12" /><circle cx="82" cy="34" r="11" />',
  },
  {
    id: 'dante', name: 'Dante', background: '#fbeee6', skin: '#f0c3a0', hair: '#b5452c',
    shirt: '#2f7fa6', hairStyle: SWOOP,
    accessory:
      '<g fill="none" stroke="#3f7f6f" stroke-width="2.4">' +
      '<circle cx="55" cy="59" r="8" /><circle cx="73" cy="59" r="8" />' +
      '<path d="M63 59 h2 M47 57 l-7 -2 M81 57 l7 -2" /></g>',
  },
  {
    id: 'elis', name: 'Elis', background: '#f7ece4', skin: '#e8b68c', hair: '#4a3020',
    shirt: '#e08b4a', hairStyle: SHORT,
  },
  {
    id: 'frida', name: 'Frida', background: '#fbeee6', skin: '#f3c9a4', hair: '#7a5230',
    shirt: '#f0c36a',
    hairStyle: SHORT,
    // Boné: copa sobre o cabelo e aba saindo pro lado.
    accessory:
      '<path d="M38 50 A26 26 0 0 1 90 50 Z" fill="#a8c6e8" />' +
      '<path d="M88 50 q18 2 16 10 q-10 2 -18 -4 Z" fill="#8fb0d6" />',
    beard: '<path d="M40 62 q0 32 24 32 t24 -32 q-4 22 -24 22 t-24 -22 Z" />',
  },
  {
    id: 'gael', name: 'Gael', background: '#f7ece4', skin: '#d9a273', hair: '#3a2416',
    shirt: '#d6c7a8',
    hairStyle: SHORT,
    // Chapéu de aba larga: a aba cobre a testa, a copa fica acima.
    accessory:
      '<ellipse cx="64" cy="42" rx="40" ry="8" fill="#e0c178" />' +
      '<path d="M44 42 q2 -22 20 -22 t20 22 Z" fill="#d9b566" />',
    beard: '<path d="M39 60 q0 36 25 36 t25 -36 q-4 26 -25 26 t-25 -26 Z" />',
  },
  {
    id: 'hana', name: 'Hana', background: '#fbeee6', skin: '#f3c9a4', hair: '#5b3a8e',
    shirt: '#d9534f', hairStyle: VOLUME,
  },
  {
    id: 'ivo', name: 'Ivo', background: '#f7ece4', skin: '#e8b68c', hair: '#8a5a2b',
    shirt: '#8fcbe0', hairStyle: SWOOP,
    // Bigode, sem barba.
    beard: '<path d="M52 72 q12 -6 24 0 q-12 6 -24 0 Z" />',
  },
  {
    id: 'juno', name: 'Juno', background: '#fbeee6', skin: '#b87a4a', hair: '#1f1a16',
    shirt: '#f0a35e', hairStyle: VOLUME,
  },
  {
    id: 'kai', name: 'Kai', background: '#f7ece4', skin: '#f0c3a0', hair: '#c9a227',
    shirt: '#8fb8d9',
    hairStyle: SWOOP,
    // Gravata: o detalhe que lê como "camisa social" na referência.
    accessory:
      '<path d="M60 100 h8 l-2 6 h-4 Z" fill="#2f5d8a" />' +
      '<path d="M62 106 h4 l3 18 l-5 4 l-5 -4 Z" fill="#2f5d8a" />' +
      '<g fill="none" stroke="#4a4a4a" stroke-width="2.4">' +
      '<circle cx="55" cy="59" r="8" /><circle cx="73" cy="59" r="8" />' +
      '<path d="M63 59 h2 M47 57 l-7 -2 M81 57 l7 -2" /></g>',
  },
  {
    id: 'lia', name: 'Lia', background: '#fbeee6', skin: '#9c6033', hair: '#2b1d14',
    shirt: '#5bbf9f', hairStyle: VOLUME,
    behind: '<path d="M34 58 q0 -28 30 -28 t30 28 v32 q-30 10 -60 0 Z" />',
  },
];

/**
 * SVG completo do personagem.
 *
 * A ordem é o desenho: fundo, cabelo de trás, ombros, pescoço, cabeça,
 * orelhas, barba, cabelo, feições e acessório. Trocar duas camadas de lugar
 * estraga em silêncio — cabelo antes da cabeça some sob ela, e feições antes
 * do cabelo aparecem por cima da franja.
 */
export function avatarSvg(preset: AvatarPreset): string {
  const parts: string[] = [
    `<rect width="${SIZE}" height="${SIZE}" fill="${preset.background}"/>`,
    preset.behind ? `<g fill="${preset.hair}">${preset.behind}</g>` : '',

    // Ombros: o busto que separa este conjunto de um avatar só de cabeça.
    `<path d="M16 128 C16 104 38 96 64 96 C90 96 112 104 112 128 Z" fill="${preset.shirt}"/>`,
    // Gola, um tom do próprio fundo pra sugerir profundidade sem outra cor.
    `<path d="M50 100 q14 14 28 0 q-14 -8 -28 0 Z" fill="${preset.background}" opacity="0.35"/>`,

    `<path d="M55 80 h18 v18 q-9 6 -18 0 Z" fill="${preset.skin}"/>`,
    `<circle cx="39" cy="62" r="5.5" fill="${preset.skin}"/>`,
    `<circle cx="89" cy="62" r="5.5" fill="${preset.skin}"/>`,
    `<ellipse cx="64" cy="60" rx="25" ry="29" fill="${preset.skin}"/>`,

    preset.beard ? `<g fill="${preset.hair}">${preset.beard}</g>` : '',
    preset.hairStyle ? `<g fill="${preset.hair}">${preset.hairStyle}</g>` : '',

    // Feições iguais em todos — é o que dá unidade ao conjunto.
    `<g fill="none" stroke="${preset.hair}" stroke-width="2.6" stroke-linecap="round">` +
      `<path d="M48 52 q6 -4 13 -1"/><path d="M80 52 q-6 -4 -13 -1"/></g>`,
    `<circle cx="55" cy="59" r="3" fill="${INK}"/>`,
    `<circle cx="73" cy="59" r="3" fill="${INK}"/>`,
    `<path d="M64 62 v6 q0 3 3 3" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round" opacity="0.5"/>`,
    `<path d="M55 74 q9 11 18 0 Z" fill="#ffffff" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/>`,

    preset.accessory ?? '',
  ];

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">` +
    parts.join('') +
    `</svg>`
  );
}

/**
 * Data URL do preset, pronta pra `<img src>` e pro mesmo armazenamento que a
 * foto carregada usa.
 *
 * `encodeURIComponent` em vez de base64: o SVG é texto, fica legível no
 * armazenamento e ocupa menos que a versão codificada.
 */
export function avatarDataUrl(preset: AvatarPreset): string {
  return `data:image/svg+xml,${encodeURIComponent(avatarSvg(preset))}`;
}

/** Qual preset corresponde a um avatar guardado, se é que algum. */
export function presetIdOf(dataUrl: string | null): string | null {
  if (!dataUrl) return null;
  return AVATAR_PRESETS.find(p => avatarDataUrl(p) === dataUrl)?.id ?? null;
}
