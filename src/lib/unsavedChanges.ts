import type { CollectionItem } from '@/app/types/CollectionItem';
import { fieldDiffs } from './collectionDiff';

// ─────────────────────────────────────────────────────────────────────────
// O que exatamente está por salvar numa aba.
//
// O aviso de fechar dizia só "suas alterações serão perdidas" — e a decisão
// que ele pede depende justamente do que ninguém via. Mexer na URL por
// engano e mexer no corpo de propósito levam à mesma frase, então o caminho
// seguro acabava sendo sempre "Save", inclusive quando a alteração era lixo.
//
// Reaproveita o fieldDiffs da comparação com o GitHub: é a mesma pergunta —
// quais campos DO PRÓPRIO nó diferem — e manter duas respostas para ela seria
// deixá-las divergir.
// ─────────────────────────────────────────────────────────────────────────

/** Nome do campo como a pessoa o vê na tela, não como o modelo o chama. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  method: 'Method',
  url: 'URL',
  headers: 'Headers',
  body: 'Body',
  auth: 'Auth',
  preRequestScript: 'Pre-request script',
  postResponseScript: 'Post-response script',
  example: 'Example',
  order: 'Order',
};

/**
 * Campos alterados entre o que está salvo e o que seria gravado.
 *
 * `saved` ausente significa request que não está mais na árvore — aí não há
 * com o que comparar, e dizer "nada mudou" seria pior que não dizer nada.
 */
export function changedFieldLabels(
  saved: CollectionItem | undefined,
  next: CollectionItem | undefined
): string[] {
  if (!saved || !next) return [];

  return fieldDiffs(saved, next)
    // Campo que estava ausente e virou vazio não é alteração nenhuma. A aba
    // sempre manda `scripts: { preRequest, postResponse }`, então editar só o
    // de pré-requisição fazia o outro — que nunca existiu — aparecer como
    // alterado. Num aviso cuja função é ser preciso, isso é ruído.
    .filter(d => !(isBlank(d.local) && isBlank(d.remote)))
    .map(d => FIELD_LABELS[d.field] ?? d.field);
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Lista legível: "URL, Headers and Body".
 *
 * Com muitos campos a frase deixa de informar e vira parede, então corta.
 */
export function describeChanges(labels: string[], max = 4): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];

  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;

  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}
