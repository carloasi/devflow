// hooks/useCollectionSync.ts
// Drop this hook into your existing Next.js app.
// It manages push/pull of collections against the Rust sync server.

import { useState, useCallback, useEffect, useRef } from "react";

const SERVER_URL = process.env.NEXT_PUBLIC_SYNC_SERVER_URL ?? "http://localhost:4000";
const POLL_INTERVAL_MS = 30_000; // check for remote updates every 30s

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncStatus {
  serverVersion: number;
  localBaseVersion: number; // last version we pulled/pushed
  updatedAt: string;
  updatedBy: string;
}

export type SyncState =
  | "idle"
  | "pushing"
  | "pulling"
  | "conflict"
  | "error"
  | "up_to_date";

interface ServerCollections {
  version: number;
  updated_at: string;
  updated_by: string;
  collections: unknown;
}

interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCollectionSync<T = unknown>(opts: {
  /** Your app's current local collection state */
  localCollections: T;
  /** Called when the user confirms a pull — update your local state here */
  onPull: (collections: T) => void;
  /** Current user's name/id */
  username: string;
}) {
  const { localCollections, onPull, username } = opts;

  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [serverStatus, setServerStatus] = useState<SyncStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const localBaseVersionRef = useRef<number>(0);

  // ── Polling: detect remote changes ────────────────────────────────────────

  const checkServerStatus = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/collections/status`);
      const body: ApiResponse<{ version: number; updated_at: string; updated_by: string }> =
        await res.json();

      if (!body.ok || !body.data) return;

      setServerStatus({
        serverVersion: body.data.version,
        localBaseVersion: localBaseVersionRef.current,
        updatedAt: body.data.updated_at,
        updatedBy: body.data.updated_by,
      });

      // Automatically flag if server is ahead
      if (body.data.version > localBaseVersionRef.current) {
        setSyncState((prev) =>
          prev === "idle" || prev === "up_to_date" ? "idle" : prev
        );
      }
    } catch {
      // Silent fail for background poll
    }
  }, []);

  useEffect(() => {
    checkServerStatus();
    const id = setInterval(checkServerStatus, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [checkServerStatus]);

  // ── Push local → server ───────────────────────────────────────────────────

  const push = useCallback(async () => {
    setSyncState("pushing");
    setErrorMessage(null);

    try {
      const res = await fetch(`${SERVER_URL}/api/collections`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          collections: localCollections,
          base_version: localBaseVersionRef.current,
        }),
      });

      const body: ApiResponse<ServerCollections> = await res.json();

      if (res.status === 409) {
        // Someone pushed a newer version — must pull first
        setSyncState("conflict");
        setErrorMessage(body.error ?? "Conflict detected. Pull the latest version first.");
        return { success: false, conflict: true };
      }

      if (!body.ok || !body.data) {
        throw new Error(body.error ?? "Unknown server error");
      }

      localBaseVersionRef.current = body.data.version;
      setServerStatus({
        serverVersion: body.data.version,
        localBaseVersion: body.data.version,
        updatedAt: body.data.updated_at,
        updatedBy: body.data.updated_by,
      });
      setSyncState("up_to_date");
      return { success: true, conflict: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Push failed";
      setErrorMessage(msg);
      setSyncState("error");
      return { success: false, conflict: false };
    }
  }, [localCollections, username]);

  // ── Pull server → local ───────────────────────────────────────────────────

  const pull = useCallback(async () => {
    setSyncState("pulling");
    setErrorMessage(null);

    try {
      const res = await fetch(`${SERVER_URL}/api/collections`);
      const body: ApiResponse<ServerCollections> = await res.json();

      if (!body.ok || !body.data) {
        throw new Error(body.error ?? "Failed to fetch collections");
      }

      localBaseVersionRef.current = body.data.version;
      setServerStatus({
        serverVersion: body.data.version,
        localBaseVersion: body.data.version,
        updatedAt: body.data.updated_at,
        updatedBy: body.data.updated_by,
      });

      onPull(body.data.collections as T);
      setSyncState("up_to_date");
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Pull failed";
      setErrorMessage(msg);
      setSyncState("error");
      return { success: false };
    }
  }, [onPull]);

  const hasRemoteUpdates =
    serverStatus !== null &&
    serverStatus.serverVersion > localBaseVersionRef.current;

  return {
    push,
    pull,
    syncState,
    serverStatus,
    errorMessage,
    hasRemoteUpdates,
    checkServerStatus,
  };
}