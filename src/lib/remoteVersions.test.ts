import { describe, it, expect } from 'vitest';
import { applyShaChanges, behindPaths, countBehind, workspaceShaChanges } from './remoteVersions';

const ws = 'Postman/Time/';
const a = `${ws}a.postman_collection.json`;
const b = `${ws}b.postman_collection.json`;
const env = `${ws}environments/dev.postman_environment.json`;
const outro = 'Postman/Outro/x.postman_collection.json';

describe('applyShaChanges', () => {
  it('grava e apaga', () => {
    expect(applyShaChanges({ [a]: '1', [b]: '1' }, { [a]: '2', [b]: null })).toEqual({ [a]: '2' });
  });
});

describe('behindPaths', () => {
  it('separa alterado, novo e apagado no GitHub, só no workspace', () => {
    const synced = { [a]: '1', [b]: '1', [outro]: '1' };
    const remote = { [a]: '2', [env]: '1', [outro]: '9' };
    expect(behindPaths(remote, synced, ws)).toEqual({ changed: [a], added: [env], deleted: [b] });
  });

  it('nada sincronizado nesta máquina: nada a avisar', () => {
    expect(behindPaths({ [a]: '1' }, {}, ws)).toEqual({ changed: [], added: [], deleted: [] });
  });
});

describe('countBehind', () => {
  it('nada sincronizado nesta máquina: não dá pra saber', () => {
    expect(countBehind({ [a]: '1' }, {}, ws)).toBeNull();
    expect(countBehind({ [a]: '1' }, { [outro]: '1' }, ws)).toBeNull();
  });

  it('em dia', () => {
    expect(countBehind({ [a]: '1', [env]: '1' }, { [a]: '1', [env]: '1' }, ws)).toBe(0);
  });

  it('conta alterado, novo e apagado no GitHub', () => {
    const remote = { [a]: '2', [env]: '1' }; // a mudou, env apareceu, b sumiu
    const synced = { [a]: '1', [b]: '1' };
    expect(countBehind(remote, synced, ws)).toBe(3);
  });

  it('ignora outros workspaces', () => {
    expect(countBehind({ [a]: '1', [outro]: '9' }, { [a]: '1', [outro]: '1' }, ws)).toBe(0);
  });

  it('ignora arquivo gravado que a listagem não acompanha', () => {
    const markers = `${ws}devflow-markers.json`;
    const tracked = (p: string) => !p.endsWith('devflow-markers.json');
    expect(countBehind({ [a]: '1' }, { [a]: '1', [markers]: '1' }, ws, tracked)).toBe(0);
  });
});

describe('workspaceShaChanges', () => {
  it('esquece o que sumiu do escopo e mantém o resto', () => {
    const changes = workspaceShaChanges({ [a]: '2' }, { [a]: '1', [b]: '1', [outro]: '1' }, p => p.startsWith(ws));
    expect(changes).toEqual({ [a]: '2', [b]: null });
  });
});
