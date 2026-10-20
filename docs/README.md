# DevFlow documentation

## Start here

- **[Architecture](ARCHITECTURE.md)** — how the pieces fit: the Next.js
  frontend in the Tauri webview, what Rust owns, the single request pipeline,
  and where every byte of your data is stored.

## Using the app

- **[Collections & environments](COLLECTIONS.md)** — the tree, workspaces,
  variables and their resolution order, saved examples, importing from Postman
  / OpenAPI / cURL, and what the Postman export does and does not preserve.
- **[Scripting](SCRIPTING.md)** — the `pm.*` API inside pre-request and
  post-response scripts. It is a hand-written object on a QuickJS sandbox, not
  Node and not the full Postman API, so the differences matter.
- **[Collection Runner](COLLECTION_RUNNER.md)** — run a folder as an ordered
  flow, pass data between steps, assert, and read the last run again later.
- **[Load testing](LOAD_TESTING.md)** — virtual users, ramp stages,
  correlation between requests, thresholds and PDF reports.
- **[gRPC](GRPC.md)** — server reflection or `.proto` files, unary calls and
  all three streaming modes.

## Sharing work

- **[GitHub sync](GITHUB_SYNC.md)** — collections encrypted into a repository
  you own: selective push, pull with a reviewable diff, and the three-way
  merge that tells "changed on GitHub" apart from "changed here".

## Extending

- **[Claude agent](CLAUDE_AGENT.md)** — the panel inside the app and the
  terminal CLI, both over the same local MCP server.
- **[Extensions](EXTENSIONS.md)** — the sandboxed extension host, its message
  API and permissions.

## For contributors

- **[CONTRIBUTING.md](../CONTRIBUTING.md)** — environment, the gates CI
  enforces, code style, and the areas where a careless change breaks data that
  already exists on someone's machine.

---

### A note on language

The code comments are in Portuguese; this documentation is in English. That is
deliberate rather than accidental — the comments are written for whoever edits
the file next, and the docs for whoever uses or evaluates the app.
