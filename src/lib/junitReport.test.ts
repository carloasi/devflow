// @vitest-environment happy-dom
// Só este arquivo precisa de DOM: o DOMParser é o que prova que o XML gerado
// é bem formado de verdade, em vez de conferir a string a olho.
import { describe, it, expect } from 'vitest';
import { buildJUnitXml, type JUnitRun } from './junitReport';

const run = (requests: JUnitRun['requests']): string =>
  buildJUnitXml({ suiteName: 'Barramento B2B', requests, timestamp: new Date('2026-01-01T00:00:00Z') });

// Valida que o XML é bem formado de verdade. Sem isso, um relatório quebrado
// só apareceria no CI de outra pessoa, como "arquivo inválido".
function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error('XML inválido: ' + error.textContent);
  return doc;
}

describe('buildJUnitXml', () => {
  it('conta testes e falhas no cabeçalho da suíte', () => {
    const xml = run([
      {
        name: 'Busca pedido',
        method: 'get',
        durationMs: 120,
        tests: [
          { name: 'status 200', passed: true, message: '' },
          { name: 'tem id', passed: false, message: 'expected undefined to be defined' },
        ],
      },
    ]);
    const suite = parse(xml).querySelector('testsuite')!;
    expect(suite.getAttribute('tests')).toBe('2');
    expect(suite.getAttribute('failures')).toBe('1');
  });

  it('usa método e nome como classname', () => {
    const xml = run([{ name: 'Busca pedido', method: 'get', durationMs: 10, tests: [{ name: 'ok', passed: true, message: '' }] }]);
    expect(parse(xml).querySelector('testcase')!.getAttribute('classname')).toBe('GET Busca pedido');
  });

  it('distingue iterações', () => {
    const xml = run([{ name: 'X', durationMs: 1, iteration: 3, tests: [{ name: 'ok', passed: true, message: '' }] }]);
    expect(parse(xml).querySelector('testcase')!.getAttribute('classname')).toContain('#3');
  });

  // Uma request que nem respondeu não pode sair como "0 testes, tudo certo".
  it('trata a falha da própria request como um caso', () => {
    const xml = run([{ name: 'Cria pedido', durationMs: 5, tests: [], failure: 'connect ECONNREFUSED' }]);
    const suite = parse(xml).querySelector('testsuite')!;
    expect(suite.getAttribute('tests')).toBe('1');
    expect(suite.getAttribute('failures')).toBe('1');
    expect(parse(xml).querySelector('failure')!.getAttribute('message')).toContain('ECONNREFUSED');
  });

  it('soma a duração em segundos', () => {
    const xml = run([
      { name: 'a', durationMs: 1500, tests: [] },
      { name: 'b', durationMs: 500, tests: [] },
    ]);
    expect(parse(xml).querySelector('testsuite')!.getAttribute('time')).toBe('2.000');
  });

  describe('conteúdo hostil', () => {
    it('escapa caracteres que invalidariam o XML', () => {
      const xml = run([
        {
          name: 'Busca <script> & "aspas"',
          durationMs: 1,
          tests: [{ name: "it's < > &", passed: false, message: 'esperava <b> & recebeu "x"' }],
        },
      ]);
      const doc = parse(xml); // joga se o XML quebrou
      expect(doc.querySelector('testcase')!.getAttribute('classname')).toBe('Busca <script> & "aspas"');
      expect(doc.querySelector('testcase')!.getAttribute('name')).toBe("it's < > &");
    });

    // Proibidos em XML 1.0 mesmo escapados; vêm de corpo binário ou truncado.
    it('remove caracteres de controle', () => {
      const xml = run([{ name: 'bin', durationMs: 1, tests: [], failure: 'corpo:\u0000\u0001 fim' }]);
      expect(() => parse(xml)).not.toThrow();
      expect(xml).not.toMatch(/[\u0000\u0001]/);
    });
  });

  it('gera suíte vazia válida quando não houve execução', () => {
    const suite = parse(run([])).querySelector('testsuite')!;
    expect(suite.getAttribute('tests')).toBe('0');
    expect(suite.getAttribute('failures')).toBe('0');
  });
});

// Este bloco existe porque o relatório saía VAZIO para o caso mais comum:
// um fluxo de requests sem nenhum pm.test. `tests="0" failures="0"` é verde
// no CI, e indistinguível de um fluxo que não chegou a rodar.
describe('request sem asserção', () => {
  const semTeste = [
    { name: 'Token v1', method: 'POST', durationMs: 490, tests: [], httpStatus: 201 },
    { name: 'Authenticate v1', method: 'POST', durationMs: 745, tests: [], httpStatus: 201 },
  ];

  it('cada request executada conta como um caso', () => {
    const suite = parse(run(semTeste)).querySelector('testsuite')!;
    expect(suite.getAttribute('tests')).toBe('2');
    expect(suite.getAttribute('failures')).toBe('0');
  });

  it('os casos trazem o nome e o método da request', () => {
    const casos = [...parse(run(semTeste)).querySelectorAll('testcase')];
    expect(casos.map(c => c.getAttribute('classname'))).toEqual([
      'POST Token v1',
      'POST Authenticate v1',
    ]);
  });

  it('o status HTTP e o tempo ficam visíveis no relatório', () => {
    const out = parse(run(semTeste)).querySelector('testcase > system-out')!;
    expect(out.textContent).toContain('HTTP 201');
    expect(out.textContent).toContain('490 ms');
  });

  it('a URL resolvida entra quando existe', () => {
    const xml = run([
      { name: 'T', durationMs: 10, tests: [], httpStatus: 200, resolvedUrl: 'https://api.x/v1/token' },
    ]);
    expect(parse(xml).querySelector('system-out')!.textContent).toContain('https://api.x/v1/token');
  });

  it('sem status ainda assim gera o caso', () => {
    const suite = parse(run([{ name: 'T', durationMs: 5, tests: [] }])).querySelector('testsuite')!;
    expect(suite.getAttribute('tests')).toBe('1');
  });

  // O caso mínimo não pode duplicar o que já foi reportado.
  it('request COM asserção não ganha um caso extra', () => {
    const xml = run([
      { name: 'T', durationMs: 10, httpStatus: 200, tests: [{ name: 'status é 200', passed: true }] },
    ]);
    const suite = parse(xml).querySelector('testsuite')!;
    expect(suite.getAttribute('tests')).toBe('1');
    expect(parse(xml).querySelector('testcase')!.getAttribute('name')).toBe('status é 200');
  });

  it('request que falhou também não ganha caso extra', () => {
    const xml = run([{ name: 'T', durationMs: 10, tests: [], failure: 'connection refused' }]);
    const suite = parse(xml).querySelector('testsuite')!;
    expect(suite.getAttribute('tests')).toBe('1');
    expect(suite.getAttribute('failures')).toBe('1');
  });

  // URL resolvida pode trazer & de querystring; o XML não pode quebrar.
  it('a URL é escapada', () => {
    const xml = run([
      { name: 'T', durationMs: 5, tests: [], resolvedUrl: 'https://x/a?b=1&c=<2>' },
    ]);
    expect(() => parse(xml)).not.toThrow();
    expect(parse(xml).querySelector('system-out')!.textContent).toContain('b=1&c=<2>');
  });
});
