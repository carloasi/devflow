import { describe, it, expect } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import type { DiffNode } from './collectionDiff';
import { classifyNode, countByOrigin } from './diffOrigin';
import { conflictingIds } from './diffSelection';
import { nodeHashes } from './syncBase';

const req = (id: string, body: string): CollectionItem => ({
  id,
  name: `Request ${id}`,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});

const node = (
  id: string,
  change: DiffNode['change'],
  local?: CollectionItem,
  remote?: CollectionItem
): DiffNode => ({
  id,
  path: ['C', id],
  rootId: 'c1',
  ancestorIds: ['c1'],
  kind: 'request',
  change,
  local,
  remote,
  fields: [],
});

// Estado da última sincronização: `a` e `b` com corpo "base".
const base = nodeHashes([req('a', 'base'), req('b', 'base')]);

describe('classifyNode', () => {
  describe('modified', () => {
    it('só mudou no GitHub', () => {
      expect(classifyNode(node('a', 'modified', req('a', 'base'), req('a', 'lá')), base).origin).toBe('github');
    });

    it('só mudou aqui — aceitar desfaria a sua edição', () => {
      const s = classifyNode(node('a', 'modified', req('a', 'aqui'), req('a', 'base')), base);
      expect(s.origin).toBe('here');
      expect(s.label).toBe('Changed here');
    });

    it('mudou dos dois lados', () => {
      expect(classifyNode(node('a', 'modified', req('a', 'aqui'), req('a', 'lá')), base).origin).toBe('both');
    });

    it('item que a base não conhece cai nos rótulos de duas vias', () => {
      expect(classifyNode(node('x', 'modified', req('x', '1'), req('x', '2')), base).origin).toBe('unknown');
    });
  });

  describe('added (existe só no GitHub)', () => {
    it('a base não conhece: é novo lá', () => {
      const s = classifyNode(node('novo', 'added', undefined, req('novo', 'x')), base);
      expect(s.origin).toBe('github');
      expect(s.label).toBe('New on GitHub');
    });

    it('a base conhece e lá não mudou: você apagou aqui', () => {
      const s = classifyNode(node('a', 'added', undefined, req('a', 'base')), base);
      expect(s.origin).toBe('here');
      expect(s.label).toBe('Deleted here');
    });

    it('a base conhece e lá mudou: apagado aqui, alterado lá', () => {
      expect(classifyNode(node('a', 'added', undefined, req('a', 'lá')), base).origin).toBe('both');
    });
  });

  describe('removed (existe só aqui)', () => {
    it('a base não conhece: é novo aqui, nunca enviado', () => {
      const s = classifyNode(node('novo', 'removed', req('novo', 'x')), base);
      expect(s.origin).toBe('here');
      expect(s.label).toBe('New here');
    });

    it('a base conhece e aqui não mudou: apagaram no GitHub', () => {
      const s = classifyNode(node('a', 'removed', req('a', 'base')), base);
      expect(s.origin).toBe('github');
      expect(s.label).toBe('Deleted on GitHub');
    });

    it('a base conhece e aqui mudou: alterado aqui, apagado lá', () => {
      expect(classifyNode(node('a', 'removed', req('a', 'aqui')), base).origin).toBe('both');
    });
  });

  it('sem base, tudo é de duas vias', () => {
    expect(classifyNode(node('a', 'added', undefined, req('a', 'x')), null).label).toBe('Only on GitHub');
    expect(classifyNode(node('a', 'removed', req('a', 'x')), null).label).toBe('Only here');
    expect(classifyNode(node('a', 'modified', req('a', 'x'), req('a', 'y')), null).label).toBe('Changed');
  });

  it('variável de environment nunca usa a base', () => {
    const v = { ...node('a', 'modified', req('a', 'aqui'), req('a', 'base')), kind: 'variable' as const };
    expect(classifyNode(v, base).origin).toBe('unknown');
  });
});

describe('countByOrigin', () => {
  it('separa seguro, seu e o que pede decisão', () => {
    const base3 = nodeHashes([req('a', 'base'), req('b', 'base'), req('c', 'base')]);
    const nodes = [
      node('a', 'modified', req('a', 'base'), req('a', 'lá')), // só lá
      node('b', 'modified', req('b', 'aqui'), req('b', 'base')), // só aqui
      node('novo', 'removed', req('novo', 'x')), // novo aqui
      node('c', 'modified', req('c', 'aqui'), req('c', 'lá')), // dos dois lados
    ];
    const statuses = new Map(nodes.map(n => [n.id, classifyNode(n, base3)]));
    const conflicts = conflictingIds(nodes, new Set(), base3);

    expect(countByOrigin(nodes, statuses, conflicts)).toEqual({ github: 1, here: 2, decide: 1 });
  });
});
