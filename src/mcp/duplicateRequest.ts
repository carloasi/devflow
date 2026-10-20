import type { CollectionItem } from '@/app/types/CollectionItem';

// ─────────────────────────────────────────────────────────────────────────
// Cópia de uma request para o servidor MCP.
//
// Existe como ferramenta própria, e não como "leia e recrie", porque a
// leitura é redigida de propósito (ver redactSecrets): client_secret, senha e
// token saem mascarados. Um agente que recriasse a request a partir do que
// enxerga produziria uma cópia sem credencial — silenciosamente quebrada.
//
// Duplicando aqui dentro, os valores reais nunca passam pelo modelo: ele pede
// a cópia, o app copia. O segredo continua inacessível pra ele, e a cópia sai
// completa.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Clona a subárvore inteira com ids novos.
 *
 * Reaproveitar um id não falha de forma visível: `findNodeById` devolve o
 * primeiro que encontra, então renomear a cópia, abrir a cópia ou gravar um
 * script nela acabaria mexendo no original. O sintoma aparece muito depois do
 * erro, por isso cada nó — inclusive os examples filhos e as variáveis de path
 * — recebe id novo.
 */
export function cloneRequestNode(source: CollectionItem, name: string): CollectionItem {
  const clone = structuredClone(source) as CollectionItem;
  return reassignIds({ ...clone, name });
}

function reassignIds(node: CollectionItem): CollectionItem {
  const next: CollectionItem = { ...node, id: crypto.randomUUID() };

  // Favoritar move o item pro topo dos irmãos e guarda a âncora de volta. A
  // cópia entra no FIM da pasta, então herdar a marca deixaria a estrela
  // acesa num item que não está no topo — e a âncora apontaria pro vizinho do
  // original, em outro lugar da árvore.
  delete next.starred;
  delete next.starredAfterId;

  if (next.request?.urlexport?.variable) {
    next.request = {
      ...next.request,
      urlexport: {
        ...next.request.urlexport,
        variable: next.request.urlexport.variable.map(v => ({ ...v, id: crypto.randomUUID() })),
      },
    };
  }

  if (node.item?.length) {
    next.item = node.item.map(reassignIds);
  }

  return next;
}

/**
 * Nome livre dentro da pasta: "X copy", depois "X copy 2", "X copy 3"…
 *
 * Dois irmãos com o mesmo nome não quebram nada na árvore (o id é que
 * identifica), mas quebram o agente: ele localiza request por nome em
 * `list_requests` e `search_requests`, e passaria a escolher entre duas
 * linhas idênticas sem critério.
 */
export function copyName(original: string, siblingNames: string[]): string {
  const taken = new Set(siblingNames);
  const base = `${original} copy`;
  if (!taken.has(base)) return base;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Inalcançável na prática; melhor um nome feio que um laço infinito.
  return `${base} ${crypto.randomUUID().slice(0, 8)}`;
}
