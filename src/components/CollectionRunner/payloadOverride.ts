import type { CollectionItem } from '@/app/types/CollectionItem';
import { VAR_REGEX } from '@/lib/monacoVarHighlight';

// ─────────────────────────────────────────────────────────────────────────────
// Payload editado dentro do Runner, só para esta execução.
//
// O caso: o fluxo rodou, o AirSearch voltou vazio para a data X, e a pergunta
// seguinte é "e com a data Y?". Antes era preciso abrir a request, mudar o
// body (alterando a collection), rodar de novo e lembrar de desfazer. Aqui o
// body editado vive só no estado do painel; a request salva não muda.
//
// Decisão sobre {{variaveis}}: o editor mostra e edita o TEMPLATE (o texto cru
// da request), igual ao que o bloco Payload já exibia. Ao reexecutar, o texto
// editado passa pela MESMA resolução do envio normal (replaceWithEnv + scripts
// de pre-request), então {{token}} continua vindo do environment atual do run
// — editar a data não obriga a colar o token resolvido à mão, e um valor
// digitado no lugar de um {{x}} vale literalmente.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reindenta um JSON que pode ter {{variaveis}} no meio — o que não é JSON
 * válido (nem dentro nem fora de aspas). Cada ocorrência vira um número
 * só-seu antes de parsear e volta ao texto original depois de formatado:
 * funciona tanto entre aspas ("{{x}}" → string) quanto sem (`"n": {{x}}`),
 * porque só o miolo é trocado, nunca as aspas ao redor.
 *
 * Devolve o texto como veio quando não é JSON (ou está quebrado/cortado).
 */
export function prettyBodyPreservingTemplates(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return body;

  const tokens: string[] = [];
  const withPlaceholders = trimmed.replace(new RegExp(VAR_REGEX.source, 'g'), match => {
    const sentinel = `90150${tokens.length}17230`;
    tokens.push(match);
    return sentinel;
  });

  try {
    const pretty = JSON.stringify(JSON.parse(withPlaceholders), null, 2);
    return tokens.reduce((text, token, i) => text.replace(`90150${i}17230`, token), pretty);
  } catch {
    return body;
  }
}

/**
 * Forma comparável de um body: JSON (com templates) reindentado; outro texto
 * só sem espaços nas pontas. Serve para que apertar "Prettify" — ou mudar só
 * a indentação — não conte como edição.
 */
function normalizeBody(body: string): string {
  const pretty = prettyBodyPreservingTemplates(body);
  return pretty === body ? body.trim() : pretty;
}

/** true quando o rascunho muda o CONTEÚDO do body original, não só o layout. */
export function isBodyEdited(original: string, draft: string | undefined): boolean {
  if (draft === undefined) return false;
  return normalizeBody(original) !== normalizeBody(draft);
}

/**
 * O body a usar no próximo envio deste passo: o rascunho quando ele de fato
 * muda o conteúdo, senão `undefined` (= usar o da request salva).
 */
export function effectiveBodyOverride(original: string, draft: string | undefined): string | undefined {
  return isBodyEdited(original, draft) ? draft : undefined;
}

/**
 * Cópia do item com o body trocado — nunca o item da árvore mutado, que é o
 * mesmo objeto da collection salva. Sem override devolve o próprio item.
 */
export function applyBodyOverride(item: CollectionItem, bodyOverride: string | undefined): CollectionItem {
  if (bodyOverride === undefined || !item.request) return item;
  return { ...item, request: { ...item.request, body: bodyOverride } };
}

/**
 * Leva para `target` o que um passo mudou no environment (de `before` para
 * `after`): chaves novas/alteradas e as apagadas. Usado quando um passo roda
 * sozinho com o run pausado — o Resume continua de `target`, e sem isto não
 * veria o token que o passo reexecutado acabou de gravar.
 */
export function applyEnvChanges(
  target: Record<string, string>,
  before: Record<string, string>,
  after: Record<string, string>
): Record<string, string> {
  const next = { ...target };
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) next[key] = value;
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) delete next[key];
  }
  return next;
}
