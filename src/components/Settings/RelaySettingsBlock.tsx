'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { SettingsToggle } from './SettingsToggle';
import {
  connectionCode,
  getRelayStatus,
  loadRelaySettings,
  regenerateRelayKey,
  setRelayEnabled,
  subscribeRelayStatus,
  type RelayStatus,
} from '@/lib/relayServer';

// Settings → Network → "HTML runner relay": liga o relay que deixa o HTML
// exportado de um flow enviar pelo DevFlow (ver lib/relayServer).
export function RelaySettingsBlock() {
  const [settings, setSettings] = useState(loadRelaySettings);
  const [status, setStatus] = useState<RelayStatus>(getRelayStatus);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => subscribeRelayStatus(setStatus), []);

  const code = status.port ? connectionCode(status.port, settings.key) : null;

  return (
    <div className="py-3 border-t border-pm-border">
      <SettingsToggle
        label="HTML runner relay"
        description="Lets a flow exported as an HTML runner send its requests through DevFlow — needed for internal hosts (.corp certificates) and APIs that block browsers (CORS). Only this computer can use it, and only with the connection code below."
        checked={settings.enabled}
        disabled={busy}
        onChange={async (on) => {
          setBusy(true);
          await setRelayEnabled(on);
          setSettings(loadRelaySettings());
          setBusy(false);
        }}
      />

      {status.error && (
        <p className="mt-1 text-xs text-rose-400">Could not start the relay: {status.error}</p>
      )}

      {settings.enabled && code && (
        <div className="mt-1">
          <p className="text-xs text-pm-text-muted mb-1.5">
            Connection code — paste it once in the HTML page (&quot;Send via → DevFlow&quot;). Running on port {status.port}.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-md border border-pm-border bg-pm-hover px-2.5 py-1.5 font-mono text-[11px] text-pm-text-secondary">
              {code}
            </code>
            <button
              type="button"
              title="Copy the connection code"
              onClick={async () => {
                await navigator.clipboard.writeText(code);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="h-8 w-8 flex items-center justify-center rounded-md border border-pm-border bg-pm-hover text-pm-text-secondary hover:text-pm-text hover:bg-pm-row-active cursor-pointer"
            >
              {copied ? <Check size={13} className="text-[#4ff09d]" /> : <Copy size={13} />}
            </button>
            <button
              type="button"
              title="New code — pages using the old one stop working"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setSettings(await regenerateRelayKey());
                setBusy(false);
              }}
              className="h-8 w-8 flex items-center justify-center rounded-md border border-pm-border bg-pm-hover text-pm-text-secondary hover:text-pm-text hover:bg-pm-row-active cursor-pointer disabled:opacity-40"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
