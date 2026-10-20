'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, FolderOpen, Plus, RefreshCw, X } from 'lucide-react';
import { UseExtensionHostResult } from '@/extensions/useExtensionHost';

interface ExtensionsSettingsSectionProps {
  host: UseExtensionHostResult;
}

export function ExtensionsSettingsSection({ host }: ExtensionsSettingsSectionProps) {
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>('extensions_folder')
      .then(setFolder)
      .catch(err => console.error('Erro ao obter a pasta de extensões:', err));
  }, []);

  const pickFolder = async (): Promise<string | null> => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === 'string' ? picked : null;
  };

  const handleLoadFolder = async () => {
    setMessage(null);
    const picked = await pickFolder();
    if (!picked) return;
    setBusy(true);
    try {
      await host.addDevPath(picked);
    } finally {
      setBusy(false);
    }
  };

  const handleScaffold = async () => {
    setMessage(null);
    const picked = await pickFolder();
    if (!picked) return;

    setBusy(true);
    try {
      const created = await invoke<string>('scaffold_extension', {
        dir: picked,
        id: 'my-extension',
      });
      // Já carrega em modo desenvolvimento: sem isso a pessoa criaria os
      // arquivos e não veria nada acontecer.
      await host.addDevPath(created);
      setMessage(`Created at ${created} and loaded.`);
    } catch (e: any) {
      setMessage(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 pt-5 border-t border-pm-border">
      <h3 className="text-sm font-semibold text-pm-text mb-2">Extensions</h3>

      <div className="py-3">
        <p className="text-xs text-pm-text-muted max-w-[52ch]">
          An extension is a folder with a manifest and an HTML file. It runs sandboxed — no access to
          the app&apos;s DOM or storage — and talks to DevFlow through the permissions it declares.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleScaffold}
            disabled={busy}
            className="flex h-8 items-center gap-1.5 rounded-md bg-pm-accent px-3 text-xs font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-50 cursor-pointer"
          >
            <Plus size={13} /> Create extension…
          </button>
          <button
            type="button"
            onClick={handleLoadFolder}
            disabled={busy}
            className="flex h-8 items-center gap-1.5 rounded-md border border-pm-border bg-pm-hover px-3 text-xs font-semibold text-pm-text transition-colors hover:bg-pm-row-active disabled:opacity-50 cursor-pointer"
          >
            <FolderOpen size={13} /> Load from folder…
          </button>
          <button
            type="button"
            onClick={() => host.reload()}
            disabled={busy || host.loading}
            className="flex h-8 items-center gap-1.5 rounded-md border border-pm-border bg-pm-hover px-3 text-xs text-pm-text-secondary transition-colors hover:bg-pm-row-active disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw size={13} /> Reload
          </button>
        </div>

        {message && <p className="mt-2 text-[11px] text-pm-text-secondary">{message}</p>}

        {folder && (
          <p className="mt-2 font-mono text-[10.5px] text-pm-text-muted break-all">
            Installed extensions live in {folder}
          </p>
        )}

        <div className="mt-3 flex flex-col gap-1.5">
          {host.extensions.length === 0 && !host.loading && (
            <p className="text-[11px] text-pm-text-muted">No extensions yet.</p>
          )}

          {host.extensions.map(extension => {
            const disabled = host.disabledIds.includes(extension.id);
            return (
              <div
                key={`${extension.id}:${extension.path}`}
                className="flex items-start gap-2 rounded-md border border-pm-border bg-pm-hover/40 px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-pm-text">
                      {extension.name}
                    </span>
                    {extension.version && (
                      <span className="font-mono text-[10px] text-pm-text-muted">
                        {extension.version}
                      </span>
                    )}
                    {extension.source === 'dev' && (
                      <span className="rounded bg-[#1a8ad4]/15 px-1 text-[9px] font-bold uppercase text-[#3c9be0]">
                        dev
                      </span>
                    )}
                    {extension.source === 'builtin' && (
                      <span className="rounded bg-white/10 px-1 text-[9px] font-bold uppercase text-pm-text-muted">
                        built-in
                      </span>
                    )}
                  </div>

                  {extension.error ? (
                    <p className="mt-0.5 flex items-start gap-1 text-[11px] text-rose-400">
                      <AlertTriangle size={11} className="mt-px shrink-0" />
                      {extension.error}
                    </p>
                  ) : (
                    <>
                      {extension.description && (
                        <p className="mt-0.5 text-[11px] text-pm-text-muted">{extension.description}</p>
                      )}
                      <p className="mt-1 text-[10px] text-pm-text-muted">
                        {extension.permissions.length > 0
                          ? `Permissions: ${extension.permissions.join(', ')}`
                          : 'No permissions requested'}
                      </p>
                    </>
                  )}

                  {extension.source !== 'builtin' && (
                    <p className="mt-1 font-mono text-[10px] text-pm-text-muted break-all">
                      {extension.path}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {!extension.error && (
                    <button
                      type="button"
                      onClick={() => host.toggleEnabled(extension.id)}
                      className={`h-6 rounded px-2 text-[10.5px] font-semibold transition-colors cursor-pointer ${
                        disabled
                          ? 'bg-pm-hover text-pm-text-muted hover:text-pm-text'
                          : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                      }`}
                    >
                      {disabled ? 'Disabled' : 'Enabled'}
                    </button>
                  )}
                  {extension.source === 'dev' && (
                    <button
                      type="button"
                      onClick={() => host.removeDevPath(extension.path)}
                      title="Remove from the dev list"
                      className="flex h-6 w-6 items-center justify-center rounded text-pm-text-muted transition-colors hover:bg-rose-500/10 hover:text-rose-400 cursor-pointer"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
