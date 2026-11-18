import { describe, expect, it } from 'vitest';
import type { Environment } from '@/app/types/Environment';
import { envKeepMineIds, environmentHashes, rebaseEnvironments } from './envMerge';
import { withoutSessionTokens } from '@/lib/jwt';

const env = (vars: Record<string, string>, id = 'e1', name = 'tst'): Environment => ({
  id,
  name,
  values: Object.entries(vars).map(([key, value]) => ({ key, value, type: 'default', enabled: true })),
});

const valuesOf = (envs: Environment[], id = 'e1') =>
  Object.fromEntries((envs.find(e => e.id === id)?.values ?? []).map(v => [v.key, v.value]));

const synced = () => [env({ baseUrl: 'https://tst', token: 't0', user: 'ana' })];
const base = environmentHashes(synced());

describe('envKeepMineIds', () => {
  it('protects my unpushed variable and a variable I deleted; not one only GitHub changed', () => {
    const local = [env({ baseUrl: 'https://tst', token: 't-mine' })]; // user apagada aqui, token mudado aqui
    const remote = [env({ baseUrl: 'https://hml', token: 't0', user: 'ana' })]; // baseUrl mudou só lá
    expect([...envKeepMineIds(local, remote, base)].sort()).toEqual(['e1:token', 'e1:user']);
  });

  it('without a base, any variable that differs stays mine', () => {
    const local = [env({ baseUrl: 'https://tst', token: 't-mine', user: 'ana' })];
    const remote = [env({ baseUrl: 'https://hml', token: 't0', user: 'ana' })];
    expect([...envKeepMineIds(local, remote, null)].sort()).toEqual(['e1:baseUrl', 'e1:token']);
  });
});

describe('rebaseEnvironments', () => {
  it('names what stayed mine', () => {
    const local = [env({ baseUrl: 'https://tst', token: 't-mine', user: 'ana' })];
    const remote = [env({ baseUrl: 'https://tst', token: 't-theirs', user: 'ana' })];
    expect(rebaseEnvironments(local, remote, base).keptMineNames).toEqual(['tst › token']);
  });

  it('keeps my variable and takes theirs when different variables changed', () => {
    const local = [env({ baseUrl: 'https://tst', token: 't-mine', user: 'ana' })];
    const remote = [env({ baseUrl: 'https://hml', token: 't0', user: 'ana' })];

    const r = rebaseEnvironments(local, remote, base);

    expect(valuesOf(r.merged)).toEqual({ baseUrl: 'https://hml', token: 't-mine', user: 'ana' });
    expect(r.incoming).toBe(1);
  });

  it('the same variable changed on both sides keeps mine', () => {
    const local = [env({ baseUrl: 'https://tst', token: 't-mine', user: 'ana' })];
    const remote = [env({ baseUrl: 'https://tst', token: 't-theirs', user: 'ana' })];

    const r = rebaseEnvironments(local, remote, base);

    expect(valuesOf(r.merged).token).toBe('t-mine');
    expect(r.keptMine).toBe(1);
  });

  it('adds variables created on GitHub and keeps the ones created here', () => {
    const local = [env({ baseUrl: 'https://tst', token: 't0', user: 'ana', mine: '1' })];
    const remote = [env({ baseUrl: 'https://tst', token: 't0', user: 'ana', theirs: '2' })];

    expect(valuesOf(rebaseEnvironments(local, remote, base).merged)).toMatchObject({ mine: '1', theirs: '2' });
  });

  it('a variable deleted on GitHub goes away unless I changed it', () => {
    const remote = [env({ baseUrl: 'https://tst', token: 't0' })];

    expect(valuesOf(rebaseEnvironments(synced(), remote, base).merged)).not.toHaveProperty('user');
    const changed = [env({ baseUrl: 'https://tst', token: 't0', user: 'bia' })];
    expect(valuesOf(rebaseEnvironments(changed, remote, base).merged).user).toBe('bia');
  });

  it('a variable I deleted stays deleted', () => {
    const local = [env({ baseUrl: 'https://tst', token: 't0' })];

    expect(valuesOf(rebaseEnvironments(local, synced(), base).merged)).not.toHaveProperty('user');
  });

  it('brings a whole environment created on GitHub', () => {
    const remote = [...synced(), env({ baseUrl: 'https://prd' }, 'e2', 'prd')];

    const r = rebaseEnvironments(synced(), remote, base);

    expect(r.merged.map(e => e.id)).toEqual(['e1', 'e2']);
  });

  it('without a base, keeps mine on every changed variable', () => {
    const local = [env({ baseUrl: 'https://tst', token: 't-mine', user: 'ana' })];
    const remote = [env({ baseUrl: 'https://hml', token: 't0', user: 'ana' })];

    expect(valuesOf(rebaseEnvironments(local, remote, null).merged)).toMatchObject({ baseUrl: 'https://tst', token: 't-mine' });
  });
});

describe('environments casados pelo nome, com ids diferentes', () => {
  it('a mudança feita no GitHub entra, mesmo com a base gravada com o id de lá', () => {
    const remoteAtSync = env({ baseUrl: 'https://old' }, 'REMOTE', 'Dev');
    const baseFromPull = environmentHashes([remoteAtSync]); // o pull grava com o id do GitHub
    const local = [env({ baseUrl: 'https://old' }, 'LOCAL', 'Dev')];
    const remote = [env({ baseUrl: 'https://new' }, 'REMOTE', 'Dev')];

    const result = rebaseEnvironments(local, remote, baseFromPull);
    expect(result.incoming).toBe(1);
    expect(result.keptMine).toBe(0);
    expect(valuesOf(result.merged, 'LOCAL')).toEqual({ baseUrl: 'https://new' });
    expect([...envKeepMineIds(local, remote, baseFromPull)]).toEqual([]);
  });
});

describe('tokens de sessão', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
  const make = (vals: Record<string, string>) => [env(vals, 'e1', 'env-tst')];

  it('depois do envio não aparecem em "Para enviar" (sobem vazios de propósito)', () => {
    const local = make({ baseUrl: 'x', bearerToken: JWT, orderToken: JWT });
    const remote = withoutSessionTokens(local);
    const r = rebaseEnvironments(local, remote, environmentHashes(remote));
    expect(r.outgoingNames).toEqual([]);
    expect(r.keptMineNames).toEqual([]);
    expect(r.sessionTokenNames.sort()).toEqual(['env-tst › bearerToken', 'env-tst › orderToken']);
  });

  it('o token daqui fica quando o do GitHub é outro, e o resto do merge segue', () => {
    const synced = make({ baseUrl: 'x', bearerToken: '' });
    const local = make({ baseUrl: 'x', bearerToken: JWT });
    const remote = make({ baseUrl: 'y', bearerToken: '' });
    const r = rebaseEnvironments(local, remote, environmentHashes(synced));
    expect(r.incomingNames).toEqual(['env-tst › baseUrl']);
    const merged = r.merged[0].values;
    expect(merged.find(v => v.key === 'bearerToken')?.value).toBe(JWT);
    expect(merged.find(v => v.key === 'baseUrl')?.value).toBe('y');
  });
});

describe('variável de token só no GitHub (arquivo antigo, com o token de alguém)', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
  it('chega aqui vazia, sem o token de outra pessoa', () => {
    const local = [env({ baseUrl: 'x' }, 'e1', 'env-tst')];
    const remote = [env({ baseUrl: 'x', accessToken: JWT }, 'e1', 'env-tst')];
    const r = rebaseEnvironments(local, remote, environmentHashes(local));
    expect(r.incomingNames).toEqual(['env-tst › accessToken']);
    expect(valuesOf(r.merged)).toEqual({ baseUrl: 'x', accessToken: '' });
  });
});

describe('valores pro diff da Central', () => {
  it('dá o valor daqui e o do GitHub de cada variável listada', () => {
    const synced = [env({ url: 'https://old' }, 'e1', '5by5')];
    const local = [env({ url: 'https://new' }, 'e1', '5by5')];
    const r = rebaseEnvironments(local, synced, environmentHashes(synced));
    expect(r.outgoingNames).toEqual(['5by5 › url']);
    expect(r.values['5by5 › url']).toEqual({ local: 'https://new', remote: 'https://old' });
  });

  it('environment só daqui vem como "chave = valor", sem token de sessão', () => {
    const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';
    const local = [env({ url: 'x', bearerToken: JWT }, 'e2', 'novo')];
    const r = rebaseEnvironments(local, [], null);
    expect(r.values['novo']).toEqual({ local: 'url = x\nbearerToken = ', remote: undefined });
  });
});
