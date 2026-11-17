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

  it('sends straight from the browser, leaving out the headers it blocks', async () => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
    const sandbox: Record<string, unknown> = {
      performance: { now: () => 0 },
      fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
        calls.push({ url, init });
        return { status: 201, headers: new Map([['content-type', 'application/json']]), text: async () => '{"id":7}' };
      },
    };
    vm.runInNewContext(assets.runner, Object.assign(sandbox, { globalThis: sandbox }));
    const core = (sandbox as { FlowCore: { runStep: (...a: unknown[]) => Promise<Record<string, unknown>> } }).FlowCore;
    const step = { kind: 'http', method: 'POST', url: '{{base}}/token', headers: { 'User-Agent': 'DevFlowRuntime/1.0.0', 'X-K': '{{k}}' }, body: '{}', preRequest: '', postResponse: '' };

    const out = await core.runStep(step, { base: 'https://general-api-tst.azul.corp', k: 'v' }, { bootstrap: '' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://general-api-tst.azul.corp/token');
    expect(calls[0].init).toMatchObject({ method: 'POST', headers: { 'X-K': 'v' }, body: '{}' });
    expect(out).toMatchObject({ status: 'success', httpStatus: 201, notSentHeaders: ['User-Agent'] });
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
        method: 'POST', time: 120, startedAt: '2026-11-05T12:00:00.000Z',
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
    expect(first.comment).toContain('Tests: 1/1 passed');
    expect(second.response.status).toBe(0);
    expect(second.comment).toContain('Error: blocked');
  });

  it('tells the environment kind from its name', () => {
    const envKind = (loadCore() as { envKind: (n: string) => { id: string } }).envKind;
    expect(['env-prd', 'PROD', 'producao', 'api-prod-br'].map(n => envKind(n).id)).toEqual(['prod', 'prod', 'prod', 'prod']);
    expect(['env-hml', 'stg', 'uat'].map(n => envKind(n).id)).toEqual(['staging', 'staging', 'staging']);
    expect(['env-tst', 'dev', 'qa'].map(n => envKind(n).id)).toEqual(['test', 'test', 'test']);
    // "product" não é produção, e um nome qualquer fica neutro.
    expect(['product-catalog', 'Default'].map(n => envKind(n).id)).toEqual(['other', 'other']);
  });

  it('explains an HTTP error in business terms, with what the API said', () => {
    const describe = (loadCore() as { describeHttpFailure: (s: number, b: string, st: unknown) => { text: string; apiMessage: string } | null }).describeHttpFailure;
    const step = { headers: { 'Ocp-Apim-Subscription-Key': '{{apiKey}}', Accept: 'application/json' } };
    const unauthorized = describe(401, '{"statusCode":401,"message":"Access denied due to invalid subscription key."}', step)!;
    expect(unauthorized.text).toContain('{{apiKey}}');
    expect(unauthorized.apiMessage).toBe('Access denied due to invalid subscription key.');
    expect(describe(400, '{"data":null,"notifications":[{"message":"Invalid PNR"}]}', {})!.apiMessage).toBe('Invalid PNR');
    expect(describe(503, 'not json', {})!.text).toContain('internal error');
    expect(describe(200, '{}', {})).toBeNull();
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

// ── Correções da revisão do HTML runner ───────────────────────────────────

const basicStep = () =>
  buildFlowData(
    flow([req('a', { request: { auth: { type: 'basic', username: '{{user}}', password: '{{pass}}' } as never } })]),
    { path: [], environments: [{ name: 'tst', envMap: { baseUrl: 'https://a', user: 'ana', pass: 'p@ss' } }], includeSecrets: true }
  );

describe('review fixes: export', () => {
  it('keeps basic auth as username and password with their variables', () => {
    const data = basicStep();
    const step = data.steps[0];
    expect(step.basicAuth).toEqual({ username: '{{user}}', password: '{{pass}}' });
    expect(step.headers.Authorization).toBeUndefined();
    expect(data.environments[0].variables.map(v => v.key)).toEqual(['baseUrl', 'pass', 'user']);
  });

  it('turns a literal basic password into a secret variable', () => {
    const data = buildFlowData(
      flow([req('a', { request: { auth: { type: 'basic', username: 'svc', password: 'Sup3rS3cret' } as never } })]),
      { path: [], environments: [{ name: 'tst', envMap: {} }] }
    );
    expect(data.steps[0].basicAuth).toEqual({ username: 'svc', password: '{{password}}' });
    expect(data.environments[0].variables.find(v => v.key === 'password')).toEqual({ key: 'password', value: '', secret: true });
  });

  it('moves a password typed in a JSON body into a secret variable, keeping the formatting', () => {
    const body = '{\n  "user": "ana",\n  "password": "S3nh@\\"Forte",\n  "journeyKey": "ABC123XYZ"\n}';
    const off = buildFlowData(flow([req('a', { request: { bodyType: 'raw', body } as never })]), { path: [], environments: [] });
    expect(off.steps[0].body).toBe('{\n  "user": "ana",\n  "password": "{{password}}",\n  "journeyKey": "ABC123XYZ"\n}');
    expect(off.environments[0].variables.find(v => v.key === 'password')).toEqual({ key: 'password', value: '', secret: true });

    // Com os segredos incluídos, a troca devolve o texto original (escapado).
    const on = buildFlowData(flow([req('a', { request: { bodyType: 'raw', body } as never })]), { path: [], environments: [], includeSecrets: true });
    const core = loadCore() as { substitute: (t: string, e: Record<string, string>) => string };
    const env = Object.fromEntries(on.environments[0].variables.map(v => [v.key, v.value]));
    expect(core.substitute(on.steps[0].body, env)).toBe(body);
  });

  it('moves credentials in a form body and in the query string', () => {
    const data = buildFlowData(
      flow([req('a', { request: { url: 'https://a/x?page=1&apikey=K3y99#top', bodyType: 'urlencoded', body: 'grant_type=password&client_secret=abc%2B1' } as never })]),
      { path: [], environments: [] }
    );
    expect(data.steps[0].url).toBe('https://a/x?page=1&apikey={{apikey}}#top');
    expect(data.steps[0].body).toBe('grant_type=password&client_secret={{clientSecret}}');
  });

  it('names a body password "password" when {{password}} only appears in a comment, and keeps it secret like the apiKey', () => {
    const body = '// {\n//   "password": "{{password}}"\n// }\n{\n  "username": "35890110845",\n  "password": "29181820"\n}';
    const data = buildFlowData(
      flow([req('a', { request: { headers: [{ key: 'Ocp-Apim-Subscription-Key', value: '{{apiKey}}', enabled: true }], bodyType: 'raw', body } as never })]),
      { path: [], environments: [{ name: 'env-prd', envMap: { baseUrl: 'https://a', apiKey: 'abcdef0123456789abcdef0123456789' } }], includeSecrets: true }
    );
    expect(data.steps[0].body).toContain('"password": "{{password}}"');
    const vars = data.environments[0].variables;
    expect(vars.find(v => v.key === 'password')).toEqual({ key: 'password', value: '29181820', secret: true });
    expect(vars.find(v => v.key === 'apiKey')).toMatchObject({ secret: true });
  });

  it('lists the variables a script sets, and treats credential names as secret even when short or empty', () => {
    const data = buildFlowData(
      flow([req('a', { request: {
        body: '{"password":"{{password}}"}', bodyType: 'raw',
        scripts: { preRequest: '', postResponse: 'pm.environment.set("currencyCode", 1);\n// pm.environment.set("journeyKeyIda", 2);' },
      } as never })]),
      { path: [], environments: [{ name: 'tst', envMap: { baseUrl: 'https://a', password: '1234', currencyCode: 'BRL' } }] }
    );
    const vars = data.environments[0].variables;
    expect(vars.map(v => v.key)).toEqual(['baseUrl', 'currencyCode', 'password']);
    expect(vars.find(v => v.key === 'password')).toEqual({ key: 'password', value: '', secret: true });
    expect(vars.find(v => v.key === 'currencyCode')).toEqual({ key: 'currencyCode', value: 'BRL', secret: false });
  });

  it('keeps a URL variable visible even when another environment leaves it empty', () => {
    const data = buildFlowData(
      flow([req('a', { request: { url: '{{urlAuthorization}}/t', headers: [{ key: 'X-Reset', value: '{{passwordResetUrl}}', enabled: true }] } as never })]),
      { path: [], environments: [
        { name: 'env-prd', envMap: { urlAuthorization: 'https://auth', passwordResetUrl: 'https://reset' } },
        { name: 'New Environment', envMap: { urlAuthorization: '', passwordResetUrl: '' } },
      ] }
    );
    expect(data.environments[0].variables).toEqual([
      { key: 'passwordResetUrl', value: 'https://reset', secret: false },
      { key: 'urlAuthorization', value: 'https://auth', secret: false },
    ]);
  });

  it('does not reuse the name of an environment variable for a literal secret', () => {
    const data = buildFlowData(
      flow([req('a', { request: { url: '{{password}}/x', bodyType: 'raw', body: '{"password":"Lit3ral!"}' } as never })]),
      { path: [], environments: [{ name: 'tst', envMap: { password: 'https://env' } }] }
    );
    expect(data.steps[0].body).toBe('{"password":"{{password2}}"}');
  });

  it('lists only real variable reads from scripts, and names with spaces', () => {
    const data = buildFlowData(
      flow([req('a', { request: {
        url: '{{base url}}/x',
        scripts: { preRequest: "pm.environment.get('envVar'); pm.response.headers.get('Content-Type'); map.get('nope');", postResponse: '' },
      } as never })]),
      { path: [], environments: [] }
    );
    expect(data.environments[0].variables.map(v => v.key)).toEqual(['base url', 'envVar']);
  });
});

describe('review fixes: runner', () => {
  type Core = Record<string, (...a: never[]) => unknown>;

  it('builds the basic header from the resolved values, in UTF-8', () => {
    const core = loadCore() as Core;
    const step = basicStep().steps[0];
    const parts = (core.buildParts as (s: unknown, e: Record<string, string>) => { headers: Record<string, string> })(step, { user: 'ana', pass: 'ção' });
    expect(parts.headers.Authorization).toBe(`Basic ${Buffer.from('ana:ção', 'utf8').toString('base64')}`);
    expect((core.utf8Base64 as (t: string) => string)('a')).toBe('YQ==');
  });

  it('fails a step like the DevFlow runner does', () => {
    const isFailure = (loadCore() as Core).isFailure as (o: unknown) => boolean;
    expect(isFailure({ status: 'success', httpStatus: 500, tests: [] })).toBe(true);
    expect(isFailure({ status: 'success', httpStatus: 400, tests: [{ passed: true }] })).toBe(false);
    expect(isFailure({ status: 'success', httpStatus: 200, tests: [], scriptError: 'Post-response script error: x' })).toBe(true);
    expect(isFailure({ status: 'success', httpStatus: 200, tests: [] })).toBe(false);
    expect(isFailure({ status: 'skipped', tests: [] })).toBe(false);
  });

  it('stores only what differs from the file, and ignores stale values from the old format', () => {
    const core = loadCore() as Core;
    const stored = (core.storedOverrides as (e: unknown, d: unknown) => { v: number; values: Record<string, string> })(
      { baseUrl: 'https://a', token: 'T', apiKey: 'typed' },
      { baseUrl: 'https://a', apiKey: '' }
    );
    expect(stored).toEqual({ v: 2, values: { token: 'T', apiKey: 'typed' } });

    const fromStore = core.valuesFromStore as (s: unknown, d: unknown) => Record<string, string>;
    // Arquivo novo com a baseUrl corrigida: vale a do arquivo.
    expect(fromStore(stored, { baseUrl: 'https://new', apiKey: '' })).toEqual({ baseUrl: 'https://new', apiKey: 'typed', token: 'T' });
    // Formato antigo (tudo guardado): só o que o arquivo não trazia ou trazia vazio.
    expect(fromStore({ baseUrl: 'https://old', apiKey: 'typed', token: 'T' }, { baseUrl: 'https://new', apiKey: '' }))
      .toEqual({ baseUrl: 'https://new', apiKey: 'typed', token: 'T' });
  });

  it('recognises binary content types', () => {
    const isBinaryType = (loadCore() as Core).isBinaryType as (t: string) => boolean;
    expect(isBinaryType('image/png')).toBe(true);
    expect(isBinaryType('application/pdf')).toBe(true);
    expect(isBinaryType('application/json; charset=utf-8')).toBe(false);
    expect(isBinaryType('text/plain')).toBe(false);
    expect(isBinaryType('')).toBe(false);
  });

  it('marks a binary response as base64 in the HAR, with its size in bytes', async () => {
    const sandbox: Record<string, unknown> = {
      performance: { now: () => 0 },
      fetch: async () => ({
        status: 200,
        headers: new Map([['content-type', 'image/png']]),
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      }),
    };
    vm.runInNewContext(assets.runner, Object.assign(sandbox, { globalThis: sandbox, Uint8Array }));
    const core = (sandbox as { FlowCore: Record<string, (...a: unknown[]) => unknown> }).FlowCore;
    const step = { id: 's', name: 'img', path: [], kind: 'http', method: 'GET', url: 'https://a/img', headers: {}, body: '', preRequest: '', postResponse: '' };
    const out = (await core.runStep(step, {}, { bootstrap: '' })) as Record<string, unknown>;
    const har = core.buildRunHar({ name: 'F', path: [], steps: [step] }, { s: out }, 'tst') as { log: { entries: { response: { content: Record<string, unknown> } }[] } };
    expect(har.log.entries[0].response.content).toMatchObject({ encoding: 'base64', size: 4, text: 'iVBORw==' });
  });
});
