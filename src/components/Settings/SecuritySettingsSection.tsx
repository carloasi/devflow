'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SettingsToggle } from './SettingsToggle';
import { SecretScanPanel } from './SecretScanPanel';
import type { CollectionItem } from '@/app/types/CollectionItem';

interface Props {
  // A varredura precisa da árvore, que vive no AppLayout — mesma razão do
  // mcp e do host de extensões chegarem por prop.
  collections?: CollectionItem[];
  onApplySecrets?: (
    roots: CollectionItem[],
    variables: { key: string; value: string }[]
  ) => Promise<void> | void;
}

export function SecuritySettingsSection({ collections, onApplySecrets }: Props = {}) {
  const [verifySSL, setVerifySSL] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<boolean>('get_ssl_verification')
      .then(setVerifySSL)
      .catch((err) => console.error('Erro ao carregar setting SSL:', err))
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = async (value: boolean) => {
    // Optimistic UI
    const previous = verifySSL;
    setVerifySSL(value);
    setSaving(true);

    try {
      await invoke('set_ssl_verification', { value });
    } catch (err) {
      console.error('Erro ao salvar setting SSL:', err);
      setVerifySSL(previous); // rollback
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-pm-text-muted py-3">Loading...</div>;
  }

  return (
    <div className="mt-5 pt-5 border-t border-pm-border">
      <h3 className="text-sm font-semibold text-pm-text mb-2">
        Security
      </h3>

      <SettingsToggle
        label="Verify SSL certificate"
        description="Disable only in test environments with a corporate certificate (MITM proxy) not trusted by the system."
        checked={verifySSL}
        onChange={handleToggle}
        disabled={saving}
      />

      {!verifySSL && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-yellow-950/40 border border-yellow-900/60 px-3 py-2">
          <span className="text-yellow-500 text-sm">⚠️</span>
          <p className="text-xs text-yellow-400">
            SSL certificate verification is disabled. All requests will
            accept invalid certificates, including possible
            man-in-the-middle attacks. Use only on trusted networks.
          </p>
        </div>
      )}
      {collections && onApplySecrets && (
        <SecretScanPanel collections={collections} onApply={onApplySecrets} />
      )}

    </div>
  );
}