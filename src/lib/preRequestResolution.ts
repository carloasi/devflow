// ─────────────────────────────────────────────────────────────────────────
// Variáveis criadas/alteradas no pre-request valem na PRÓPRIA request.
//
// O envio resolvia os {{...}} de URL, headers e body ANTES do pre-request e
// não resolvia de novo depois. Resultado: um pm.environment.set("data", ...)
// no pre-request só chegava à request SEGUINTE — diferente do Postman, e o
// motivo de scripts precisarem reescrever pm.request.body na mão.
//
// Agora, depois do pre-request, cada parte da request é decidida assim:
//   • o script NÃO mexeu na parte  → recalculada dos templates com o env
//     novo (pega variáveis novas e valores alterados);
//   • o script mexeu               → fica a versão do script, só com os
//     {{...}} que sobraram resolvidos (respeita o que ele escreveu).
// ─────────────────────────────────────────────────────────────────────────

export interface RequestParts {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function sameHeaders(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => b[k] === a[k]);
}

export function resolveAfterPreRequest(options: {
  // O que foi entregue ao script (resolvido com o env de antes).
  before: RequestParts;
  // O que o script devolveu em pm.request (pode faltar).
  after: Partial<RequestParts> | undefined;
  // Recalcula as partes a partir dos templates da request com um env.
  rebuild: (env: Record<string, string>) => RequestParts;
  env: Record<string, string>;
  resolve: (text: string, env: Record<string, string>) => string;
}): RequestParts {
  const { before, after, env, resolve } = options;

  let rebuilt: RequestParts | null = null;
  const fresh = () => {
    if (!rebuilt) {
      try {
        rebuilt = options.rebuild(env);
      } catch {
        // Ex.: variables do GraphQL viraram JSON inválido com o env novo —
        // fica o que já tinha sido montado antes do script.
        rebuilt = before;
      }
    }
    return rebuilt;
  };

  const url = after?.url && after.url !== before.url ? resolve(after.url, env) : fresh().url;

  const headers =
    after?.headers && !sameHeaders(after.headers, before.headers)
      ? Object.fromEntries(
          Object.entries(after.headers).map(([key, value]) => [resolve(key, env), resolve(String(value ?? ''), env)])
        )
      : fresh().headers;

  const body = after?.body !== undefined && after.body !== before.body ? resolve(after.body, env) : fresh().body;

  return { url, headers, body };
}
