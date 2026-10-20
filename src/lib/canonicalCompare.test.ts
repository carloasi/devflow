import { describe, it, expect } from 'vitest';
import { sameContent, canonical } from './canonicalCompare';

describe('sameContent', () => {
  // Os dois casos que a tela de comparação mostrou lado a lado como
  // "alterado" num workspace em que nada havia mudado.
  describe('o que inflava o diff de verdade', () => {
    it('header com as chaves em outra ordem é o mesmo header', () => {
      const aqui = [{ key: 'accept', value: 'text/plain', enabled: true }];
      const la = [{ enabled: true, key: 'accept', value: 'text/plain' }];
      expect(sameContent(aqui, la)).toBe(true);
    });

    it('auth com oauth2 vazio é o mesmo auth', () => {
      const aqui = { type: 'bearer', token: '{{bearerToken}}' };
      const la = { oauth2: [], token: '{{bearerToken}}', type: 'bearer' };
      expect(sameContent(aqui, la)).toBe(true);
    });

    // O id de header/param é gerado no import, nunca digitado.
    it('id diferente não é alteração', () => {
      const aqui = [{ id: 'local-1', key: 'a', value: '1' }];
      const la = [{ id: 'remoto-9', key: 'a', value: '1' }];
      expect(sameContent(aqui, la)).toBe(true);
    });

    // O app lê `enabled !== false`, então ausente é habilitado.
    it('enabled ausente é o mesmo que true', () => {
      expect(sameContent({ key: 'a', value: '1' }, { key: 'a', value: '1', enabled: true })).toBe(true);
    });

    it('CRLF e LF no corpo são o mesmo corpo', () => {
      expect(sameContent('{\r\n  "a": 1\r\n}', '{\n  "a": 1\n}')).toBe(true);
    });

    it('ausente, nulo, lista vazia e objeto vazio se equivalem', () => {
      expect(sameContent({ a: 1 }, { a: 1, b: undefined, c: null, d: [], e: {} })).toBe(true);
    });

    it('aninhado também normaliza', () => {
      const aqui = { request: { headers: [{ key: 'a', value: '1' }], auth: { type: 'none', oauth2: [] } } };
      const la = { request: { auth: { oauth2: [], type: 'none' }, headers: [{ value: '1', key: 'a', enabled: true }] } };
      expect(sameContent(aqui, la)).toBe(true);
    });
  });

  // Igualar demais é pior que o problema original: o diff passaria a
  // esconder mudança de verdade.
  describe('o que continua sendo diferença', () => {
    it('valor diferente', () => {
      expect(sameContent({ key: 'a', value: '1' }, { key: 'a', value: '2' })).toBe(false);
    });

    it('enabled false não some', () => {
      expect(sameContent({ key: 'a', enabled: false }, { key: 'a' })).toBe(false);
      expect(sameContent({ key: 'a', enabled: false }, { key: 'a', enabled: true })).toBe(false);
    });

    // Espaço sobrando numa URL é defeito, e esconder isso faria o diff mentir.
    it('espaço no fim do valor', () => {
      expect(sameContent('http://x ', 'http://x')).toBe(false);
    });

    it('maiúsculas', () => {
      expect(sameContent('Bearer', 'bearer')).toBe(false);
    });

    // Reordenar headers é edição real; igualá-la deixaria passar a mudança.
    it('ordem dos itens de um array', () => {
      expect(sameContent([{ key: 'a' }, { key: 'b' }], [{ key: 'b' }, { key: 'a' }])).toBe(false);
    });

    it('header a mais', () => {
      expect(sameContent([{ key: 'a' }], [{ key: 'a' }, { key: 'b' }])).toBe(false);
    });

    it('chave a mais com conteúdo', () => {
      expect(sameContent({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it('número e texto não se confundem', () => {
      expect(sameContent({ a: 1 }, { a: '1' })).toBe(false);
    });
  });
});

describe('canonical', () => {
  it('não altera o valor recebido', () => {
    const original = { b: 1, a: { id: 'x', k: 2 } };
    canonical(original);
    expect(Object.keys(original)).toEqual(['b', 'a']);
    expect((original.a as { id?: string }).id).toBe('x');
  });

  it('aceita primitivos e nulo', () => {
    expect(canonical(null)).toBeNull();
    expect(canonical(5)).toBe(5);
    expect(canonical(false)).toBe(false);
  });
});
