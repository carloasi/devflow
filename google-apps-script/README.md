# Remote block / update notice (Google Sheets + Apps Script)

The app (`AppUpdateGate`, in `src/components/AppUpdateGate.tsx`) periodically
checks a URL that returns a small JSON with the app's status. That URL is a
Google Apps Script Web App published from a Google Sheet — editing the sheet's
cells propagates to everyone using the app, with no rebuild.

## Setup

1. Create a new, blank Google Sheet.
2. On the first tab, fill columns **A** (key) and **B** (value), one row per
   key, **with no header** (start at row 1):

   | A | B |
   |---|---|
   | `latestVersion` | `1.1.5` |
   | `minVersion` | *(empty = no mandatory minimum version)* |
   | `blocked` | `FALSE` |
   | `blockMessage` | *(message shown on the block screen when `blocked=TRUE`)* |
   | `updateUrl` | `https://github.com/your-user/devflow/releases/latest` |
   | `updateMessage` | `New version available with load test improvements!` |
   | `blockedUsers` | *(optional — Windows usernames, comma separated, e.g. `CarlosSilva, joao.pereira`)* |
   | `blockedVersions` | *(optional — exact versions, comma separated, e.g. `1.1.4, 1.1.7-beta`)* |

   ⚠️ **Careful with versions like `1.1.2008`**: Google Sheets sometimes reads
   dot-separated numbers as a DATE and converts the cell on its own, breaking
   the version comparison. If that happens: clear the cell, select column B →
   **Format → Number → Plain text**, and type it again (or type it with a
   leading apostrophe, e.g. `'1.1.2008`, which forces plain text without
   changing the column format).

3. **Extensions → Apps Script**, delete the default content and paste
   [`Code.gs`](./Code.gs) from this directory.
4. **Deploy → New deployment → type "Web app"**:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the generated URL (it ends in `/exec`) and paste it into
   `src/lib/appStatus.ts`, in the `APP_STATUS_URL` constant. Publish a new
   build with that URL in place.

## Day-to-day use

- **Block everyone now**: set `blocked` to `TRUE` (fill `blockMessage` if you
  want to explain why). The app picks it up within ~20 minutes — or
  immediately, if the person focuses the app window after the change — and
  shows a full screen blocking any interaction.
- **Unblock**: set `blocked` back to `FALSE`.
- **Announce a new version (without blocking)**: set `latestVersion` to the new
  version (e.g. `1.2.0`). Anyone on an older version gets a toast — nothing is
  blocked — with a download button if `updateUrl` is filled in.
- **Force a mandatory update**: fill `minVersion`. Anyone below that version
  sees the same block screen until they update. Unlike `blocked`, which blocks
  everyone regardless of the version installed.
- **Block one person**: fill `blockedUsers` with their Windows username (the
  one in "This PC → Properties", not an app login). Only that person sees the
  block screen; the rest of the team carries on. Accepts several names,
  comma separated.
- **Block a specific version**: fill `blockedVersions` with the exact version
  you want to take down (a release with a bug, say), without raising
  `minVersion` for everyone. Accepts several, comma separated.

`blockMessage` is shared across all the block types above — if filled, it
appears in any of them (global, minimum version, specific user or specific
version). Leave it blank for each case to show its own default English
message.

## Seeing who is using the app

Every time someone opens the app it records a "check-in" (Windows user +
version) straight into the sheet, on a new tab called **Users** (created
automatically on the first check-in). Each person takes **one row**, updated on
every launch — it is not a growing log, it is always "who has used it and when
they were last seen":

| username | version | lastSeen |
|---|---|---|
| CarlosSilva | 1.1.8 | 2025-06-01T12:34:56.000Z |
| joao.pereira | 1.1.7 | 2025-05-30T09:12:03.000Z |

This needs no new sheet and no extra configuration — just paste the updated
`Code.gs` (see below) and redeploy once.

The `version` column on that tab is written as plain text automatically by the
code, which avoids the "turns into a Date on its own" problem described above.
You do not need to format that column by hand.

## User error log

The app captures errors — unhandled JS errors, rejected promises without a
catch, `console.error`, and React render crashes — into a local log and sends
them to the **Errors** tab of the sheet (created automatically on the first
send). App-side code: `src/lib/errorLog.ts`.

- **Automatic**: unhandled errors and crashes are sent on their own, with
  `kind = auto`. The same error repeated goes once per session, at most 10 per
  session.
- **Manual**: in **Settings → Report a problem** the user describes the problem
  and clicks **Send report**. The description plus the last 30 entries from the
  log (including `console.error`) are sent, all with `kind = manual` and the
  same `reportId`. The app shows that `reportId` to the user — ask them for it
  and filter the `reportId` column in the sheet.

| receivedAt | reportId | kind | username | version | description | occurredAt | source | message | stack |
|---|---|---|---|---|---|---|---|---|---|

Tokens (`Bearer`, JWT, `password=`, `api_key=` and the like) are masked in the
app before sending. You need to paste the updated `Code.gs` and redeploy once
(see below) for the Errors tab to start receiving data.

## After updating Code.gs (the code changed, not just the sheet)

Unlike editing sheet cells — which the Web App reads live, with no redeploy —
any change to the **code** in `Code.gs` needs a new deployment to take effect:

1. **Extensions → Apps Script**, delete everything and paste the updated
   `Code.gs` from this directory.
2. **Deploy → Manage deployments**, click the pencil icon on the **active
   deployment** — the one that produced the URL used in `APP_STATUS_URL`.
3. Under **Version**, choose **New version** and click **Deploy**.

Edit that deployment; do not create a second one. A new deployment gets a new
`/exec` URL, which the app does not call — the code would look updated in the
editor while every client kept reading the old deployment.

The `/exec` URL stays the same, so nothing needs to change in the app and no
new build is required.

You do **not** need to redeploy after editing only the sheet — the Web App
reads it live on every call.

## If the "Open update page" / "Download" button does not open the link

For security, the app may only open URLs from specific domains, configured in
`src-tauri/capabilities/default.json` under `opener:allow-open-url`. By default
`https://github.com/**` is already allowed, so `updateUrl` can point at a
GitHub release. If `updateUrl` is on another domain, add
`{ "url": "https://your-domain.com/**" }` to that list and make a new build —
without it, clicking the button fails silently.

## If the app is not reacting to changes

- Check that the URL in `APP_STATUS_URL` ends in `/exec`, not `/dev` — that
  one only works inside the Apps Script editor.
- Open the `/exec` URL directly in a browser: it should return raw JSON. If it
  asks for a Google login, the deployment does not have "Anyone" under "Who has
  access" — redeploy with that option.
- The check is **fail-open**: if the request fails for any reason (network,
  invalid JSON, the 8 s timeout) it is ignored silently and the app keeps
  working normally. Only a `blocked: true` that was read successfully blocks.
