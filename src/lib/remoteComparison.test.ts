import { describe, it, expect } from 'vitest';
import { compareWorkspaces, hasDifferences, describeComparison } from './remoteComparison';
import type { CollectionItem } from '@/app/types/CollectionItem';

const col = (id: string, name: string, children: CollectionItem[] = []): CollectionItem => ({
  id,
  name,
  type: 'folder',
  item: children,
});

const req = (id: string, name = id): CollectionItem => ({ id, name, type: 'request', method: 'GET' });

describe('compareWorkspaces', () => {
  it('reconhece workspaces idênticos', () => {
    const tree = [col('a', 'Pagamentos', [req('r1')])];
    const c = compareWorkspaces(tree, tree);
    expect(hasDifferences(c)).toBe(false);
    expect(c.identical).toBe(1);
  });

  it('separa modificada de só-remota', () => {
    const local = [col('a', 'Pagamentos', [req('r1')])];
    const remote = [col('a', 'Pagamentos', [req('r1'), req('r2')]), col('b', 'Reservas')];
    const c = compareWorkspaces(local, remote);
    expect(c.modified).toEqual(['a']);
    expect(c.onlyRemote).toEqual(['b']);
  });

  it('reconhece collection que só existe aqui', () => {
    const c = compareWorkspaces([col('a', 'A'), col('b', 'B')], [col('a', 'A')]);
    expect(c.onlyLocal).toEqual(['b']);
    expect(c.modified).toEqual([]);
  });

  it('conta as iguais sem contar as diferentes', () => {
    const local = [col('a', 'A'), col('b', 'B', [req('r1')])];
    const remote = [col('a', 'A'), col('b', 'B', [req('r2')])];
    const c = compareWorkspaces(local, remote);
    expect(c.identical).toBe(1);
    expect(c.modified).toEqual(['b']);
  });

  // Mesma regra do push: favorito é marca local e não sobe. Acusar diferença
  // por causa dele faria a comparação mentir já no primeiro uso.
  it('favorito não conta como diferença', () => {
    const local = [col('a', 'A', [{ ...req('r1'), starred: true }])];
    const remote = [col('a', 'A', [req('r1')])];
    expect(hasDifferences(compareWorkspaces(local, remote))).toBe(false);
  });

  it('remoto vazio deixa tudo como só-local', () => {
    const c = compareWorkspaces([col('a', 'A')], []);
    expect(c.onlyLocal).toEqual(['a']);
    expect(c.onlyRemote).toEqual([]);
  });

  it('local vazio deixa tudo como só-remoto', () => {
    const c = compareWorkspaces([], [col('a', 'A')]);
    expect(c.onlyRemote).toEqual(['a']);
    expect(c.onlyLocal).toEqual([]);
  });

  it('aceita nulo dos dois lados', () => {
    expect(hasDifferences(compareWorkspaces(null, undefined))).toBe(false);
  });
});

describe('describeComparison', () => {
  const names: Record<string, string> = { a: 'Pagamentos', b: 'Reservas', c: 'Bilhetes', d: 'Cotação' };
  const nameOf = (id: string) => names[id];

  it('diz que está em dia', () => {
    const c = compareWorkspaces([col('a', 'Pagamentos')], [col('a', 'Pagamentos')]);
    expect(describeComparison(c, nameOf)).toContain('Up to date');
  });

  it('avisa quando não há nada a comparar', () => {
    expect(describeComparison(compareWorkspaces([], []), nameOf)).toBe('Nothing to compare yet.');
  });

  // "2 collections differ" obrigaria a dar o pull justamente pra descobrir
  // quais — que é o que esta tela existe pra evitar.
  it('nomeia as collections quando são poucas', () => {
    const c = compareWorkspaces([col('a', 'Pagamentos')], [col('a', 'Pagamentos', [req('r1')])]);
    expect(describeComparison(c, nameOf)).toBe('"Pagamentos" changed on GitHub');
  });

  it('resume quando são muitas', () => {
    const local = ['a', 'b', 'c', 'd'].map(id => col(id, names[id]));
    const remote = ['a', 'b', 'c', 'd'].map(id => col(id, names[id], [req('r1')]));
    expect(describeComparison(compareWorkspaces(local, remote), nameOf)).toBe('4 collections changed on GitHub');
  });

  it('junta os três tipos de diferença', () => {
    const local = [col('a', 'Pagamentos'), col('d', 'Cotação')];
    const remote = [col('a', 'Pagamentos', [req('r1')]), col('b', 'Reservas')];
    const text = describeComparison(compareWorkspaces(local, remote), nameOf);
    expect(text).toContain('"Pagamentos" changed on GitHub');
    expect(text).toContain('"Reservas" only on GitHub');
    expect(text).toContain('"Cotação" only here');
  });

  it('cai no id quando o nome não é conhecido', () => {
    const c = compareWorkspaces([], [col('zzz', 'X')]);
    expect(describeComparison(c, () => undefined)).toContain('"zzz"');
  });
});
