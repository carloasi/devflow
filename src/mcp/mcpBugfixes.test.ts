import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { executeMcpTool, McpContext } from './mcpTools';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { validateFlow } from './flowValidation';
import { displayedCommand } from '@/components/Settings/McpSettingsSection';

const req = (id: string, name: string, opts: { url?: string; pre?: string; post?: string; token?: string } = {}) =>
  ({
    id,
    name,
    type: 'request',
    method: 'GET',
    request: {
      url: opts.url ?? '{{urlX}}/a',
      urlexport: { host: [], path: [], raw: '' },
      headers: [],
      body: '',
      bodyType: 'none',
      auth: { type: 'bearer', token: opts.token ?? '{{tokenB2b}}' },
      scripts: { preRequest: opts.pre ?? '', postResponse: opts.post ?? '' },
    },
  }) as unknown as CollectionItem;
const folder = (id: string, name: string, item: CollectionItem[]) => ({ id, name, type: 'folder', item }) as CollectionItem;

function ctxOf(collections: CollectionItem[], envValues: unknown[] = [{ key: 'urlX', value: 'x', enabled: true }]): McpContext {
  return {
    workspace: 'w',
    collections,
    environments: [{ id: 'e', name: '5by5', values: envValues } as any],
    activeEnvironmentName: '5by5',
    tabs: [],
    activeTabId: null,
    consoleLogs: [],
    setRequestScript: vi.fn(async () => {}),
    addCollectionItem: vi.fn(async () => {}),
    renameCollectionItem: async () => {},
    setEnvironmentVariable: async () => {},
    applyEnvironmentChanges: vi.fn(async () => {}),
    updateCollectionItem: vi.fn(async () => {}),
    moveCollectionItem: vi.fn(async () => {}),
    removeCollectionItem: vi.fn(async () => {}),
  };
}

describe('M1: variável que só o usuário cria não vira "corrija"', () => {
  it('create_flow lista as variáveis a criar e não manda consertar', async () => {
    const out: any = await executeMcpTool(
      'create_flow',
      { name: 'X', parentFolderId: 'p', steps: [{ name: 'Token', method: 'POST', url: '{{urlX}}/t', auth: { type: 'bearer', token: '{{tokenB2b}}' } }] },
      ctxOf([folder('p', 'P', [])])
    );
    expect(out.variablesToCreate).toEqual(['tokenB2b']);
    expect(out.note).toContain('Variables to create in the app: tokenB2b');
    expect(out.note).toContain('do NOT try to fix them');
    expect(out.note).not.toMatch(/error\(s\) in the steps/);
  });

  it('erro de verdade num passo continua mandando corrigir', async () => {
    const out: any = await executeMcpTool(
      'create_flow',
      { name: 'X', steps: [{ name: 'Quebrado', url: '{{urlX}}/a', postResponseScript: 'pm.environment.set("a", ' }] },
      ctxOf([])
    );
    expect(out.note).toContain('The check found 1 error(s) in the steps');
  });

  it('validate_flow dá a mesma nota', async () => {
    const out: any = await executeMcpTool('validate_flow', { folderId: 'p' }, ctxOf([folder('p', 'P', [req('r', 'R')])]));
    expect(out.note).toContain('Variables to create in the app: tokenB2b');
  });
});

describe('M2: set_request_script só em request', () => {
  it('id de pasta é recusado e nada é gravado', async () => {
    const ctx = ctxOf([folder('f', 'Pasta', [req('r', 'R')])]);
    await expect(executeMcpTool('set_request_script', { requestId: 'f', phase: 'preRequest', code: 'x = 1;' }, ctx)).rejects.toThrow(
      /is a folder, not a request/
    );
    expect(ctx.setRequestScript).not.toHaveBeenCalled();
  });
});

describe('B1: variável sem "enabled" conta como desligada, igual à execução', () => {
  it('validate_flow acusa a falta', async () => {
    const out: any = await executeMcpTool(
      'validate_flow',
      { folderId: 'p' },
      ctxOf([folder('p', 'P', [req('r', 'R', { token: '' })])], [{ key: 'urlX', value: 'x' }])
    );
    expect(out.missingVariables).toEqual(['urlX']);
  });
});

describe('B2: create_request devolve a posição entre os itens diretos', () => {
  it('subpasta conta como um item', async () => {
    const tree = [folder('p', 'P', [folder('sub', 'Sub', [req('a', 'A'), req('b', 'B')]), req('c', 'C')])];
    const out: any = await executeMcpTool('create_request', { folderId: 'p', name: 'Nova', url: '/n' }, ctxOf(tree));
    expect(out.position).toBe(3);
  });
});

describe('B3: comando na tela com o token ainda carregando', () => {
  it('não põe bolinhas na frente do comando', () => {
    const cmd = (token: string) => `claude mcp add -s user devflow --header "Authorization: Bearer ${token}"`;
    expect(displayedCommand(cmd(''), '', false)).toBe('Loading the token…');
    expect(displayedCommand(cmd('abc123'), 'abc123', false)).toBe(cmd('•'.repeat(12)));
    expect(displayedCommand(cmd('abc123'), 'abc123', true)).toBe(cmd('abc123'));
  });
});

describe('B5: zerar no pre-request não conta como produzir', () => {
  it('reset de journeyKey não esconde a falta do produtor', () => {
    const steps = [
      req('s1', 'AirSearch', { pre: 'pm.environment.set("journeyKey", "");\npm.environment.set(\'fareKey\', \'\');', post: '// caminho errado: não grava nada', token: '' }),
      req('s2', 'Order', { url: '{{urlX}}/order/{{journeyKey}}/{{fareKey}}', token: '' }),
    ];
    const report = validateFlow(steps, ['urlX']);
    expect(report.steps[0].produces).toEqual([]);
    expect(report.missingVariables).toEqual(['journeyKey', 'fareKey']);
  });

  it('set com valor de verdade continua produzindo', () => {
    const report = validateFlow([req('s1', 'A', { pre: 'pm.environment.set("x", "1");', token: '' })], ['urlX']);
    expect(report.steps[0].produces).toEqual(['x']);
  });
});
