# Scripting

Every request has two script slots, in the **Scripts** tab of the request
editor:

- **Pre-request** — runs before the call. Use it to compute a value, set a
  variable, or rewrite a header.
- **Post-response** — runs after the response arrives. Use it to extract data
  for the next request, and to assert.

## This is not Node, and not the full Postman API

Scripts run in a **QuickJS sandbox on the Rust side**
(`execute_script_backend` in `src-tauri/src/lib.rs`), with a hand-written `pm`
object injected into the global scope. What that rules out:

- no `pm.sendRequest`
- no `setTimeout`, `setInterval`, `fetch` or `XMLHttpRequest`
- no `require()` except `require('moment')`
- no filesystem, no network, no DOM

The editor knows the API: `src/lib/pmApiTypes.ts` feeds Monaco the type
declarations, so you get autocomplete, signatures and hover docs. **That file
has to stay in sync with the bootstrap in `lib.rs` by hand** — a method added
on one side and not the other is a silent gap.

## Variables

```js
pm.environment.get('baseUrl')        // string | undefined
pm.environment.set('token', value)   // always stored as a string
pm.environment.has('token')          // boolean
pm.environment.unset('token')
```

`pm.variables`, `pm.globals` and `pm.collectionVariables` are **aliases of the
same map**. DevFlow has one variable scope, not Postman's four. A script
written for Postman that relies on globals and environment being separate will
behave differently here.

## The response

Only in post-response scripts.

```js
pm.response.code           // 200
pm.response.status         // alias of code
pm.response.responseTime   // ms
pm.response.text()         // body as a string
pm.response.json()         // parsed; throws if the body is not JSON
pm.response.headers.get('content-type')
pm.response.headers.has('x-request-id')
```

## The request

Readable and writable in both phases.

```js
pm.request.method
pm.request.url
pm.request.body.raw
pm.request.headers.get('authorization')
pm.request.headers.add({ key: 'X-Trace', value: id })
pm.request.headers.upsert({ key: 'X-Trace', value: id })
pm.request.headers.remove('X-Trace')
```

## Tests and assertions

```js
pm.test('status is 200', () => {
  pm.expect(pm.response.code).to.equal(200);
});

pm.test('returns a booking code', () => {
  const body = pm.response.json();
  pm.expect(body).to.have.property('recordLocator');
  pm.expect(body.recordLocator).to.be.a('string');
});
```

A test **passes when the function does not throw**. Results show up in the
**Test Results** tab and in the Collection Runner.

The assertion chain is chai-flavoured. The connecting words — `to`, `be`,
`been`, `is`, `and`, `has`, `have`, `with`, `at`, `of`, `same` — are there to
make the sentence read, and do nothing on their own.

| Assertion | Checks |
|---|---|
| `.equal(x)` / `.eql(x)` | Equality; `eql` is deep |
| `.deep.equal(x)` | Deep equality |
| `.not` | Inverts the next check |
| `.a(type)` / `.an(type)` | `'string'`, `'number'`, `'boolean'`, `'object'`, `'array'`, `'undefined'`, `'function'`, `'null'` |
| `.include(x)` | Containment |
| `.property(name, value?)` | Property exists, optionally equals |
| `.length(n)` / `.lengthOf(n)` | Length |
| `.above(n)` / `.below(n)` | Strict comparison |
| `.least(n)` / `.most(n)` | Inclusive comparison |
| `.match(/regex/)` | Regex |
| `.oneOf([...])` | Membership |
| `.ok` `.true` `.false` `.null` `.undefined` `.exist` `.empty` | Truthiness and presence |

There is also a shorthand on the response:

```js
pm.response.to.have.status(200);
pm.response.to.have.header('content-type');
pm.response.to.have.jsonBody();
pm.response.to.be.ok;
```

## Passing data between requests

This is what post-response scripts are mostly for. Extract in one request,
read in the next:

```js
// post-response of "Login"
const body = pm.response.json();
pm.environment.set('token', body.access_token);
```

```
// header of the next request
Authorization: Bearer {{token}}
```

Inside the **Collection Runner** and the **load test**, each run (and each
virtual user) gets its own copy of the environment, so values set this way do
not leak between runs or between VUs.

## moment.js

Available globally and through `require`:

```js
const tomorrow = moment().add(1, 'day').format('YYYY-MM-DD');
pm.environment.set('departureDate', tomorrow);
```

It is the only module `require()` accepts.

## Legacy globals

Old collections often use the pre-`pm` API. It still works, and the editor
marks each one deprecated:

| Legacy | Prefer |
|---|---|
| `responseBody` | `pm.response.text()` |
| `responseCode.code` | `pm.response.code` |
| `responseHeaders` | `pm.response.headers` |
| `responseTime` | `pm.response.responseTime` |
| `request` | `pm.request` |
| `tests["name"] = cond` | `pm.test(name, fn)` |
| `postman.setEnvironmentVariable(k, v)` | `pm.environment.set(k, v)` |

## Scripts in load tests

The load test runs post-response scripts too, but with a **smaller API**:
variables and response reading only. There is no `pm.test` or `pm.expect`
there — a load test measures, it does not assert. See
[Load testing](LOAD_TESTING.md#correlating-requests-post-response-scripts).

A script error does not abort a load test; it is counted under **Script
errors**, so broken correlation is visible without stopping the run.

## Writing scripts with the agent

If you ask the Claude panel or the CLI to write a script, it should call
`get_script_api` first — that tool returns these same declarations, which is
how it learns that `pm.sendRequest` and `setTimeout` do not exist here. It is
also worth running the request once before asking for assertions, so the agent
writes them against the real response shape.
