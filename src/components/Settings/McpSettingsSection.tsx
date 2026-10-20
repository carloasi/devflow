'use client';

import { useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { UseMcpServerResult } from '@/mcp/useMcpServer';

interface McpSettingsSectionProps {
  mcp: UseMcpServerResult;
}

export function McpSettingsSection({ mcp }: McpSettingsSectionProps) {
  const [copied, setCopied] = useState<'command' | 'token' | null>(null);
  const [showToken, setShowToken] = useState(false);

  const addCommand = mcp.port
    ? `claude mcp add --transport http devflow http://127.0.0.1:${mcp.port}/mcp --header "Authorization: Bearer ${mcp.token}"`
    : '';

  const copy = async (value: string, what: 'command' | 'token') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch (e) {
      console.error('Erro ao copiar:', e);
    }
  };

  return (
    <div className="mt-5 pt-5 border-t border-pm-border">
      <h3 className="text-sm font-semibold text-pm-text mb-2">Claude Code (MCP)</h3>

      <div className="py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-pm-text">Local MCP server</p>
            <p className="text-xs text-pm-text-muted mt-0.5 max-w-[52ch]">
              Lets Claude Code list and run the requests in this workspace, using this
              app&apos;s own engine — same variable resolution, auth and scripts as the Send
              button. Listens on 127.0.0.1 only, and every call needs the token below.
            </p>
          </div>

          <button
            type="button"
            disabled={mcp.starting}
            onClick={() => (mcp.enabled ? mcp.disable() : mcp.enable())}
            className={`h-8 shrink-0 rounded-md px-3 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
              mcp.enabled
                ? 'border border-pm-border bg-pm-hover text-pm-text hover:bg-pm-row-active'
                : 'border-none bg-pm-accent text-white hover:brightness-110'
            }`}
          >
            {mcp.starting ? 'Starting…' : mcp.enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>

        {mcp.error && (
          <p className="mt-2 text-xs text-rose-400">{mcp.error}</p>
        )}

        {mcp.enabled && mcp.port && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-pm-text-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Running on <span className="font-mono">127.0.0.1:{mcp.port}</span>
            </div>

            {mcp.portChanged && (
              <p className="text-[11px] text-amber-400/90 max-w-[52ch]">
                The previous port was no longer available, so the server moved to a new one.
                If you had already connected Claude Code, run the command below again to
                point it at the new address.
              </p>
            )}

            <div>
              <p className="text-[11px] text-pm-text-muted mb-1">
                Run this once in your terminal to connect Claude Code:
              </p>
              <div className="flex items-start gap-2">
                <code className="flex-1 rounded-md border border-pm-border bg-pm-hover px-2.5 py-2 font-mono text-[11px] text-pm-text break-all">
                  {showToken ? addCommand : addCommand.replace(mcp.token, '•'.repeat(12))}
                </code>
                <button
                  type="button"
                  onClick={() => copy(addCommand, 'command')}
                  title="Copy command"
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text cursor-pointer"
                >
                  {copied === 'command' ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                </button>
              </div>

              <div className="mt-1.5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowToken(v => !v)}
                  className="text-[11px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                >
                  {showToken ? 'Hide token' : 'Show token'}
                </button>
                <button
                  type="button"
                  onClick={mcp.regenerateToken}
                  title="Any client using the old token stops working"
                  className="flex items-center gap-1 text-[11px] text-pm-text-muted hover:text-pm-text transition-colors cursor-pointer"
                >
                  <RefreshCw size={11} />
                  Regenerate token
                </button>
              </div>
            </div>

            <p className="text-[11px] text-amber-400/90">
              While this is on, Claude Code can call your APIs with the credentials stored in
              your environments. Turn it off when you&apos;re not using it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
