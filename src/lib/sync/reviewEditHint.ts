// ─────────────────────────────────────────────────────────────────────────
// "Editar na revisão": ponte da janela de diferença (simulação) pra revisão
// do merge de verdade (SyncDiffDialog).
//
// A simulação não pode ser editada: o texto dela é a PRÉVIA do aviso —
// segredos mascarados ("eyJ0eX…6LRQ (2022 chars)") e campos longos cortados
// (remoteChangeAlert.clip). Gravar uma edição feita ali poria o token
// mascarado no lugar do real. Então o botão só deixa um recado — qual item e
// qual campo — e abre a revisão, que lê o recado ao abrir e já entra com o
// resultado daquele campo em edição, sobre os valores reais.
//
// O recado vence: se a revisão não abrir logo (o pull resolveu sem conflito,
// ou a pessoa desistiu), ele não pode pular numa revisão aberta muito depois.
// ─────────────────────────────────────────────────────────────────────────

export interface ReviewEditHint {
  itemId: string;
  field: string;
}

/** Quanto o recado vale depois de deixado. */
export const REVIEW_EDIT_HINT_TTL_MS = 2 * 60_000;

let pending: (ReviewEditHint & { at: number }) | null = null;

export function requestReviewEdit(hint: ReviewEditHint, now: number = Date.now()): void {
  pending = { ...hint, at: now };
}

/**
 * Lê e consome o recado, se ainda vale e se o item está entre os da revisão
 * aberta. Sem o item, o recado é descartado mesmo assim: era pra outra revisão.
 */
export function takeReviewEdit(
  hasItem: (itemId: string) => boolean,
  now: number = Date.now()
): ReviewEditHint | null {
  const hint = pending;
  pending = null;
  if (!hint || now - hint.at > REVIEW_EDIT_HINT_TTL_MS || !hasItem(hint.itemId)) return null;
  return { itemId: hint.itemId, field: hint.field };
}
