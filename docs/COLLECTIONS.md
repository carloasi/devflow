# Collections & environments

## Workspaces

A workspace is an isolated set of collections and environments. Switching
workspaces swaps the tree, the environment list and the GitHub sync target.
They are listed in `workspaces.json`; the contents live in `settings.json`
under one key per workspace.

Use them to keep unrelated projects apart, or the same project across
different backends.

## The tree

Three node types:

- **Folder** — groups requests. Also the unit the Collection Runner and the
  load test execute as a flow, in tree order.
- **Request** — HTTP or gRPC.
- **Example** — a saved response attached to a request. Postman keeps these in
  `item.response[]`; DevFlow stores them as child nodes of the request so the
  whole tree machinery (rename, duplicate, drag, delete) works on them for
  free, and converts on import/export.

### Context menu

Right-click any node:

| Action | Notes |
|---|---|
| Run / Send | Request only |
| **Load Test** | Request or folder. A folder runs as a flow. |
| Duplicate | Copies the subtree with fresh ids. Only the top node gets `(Copy)` — children keep their names, because a folder of renamed children is unusable. |
| Move up / Move down | Reorders among siblings. Order is content here: the runner executes in tree order. |
| Move out of folder | Lifts the node one level up |
| Rename, Delete, Copy, Paste | |
| Star | Pins to the top of its siblings. Local only — stars never go to GitHub, and a pull restores them. |

### Saving

The **Save** button has a dropdown next to it with **Save to all with this
name** — it writes the current editor content into *every* request with the
same name across the tree, after showing you the full list of targets.

A plain save only ever touches the request you have open; it is keyed by id,
not by name.

## Environments and variables

An environment is a named list of `key` / `value` pairs, each one enabled or
disabled. Reference them anywhere with `{{key}}`: URL, headers, body, auth
fields, path params.

### Which value wins

If the same key appears twice in one environment, **the first enabled entry
wins**. Reads and writes use the same rule (`src/lib/envMap.ts`) — they used
to disagree, which produced the symptom of "I edited the variable and it still
used the old value".

A disabled entry is invisible to resolution, but it is still stored and still
syncs, so it survives as a parked alternative.

### Where a variable can be set

- By hand, in the environment panel
- By a script: `pm.environment.set('token', value)`
- By an OAuth 2.0 token step, into the variable the *Access Token* field names

Inside the Collection Runner and the load test, each run and each virtual user
works on its own copy, so nothing leaks between them.

### Editing without leaving the runner

The Collection Runner panel shows the variables a request actually used, and
lets you edit them there and re-run — without closing the panel to go find the
environment.

## Path parameters

A URL segment written `:name` becomes a path parameter with its own field.
They are stored separately from the URL, so renaming the segment does not lose
the value.

## Importing

| Source | How |
|---|---|
| **Postman collection** (v2.1) | Import from the sidebar. Folders, requests, scripts, auth, saved examples and path variables all come across. |
| **Postman environment** | Same importer; it detects `_postman_variable_scope`. |
| **OpenAPI** (2.0 and 3.x) | Builds a folder per tag with a request per operation. Resolves `$ref`, `allOf` and recursive schemas to generate example bodies. |
| **cURL** | Paste a command; it becomes a request. |

Importing an obfuscated environment exported by an older DevFlow build still
works — values prefixed `OBFv1$` are decoded, anything else passes through.

## Exporting

Right-click a collection → **Export**. The output is **Postman Collection
v2.1**, and an environment exports from its panel in Postman's environment
format.

### What is verified

The collection export validates against the official
`schema.postman.com/json/collection/v2.1.0` schema. Headers use `disabled`
rather than `enabled`, examples use `_postman_previewlanguage`, scripts are
`event[].script.exec` line arrays, raw JSON bodies carry
`options.raw.language`, and bearer / basic / API key / OAuth 2.0 all export
with their fields.

Environment export matches Postman's format: `values[]` with
`key`/`value`/`type`/`enabled`, plus `_postman_variable_scope`,
`_postman_exported_at` and `_postman_exported_using`. The `color` field is a
DevFlow extension that Postman ignores.

### Known gaps

These are measured, not theoretical.

**URL parts can contradict the raw URL.** `toPostmanUrl` prefers
`urlexport.host` / `path` when they exist, but editing a URL in the app updates
only `raw`. For a request that was imported from Postman and later edited, the
parts go stale — and **Postman rebuilds the URL from the parts and ignores
`raw`** (`Url.toString()` in `postman-collection`). The exported request then
points somewhere else, silently. On one real 8,279-request data set, 296 (3.6%)
were affected.

**`protocol` and `port` are not emitted.** An `https://` URL exported from a
raw string loses the scheme, and `localhost:5001` loses the port, for the same
reason — the parts never carry them. URLs that start with `{{variable}}` are
unaffected, which is the overwhelming majority in practice.

**`disabledDefaultHeaders` has no equivalent** in the v2.1 format. If you
switched a default header off, Postman will still send its own.

**gRPC requests are excluded.** The v2.1 format has no gRPC. They are left out
rather than exported as broken HTTP.

If you are moving work to Postman and any of this matters, check the URLs of
requests you have edited since importing.
