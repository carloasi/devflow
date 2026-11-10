import { describe, expect, it } from 'vitest';
import { detectVariableTagTrigger } from './variableTagTrigger';

describe('detectVariableTagTrigger', () => {
  it('retorna null sem nenhum "{{" na linha', () => {
    const line = '"origin": "VCP"';
    expect(detectVariableTagTrigger(line, line.length + 1)).toBeNull();
  });

  it('dispara logo depois de "{{", com query vazia', () => {
    const line = '"departure": "{{';
    expect(detectVariableTagTrigger(line, line.length + 1)).toEqual({
      openIdx: 14,
      query: '',
    });
  });

  it('inclui o que já foi digitado depois do "{{" na query', () => {
    const line = '"departure": "{{departureIda';
    expect(detectVariableTagTrigger(line, line.length + 1)).toEqual({
      openIdx: 14,
      query: 'departureIda',
    });
  });

  it('tira espaços da query (ex: "{{ departureIda")', () => {
    const line = '"departure": "{{  departureIda';
    expect(detectVariableTagTrigger(line, line.length + 1)?.query).toBe('departureIda');
  });

  it('retorna null quando a tag já foi fechada antes do cursor', () => {
    const line = '"departure": "{{departureIda}}", "origin": "VCP"';
    const col = line.indexOf('}}') + 2 + 1; // logo depois do "}}"
    expect(detectVariableTagTrigger(line, col)).toBeNull();
  });

  // O caso do bug: o Monaco auto-fecha "{{" em "{{}}" (par de JSON). Digitar
  // o "}" de fechamento não insere nada — só pula por cima do que já estava
  // lá (type-over), deixando o cursor ENTRE os dois "}". Sem o fix, isso
  // parecia uma tag ainda aberta e reabria o menu com "nome}" na busca.
  it('retorna null com o cursor ENTRE os dois "}" de um fechamento (type-over)', () => {
    const line = '"departure": "{{departureIda}}", "origin": "VCP"';
    const col = line.indexOf('}}') + 1 + 1; // entre o 1º e o 2º "}"
    expect(detectVariableTagTrigger(line, col)).toBeNull();
  });

  it('mesmo caso ao clicar de volta no meio de uma variável já fechada', () => {
    // Sem digitar nada agora — só posicionar o cursor ali (ex: clique do
    // mouse) já dispara o mesmo onDidChangeCursorPosition.
    const line = '{{bearerToken}}';
    const col = line.indexOf('}}') + 1 + 1;
    expect(detectVariableTagTrigger(line, col)).toBeNull();
  });

  it('não confunde "}}" de JSON aninhado sem nenhum "{{" de variável', () => {
    const line = '{"a": {"b": 1}}';
    const col = line.lastIndexOf('}}') + 1 + 1; // entre os dois "}" finais
    expect(detectVariableTagTrigger(line, col)).toBeNull();
  });

  it('usa o "{{" mais próximo quando há mais de uma tag na linha', () => {
    const line = '{{varA}} meio {{varB';
    expect(detectVariableTagTrigger(line, line.length + 1)).toEqual({
      openIdx: line.lastIndexOf('{{'),
      query: 'varB',
    });
  });
});
