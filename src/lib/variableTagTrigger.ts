// Detecta se o cursor está logo depois de um "{{" ainda não fechado na linha
// — usado pelo editor de Body (Monaco) pra decidir quando abrir o dropdown
// de sugestão de variável. Extraído de HttpBodyEditor.tsx pra poder testar a
// parte sem Monaco: é só string + número de coluna.
export interface VariableTagTrigger {
  /** Índice (na linha) onde o "{{" que disparou o menu começa. */
  openIdx: number;
  /** Texto já digitado entre o "{{" e o cursor, pra pré-filtrar a lista. */
  query: string;
}

/**
 * `column` é 1-based, no mesmo sentido do `Position.column` do Monaco: a
 * coluna N é a lacuna ANTES do N-ésimo caractere (há N-1 caracteres à
 * esquerda do cursor).
 */
export function detectVariableTagTrigger(lineText: string, column: number): VariableTagTrigger | null {
  const before = lineText.slice(0, column - 1);
  const openIdx = before.lastIndexOf('{{');
  const closeIdx = before.lastIndexOf('}}');

  // O "{{" já vem com o "}}" auto-fechado pelo Monaco (par de JSON), então
  // digitar o "}" de fechamento não INSERE nada — só pula por cima do que já
  // estava lá (type-over), deixando o cursor ENTRE os dois "}". Nesse
  // instante `before` só enxerga um "}" (o outro ainda está à frente do
  // cursor) e pareceria uma tag ainda aberta — reabrindo o menu com esse "}"
  // sobrando dentro da busca (query "nome}", sem resultado nenhum). Clicar
  // de volta no meio de uma "{{var}}" já fechada cai no mesmo caso.
  const afterCursor = lineText.charAt(column - 1);
  const cursorBetweenClosingBraces = before.endsWith('}') && afterCursor === '}';

  if (openIdx === -1 || openIdx <= closeIdx || cursorBetweenClosingBraces) return null;

  return { openIdx, query: before.slice(openIdx + 2).trim() };
}
