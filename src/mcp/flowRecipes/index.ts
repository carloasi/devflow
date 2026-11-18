import authB2b from './auth-b2b.json';
import authMsal from './auth-msal.json';
import posVenda from './b2b-pos-venda.json';
import reservaHold from './b2b-reserva-hold.json';
import reservaPaga from './b2b-reserva-paga.json';
import reserva24h from './b2b-reserva-partida-24h.json';
import gruposPedido from './grupos-cotacao-pedido.json';
import { authBlockSteps } from './applyRecipe';

// ─────────────────────────────────────────────────────────────────────────
// Receitas de flow servidas pelo MCP (list_flow_recipes / get_flow_recipe).
//
// Uma receita é um flow inteiro, pronto: os passos na ordem, de onde copiar
// cada request, o que cada passo consome e produz, os scripts e as perguntas
// obrigatórias. Viviam só na skill do Claude Code; servidas pelo app, qualquer
// cliente do MCP (outra IA, outro editor) recebe a mesma receita, sempre a da
// versão instalada.
//
// Os JSON são os mesmos da skill `criar-fluxo-devflow` (recipes/ e
// references/grupos/auth-*.json). Ao mudar um, mude o outro.
// ─────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

interface RecipeEntry {
  recipe: Json;
  /** Palavras do pedido que levam a esta receita. */
  triggers: string[];
  /** confirmed = passos verificados; partial = há passos "A LEVANTAR". */
  status: 'confirmed' | 'partial';
}

const RECIPES: RecipeEntry[] = [
  {
    recipe: reserva24h,
    triggers: ['reserva com partida em menos de 24h', 'voo de hoje ou amanhã', 'em cima da hora', 'menos de 24 horas'],
    status: 'confirmed',
  },
  { recipe: reservaHold, triggers: ['reserva em hold', 'sem pagar', 'reserva pendente', 'reserva'], status: 'confirmed' },
  { recipe: reservaPaga, triggers: ['reserva paga', 'com pagamento', 'emitir', 'emissão'], status: 'confirmed' },
  {
    recipe: posVenda,
    triggers: ['pós-venda', 'cancelamento', 'remarcação', 'assento, bagagem ou serviço depois da reserva'],
    status: 'partial',
  },
  {
    recipe: gruposPedido,
    triggers: ['cotação de grupo', 'quote', 'pedido de grupo', 'Portal de Grupos', 'checkout do pedido'],
    status: 'confirmed',
  },
];

export const AUTH_BLOCKS: Record<string, Json> = {
  'references/grupos/auth-msal.json': authMsal,
  'references/grupos/auth-b2b.json': authB2b,
};

/** Como aplicar uma receita (o mesmo texto da skill, curto). */
export const RECIPE_RULES = [
  'FAST PATH: ask the user the questions in "ask" that the request has not answered (ONE round), then call create_flow_from_recipe with the answers — the app copies every source request, the reference scripts and the auth block, fills route/pax, numbers the folder and validates. Use dryRun first if a step is "A LEVANTAR" and you want to see what it resolved. The rules below are for building the steps by hand (create_flow).',
  'First look up the sources (get_request, reference flow, examples) without reading variable values; then ask, in ONE round and before creating anything, the questions in "ask" that the request has not already answered (e.g. "reserva paga" answers hold x paga, "cancelamento com reembolso" answers the post-sale action, "Auth: msal" answers authentication). Do not add questions the recipe already fixes.',
  'Steps from the matching "include" block come FIRST, then "steps", in order.',
  'A step with "when" goes in only if the answer matches (e.g. "payment == paga").',
  'For each step: pass "copyFrom" as it is to create_flow (the app copies method, url, headers, auth and body — no get_request needed); the recipe "body" (and url, auth, pathParams when present) replaces the copied one; use the recipe scripts EXACTLY as written; pass "scriptsFrom" as it is to copy the reference flow scripts. A <<id>> marker is the answer to the "ask" question id (<<route.origin>>, <<pax.number>>…): replace it.',
  'A step with status "A LEVANTAR" has unconfirmed details: find the source request and the reference flow ("scriptsFrom") with list_folders/list_requests/get_request; if you are not sure, STOP and ask the user. Never guess a URL, header, body or JSON path.',
  'A script with a CONFIRMAR block: confirm each value (get_last_run, get_example or the reference flow) before creating. "Use the recommended" does not confirm a JSON path: without confirmation, do not create and say what is missing.',
  'Never reset (set to "") a variable the step itself consumes (e.g. GET Order/{recordLocator} v3 reads {{recordLocator}} in its URL and saves it again; Checkout v1 does NOT — it closes the session order and only produces recordLocator): the reset belongs to the step that first creates it.',
  'Create everything with ONE create_flow call ("tool": "duplicate_request" becomes {"duplicateFrom": <its copyFrom>}; step names without numbers — create_flow numbers them), then fix every problem in "check".',
  'Do not run the flow unless the user asks: running creates real data.',
];

function idOf(recipe: Json): string {
  return String(recipe.id ?? '');
}

export function listFlowRecipes() {
  return RECIPES.map(({ recipe, triggers, status }) => ({
    id: idOf(recipe),
    title: String(recipe.title ?? ''),
    context: String(recipe.context ?? ''),
    status,
    triggers,
  }));
}

/** A receita como está no JSON (para o create_flow_from_recipe). */
export function getRawRecipe(id: string): Json {
  const entry = RECIPES.find(r => idOf(r.recipe) === id);
  if (!entry) {
    throw new Error(`Recipe "${id}" not found. Available: ${RECIPES.map(r => idOf(r.recipe)).join(', ')}.`);
  }
  return entry.recipe;
}

/**
 * A receita completa, com os blocos de `include` já resolvidos em passos do
 * create_flow — tudo numa resposta só.
 */
export function getFlowRecipe(id: string) {
  const entry = RECIPES.find(r => idOf(r.recipe) === id);
  if (!entry) {
    throw new Error(`Recipe "${id}" not found. Available: ${RECIPES.map(r => idOf(r.recipe)).join(', ')}.`);
  }
  const includes = (entry.recipe.include as { when: string; file: string }[] | undefined) ?? [];
  return {
    ...entry.recipe,
    status: entry.status,
    include: includes.map(({ when, file }) => {
      const block = AUTH_BLOCKS[file];
      return block ? { when, comment: block._comment, steps: authBlockSteps(block) } : { when, file, missing: true };
    }),
    rules: RECIPE_RULES,
  };
}
