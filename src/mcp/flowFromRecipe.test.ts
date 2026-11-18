import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { executeMcpTool, McpContext } from './mcpTools';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { evaluateWhen, numberedFlowName } from './flowRecipes/applyRecipe';

let seq = 0;
const req = (
  name: string,
  url: string,
  opts: { id?: string; method?: string; body?: string; pre?: string; post?: string; auth?: Record<string, unknown> } = {}
): CollectionItem =>
  ({
    id: opts.id ?? `r${++seq}`,
    name,
    type: 'request',
    method: opts.method ?? 'POST',
    request: {
      url,
      urlexport: { host: [], path: [], raw: url },
      headers: [{ key: 'Ocp-Apim-Subscription-Key', value: '{{apiKey}}', enabled: true }],
      body: opts.body ?? '',
      bodyType: opts.body ? 'raw' : 'none',
      auth: opts.auth ?? { type: 'bearer', token: '{{bearerToken}}' },
      scripts: { preRequest: opts.pre ?? '', postResponse: opts.post ?? '' },
    },
    item: [{ id: `ex${seq}`, name: 'Saved example', type: 'example' }],
  }) as unknown as CollectionItem;
const folder = (name: string, item: CollectionItem[]): CollectionItem =>
  ({ id: `f-${name}-${++seq}`, name, type: 'folder', item }) as CollectionItem;

// As receitas B2B copiam pela id (no workspace real, Token v1, Order v1, Payments… têm
// GET/DELETE com o mesmo nome na mesma pasta): estas são as ids de lá.
const B2B_IDS = {
  token: '0cd95190-444d-47ea-9194-7dee99209573',
  authenticate: 'eb465345-14f8-41ff-b6f7-2ced2dbb7071',
  twoFa: '55cc9e3c-1cb9-4f10-9d8b-daaf0150a3aa',
  airSearchV3: 'eb293af8-94b3-40d0-bc20-61d8e0078680',
  orderV1: 'bb203ba7-09ed-41bd-9a82-43bff92de115',
  orderV2: '940e3223-3eaf-4c63-9469-95a77b99d6eb',
  payments: '39de420c-8816-486e-b34b-df2d397fbc5d',
  checkoutV1: '749f1045-05d2-4cac-baff-c662350dbb2a',
};

function b2bTree(): CollectionItem[] {
  return [
    folder('Barramento B2B - Dev', [
      folder('Authentication', [folder('v1', [req('Token v1', '{{urlAuthorization}}/api/v1/token', { id: B2B_IDS.token, auth: { type: 'bearer', token: '{{tokenB2b}}' }, post: 'pm.test("x", () => {});' })])]),
      folder('User', [
        folder('v1', [req('Authenticate v1', '{{urlUser}}/api/v1/authenticate', { id: B2B_IDS.authenticate, body: '{"username":"{{b2bUsername}}"}' })]),
        req('2FA', '{{urlUser}}/api/v1/2fa', { id: B2B_IDS.twoFa }),
      ]),
      folder('Shopping', [
        folder('v2', [req('AirSearch v2', '{{urlShopping}}/api/v2/airsearch', { body: '{"origin":"VCP"}' })]),
        folder('v3', [req('AirSearch v3', '{{urlShopping}}/api/v3/airsearch', { id: B2B_IDS.airSearchV3, body: '{"origin":"SDU","destination":"REC"}' })]),
      ]),
      folder('Order', [
        folder('v1', [req('Order v1', '{{urlOrder}}/api/v1/order', { id: B2B_IDS.orderV1, body: '{"pax":[]}' })]),
        folder('v2', [req('Order v2', '{{urlOrder}}/api/v2/order', { id: B2B_IDS.orderV2, body: '{"pax":[]}' })]),
      ]),
      folder('Payments', [folder('v1', [req('Payments v1', '{{urlPayments}}/api/v1/payments', { id: B2B_IDS.payments })])]),
      folder('Checkout', [folder('v1', [req('Checkout v1', '{{urlCheckout}}/api/v1/checkout/{{recordLocator}}', { id: B2B_IDS.checkoutV1 })])]),
    ]),
    folder('Sprints', [folder('Sprint 121', [folder('User Story 1345299: [Sales.B2B.Api] Migrar os Métodos de Change e Cancel para V4', [
      folder('Flow 01 - Fluxo Cancelamento com Reembolso', [
        req('01 - Token v1', '{{urlAuthorization}}/api/v1/token'),
        req('02 - Authenticate', '{{urlUser}}/api/v1/authenticate', { post: 'pm.environment.set("authToken", pm.response.json().data.token);' }),
        req('03 - 2FA', '{{urlUser}}/api/v1/2fa', { post: 'pm.environment.set("bearerToken", pm.response.json().data.token);' }),
        req('04 - AirSearch', '{{urlShopping}}/api/v3/airsearch', {
          post: 'var j = pm.response.json().data.journeys[0];\npm.environment.set("journeyKey", j.journeyKey);\npm.environment.set("fareKey", j.fares[0].fareKey);',
        }),
        req('05 - Order v1', '{{urlOrder}}/api/v1/order', {
          pre: 'pm.environment.set("flowCpf", "123");',
          post: 'pm.environment.set("recordLocator", pm.response.json().data.recordLocator);',
        }),
        req('06 - Payments v1', '{{urlPayments}}/api/v1/payments'),
        req('07 - Checkout v1', '{{urlCheckout}}/api/v1/checkout/{{recordLocator}}'),
      ]),
    ])])]),
  ];
}

function context(collections: CollectionItem[]): McpContext {
  return {
    workspace: 'Barramento B2B - Dev',
    collections,
    environments: [
      {
        id: 'e',
        name: '5by5',
        values: ['urlAuthorization', 'urlUser', 'urlShopping', 'urlOrder', 'urlPayments', 'urlCheckout', 'apiKey', 'tokenB2b', 'b2bUsername', 'b2bPassword'].map(
          key => ({ key, value: 'x', enabled: true })
        ),
      } as any,
    ],
    activeEnvironmentName: '5by5',
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

const created = (ctx: McpContext) => (ctx.addCollectionItem as any).mock.calls[0][1] as CollectionItem;

describe('create_flow com copyFrom / scriptsFrom', () => {
  it('copia a origem pelo caminho, sem os scripts nem os examples dela, e aplica o que vier por cima', async () => {
    const ctx = context(b2bTree());
    const out: any = await executeMcpTool(
      'create_flow',
      {
        name: 'Flow X',
        steps: [
          {
            copyFrom: { folder: 'Order / v1', request: 'Order v1' },
            scriptsFrom: { folder: 'Flow 01 - Fluxo Cancelamento com Reembolso', step: 'Order v1' },
            body: '{"pax":[{"name":"Fulano"}]}',
          },
          { copyFrom: 'Barramento B2B - Dev / Authentication / v1 / Token v1' },
        ],
      },
      ctx
    );
    expect(out.ok).toBe(true);
    expect(out.steps[0]).toMatchObject({
      name: '01 - Order v1',
      source: 'Barramento B2B - Dev / Order / v1 / Order v1',
      scriptsFrom: 'Sprints / Sprint 121 / User Story 1345299: [Sales.B2B.Api] Migrar os Métodos de Change e Cancel para V4 / Flow 01 - Fluxo Cancelamento com Reembolso / 05 - Order v1',
    });
    const [order, token] = created(ctx).item!;
    expect(order.request!.url).toBe('{{urlOrder}}/api/v1/order');
    expect(order.request!.body).toBe('{"pax":[{"name":"Fulano"}]}');
    expect(order.request!.scripts!.postResponse).toContain('recordLocator');
    expect(order.item).toBeUndefined();
    // Sem scriptsFrom: o pm.test da origem não vem junto.
    expect(token.request!.scripts!.postResponse).toBe('');
    expect(token.request!.auth).toMatchObject({ type: 'bearer', token: '{{tokenB2b}}' });
  });

  it('origem ambígua: nada é criado e o erro lista as candidatas com id', async () => {
    const ctx = context(b2bTree());
    await expect(
      executeMcpTool('create_flow', { name: 'X', steps: [{ copyFrom: { folder: 'Shopping', request: 'AirSearch' } }] }, ctx)
    ).rejects.toThrow(/Step 1: .*matches 2 requests: .*AirSearch v2 \(id: .*AirSearch v3/);
    expect(ctx.addCollectionItem).not.toHaveBeenCalled();
  });

  it('a versão desempata, e flows prontos nunca são origem', async () => {
    const ctx = context(b2bTree());
    const out: any = await executeMcpTool(
      'create_flow',
      { name: 'X', steps: [{ copyFrom: { folder: 'Shopping', request: 'AirSearch', version: 'v3' } }, { copyFrom: { request: 'Payments v1' } }] },
      ctx
    );
    expect(out.steps.map((s: any) => s.source)).toEqual([
      'Barramento B2B - Dev / Shopping / v3 / AirSearch v3',
      'Barramento B2B - Dev / Payments / v1 / Payments v1',
    ]);
  });

  it('duplicateFrom aceita caminho e mantém scripts e examples', async () => {
    const ctx = context(b2bTree());
    await executeMcpTool('create_flow', { name: 'X', steps: [{ duplicateFrom: 'Authentication / v1 / Token v1' }] }, ctx);
    const [token] = created(ctx).item!;
    expect(token.request!.scripts!.postResponse).toContain('pm.test');
    expect(token.item).toHaveLength(1);
  });
});

describe('create_flow_from_recipe', () => {
  const paga = { id: 'b2b-reserva-paga', answers: { route: 'VCP → SDU', pax: '1' } };

  it('monta o flow inteiro da receita numa chamada, numerado depois do Flow 01', async () => {
    const ctx = context(b2bTree());
    const out: any = await executeMcpTool('create_flow_from_recipe', paga, ctx);
    expect(out.ok).toBe(true);
    expect(out.name).toBe('Flow 02 - Reserva paga');
    expect(out.parent).toBe('User Story 1345299: [Sales.B2B.Api] Migrar os Métodos de Change e Cancel para V4');
    expect(out.steps.map((s: any) => s.name)).toEqual([
      '01 - Token v1', '02 - Authenticate v1', '03 - 2FA', '04 - AirSearch v3', '05 - Order v1', '06 - Payments v1', '07 - Checkout v1',
    ]);
    const steps = created(ctx).item!;
    // Token v1: sempre bearer {{tokenB2b}}, mesmo copiando a origem.
    expect(steps[0].request!.auth).toMatchObject({ type: 'bearer', token: '{{tokenB2b}}' });
    // Rota e pax entram no body do AirSearch pelos marcadores; a data é calculada no pre-request.
    const air = JSON.parse(steps[3].request!.body!);
    expect(air.journeys[0]).toEqual({ origin: 'VCP', destination: 'SDU', departure: '{{flowDeparture}}' });
    expect(air.passengers[0]).toEqual({ type: 'ADT', count: 1 });
    expect(steps[3].request!.scripts!.postResponse).toContain('offersAvailableByMarket');
    // Order v1 zera o que produz (orderTotalAmount); quem produz recordLocator é o Checkout v1.
    expect(steps[4].request!.scripts!.preRequest).toContain('["orderTotalAmount"]');
    expect(steps[4].request!.scripts!.preRequest).not.toContain('recordLocator');
    expect(steps[6].request!.scripts!.preRequest).toContain('["recordLocator"]');
    // Sem pm.test por padrão: os scripts da receita só gravam variáveis.
    expect(steps.some(s => /pm\.test/.test(`${s.request!.scripts!.preRequest}${s.request!.scripts!.postResponse}`))).toBe(false);
    expect(out.deliveryTable).toContain('| 05 - Order v1 | Barramento B2B - Dev / Order / v1 / Order v1 |');
    // Toda resposta tem marcador: nada sobra para o agente aplicar à mão.
    expect(out.review?.find((r: any) => r.step === '(answers)')).toBeUndefined();
  });

  it('dryRun mostra o plano com as origens e não cria nada', async () => {
    const ctx = context(b2bTree());
    const out: any = await executeMcpTool('create_flow_from_recipe', { ...paga, dryRun: true }, ctx);
    expect(out.created).toBe(false);
    expect(out.plan[3].source).toBe('Barramento B2B - Dev / Shopping / v3 / AirSearch v3');
    expect(ctx.addCollectionItem).not.toHaveBeenCalled();
  });

  it('resposta faltando: diz o que perguntar e não cria', async () => {
    const ctx = context(b2bTree());
    const out: any = await executeMcpTool('create_flow_from_recipe', { id: 'b2b-reserva-paga', answers: { route: 'VCP → SDU' } }, ctx);
    expect(out.ok).toBe(false);
    expect(out.blockers[0]).toMatch(/Missing answers.*pax/);
    expect(ctx.addCollectionItem).not.toHaveBeenCalled();
  });

  it('partida < 24h: hold tira Order v1/Payments, caminhos já confirmados, MIN_HOURS vem da resposta', async () => {
    const answers = { payment: 'hold (Recomendado)', route: 'VCP → SDU', pax: '1', minHours: '1 hora' };
    const ctx = context(b2bTree());
    const out: any = await executeMcpTool('create_flow_from_recipe', { id: 'b2b-reserva-partida-24h', answers }, ctx);
    expect(out.blockers).toEqual(undefined);
    const names = out.steps.map((s: any) => s.name);
    expect(names).toContain('06 - Order v2');
    expect(names.some((n: string) => /Order v1|Payments/.test(n))).toBe(false);
    const steps = created(ctx).item!;
    const hoje = steps.find(i => i.name === '04 - AirSearch v3 (hoje)')!;
    const amanha = steps.find(i => i.name === '05 - AirSearch v3 (amanhã)')!;
    expect(hoje.request!.scripts!.postResponse).toContain('var MIN_HOURS = 1;');
    expect(hoje.request!.scripts!.postResponse).toContain('"designator.departure"');
    expect(amanha.request!.scripts!.postResponse).toBe(hoje.request!.scripts!.postResponse);
    expect(hoje.request!.scripts!.preRequest).toContain('var DAY_OFFSET = 0;');
    expect(amanha.request!.scripts!.preRequest).toContain('var DAY_OFFSET = 1;');
    expect(JSON.parse(hoje.request!.body!).journeys[0]).toMatchObject({ origin: 'VCP', destination: 'SDU', departure: '{{flowSearchDate}}' });
  });

  it('pós-venda: ação ainda não levantada bloqueia e pede a origem', async () => {
    const ctx = context(b2bTree());
    const out: any = await executeMcpTool(
      'create_flow_from_recipe',
      { id: 'b2b-pos-venda', answers: { route: 'VCP → SDU', pax: '1', action: 'assento' }, dryRun: true },
      ctx
    );
    expect(out.blockers.join(' ')).toMatch(/The source of "<ação>[^"]*" depends on a choice the recipe does not resolve/);
    expect(out.plan.some((s: any) => /Delete Journey/.test(s.name))).toBe(false);
  });
});

describe('create_flow_from_recipe — Grupos', () => {
  function gruposTree(): CollectionItem[] {
    return [
      folder('Portal De Grupos - APIs', [
        req('Gerar token MSAL', '', { method: 'GET', auth: { type: 'oauth2', oauth2: [{ key: 'clientSecret', value: 'segredo', enabled: true }] } }),
        folder('Quote.Groups', [folder('v1', [req('POST Quote', '{{urlGroupsQuoteApi}}/api/v1/quote', { body: '{}' })])]),
        folder('Shopping.Groups', [req('AirSearch (AzulCorp)', '{{urlGroupsShoppingApi}}/api/v1/airSearch')]),
        folder('Order.Groups', [
          req('Post Order', '{{urlOrderGroupsApi}}/api/v1/order'),
          req('Checkout', '{{urlOrderGroupsApi}}/api/v1/groups/order/checkout'),
        ]),
      ]),
      folder('Method Flows Grupos - Claude', [folder('Flow 07 - Cotação até checkout', [])]),
    ];
  }

  it('auth msal pelo caminho, rota e pax nos scripts e URL do Order.Groups trocada', async () => {
    const ctx = context(gruposTree());
    const out: any = await executeMcpTool(
      'create_flow_from_recipe',
      {
        id: 'grupos-cotacao-pedido',
        answers: { auth: 'msal', route: 'SDU → GRU', pax: '12', orderUrl: 'Sim, usar urlOrderGroups (Recomendado)' },
        parentFolderId: 'Method Flows Grupos - Claude',
        environment: '5by5',
      },
      ctx
    );
    expect(out.blockers).toBeUndefined();
    expect(out.name).toMatch(/^Flow 08 - /);
    const steps = created(ctx).item!;
    expect(steps[0].name).toBe('01 - Gerar token MSAL');
    expect(steps[0].request!.auth!.oauth2![0].value).toBe('segredo');
    const quote = steps.find(s => /POST Quote/.test(s.name))!;
    expect(quote.request!.scripts!.preRequest).toContain('pm.environment.set("flowOrigin", "SDU");');
    expect(quote.request!.scripts!.preRequest).toContain('pm.environment.set("flowPaxCount", "12");');
    const order = steps.find(s => /Post Order/.test(s.name))!;
    expect(order.request!.url).toBe('{{urlOrderGroups}}/api/v1/order');
  });
});

describe('regras da receita', () => {
  it('when compara o começo da resposta, palavra inteira', () => {
    expect(evaluateWhen('payment == paga', { payment: 'paga' })).toBe(true);
    expect(evaluateWhen('payment == paga', { payment: 'hold (Recomendado)' })).toBe(false);
    expect(evaluateWhen('payment == paga', { payment: 'pagamento depois' })).toBe(false);
    expect(evaluateWhen('auth != msal', { auth: 'b2b' })).toBe(true);
    expect(evaluateWhen('payment == paga', {})).toBeUndefined();
  });

  it('Flow NN = próximo número livre', () => {
    expect(numberedFlowName('Flow NN - Reserva', ['Flow 01 - A', 'Flow 07 - B', 'Outra'])).toBe('Flow 08 - Reserva');
    expect(numberedFlowName('Flow NN - Reserva', [])).toBe('Flow 01 - Reserva');
  });
});
