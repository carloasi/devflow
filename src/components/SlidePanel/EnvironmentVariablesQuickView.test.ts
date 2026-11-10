import { describe, it, expect } from 'vitest';
import { copyVariablesInto, findTargetIndex } from './EnvironmentVariablesQuickView';
import type { Environment, EnvironmentValue } from '@/app/types/Environment';

// "Copy to environment..." (ver EnvironmentVariablesQuickView.tsx) — valida
// que value e description chegam no destino, tanto criando uma variável nova
// quanto sobrescrevendo uma que já existia lá (pedido do usuário: confirmar
// que a feature manda os dois, não só o valor).

const value = (overrides: Partial<EnvironmentValue>): EnvironmentValue => ({
  id: 'id-origem',
  key: 'quoteToken',
  value: 'eyJhbGciOiJIUzI1NiIs',
  type: 'default',
  enabled: true,
  description: 'Token da cotação ativa',
  ...overrides,
});

const target = (values: EnvironmentValue[]): Environment => ({
  id: 'env-destino',
  name: 'Destino',
  values,
});

describe('copyVariablesInto', () => {
  it('cria a variável no destino com o MESMO valor e a MESMA descrição', () => {
    const { values, added, overwritten } = copyVariablesInto(target([]), [value({})]);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      key: 'quoteToken',
      value: 'eyJhbGciOiJIUzI1NiIs',
      description: 'Token da cotação ativa',
    });
    expect(added).toBe(1);
    expect(overwritten).toBe(0);
  });

  it('sobrescreve uma variável existente com o valor E a descrição da origem', () => {
    const existing = target([
      value({ id: 'id-destino', value: 'valor-antigo', description: 'descrição antiga' }),
    ]);
    const { values, added, overwritten } = copyVariablesInto(existing, [
      value({ value: 'valor-novo', description: 'descrição nova' }),
    ]);
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe('valor-novo');
    expect(values[0].description).toBe('descrição nova');
    expect(values[0].id).toBe('id-destino'); // id do destino é preservado
    expect(added).toBe(0);
    expect(overwritten).toBe(1);
  });

  it('origem sem descrição NÃO apaga a descrição que já existia no destino', () => {
    const existing = target([value({ id: 'id-destino', description: 'documentação do destino' })]);
    const { values } = copyVariablesInto(existing, [value({ description: '' })]);
    expect(values[0].description).toBe('documentação do destino');
  });

  it('origem sem descrição E destino novo (sem nada pra herdar) fica com descrição vazia, não undefined', () => {
    const { values } = copyVariablesInto(target([]), [value({ description: '' })]);
    expect(values[0].description).toBe('');
  });

  it('o valor sempre vem da origem, mesmo quando a descrição é herdada do destino', () => {
    const existing = target([value({ id: 'id-destino', value: 'valor-do-destino', description: 'doc' })]);
    const { values } = copyVariablesInto(existing, [value({ value: 'valor-da-origem', description: '' })]);
    expect(values[0].value).toBe('valor-da-origem');
  });
});

describe('findTargetIndex', () => {
  it('prefere a entrada HABILITADA quando a key está duplicada', () => {
    const values = [
      value({ id: 'a', enabled: false }),
      value({ id: 'b', enabled: true }),
    ];
    expect(findTargetIndex(values, 'quoteToken')).toBe(1);
  });

  it('sem nenhuma habilitada, cai na primeira', () => {
    const values = [value({ id: 'a', enabled: false }), value({ id: 'b', enabled: false })];
    expect(findTargetIndex(values, 'quoteToken')).toBe(0);
  });

  it('key que não existe devolve -1', () => {
    expect(findTargetIndex([value({})], 'outraKey')).toBe(-1);
  });
});
