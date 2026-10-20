# GitHub sync

Collections and environments live in a GitHub repository you own, encrypted
with a passphrase only you hold. There is no DevFlow account and no
third-party server: the app talks to the GitHub API directly.

## Setup

**Settings → GitHub sync.** You need:

| Field | Notes |
|---|---|
| **Token** | A personal access token with access to the repository. Stored in the OS keyring, never in `localStorage`. |
| **Owner / Repo / Branch** | Where the files go. |
| **Passphrase** | Encrypts the contents. The app cannot recover it — if it is lost, what is already in the repository is unreadable. |

Each workspace maps to its own path in the repository, so several workspaces
can share one repo.

## Encryption

Contents are encrypted before upload (`src/lib/syncCrypto.ts`). The format is
versioned — current payloads are written as `DFv2:`, and the previous key is
retained **for reading only** so that anything synced by an older build stays
readable. That key cannot be removed without stranding existing data.

What this means in practice: someone with access to the repository sees file
names and sizes, not request bodies, URLs or credentials.

## Pushing

### Selective push

You do not have to push everything. The app tracks which collections actually
changed and offers to send only those.

It detects this by **comparing the tree against its previous state**
(`collectionFingerprint.ts`) rather than by instrumenting every mutation.
There are dozens of places that modify the tree — create, rename, delete,
paste, reorder, drag, save tab — and any one of them forgotten would mean a
change that never gets pushed: the worst possible defect in a sync feature,
because it fails silently. One comparison in one place cannot be forgotten.

The fingerprint is taken from the content **already stripped of star marks**,
which is exactly what the push writes. So the question it answers is "would
the remote file change?", not "did anything move on screen".

### Push one collection

Right-click a collection → push. Only that file is written.

### What never goes up

- **Star marks.** Favouriting is a personal, local signal. A pull restores
  your stars rather than wiping them.
- **Anything the agent created.** Requests created, renamed or edited through
  the Claude panel or MCP save **locally only**. An agent iterating on a script
  would otherwise produce a flood of commits.

## Pulling, with review

A pull does not overwrite blindly. **Review changes first** opens a diff of
what is in the repository against what you have, and you choose what to apply.

### The list

Grouped by collection, then by folder, with the **item name in front** and the
folder path as a muted header above it. Each row is marked added, removed or
changed, and carries a checkbox.

Filter by text, by kind of change, or to conflicts only. The search matches the
whole path, so typing a folder name brings up what is inside it.

The toolbar acts on **what is currently listed**, never on hidden rows:

- **Select safe** — everything that can be accepted without discarding local
  work
- **All** / **None** — the visible subset, preserving choices outside it

### The detail panel

Click a row to see what changed, field by field. You can edit the result
before applying — the choice is not "theirs or mine, whole".

For **headers and environment variables**, the comparison is per entry rather
than two blocks of JSON side by side: one row per key, with the two values and
a **Here / GitHub** button on each. Resolving one header no longer means
hand-editing the whole array.

Entries match **by key, not by position** — reordering headers does not change
what a request does, and matching by index would shift everything and hide the
real difference. Repeated keys match occurrence by occurrence.

## Conflicts

A conflict is a node that changed **on both sides**. Telling that apart from
"changed only on GitHub" needs a record of the last common state, which is what
`sync-base.json` holds: one hash per node, written after each sync.

Without that base the app could only know that local and remote differ, not
who moved. It used to mark conflicts per collection — any pending change
anywhere in a collection flagged *every* item in it. In a workspace with 313
items the warning appeared on all 313 and stopped meaning anything.

With the base, the three cases separate:

| Situation | Treatment |
|---|---|
| Changed only on GitHub | Safe to accept; selected by default |
| Changed only here | Not a decision at all |
| Changed on both sides | Real conflict; starts unselected, marked amber |

Accepting a conflicting node replaces your version and there is no undo, so
the footer counts them separately: `9/10 selected · 1 discard local work`.

### Comparison is canonical

The remote side is rebuilt by the importer and comes back with keys in a
different order, so a literal comparison reported a difference in essentially
every item. The comparison normalises key order, `\r\n`, absent-versus-empty,
and `enabled: true` as the default (`canonicalCompare.ts`).

Deliberately *not* normalised: trailing spaces, array order and letter case.
Those are real differences.

## Pull at any level

Pull is not limited to a whole collection. Right-click a folder and pull just
that subtree — the diff is cut to it, and only what you select is applied.

Environments have the same review flow from their own panel. Variables match
**by key**, because a pull regenerates value ids.

## Troubleshooting

**Everything shows as changed.** Usually a passphrase mismatch — a payload
decrypted with the wrong key is not the content you have. Check the passphrase
before accepting a diff that claims to rewrite everything.

**A renamed collection appears twice.** Renaming changes the file name; the old
remote file is not removed automatically. Delete it in the repository.

**A pull wiped my stars.** It should not — star marks are collected before the
pull and reapplied. If it happens, that is a bug worth reporting with the
collection shape.
