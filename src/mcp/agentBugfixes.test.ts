import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { executeMcpTool, McpContext } from './mcpTools';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { connectedSessions, EMPTY_CONNECTIONS, mcpConnectionsReducer } from './mcpConnections';
import { findSourceRequest } from './flowSources';
import { applyBodyPatch, caseIdOf } from './suiteCase';
import { createWriteQueue } from './writeQueue';

const req = (id: string, name: string, body = '') =>
  ({
    id,
    name,
    type: 'request',
    method: 'POST',
    request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body, bodyType: body ? 'raw' : 'none', scripts: { preRequest: '', postResponse: '' } },
  }) as unknown as CollectionItem;
const folder = (id: string, name: string, item: CollectionItem[]) => ({ id, name, type: 'folder', item }) as CollectionItem;

function ctxOf(collections: CollectionItem[], workspace = 'Barramento B2B - Dev'): McpContext {
  return {
    workspace,
    collections,
    environments: [{ id: 'e', name: '5by5', values: [] } as any],
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

const paga = { id: 'b2b-reserva-paga', answers: { route: 'VCP → SDU', pax: '1' } };

describe('receita: origem, workspace e pasta', () => {
  it('id que não existe diz isso, e com outro workspace aberto vem um aviso só no começo', async () => {
    expect(() => findSourceRequest([], '0cd95190-444d-47ea-9194-7dee99209573')).toThrow(/Request id ".*" not found in the open workspace/);
    const out: any = await executeMcpTool(
      'create_flow_from_recipe',
      { ...paga, parentFolderId: 'x', dryRun: true },
      ctxOf([folder('x', 'x', [])], 'Portal De Grupos - Dev')
    );
    expect(out.blockers[0]).toMatch(/This recipe is for the workspace "Barramento B2B - Dev", but "Portal De Grupos - Dev" is open/);
  });

  it('dryRun com a pasta da receita ausente mostra o plano e um blocker, sem lançar erro', async () => {
    const out: any = await executeMcpTool('create_flow_from_recipe', { ...paga, dryRun: true }, ctxOf([]));
    expect(out.created).toBe(false);
    expect(out.plan.length).toBeGreaterThan(0);
    expect(out.blockers.some((b: string) => b.startsWith('Where to create it:'))).toBe(true);
  });

  it('answers e steps mandados como texto JSON são aceitos', async () => {
    const out: any = await executeMcpTool(
      'create_flow_from_recipe',
      { id: 'b2b-reserva-paga', answers: JSON.stringify(paga.answers), parentFolderId: 'x', dryRun: true },
      ctxOf([folder('x', 'x', [])])
    );
    expect((out.blockers ?? []).some((b: string) => b.startsWith('Missing answers'))).toBe(false);

    const ctx = ctxOf([]);
    const created: any = await executeMcpTool('create_flow', { name: 'X', steps: JSON.stringify([{ name: 'A', url: '/a' }]) }, ctx);
    expect(created.ok).toBe(true);
    await expect(executeMcpTool('create_flow', { name: 'X', steps: '[{nao é json' }, ctx)).rejects.toThrow(/"steps" must be a JSON/);
  });
});

describe('caminho em texto', () => {
  it('"/" dentro do nome da request não quebra o caminho', () => {
    const tree = [folder('o', 'Order', [folder('v3', 'v3', [req('r', 'Order/{recordLocator} v3')])])];
    expect(findSourceRequest(tree, 'Order / v3 / Order/{recordLocator} v3').item.id).toBe('r');
    // Caminho sem espaços continua valendo; nome solto também.
    expect(findSourceRequest([folder('a', 'A', [req('t', 'Token')])], 'A/Token').item.id).toBe('t');
    expect(findSourceRequest([folder('a', 'A', [req('t', '2FA')])], '2FA').item.id).toBe('t');
  });
});

describe('casos de suíte', () => {
  it('número com mais de 15 dígitos volta igual', () => {
    const out = applyBodyPatch('{"orderNumber": 12345678901234567890, "small": 12.5, "neg": -3, "a": 1}', { a: 2 });
    expect(out).toContain('"orderNumber": 12345678901234567890');
    expect(out).toContain('"small": 12.5');
    expect(out).toContain('"a": 2');
  });

  it('ids de caso com ponto e sublinhado', () => {
    expect(caseIdOf('C-1.1 - Vazio')).toBe('C-1.1');
    expect(caseIdOf('C-1.2 - Nulo')).toBe('C-1.2');
    expect(caseIdOf('CT_01 - x')).toBe('CT_01');
    expect(caseIdOf('03 - C-11 - Hífen')).toBe('C-11');
    expect(caseIdOf('A-01b - Consultar')).toBe('A-01b');
  });
});

describe('sessões do painel do DevFlow', () => {
  it('um prompt novo do painel fecha a sessão do prompt anterior', () => {
    let s = EMPTY_CONNECTIONS;
    for (let i = 0; i < 4; i++) {
      s = mcpConnectionsReducer(s, {
        type: 'request',
        meta: { sessionId: `p${i}`, clientTag: 'panel' },
        method: 'initialize',
        clientInfo: { name: 'claude-code' },
        at: 1000 + i,
      });
    }
    s = mcpConnectionsReducer(s, { type: 'request', meta: { sessionId: 'cc' }, method: 'initialize', clientInfo: { name: 'claude-code' }, at: 1010 });
    const connected = connectedSessions(s, 2000);
    expect(connected.map(x => x.key).sort()).toEqual(['cc', 'p3']);
  });
});

describe('fila de escrita do MCP', () => {
  it('duas escritas seguidas: a segunda espera o React aplicar a primeira e lê a árvore nova', async () => {
    // Simula o AppLayout: a escrita só aparece na árvore no "próximo render".
    let tree: { scripts: string; url: string } = { scripts: '', url: '/a' };
    const queue = createWriteQueue(() => tree, { pollMs: 2 });
    const write = (change: Partial<typeof tree>) => async () => {
      const read = tree; // o que a ferramenta lê do contexto
      setTimeout(() => {
        tree = { ...read, ...change };
      }, 15);
      return { ok: true };
    };
    await Promise.all([queue(write({ scripts: 'pm.environment.set("x", "1");' })), queue(write({ url: '/novo' }))]);
    expect(tree).toEqual({ scripts: 'pm.environment.set("x", "1");', url: '/novo' });
  });

  it('escrita que falha não trava a fila; ok:false não espera', async () => {
    const queue = createWriteQueue(() => 'igual', { timeoutMs: 5000, pollMs: 2 });
    await expect(queue(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const started = Date.now();
    await queue(async () => ({ ok: false }));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
