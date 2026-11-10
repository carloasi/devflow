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
    addCollectionItem: async () => {},
    renameCollectionItem: async () => {},
    setEnvironmentVariable: async () => {},
    applyEnvironmentChanges: vi.fn(async () => {}),
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
