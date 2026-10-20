import type { CollectionItem } from '@/app/types/CollectionItem';
import { fingerprintRoots, diffRoots } from './collectionFingerprint';

// ─────────────────────────────────────────────────────────────────────────
// Compara a árvore local com a que está no GitHub.
//
// Reaproveita a mesma impressão usada pra detectar pendência local
// (collectionFingerprint): ela é tirada do conteúdo já sem as marcas de
// favorito, ou seja, exatamente do que o push grava. Usar outra regra aqui
// faria o app dizer "mudou" por causa de um campo que nunca sobe — e a
// comparação perderia a confiança logo no primeiro uso.
//
// Isto responde só "o que difere". Qual lado está mais novo, e o que fazer a
// respeito, são as etapas seguintes.
// ─────────────────────────────────────────────────────────────────────────

export interface WorkspaceComparison {
  /** Existem nos dois lados, com conteúdo diferente. */
  modified: string[];
  /** Só no remoto — um pull traria. */
  onlyRemote: string[];
  /** Só no local — nunca foram enviadas, ou foram apagadas lá. */
  onlyLocal: string[];
  identical: number;
}

export function compareWorkspaces(
  local: CollectionItem[] | undefined | null,
  remote: CollectionItem[] | undefined | null
): WorkspaceComparison {
  // Canônico dos dois lados: o remoto vem reconstruído pelo importData, e a
  // forma literal acusaria diferença em toda collection, sempre.
  const localPrints = fingerprintRoots(local, true);
  const remotePrints = fingerprintRoots(remote, true);

  // diffRoots("de" → "para"): tratando o local como o estado antigo e o
  // remoto como o novo, `changed` reúne modificadas e só-remotas, e
  // `removed` é o que existe só aqui. Separar as duas primeiras exige olhar
  // quem está dos dois lados.
  const { changed, removed } = diffRoots(localPrints, remotePrints);

  const modified = changed.filter(id => localPrints.has(id));
  const onlyRemote = changed.filter(id => !localPrints.has(id));

  let identical = 0;
  for (const [id, print] of localPrints) {
    if (remotePrints.get(id) === print) identical++;
  }

  return { modified, onlyRemote, onlyLocal: removed, identical };
}

export function hasDifferences(c: WorkspaceComparison): boolean {
  return c.modified.length > 0 || c.onlyRemote.length > 0 || c.onlyLocal.length > 0;
}

/**
 * Frase curta pro painel de sync. Nomeia as collections quando são poucas:
 * "2 collections differ" não ajuda a decidir nada, e descobrir quais exigiria
 * justamente o pull que se está tentando evitar.
 */
export function describeComparison(
  comparison: WorkspaceComparison,
  nameOf: (id: string) => string | undefined
): string {
  if (!hasDifferences(comparison)) {
    return comparison.identical === 0
      ? 'Nothing to compare yet.'
      : `Up to date — ${comparison.identical} collection(s) match GitHub.`;
  }

  const parts: string[] = [];
  const list = (ids: string[]) =>
    ids.length <= 3
      ? ids.map(id => `"${nameOf(id) ?? id}"`).join(', ')
      : `${ids.length} collections`;

  if (comparison.modified.length > 0) parts.push(`${list(comparison.modified)} changed on GitHub`);
  if (comparison.onlyRemote.length > 0) parts.push(`${list(comparison.onlyRemote)} only on GitHub`);
  if (comparison.onlyLocal.length > 0) parts.push(`${list(comparison.onlyLocal)} only here`);

  return parts.join(' · ');
}
