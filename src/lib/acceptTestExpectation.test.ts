import { describe, it, expect } from 'vitest';
import { acceptTestExpectation } from './acceptTestExpectation';

describe('acceptTestExpectation', () => {
  it('atualiza .to.equal(...) com o valor que a resposta trouxe', () => {
    const script = `
pm.test("jornada excluída na sessão (200)", function () {
  pm.expect(pm.response.code).to.equal(200);
});`;
    const result = acceptTestExpectation(script, 'jornada excluída na sessão (200)', 'expected 400 to equal 200');
    expect(result).toContain('pm.expect(pm.response.code).to.equal(400)');
  });

  it('atualiza o número entre parênteses no nome do teste junto com a asserção', () => {
    const script = `pm.test("jornada excluída na sessão (200)", function () { pm.expect(pm.response.code).to.equal(200); });`;
    const result = acceptTestExpectation(script, 'jornada excluída na sessão (200)', 'expected 400 to equal 200');
    expect(result).toContain('pm.test("jornada excluída na sessão (400)"');
  });

  it('atualiza .to.eql(...) (mensagem "to deeply equal")', () => {
    const script = `pm.test("body check", function () { pm.expect(pm.response.json()).to.eql(200); });`;
    const result = acceptTestExpectation(script, 'body check', 'expected 400 to deeply equal 200');
    expect(result).toContain('.to.eql(400)');
  });

  it('acha o teste certo quando há mais de um pm.test no script', () => {
    const script = `
pm.test("primeiro", function () { pm.expect(1).to.equal(1); });
pm.test("segundo", function () { pm.expect(pm.response.code).to.equal(200); });
pm.test("terceiro", function () { pm.expect(2).to.equal(2); });`;
    const result = acceptTestExpectation(script, 'segundo', 'expected 400 to equal 200');
    expect(result).toContain('pm.test("segundo", function () { pm.expect(pm.response.code).to.equal(400); });');
    // Os outros ficam intocados.
    expect(result).toContain('pm.test("primeiro", function () { pm.expect(1).to.equal(1); });');
    expect(result).toContain('pm.test("terceiro", function () { pm.expect(2).to.equal(2); });');
  });

  it('funciona com nome de teste entre aspas simples', () => {
    const script = `pm.test('status ok', function () { pm.expect(pm.response.code).to.equal(200); });`;
    const result = acceptTestExpectation(script, 'status ok', 'expected 400 to equal 200');
    expect(result).toContain('.to.equal(400)');
  });

  it('funciona com valores string (aspas no literal)', () => {
    const script = `pm.test("status text", function () { pm.expect(pm.response.json().status).to.equal("OK"); });`;
    const result = acceptTestExpectation(script, 'status text', 'expected "FAILED" to equal "OK"');
    expect(result).toContain('.to.equal("FAILED")');
  });

  it('devolve null quando a mensagem não é do formato "expected X to equal Y"', () => {
    const script = `pm.test("x", function () { pm.expect(true).to.be.ok; });`;
    expect(acceptTestExpectation(script, 'x', 'expected value to be truthy')).toBeNull();
  });

  it('devolve null quando a mensagem é de pm.expect(...).to.have.property(...)', () => {
    const script = `pm.test("x", function () { pm.expect(obj).to.have.property('foo', 200); });`;
    expect(acceptTestExpectation(script, 'x', "expected property 'foo' to equal 200")).toBeNull();
  });

  it('devolve null quando o nome do teste não existe no script', () => {
    const script = `pm.test("outro nome", function () { pm.expect(pm.response.code).to.equal(200); });`;
    expect(acceptTestExpectation(script, 'nome que não existe', 'expected 400 to equal 200')).toBeNull();
  });

  it('devolve null quando o valor esperado aparece mais de uma vez no bloco (ambíguo)', () => {
    const script = `pm.test("duplo", function () {
      pm.expect(pm.response.code).to.equal(200);
      pm.expect(pm.variables.get('count')).to.equal(200);
    });`;
    expect(acceptTestExpectation(script, 'duplo', 'expected 400 to equal 200')).toBeNull();
  });

  it('devolve null quando actual e expected são iguais (nada pra aceitar)', () => {
    const script = `pm.test("x", function () { pm.expect(200).to.equal(200); });`;
    expect(acceptTestExpectation(script, 'x', 'expected 200 to equal 200')).toBeNull();
  });
});
