import type { Tab } from '@/app/types/Tab';

// ─────────────────────────────────────────────────────────────────────────
// A forma de uma aba DENTRO de uma sessão salva.
//
// Uma sessão guarda o conjunto de trabalho — quais requests estavam abertas e
// como estavam —, não o retrato de uma execução. Resposta, tempo e resultado
// de teste são da última vez que alguém apertou Send; restaurar a sessão
// semanas depois e ver aquela resposta congelada não ajuda, e o que importa
// (a request pronta pra enviar) continua lá.
//
// Isto já era a posição do código: a comparação que decide se a sessão tem
// alteração pendente sempre descartou esses três campos. Só a gravação é que
// os guardava — e a conta dessa discordância, num perfil real, era 687 KB de
// 1,08 MB: 63% do arquivo era resposta que ninguém lia.
//
// Nada se perde: o histórico guarda as últimas respostas por request, e quem
// quer um retrato fixo usa Saved Example.
// ─────────────────────────────────────────────────────────────────────────

/** Campos que pertencem à execução, não ao conjunto de trabalho. */
const RUNTIME_FIELDS = ['response', 'responseTime', 'testResults'] as const;

export function stripTabForSession(tab: Tab): Tab {
  const next = { ...tab } as Tab & Record<string, unknown>;
  for (const field of RUNTIME_FIELDS) delete next[field];
  // `response` é obrigatório no tipo Tab, e uma aba restaurada nasce sem
  // resposta como qualquer aba recém-aberta.
  next.response = null;
  return next as Tab;
}

export function stripTabsForSession(tabs: Tab[]): Tab[] {
  return tabs.map(stripTabForSession);
}

/**
 * As abas abertas diferem das que a sessão guardou?
 *
 * Compara pela MESMA forma que é gravada, então "salvou e nada mudou" nunca
 * volta como pendente — era o que acontecia quando gravação e comparação
 * discordavam sobre o que conta.
 */
export function sameSessionTabs(a: Tab[], b: Tab[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(stripTabsForSession(a)) === JSON.stringify(stripTabsForSession(b));
}
