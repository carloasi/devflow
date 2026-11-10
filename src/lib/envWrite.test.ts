import { describe, it, expect } from 'vitest';
import type { EnvironmentValue } from '@/app/types/Environment';
import { applyEnvPatch, detectEnvLosses } from './envWrite';

const val = (over: Partial<EnvironmentValue> & { key: string }): EnvironmentValue => ({
  id: `id-${over.key}-${over.value ?? ''}`,
  value: '',
  type: 'default',
  enabled: true,
  description: '',
  ...over,
});

describe('applyEnvPatch > gravar', () => {
  it('grava na entrada existente', () => {
    const out = applyEnvPatch([val({ key: 'token', value: 'velho' })], {}, { token: 'novo' });
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe('novo');
  });

  it('preserva id, type e description ao gravar', () => {
    const antes = val({ key: 'token', value: 'a', id: 'fixo', type: 'secret', description: 'o token' });
    const [depois] = applyEnvPatch([antes], {}, { token: 'b' });
    expect(depois).toEqual({ ...antes, value: 'b' });
  });

  // O bug do popover da URL bar: ele gravava em TODA entrada com a key, e a
  // desabilitada existe justamente pra guardar o valor do outro ambiente.
  it('grava só na HABILITADA quando a key está duplicada', () => {
    const out = applyEnvPatch(
      [
        val({ key: 'baseUrl', value: 'https://homolog', enabled: false }),
        val({ key: 'baseUrl', value: 'https://prod', enabled: true }),
      ],
      {},
      { baseUrl: 'https://novo' }
    );
    expect(out.map(v => [v.value, v.enabled])).toEqual([
      ['https://homolog', false],
      ['https://novo', true],
    ]);
  });

  it('sem nenhuma habilitada, reativa a primeira com aquela key', () => {
    const out = applyEnvPatch(
      [val({ key: 'baseUrl', value: 'x', enabled: false })],
      {},
      { baseUrl: 'y' }
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ value: 'y', enabled: true });
  });

  it('key que não existe nasce habilitada e COM id', () => {
    const [novo] = applyEnvPatch([], {}, { novaVar: '2761' });
    expect(novo).toMatchObject({ key: 'novaVar', value: '2761', enabled: true, type: 'default' });
    // O painel de Environment usa o id como chave de lista; sem ele a lista
    // embaralha ao renderizar.
    expect(novo.id).toBeTruthy();
  });

  it('não mexe nas outras variáveis', () => {
    const outra = val({ key: 'outra', value: 'intacta' });
    const out = applyEnvPatch([outra, val({ key: 'token', value: 'a' })], {}, { token: 'b' });
    expect(out[0]).toBe(outra);
  });

  it('valor igual ao anterior não reescreve a entrada', () => {
    const antes = val({ key: 'token', value: 'mesmo' });
    const out = applyEnvPatch([antes], { token: 'mesmo' }, { token: 'mesmo' });
    expect(out[0]).toBe(antes);
  });
});

describe('applyEnvPatch > remover', () => {
  it('key que sai do mapa atual é removida', () => {
    const out = applyEnvPatch(
      [val({ key: 'token', value: 'a' }), val({ key: 'outra', value: 'b' })],
      { token: 'a' },
      {}
    );
    expect(out.map(v => v.key)).toEqual(['outra']);
  });

  it('remove só a habilitada, deixando a duplicata desabilitada', () => {
    const out = applyEnvPatch(
      [
        val({ key: 'token', value: 'guardado', enabled: false }),
        val({ key: 'token', value: 'ativo', enabled: true }),
      ],
      { token: 'ativo' },
      {}
    );
    expect(out.map(v => [v.value, v.enabled])).toEqual([['guardado', false]]);
  });

  it('previousMap vazio nunca remove nada — é o modo "só gravar"', () => {
    const out = applyEnvPatch([val({ key: 'token', value: 'a' })], {}, { outra: 'b' });
    expect(out.map(v => v.key).sort()).toEqual(['outra', 'token']);
  });
});

describe('detectEnvLosses', () => {
  it('avisa quando remove uma entrada, com o valor perdido', () => {
    expect(detectEnvLosses([val({ key: 'token', value: 'abc123' })], { token: 'abc123' }, {})).toEqual([
      { kind: 'removed', key: 'token', previous: 'abc123' },
    ])
  })

  it('avisa quando um valor que existia vira vazio', () => {
    expect(detectEnvLosses([val({ key: 'token', value: 'abc123' })], {}, { token: '   ' })).toEqual([
      { kind: 'blanked', key: 'token', previous: 'abc123' },
    ])
  })

  it('nao avisa quando o valor so muda', () => {
    expect(detectEnvLosses([val({ key: 'token', value: 'a' })], {}, { token: 'b' })).toEqual([])
  })

  it('nao avisa ao preencher uma entrada que ja estava vazia', () => {
    expect(detectEnvLosses([val({ key: 'token', value: '' })], {}, { token: '' })).toEqual([])
  })

  it('remover uma key que nao existe na lista nao avisa nada', () => {
    expect(detectEnvLosses([], { fantasma: 'x' }, {})).toEqual([])
  })

  // A entrada DESABILITADA guarda o valor do outro ambiente e nao e tocada
  // pela gravacao — anunciar perda dela seria alarme falso.
  it('ignora a duplicata desabilitada', () => {
    const vals = [val({ key: 'baseUrl', value: 'homolog', enabled: false })]
    expect(detectEnvLosses(vals, { baseUrl: 'homolog' }, {})).toEqual([])
  })

  it('nao altera a lista que recebeu', () => {
    const vals = [val({ key: 'token', value: 'abc' })]
    const copia = JSON.parse(JSON.stringify(vals))
    detectEnvLosses(vals, { token: 'abc' }, {})
    expect(vals).toEqual(copia)
  })
})
