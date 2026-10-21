import { describe, it, expect } from 'vitest';
import {
  applySecretActions,
  jwtExpiry,
  maskValue,
  scanTree,
  suggestVariableName,
  summarizeFindings,
} from './secretScan';
import type { CollectionItem } from '@/app/types/CollectionItem';

/** JWT de verdade (assinatura falsa) com o `exp` pedido. */
function jwt(expSecondsFromNow: number | null): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = expSecondsFromNow === null ? { sub: 'x' } : { sub: 'x', exp: Math.floor(Date.now() / 1000) + expSecondsFromNow };
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.c2ln`;
}

const req = (id: string, name: string, request: Partial<NonNullable<CollectionItem['request']>>): CollectionItem =>
  ({
    id,
    name,
    type: 'request',
    request: { url: '', urlexport: { host: [], path: [], raw: '' }, headers: [], ...request },
  }) as CollectionItem;

describe('maskValue', () => {
  it('mostra as pontas e o tamanho', () => {
    expect(maskValue('abcdefghijklmnopqrst')).toBe('abcdef…qrst (20 chars)');
  });

  // Valor curto não tem ponta que dê pra mostrar sem entregar quase tudo.
  it('valor curto some por inteiro', () => {
    expect(maskValue('senha123')).toBe('••••••••');
  });
});

describe('jwtExpiry', () => {
  it('reconhece token expirado e há quantos dias', () => {
    const r = jwtExpiry(jwt(-86400 * 30));
    expect(r).toMatchObject({ expired: true });
    expect(r!.daysAgo).toBe(30);
  });

  it('token ainda válido', () => {
    expect(jwtExpiry(jwt(3600))).toMatchObject({ expired: false });
  });

  // Dizer "não expirou" sem ler o exp seria afirmar o que não se sabe.
  it('sem exp devolve null', () => {
    expect(jwtExpiry(jwt(null))).toBeNull();
  });

  it('texto que não é JWT devolve null', () => {
    expect(jwtExpiry('senha-comum')).toBeNull();
  });
});

describe('suggestVariableName', () => {
  it('header vira camelCase', () => {
    expect(suggestVariableName('X-Api-Key')).toBe('xApiKey');
  });

  it('já em uma palavra', () => {
    expect(suggestVariableName('token')).toBe('token');
  });

  it('nome sem letras cai num padrão', () => {
    expect(suggestVariableName('---')).toBe('secret');
  });
});

describe('scanTree', () => {
  it('acha token literal no auth bearer', () => {
    const found = scanTree([req('r1', 'Login', { auth: { type: 'bearer', token: jwt(-86400) } })]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ requestId: 'r1', kind: 'jwt', expired: true });
  });

  // `{{token}}` é exatamente o que se quer ver no lugar do literal.
  it('referência a variável não é achado', () => {
    expect(scanTree([req('r1', 'x', { auth: { type: 'bearer', token: '{{token}}' } })])).toEqual([]);
  });

  it('campo vazio não é achado', () => {
    expect(scanTree([req('r1', 'x', { auth: { type: 'bearer', token: '' } })])).toEqual([]);
  });

  it('header cujo nome sugere credencial', () => {
    const found = scanTree([
      req('r1', 'x', { headers: [{ key: 'Authorization', value: 'Bearer abc123xyz', enabled: true }] }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].location).toEqual({ type: 'header', key: 'Authorization' });
  });

  // Redigir todo header tiraria Content-Type e Accept sem ganhar segurança.
  it('header comum é ignorado', () => {
    const found = scanTree([
      req('r1', 'x', { headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }] }),
    ]);
    expect(found).toEqual([]);
  });

  it('client_secret do oauth2', () => {
    const found = scanTree([
      req('r1', 'x', {
        auth: { type: 'oauth2', token: '', oauth2: [
          { key: 'clientSecret', value: 's3cr3t-value-aqui', enabled: true },
          { key: 'grantType', value: 'client_credentials', enabled: true },
        ] },
      }),
    ]);
    expect(found.map(f => f.location)).toEqual([{ type: 'oauth2', key: 'clientSecret' }]);
  });

  it('o valor real nunca aparece no achado', () => {
    const segredo = 'super-secreto-que-nao-pode-vazar';
    const found = scanTree([req('r1', 'x', { auth: { type: 'bearer', token: segredo } })]);
    expect(JSON.stringify(found)).not.toContain(segredo);
  });

  it('percorre a árvore e guarda o caminho', () => {
    const tree: CollectionItem[] = [
      { id: 'c1', name: 'Voos', type: 'folder', item: [
        { id: 'f1', name: 'Auth', type: 'folder', item: [
          req('r1', 'Token', { auth: { type: 'bearer', token: 'abc123defg456' } }),
        ] },
      ] } as CollectionItem,
    ];
    expect(scanTree(tree)[0].path).toEqual(['Voos', 'Auth', 'Token']);
  });

  // O segredo num example é cópia do da request; listar os dois dobraria a
  // lista sem acrescentar um lugar pra corrigir.
  it('ignora examples', () => {
    const tree: CollectionItem[] = [
      { ...req('r1', 'Req', { auth: { type: 'bearer', token: '{{t}}' } }),
        item: [{ ...req('e1', 'Example', { auth: { type: 'bearer', token: 'abc123defg456' } }), type: 'example' }],
      } as CollectionItem,
    ];
    expect(scanTree(tree)).toEqual([]);
  });

  it('árvore vazia', () => {
    expect(scanTree([])).toEqual([]);
    expect(scanTree(null)).toEqual([]);
  });
});

describe('summarizeFindings', () => {
  it('separa expirado de ainda válido', () => {
    const found = scanTree([
      req('r1', 'a', { auth: { type: 'bearer', token: jwt(-86400) } }),
      req('r2', 'b', { auth: { type: 'bearer', token: jwt(3600) } }),
      req('r3', 'c', { headers: [{ key: 'X-Api-Key', value: 'chave-literal-aqui', enabled: true }] }),
    ]);
    expect(summarizeFindings(found)).toEqual({ total: 3, expired: 1, live: 2 });
  });
});

describe('applySecretActions', () => {
  const tree = () => [req('r1', 'Login', { auth: { type: 'bearer', token: 'valor-secreto-real' } })];

  it('extrair troca pelo {{nome}} e devolve o valor de verdade', () => {
    const roots = tree();
    const found = scanTree(roots);
    const out = applySecretActions(roots, [{ finding: found[0], action: { type: 'extract', variable: 'tokenLogin' } }]);

    expect(out.roots[0].request!.auth!.token).toBe('{{tokenLogin}}');
    expect(out.variables).toEqual([{ key: 'tokenLogin', value: 'valor-secreto-real' }]);
  });

  it('limpar esvazia sem criar variável', () => {
    const roots = tree();
    const out = applySecretActions(roots, [{ finding: scanTree(roots)[0], action: { type: 'clear' } }]);
    expect(out.roots[0].request!.auth!.token).toBe('');
    expect(out.variables).toEqual([]);
  });

  it('não altera a árvore recebida', () => {
    const roots = tree();
    applySecretActions(roots, [{ finding: scanTree(roots)[0], action: { type: 'clear' } }]);
    expect(roots[0].request!.auth!.token).toBe('valor-secreto-real');
  });

  it('alcança request no fundo da árvore', () => {
    const roots: CollectionItem[] = [
      { id: 'c1', name: 'C', type: 'folder', item: [
        req('r1', 'Deep', { headers: [{ key: 'X-Token', value: 'literal-aqui-123', enabled: true }] }),
      ] } as CollectionItem,
    ];
    const out = applySecretActions(roots, [{ finding: scanTree(roots)[0], action: { type: 'extract', variable: 'xToken' } }]);
    expect(out.roots[0].item![0].request!.headers[0].value).toBe('{{xToken}}');
  });

  // Uma request pode ter vários achados; aplicar um de cada vez sobre a
  // árvore inteira reescreveria o nó e perderia a alteração anterior.
  it('várias decisões na mesma request', () => {
    const roots = [
      req('r1', 'x', {
        auth: { type: 'bearer', token: 'token-literal-aqui' },
        headers: [{ key: 'X-Api-Key', value: 'chave-literal-aqui', enabled: true }],
      }),
    ];
    const found = scanTree(roots);
    const out = applySecretActions(roots, found.map(f => ({ finding: f, action: { type: 'extract' as const, variable: f.suggestedVariable } })));

    expect(out.roots[0].request!.auth!.token).toBe('{{token}}');
    expect(out.roots[0].request!.headers[0].value).toBe('{{xApiKey}}');
    expect(out.variables).toHaveLength(2);
  });

  it('decisão sobre campo já limpo não cria variável vazia', () => {
    const roots = tree();
    const f = scanTree(roots)[0];
    const out = applySecretActions(roots, [
      { finding: f, action: { type: 'clear' } },
      { finding: f, action: { type: 'extract', variable: 'tokenLogin' } },
    ]);
    expect(out.variables).toEqual([]);
  });

  it('sem decisões devolve a árvore equivalente', () => {
    const out = applySecretActions(tree(), []);
    expect(out.roots[0].request!.auth!.token).toBe('valor-secreto-real');
    expect(out.variables).toEqual([]);
  });
});

// Os dois recortes abaixo vieram de medir a base real: sem eles o detector
// apontava 3.087 itens, dos quais 2.501 eram ruído — e lista com 80% de
// ruído ninguém olha.
describe('o que NÃO é segredo', () => {
  it('variável com prefixo é a forma correta, não um achado', () => {
    const found = scanTree([
      req('r1', 'x', { headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }] }),
    ]);
    expect(found).toEqual([]);
  });

  it('qualquer {{...}} no valor já basta', () => {
    const found = scanTree([
      req('r1', 'x', { headers: [{ key: 'Cookie', value: 'sid={{sessionId}}; path=/', enabled: true }] }),
    ]);
    expect(found).toEqual([]);
  });

  it('valor curto demais não é credencial', () => {
    const found = scanTree([
      req('r1', 'x', { headers: [{ key: 'X-Token', value: 'none', enabled: true }] }),
    ]);
    expect(found).toEqual([]);
  });

  // tokenName é rótulo; authUrl e accessTokenUrl são endereços. Os três casam
  // com /token|auth/ e não autorizam nada.
  it('campos de configuração do oauth2 ficam de fora', () => {
    const found = scanTree([
      req('r1', 'x', {
        auth: { type: 'oauth2', token: '', oauth2: [
          { key: 'tokenName', value: 'Access Token B2B', enabled: true },
          { key: 'authUrl', value: 'https://login.microsoftonline.com/x/oauth2/authorize', enabled: true },
          { key: 'accessTokenUrl', value: 'https://login.microsoftonline.com/x/oauth2/token', enabled: true },
          { key: 'clientId', value: '11111111-2222-3333-4444-555555555555', enabled: true },
          { key: 'clientSecret', value: 'vLI8Q~segredo~de~verdade', enabled: true },
        ] },
      }),
    ]);
    expect(found.map(f => f.location)).toEqual([{ type: 'oauth2', key: 'clientSecret' }]);
  });
});

describe('suggestVariableName — camelCase', () => {
  it('preserva o camelCase de um nome só', () => {
    expect(suggestVariableName('clientSecret')).toBe('clientSecret');
  });

  it('header com hífen continua virando camelCase', () => {
    expect(suggestVariableName('Ocp-Apim-Subscription-Key')).toBe('ocpApimSubscriptionKey');
  });
});
