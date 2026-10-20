# Architecture

## The two halves

DevFlow is a Tauri 2 desktop app. The frontend is Next.js 16 built in **static
export mode** (`output: 'export'` in `next.config.ts`) and served from inside
the Tauri webview. There is no Node server at runtime and no `/api` routes —
anything the browser cannot do is a Rust command instead.

```
┌─────────────────────────────────────────────────┐
│  Webview (Next.js 16 · React 19 · Tailwind v4)  │
│                                                 │
│  tree · editors · runner · panels · themes      │
└───────────────────────┬─────────────────────────┘
                        │  invoke() / events
┌───────────────────────┴─────────────────────────┐
│  Rust (src-tauri)                               │
│                                                 │
│  HTTP (no CORS)   QuickJS sandbox   gRPC        │
│  load test engine  keyring   local MCP server   │
└─────────────────────────────────────────────────┘
```

### What Rust owns, and why

| Area | File | Why it cannot live in the webview |
|---|---|---|
| Script execution | `src-tauri/src/lib.rs` | Scripts run in a QuickJS sandbox with a hand-written `pm` object. Running them in the webview would give user scripts the app's own DOM and storage. |
| Load test engine | `load_test.rs` | Thousands of concurrent virtual users with per-VU script isolation. JavaScript cannot do this without blocking the UI thread. |
| gRPC | `grpc.rs` | Browsers speak gRPC-Web, not gRPC. Reflection, descriptor sets and bidirectional streaming need a real HTTP/2 client. |
| Secure storage | `secure_storage.rs` | The GitHub token and the MCP token belong in the OS keyring, not in `localStorage`. |
| MCP server | `mcp_server.rs` | A local HTTP listener that the Claude CLI connects to. |
| Claude CLI bridge | `claude_cli.rs` | Spawns and talks to the `claude` binary, including an interactive terminal for login. |
| Extensions | `extensions.rs` | Discovering, scaffolding and reading extension folders from disk. |
| Windows user photo | `user_photo.rs` | Reads the signed-in account picture for the avatar. |

Everything else — tree, editors, diffing, themes, history — is TypeScript.

## The request pipeline

This is the most important design decision in the codebase, and the one most
likely to be broken by a careless change.

**There is exactly one path from "a request" to "an HTTP call":**

```
resolve {{variables}}
  → substitute :path params
  → apply auth (bearer / basic / apikey / oauth2)
  → sanitise the JSON body
  → run the pre-request script
  → send
  → run the post-response script
```

Four callers share it: the **Send** button, the **Collection Runner**, the
**load test** engine and the **MCP tools**. That is why "run this request" from
the Claude panel is not a simulation — it is the same code the button runs.

A change in that path affects all four. Treat it accordingly.

## Default headers

DevFlow sends a set of headers automatically, the same role as Postman's
"hidden headers" (`src/lib/defaultHeaders.ts`):

```
User-Agent: DevFlowRuntime/1.0.0
Accept: */*
Connection: keep-alive
Cache-Control: no-cache
Content-type: application/json     (only when the request has a body)
```

A header you define yourself replaces the default with the same name, case
insensitively. A request can also switch individual defaults off
(`disabledDefaultHeaders`). The Rust load test engine keeps a parallel copy of
these rules in `load_test.rs` — if you change one, change the other.

## Where data lives

Three stores, each chosen for a reason.

### Tauri store files

`%APPDATA%\com.DevFlow.dev\` on Windows, the platform equivalent elsewhere.

| File | Contents |
|---|---|
| `settings.json` | Collections and environments, per workspace, plus app settings |
| `workspaces.json` | The workspace list |
| `open-tabs.json` | Open tabs and tab groups |
| `tab-sessions.json` | Named tab sessions |
| `active-environment.json` | The selected environment per workspace |
| `runner-history.json` | The last Collection Runner run per collection |
| `sync-base.json` | Per-node hashes of the last sync, for three-way merge |

`runner-history.json` and `sync-base.json` have their own files rather than
sharing `settings.json` because they are written on a different rhythm and can
grow large.

### localStorage

A **~5 MiB quota shared by the whole origin**, so it holds only small, losable
things: panel sizes, the selected theme, which tree nodes are expanded, tab
drafts, the error log, and the last five responses per request.

That last one used to be unbounded and filled the quota, which then made
unrelated writes throw `QuotaExceededError`. It is now capped per entry and
budgeted globally — see `src/lib/safeStorage.ts`. **Anything that must survive
reliably belongs in a Tauri store file, not here.**

### OS keyring

The GitHub token and the MCP server token. Never in `localStorage`, never in a
store file.

## Storage keys are a contract

A key name in `localStorage`, a Tauri store file or the keyring is a contract
with data already written on someone's machine. Renaming one does not rename
what is on disk — it only makes the read come back empty. If a key has to
change, migrate it; `src/storage/pendingPushStore.ts` is the worked example.

## Sync encryption

What goes to GitHub is encrypted with a passphrase the user holds
(`src/lib/syncCrypto.ts`). The format is versioned (`DFv2:`), and the previous
key is still there **for reading only** — removing it would make everything
synced by older versions unreadable.

## Code map

| Area | Where |
|---|---|
| App shell, tabs, send pipeline | `src/components/AppLayout.tsx` |
| Collection tree | `src/components/collection-tree/` |
| Request editors | `src/components/RequestEditor.tsx`, `HttpBodyEditor.tsx`, `HeadersManager.tsx` |
| Collection Runner | `src/components/CollectionRunner/` |
| Load test UI | `src/components/LoadTest/` |
| gRPC UI | `src/components/Grpc/` |
| GitHub sync | `src/components/GitHubStorageClient.tsx`, `src/components/SyncDiff/` |
| Diff and merge logic | `src/lib/collectionDiff.ts`, `diffSelection.ts`, `applyDiff.ts`, `syncBase.ts`, `canonicalCompare.ts` |
| Claude panel | `src/claude/` |
| MCP tools | `src/mcp/mcpTools.ts` |
| Extensions | `src/extensions/` |
| Pure logic with tests | `src/lib/*.ts` with `*.test.ts` beside them |

## Testing strategy

Pure modules — no UI, no Tauri — are where the subtle decisions live, and they
are testable without starting the app. Those are the ones with suites beside
them. `CONTRIBUTING.md` lists each one and what its tests protect.

Run them with `npm test` (vitest). The whole suite finishes in a few seconds.
