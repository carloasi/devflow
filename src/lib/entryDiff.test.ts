import { describe, it, expect } from 'vitest';
import {
  applyChoice,
  countChangedEntries,
  diffEntries,
  entriesFromText,
  isKeyedList,
  sameEntry,
  sideOf,
  type EntryRow,
  type KeyedEntry,
} from './entryDiff';

const h = (key: string, value: string, enabled?: boolean): KeyedEntry =>
  enabled === undefined ? { key, value } : { key, value, enabled };

const rowFor = (rows: EntryRow[], key: string, occurrence = 0) =>
  rows.find(r => r.key === key && r.occurrence === occurrence)!;

describe('isKeyedList', () => {
  it('aceita lista de chave/valor', () => {
    expect(isKeyedList([h('Accept', 'application/json')])).toBe(true);
  });

  it('lista vazia é lista', () => {
    expect(isKeyedList([])).toBe(true);
  });

  it('recusa o que não tem chave de texto', () => {
    expect(isKeyedList([{ value: 'x' }])).toBe(false);
    expect(isKeyedList([{ key: 1, value: 'x' }])).toBe(false);
    expect(isKeyedList(['Accept'])).toBe(false);
    expect(isKeyedList([null])).toBe(false);
    expect(isKeyedList({ key: 'a', value: 'b' })).toBe(false);
  });
});

describe('sameEntry', () => {
  it('valor igual', () => {
    expect(sameEntry(h('A', '1'), h('A', '1'))).toBe(true);
  });

  // Desligar um header muda o que a request manda: é conteúdo, não enfeite.
  it('ligado e desligado são diferentes', () => {
    expect(sameEntry(h('A', '1', true), h('A', '1', false))).toBe(false);
  });

  it('enabled ausente vale como ligado', () => {
    expect(sameEntry(h('A', '1'), h('A', '1', true))).toBe(true);
    expect(sameEntry(h('A', '1'), h('A', '1', false))).toBe(false);
  });
});

describe('diffEntries', () => {
  it('marca a entrada alterada e deixa o resto quieto', () => {
    const rows = diffEntries(
      [h('Accept', 'application/json'), h('X-Tenant', 'homolog')],
      [h('Accept', 'application/json'), h('X-Tenant', 'prod')]
    )!;
    expect(rows.map(r => r.change)).toEqual(['same', 'changed']);
    expect(countChangedEntries(rows)).toBe(1);
  });

  it('entrada só daqui é removida, só de lá é adicionada', () => {
    const rows = diffEntries([h('A', '1')], [h('B', '2')])!;
    expect(rows.map(r => [r.key, r.change])).toEqual([
      ['A', 'removed'],
      ['B', 'added'],
    ]);
  });

  // Reordenar headers não muda o que a request faz. Casar por posição faria
  // uma inserção no topo deslocar tudo e esconder a mudança de verdade.
  it('casa por chave, não por posição', () => {
    const rows = diffEntries(
      [h('A', '1'), h('B', '2')],
      [h('B', '2'), h('A', '1')]
    )!;
    expect(rows.every(r => r.change === 'same')).toBe(true);
  });

  // Dado real: um environment aqui tem `username` duas vezes, uma ligada e
  // outra não. Casar as duas na mesma entrada perderia uma das diferenças.
  it('chave repetida casa ocorrência com ocorrência', () => {
    const rows = diffEntries(
      [h('user', 'a', true), h('user', 'b', false)],
      [h('user', 'a', true), h('user', 'ZZZ', false)]
    )!;
    expect(rows.map(r => r.change)).toEqual(['same', 'changed']);
    expect(rows.map(r => r.occurrence)).toEqual([0, 1]);
    expect(rows.map(r => r.id)).toEqual(['user#0', 'user#1']);
  });

  it('sobra de chave repetida vira added/removed', () => {
    const doisAqui = diffEntries([h('u', 'a'), h('u', 'b')], [h('u', 'a')])!;
    expect(doisAqui.map(r => r.change)).toEqual(['same', 'removed']);

    const doisLa = diffEntries([h('u', 'a')], [h('u', 'a'), h('u', 'b')])!;
    expect(doisLa.map(r => r.change)).toEqual(['same', 'added']);
  });

  it('guarda a posição remota, que é onde uma entrada nova entra', () => {
    const rows = diffEntries([h('B', '2')], [h('A', '1'), h('B', '2')])!;
    expect(rowFor(rows, 'A').remoteIndex).toBe(0);
  });

  // "A request de lá não tem mais headers" se quer ver entrada a entrada
  // tanto quanto qualquer outra diferença.
  it('campo ausente conta como lista vazia', () => {
    expect(diffEntries([h('A', '1')], undefined)!.map(r => r.change)).toEqual(['removed']);
    expect(diffEntries(null, [h('A', '1')])!.map(r => r.change)).toEqual(['added']);
  });

  it('devolve null quando não é lista de chave/valor', () => {
    expect(diffEntries({ type: 'bearer' }, { type: 'basic' })).toBeNull();
    expect(diffEntries(['a', 'b'], ['b', 'a'])).toBeNull();
    expect(diffEntries('texto', 'outro')).toBeNull();
  });

  it('devolve null quando nenhum dos lados era lista de verdade', () => {
    expect(diffEntries(undefined, null)).toBeNull();
  });
});

describe('entriesFromText', () => {
  it('lê a lista do rascunho', () => {
    expect(entriesFromText('[{"key":"A","value":"1"}]')).toEqual([{ key: 'A', value: '1' }]);
  });

  it('texto vazio é lista vazia', () => {
    expect(entriesFromText('   ')).toEqual([]);
  });

  // JSON pela metade enquanto se digita não pode derrubar a tela.
  it('JSON quebrado devolve null', () => {
    expect(entriesFromText('[{"key"')).toBeNull();
  });

  it('JSON válido que não é lista de chave/valor devolve null', () => {
    expect(entriesFromText('{"a":1}')).toBeNull();
  });
});

describe('applyChoice', () => {
  const rows = diffEntries(
    [h('Accept', 'json'), h('X-Tenant', 'homolog')],
    [h('Accept', 'json'), h('X-Tenant', 'prod')]
  )!;
  const remoto = [h('Accept', 'json'), h('X-Tenant', 'prod')];

  it('troca a entrada pela versão daqui', () => {
    const next = applyChoice(remoto, rowFor(rows, 'X-Tenant'), 'local');
    expect(next).toEqual([h('Accept', 'json'), h('X-Tenant', 'homolog')]);
  });

  it('não mexe nas outras entradas', () => {
    const next = applyChoice(remoto, rowFor(rows, 'X-Tenant'), 'local');
    expect(next[0]).toEqual(h('Accept', 'json'));
  });

  it('não altera a lista recebida', () => {
    applyChoice(remoto, rowFor(rows, 'X-Tenant'), 'local');
    expect(remoto[1]).toEqual(h('X-Tenant', 'prod'));
  });

  it('escolher o lado que não tem a entrada a remove', () => {
    const r = diffEntries([], [h('Novo', '1')])!;
    expect(applyChoice([h('Novo', '1')], rowFor(r, 'Novo'), 'local')).toEqual([]);
  });

  // Sem a posição remota, toda entrada aceita iria parar no fim da lista.
  it('entrada ausente entra na posição que tem no remoto', () => {
    const r = diffEntries([h('B', '2')], [h('A', '1'), h('B', '2')])!;
    expect(applyChoice([h('B', '2')], rowFor(r, 'A'), 'remote')).toEqual([
      h('A', '1'),
      h('B', '2'),
    ]);
  });

  it('posição remota fora do alcance cai no fim, sem buraco', () => {
    const r = diffEntries([], [h('A', '1'), h('B', '2'), h('C', '3')])!;
    expect(applyChoice([], rowFor(r, 'C'), 'remote')).toEqual([h('C', '3')]);
  });

  it('devolver uma entrada removida a traz de volta', () => {
    const r = diffEntries([h('A', '1')], [])!;
    expect(applyChoice([], rowFor(r, 'A'), 'local')).toEqual([h('A', '1')]);
  });

  it('chave repetida: resolve a ocorrência certa', () => {
    const r = diffEntries(
      [h('u', 'a'), h('u', 'b')],
      [h('u', 'a'), h('u', 'ZZZ')]
    )!;
    const next = applyChoice([h('u', 'a'), h('u', 'ZZZ')], rowFor(r, 'u', 1), 'local');
    expect(next).toEqual([h('u', 'a'), h('u', 'b')]);
  });
});

describe('sideOf', () => {
  const rows = diffEntries(
    [h('Accept', 'json'), h('X-Tenant', 'homolog')],
    [h('Accept', 'json'), h('X-Tenant', 'prod')]
  )!;

  it('rascunho igual ao remoto', () => {
    const atual = [h('Accept', 'json'), h('X-Tenant', 'prod')];
    expect(sideOf(atual, rowFor(rows, 'X-Tenant'))).toBe('remote');
  });

  it('rascunho igual ao local', () => {
    const atual = [h('Accept', 'json'), h('X-Tenant', 'homolog')];
    expect(sideOf(atual, rowFor(rows, 'X-Tenant'))).toBe('local');
  });

  // Mão livre na caixa de resultado é permitida; o que não pode é a tela
  // afirmar que é um dos dois lados quando não é nenhum.
  it('valor de terceiro tipo não vira lado nenhum', () => {
    const atual = [h('Accept', 'json'), h('X-Tenant', 'outro')];
    expect(sideOf(atual, rowFor(rows, 'X-Tenant'))).toBeNull();
  });

  it('entrada nova ausente do rascunho conta como ficar com a daqui', () => {
    const r = diffEntries([], [h('Novo', '1')])!;
    expect(sideOf([], rowFor(r, 'Novo'))).toBe('local');
  });

  it('entrada removida ausente do rascunho conta como aceitar a remoção', () => {
    const r = diffEntries([h('A', '1')], [])!;
    expect(sideOf([], rowFor(r, 'A'))).toBe('remote');
  });

  it('entrada que existe dos dois lados e sumiu do rascunho não é lado nenhum', () => {
    expect(sideOf([h('Accept', 'json')], rowFor(rows, 'X-Tenant'))).toBeNull();
  });

  it('acompanha o que applyChoice acabou de fazer', () => {
    const row = rowFor(rows, 'X-Tenant');
    const depois = applyChoice([h('Accept', 'json'), h('X-Tenant', 'prod')], row, 'local');
    expect(sideOf(depois, row)).toBe('local');
  });
});
