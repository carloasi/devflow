import { describe, it, expect } from 'vitest';
import { diffEnvironments, applyEnvironmentChanges } from './environmentDiff';
import type { Environment, EnvironmentValue } from '@/app/types/Environment';

const v = (key: string, value: string, over: Partial<EnvironmentValue> = {}): EnvironmentValue => ({
  id: `${key}-id`,
  key,
  value,
  type: 'default',
  enabled: true,
  ...over,
});

const env = (id: string, name: string, values: EnvironmentValue[]): Environment => ({ id, name, values });

const valueOf = (envs: Environment[], key: string) =>
  envs[0].values.find(x => x.key === key && x.enabled)?.value;

describe('diffEnvironments', () => {
  it('não acusa nada quando são iguais', () => {
    const e = [env('e1', '5by5', [v('urlUser', 'http://localhost:6015')])];
    expect(diffEnvironments(e, e)).toEqual([]);
  });

  it('acusa valor diferente', () => {
    const local = [env('e1', '5by5', [v('urlUser', 'http://localhost:6015')])];
    const remote = [env('e1', '5by5', [v('urlUser', 'http://192.168.1.100')])];
    const nodes = diffEnvironments(local, remote);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].change).toBe('modified');
    expect(nodes[0].fields[0]).toMatchObject({ field: 'value', remote: 'http://192.168.1.100' });
  });

  it('separa adicionada de removida', () => {
    const local = [env('e1', '5by5', [v('a', '1'), v('soAqui', '2')])];
    const remote = [env('e1', '5by5', [v('a', '1'), v('soLa', '3')])];
    const nodes = diffEnvironments(local, remote);
    expect(nodes.find(n => n.path[1] === 'soLa')?.change).toBe('added');
    expect(nodes.find(n => n.path[1] === 'soAqui')?.change).toBe('removed');
  });

  // O pull regenera os ids dos valores; comparar por id acusaria "tudo
  // diferente" em toda sincronização.
  it('casa por key, não por id', () => {
    const local = [env('e1', '5by5', [v('token', 'x', { id: 'local-1' })])];
    const remote = [env('e1', '5by5', [v('token', 'x', { id: 'remoto-9' })])];
    expect(diffEnvironments(local, remote)).toEqual([]);
  });

  // Desabilitar é como o app arquiva um valor sem perder; ele não compete.
  it('ignora duplicata desabilitada', () => {
    const local = [env('e1', '5by5', [v('user', 'ativo'), v('user', 'arquivado', { enabled: false, id: 'x' })])];
    const remote = [env('e1', '5by5', [v('user', 'ativo')])];
    expect(diffEnvironments(local, remote)).toEqual([]);
  });

  // Listar as 155 variáveis de um environment novo afogaria o resto.
  it('environment inteiro novo entra como um nó só', () => {
    const nodes = diffEnvironments([], [env('e2', 'QA', [v('a', '1'), v('b', '2')])]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].change).toBe('added');
    expect(nodes[0].path).toEqual(['QA']);
  });

  it('casa environment por nome quando o id difere', () => {
    const local = [env('local-1', '5by5', [v('a', '1')])];
    const remote = [env('remoto-9', '5by5', [v('a', '2')])];
    expect(diffEnvironments(local, remote).map(n => n.change)).toEqual(['modified']);
  });

  it('aceita nulo dos dois lados', () => {
    expect(diffEnvironments(null, undefined)).toEqual([]);
  });
});

describe('applyEnvironmentChanges', () => {
  const local = [env('e1', '5by5', [v('urlUser', 'local'), v('token', 'meu')])];
  const remote = [env('e1', '5by5', [v('urlUser', 'remoto'), v('token', 'dele')])];
  const all = new Set(diffEnvironments(local, remote).map(n => n.id));

  it('sem seleção, nada muda', () => {
    expect(applyEnvironmentChanges(local, remote, new Set())).toEqual(local);
  });

  it('aplica só a variável escolhida', () => {
    const result = applyEnvironmentChanges(local, remote, new Set(['e1:urlUser']));
    expect(valueOf(result, 'urlUser')).toBe('remoto');
    expect(valueOf(result, 'token')).toBe('meu');
  });

  it('selecionando tudo, chega no remoto', () => {
    const result = applyEnvironmentChanges(local, remote, all);
    expect(valueOf(result, 'urlUser')).toBe('remoto');
    expect(valueOf(result, 'token')).toBe('dele');
  });

  it('traz variável que só existe no remoto', () => {
    const comNova = [env('e1', '5by5', [v('urlUser', 'local'), v('token', 'meu'), v('nova', 'n')])];
    const result = applyEnvironmentChanges(local, comNova, new Set(['e1:nova']));
    expect(valueOf(result, 'nova')).toBe('n');
  });

  it('remove a que sumiu no remoto, quando aceita', () => {
    const semToken = [env('e1', '5by5', [v('urlUser', 'local')])];
    const result = applyEnvironmentChanges(local, semToken, new Set(['e1:token']));
    expect(valueOf(result, 'token')).toBeUndefined();
  });

  it('mantém a que sumiu quando a remoção é recusada', () => {
    const semToken = [env('e1', '5by5', [v('urlUser', 'local')])];
    const result = applyEnvironmentChanges(local, semToken, new Set());
    expect(valueOf(result, 'token')).toBe('meu');
  });

  // Trocar o array inteiro pelo remoto apagaria o valor arquivado.
  it('preserva a duplicata desabilitada', () => {
    const comArquivada = [env('e1', '5by5', [v('urlUser', 'local'), v('urlUser', 'antigo', { enabled: false, id: 'arq' })])];
    const result = applyEnvironmentChanges(comArquivada, [env('e1', '5by5', [v('urlUser', 'remoto')])], new Set(['e1:urlUser']));
    expect(result[0].values.find(x => !x.enabled)?.value).toBe('antigo');
    expect(valueOf(result, 'urlUser')).toBe('remoto');
  });

  it('preserva o id local da entrada alterada', () => {
    const result = applyEnvironmentChanges(local, remote, new Set(['e1:urlUser']));
    expect(result[0].values.find(x => x.key === 'urlUser')?.id).toBe('urlUser-id');
  });

  // O caso de editar o valor final na tela: nem o local nem o remoto servem.
  it('valor editado à mão vence os dois lados', () => {
    const result = applyEnvironmentChanges(local, remote, new Set(['e1:urlUser']), {
      'e1:urlUser': { value: 'http://meu-host:6015' },
    });
    expect(valueOf(result, 'urlUser')).toBe('http://meu-host:6015');
  });

  it('não altera o recebido', () => {
    applyEnvironmentChanges(local, remote, all);
    expect(valueOf(local, 'urlUser')).toBe('local');
  });
});
