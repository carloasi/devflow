# Collection Runner

Runs a folder as an ordered flow: every request in it, in tree order, sharing
one environment copy so each step can hand data to the next.

## Opening it

Right-click a folder in the tree → **Run**. The panel opens over the app.

It is a **non-modal** window on purpose: the rest of the app stays live, so you
can keep the Claude panel open beside it, or go look at a request while a run
is finished on screen. Drag it by the header, double-click the header to
recentre. It closes only on the **X** or **Esc** — a click outside is almost
always "let me look at something else", not "throw this away".

## Options

| Option | What it does |
|---|---|
| **Environment** | Which environment seeds the run. Each run gets its own copy. |
| **Iterations** | Run the whole flow N times. |
| **Delay** | Milliseconds to wait between requests. |
| **Stop** | Interrupts the run; what already ran is kept. |

## What each step shows

Click a row to expand it:

- **Response body** — the real response, not a summary
- **Request payload and URL** — what was actually sent, after variable
  resolution
- **The variables it used** — editable right there, so you can fix a value and
  re-run without hunting for the environment panel
- **Assertions** — each `pm.test` with its result

Variable references render as chips. Click one to edit it.

## What counts as a failure

The assertion decides, not the status code (`runVerdict.ts`).

- A request that returns **400 with a passing assertion is a pass**. If the
  test says `pm.expect(pm.response.code).to.equal(400)`, that is the expected
  behaviour of a negative test case, and the runner reports it as such.
- A **network error is a failure** even if some test happened to pass — a
  connection that never completed cannot be covered up by an assertion that
  ran on nothing.

## Token steps

A request with **OAuth 2.0** auth and an **empty URL** is not broken — it is
how the app stores an OAuth2 configuration. The runner treats it as *get a
token*, not *send a request*:

- it reuses the token already in the variable while more than **5 minutes** of
  validity remain
- it opens the login window only when a refresh is actually needed
- the token goes into that run's environment copy, so later steps find it

Without this the flow would stop at the first token step with "empty URL".

## Reading the last run again

The run is saved per collection (`runner-history.json`), so **closing the panel
does not lose it**. Reopen the runner and the last result is there, with bodies
and assertions.

Storage is budgeted rather than unbounded (`runHistory.ts`): bodies are capped
at 2 MB each and the whole record at 20 MB, degrading in steps — first large
bodies, then all bodies, then older entries — so one enormous run cannot
displace everything else.

The MCP tool `get_last_run` reads the same record. That is how the Claude agent
can answer "what broke in that run?" without asking you to run it again — a
request executed by the runner does not open a tab, so `get_response` would not
find it.

## Exporting results

**JUnit XML**, which is the format CI systems read natively — GitHub Actions,
GitLab, Jenkins, Azure DevOps. Without it, a run inside a pipeline can only say
"passed" or "failed" in text, and nobody sees which assertion broke without
opening the log.

The generator (`src/lib/junitReport.ts`) is a pure module with its own tests,
including that the XML stays well-formed when a response body contains `<`,
`&` or a control byte.

## Running it from the agent

`run_collection` goes through the same path as the button — same variable
resolution, same auth, same scripts. See [Claude agent](CLAUDE_AGENT.md).
