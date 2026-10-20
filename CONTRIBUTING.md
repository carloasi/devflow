# Contributing to DevFlow

## Environment

```bash
npm ci
npx tauri dev
```

You need Node 20+, the Rust toolchain and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/).

## What CI requires

A PR has to pass four gates, the same ones you can run locally:

```bash
npx tsc --noEmit -p tsconfig.json     # types
npx eslint src --ext .ts,.tsx         # lint
npm test                              # tests (vitest)
cd src-tauri && cargo check           # Rust
```

While developing, `npm run test:watch` re-runs only what you touched.

`cargo check` runs on **Linux and Windows** in CI. That is not fussiness: there
are `#[cfg(windows)]` and `#[cfg(not(windows))]` blocks in the code, and the
compiler only sees the branch for the platform it is running on. If you touch
anything conditional, wait for both results.

### About lint

The project currently carries ~325 inherited **warnings** (`any` typing, React
Compiler rules). They are tolerated on purpose: treating them as errors would
leave the build permanently red, and a CI that is always red tells you nothing.

The deal is simple: **do not grow the count.** New code should not introduce
warnings, and reducing existing ones while you are nearby is welcome.

The rules that remain **errors** are listed with their rationale in
[eslint.config.mjs](eslint.config.mjs) — all of them catch real defects, not
style preferences.

## Code style

**Comments explain why, not what.** The code already says what it does. What
gets lost over time is the reason: the constraint that led to that choice, the
bug that motivated that guard, the path that was tried and did not work. The
project is written this way, and it is what makes a file editable six months
later.

Comments are in Portuguese; documentation is in English. Match whichever file
you are in.

**Do not leave commented-out code.** Git history keeps the previous version.
This repository once carried ~4,400 lines of dead commented code, removed
precisely because they made the files unreadable.

**Test pure logic.** Modules with no UI and no Tauri dependency are where the
subtle decisions live, and they are testable without starting the app. The ones
that already have a suite (`*.test.ts` beside the module):

| Module | What the test protects |
|---|---|
| `src/lib/syncCrypto.ts` | that already-synced content stays readable after a key change |
| `src/lib/codeSnippets.ts` | the escaping per language — cURL is validated by undoing the shell quoting |
| `src/lib/openapiParser.ts` | `$ref`, recursive schemas, `allOf`, and both spec versions |
| `src/components/collection-tree/utils/tree.utils.ts` | moving, refusing cycles, projecting the drop level, and the star/unstar pair |
| `src/lib/junitReport.ts` | that the report XML stays well-formed even with `<`, `&` or a control byte from the response |
| `src/components/CollectionRunner/runHistory.ts` | that a large run degrades until it fits the quota, instead of blowing it and killing other features' writes |
| `src/mcp/duplicateRequest.ts` | that the copy carries the secret the read masks, and that no id is reused between original and copy |
| `src/lib/envMap.ts` | which entry wins when the same key is enabled twice — reads and writes must pick the same one |
| `src/components/CollectionRunner/runVerdict.ts` | that the assertion decides the verdict — an expected 400 passes, and a network error is not covered up by a passing test |
| `src/storage/pendingPushStore.ts` | that the old format (a workspace list) migrates without losing the pending-change warning |
| `src/lib/collectionFingerprint.ts` | that only a genuinely touched collection is marked, and that starring does not mark one on its own |
| `src/lib/remoteComparison.ts` | separating "changed on GitHub" from "only exists there" and "only exists here", with the same fingerprint rule as the push |
| `src/lib/collectionDiff.ts` | matching nodes by id with name as a fallback, and keeping the change on the node that changed instead of propagating to ancestors |
| `src/lib/canonicalCompare.ts` | what counts as the same thing when comparing with GitHub — and, just as important, what stays a difference |
| `src/lib/syncBase.ts` | telling apart who moved in a three-way comparison, and that a folder does not change when a child does |
| `src/lib/diffSelection.ts` | which choices discard unpushed local work, why a conflicting node starts unselected, and that a bulk action never reaches rows hidden by a filter |
| `src/lib/diffList.ts` | the label and folder grouping of the diff list, and that the filter matches the whole path |
| `src/lib/entryDiff.ts` | per-entry comparison of headers and variables: matching by key, repeated keys by occurrence, and that `enabled` is content |
| `src/lib/applyDiff.ts` | merging only what was chosen: new item position, id and star preserved, and refusing the folder without discarding what was accepted inside |
| `src/lib/environmentDiff.ts` | matching a variable by key (the pull regenerates ids) and preserving the disabled duplicate when applying |
| `src/lib/diffFields.ts` | where each editable field lives on the node, and that invalid JSON becomes an error instead of entering the request |
| `src/lib/safeStorage.ts` | that a full quota returns false instead of throwing, and which keys the startup sweep may remove |
| `src/storage/responseHistoryStore.ts` | that an oversized body becomes an explicit marker rather than truncated, invalid JSON |
| `src/lib/variableHistory.ts` | that a blank value does not enter the history, and that malformed `localStorage` content does not break the read |
| `src/lib/avatarImage.ts` | the centred square crop and refusing a non-image file before decoding |
| `src/lib/avatarPresets.ts` | that each avatar generates well-formed SVG with enough contrast, and that generation is deterministic (selection depends on it) |
| `src/lib/tabGroups.ts` | the contiguity of a group's tabs — grouping distant tabs without swallowing what is between them, and what happens on drag |
| `src/lib/dragWindow.ts` | that dragging a modal never takes it off screen, where there would be no way to bring it back |

When you touch one of these, run `npm test` before opening the PR — they are
fast, under two seconds in total.

## Rendering is not optional

Passing tests are not proof that a UI change works. The avatar work in this
repository passed its whole suite while being visibly broken twice: once
because SVG path *data* was injected as text inside a `<g>` (valid SVG,
invisible drawing), and once because a sweep flag was inverted.

If you change something visual, render it and look at it.

## Sensitive areas

**`src/lib/syncCrypto.ts`** — encryption of what goes to GitHub. The format is
versioned (`DFv2:`), and the old key is kept **read-only**: removing it would
make everything synced by earlier versions unreadable.

**Storage keys** (`localStorage`, Tauri store, keyring) are a contract with
data already written on a user's machine. Renaming one without a migration does
not rename what is on disk — it only makes the read come back empty.

**The request execution path** is shared by Send, the runner, the load test and
the MCP tools. A change there affects all four.

**`localStorage` is a ~5 MiB quota for the whole app.** Anything that grows
with usage needs a budget, and any write that can fail needs
`safeSetItem` — an unguarded `setItem` throwing takes the window down. See
[Architecture](docs/ARCHITECTURE.md#where-data-lives).

**`src/lib/pmApiTypes.ts` mirrors the script bootstrap in `lib.rs` by hand.**
A method added to one and not the other is a silent gap between what the editor
promises and what the sandbox provides.
