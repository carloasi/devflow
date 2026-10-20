import { describe, it, expect } from 'vitest';
import { applySelectedChanges } from './applyDiff';
import { diffTrees } from './collectionDiff';
import type { CollectionItem } from '@/app/types/CollectionItem';

const req = (id: string, name: string, body = ''): CollectionItem => ({
  id,
  name,
  type: 'request',
  method: 'GET',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body },
});

const folder = (id: string, name: string, children: CollectionItem[] = []): CollectionItem => ({
  id,
  name,
  type: 'folder',
  item: children,
});

const names = (items: CollectionItem[] | undefined) => (items ?? []).map(i => i.name);
const allIds = (local: CollectionItem[], remote: CollectionItem[]) =>
  new Set(diffTrees(local, remote).map(n => n.id));

describe('applySelectedChanges', () => {
  it('sem seleção, nada muda', () => {
    const local = [folder('c', 'P', [req('r1', 'Token')])];
    const remote = [folder('c', 'P', [req('r1', 'Token', 'novo')])];
    expect(applySelectedChanges(local, remote, new Set())).toEqual(local);
  });

  it('selecionando tudo, chega no remoto', () => {
    const local = [folder('c', 'P', [req('r1', 'Token')])];
    const remote = [folder('c', 'P', [req('r1', 'Token', 'novo')])];
    const merged = applySelectedChanges(local, remote, allIds(local, remote));
    expect(merged[0].item![0].request!.body).toBe('novo');
  });

  describe('alteração', () => {
    it('aceita só a request escolhida', () => {
      const local = [folder('c', 'P', [req('r1', 'A'), req('r2', 'B')])];
      const remote = [folder('c', 'P', [req('r1', 'A', 'novo-a'), req('r2', 'B', 'novo-b')])];
      const merged = applySelectedChanges(local, remote, new Set(['r1']));
      expect(merged[0].item![0].request!.body).toBe('novo-a');
      expect(merged[0].item![1].request!.body).toBe('');
    });

    // Sem separar campos próprios de filhos, recusar a pasta descartaria
    // junto o que foi aceito dentro dela.
    it('recusar a pasta não descarta a request aceita dentro', () => {
      const local = [folder('c', 'Antigo', [req('r1', 'A')])];
      const remote = [folder('c', 'Novo', [req('r1', 'A', 'novo')])];
      const merged = applySelectedChanges(local, remote, new Set(['r1']));
      expect(merged[0].name).toBe('Antigo');
      expect(merged[0].item![0].request!.body).toBe('novo');
    });
  });

  describe('adição', () => {
    it('traz a request nova quando aceita', () => {
      const local = [folder('c', 'P', [req('r1', 'A')])];
      const remote = [folder('c', 'P', [req('r1', 'A'), req('r2', 'B')])];
      const merged = applySelectedChanges(local, remote, new Set(['r2']));
      expect(names(merged[0].item)).toEqual(['A', 'B']);
    });

    it('não traz quando recusada', () => {
      const local = [folder('c', 'P', [req('r1', 'A')])];
      const remote = [folder('c', 'P', [req('r1', 'A'), req('r2', 'B')])];
      expect(names(applySelectedChanges(local, remote, new Set())[0].item)).toEqual(['A']);
    });

    // Ordem é execução neste app: um passo novo no meio do fluxo tem que
    // cair no meio, não no fim.
    it('entra na posição que ocupa no remoto', () => {
      const local = [folder('c', 'P', [req('r1', 'A'), req('r3', 'C')])];
      const remote = [folder('c', 'P', [req('r1', 'A'), req('r2', 'B'), req('r3', 'C')])];
      const merged = applySelectedChanges(local, remote, new Set(['r2']));
      expect(names(merged[0].item)).toEqual(['A', 'B', 'C']);
    });

    it('traz a collection inteira nova', () => {
      const remote = [folder('c2', 'Nova', [req('r', 'X')])];
      const merged = applySelectedChanges([], remote, new Set(['c2']));
      expect(names(merged)).toEqual(['Nova']);
    });
  });

  describe('remoção', () => {
    it('apaga quando aceita', () => {
      const local = [folder('c', 'P', [req('r1', 'A'), req('r2', 'B')])];
      const remote = [folder('c', 'P', [req('r1', 'A')])];
      expect(names(applySelectedChanges(local, remote, new Set(['r2']))[0].item)).toEqual(['A']);
    });

    // Recusar a remoção mantém o item — e ele volta a subir no próximo push.
    it('mantém quando recusada', () => {
      const local = [folder('c', 'P', [req('r1', 'A'), req('r2', 'B')])];
      const remote = [folder('c', 'P', [req('r1', 'A')])];
      expect(names(applySelectedChanges(local, remote, new Set())[0].item)).toEqual(['A', 'B']);
    });
  });

  describe('ordem', () => {
    it('aceitar a pasta reordenada aplica a sequência do remoto', () => {
      const local = [folder('c', 'P', [req('r1', 'A'), req('r2', 'B')])];
      const remote = [folder('c', 'P', [req('r2', 'B'), req('r1', 'A')])];
      const merged = applySelectedChanges(local, remote, new Set(['c']));
      expect(names(merged[0].item)).toEqual(['B', 'A']);
    });

    it('recusar mantém a sequência daqui', () => {
      const local = [folder('c', 'P', [req('r1', 'A'), req('r2', 'B')])];
      const remote = [folder('c', 'P', [req('r2', 'B'), req('r1', 'A')])];
      expect(names(applySelectedChanges(local, remote, new Set())[0].item)).toEqual(['A', 'B']);
    });

    it('item recusado não some ao reordenar', () => {
      const local = [folder('c', 'P', [req('r1', 'A'), req('r2', 'B'), req('rx', 'SóAqui')])];
      const remote = [folder('c', 'P', [req('r2', 'B'), req('r1', 'A')])];
      const merged = applySelectedChanges(local, remote, new Set(['c']));
      expect(names(merged[0].item)).toContain('SóAqui');
      expect(merged[0].item).toHaveLength(3);
    });
  });

  describe('identidade e marcas locais', () => {
    // Abas abertas e favoritos apontam pro id local; trocá-lo pelo remoto
    // faria a aba aberta referenciar um nó que não existe mais.
    it('preserva o id local ao aceitar o remoto', () => {
      const local = [folder('c', 'P', [{ ...req('local-1', 'Token') }])];
      const remote = [folder('c', 'P', [req('remoto-9', 'Token', 'novo')])];
      const merged = applySelectedChanges(local, remote, allIds(local, remote));
      expect(merged[0].item![0].id).toBe('local-1');
      expect(merged[0].item![0].request!.body).toBe('novo');
    });

    // Favorito nunca está no arquivo remoto: sem reaplicar, aceitar uma
    // alteração apagaria a estrela.
    it('preserva o favorito ao aceitar o remoto', () => {
      const local = [folder('c', 'P', [{ ...req('r1', 'Token'), starred: true }])];
      const remote = [folder('c', 'P', [req('r1', 'Token', 'novo')])];
      const merged = applySelectedChanges(local, remote, allIds(local, remote));
      expect(merged[0].item![0].starred).toBe(true);
      expect(merged[0].item![0].request!.body).toBe('novo');
    });
  });

  describe('aninhamento', () => {
    it('aceita em profundidade sem tocar nos irmãos', () => {
      const tree = (body: string, other: string) => [
        folder('c', 'P', [
          folder('f1', 'A', [req('r1', 'X', body)]),
          folder('f2', 'B', [req('r2', 'Y', other)]),
        ]),
      ];
      const local = tree('', '');
      const remote = tree('novo', 'tambem-novo');
      const merged = applySelectedChanges(local, remote, new Set(['r1']));
      expect(merged[0].item![0].item![0].request!.body).toBe('novo');
      expect(merged[0].item![1].item![0].request!.body).toBe('');
    });
  });

  it('não altera as árvores recebidas', () => {
    const local = [folder('c', 'P', [req('r1', 'A')])];
    const remote = [folder('c', 'P', [req('r1', 'A', 'novo'), req('r2', 'B')])];
    applySelectedChanges(local, remote, allIds(local, remote));
    expect(local[0].item).toHaveLength(1);
    expect(local[0].item![0].request!.body).toBe('');
  });

  it('aceita nulo dos dois lados', () => {
    expect(applySelectedChanges(null, undefined, new Set())).toEqual([]);
  });

  // O caso que motiva editar na tela: nem o local nem o remoto estão certos
  // sozinhos — o colega mudou o corpo e você mudou outra parte dele.
  describe('valores editados à mão', () => {
    const local = [folder('c', 'P', [req('r1', 'Token', 'meu')])];
    const remote = [folder('c', 'P', [req('r1', 'Token', 'dele')])];

    it('vencem sobre os dois lados', () => {
      const merged = applySelectedChanges(local, remote, new Set(['r1']), {
        r1: { body: 'resolvido à mão' },
      });
      expect(merged[0].item![0].request!.body).toBe('resolvido à mão');
    });

    it('não vazam pros irmãos', () => {
      const dois = [folder('c', 'P', [req('r1', 'A', 'a'), req('r2', 'B', 'b')])];
      const doisRemoto = [folder('c', 'P', [req('r1', 'A', 'a2'), req('r2', 'B', 'b2')])];
      const merged = applySelectedChanges(dois, doisRemoto, new Set(['r1', 'r2']), {
        r1: { body: 'editado' },
      });
      expect(merged[0].item![0].request!.body).toBe('editado');
      expect(merged[0].item![1].request!.body).toBe('b2');
    });

    // A tela marca o nó ao editar, então este caso não deveria acontecer —
    // mas se acontecer, "muda o que está marcado" tem que continuar valendo.
    it('não se aplicam a nó recusado', () => {
      const merged = applySelectedChanges(local, remote, new Set(), { r1: { body: 'editado' } });
      expect(merged[0].item![0].request!.body).toBe('meu');
    });

    it('valem também num nó novo aceito', () => {
      const vazio: CollectionItem[] = [folder('c', 'P', [])];
      const comNovo = [folder('c', 'P', [req('r9', 'Novo', 'do-remoto')])];
      const merged = applySelectedChanges(vazio, comNovo, new Set(['r9']), {
        r9: { body: 'editado antes de entrar' },
      });
      expect(merged[0].item![0].request!.body).toBe('editado antes de entrar');
    });
  });
});
