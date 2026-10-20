import { describe, it, expect } from 'vitest';
import { toPostmanUrl } from './postmanUrl';

// Reconstrói a URL como o postman-collection SDK faz: pelas PARTES, nunca
// pelo `raw`. É este o leitor que importa, e é contra ele que as asserções
// abaixo valem.
function rebuild(u: ReturnType<typeof toPostmanUrl>): string {
  let out = u.protocol ? `${u.protocol}://` : '';
  if (u.auth) out += u.auth.password ? `${u.auth.user}:${u.auth.password}@` : `${u.auth.user}@`;
  out += u.host.join('.');
  if (u.port) out += `:${u.port}`;
  if (u.path.length) out += `/${u.path.join('/')}`;
  if (u.query.length) out += `?${u.query.map(q => `${q.key}=${q.value}`).join('&')}`;
  if (u.hash) out += `#${u.hash}`;
  return out;
}

describe('toPostmanUrl', () => {
  it('guarda o texto cru', () => {
    expect(toPostmanUrl('https://api.example.com/v1').raw).toBe('https://api.example.com/v1');
  });

  it('separa protocolo, host e caminho', () => {
    const u = toPostmanUrl('https://apim-arch.azure-api.net/echo/resource');
    expect(u.protocol).toBe('https');
    expect(u.host).toEqual(['apim-arch', 'azure-api', 'net']);
    expect(u.path).toEqual(['echo', 'resource']);
  });

  // O export não emitia `protocol`, então toda request https virava http no
  // Postman — que monta a URL pelas partes e assume o padrão sem esquema.
  it('preserva o https', () => {
    expect(toPostmanUrl('https://x.com/a').protocol).toBe('https');
    expect(toPostmanUrl('http://x.com/a').protocol).toBe('http');
  });

  it('sem esquema não inventa um', () => {
    expect(toPostmanUrl('{{base}}/a').protocol).toBeUndefined();
  });

  // A porta ficava grudada no host ou sumia; `localhost:5001` virava
  // `localhost`.
  it('separa a porta', () => {
    const u = toPostmanUrl('https://localhost:5001/api/v1/order');
    expect(u.host).toEqual(['localhost']);
    expect(u.port).toBe('5001');
  });

  it('porta como variável também conta', () => {
    const u = toPostmanUrl('{{host}}:{{port}}/api');
    expect(u.host).toEqual(['{{host}}']);
    expect(u.port).toBe('{{port}}');
  });

  it('dois-pontos que não é porta fica no host', () => {
    expect(toPostmanUrl('{{url:dev}}/api').port).toBeUndefined();
  });
});

describe('variáveis no host', () => {
  it('host que é só uma variável não é dividido', () => {
    expect(toPostmanUrl('{{urlAuthorization}}/api/v1/token').host).toEqual([
      '{{urlAuthorization}}',
    ]);
  });

  // Dividir dentro das chaves produziria ["{{base", "url}}"], que o Postman
  // remontaria como um host inexistente.
  it('ponto dentro da variável não separa', () => {
    expect(toPostmanUrl('{{base.url}}/api').host).toEqual(['{{base.url}}']);
  });

  it('variável misturada com domínio', () => {
    expect(toPostmanUrl('https://{{tenant}}.example.com/a').host).toEqual([
      '{{tenant}}',
      'example',
      'com',
    ]);
  });
});

describe('caminho e parâmetros', () => {
  it('mantém o segmento :param', () => {
    const u = toPostmanUrl('{{url}}/api/v1/order/:recordLocator/seats/:unitKey');
    expect(u.path).toEqual(['api', 'v1', 'order', ':recordLocator', 'seats', ':unitKey']);
  });

  it('recebe os path params de fora', () => {
    const vars = [{ key: 'recordLocator', value: 'ABC123' }];
    expect(toPostmanUrl('{{url}}/order/:recordLocator', vars).variable).toEqual(vars);
  });

  it('sem path params, lista vazia', () => {
    expect(toPostmanUrl('{{url}}/a').variable).toEqual([]);
  });

  it('query vira pares', () => {
    const u = toPostmanUrl('{{url}}/search?origin=GRU&destination=REC');
    expect(u.query).toEqual([
      { key: 'origin', value: 'GRU' },
      { key: 'destination', value: 'REC' },
    ]);
    expect(u.path).toEqual(['search']);
  });

  it('valor de query com = no meio não é cortado', () => {
    expect(toPostmanUrl('{{url}}/a?filter=x=1').query).toEqual([{ key: 'filter', value: 'x=1' }]);
  });

  it('query sem valor', () => {
    expect(toPostmanUrl('{{url}}/a?flag').query).toEqual([{ key: 'flag', value: '' }]);
  });

  // Um `%` solto não pode derrubar o export inteiro.
  it('escape inválido passa como está', () => {
    expect(toPostmanUrl('{{url}}/a?x=100%').query).toEqual([{ key: 'x', value: '100%' }]);
  });

  it('fragmento é separado', () => {
    const u = toPostmanUrl('https://x.com/a?b=1#secao');
    expect(u.hash).toBe('secao');
    expect(u.query).toEqual([{ key: 'b', value: '1' }]);
    expect(u.path).toEqual(['a']);
  });
});

describe('casos de borda', () => {
  it('URL vazia — é como o app guarda um passo de token OAuth2', () => {
    const u = toPostmanUrl('');
    expect(u).toMatchObject({ raw: '', host: [], path: [], query: [] });
    expect(u.protocol).toBeUndefined();
  });

  it('só o host', () => {
    expect(toPostmanUrl('https://x.com')).toMatchObject({ host: ['x', 'com'], path: [] });
  });

  it('endereço sem esquema, começando com //', () => {
    const u = toPostmanUrl('//cdn.example.com/a');
    expect(u.host).toEqual(['cdn', 'example', 'com']);
    expect(u.protocol).toBeUndefined();
  });

  it('credenciais no endereço', () => {
    const u = toPostmanUrl('https://joao:segredo@x.com/a');
    expect(u.auth).toEqual({ user: 'joao', password: 'segredo' });
    expect(u.host).toEqual(['x', 'com']);
  });

  it('barras repetidas não viram segmento vazio', () => {
    expect(toPostmanUrl('{{url}}//a//b').path).toEqual(['a', 'b']);
  });

  // Campo ausente sai do objeto: declará-lo vazio faria o Postman montar
  // `://` ou `:` sem valor.
  it('campos ausentes não aparecem no objeto', () => {
    const u = toPostmanUrl('{{url}}/a');
    expect('protocol' in u).toBe(false);
    expect('port' in u).toBe(false);
    expect('hash' in u).toBe(false);
    expect('auth' in u).toBe(false);
  });
});

// O ponto do módulo inteiro: o que o Postman monta a partir das partes tem
// que ser a URL que o usuário vê na tela.
describe('as partes reconstroem o raw', () => {
  const casos = [
    'https://apim-arch.azure-api.net/echo/resource',
    'https://localhost:5001/api/v1/order/:recordLocator/seats/:unitKey',
    '{{urlAuthorization}}/api/v1/token',
    '{{urlShopping}}/api/v1/airSearch?origin=GRU&destination=REC',
    'http://localhost:6012/api/v1/order/{{recordLocator}}/passengers',
    'https://{{tenant}}.example.com/a/b',
    '{{base.url}}/api',
    'https://x.com',
  ];

  for (const raw of casos) {
    it(raw, () => {
      expect(rebuild(toPostmanUrl(raw))).toBe(raw);
    });
  }
});
