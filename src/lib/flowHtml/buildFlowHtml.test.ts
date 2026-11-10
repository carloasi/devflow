import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { buildFlowData, renderFlowHtml } from './buildFlowHtml';

const runtimeDir = resolve(__dirname, '../../../public/runtime');
const assets = {
  bootstrap: readFileSync(resolve(runtimeDir, 'pm-bootstrap.js'), 'utf8'),
  moment: readFileSync(resolve(runtimeDir, 'moment.min.js'), 'utf8'),
  runner: readFileSync(resolve(runtimeDir, 'flow-runner.js'), 'utf8'),
};

type RequestPatch = Omit<Partial<CollectionItem>, 'request'> & { request?: Partial<NonNullable<CollectionItem['request']>> };

const req = (id: string, patch: RequestPatch = {}): CollectionItem => ({
  id,
  name: `Step ${id}`,
  type: 'request',
  method: 'POST',
  ...patch,
  request: {
    url: '{{baseUrl}}/api/v1/airSearch',
    urlexport: { host: [], path: [], raw: '' },
    headers: [],
    body: '',
    ...(patch.request ?? {}),
  },
});

const flow = (children: CollectionItem[]): CollectionItem =>
  ({ id: 'flow', name: 'Flow 04', type: 'folder', item: children }) as CollectionItem;

describe('buildFlowData', () => {
  it('keeps the steps in tree order, with the folders between them', () => {
    const data = buildFlowData(
      flow([req('a'), { id: 'sub', name: 'Booking', type: 'folder', item: [req('b')] } as CollectionItem]),
      { path: ['Sprints', 'Flow 04'], environments: [{ name: 'tst', envMap: {} }] }
    );
    expect(data.steps.map(s => [s.id, s.path])).toEqual([['a', []], ['b', ['Booking']]]);
  });

  it('builds headers like the Runner but keeps {{placeholders}}', () => {
    const data = buildFlowData(
      flow([req('a', {
        request: {
          body: '{ "a": 1, // comment\n }',
          headers: [{ key: 'Ocp-Apim-Subscription-Key', value: '{{apiKey}}', enabled: true }],
          auth: { type: 'bearer', token: '{{bearerToken}}' } as never,
        },
      })]),
      { path: [], environments: [{ name: 'tst', envMap: { baseUrl: 'https://tst', apiKey: 'k', bearerToken: 'eyJxxxxxxxxxx' } }] }
    );
    const step = data.steps[0];
    expect(step.headers['Authorization']).toBe('Bearer {{bearerToken}}');
    expect(step.headers['Ocp-Apim-Subscription-Key']).toBe('{{apiKey}}');
    expect(step.body.replace(/\s/g, '')).toBe('{"a":1}');
    expect(data.environments[0].variables.map(v => v.key)).toEqual(['apiKey', 'baseUrl', 'bearerToken']);
  });

  it('never writes secrets into the file', () => {
    const data = buildFlowData(
      flow([req('a', {
        request: { headers: [{ key: 'Ocp-Apim-Subscription-Key', value: 'eb01e13724814a939b13de8d560ee222', enabled: true }] },
      })]),
      { path: [], environments: [{ name: 'tst', envMap: { baseUrl: 'https://tst', bearerToken: 'eyJhbGciOiJIUzI1NiJ9.abc' } }] }
    );
    const html = renderFlowHtml(data, assets);
    expect(html).not.toContain('eb01e13724814a939b13de8d560ee222');
    expect(data.steps[0].headers['Ocp-Apim-Subscription-Key']).toMatch(/^\{\{\w+\}\}$/);
    expect(data.environments[0].variables.find(v => v.secret)?.value).toBe('');
  });

  it('includes the secret values only when asked to', () => {
    const folder = flow([req('a', {
      request: { headers: [{ key: 'Ocp-Apim-Subscription-Key', value: 'eb01e13724814a939b13de8d560ee222', enabled: true }],
        auth: { type: 'bearer', token: '{{bearerToken}}' } as never },
    })]);
    const options = { path: [], environments: [{ name: 'tst', envMap: { baseUrl: 'https://tst', bearerToken: 'eyJhbGciOiJIUzI1NiJ9.abc' } }] };

    const withSecrets = buildFlowData(folder, { ...options, includeSecrets: true });
    expect(withSecrets.includesSecrets).toBe(true);
    expect(withSecrets.environments[0].variables.filter(v => v.secret).map(v => v.value).sort()).toEqual(
      ['eb01e13724814a939b13de8d560ee222', 'eyJhbGciOiJIUzI1NiJ9.abc']
    );
    expect(renderFlowHtml(withSecrets, assets)).toContain('eb01e13724814a939b13de8d560ee222');

    const without = buildFlowData(folder, options);
    expect(without.includesSecrets).toBe(false);
    expect(without.environments[0].variables.filter(v => v.secret).every(v => v.value === '')).toBe(true);
  });

  it('carries every chosen environment, each with its own values', () => {
    const data = buildFlowData(flow([req('a', { request: { headers: [{ key: 'Ocp-Apim-Subscription-Key', value: '{{apiKey}}', enabled: true }] } })]), {
      path: [],
      environments: [
        { name: 'tst-internal', envMap: { baseUrl: 'https://general-api-tst.azul.corp', apiKey: 'internal-key-123' } },
        { name: 'tst-public', envMap: { baseUrl: 'https://general-api-tst.voeazul.com.br', apiKey: 'public-key-456' } },
      ],
      defaultEnvironment: 'tst-public',
    });
    expect(data.defaultEnvironment).toBe('tst-public');
    const baseUrls = data.environments.map(e => [e.name, e.variables.find(v => v.key === 'baseUrl')?.value]);
    expect(baseUrls).toEqual([
      ['tst-internal', 'https://general-api-tst.azul.corp'],
      ['tst-public', 'https://general-api-tst.voeazul.com.br'],
    ]);
    // apiKey é secreta nos dois — e sem includeSecrets, vazia nos dois.
    expect(data.environments.map(e => e.variables.find(v => v.key === 'apiKey'))).toEqual([
      { key: 'apiKey', value: '', secret: true },
      { key: 'apiKey', value: '', secret: true },
    ]);
  });

  it('opens with an empty "No environment" when none is chosen', () => {
    const data = buildFlowData(flow([req('a')]), { path: [], environments: [] });
    expect(data.environments.map(e => e.name)).toEqual(['No environment']);
    expect(data.defaultEnvironment).toBe('No environment');
  });

  it('keeps URL variables even when the name looks like a credential', () => {
    const data = buildFlowData(
      flow([req('a', { request: { url: '{{urlAuthorization}}/api/v1/token' } })]),
      { path: [], environments: [{ name: 'tst', envMap: { urlAuthorization: 'https://auth-tst.voeazul.com.br' } }] }
    );
    expect(data.environments[0].variables).toEqual([{ key: 'urlAuthorization', value: 'https://auth-tst.voeazul.com.br', secret: false }]);
  });

  it('marks OAuth token steps and gRPC requests', () => {
    const data = buildFlowData(
      flow([
        req('t', { request: { url: '', auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: '{{msal}}', enabled: true }] } as never } }),
        { ...req('g'), protocol: 'grpc' } as CollectionItem,
      ]),
      { path: [], environments: [{ name: 'tst', envMap: {} }] }
    );
    expect(data.steps.map(s => [s.kind, s.tokenVariable])).toEqual([['token', 'msal'], ['grpc', undefined]]);
  });

  it('embeds moment only when a script uses it', () => {
    const withMoment = buildFlowData(flow([req('a', { request: { scripts: { preRequest: 'moment()', postResponse: '' } } })]), { path: [], environments: [{ name: 'tst', envMap: {} }] });
    const without = buildFlowData(flow([req('a')]), { path: [], environments: [{ name: 'tst', envMap: {} }] });
    expect(renderFlowHtml(withMoment, assets).length - renderFlowHtml(without, assets).length).toBeGreaterThan(100_000);
  });

  it('cannot break out of the data script tag', () => {
    const data = buildFlowData(flow([req('a', { request: { body: '"</script><script>alert(1)</script>"' } })]), { path: [], environments: [{ name: 'tst', envMap: {} }] });
    const html = renderFlowHtml(data, assets);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });
});

// O motor do HTML, fora do navegador: o código do Worker roda num contexto
// isolado do node (vm) com o MESMO pm-bootstrap.js do DevFlow.
function loadCore() {
  const sandbox: Record<string, unknown> = {};
  vm.runInNewContext(assets.runner, { globalThis: sandbox, window: undefined, ...sandbox });
  return (sandbox as { FlowCore?: Record<string, unknown> }).FlowCore ?? (vm.runInNewContext(`${assets.runner}; FlowCore`, {}) as Record<string, unknown>);
}

function runInWorker(script: string, ctx: Record<string, unknown>, withMoment = false): Promise<Record<string, unknown>> {
  const core = loadCore() as { workerMain: () => void };
  return new Promise(resolvePromise => {
    const self: Record<string, unknown> = {};
    self.postMessage = (msg: Record<string, unknown>) => resolvePromise(msg);
    const context = vm.createContext({ self, JSON, Object, String, Error });
    // Worker: o global É o self.
    vm.runInContext('self = this; ' + `(${core.workerMain.toString()})()`, Object.assign(context, { self: context }));
    (context as unknown as { postMessage: unknown }).postMessage = (msg: Record<string, unknown>) => resolvePromise(msg);
    (context as unknown as { onmessage: (e: unknown) => void }).onmessage({
      data: { bootstrap: assets.bootstrap, moment: withMoment ? assets.moment : null, script, ctx },
    });
  });
}

describe('flow-runner core', () => {
  it('substitutes variables like the Runner', () => {
    const core = loadCore() as { substitute: (t: string, e: Record<string, string>) => string };
    expect(core.substitute('{{a}}/{{ b }}/{{missing}}', { a: '1', b: '' })).toBe('1//{{missing}}');
  });

  it('leaves out the headers a browser cannot send', () => {
    const core = loadCore() as { splitForbidden: (h: Record<string, string>) => { allowed: Record<string, string>; dropped: string[] } };
    expect(core.splitForbidden({ 'User-Agent': 'x', Connection: 'keep-alive', Accept: '*/*', 'Ocp-Apim-Subscription-Key': 'k' })).toEqual({
      allowed: { Accept: '*/*', 'Ocp-Apim-Subscription-Key': 'k' },
      dropped: ['User-Agent', 'Connection'],
    });
  });

  it('reads the DevFlow connection code', () => {
    const core = loadCore() as { parseConnectionCode: (c: string) => unknown };
    const key = 'a'.repeat(48);
    expect(core.parseConnectionCode(` devflow-relay://127.0.0.1:47821/${key} `)).toEqual({ base: 'http://127.0.0.1:47821', key });
    // Só endereço local: o código nunca manda a página falar com outra máquina.
    expect(core.parseConnectionCode(`devflow-relay://evil.example:80/${key}`)).toBeNull();
    expect(core.parseConnectionCode('whatever')).toBeNull();
  });

  it('sends through the DevFlow relay with every header, including the ones browsers block', async () => {
    const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const sandbox: Record<string, unknown> = {
      performance: { now: () => 0 },
      fetch: async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ status: 201, headers: { a: '1' }, body: '{"id":7}', timeMs: 42 }) };
      },
    };
    vm.runInNewContext(assets.runner, Object.assign(sandbox, { globalThis: sandbox }));
    const core = (sandbox as { FlowCore: { runStep: (...a: unknown[]) => Promise<Record<string, unknown>> } }).FlowCore;
    const step = { kind: 'http', method: 'POST', url: '{{base}}/token', headers: { 'User-Agent': 'DevFlowRuntime/1.0.0', 'X-K': '{{k}}' }, body: '{}', preRequest: '', postResponse: '' };

    const out = await core.runStep(step, { base: 'https://general-api-tst.azul.corp', k: 'v' }, { bootstrap: '' }, { base: 'http://127.0.0.1:47821', key: 'K' });

    expect(calls[0].url).toBe('http://127.0.0.1:47821/relay');
    expect(calls[0].init.headers['X-DevFlow-Relay-Key']).toBe('K');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      method: 'POST', url: 'https://general-api-tst.azul.corp/token',
      headers: { 'User-Agent': 'DevFlowRuntime/1.0.0', 'X-K': 'v' }, body: '{}',
    });
    expect(out).toMatchObject({ status: 'success', httpStatus: 201, time: 42, via: 'DevFlow' });
  });

  it('turns a run into a HAR with what was sent and received', () => {
    const core = loadCore() as { buildRunHar: (f: unknown, r: unknown, e: string) => { log: { entries: Record<string, any>[] } } };
    const flowData = {
      name: 'Flow 106', path: ['Sprints', 'Flow 106'],
      steps: [
        { id: 'a', name: '01 - Token', path: [] },
        { id: 'b', name: '02 - Not run', path: [] },
        { id: 'c', name: '03 - Blocked', path: ['Sub'] },
      ],
    };
    const results = {
      a: {
        method: 'POST', time: 120, startedAt: '2026-11-05T12:00:00.000Z', via: 'DevFlow',
        sent: { url: 'https://x/token?scope=b2b', headers: { 'Content-Type': 'application/json' }, body: '{"u":1}' },
        response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"token":"T"}' },
        tests: [{ name: 'ok', passed: true }],
      },
      c: { method: 'GET', time: 5, sent: { url: 'https://y/z', headers: {}, body: '' }, response: null, tests: [], errorMessage: 'blocked' },
    };

    const har = core.buildRunHar(flowData, results, 'tst');
    expect(har.log.entries).toHaveLength(2);
    const [first, second] = har.log.entries;
    expect(first.request).toMatchObject({ method: 'POST', url: 'https://x/token?scope=b2b', postData: { mimeType: 'application/json', text: '{"u":1}' } });
    expect(first.request.queryString).toEqual([{ name: 'scope', value: 'b2b' }]);
    expect(first.response).toMatchObject({ status: 200, content: { mimeType: 'application/json', text: '{"token":"T"}' } });
    expect(first.comment).toContain('Sent through DevFlow.');
    expect(second.response.status).toBe(0);
    expect(second.comment).toContain('Error: blocked');
  });

  it('names the empty variables of an incomplete URL', () => {
    const core = loadCore() as { emptyUrlVariables: (t: string, e: Record<string, string>) => string[] };
    expect(core.emptyUrlVariables('{{urlAuthorization}}/api/{{v}}/token', { urlAuthorization: '', v: '1' })).toEqual(['urlAuthorization']);
  });

  it('runs a post-response script with the DevFlow pm runtime', async () => {
    const result = await runInWorker(
      `pm.test("status 200", () => pm.response.to.have.status(200));
       const json = pm.response.json();
       pm.environment.set("bearerToken", json.data.token);
       tests["legacy"] = responseCode.code === 200;`,
      {
        env: { a: '1' },
        request: { method: 'POST', url: 'u', headers: {}, body: '' },
        response: { status: 200, headers: { 'Content-Type': 'application/json' } },
        responseBody: '{"data":{"token":"T"}}',
      }
    );
    expect(result.env).toEqual({ a: '1', bearerToken: 'T' });
    expect(result.tests).toEqual([
      { name: 'status 200', passed: true, message: '' },
      { name: 'legacy', passed: true, message: '' },
    ]);
    expect(result.scriptError).toBeNull();
  });

  it('lets a pre-request script change the body and use moment', async () => {
    const result = await runInWorker(
      `const moment = require('moment');
       const body = JSON.parse(pm.request.body.raw);
       body.when = moment('2026-01-01').add(1, 'days').format('YYYY-MM-DD');
       pm.request.body.update(JSON.stringify(body));`,
      { env: {}, request: { method: 'POST', url: 'u', headers: {}, body: '{"a":1}' }, response: null },
      true
    );
    expect(JSON.parse((result.request as { body: string }).body)).toEqual({ a: 1, when: '2026-01-02' });
  });

  it('reports a script error with its type', async () => {
    const result = await runInWorker('undefinedThing.x', { env: {}, request: { method: 'GET', url: 'u', headers: {}, body: '' } });
    expect(result.scriptError).toMatch(/^ReferenceError: /);
  });
});
