# DevFlow

A local-first desktop API client built with Tauri and Next.js.

It does what you expect from an API client — collections, environments,
pre-request and post-response scripts, a runner — plus three things the others
don't:

- **A built-in AI agent.** The Claude Code panel runs inside the app and sees
  your collections through a local MCP server, so you can ask "run this request
  and tell me why it returned 401" without copying anything anywhere.
- **Native load testing.** The engine is Rust, not a script. It runs virtual
  users by duration, iterations or ramp stages, and keeps the history.
- **Sync over GitHub.** Collections live in a repository you own, encrypted
  with a passphrase only you hold. No account, no third-party cloud.

> **Status:** under active development. Only the Windows build is packaged
> today; macOS and Linux compile but have not been validated in real use.

## Screenshots

<!-- TODO: add screenshots. Three, in this order:
     1. The main window with a collection open and a response
     2. The Claude panel next to a request
     3. The load test panel with the live chart -->

## Install

Download the latest installer from [Releases](../../releases).

The executable is not signed yet, so Windows shows a SmartScreen warning and
macOS asks for Gatekeeper confirmation the first time you open it.

## Running from source

You need [Node 20+](https://nodejs.org), the
[Rust toolchain](https://www.rust-lang.org/tools/install) and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/)
(on Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` and friends).

```bash
npm ci
npx tauri dev
```

To build the installer for your platform:

```bash
npx tauri build
```

## How it works

The frontend is Next.js in static export mode, served inside the Tauri webview.
Rust handles what the browser cannot: HTTP requests without CORS, the load test
engine, the script sandbox (QuickJS), secure credential storage, gRPC, and the
local MCP server.

Sending a request goes through a single path — variable resolution, path
params, auth, body sanitisation and scripts — shared by the Send button, the
runner, the load test and the MCP tools. That is what keeps the four
consistent with each other.

See [Architecture](docs/ARCHITECTURE.md) for the full picture.

## Documentation

Start at the [documentation index](docs/README.md).

| Guide | What it covers |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Process model, the request pipeline, where data lives |
| [Collections & environments](docs/COLLECTIONS.md) | The tree, variables, import and export, Postman compatibility |
| [Scripting](docs/SCRIPTING.md) | The `pm.*` API available in pre-request and post-response scripts |
| [Collection Runner](docs/COLLECTION_RUNNER.md) | Running a folder as a flow, assertions, run history |
| [GitHub sync](docs/GITHUB_SYNC.md) | Encrypted sync, selective push, three-way merge review |
| [Load testing](docs/LOAD_TESTING.md) | Execution modes, correlation between requests, thresholds |
| [Claude agent](docs/CLAUDE_AGENT.md) | The in-app panel and the terminal CLI over MCP |
| [gRPC](docs/GRPC.md) | Reflection, `.proto` files, unary and streaming calls |
| [Extensions](docs/EXTENSIONS.md) | The extension host and its API |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

See [LICENSE](LICENSE).
