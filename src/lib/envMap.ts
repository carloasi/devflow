import type { EnvironmentValue } from '@/app/types/Environment';

// ─────────────────────────────────────────────────────────────────────────
// Monta o mapa {key: value} que resolve {{variáveis}} em toda execução —
// Send, Collection Runner, teste de carga, OAuth2 e ferramentas do MCP.
//
// Existe como função única porque a mesma expressão estava copiada em dez
// lugares, e as cópias discordavam do código que ESCREVE no environment.
//
// O app permite a mesma key em mais de uma entrada de propósito (ver
// DuplicateVariablePicker): guarda-se várias e habilita-se a que vale. Quando
// mais de uma fica habilitada — o que acontece importando de fora, ou
// habilitando a segunda sem desabilitar a primeira — alguém precisa decidir
// qual vence, e as duas metades do app decidiam diferente:
//
//   • leitura:  Object.fromEntries(...)  ficava com a ÚLTIMA
//   • escrita:  findIndex(v.enabled)     mexia na PRIMEIRA
//
// Na prática isso fazia pm.environment.set("token", x) gravar numa entrada e
// a request seguinte ler a outra — ou seja, o fluxo continuava mandando o
// valor velho, sem nada na tela indicando o porquê.
//
// A PRIMEIRA habilitada vence, que é o lado que já era usado para escrever e
// o que a lista mostra primeiro.
// ─────────────────────────────────────────────────────────────────────────

export function buildEnvMap(values: EnvironmentValue[] | undefined | null): Record<string, string> {
  const map: Record<string, string> = {};
  for (const v of values ?? []) {
    if (!v.enabled || !v.key) continue;
    if (v.key in map) continue;
    map[v.key] = String(v.value);
  }
  return map;
}

/** Keys com mais de uma entrada habilitada — estado ambíguo que o app
 *  resolve escolhendo a primeira, mas que quase sempre é engano do usuário. */
export function findAmbiguousKeys(values: EnvironmentValue[] | undefined | null): string[] {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const v of values ?? []) {
    if (!v.enabled || !v.key) continue;
    if (seen.has(v.key)) ambiguous.add(v.key);
    seen.add(v.key);
  }
  return [...ambiguous];
}
