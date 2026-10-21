import { describe, it, expect } from 'vitest';
import {
  detectDelimiter,
  envForRow,
  parseCsv,
  parseDataFile,
  parseJsonRows,
  rowLabel,
} from './runnerData';

const ok = (r: ReturnType<typeof parseCsv>) => {
  if (!r.ok) throw new Error('esperava sucesso, veio: ' + r.error);
  return r.data;
};

describe('detectDelimiter', () => {
  it('vírgula', () => {
    expect(detectDelimiter('cenario,documento,esperado')).toBe(',');
  });

  // Excel em português exporta com ponto e vírgula. Exigir vírgula obrigaria a
  // converter o arquivo antes — e quem converte erra.
  it('ponto e vírgula', () => {
    expect(detectDelimiter('cenario;documento;esperado')).toBe(';');
  });

  it('tabulação', () => {
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
  });

  // `"Smith, John";42` tem uma vírgula que não separa nada.
  it('ignora o separador dentro de aspas', () => {
    expect(detectDelimiter('"nome, completo";idade')).toBe(';');
  });

  it('uma coluna só cai na vírgula', () => {
    expect(detectDelimiter('cenario')).toBe(',');
  });
});

describe('parseCsv', () => {
  it('cabeçalho e linhas', () => {
    const data = ok(parseCsv('cenario,documento\npassport,AB123\ncpf,12345678901'));
    expect(data.columns).toEqual(['cenario', 'documento']);
    expect(data.rows).toEqual([
      { cenario: 'passport', documento: 'AB123' },
      { cenario: 'cpf', documento: '12345678901' },
    ]);
  });

  // Split ingênuo não falha aqui: ele desloca as colunas em silêncio e o teste
  // roda com os dados errados.
  it('vírgula dentro de campo com aspas', () => {
    const data = ok(parseCsv('nome,obs\n"Silva, Carlos",ok'));
    expect(data.rows[0]).toEqual({ nome: 'Silva, Carlos', obs: 'ok' });
  });

  it('aspas escapadas', () => {
    const data = ok(parseCsv('texto\n"ele disse ""oi"""'));
    expect(data.rows[0].texto).toBe('ele disse "oi"');
  });

  it('quebra de linha dentro de campo', () => {
    const data = ok(parseCsv('corpo,id\n"linha1\nlinha2",7'));
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toEqual({ corpo: 'linha1\nlinha2', id: '7' });
  });

  it('CRLF do Windows', () => {
    const data = ok(parseCsv('a,b\r\n1,2\r\n3,4'));
    expect(data.rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  // Se o BOM ficar, a primeira coluna vira "﻿id" e nenhuma {{id}} resolve.
  it('BOM do Excel é removido', () => {
    const data = ok(parseCsv('﻿id,valor\n1,x'));
    expect(data.columns[0]).toBe('id');
    expect(data.rows[0].id).toBe('1');
  });

  it('linha em branco no fim é ignorada', () => {
    const data = ok(parseCsv('a\n1\n\n'));
    expect(data.rows).toEqual([{ a: '1' }]);
  });

  it('célula faltando vira string vazia', () => {
    const data = ok(parseCsv('a,b,c\n1,2'));
    expect(data.rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('ponto e vírgula ponta a ponta', () => {
    const data = ok(parseCsv('cenario;doc\nmercosur;X1'));
    expect(data.rows[0]).toEqual({ cenario: 'mercosur', doc: 'X1' });
  });

  it('arquivo vazio', () => {
    expect(parseCsv('   ')).toEqual({ ok: false, error: 'The file is empty.' });
  });

  it('só cabeçalho', () => {
    const r = parseCsv('a,b');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/no rows/i);
  });
});

describe('parseJsonRows', () => {
  it('array de objetos', () => {
    const data = ok(parseJsonRows('[{"cpf":"1"},{"cpf":"2"}]'));
    expect(data.columns).toEqual(['cpf']);
    expect(data.rows).toEqual([{ cpf: '1' }, { cpf: '2' }]);
  });

  // Variável de ambiente é texto; número tem que virar string ou a
  // substituição em {{campo}} sairia "[object Object]" ou quebraria.
  it('número vira texto', () => {
    expect(ok(parseJsonRows('[{"idade":42}]')).rows[0].idade).toBe('42');
  });

  it('objeto aninhado vira JSON, pra caber num body', () => {
    expect(ok(parseJsonRows('[{"p":{"a":1}}]')).rows[0].p).toBe('{"a":1}');
  });

  it('null vira vazio', () => {
    expect(ok(parseJsonRows('[{"x":null}]')).rows[0].x).toBe('');
  });

  it('colunas de todas as linhas, na ordem de aparição', () => {
    const data = ok(parseJsonRows('[{"a":1},{"b":2}]'));
    expect(data.columns).toEqual(['a', 'b']);
  });

  it('JSON inválido explica o erro', () => {
    const r = parseJsonRows('[{');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Invalid JSON/);
  });

  it('não é array', () => {
    const r = parseJsonRows('{"a":1}');
    expect(!r.ok && r.error).toMatch(/array of objects/i);
  });

  it('array vazio', () => {
    expect(!parseJsonRows('[]').ok).toBe(true);
  });

  it('item que não é objeto aponta a posição', () => {
    const r = parseJsonRows('[{"a":1},"x"]');
    expect(!r.ok && r.error).toMatch(/Item 2/);
  });
});

describe('parseDataFile', () => {
  it('escolhe JSON pela extensão', () => {
    expect(ok(parseDataFile('[{"a":"1"}]', 'casos.json')).rows[0].a).toBe('1');
  });

  it('escolhe CSV pela extensão', () => {
    expect(ok(parseDataFile('a,b\n1,2', 'casos.csv')).columns).toEqual(['a', 'b']);
  });

  // Arquivo arrastado de outro lugar pode não ter extensão.
  it('sem extensão, decide pelo conteúdo', () => {
    expect(ok(parseDataFile('[{"a":"1"}]')).rows[0].a).toBe('1');
    expect(ok(parseDataFile('a\n1')).columns).toEqual(['a']);
  });
});

describe('rowLabel', () => {
  // Numa planilha de caso de teste a primeira coluna é o nome do cenário.
  it('usa a primeira coluna', () => {
    expect(rowLabel({ cenario: 'passport válido', doc: 'X' }, ['cenario', 'doc'], 0)).toBe(
      'passport válido'
    );
  });

  it('primeira coluna vazia cai no número da linha', () => {
    expect(rowLabel({ cenario: '  ' }, ['cenario'], 3)).toBe('Row 4');
  });

  it('sem colunas', () => {
    expect(rowLabel({}, [], 0)).toBe('Row 1');
  });
});

describe('envForRow', () => {
  it('junta base e linha', () => {
    expect(envForRow({ base: 'b' }, { cpf: '1' })).toEqual({ base: 'b', cpf: '1' });
  });

  // A linha é o que distingue este caso dos outros.
  it('a linha vence a base', () => {
    expect(envForRow({ cpf: 'antigo' }, { cpf: 'novo' }).cpf).toBe('novo');
  });

  it('não altera a base recebida', () => {
    const base = { a: '1' };
    envForRow(base, { a: '2' });
    expect(base.a).toBe('1');
  });
});
