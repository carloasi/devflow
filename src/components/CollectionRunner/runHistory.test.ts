import { describe, it, expect } from 'vitest';
import { trimRunForStorage, DEFAULT_TRIM_LIMITS, type StoredRun, type TrimLimits } from './runHistory';
import type { RunEntry } from './runCollectionRequest';

function entry(id: string, body?: string, fullBody?: string): RunEntry {
  return {
    id,
    itemId: id,
    iteration: 1,
    name: `Request ${id}`,
    method: 'POST',
    state: 'success',
    outcome: {
      itemId: id,
      status: 'success',
      httpStatus: 200,
      responseTime: 120,
      tests: [{ name: 'status 200', passed: true, message: '' }],
      envAfter: {},
      logs: [],
      variablesSet: [],
      responseBodySnippet: body,
      fullResponseBody: fullBody,
    },
  };
}

const run = (entries: RunEntry[]): StoredRun => ({
  collectionId: 'c1',
  collectionName: 'Flow 01',
  finishedAt: '2026-10-09T12:00:00.000Z',
  entries,
});

// Limites miúdos pra exercitar a DEGRADAÇÃO sem montar megabytes. O que se
// testa aqui é a ordem dos cortes, não o valor das constantes.
const tiny: TrimLimits = { budget: 4000, storedBodyMax: 800, smallSnippet: 100, maxEntries: 3 };

describe('trimRunForStorage', () => {
  // O painel exibe fullResponseBody; o limite antigo de 10k cortava uma
  // resposta de 15KB e ela reaparecia como "Showing 9.8 KB of 15.2 KB".
  it('mantém a resposta inteira nos limites de produção', () => {
    const body = JSON.stringify({ orders: 'x'.repeat(400_000) });
    const trimmed = trimRunForStorage(run([entry('a', body.slice(0, 2000), body)]));
    expect(trimmed.entries[0].outcome?.fullResponseBody).toBe(body);
  });

  it('ainda assim corta um corpo absurdo, pra não virar arquivo gigante', () => {
    const huge = 'x'.repeat(DEFAULT_TRIM_LIMITS.storedBodyMax + 5_000);
    const stored = trimRunForStorage(run([entry('a', 'resumo', huge)])).entries[0].outcome;
    expect(stored?.fullResponseBody?.length).toBe(DEFAULT_TRIM_LIMITS.storedBodyMax);
    expect(stored?.responseBodySnippet).toBe('resumo');
  });

  it('preserva o run inteiro quando ele já cabe', () => {
    const trimmed = trimRunForStorage(run([entry('a', 'ok'), entry('b', 'ok')]), tiny);
    expect(trimmed.entries).toHaveLength(2);
    expect(trimmed.truncated).toBeUndefined();
  });

  // A ordem dos cortes é deliberada: status, tempo e testes de TODAS as
  // linhas valem mais que o corpo de algumas.
  describe('degradação, quando não cabe', () => {
    const many = (n: number, bodyLen: number) =>
      Array.from({ length: n }, (_, i) => entry(String(i), 'y'.repeat(bodyLen), 'z'.repeat(bodyLen)));

    it('o corpo completo cai primeiro, porque dele sobra o snippet', () => {
      const trimmed = trimRunForStorage(run(many(6, 300)), tiny);
      expect(trimmed.entries.every(e => e.outcome?.fullResponseBody === undefined)).toBe(true);
      expect(trimmed.entries.every(e => !!e.outcome?.responseBodySnippet)).toBe(true);
      expect(trimmed.entries).toHaveLength(6);
    });

    it('depois encurta o snippet, ainda sem descartar linha', () => {
      const trimmed = trimRunForStorage(run(many(8, 400)), tiny);
      expect(trimmed.entries).toHaveLength(8);
      expect(trimmed.entries[0].outcome?.responseBodySnippet!.length).toBeLessThanOrEqual(tiny.smallSnippet);
    });

    it('mantém status e testes de todas as linhas', () => {
      const trimmed = trimRunForStorage(run(many(8, 400)), tiny);
      expect(trimmed.entries.every(e => e.outcome?.httpStatus === 200)).toBe(true);
      expect(trimmed.entries.every(e => e.outcome?.tests.length === 1)).toBe(true);
    });

    // O passo que descarta o snippet não pode ressuscitar o corpo completo
    // que o passo anterior tirou.
    it('não devolve o corpo completo num passo posterior', () => {
      const trimmed = trimRunForStorage(run(many(200, 600)), tiny);
      expect(trimmed.entries.every(e => e.outcome?.fullResponseBody === undefined)).toBe(true);
    });

    it('fica abaixo do orçamento mesmo no pior caso', () => {
      const trimmed = trimRunForStorage(run(many(500, 900)), tiny);
      expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(tiny.budget);
    });

    it('avisa quando precisou cortar linhas, em vez de mentir no placar', () => {
      const trimmed = trimRunForStorage(run(many(500, 900)), tiny);
      expect(trimmed.truncated).toBe(true);
      expect(trimmed.entries.length).toBeLessThan(500);
      // Mantém o começo: o Runner roda um fluxo em ordem.
      expect(trimmed.entries[0].id).toBe('0');
    });
  });

  it('não altera o run recebido', () => {
    const original = run([entry('a', 'resumo', 'x'.repeat(5_000))]);
    trimRunForStorage(original, tiny);
    expect(original.entries[0].outcome?.fullResponseBody).toHaveLength(5_000);
  });
});
