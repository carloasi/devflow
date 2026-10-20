import { describe, it, expect } from 'vitest';
import {
  assignToGroup,
  buildSegments,
  defaultGroupName,
  nextColor,
  pruneEmptyGroups,
  regroupAfterReorder,
  removeFromGroup,
  ungroup,
  visibleTabs,
  type TabGroup,
} from './tabGroups';
import type { Tab } from '@/app/types/Tab';

const tab = (id: string, groupId?: string): Tab =>
  ({ id, name: id, groupId } as Tab);

const group = (id: string, over: Partial<TabGroup> = {}): TabGroup => ({
  id,
  name: id,
  color: 0,
  ...over,
});

const ids = (tabs: Tab[]) => tabs.map(t => t.id);
const groupOf = (tabs: Tab[], id: string) => tabs.find(t => t.id === id)?.groupId;

describe('buildSegments', () => {
  it('abas soltas viram segmentos próprios', () => {
    const segments = buildSegments([tab('a'), tab('b')], []);
    expect(segments.map(s => s.kind)).toEqual(['tab', 'tab']);
  });

  it('abas vizinhas do mesmo grupo viram um segmento só', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1'), tab('d')];
    const segments = buildSegments(tabs, [group('g1')]);
    expect(segments.map(s => s.kind)).toEqual(['tab', 'group', 'tab']);
    expect(segments[1].kind === 'group' && ids(segments[1].tabs)).toEqual(['b', 'c']);
  });

  it('aba com grupo inexistente é tratada como solta', () => {
    expect(buildSegments([tab('a', 'sumiu')], []).map(s => s.kind)).toEqual(['tab']);
  });

  // Barra estranha é melhor que barra vazia: se a contiguidade quebrar por
  // dado antigo, cada trecho vira um segmento em vez de o render explodir.
  it('grupo partido vira dois segmentos em vez de quebrar', () => {
    const tabs = [tab('a', 'g1'), tab('b'), tab('c', 'g1')];
    expect(buildSegments(tabs, [group('g1')]).map(s => s.kind)).toEqual(['group', 'tab', 'group']);
  });
});

describe('visibleTabs', () => {
  it('esconde as abas de grupo recolhido', () => {
    const tabs = [tab('a'), tab('b', 'g1'), tab('c', 'g1')];
    expect(ids(visibleTabs(tabs, [group('g1', { collapsed: true })]))).toEqual(['a']);
  });

  it('grupo aberto não esconde nada', () => {
    const tabs = [tab('a'), tab('b', 'g1')];
    expect(visibleTabs(tabs, [group('g1')])).toHaveLength(2);
  });
});

// A regra que amarra tudo: sem contiguidade a pílula não teria onde começar
// e terminar.
describe('assignToGroup', () => {
  it('marca as abas escolhidas', () => {
    const result = assignToGroup([tab('a'), tab('b')], ['a'], 'g1');
    expect(groupOf(result, 'a')).toBe('g1');
    expect(groupOf(result, 'b')).toBeUndefined();
  });

  it('junta abas distantes sem engolir o que está no meio', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    const result = assignToGroup(tabs, ['a', 'c'], 'g1');
    expect(ids(result)).toEqual(['a', 'c', 'b']);
    expect(groupOf(result, 'b')).toBeUndefined();
  });

  it('aba nova vai para junto das que já estão no grupo', () => {
    const tabs = [tab('a', 'g1'), tab('b'), tab('c')];
    const result = assignToGroup(tabs, ['c'], 'g1');
    expect(ids(result)).toEqual(['a', 'c', 'b']);
  });

  it('o grupo começa na posição da primeira aba escolhida', () => {
    const tabs = [tab('a'), tab('b'), tab('c'), tab('d')];
    expect(ids(assignToGroup(tabs, ['b', 'd'], 'g1'))).toEqual(['a', 'b', 'd', 'c']);
  });

  it('lista vazia não mexe em nada', () => {
    const tabs = [tab('a')];
    expect(assignToGroup(tabs, [], 'g1')).toBe(tabs);
  });
});

describe('removeFromGroup e ungroup', () => {
  it('tirar uma aba mantém as outras no grupo', () => {
    const tabs = [tab('a', 'g1'), tab('b', 'g1')];
    const result = removeFromGroup(tabs, 'a');
    expect(groupOf(result, 'a')).toBeUndefined();
    expect(groupOf(result, 'b')).toBe('g1');
  });

  it('desfazer o grupo mantém as abas abertas e na ordem', () => {
    const tabs = [tab('a', 'g1'), tab('b', 'g1'), tab('c')];
    const result = ungroup(tabs, 'g1');
    expect(ids(result)).toEqual(['a', 'b', 'c']);
    expect(result.every(t => t.groupId === undefined)).toBe(true);
  });
});

// Grupo vazio no disco reaparece quando um id é reaproveitado.
describe('pruneEmptyGroups', () => {
  it('descarta grupo que ficou sem aba', () => {
    const groups = pruneEmptyGroups([tab('a')], [group('g1'), group('g2')]);
    expect(groups).toEqual([]);
  });

  it('mantém o que ainda tem aba', () => {
    const groups = pruneEmptyGroups([tab('a', 'g1')], [group('g1'), group('g2')]);
    expect(groups.map(g => g.id)).toEqual(['g1']);
  });
});

describe('regroupAfterReorder', () => {
  // Como o Chrome: soltar entre duas abas do grupo põe dentro dele.
  it('aba solta no meio do grupo entra nele', () => {
    const tabs = [tab('a', 'g1'), tab('x'), tab('b', 'g1')];
    expect(groupOf(regroupAfterReorder(tabs, 'x'), 'x')).toBe('g1');
  });

  // Na borda há ambiguidade, e assumir o grupo seria a leitura destrutiva.
  it('aba na borda do grupo fica de fora', () => {
    const tabs = [tab('a', 'g1'), tab('b', 'g1'), tab('x')];
    expect(groupOf(regroupAfterReorder(tabs, 'x'), 'x')).toBeUndefined();
  });

  it('aba arrastada para fora perde o grupo', () => {
    const tabs = [tab('x', 'g1'), tab('a'), tab('b')];
    expect(groupOf(regroupAfterReorder(tabs, 'x'), 'x')).toBeUndefined();
  });

  it('não confunde grupos diferentes como vizinhos', () => {
    const tabs = [tab('a', 'g1'), tab('x'), tab('b', 'g2')];
    expect(groupOf(regroupAfterReorder(tabs, 'x'), 'x')).toBeUndefined();
  });

  it('id inexistente não altera nada', () => {
    const tabs = [tab('a')];
    expect(regroupAfterReorder(tabs, 'zzz')).toBe(tabs);
  });
});

describe('nomes e cores', () => {
  it('numera o grupo novo', () => {
    expect(defaultGroupName([])).toBe('Group 1');
    expect(defaultGroupName([group('x', { name: 'Group 1' })])).toBe('Group 2');
  });

  it('pula o número já usado', () => {
    const existing = [group('a', { name: 'Group 1' }), group('b', { name: 'Group 3' })];
    expect(defaultGroupName(existing)).toBe('Group 2');
  });

  it('escolhe uma cor ainda livre', () => {
    expect(nextColor([group('a', { color: 0 })])).toBe(1);
  });

  it('com todas usadas, volta a repetir sem travar', () => {
    const all = Array.from({ length: 8 }, (_, i) => group(String(i), { color: i }));
    expect(nextColor(all)).toBeGreaterThanOrEqual(0);
  });
});
