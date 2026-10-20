# gRPC

DevFlow speaks real gRPC, not gRPC-Web. The client lives in Rust
(`src-tauri/src/grpc.rs`), because a browser cannot open an HTTP/2 connection
with trailers, and reflection and bidirectional streaming need one.

## Creating a request

Right-click a folder → **New gRPC request**. It starts empty: the schema
arrives afterwards, from the tab.

## Target

```
host:port
```

Two switches beside it:

- **Use TLS** — plaintext (`h2c`) when off.
- **Allow insecure TLS** — skips certificate verification. For a staging
  server with a self-signed certificate; not something to leave on.

## Getting the schema

Two sources, tracked on the request as `schemaSource`:

### Server reflection

If the server exposes the reflection service, press reflect and DevFlow asks it
for the service list. Nothing to provide.

### `.proto` files

Pick one or more `.proto` files and the app compiles them into a descriptor
set. Use this when reflection is disabled, which is common in production.

Either way the result is cached on the request (`descriptorSet`), so reopening
the tab does not require the server to be reachable. Replacing or clearing the
schema invalidates the cached service list together with it — the two are
stored as a pair so they cannot drift apart.

## Choosing a method

The method picker lists every service and method from the schema. Each one
carries its kind, derived from the descriptor:

| Kind | Meaning |
|---|---|
| `unary` | One message in, one out |
| `server` | One in, a stream out |
| `client` | A stream in, one out |
| `bidi` | Streams both ways |

Switching schemas keeps the selected method if it still exists; otherwise the
first available one is picked.

## The message

JSON, and **`{{variables}}` work** — resolved from the active environment, the
same as HTTP requests.

The method info carries an `inputTemplate` generated from the input type, so a
new request starts with the right shape rather than an empty object.

## Metadata

Key/value pairs, each one enabled or disabled — gRPC's equivalent of headers.
Variables are resolved here too.

## Streaming

Unary calls return a single response. Streaming calls open a session with its
own controls:

| Command | Rust side |
|---|---|
| Start | `grpc_stream_start` |
| Send a message | `grpc_stream_send` |
| Half-close (stop sending, keep receiving) | `grpc_stream_end` |
| Cancel | `grpc_stream_cancel` |

The response panel shows a **timeline** of the session, with each message in
order and the direction it travelled, so a bidirectional exchange reads as a
conversation rather than a flat log.

## Timeout

`timeoutMs` on the request. Leave it unset for the default.

## Exporting as grpcurl

The equivalent `grpcurl` command, with variables already resolved — the gRPC
counterpart of the cURL snippet. Useful for handing a reproduction to someone
who does not have the app.

## Limits

**gRPC requests are not included in the Postman export.** The Postman v2.1
format has no gRPC; they are left out rather than exported as broken HTTP
requests. See [Collections](COLLECTIONS.md#known-gaps).

**The MCP tools do not cover gRPC.** `run_request` and the rest of the agent
surface are HTTP-only today.

## Where the code is

| Piece | File |
|---|---|
| Client, reflection, descriptor compilation, streaming | `src-tauri/src/grpc.rs` |
| Shared types | `src/app/types/Grpc.ts` |
| Request panel | `src/components/Grpc/GrpcRequestPanel.tsx` |
| Response panel | `src/components/Grpc/GrpcResponsePanel.tsx` |
| Stream timeline | `src/components/Grpc/GrpcStreamTimeline.tsx` |
| grpcurl snippet | `src/components/Grpc/grpcurl.ts` |
