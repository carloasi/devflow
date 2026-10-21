'use client';

import { useMemo, useState } from 'react';
import { KeyRound, Loader2, ShieldAlert, Trash2, Variable } from 'lucide-react';
import type { CollectionItem } from '@/app/types/CollectionItem';
import {
  applySecretActions,
  scanTree,
  summarizeFindings,
  type SecretFinding,
} from '@/lib/secretScan';

// ─────────────────────────────────────────────────────────────────────────
// Credenciais escritas direto nas requests.
//
// A lista separa expirado de ainda válido porque a ação é outra: token morto
// se apaga em bloco — numa base real eram 338, mediana de 328 dias desde a
// expiração, nenhum ainda funcionando —, e credencial viva vira variável, uma
// decisão por vez.
//
// O valor real nunca é exibido: a lista mostra só as pontas e o tamanho, e a
// extração lê o valor da árvore na hora de aplicar.
// ─────────────────────────────────────────────────────────────────────────

interface Props {
  collections: CollectionItem[];
  /** Grava a árvore corrigida e cria as variáveis extraídas no environment. */
  onApply: (
    roots: CollectionItem[],
    variables: { key: string; value: string }[]
  ) => Promise<void> | void;
}

export function SecretScanPanel({ collections, onApply }: Props) {
  const [findings, setFindings] = useState<SecretFinding[] | null>(null);
  // Cópia de trabalho da árvore, tirada na varredura.
  //
  // Cada correção parte do resultado da anterior, e não da prop: duas ações
  // seguidas rodavam ambas sobre a árvore original, e a segunda desfazia a
  // primeira. Depender de a prop voltar atualizada a tempo é depender de
  // quem chama — e quem chama pode só gravar e não devolver.
  const [working, setWorking] = useState<CollectionItem[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState('');

  const summary = useMemo(
    () => (findings ? summarizeFindings(findings) : null),
    [findings]
  );

  const handleScan = () => {
    setScanning(true);
    setDone('');
    // Num tique: a varredura percorre milhares de nós e bloquearia o clique.
    setTimeout(() => {
      setWorking(collections);
      setFindings(scanTree(collections));
      setScanning(false);
    }, 0);
  };

  const apply = async (
    decisions: Parameters<typeof applySecretActions>[1],
    message: string
  ) => {
    if (decisions.length === 0) return;
    setApplying(true);
    try {
      const result = applySecretActions(working ?? collections, decisions);
      await onApply(result.roots, result.variables);
      setWorking(result.roots);
      // Varre de novo em vez de remover da lista na mão: o que sobrou é o que
      // a árvore nova diz, e não o que esta tela acha que sobrou.
      setFindings(scanTree(result.roots));
      setDone(message);
    } finally {
      setApplying(false);
    }
  };

  const clearExpired = () =>
    apply(
      (findings ?? [])
        .filter(f => f.expired === true)
        .map(f => ({ finding: f, action: { type: 'clear' as const } })),
      'Expired tokens cleared.'
    );

  const extract = (finding: SecretFinding) =>
    apply(
      [{ finding, action: { type: 'extract', variable: finding.suggestedVariable } }],
      `Moved to {{${finding.suggestedVariable}}}.`
    );

  const busy = scanning || applying;

  return (
    <div className="border-t border-pm-border pt-4 mt-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-pm-text">Hard-coded credentials</p>
          <p className="text-xs text-pm-text-muted mt-0.5">
            Tokens, keys and passwords written straight into a request instead of{' '}
            <code className="text-[11px]">{'{{a variable}}'}</code>. Expired ones only
            produce confusing 401s; live ones travel to GitHub on every push.
          </p>
        </div>
        <button
          onClick={handleScan}
          disabled={busy}
          className="shrink-0 h-7 px-3 rounded-md text-xs font-medium border border-pm-border text-pm-text-secondary hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer disabled:opacity-50"
        >
          {scanning ? <Loader2 size={13} className="animate-spin" /> : findings ? 'Scan again' : 'Scan workspace'}
        </button>
      </div>

      {summary && (
        <div className="mt-3">
          {summary.total === 0 ? (
            <p className="text-xs text-[#4ff09d]">
              No hard-coded credentials found in this workspace.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-pm-text-secondary">
                  <span className="font-semibold text-pm-text">{summary.total}</span> found
                </span>
                {summary.expired > 0 && (
                  <span className="text-pm-text-muted">
                    <span className="font-semibold text-pm-text-secondary">{summary.expired}</span> expired
                  </span>
                )}
                {summary.live > 0 && (
                  <span className="text-amber-400">
                    <span className="font-semibold">{summary.live}</span> still live
                  </span>
                )}

                {summary.expired > 0 && (
                  <button
                    onClick={clearExpired}
                    disabled={busy}
                    title="Clear every expired token — they cannot work any more"
                    className="ml-auto flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11px] border border-pm-border bg-pm-hover text-pm-text-secondary hover:text-pm-text transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 size={11} />
                    Clear {summary.expired} expired
                  </button>
                )}
              </div>

              {done && <p className="mt-2 text-[11px] text-[#4ff09d]">{done}</p>}

              <div className="mt-2 max-h-72 overflow-y-auto rounded-md border border-pm-border divide-y divide-pm-border/60">
                {findings!.map((f, i) => (
                  <div key={`${f.requestId}-${i}`} className="px-2.5 py-2 flex items-start gap-2">
                    {f.expired === true ? (
                      <ShieldAlert size={13} className="mt-0.5 shrink-0 text-pm-text-muted" />
                    ) : (
                      <KeyRound size={13} className="mt-0.5 shrink-0 text-amber-400" />
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="text-[11.5px] text-pm-text truncate" title={f.path.join(' / ')}>
                        {f.requestName}
                      </div>
                      <div className="text-[10px] text-pm-text-muted truncate">
                        {f.path.slice(0, -1).join(' / ')}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] font-mono text-pm-text-secondary">
                          {f.location.type === 'header'
                            ? f.location.key
                            : f.location.type === 'oauth2'
                              ? `oauth2 · ${f.location.key}`
                              : `auth · ${f.location.field}`}
                        </span>
                        <span className="text-[10px] font-mono text-pm-text-muted">{f.preview}</span>
                        {f.expired === true && (
                          <span className="text-[9.5px] rounded-sm bg-pm-border px-1 text-pm-text-muted">
                            expired {f.expiredDaysAgo}d ago
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      onClick={() => extract(f)}
                      disabled={busy}
                      title={`Move the value into {{${f.suggestedVariable}}} and reference it here`}
                      className="shrink-0 flex items-center gap-1 h-6 px-2 rounded text-[10px] border border-pm-border text-pm-text-secondary hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer disabled:opacity-50"
                    >
                      <Variable size={10} />
                      {f.suggestedVariable}
                    </button>
                  </div>
                ))}
              </div>

              <p className="mt-2 text-[10.5px] text-pm-text-muted">
                Extracting writes the value into the active environment and leaves{' '}
                <code className="text-[10px]">{'{{name}}'}</code> in the request. The value
                itself is read from the tree at that moment — it never appears in this list.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
