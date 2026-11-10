import { CollectionItem } from '@/app/types/CollectionItem';
import { isTokenStep } from '@/lib/oauth2Token';
import { runCollectionRequest, RunItemOutcome } from '@/components/CollectionRunner/runCollectionRequest';

// ─────────────────────────────────────────────────────────────────────────
// Passos de token (OAuth 2.0 sem URL) num teste de carga.
//
// O motor de carga só sabe mandar HTTP, e um passo de token não é um envio: é
// a configuração do login MSAL/Azure AD que enche {{msal}} pros passos
// seguintes. Antes o flow inteiro era recusado com "empty URL" — justamente os
// fluxos de Grupos, que todos começam assim.
//
// Aqui o token é obtido UMA vez, antes da carga (reaproveitando o que ainda
// vale, como o Runner faz), entra no environment do teste e o passo sai do
// flow. Todas as VUs usam o mesmo token, que é o que um login interativo
// permite de qualquer forma.
// ─────────────────────────────────────────────────────────────────────────

export interface TokenStepsResult {
  /** Requests que vão pro motor de carga, sem os passos de token. */
  requests: CollectionItem[];
  /** Environment de partida da carga, já com os tokens. */
  envMap: Record<string, string>;
  /** Um resultado por passo de token resolvido, na ordem do flow. */
  tokenSteps: { item: CollectionItem; outcome: RunItemOutcome }[];
}

export async function resolveTokenSteps(
  items: CollectionItem[],
  envMap: Record<string, string>
): Promise<TokenStepsResult> {
  let env = envMap;
  const tokenSteps: TokenStepsResult['tokenSteps'] = [];
  const requests: CollectionItem[] = [];

  for (const item of items) {
    if (!isTokenStep(item.request)) {
      requests.push(item);
      continue;
    }
    const outcome = await runCollectionRequest(item, env);
    if (outcome.status === 'error') {
      throw new Error(`Could not get the token of "${item.name}": ${outcome.errorMessage ?? 'unknown error'}`);
    }
    env = outcome.envAfter;
    tokenSteps.push({ item, outcome });
  }

  return { requests, envMap: env, tokenSteps };
}
