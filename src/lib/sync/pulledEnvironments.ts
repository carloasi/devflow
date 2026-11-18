import type { Environment } from '@/app/types/Environment';
import { isSessionToken } from '@/lib/jwt';

// ─────────────────────────────────────────────────────────────────────────
// O que é DESTA máquina e sobrevive a um pull que substitui os environments.
//
// O push sobe o token de sessão vazio (lib/jwt.withoutSessionTokens: é de
// cada pessoa e expira). Os pulls que substituem os environments inteiros
// gravavam esse vazio por cima do token daqui — depois de todo Pull era
// preciso autenticar de novo. A cor do environment também é escolha local,
// e voltava sem cor.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Os environments que chegaram do GitHub, com o token de sessão e a cor
 * daqui de volta. O environment daqui é casado pelo id e, sem ele, pelo
 * nome; a variável, pela key. O token só volta quando o de lá veio VAZIO —
 * um valor de verdade lá é escolha de quem enviou.
 */
export function withLocalOnlyValues(incoming: Environment[], local: Environment[]): Environment[] {
  if (local.length === 0) return incoming;
  const byId = new Map(local.map(e => [e.id, e]));
  const byName = new Map(local.map(e => [e.name, e]));
  return incoming.map(env => {
    const mine = byId.get(env.id) ?? byName.get(env.name);
    if (!mine) return env;
    const tokens = new Map(
      (mine.values ?? []).filter(v => isSessionToken(v.key, v.value)).map(v => [v.key, v.value])
    );
    const values = tokens.size === 0
      ? env.values
      : env.values.map(v => (!v.value && tokens.has(v.key) ? { ...v, value: tokens.get(v.key)! } : v));
    return {
      ...env,
      values,
      ...(env.color === undefined && mine.color !== undefined ? { color: mine.color } : {}),
    };
  });
}
