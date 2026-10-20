import { describe, it, expect } from 'vitest';
import {
  addPending,
  removePending,
  isPendingEmpty,
  parseStored,
  EMPTY_PENDING,
  type PendingPush,
} from './pendingPushStore';

const pending = (over: Partial<PendingPush> = {}): PendingPush => ({
  collections: [],
  environments: [],
  requiresFullPush: false,
  ...over,
});

describe('addPending', () => {
  it('acrescenta id', () => {
    expect(addPending(EMPTY_PENDING, 'collections', ['c1']).collections).toEqual(['c1']);
  });

  // O efeito que detecta mudança dispara a cada edição; sem isto a lista
  // cresceria sem limite com o mesmo id.
  it('não duplica', () => {
    const once = addPending(EMPTY_PENDING, 'collections', ['c1']);
    expect(addPending(once, 'collections', ['c1', 'c2']).collections).toEqual(['c1', 'c2']);
  });

  it('não mistura collections com environments', () => {
    const p = addPending(addPending(EMPTY_PENDING, 'collections', ['c1']), 'environments', ['e1']);
    expect(p.collections).toEqual(['c1']);
    expect(p.environments).toEqual(['e1']);
  });

  it('ignora id vazio', () => {
    expect(addPending(EMPTY_PENDING, 'collections', ['']).collections).toEqual([]);
  });

  it('preserva requiresFullPush', () => {
    const p = addPending(pending({ requiresFullPush: true }), 'collections', ['c1']);
    expect(p.requiresFullPush).toBe(true);
  });

  it('não altera o objeto recebido', () => {
    const original = pending();
    addPending(original, 'collections', ['c1']);
    expect(original.collections).toEqual([]);
  });
});

describe('removePending', () => {
  it('tira o id enviado', () => {
    const p = pending({ collections: ['c1', 'c2'] });
    expect(removePending(p, 'collections', ['c1']).collections).toEqual(['c2']);
  });

  // Push seletivo de uma collection não pode apagar o aviso de que ainda há
  // uma collection apagada esperando push completo.
  it('não limpa requiresFullPush', () => {
    const p = pending({ collections: ['c1'], requiresFullPush: true });
    expect(removePending(p, 'collections', ['c1']).requiresFullPush).toBe(true);
  });
});

describe('isPendingEmpty', () => {
  it('vazio é vazio', () => {
    expect(isPendingEmpty(EMPTY_PENDING)).toBe(true);
    expect(isPendingEmpty(undefined)).toBe(true);
  });

  it('requiresFullPush sozinho já é pendência', () => {
    expect(isPendingEmpty(pending({ requiresFullPush: true }))).toBe(false);
  });

  it('um environment sozinho já é pendência', () => {
    expect(isPendingEmpty(pending({ environments: ['e1'] }))).toBe(false);
  });
});

describe('parseStored', () => {
  it('lê o formato novo', () => {
    const raw = JSON.stringify({ ws: { collections: ['c1'], environments: [], requiresFullPush: false } });
    expect(parseStored(raw, null).ws.collections).toEqual(['c1']);
  });

  // O formato antigo dizia "este workspace tem coisa pendente" sem dizer o
  // quê. Ler como "nada pendente" apagaria o aviso que já existia — que é
  // exatamente o que ele existe pra evitar.
  describe('migração do formato antigo', () => {
    it('converte a lista de workspaces', () => {
      const map = parseStored(null, JSON.stringify(['ws1', 'ws2']));
      expect(Object.keys(map)).toEqual(['ws1', 'ws2']);
    });

    it('marca requiresFullPush, já que não se sabe o que mudou', () => {
      const map = parseStored(null, JSON.stringify(['ws1']));
      expect(map.ws1.requiresFullPush).toBe(true);
      expect(isPendingEmpty(map.ws1)).toBe(false);
    });

    it('o formato novo tem precedência sobre o antigo', () => {
      const novo = JSON.stringify({ ws1: { collections: ['c1'], environments: [], requiresFullPush: false } });
      const map = parseStored(novo, JSON.stringify(['ws1', 'ws2']));
      expect(map.ws1.requiresFullPush).toBe(false);
      expect(map.ws2).toBeUndefined();
    });

    it('ignora entrada que não é string', () => {
      expect(parseStored(null, JSON.stringify(['ws1', 42, null]))).toEqual({
        ws1: { collections: [], environments: [], requiresFullPush: true },
      });
    });
  });

  describe('conteúdo corrompido', () => {
    it('JSON inválido vira mapa vazio', () => {
      expect(parseStored('{nao e json', null)).toEqual({});
    });

    it('cai no antigo quando o novo está corrompido', () => {
      expect(parseStored('{{{', JSON.stringify(['ws1']))).toEqual({
        ws1: { collections: [], environments: [], requiresFullPush: true },
      });
    });

    it('campo com tipo errado vira lista vazia, não quebra', () => {
      const raw = JSON.stringify({ ws: { collections: 'c1', environments: null, requiresFullPush: 'sim' } });
      expect(parseStored(raw, null).ws).toEqual({
        collections: [],
        environments: [],
        requiresFullPush: false,
      });
    });

    it('nada gravado vira mapa vazio', () => {
      expect(parseStored(null, null)).toEqual({});
    });
  });
});
