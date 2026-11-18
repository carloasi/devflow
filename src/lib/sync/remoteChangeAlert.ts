import type { CollectionItem } from '@/app/types/CollectionItem';
import { diffTrees, type DiffNode } from '@/lib/collectionDiff';
import { isLikelySecretValue, maskValue, redactAuthForDisplay } from '@/lib/secretScan';
import { diffableText } from '@/lib/textDiff';
import { fieldValue, MERGE_FIELDS, type MergeField } from './fieldMerge';
import type { ChangeDetail, RebaseResult } from './rebase';

// ─────────────────────────────────────────────────────────────────────────
// O que mostrar no aviso "alguém mudou isto no GitHub".
//
// O aviso dizia só o nome do arquivo e o autor ("Barramento B2B - Dev was
// changed by Matheus"): pra saber O QUE mudou era preciso abrir o pull. Aqui
// sai, do mesmo merge de teste que o push faria (rebaseCollections), a lista
// dos itens que vêm do GitHub — e de cada um, os campos com o valor daqui e
// o de lá, prontos pra um mini-diff.
//
// Segredos não aparecem: auth mascarado, header com cara de credencial com o
// valor escondido (mesma regra da tela de revisão). Environments entram só
// pelo nome da variável: o valor costuma ser token.
// ─────────────────────────────────────────────────────────────────────────

export interface RemoteFieldPreview {
  field: string;
  /** Como está aqui. */
  before: string;
  /** Como ficou no GitHub. */
  after: string;
  /**
   * Como estava na última sincronização — o que deixa a visão de três
   * painéis dizer QUEM mudou cada trecho. Ausente/null = sem como saber
   * (relatório depois do merge, base indisponível): a visão vira de duas vias.
   */
  base?: string | null;
  /**
   * Os mesmos textos SEM máscara e sem corte — pra editar o resultado à mão
   * ali mesmo (a edição vira rascunho da revisão). Função, e não campo: não
   * vai junto quando algo serializa o aviso (JSON.stringify ignora função),
   * então o token real nunca acaba num storage por tabela.
   */
  raw?: () => RawFieldTexts;
}

export interface RawFieldTexts {
  before: string;
  after: string;
  base: string | null;
}

/** O item na última sincronização: undefined = não dá pra saber; null = não existia. */
export type BaseItemOf = (node: DiffNode) => CollectionItem | null | undefined;

export interface RemoteChangeItem {
  id: string;
  /** Caminho, da collection ao item. */
  path: string[];
  change: ChangeDetail['change'];
  /** Mudou aqui também, no mesmo campo: vai pedir decisão. */
  conflict: boolean;
  fields: RemoteFieldPreview[];
  /** Collection raiz do item, quando se sabe (Central: agrupar e filtrar). */
  rootId?: string;
}

export interface RemoteChangePreview {
  /** Itens com conflito (caminho curto) — pro título do aviso. */
  conflicts: string[];
  /** Quantos itens entram sozinhos. */
  incoming: number;
  /** O que mudou no GitHub, conflitos primeiro. */
  items: RemoteChangeItem[];
  /** Variáveis de environment que mudaram lá ("Dev › baseUrl"). */
  environments: string[];
  /**
   * Os itens são o que o ÚLTIMO COMMIT mudou (commitChangeItems), não o que
   * o Pull traria: o merge de teste não achou nada a trazer.
   */
  fromCommit?: boolean;
}

/** Texto acima disto é cortado na prévia: o aviso não é a tela de revisão. */
const MAX_PREVIEW_CHARS = 6000;

function clip(text: string): string {
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n…` : text;
}

/** Valor de um campo como texto, sem segredos. */
export function safeFieldText(field: string, value: unknown): string {
  if (field === 'auth') return diffableText(redactAuthForDisplay(value));
  if (field === 'headers' && Array.isArray(value)) {
    return diffableText(
      value.map(h =>
        h && typeof h === 'object' && isLikelySecretValue((h as { key?: string }).key, (h as { value?: string }).value)
          ? { ...h, value: maskValue(String((h as { value?: string }).value ?? '')) }
          : h
      )
    );
  }
  return diffableText(value);
}

function fieldsOf(node: DiffNode | undefined, only: string[], baseItemOf?: BaseItemOf): RemoteFieldPreview[] {
  if (!node) return [];
  const baseItem = baseItemOf?.(node);
  return node.fields
    .filter(f => f.field !== 'order' && (only.length === 0 || only.includes(f.field)))
    .map(f => {
      const known = baseItem !== undefined && (MERGE_FIELDS as readonly string[]).includes(f.field);
      const baseValue = known && baseItem ? fieldValue(baseItem, f.field as MergeField) : undefined;
      return {
        field: f.field,
        before: clip(safeFieldText(f.field, f.local)),
        after: clip(safeFieldText(f.field, f.remote)),
        // Item que não existia na base: base vazia (os dois o criaram).
        base: known ? clip(baseItem ? safeFieldText(f.field, baseValue) : '') : null,
        raw: () => ({
          before: diffableText(f.local),
          after: diffableText(f.remote),
          base: known ? (baseItem ? diffableText(baseValue) : '') : null,
        }),
      };
    })
    .filter(f => f.before !== f.after);
}

/**
 * Itens de uma lista de mudanças (relatório do merge, prévia do push) com o
 * antes/depois de cada campo — pra abrir a diferença no formato de três
 * painéis a partir de qualquer aviso de merge.
 */
export function detailItems(
  details: ChangeDetail[],
  nodes: DiffNode[],
  options: { conflict?: boolean; baseItemOf?: BaseItemOf } = {}
): RemoteChangeItem[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  return details.map(detail => {
    const rootId = byId.get(detail.id)?.rootId;
    return {
      id: detail.id,
      path: detail.path,
      change: detail.change,
      conflict: !!options.conflict,
      fields:
        detail.change === 'changed' || options.conflict
          ? fieldsOf(byId.get(detail.id), options.conflict ? [] : detail.fields, options.baseItemOf)
          : [],
      ...(rootId ? { rootId } : {}),
    };
  });
}

const shortPath = (path: string[]) => path.slice(-2).join(' / ');

/**
 * Prévia do aviso a partir do merge de teste. `limit` corta a lista — o
 * aviso diz quantos ficaram de fora.
 */
export function buildRemoteChangePreview(
  result: Pick<RebaseResult, 'nodes' | 'conflicts' | 'conflictDetails' | 'incomingDetails' | 'incoming' | 'fieldMerged'>,
  environments: string[] = [],
  baseItemOf?: BaseItemOf
): RemoteChangePreview {
  const byId = new Map(result.nodes.map(n => [n.id, n]));
  const conflictIds = new Set(result.conflicts);

  const items: RemoteChangeItem[] = [];
  const seen = new Set<string>();
  const add = (detail: ChangeDetail, conflict: boolean) => {
    // Um item pode vir duas vezes (campos daqui e de lá numa mescla por
    // campo): o aviso fala do que veio do GitHub, uma linha por item.
    if (seen.has(detail.id)) return;
    seen.add(detail.id);
    const node = byId.get(detail.id);
    items.push({
      id: detail.id,
      path: detail.path,
      change: detail.change,
      conflict,
      fields: detail.change === 'changed' || conflict ? fieldsOf(node, conflict ? [] : detail.fields, baseItemOf) : [],
      ...(node?.rootId ? { rootId: node.rootId } : {}),
    });
  };
  for (const detail of result.conflictDetails) add(detail, true);
  for (const detail of result.incomingDetails) add(detail, conflictIds.has(detail.id));

  return {
    conflicts: result.conflictDetails.map(d => shortPath(d.path)),
    incoming: result.incoming + result.fieldMerged,
    items,
    environments,
  };
}

/** Iniciais pro avatar do autor ("Matheus Rodrigues" → "MR"). */
export function initialsOf(name: string): string {
  const parts = name.replace(/[._-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function findById(items: CollectionItem[] | undefined | null, id: string): CollectionItem | undefined {
  for (const item of items ?? []) {
    if (item?.id === id) return item;
    const found = findById(item?.item, id);
    if (found) return found;
  }
  return undefined;
}

const isMergeField = (field: string): field is MergeField => (MERGE_FIELDS as readonly string[]).includes(field);

/**
 * O que UM commit mudou (versão anterior → a do commit), com o valor daqui
 * ao lado — pra "Ver diferença" do aviso quando o merge de teste não traz
 * itens (você já tem a mudança, ou ela é sua, de outra máquina). Assim o
 * aviso sempre mostra o que aquele commit fez.
 *
 * Nos três painéis: base = antes do commit, GitHub = depois, "minha" = aqui.
 * `older` null = o arquivo nasceu nesse commit.
 */
export function commitChangeItems(
  older: CollectionItem[] | null,
  newer: CollectionItem[],
  local: CollectionItem[]
): RemoteChangeItem[] {
  const items: RemoteChangeItem[] = [];
  const valueOf = (item: CollectionItem | undefined, field: MergeField) =>
    item ? clip(safeFieldText(field, fieldValue(item, field))) : '';
  for (const node of diffTrees(older ?? [], newer)) {
    if (node.kind === 'variable') continue;
    const here = findById(local, node.id);
    const names: MergeField[] =
      node.change === 'modified' ? node.fields.map(f => f.field).filter(isMergeField) : [...MERGE_FIELDS];
    const fields = names
      .map(field => ({
        field,
        before: valueOf(here, field),
        after: valueOf(node.change === 'removed' ? undefined : node.remote, field),
        base: valueOf(node.change === 'added' ? undefined : node.local, field),
      }))
      // Só o que o commit mudou.
      .filter(f => f.base !== f.after);
    items.push({
      id: node.id,
      path: node.path,
      change: node.change === 'added' ? 'new' : node.change === 'removed' ? 'deleted' : 'changed',
      conflict: false,
      fields,
    });
  }
  return items;
}
