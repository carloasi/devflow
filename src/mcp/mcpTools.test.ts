import { describe, it, expect, vi } from 'vitest';

// O motor de execução fala com o Rust; aqui só interessa o que a ferramenta
// faz com o resultado, então ele devolve o mesmo formato do passo de token real
// (runTokenStep em runCollectionRequest.ts) e de um passo que usa o token.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.c2lnbmF0dXJl';

vi.mock('@/components/CollectionRunner/runCollectionRequest', async original => {
  const real: any = await original();
  return {
    ...real,
    runCollectionRequest: vi.fn(async (item: any, env: Record<string, string>) => {
      if (item.id === 'tok') {
        return {
          itemId: item.id,
          status: 'success',
          responseTime: 1,
          tests: [],
          envAfter: { ...env, msal: JWT },
          logs: [],
          variablesSet: [{ key: 'msal', value: JWT, phase: 'post-response' }],
          responseBodySnippet: 'New token stored in {{msal}}',
        };
      }
      return {
        itemId: item.id,
        status: 'success',
        httpStatus: 200,
        responseTime: 1,
        tests: [{ name: 'has token', passed: true, message: `got ${env.msal}` }],
        envAfter: { ...env, bookingId: 'BK-1' },
        resolvedUrl: `https://api/x?access_token=${env.msal}`,
        logs: [{ level: 'log', message: `token=${env.msal}`, phase: 'post-response' }],
        variablesSet: [{ key: 'bookingId', value: 'BK-1', phase: 'post-response' }],
        fullResponseBody: `{"echo":"${env.msal}","id":"BK-1"}`,
        responseBodySnippet: `{"echo":"${env.msal}"`,
      };
    }),
  };
});

import { executeMcpTool, McpContext } from './mcpTools';
import type { CollectionItem } from '@/app/types/CollectionItem';

const tokenStep = {
  id: 'tok',
  name: '0 - Token MSAL',
  type: 'request',
  method: 'GET',
  request: { url: '', headers: [], body: '', auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: '{{msal}}', enabled: true }] } },
} as unknown as CollectionItem;

const search = {
  id: 'search',
  name: '1 - Search',
  type: 'request',
  method: 'GET',
  request: { url: '{{baseUrl}}/x', headers: [], body: '', auth: { type: 'bearer', token: '{{msal}}' } },
} as unknown as CollectionItem;

function context(collections: CollectionItem[]): McpContext {
  return {
    workspace: 'w',
    collections,
    environments: [{ id: 'e', name: 'dev', values: [{ key: 'baseUrl', value: 'https://api', enabled: true }] } as any],
    activeEnvironmentName: 'dev',
    tabs: [],
    activeTabId: null,
    consoleLogs: [],
    setRequestScript: async () => {},
    addCollectionItem: vi.fn(async () => {}),
    renameCollectionItem: async () => {},
    setEnvironmentVariable: async () => {},
    applyEnvironmentChanges: vi.fn(async () => {}),
    updateCollectionItem: vi.fn(async () => {}),
    moveCollectionItem: vi.fn(async () => {}),
    removeCollectionItem: vi.fn(async () => {}),
  };
}

describe('segredos no resultado das execuções do MCP', () => {
  it('run_request de um passo de token não devolve o token', async () => {
    const out: any = await executeMcpTool('run_request', { requestId: 'tok' }, context([tokenStep]));
    expect(JSON.stringify(out)).not.toContain(JWT);
    expect(out.variablesSet[0]).toMatchObject({ key: 'msal', token: { readable: true } });
  });

  it('run_collection mascara o token em logs, URL, testes e body dos passos seguintes', async () => {
    const tree = [{ id: 'f', name: 'Flow', type: 'folder', item: [tokenStep, search] }] as unknown as CollectionItem[];
    const out: any = await executeMcpTool('run_collection', { folderId: 'f' }, context(tree));
    const text = JSON.stringify(out);
    expect(text).not.toContain(JWT);

    const step = out.steps[1];
    expect(step.logs[0].message).toBe('token={{msal}}');
    expect(step.resolvedUrl).toBe('https://api/x?access_token={{msal}}');
    expect(step.tests[0].message).toBe('got {{msal}}');
    // Valor que não é credencial continua visível: é o que encadeia o fluxo.
    expect(step.variablesSet[0]).toMatchObject({ key: 'bookingId', value: 'BK-1' });
  });

  it('run_request mascara o body completo', async () => {
    const ctx = context([search]);
    ctx.environments[0].values.push({ key: 'msal', value: JWT, enabled: true } as any);
    const out: any = await executeMcpTool('run_request', { requestId: 'search' }, ctx);
    expect(out.body).toBe('{"echo":"{{msal}}","id":"BK-1"}');
  });
});

describe('variáveis gravadas pelos scripts', () => {
  it('run_request leva pro environment o que o script gravou, como o Send', async () => {
    const ctx = context([search]);
    const out: any = await executeMcpTool('run_request', { requestId: 'search' }, ctx);
    expect(ctx.applyEnvironmentChanges).toHaveBeenCalledWith(
      'e',
      { baseUrl: 'https://api' },
      { baseUrl: 'https://api', bookingId: 'BK-1' },
      '1 - Search'
    );
    expect(out.savedToEnvironment).toEqual(['bookingId']);
  });

  it('run_collection grava passo a passo, e o passo 2 recebe o token do passo 1', async () => {
    const tree = [{ id: 'f', name: 'Flow', type: 'folder', item: [tokenStep, search] }] as unknown as CollectionItem[];
    const ctx = context(tree);
    const out: any = await executeMcpTool('run_collection', { folderId: 'f' }, ctx);
    expect(ctx.applyEnvironmentChanges).toHaveBeenCalledTimes(2);
    const [, , afterStep1] = (ctx.applyEnvironmentChanges as any).mock.calls[0];
    expect(afterStep1.msal).toBe(JWT);
    expect(out.savedToEnvironment.sort()).toEqual(['bookingId', 'msal']);
  });

  it('sem environment selecionado não grava e avisa', async () => {
    const ctx = context([search]);
    ctx.activeEnvironmentName = undefined;
    const out: any = await executeMcpTool('run_request', { requestId: 'search' }, ctx);
    expect(ctx.applyEnvironmentChanges).not.toHaveBeenCalled();
    expect(out.note).toMatch(/not saved/);
  });
});

describe('resolução de pasta por caminho', () => {
  const tree = [
    {
      id: 'root',
      name: 'Coll',
      type: 'folder',
      item: [
        { id: 'bf', name: 'Booking Flow', type: 'folder', item: [search] },
        { id: 'fl', name: 'Flow', type: 'folder', item: [tokenStep] },
      ],
    },
  ] as unknown as CollectionItem[];

  it('"Flow" é a pasta Flow, não "Booking Flow"', async () => {
    const out: any = await executeMcpTool('list_requests', { folderId: 'Flow' }, context(tree));
    expect(out.requests.map((r: any) => r.id)).toEqual(['tok']);
  });

  it('pedaço de nome que não é segmento não casa com nada', async () => {
    await expect(executeMcpTool('list_requests', { folderId: 'ing Flow' }, context(tree))).rejects.toThrow(/not found/);
  });

  it('caminho parcial com barra sem espaços funciona', async () => {
    const out: any = await executeMcpTool('list_requests', { folderId: 'coll/booking flow' }, context(tree));
    expect(out.requests.map((r: any) => r.id)).toEqual(['search']);
  });
});

describe('create_flow e validate_flow', () => {
  const msal = {
    id: 'msal-src',
    name: 'Gerar token MSAL',
    type: 'request',
    method: 'GET',
    request: { url: '', headers: [], auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: '{{msal}}', enabled: true }, { key: 'clientSecret', value: 'segredo', enabled: true }] } },
  } as unknown as CollectionItem;
  const root = { id: 'root', name: 'Method Flows', type: 'folder', item: [msal] } as unknown as CollectionItem;

  it('cria a pasta com os passos numerados, numa inserção só, e devolve a checagem', async () => {
    const ctx = context([root]);
    const out: any = await executeMcpTool(
      'create_flow',
      {
        name: 'Flow 08 - Reserva',
        parentFolderId: 'root',
        steps: [
          { duplicateFrom: 'msal-src' },
          {
            name: 'Token Groups v1',
            method: 'POST',
            url: '{{urlAuthorization}}/api/v1/token/groups',
            auth: { type: 'bearer', token: '{{msal}}' },
            postResponseScript: 'pm.environment.set("bearerToken", pm.response.json().data.token);',
          },
          { name: 'Search', method: 'POST', url: '{{baseUrl}}/search', auth: { type: 'bearer', token: '{{bearerToken}}' }, body: '{"k":"{{fareKey}}"}' },
        ],
      },
      ctx
    );
    expect(ctx.addCollectionItem).toHaveBeenCalledTimes(1);
    const [parentId, folder] = (ctx.addCollectionItem as any).mock.calls[0];
    expect(parentId).toBe('root');
    expect(folder.item.map((i: any) => i.name)).toEqual(['01 - Gerar token MSAL', '02 - Token Groups v1', '03 - Search']);
    // A cópia leva o segredo (o modelo nunca o vê) e ganha id novo.
    expect(folder.item[0].id).not.toBe('msal-src');
    expect(folder.item[0].request.auth.oauth2[1].value).toBe('segredo');
    expect(out.steps).toHaveLength(3);
    expect(JSON.stringify(out)).not.toContain('segredo');
    // fareKey ninguém produz e não está no environment de teste.
    expect(out.check.ok).toBe(false);
    expect(out.check.missingVariables).toEqual(expect.arrayContaining(['fareKey']));
    expect(out.check.steps[0].produces).toEqual(['msal']);
  });

  it('passo inválido: nada é criado', async () => {
    const ctx = context([root]);
    await expect(
      executeMcpTool('create_flow', { name: 'X', steps: [{ name: 'ok', url: '/a' }, { name: 'sem url' }] }, ctx)
    ).rejects.toThrow(/Step 2: url is required\. Nothing was created\./);
    expect(ctx.addCollectionItem).not.toHaveBeenCalled();
  });

  it('validate_flow confere uma pasta existente contra o environment', async () => {
    const flow = {
      id: 'f', name: 'Flow', type: 'folder',
      item: [search],
    } as unknown as CollectionItem;
    const out: any = await executeMcpTool('validate_flow', { folderId: 'f' }, context([flow]));
    // search usa {{baseUrl}} (existe no env de teste) e {{msal}} (não existe, ninguém produz).
    expect(out.environment).toBe('dev');
    expect(out.missingVariables).toEqual(['msal']);
    expect(out.steps[0].problems[0].code).toBe('missing-variable');
  });
});

describe('fase 5: receitas, edição, movimento, exclusão e anotações', () => {
  it('list_flow_recipes e get_flow_recipe (com o bloco de autenticação já em passos)', async () => {
    const list: any = await executeMcpTool('list_flow_recipes', {}, context([]));
    expect(list.recipes.map((r: any) => r.id)).toContain('b2b-reserva-partida-24h');
    const recipe: any = await executeMcpTool('get_flow_recipe', { id: 'grupos-cotacao-pedido' }, context([]));
    const msalBlock = recipe.include.find((b: any) => b.when === 'auth == msal');
    // O caminho da origem: o create_flow resolve sozinho, sem o agente procurar o id.
    expect(msalBlock.steps[0]).toEqual({ duplicateFrom: 'Portal De Grupos - APIs / Gerar token MSAL', name: '01 - Gerar token MSAL' });
    expect(msalBlock.steps[1].folderId).toBeUndefined();
    expect(recipe.rules.length).toBeGreaterThan(3);
    await expect(executeMcpTool('get_flow_recipe', { id: 'nao-existe' }, context([]))).rejects.toThrow(/not found/);
  });

  it('update_request mantém o segredo quando volta o texto mascarado', async () => {
    const original = {
      id: 'r1', name: 'Token', type: 'request', method: 'POST',
      request: { url: '/a', headers: [{ key: 'X-Api-Key', value: 'real', enabled: true }], auth: { type: 'none' } },
    } as unknown as CollectionItem;
    const ctx = context([original]);
    const out: any = await executeMcpTool(
      'update_request',
      { requestId: 'r1', url: '/b', headers: [{ key: 'X-Api-Key', value: '[redacted — set in DevFlow]' }] },
      ctx
    );
    expect(out.changed).toEqual(['url', 'headers']);
    const [, saved] = (ctx.updateCollectionItem as any).mock.calls[0];
    expect(saved.request.url).toBe('/b');
    expect(saved.request.headers[0].value).toBe('real');
    // A resposta mostra a request como o get_request: segredo mascarado.
    expect(JSON.stringify(out)).not.toContain('"real"');
  });

  it('move_item confere antes e repassa ao app; delete_item exige o nome exato', async () => {
    const tree = [{ id: 'f', name: 'Flow', type: 'folder', item: [search, tokenStep] }] as unknown as CollectionItem[];
    const ctx = context(tree);
    const moved: any = await executeMcpTool('move_item', { itemId: 'tok', targetFolderId: 'f', position: 1 }, ctx);
    expect(moved.position).toBe(1);
    expect(ctx.moveCollectionItem).toHaveBeenCalledWith('tok', 'f', 1);

    await expect(executeMcpTool('delete_item', { itemId: 'search', confirmName: 'Search' }, ctx)).rejects.toThrow(/Nothing was deleted/);
    expect(ctx.removeCollectionItem).not.toHaveBeenCalled();
    const deleted: any = await executeMcpTool('delete_item', { itemId: 'search', confirmName: '1 - Search' }, ctx);
    expect(deleted.deleted).toMatchObject({ id: 'search', requests: 1 });
    expect(ctx.removeCollectionItem).toHaveBeenCalledWith('search');
  });

  it('ferramentas têm anotações e as principais trazem exemplo', async () => {
    const { MCP_TOOLS } = await import('./mcpTools');
    const byName = Object.fromEntries(MCP_TOOLS.map(t => [t.name, t]));
    expect(byName.list_requests.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_item.annotations?.destructiveHint).toBe(true);
    expect(byName.run_collection.annotations?.openWorldHint).toBe(true);
    expect(MCP_TOOLS.every(t => t.annotations)).toBe(true);
    expect(byName.create_request.description).toContain('Example:');
    // Todo exemplo é JSON válido (o que vem depois de "Example: ").
    for (const tool of MCP_TOOLS) {
      const at = tool.description.lastIndexOf('Example: {');
      const example = at >= 0 ? tool.description.slice(at + 'Example: '.length) : undefined;
      if (example && !example.includes('<') && !example.includes('…')) expect(() => JSON.parse(example)).not.toThrow();
    }
  });
});
