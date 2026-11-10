import { describe, expect, it } from 'vitest';
import { computeRenamedWorkspaces, type WorkspaceInfo } from './workspaceStore';

const ws = (name: string, path = name): WorkspaceInfo => ({ name, path });

describe('computeRenamedWorkspaces', () => {
  it('renomeia o workspace e mantém os demais intactos', () => {
    const list = [ws('Barramento B2B - Dev'), ws('Release')];
    const result = computeRenamedWorkspaces(list, 'Barramento B2B - Dev', 'Barramento B2B - QA');
    expect(result).toEqual({
      workspaces: [ws('Barramento B2B - QA'), ws('Release')],
      renamed: ws('Barramento B2B - QA'),
    });
  });

  it('tira caracteres que não são letra/número/traço/underscore/espaço do novo nome', () => {
    const list = [ws('Old')];
    const result = computeRenamedWorkspaces(list, 'Old', 'New!! @Name##');
    expect(result?.renamed).toEqual(ws('New Name'));
  });

  it('retorna null quando o nome sanitizado fica vazio', () => {
    const list = [ws('Old')];
    expect(computeRenamedWorkspaces(list, 'Old', '!!!')).toBeNull();
  });

  it('retorna null quando já existe outro workspace com o path novo', () => {
    const list = [ws('Old'), ws('Taken')];
    expect(computeRenamedWorkspaces(list, 'Old', 'Taken')).toBeNull();
  });

  it('permite renomear pra um nome que sanitiza pro MESMO path (no-op)', () => {
    const list = [ws('Old')];
    const result = computeRenamedWorkspaces(list, 'Old', 'Old');
    expect(result).toEqual({ workspaces: [ws('Old')], renamed: ws('Old') });
  });

  // O caso que o guard evita: sem ele, um oldPath que não existe mais na
  // lista (corrida com outra aba, ou chamada repetida) ainda devolveria um
  // WorkspaceInfo de "sucesso" — o chamador migraria dados pra um path que
  // nunca entrou no registro, um workspace fantasma.
  it('retorna null quando oldPath não existe na lista', () => {
    const list = [ws('Release')];
    expect(computeRenamedWorkspaces(list, 'Ghost', 'New Name')).toBeNull();
  });

  it('não altera a lista original (retorna uma nova array)', () => {
    const list = [ws('Old')];
    const result = computeRenamedWorkspaces(list, 'Old', 'New');
    expect(result).not.toBeNull();
    expect(list).toEqual([ws('Old')]);
  });
});
