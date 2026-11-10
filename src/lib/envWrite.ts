import type { EnvironmentValue } from '@/app/types/Environment';

// ─────────────────────────────────────────────────────────────────────────
// A regra de "gravar o valor de uma variável num environment".
//
// Saiu do EnvironmentContext pra cá quando o popover de edição rápida da URL
// bar precisou da MESMA regra: ele reconstruía o array à mão e, com isso,
// escrevia em TODAS as entradas de uma key duplicada — inclusive nas
// desabilitadas, que existem justamente pra guardar o valor do outro
// ambiente. Duas implementações da mesma coisa é como a primeira voltou a
// divergir depois de corrigida uma vez.
//
// O que a regra protege, em ordem:
//   1. a entrada HABILITADA da key é a que recebe o valor — é ela que o
//      replaceVariables resolve;
//   2. não havendo habilitada, a primeira com aquela key é reativada;
//   3. não havendo nenhuma, cria uma nova COM id (o painel de Environment
//      usa o id como chave de lista) e com os campos que o formato Postman
//      espera.
// Todo o resto do array fica intocado.
// ─────────────────────────────────────────────────────────────────────────

export interface EnvLoss {
  /** removed = a entrada saiu; blanked = o valor virou vazio. */
  kind: 'removed' | 'blanked';
  key: string;
  /** O que havia antes — o que se perdeu. */
  previous: string;
}

/**
 * @param previousMap valores de antes. Uma key presente aqui e ausente de
 *        `currentMap` é REMOVIDA — é assim que um `pm.environment.unset()`
 *        chega. Passe `{}` quando a intenção é só gravar.
 */
export function applyEnvPatch(
  values: EnvironmentValue[],
  previousMap: Record<string, string>,
  currentMap: Record<string, string>
): EnvironmentValue[] {
  const next = [...values];

  Object.keys(previousMap).forEach(key => {
    if (key in currentMap) return;
    const idx = next.findIndex(v => v.key === key && v.enabled);
    if (idx !== -1) next.splice(idx, 1);
  });

  Object.entries(currentMap).forEach(([key, value]) => {
    // Nada mudou: sair sem tocar no array evita marcar o environment como
    // sujo (e pedir push) por uma gravação que não gravou nada.
    if (previousMap[key] === value) return;

    const enabledIdx = next.findIndex(v => v.key === key && v.enabled);
    if (enabledIdx !== -1) {
      next[enabledIdx] = { ...next[enabledIdx], value: String(value) };
      return;
    }

    const anyIdx = next.findIndex(v => v.key === key);
    if (anyIdx !== -1) {
      next[anyIdx] = { ...next[anyIdx], value: String(value), enabled: true };
      return;
    }

    next.push({
      id: crypto.randomUUID(),
      key,
      value: String(value),
      type: 'default',
      enabled: true,
      description: '',
    });
  });

  return next;
}

/**
 * Quais valores ESTA gravação vai destruir — sem gravar nada.
 *
 * Separado do applyEnvPatch de propósito. O applyEnvPatch roda dentro do
 * updater do `setState`, que precisa ser uma função pura: o React pode
 * chamá-lo duas vezes, e pode chamá-lo durante o render de outro componente.
 * Avisar de dentro dele era um `setState` no meio do render — o erro
 * "Cannot update a component while rendering a different component".
 *
 * Quem avisa chama isto ANTES, fora do updater, e aí pode registrar no
 * console, no log do app, no que for.
 */
export function detectEnvLosses(
  values: EnvironmentValue[],
  previousMap: Record<string, string>,
  currentMap: Record<string, string>
): EnvLoss[] {
  const losses: EnvLoss[] = [];

  for (const key of Object.keys(previousMap)) {
    if (key in currentMap) continue;
    const entry = values.find(v => v.key === key && v.enabled);
    if (entry) losses.push({ kind: 'removed', key, previous: entry.value });
  }

  for (const [key, value] of Object.entries(currentMap)) {
    if (previousMap[key] === value) continue;
    const entry = values.find(v => v.key === key && v.enabled);
    // Apagar o conteúdo é tão destrutivo quanto remover a entrada, e na tela
    // dá no mesmo: a {{variavel}} fica vermelha. Anuncia igual.
    if (entry && entry.value.trim() && !String(value).trim()) {
      losses.push({ kind: 'blanked', key, previous: entry.value });
    }
  }

  return losses;
}
