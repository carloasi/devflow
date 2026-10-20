import { describe, it, expect } from 'vitest';
import { nodeHashes, changedSinceBase } from './syncBase';
import type { CollectionItem } from '@/app/types/CollectionItem';

const req = (id: string, body = ''): CollectionItem => ({
  id,
  name: `Request ${id}`,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});

const folder = (id: string, children: CollectionItem[] = []): CollectionItem =>
  ({ id, name: `Folder ${id}`, type: 'folder', item: children }) as CollectionItem;

describe('nodeHashes', () => {
  it('cobre pastas e requests em profundidade', () => {
    const tree = [folder('c', [folder('f', [req('r')])])];
    expect(Object.keys(nodeHashes(tree)).sort()).toEqual(['c', 'f', 'r']);
  });

  // A pergunta é "este nó mudou", e o conteúdo nunca sai daqui.
  it('o hash muda com o conteúdo', () => {
    expect(nodeHashes([req('r', 'a')]).r).not.toBe(nodeHashes([req('r', 'b')]).r);
  });

  it('mesmo conteúdo, mesmo hash', () => {
    expect(nodeHashes([req('r', 'a')]).r).toBe(nodeHashes([req('r', 'a')]).r);
  });

  // Incluir os filhos faria toda pasta de um fluxo "mudar" quando uma request
  // lá dentro mudasse, e ela apareceria como conflito sem ninguém tocá-la.
  it('a pasta não muda quando um filho muda', () => {
    const antes = nodeHashes([folder('f', [req('r', 'a')])]);
    const depois = nodeHashes([folder('f', [req('r', 'b')])]);
    expect(depois.f).toBe(antes.f);
    expect(depois.r).not.toBe(antes.r);
  });

  // Mesma regra do diff: ordem de chave e id gerado não são conteúdo.
  it('ignora o que a normalização ignora', () => {
    const a = { ...req('r'), request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [{ id: 'local', key: 'a', value: '1', enabled: true }], body: '' } } as unknown as CollectionItem;
    const b = { ...req('r'), request: { urlexport: { raw: '/x', host: [], path: [] }, url: '/x', body: '', headers: [{ enabled: true, value: '1', key: 'a', id: 'remoto' }] } } as unknown as CollectionItem;
    expect(nodeHashes([a]).r).toBe(nodeHashes([b]).r);
  });

  it('favorito não conta', () => {
    const comEstrela = { ...req('r'), starred: true } as CollectionItem;
    expect(nodeHashes([comEstrela]).r).toBe(nodeHashes([req('r')]).r);
  });

  it('aceita nulo', () => {
    expect(nodeHashes(null)).toEqual({});
  });
});

describe('changedSinceBase', () => {
  const base = nodeHashes([req('r', 'original')]);

  it('intocado desde a base', () => {
    expect(changedSinceBase(base, 'r', req('r', 'original'))).toBe(false);
  });

  it('alterado desde a base', () => {
    expect(changedSinceBase(base, 'r', req('r', 'editado'))).toBe(true);
  });

  // Nó que a base não conhece foi criado depois dela — é trabalho local.
  it('nó novo conta como alterado', () => {
    expect(changedSinceBase(base, 'novo', req('novo'))).toBe(true);
  });

  // Sem base não há como saber quem mexeu: quem chama decide o que fazer.
  it('sem base devolve null em vez de chutar', () => {
    expect(changedSinceBase(null, 'r', req('r'))).toBeNull();
  });
});
