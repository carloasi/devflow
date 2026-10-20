// ─────────────────────────────────────────────────────────────────────────
// Histórico de valores anteriores de cada variável de environment.
//
// Valor em branco não entra. Restaurá-lo só apagaria o valor atual, que é o
// contrário do que a lista serve — e ele aparecia por acaso: toda vez que
// alguém preenchia uma variável criada vazia, o valor anterior registrado
// antes da edição era "".
// ─────────────────────────────────────────────────────────────────────────

export type VariableHistory = Record<string, string[]>;

export function isBlankValue(value: string): boolean {
  return value.trim() === '';
}

/**
 * Lê o que estava salvo, descartando os vazios.
 *
 * A limpeza acontece na LEITURA, e não só na gravação, porque quem já usou o
 * app tem entradas vazias no disco e elas não sairiam sozinhas. Também
 * tolera conteúdo fora do formato: a chave é de localStorage, onde uma versão
 * anterior pode ter gravado outra coisa, e quebrar a leitura derrubaria o
 * histórico inteiro por causa de uma entrada ruim.
 */
export function sanitizeVariableHistory(stored: unknown): VariableHistory {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};

  const out: VariableHistory = {};
  for (const [key, values] of Object.entries(stored as Record<string, unknown>)) {
    if (!key || !Array.isArray(values)) continue;
    out[key] = values.filter((v): v is string => typeof v === 'string' && !isBlankValue(v));
  }
  return out;
}
