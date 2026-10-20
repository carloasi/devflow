# Load testing

DevFlow has a built-in load test engine — no k6, no JMeter. It runs in the
app's Rust backend with multiple virtual users (VUs) in parallel, from a single
request up to a multi-step flow with data correlated between steps.

## Opening it

Right-click a **request** or a **folder** in the tree and choose **Load Test**.
A folder runs the **whole flow** — every request in it, in tree order, the same
order the Collection Runner uses.

## Execution modes

Chosen at the top of the panel:

- **Duration** — a fixed number of concurrent VUs, looping, for a set number of
  seconds.
- **Iterations/VU** — a fixed number of VUs, each running a fixed number of
  iterations of the flow, then stopping.
- **Ramp (stages)** — a sequence of stages, each one a target VU count and how
  long to hold or climb to it. For gradual ramp-up, a plateau and ramp-down.
  Stage VUs and duration are editable; adding, removing and reordering stages
  is not supported yet.

Engine limits: **2,000 VUs**, **3,600 s** per run, **100,000 iterations per
VU**, **20 ramp stages**, **30 requests** in a flow, **10 thresholds**.

## Environment

The **Environment** selector picks which environment provides the `{{...}}`
values used in URLs, headers, bodies and auth. **Each VU gets its own copy** at
the start of the run — variables never leak between VUs.

## Correlating requests (post-response scripts)

When the target is a flow with more than one request, each request can have a
**post-response script** — the same Scripts tab as normal use. It runs after
the response arrives, inside that VU, and can read the response and write to
that VU's environment for the following steps. Extracting a login token and
using it as a bearer token in the next request is the typical case.

The API inside the sandbox (QuickJS, isolated per VU) is deliberately small —
correlation only:

```js
pm.environment.get('key')
pm.environment.set('key', value)
pm.environment.has('key')
pm.environment.unset('key')
// pm.variables, pm.globals and pm.collectionVariables are aliases of the same map

pm.response.code        // HTTP status (number)
pm.response.status      // alias
pm.response.responseTime
pm.response.text()      // body as a string
pm.response.json()      // body parsed as JSON
pm.response.headers.get('header-name')
pm.response.headers.has('header-name')
```

**There is no `pm.test` or `pm.expect` here** — those exist in normal sends and
in the Collection Runner. A load test measures; it does not assert.

A script error does **not** abort the run. It is counted under **Script
errors** in the summary, so broken correlation is visible without stopping the
load.

## Authentication

Each request in the flow carries its own auth type — `none`, `bearer`, `basic`
or `apikey` — resolved against that VU's environment before every call.

## Thresholds

Click **Thresholds** to set pass/fail criteria for the run. Each one is
`metric` + `operator` + `value`:

- Metrics: `p50`, `p90`, `p95`, `p99`, `avg`, `min`, `max` (all in ms),
  `errorRate` (%), `rps` (requests/second)
- Operators: `<`, `<=`, `>`, `>=`

Example: `p95 < 500` fails the run if the 95th percentile latency goes above
500 ms. Each threshold's result — pass/fail plus the measured value — appears
in the summary, the history and the PDF report.

## Metrics

Live during the run and in the final summary:

- Total, successful and failed requests
- Current RPS (live) and average RPS (summary)
- Latency: min, avg, p50, p90, p95, p99, max (ms)
- Breakdown by status code, including `error` for network failures and timeouts
- Script error count
- Active VUs (live)

Three real-time charts show RPS, latency (avg/p95/p99) and — in Ramp mode —
active VUs over time.

## Timeout

Each individual request has a **30 second** timeout by default. It is
configurable through `timeoutSecs` in the config, though the UI does not expose
the field yet.

## Run history

Every completed run — or one you stopped manually — is saved against that
request or folder, with timestamp, mode, the config used and the metric
summary. Reach it through **History** at the top of the panel.

From there you can:

- **View** an old run — the aggregate metrics, but not the time-series charts.
  Only the final summary is persisted, not the full series.
- **Export** as JSON or as a **PDF report**
- **Delete** a record

Up to **20 records** per item are kept; older ones are dropped automatically.

## Exporting a report

With a finished live run or a history entry open, the **JSON** and **PDF**
buttons at the top export it:

- **JSON** — the complete record (config + summary), for reprocessing or
  versioning.
- **PDF** — a formatted report: header, summary (requests, RPS, error rate,
  script errors), latency table, thresholds with coloured pass/fail, status
  code breakdown and the list of requests in the flow. Ready to share with the
  team or attach as test evidence.

## Stopping a run

**Stop** interrupts immediately — VUs mid-iteration finish the current one and
stop. The partial summary up to that point is saved to history normally.

## Running one from the agent

`run_load_test` exposes the same engine over MCP, blocking until the run
finishes and returning the final metrics. See [Claude agent](CLAUDE_AGENT.md).

## Where the code is

| Piece | File |
|---|---|
| Engine (Rust, VUs + QuickJS) | `src-tauri/src/load_test.rs` |
| Shared types (TS) | `src/components/LoadTest/types.ts` |
| Main panel | `src/components/LoadTest/LoadTestPanel.tsx` |
| Collection → flow conversion | `src/components/LoadTest/buildFlowSteps.ts` |
| History persistence | `src/components/LoadTest/loadTestHistory.ts` |
| PDF report | `src/components/LoadTest/loadTestPdfReport.ts` |
