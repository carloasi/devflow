# Extensions

An extension is a small HTML page that DevFlow loads in a sandboxed frame and
talks to over `postMessage`. It can read your requests, run them, store its own
data and put a widget in the status bar.

## Why a frame and not a plugin API

Running extension code in the app's own context would give it the DOM, the
stores and the credentials. The frame means an extension gets exactly what it
asks for in `permissions`, and nothing else.

The proof that the API is enough: the footer clock and date-difference
calculator used to be a native React component inside `AppLayout`. It was
ported to an extension on purpose — if something the app itself uses cannot be
written as one, the API is incomplete.

## Managing them

**Settings → Extensions.**

- **Open the extensions folder** — where installed extensions live on disk
- **Scaffold a new extension** — writes a working skeleton, including a
  `devflow.d.ts` with the typed API
- **Enable / disable** each one
- **Dev paths** — point at a folder you are working on without installing it

`source` tells them apart: `builtin`, `installed` or `dev`.

## Manifest

```json
{
  "id": "com.example.my-extension",
  "name": "My extension",
  "version": "1.0.0",
  "description": "What it does",
  "permissions": ["requests:read", "storage"],
  "contributes": {
    "statusBarItems": [{ "id": "my-widget" }],
    "shortcuts": ["Ctrl+Shift+D"]
  }
}
```

A manifest that fails to parse does not take the app down — the extension is
listed with its `error` so you can see why it did not load.

## Permissions

| Permission | Grants |
|---|---|
| `requests:read` | List and read requests |
| `requests:run` | Execute a request |
| `response:read` | Read the current response |
| `environments:read` | List environments |
| `storage` | Its own persistent key/value store |

A command whose permission is missing is refused. Ask only for what the
extension needs — the list is visible to whoever installs it.

## The API

Messages to the host, each resolving with a result:

**Requests**

```js
devflow.requests.list()
devflow.requests.get(id)
devflow.requests.run(id)
```

`requests.run` goes through the same pipeline as the Send button — same
variable resolution, same auth, same scripts.

**Response**

```js
devflow.response.get()
```

**Environments**

```js
devflow.environments.list()
```

**Storage** — scoped to the extension, persisted across restarts

```js
devflow.storage.get(key)
devflow.storage.set(key, value)
devflow.storage.remove(key)
```

**UI**

```js
devflow.ui.toast(message)
devflow.ui.resize({ width, height })
devflow.ui.expand()
devflow.ui.collapse()
```

A status bar widget is collapsed by default and expands to its requested size
on interaction, so several can share the bar without fighting for room.

## Writing one

Start from the scaffold: it generates the manifest, an `index.html` and the
`devflow.d.ts` declarations, so an editor can autocomplete the API.

Point a dev path at the folder while you work — no install, no restart.

For a complete worked example, read the built-in one:
`src/extensions/builtin/dateDiffExtension.ts`.

## Where the code is

| Piece | File |
|---|---|
| Host: message handling, permissions, lifecycle | `src/extensions/useExtensionHost.ts` |
| The frame and status bar slot | `src/extensions/ExtensionSlot.tsx` |
| Built-in example | `src/extensions/builtin/dateDiffExtension.ts` |
| Discovery, scaffolding, folder access | `src-tauri/src/extensions.rs` |
