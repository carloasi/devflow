import { describe, it, expect } from 'vitest';
import { entryBytes, planEviction, DEAD_PREFIXES, type StoredItem } from './safeStorage';

const item = (key: string, bytes: number, touchedAt: number): StoredItem => ({
  key,
  bytes,
  touchedAt,
});

describe('entryBytes', () => {
  // Chromium mede a cota em UTF-16 e cobra a chave junto com o valor. Medir
  // em bytes de UTF-8 subestimaria a conta e o orçamento estouraria antes.
  it('conta chave e valor, a 2 bytes por caractere', () => {
    expect(entryBytes('ab', 'cde')).toBe(10);
  });

  it('valor vazio ainda custa a chave', () => {
    expect(entryBytes('abc', '')).toBe(6);
  });
});

describe('planEviction', () => {
  it('não remove nada quando já cabe', () => {
    expect(planEviction([item('a', 100, 1)], 1000)).toEqual([]);
  });

  it('exatamente no orçamento não remove', () => {
    expect(planEviction([item('a', 100, 1)], 100)).toEqual([]);
  });

  it('remove o mais antigo primeiro', () => {
    // 180 no total, orçamento 60: saem os dois mais antigos, nessa ordem.
    const items = [item('novo', 60, 300), item('velho', 60, 100), item('meio', 60, 200)];
    expect(planEviction(items, 60)).toEqual(['velho', 'meio']);
  });

  it('para assim que couber, sem remover a mais', () => {
    const items = [item('a', 50, 1), item('b', 50, 2), item('c', 50, 3)];
    expect(planEviction(items, 100)).toEqual(['a']);
  });

  // Empate acontece com entradas ilegíveis, todas em touchedAt 0: sair pela
  // maior libera mais espaço por remoção.
  it('no empate de idade, a maior sai antes', () => {
    const items = [item('pequena', 10, 0), item('grande', 500, 0)];
    expect(planEviction(items, 100)).toEqual(['grande']);
  });

  it('orçamento zero remove tudo', () => {
    const items = [item('a', 10, 1), item('b', 10, 2)];
    expect(planEviction(items, 0).sort()).toEqual(['a', 'b']);
  });

  it('não altera a lista recebida', () => {
    const items = [item('a', 60, 2), item('b', 60, 1)];
    planEviction(items, 60);
    expect(items.map(i => i.key)).toEqual(['a', 'b']);
  });

  it('lista vazia', () => {
    expect(planEviction([], 0)).toEqual([]);
  });
});

describe('DEAD_PREFIXES', () => {
  // Estes vieram da migração do histórico de runs pro runner-history.json.
  // Se alguém voltar a usar o prefixo em código novo, o teste não pega — mas
  // a lista fica visível e explicada num lugar só.
  it('cobre os restos conhecidos', () => {
    expect([...DEAD_PREFIXES]).toEqual(['devflow_runner_last', 'response-viewer:']);
  });

  it('o prefixo de runs pega tanto a chave solta quanto as por collection', () => {
    const [runner] = DEAD_PREFIXES;
    expect('devflow_runner_last'.startsWith(runner)).toBe(true);
    expect('devflow_runner_last_run:abc-123'.startsWith(runner)).toBe(true);
  });

  // O histórico de respostas NÃO é lixo: ele é orçado, não varrido.
  it('não alcança o histórico de respostas', () => {
    const key = 'devflow_response_history_abc';
    expect(DEAD_PREFIXES.some(p => key.startsWith(p))).toBe(false);
  });
});
