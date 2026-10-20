import { describe, it, expect } from 'vitest';
import { isBlankValue, sanitizeVariableHistory } from './variableHistory';

describe('isBlankValue', () => {
  it('vazio e só espaço são em branco', () => {
    expect(isBlankValue('')).toBe(true);
    expect(isBlankValue('   ')).toBe(true);
    expect(isBlankValue('\n\t')).toBe(true);
  });

  it('valor com conteúdo não é', () => {
    expect(isBlankValue('http://localhost:6015')).toBe(false);
    expect(isBlankValue('0')).toBe(false);
  });
});

describe('sanitizeVariableHistory', () => {
  it('preserva os valores reais', () => {
    const stored = { urlApi: ['http://localhost:6015', 'https://tst.azul.corp/x'] };
    expect(sanitizeVariableHistory(stored)).toEqual(stored);
  });

  // Quem já usou o app tem o "empty" salvo, e ele não sairia sozinho —
  // restaurá-lo apagaria o valor atual.
  it('remove o vazio que já estava gravado', () => {
    const stored = { urlApi: ['http://localhost:6015', '', 'https://tst.azul.corp/x'] };
    expect(sanitizeVariableHistory(stored).urlApi).toEqual([
      'http://localhost:6015',
      'https://tst.azul.corp/x',
    ]);
  });

  it('remove valor só com espaço', () => {
    expect(sanitizeVariableHistory({ k: ['  ', 'a'] }).k).toEqual(['a']);
  });

  it('variável que só tinha vazio fica com lista vazia, não some', () => {
    expect(sanitizeVariableHistory({ k: [''] })).toEqual({ k: [] });
  });

  // A chave é de localStorage: uma versão anterior pode ter gravado outra
  // coisa, e quebrar a leitura derrubaria o histórico inteiro.
  describe('conteúdo fora do formato', () => {
    it('nulo e tipos errados viram mapa vazio', () => {
      expect(sanitizeVariableHistory(null)).toEqual({});
      expect(sanitizeVariableHistory('texto')).toEqual({});
      expect(sanitizeVariableHistory(['a'])).toEqual({});
    });

    it('entrada que não é lista é ignorada sem derrubar as outras', () => {
      expect(sanitizeVariableHistory({ ruim: 'x', boa: ['v'] })).toEqual({ boa: ['v'] });
    });

    it('item que não é string sai da lista', () => {
      expect(sanitizeVariableHistory({ k: ['a', 42, null, 'b'] }).k).toEqual(['a', 'b']);
    });
  });
});
