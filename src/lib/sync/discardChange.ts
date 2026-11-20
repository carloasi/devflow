import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import { applyEnvironmentChanges, diffEnvironments } from '@/lib/environmentDiff';
import { withoutSessionTokens } from '@/lib/jwt';
import { withLocalOnlyValues } from './pulledEnvironments';

// ─────────────────────────────────────────────────────────────────────────
// "Descartar" da Central de Sincronização: um item daqui volta a ser como
// está no GitHub. Novo aqui → some; apagado aqui → volta; alterado ou movido
// → fica igual ao de lá (conteúdo E lugar). Só a árvore local muda: nada é
// enviado.
//
// E o conteúdo de um item como texto, pra Central mostrar o que é um item
// novo ou apagado (que não tem diff de campo — antes a linha nem abria).
// ─────────────────────────────────────────────────────────────────────────

export type DiscardAction = 'deleted' | 'restored' | 'reverted' | 'none';

interface Location {
  parentId: string | null;
  index: number;
}

function locate(tree: CollectionItem[], id: string, parentId: string | null = null): Location | null {
  for (let i = 0; i < tree.length; i++) {
    const item = tree[i];
    if (item.id === id) return { parentId, index: i };
    const below = item.item ? locate(item.item, id, item.id) : null;
    if (below) return below;
  }
  return null;
}

export function findItem(tree: CollectionItem[], id: string): CollectionItem | undefined {
  for (const item of tree) {
    if (item.id === id) return item;
    const below = item.item ? findItem(item.item, id) : undefined;
    if (below) return below;
  }
  return undefined;
}

function removeIds(tree: CollectionItem[], ids: Set<string>): CollectionItem[] {
  return tree
    .filter(item => !ids.has(item.id))
    .map(item => (item.item ? { ...item, item: removeIds(item.item, ids) } : item));
}

function insertAt(tree: CollectionItem[], parentId: string | null, index: number, node: CollectionItem): CollectionItem[] {
  if (parentId === null) {
    const next = [...tree];
    next.splice(Math.min(Math.max(index, 0), next.length), 0, node);
    return next;
  }
  return tree.map(item => {
    if (item.id === parentId) {
      const children = [...(item.item ?? [])];
      children.splice(Math.min(Math.max(index, 0), children.length), 0, node);
      return { ...item, item: children };
    }
    return item.item ? { ...item, item: insertAt(item.item, parentId, index, node) } : item;
  });
}

function idsOf(node: CollectionItem, out = new Set<string>()): Set<string> {
  out.add(node.id);
  for (const child of node.item ?? []) idsOf(child, out);
  return out;
}

/** Caminho de nomes até o item numa árvore (da collection até ele), ou null. */
export function namePathIn(tree: CollectionItem[], id: string): string[] | null {
  for (const item of tree) {
    if (item.id === id) return [item.name];
    const below = item.item ? namePathIn(item.item, id) : null;
    if (below) return [item.name, ...below];
  }
  return null;
}

/**
 * O item `id` daqui volta a ser o do GitHub. Pasta volta com o que tinha
 * dentro lá — e o que estava dentro dela lá mas foi movido pra outro lugar
 * aqui volta pra dentro dela (senão ficaria duplicado). O que foi CRIADO aqui
 * dentro dela fica (ver keepCreatedHere).
 */
export function discardLocalChange(
  local: CollectionItem[],
  remote: CollectionItem[],
  id: string
): { tree: CollectionItem[]; action: DiscardAction } {
  const mine = findItem(local, id);
  const theirs = findItem(remote, id);
  if (!mine && !theirs) return { tree: local, action: 'none' };
  // Só existe aqui: criado aqui, descartar é apagar.
  if (!theirs) return { tree: removeIds(local, new Set([id])), action: 'deleted' };

  const clone = structuredClone(theirs);
  // O que foi CRIADO aqui dentro da pasta (não existe em lugar nenhum lá)
  // continua nela: tem a própria linha na Central, e descartar a mudança da
  // pasta (um nome, a ordem) apagava junto as requests novas, sem aviso.
  if (mine) keepCreatedHere(mine, clone, remote);
  // Tudo que a versão de lá traz sai de onde estiver aqui (o próprio item, e
  // filhos que aqui foram movidos pra fora dele).
  const base = removeIds(local, idsOf(clone));
  const there = locate(remote, id)!;
  const parentHere = there.parentId === null || !!findItem(base, there.parentId);
  if (parentHere) {
    return { tree: insertAt(base, there.parentId, there.index, clone), action: mine ? 'reverted' : 'restored' };
  }
  // Apagado aqui junto com a pasta onde ficava: as pastas do caminho voltam
  // VAZIAS (só a casca, com nome e configuração de lá) e o item entra nelas.
  // Antes não acontecia nada, e a Central dizia "já está igual ao GitHub".
  // Os outros itens dessas pastas continuam apagados aqui — só este volta.
  if (!mine) {
    let tree = base;
    for (const ancestor of ancestorsIn(remote, id)) {
      if (findItem(tree, ancestor.id)) continue;
      const at = locate(remote, ancestor.id)!;
      tree = insertAt(tree, at.parentId, at.index, { ...structuredClone(ancestor), item: [] });
    }
    return { tree: insertAt(tree, there.parentId, there.index, clone), action: 'restored' };
  }
  // A pasta de lá não existe mais aqui: volta o conteúdo no lugar de agora.
  const here = locate(local, id);
  if (!here) return { tree: local, action: 'none' };
  return { tree: insertAt(base, here.parentId, here.index, clone), action: 'reverted' };
}

/**
 * Põe em `clone` (a pasta como está no GitHub) os itens que existem dentro
 * de `mine` (a pasta daqui) e em lugar nenhum de `remote` — criados aqui —,
 * no mesmo pai e posição de aqui (no fim do pai, se ele não existir lá).
 * Muda `clone` no lugar.
 */
function keepCreatedHere(mine: CollectionItem, clone: CollectionItem, remote: CollectionItem[]): void {
  if (!mine.item?.length) return;
  const walk = (parent: CollectionItem) => {
    (parent.item ?? []).forEach((child, index) => {
      if (findItem(remote, child.id)) {
        walk(child);
        return;
      }
      // Novo aqui (e tudo o que tem dentro vai junto, inteiro).
      const target = parent.id === mine.id ? clone : findItem([clone], parent.id) ?? clone;
      const siblings = (target.item ??= []);
      siblings.splice(Math.min(index, siblings.length), 0, structuredClone(child));
    });
  };
  walk(mine);
}

/** As pastas acima do item, da collection até o pai direto. */
function ancestorsIn(tree: CollectionItem[], id: string): CollectionItem[] {
  for (const item of tree) {
    if (item.id === id) return [];
    if (!item.item) continue;
    const below = ancestorsIn(item.item, id);
    if (below.length > 0 || item.item.some(child => child.id === id)) return [item, ...below];
  }
  return [];
}

/**
 * A variável (ou o environment inteiro) `label` — "environment › variável",
 * como a Central mostra — volta a ser a do GitHub. Tokens de sessão ficam
 * os daqui: não são do GitHub.
 */
export function discardEnvironmentChange(local: Environment[], remote: Environment[], label: string): Environment[] {
  const theirs = withLocalOnlyValues(withoutSessionTokens(remote), local);
  const node = diffEnvironments(local, theirs).find(n => n.path.join(' › ') === label);
  if (!node) return local;
  return applyEnvironmentChanges(local, theirs, new Set([node.id]));
}

// ── Conteúdo como texto ──────────────────────────────────────────────────

/**
 * JSON indentado (uma linha por campo), pra o diff mostrar o campo que
 * mudou e não a linha inteira do payload. O resto vai como está (inclusive
 * JSON com {{variáveis}} fora de aspas, que não parseia).
 */
function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function requestText(item: CollectionItem): string {
  if (item.protocol === 'grpc' && item.grpc) {
    return [`gRPC ${item.grpc.target ?? ''} ${item.grpc.method ?? ''}`.trim(), item.grpc.message ? `\n${item.grpc.message}` : '']
      .filter(Boolean)
      .join('\n');
  }
  const req = item.request;
  const lines = [`${item.method ?? 'GET'} ${req?.url ?? ''}`.trim()];
  const pathParams = (req?.urlexport?.variable ?? []).filter(v => v.enabled !== false && v.key);
  if (pathParams.length) lines.push('', 'Path params:', ...pathParams.map(v => `  ${v.key} = ${v.value ?? ''}`));
  const headers = (req?.headers ?? []).filter(h => h.enabled !== false && h.key);
  if (headers.length) lines.push('', 'Headers:', ...headers.map(h => `  ${h.key}: ${h.value ?? ''}`));
  if (req?.auth?.type && req.auth.type !== 'none') lines.push('', `Auth: ${req.auth.type}`);
  // O payload aparece sempre que existe — inclusive com o tipo "none", que
  // guarda o texto mas não o envia (e isso é dito, pra não confundir).
  if (req?.body?.trim()) {
    const type = req.bodyType ?? 'raw';
    lines.push('', type === 'none' ? 'Body (type "none" — kept, not sent):' : `Body (${type}):`, prettyBody(req.body));
  }
  if (req?.scripts?.preRequest?.trim()) lines.push('', 'Pre-request script:', req.scripts.preRequest);
  if (req?.scripts?.postResponse?.trim()) lines.push('', 'Post-response script:', req.scripts.postResponse);
  return lines.join('\n');
}

function treeLines(items: CollectionItem[], depth: number, out: string[]) {
  for (const child of items) {
    const kind = child.type === 'request' ? `${child.method ?? 'GET'} ` : child.type === 'example' ? 'example · ' : '📁 ';
    out.push(`${'  '.repeat(depth)}${kind}${child.name}`);
    if (child.item?.length && child.type !== 'request') treeLines(child.item, depth + 1, out);
  }
}

/** O item inteiro como texto: a request (método, URL, headers, body, scripts) ou o que há na pasta. */
export function itemText(item: CollectionItem): string {
  if (item.type === 'request') return requestText(item);
  if (item.type === 'example') {
    const ex = item.example;
    return [
      `Example: ${ex?.code ?? ''} ${ex?.status ?? ''}`.trim(),
      // A request que o exemplo documenta (com o payload, quando houver).
      item.request?.url ? `\nRequest:\n${requestText(item)}` : '',
      ex?.body ? `\nResponse:\n${prettyBody(ex.body)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const out: string[] = [];
  treeLines(item.item ?? [], 0, out);
  return out.length ? out.join('\n') : '(empty folder)';
}
