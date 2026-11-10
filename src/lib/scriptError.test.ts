import { describe, it, expect } from 'vitest';
import { parseScriptError } from './scriptError';

// Strings REAIS do formato que o sandbox devolve — medidas rodando o
// rquickjs 0.9 isolado (mesma versão do src-tauri/Cargo.toml) contra os
// throws que o SCRIPTING.md documenta, não inventadas.
describe('parseScriptError', () => {
  it('throw de Error: resumo é "Nome: mensagem", detail guarda o stack', () => {
    const raw =
      '❌ ReferenceError: order is not defined\n📜 Stack Trace:\n    at <eval> (eval_script:3:14)';
    const { summary, detail } = parseScriptError(raw);
    expect(summary).toBe('ReferenceError: order is not defined');
    expect(detail).toBe(raw);
  });

  it('TypeError de propriedade de undefined', () => {
    const raw =
      "❌ TypeError: cannot read property '0' of undefined\n📜 Stack Trace:\n    at <eval> (eval_script:2:34)";
    expect(parseScriptError(raw).summary).toBe(
      "TypeError: cannot read property '0' of undefined"
    );
  });

  it('pilha com várias chamadas aninhadas vai inteira pro detail', () => {
    const raw =
      '❌ Error: fundo do poço\n📜 Stack Trace:\n    at inner (eval_script:1:29)\n    at outer (eval_script:2:20)\n    at <eval> (eval_script:3:1)';
    const { summary, detail } = parseScriptError(raw);
    expect(summary).toBe('Error: fundo do poço');
    expect(detail.split('\n')).toHaveLength(5);
  });

  it('erro de sintaxe (sem Stack Trace, formato "❌ Error: msg")', () => {
    const raw = "❌ Error: unexpected token in expression: ';'";
    expect(parseScriptError(raw).summary).toBe("Error: unexpected token in expression: ';'");
  });

  it('throw de um valor que não é Error (string/número/objeto)', () => {
    expect(parseScriptError('❌ Thrown value: oops').summary).toBe('Thrown value: oops');
    expect(parseScriptError('❌ Thrown value: 42').summary).toBe('Thrown value: 42');
    expect(parseScriptError('❌ Thrown value: {"codigo":1}').summary).toBe(
      'Thrown value: {"codigo":1}'
    );
  });

  it('texto vazio ou só espaço não quebra — some com um resumo genérico', () => {
    expect(parseScriptError('').summary).toBe('Script error');
    expect(parseScriptError('   ').summary).toBe('Script error');
  });

  it('sem o prefixo ❌ (ex: erro cru do catch do invoke) usa a linha toda', () => {
    const raw = 'invoke error: window destroyed';
    expect(parseScriptError(raw).summary).toBe('invoke error: window destroyed');
  });

  it('detail sempre preserva o texto original aparado', () => {
    const raw = '  ❌ Error: x  \n\n';
    expect(parseScriptError(raw).detail).toBe('❌ Error: x');
  });
});
