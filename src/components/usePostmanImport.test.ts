import { describe, it, expect } from 'vitest';
import { parsePostmanImport } from './usePostmanImport';
import type { CollectionItem } from '@/app/types/CollectionItem';

// ─────────────────────────────────────────────────────────────────────────
// Este conversor é o caminho do PULL do GitHub, não só do import de arquivo
// Postman: o push grava a árvore do DevFlow e o pull a passa por aqui. Campo
// que não for copiado explicitamente some — foi o que quase aconteceu com os
// marcadores, que baixar atualizações teria apagado em silêncio.
// ─────────────────────────────────────────────────────────────────────────

const collection = (items: unknown[]) => ({
  info: {
    _postman_id: 'col-1',
    name: 'Grupos B2B',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: items,
});

const find = (nodes: CollectionItem[], name: string): CollectionItem => {
  for (const node of nodes) {
    if (node.name === name) return node;
    const hit = node.item && find(node.item, name);
    if (hit) return hit;
  }
  throw new Error(`não achei "${name}" na árvore importada`);
};

const roots = (raw: unknown): CollectionItem[] => parsePostmanImport(raw).collections ?? [];

describe('parsePostmanImport > marcadores', () => {
  it('preserva os marcadores da request', () => {
    const tree = roots(
      collection([
        { id: 'r1', name: 'Token', request: { url: 'https://x/y' }, markers: ['m1', 'm2'] },
      ])
    );
    expect(find(tree, 'Token').markers).toEqual(['m1', 'm2']);
  });

  it('preserva os marcadores da pasta', () => {
    const tree = roots(
      collection([{ id: 'f1', name: 'Fluxo', item: [], markers: ['m1'] }])
    );
    expect(find(tree, 'Fluxo').markers).toEqual(['m1']);
  });

  it('item sem marcador não ganha o campo', () => {
    const tree = roots(collection([{ id: 'r1', name: 'Token', request: { url: 'https://x' } }]));
    expect('markers' in find(tree, 'Token')).toBe(false);
  });

  it('descarta entrada que não é string — o arquivo é editável à mão no repo', () => {
    const tree = roots(
      collection([
        { id: 'r1', name: 'Token', request: { url: 'https://x' }, markers: ['m1', 42, null, ''] },
      ])
    );
    expect(find(tree, 'Token').markers).toEqual(['m1']);
  });

  it('markers que não é array é ignorado sem quebrar', () => {
    const tree = roots(
      collection([{ id: 'r1', name: 'Token', request: { url: 'https://x' }, markers: 'm1' }])
    );
    expect('markers' in find(tree, 'Token')).toBe(false);
  });
});

describe('parsePostmanImport > descrição', () => {
  it('lê a descrição da pasta, que o Postman guarda no próprio item', () => {
    const tree = roots(
      collection([{ id: 'f1', name: 'Fluxo', item: [], description: '  Precisa de reserva em Hold  ' }])
    );
    expect(find(tree, 'Fluxo').description).toBe('Precisa de reserva em Hold');
  });

  it('lê a descrição da request, que o Postman guarda dentro de request', () => {
    const tree = roots(
      collection([
        { id: 'r1', name: 'Token', request: { url: 'https://x', description: 'Gera o token' } },
      ])
    );
    expect(find(tree, 'Token').description).toBe('Gera o token');
  });

  it('a do item ganha da de dentro de request quando as duas vêm', () => {
    const tree = roots(
      collection([
        {
          id: 'r1',
          name: 'Token',
          description: 'do item',
          request: { url: 'https://x', description: 'do request' },
        },
      ])
    );
    expect(find(tree, 'Token').description).toBe('do item');
  });

  it('descrição em branco não vira campo vazio', () => {
    const tree = roots(
      collection([{ id: 'r1', name: 'Token', request: { url: 'https://x' }, description: '   ' }])
    );
    expect('description' in find(tree, 'Token')).toBe(false);
  });
});

describe('parsePostmanImport > notas por marca', () => {
  it('preserva a nota junto com a marca', () => {
    const tree = roots(
      collection([
        {
          id: 'r1',
          name: 'Token',
          request: { url: 'https://x' },
          markers: ['m1'],
          markerNotes: { m1: '  flaky desde o gateway novo  ' },
        },
      ])
    );
    expect(find(tree, 'Token').markerNotes).toEqual({ m1: 'flaky desde o gateway novo' });
  });

  it('descarta nota de marca que o item não tem', () => {
    const tree = roots(
      collection([
        {
          id: 'r1',
          name: 'Token',
          request: { url: 'https://x' },
          markers: ['m1'],
          markerNotes: { m1: 'vale', m9: 'não vale' },
        },
      ])
    );
    expect(find(tree, 'Token').markerNotes).toEqual({ m1: 'vale' });
  });

  it('descarta nota em branco e nota que não é string', () => {
    const tree = roots(
      collection([
        {
          id: 'r1',
          name: 'Token',
          request: { url: 'https://x' },
          markers: ['m1', 'm2'],
          markerNotes: { m1: '   ', m2: 42 },
        },
      ])
    );
    expect('markerNotes' in find(tree, 'Token')).toBe(false);
  });

  it('markerNotes que não é objeto não quebra', () => {
    const tree = roots(
      collection([
        { id: 'r1', name: 'Token', request: { url: 'https://x' }, markers: ['m1'], markerNotes: 'oi' },
      ])
    );
    expect('markerNotes' in find(tree, 'Token')).toBe(false);
  });
});
