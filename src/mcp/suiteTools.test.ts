import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

// Execução falsa: o caso "C-02" falha num teste; o resto passa.
vi.mock('@/components/CollectionRunner/runCollectionRequest', async original => {
  const real: any = await original();
  return {
    ...real,
    runCollectionRequest: vi.fn(async (item: any, env: Record<string, string>) => {
      const failing = /C-02/.test(item.name);
      const tests = /^0[2-9]|^1\d/.test(item.name)
        ? [
            { name: `${item.name.slice(5, 9)}: status 400`, passed: true, message: '' },
            { name: `${item.name.slice(5, 9)}: code X.Invalid`, passed: !failing, message: failing ? 'expected [] to include X.Invalid' : '' },
          ]
        : [];
      return {
        itemId: item.id,
        status: 'success',
        httpStatus: tests.length ? 400 : 200,
        responseTime: 1,
        tests,
        envAfter: env,
        logs: [{ level: 'log', message: 'x'.repeat(50), phase: 'post-response' }],
        variablesSet: [],
        responseBodySnippet: '{"notifications":[]}',
      };
    }),
  };
});

import { executeMcpTool, McpContext } from './mcpTools';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { applyBodyPatch, buildExpectScript, caseIdOf } from './suiteCase';

const base = {
  id: 'quote',
  name: 'POST Quote',
  type: 'request',
  method: 'POST',
  request: {
    url: '{{urlQuote}}/api/v1/quote',
    urlexport: { host: [], path: [], raw: '' },
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    body: '{\n  "eventName": "Evento",\n  "paxCount": {{flowPaxCount}},\n  "contact": { "email": "a@example.com", "phones": [{ "number": "1" }] }\n}',
    bodyType: 'raw',
    auth: { type: 'bearer', token: '{{bearerToken}}' },
    scripts: { preRequest: '', postResponse: 'pm.test("velho", function () {});' },
  },
} as unknown as CollectionItem;

function context(collections: CollectionItem[]): McpContext {
  return {
    workspace: 'w',
    collections,
    environments: [{ id: 'e', name: 'dev', values: [] } as any],
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

describe('casos de suíte', () => {
  it('bodyPatch / bodyRemove mudam só o campo do caso e preservam {{variável}} fora de string', () => {
    const out = applyBodyPatch(
      base.request!.body!,
      { eventName: 'Comemora-ção', 'contact.phones[0].number': null, 'contact.extra.flag': true },
      ['contact.email']
    );
    expect(out).toContain('"paxCount": {{flowPaxCount}}');
    expect(JSON.parse(out.replace('{{flowPaxCount}}', '10'))).toEqual({
      eventName: 'Comemora-ção',
      paxCount: 10,
      contact: { phones: [{ number: null }], extra: { flag: true } },
    });
    expect(() => applyBodyPatch(base.request!.body!, {}, ['nao.existe'])).toThrow(/bodyRemove/);
    expect(() => applyBodyPatch('{ // comentário\n}', { a: 1 })).toThrow(/not valid JSON/);
  });

  it('expect vira asserções com o id do caso, igualdade exata no status', () => {
    const script = buildExpectScript('C-11', { status: 400, codes: ['EventName.Invalid'], fields: { 'data.status': 'Open' } });
    expect(script).toContain('pm.test("C-11: status 400", function () { pm.expect(pm.response.code).to.equal(400); });');
    expect(script).toContain('pm.test("C-11: code EventName.Invalid"');
    expect(script).toContain('pm.expect(__get(__body, "data.status")).to.eql("Open")');
    expect(() => new Function('pm', script)).not.toThrow();
    expect(caseIdOf('03 - C-11 - Hífen')).toBe('C-11');
    expect(caseIdOf('A-01b - Consultar')).toBe('A-01b');
  });

  it('create_flow monta 2 casos a partir da origem, sem redigitar o body', async () => {
    const ctx = context([{ id: 'f', name: 'Quote.Groups', type: 'folder', item: [base] } as CollectionItem]);
    const out: any = await executeMcpTool(
      'create_flow',
      {
        name: 'Validação - eventName',
        steps: [
          { copyFrom: 'quote', name: 'C-01 - Vazio', bodyPatch: { eventName: '' }, expect: { status: 400, codes: ['EventName.Required'] } },
          { copyFrom: 'quote', name: 'C-02 - Ausente', bodyRemove: ['eventName'], expect: { status: 400, codes: ['EventName.Required'] } },
        ],
      },
      ctx
    );
    expect(out.ok).toBe(true);
    const [c1, c2] = (ctx.addCollectionItem as any).mock.calls[0][1].item as CollectionItem[];
    expect(c1.name).toBe('01 - C-01 - Vazio');
    expect(JSON.parse(c1.request!.body!.replace('{{flowPaxCount}}', '1')).eventName).toBe('');
    expect(c2.request!.body).not.toContain('eventName');
    // O pm.test da origem não vem (copyFrom tira os scripts); só as asserções geradas.
    expect(c1.request!.scripts!.postResponse).not.toContain('velho');
    expect(c1.request!.scripts!.postResponse).toContain('C-01: code EventName.Required');
  });
});

describe('run_collection com detail: "failures"', () => {
  const req = (id: string, name: string) =>
    ({ id, name, type: 'request', method: 'POST', request: { url: '/x', headers: [], body: '' } }) as unknown as CollectionItem;
  const suite = [
    {
      id: 'suite',
      name: 'Validação',
      type: 'folder',
      item: [
        { id: 'ga', name: 'A - Obrigatórios', type: 'folder', item: [req('t1', '01 - Token'), req('a1', '02 - C-01 - Vazio'), req('a2', '03 - C-02 - Ausente')] },
        { id: 'gb', name: 'B - Formato', type: 'folder', item: [req('t2', '01 - Token'), req('b1', '04 - C-03 - Hífen')] },
      ],
    },
  ] as unknown as CollectionItem[];

  it('com stopOnFailure, os casos que não rodaram entram na matriz como "não executado"', async () => {
    const out: any = await executeMcpTool('run_collection', { folderId: 'suite', detail: 'failures', stopOnFailure: true }, context(suite));
    expect(out.completed).toBe(3);
    expect(out.matrix.find((r: any) => r.case === 'C-03')).toMatchObject({ result: 'não executado', group: 'B - Formato' });
  });

  it('suíte inteira numa chamada: detalhe só das falhas, resumo por grupo e matriz por caso', async () => {
    const out: any = await executeMcpTool('run_collection', { folderId: 'suite', detail: 'failures' }, context(suite));
    expect(out.completed).toBe(5);
    expect(out.groups).toEqual([
      { group: 'A - Obrigatórios', steps: 3, passed: 2, failed: 1 },
      { group: 'B - Formato', steps: 2, passed: 2, failed: 0 },
    ]);
    const passedStep = out.steps.find((s: any) => s.request === '02 - C-01 - Vazio');
    expect(passedStep).toEqual({ request: '02 - C-01 - Vazio', group: 'A - Obrigatórios', verdict: 'passed', httpStatus: 400, tests: '2/2' });
    const failedStep = out.steps.find((s: any) => s.request === '03 - C-02 - Ausente');
    expect(failedStep.logs).toBeDefined();
    expect(out.matrix.map((r: any) => [r.case, r.result])).toEqual([
      ['C-01', 'passou'],
      ['C-02', 'falhou'],
      ['C-03', 'passou'],
    ]);
    expect(out.matrix[1].failedTests[0]).toContain('code X.Invalid');
    expect(out.matrix[0].expected).toBe('status 400; code X.Invalid');
  });
});
