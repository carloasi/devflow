// @vitest-environment happy-dom
// Só este arquivo precisa de DOM: o DOMParser é o que prova que o SVG gerado
// é bem formado de verdade, em vez de conferir a string a olho.
import { describe, it, expect } from 'vitest';
import { AVATAR_PRESETS, avatarSvg, avatarDataUrl, presetIdOf } from './avatarPresets';

// Cor dos olhos/boca — igual em todos, é o que dá unidade ao conjunto.
const INK = '#3b2f2a';

function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error('SVG inválido: ' + error.textContent);
  return doc;
}

describe('AVATAR_PRESETS', () => {
  it('tem opções suficientes pra escolher', () => {
    expect(AVATAR_PRESETS.length).toBeGreaterThanOrEqual(8);
  });

  it('nenhum id repetido', () => {
    const ids = AVATAR_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('todas as cores são hex válidas', () => {
    for (const preset of AVATAR_PRESETS) {
      expect(preset.background).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.skin).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.hair).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.shirt).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('nenhum nome repetido', () => {
    const names = AVATAR_PRESETS.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // O avatar aparece em 32px: sem contraste entre a roupa e o fundo claro,
  // o busto some e sobra uma cabeça flutuando.
  //
  // Diferença ABSOLUTA, não "mais claro que": exigir rosto mais claro que o
  // fundo obrigaria todo personagem a ter pele clara, o que exclui metade do
  // conjunto. O que importa é separar as duas cores, em qualquer direção.
  it('a roupa se destaca do fundo', () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };
    for (const preset of AVATAR_PRESETS) {
      const contrast = Math.abs(lum(preset.shirt) - lum(preset.background));
      expect(contrast, `${preset.name}`).toBeGreaterThan(25);
    }
  });

  // O cabelo cobre a testa: sem separá-lo da pele, a silhueta some.
  it('o cabelo se destaca do rosto', () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    };
    for (const preset of AVATAR_PRESETS) {
      const contrast = Math.abs(lum(preset.skin) - lum(preset.hair));
      expect(contrast, `${preset.name}`).toBeGreaterThan(30);
    }
  });
});

describe('avatarSvg', () => {
  // Um SVG malformado não falha: ele simplesmente não aparece, e o avatar
  // fica vazio sem nenhum erro no console.
  it('todo preset gera SVG bem formado', () => {
    for (const preset of AVATAR_PRESETS) {
      expect(() => parse(avatarSvg(preset))).not.toThrow();
    }
  });

  // O erro que isto trava: um fragmento montado como DADO de path ('M39 54
  // A25...') em vez de elemento ('<path d=\"...\"/>') vira texto dentro do <g>.
  // O SVG continua bem formado, nada reclama, e o desenho simplesmente não
  // aparece — todos os personagens nasceram carecas assim.
  it('cada grupo de cor contém elemento, não texto solto', () => {
    for (const preset of AVATAR_PRESETS) {
      const doc = parse(avatarSvg(preset));
      for (const group of doc.querySelectorAll('g')) {
        expect(group.children.length, `${preset.name}`).toBeGreaterThan(0);
        expect(group.textContent?.trim(), `${preset.name}`).toBe('');
      }
    }
  });

  it('é quadrado, pro recorte redondo não deformar', () => {
    const svg = parse(avatarSvg(AVATAR_PRESETS[0])).documentElement;
    expect(svg.getAttribute('viewBox')).toBe('0 0 128 128');
  });

  it('todo personagem tem rosto, olhos e boca', () => {
    for (const preset of AVATAR_PRESETS) {
      const doc = parse(avatarSvg(preset));
      const circles = [...doc.querySelectorAll('circle')];
      expect(circles.some(c => c.getAttribute('fill') === preset.skin)).toBe(true);
      // Dois olhos, sempre na mesma cor.
      expect(circles.filter(c => c.getAttribute('fill') === INK)).toHaveLength(2);
      expect(doc.querySelectorAll('path').length).toBeGreaterThan(0);
    }
  });
});

describe('avatarDataUrl', () => {
  it('gera data URL de SVG', () => {
    expect(avatarDataUrl(AVATAR_PRESETS[0])).toMatch(/^data:image\/svg\+xml,/);
  });

  // O '#' das cores quebraria a URL: tudo depois dele viraria fragmento.
  it('escapa o que quebraria a URL', () => {
    expect(avatarDataUrl(AVATAR_PRESETS[0])).not.toContain('#');
  });

  // A seleção é identificada comparando a URL guardada com a gerada: se a
  // geração não for determinística, o preset escolhido some do destaque.
  it('é determinístico', () => {
    expect(avatarDataUrl(AVATAR_PRESETS[0])).toBe(avatarDataUrl(AVATAR_PRESETS[0]));
  });

  it('presets diferentes geram URLs diferentes', () => {
    const urls = AVATAR_PRESETS.map(avatarDataUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('presetIdOf', () => {
  it('reconhece o preset guardado', () => {
    expect(presetIdOf(avatarDataUrl(AVATAR_PRESETS[2]))).toBe(AVATAR_PRESETS[2].id);
  });

  it('foto carregada não é preset', () => {
    expect(presetIdOf('data:image/png;base64,AAAA')).toBeNull();
  });

  it('sem avatar devolve null', () => {
    expect(presetIdOf(null)).toBeNull();
  });
});
