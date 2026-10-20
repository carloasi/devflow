// components/SyncBar.tsx
// A compact sync bar to embed in your app's header or sidebar.
// Shows server version, push/pull buttons, and conflict warnings.

import React from "react";
import { useCollectionSync, SyncState } from "../hooks/useCollectionSync";

interface SyncBarProps<T> {
  localCollections: T;
  onPull: (collections: T) => void;
  username: string;
}

function formatDate(iso: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

const STATE_LABELS: Record<SyncState, string> = {
  idle: "Ready",
  pushing: "Sending…",
  pulling: "Downloading…",
  conflict: "Conflict",
  error: "Error",
  up_to_date: "Up to date",
};

const STATE_COLORS: Record<SyncState, string> = {
  idle: "#6b7280",
  pushing: "#2563eb",
  pulling: "#7c3aed",
  conflict: "#d97706",
  error: "#dc2626",
  up_to_date: "#16a34a",
};

export function SyncBar<T>({ localCollections, onPull, username }: SyncBarProps<T>) {
  const {
    push,
    pull,
    syncState,
    serverStatus,
    errorMessage,
    hasRemoteUpdates,
  } = useCollectionSync({ localCollections, onPull, username });

  const busy = syncState === "pushing" || syncState === "pulling";

  return (
    <div style={styles.bar}>
      {/* Status dot + label */}
      <div style={styles.statusGroup}>
        <span
          style={{
            ...styles.dot,
            backgroundColor: STATE_COLORS[syncState],
            boxShadow: busy ? `0 0 6px ${STATE_COLORS[syncState]}` : "none",
          }}
        />
        <span style={styles.statusLabel}>{STATE_LABELS[syncState]}</span>
      </div>

      {/* Server info */}
      {serverStatus && (
        <div style={styles.info}>
          <span style={styles.muted}>Server v{serverStatus.serverVersion}</span>
          {serverStatus.updatedBy && (
            <span style={styles.muted}>· {serverStatus.updatedBy}</span>
          )}
          {serverStatus.updatedAt && (
            <span style={styles.muted}>· {formatDate(serverStatus.updatedAt)}</span>
          )}
        </div>
      )}

      {/* Remote update badge */}
      {hasRemoteUpdates && syncState !== "conflict" && (
        <span style={styles.badge}>New version available</span>
      )}

      {/* Conflict warning */}
      {syncState === "conflict" && (
        <span style={{ ...styles.badge, backgroundColor: "#fef3c7", color: "#92400e" }}>
          ⚠ Conflict — pull before pushing
        </span>
      )}

      {/* Error message */}
      {syncState === "error" && errorMessage && (
        <span style={{ ...styles.badge, backgroundColor: "#fee2e2", color: "#991b1b" }}>
          {errorMessage}
        </span>
      )}

      {/* Action buttons */}
      <div style={styles.actions}>
        <button
          onClick={pull}
          disabled={busy}
          title="Download collection from the server"
          style={{
            ...styles.btn,
            ...(hasRemoteUpdates || syncState === "conflict" ? styles.btnPrimary : {}),
          }}
        >
          {syncState === "pulling" ? "⟳ Downloading…" : "⬇ Pull"}
        </button>
        <button
          onClick={push}
          disabled={busy}
          title="Send your collection to the server"
          style={styles.btn}
        >
          {syncState === "pushing" ? "⟳ Sending…" : "⬆ Push"}
        </button>
      </div>
    </div>
  );
}

// ── Inline styles (no CSS dependency) ────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "6px 14px",
    background: "#1e1e2e",
    borderBottom: "1px solid #2d2d3f",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontSize: 12,
    color: "#e2e8f0",
    flexWrap: "wrap",
  },
  statusGroup: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
    transition: "background-color 0.3s",
  },
  statusLabel: {
    fontWeight: 600,
    letterSpacing: "0.02em",
  },
  info: {
    display: "flex",
    gap: 4,
    color: "#94a3b8",
  },
  muted: {
    color: "#64748b",
  },
  badge: {
    padding: "2px 8px",
    borderRadius: 4,
    backgroundColor: "#fef9c3",
    color: "#713f12",
    fontWeight: 600,
    fontSize: 11,
  },
  actions: {
    marginLeft: "auto",
    display: "flex",
    gap: 6,
  },
  btn: {
    padding: "4px 12px",
    borderRadius: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#334155",
    background: "#0f172a",
    color: "#cbd5e1",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    transition: "background 0.15s",
  },
  btnPrimary: {
    background: "#1d4ed8",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#2563eb",
    color: "#fff",
  },
};
