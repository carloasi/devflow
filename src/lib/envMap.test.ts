import { describe, it, expect } from 'vitest';
import { buildEnvMap, findAmbiguousKeys } from './envMap';
import type { EnvironmentValue } from '@/app/types/Environment';

const v = (key: string, value: string, enabled = true): EnvironmentValue => ({
  id: `${key}-${value}`,
  key,
  value,
  type: 'default',
  enabled,
});

describe('buildEnvMap', () => {
  it('monta o mapa das habilitadas', () => {
    expect(buildEnvMap([v('baseUrl', 'https://api'), v('token', 'abc')])).toEqual({
      baseUrl: 'https://api',
      token: 'abc',
    });
  });

  // Desabilitar é como o app "arquiva" um valor sem perder (ver
  // DuplicateVariablePicker): ele não pode vazar pra execução.
  it('ignora as desabilitadas', () => {
    expect(buildEnvMap([v('username', '20202020WS'), v('username', '5by5admext', false)])).toEqual({
      username: '20202020WS',
    });
  });

  it('ignora entrada sem key', () => {
    expect(buildEnvMap([v('', 'orfao'), v('a', '1')])).toEqual({ a: '1' });
  });

  it('aceita lista vazia ou ausente', () => {
    expect(buildEnvMap([])).toEqual({});
    expect(buildEnvMap(undefined)).toEqual({});
  });

  it('converte valor não-string', () => {
    const numeric = { ...v('port', ''), value: 8080 as unknown as string };
    expect(buildEnvMap([numeric])).toEqual({ port: '8080' });
  });

  // O ponto do módulo. A escrita (syncEnvToGlobal/patchEnvironmentVariables)
  // sempre mexeu na PRIMEIRA habilitada; a leitura ficava com a última, então
  // pm.environment.set gravava numa entrada e a request lia a outra.
  describe('duas habilitadas com a mesma key', () => {
    it('fica com a primeira, como a escrita faz', () => {
      expect(buildEnvMap([v('token', 'novo'), v('token', 'velho')])).toEqual({ token: 'novo' });
    });

    it('não é a ordem do Object.fromEntries, que pegava a última', () => {
      const values = [v('token', 'primeiro'), v('token', 'ultimo')];
      const old = Object.fromEntries(values.filter(x => x.enabled).map(x => [x.key, String(x.value)]));
      expect(old.token).toBe('ultimo');
      expect(buildEnvMap(values).token).toBe('primeiro');
    });

    it('pula a desabilitada no meio', () => {
      expect(buildEnvMap([v('a', '1', false), v('a', '2'), v('a', '3')])).toEqual({ a: '2' });
    });
  });
});

describe('findAmbiguousKeys', () => {
  it('não acusa nada quando só uma está habilitada', () => {
    expect(findAmbiguousKeys([v('username', 'a'), v('username', 'b', false)])).toEqual([]);
  });

  it('acusa a key com duas habilitadas', () => {
    expect(findAmbiguousKeys([v('userAgent', ''), v('userAgent', '')])).toEqual(['userAgent']);
  });

  it('não repete a mesma key', () => {
    expect(findAmbiguousKeys([v('a', '1'), v('a', '2'), v('a', '3')])).toEqual(['a']);
  });
});
