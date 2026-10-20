import { LazyStore } from '@tauri-apps/plugin-store';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { canonicalString } from './canonicalCompare';
import { stripStarredFlags } from '@/components/collection-tree/utils/tree.utils';

// ─────────────────────────────────────────────────────────────────────────
// Estado comum da última sincronização — a "base" de uma comparação de três
// vias.
//
// Sem ela só dá para saber que local e remoto diferem, não QUEM mexeu. O
// conflito então era marcado por collection: bastava a collection ter
// qualquer pendência para TODOS os itens dela saírem com o aviso de "isto
// descarta trabalho seu". Num workspace com 313 itens o aviso aparecia nos
// 313 e deixava de informar qualquer coisa.
//
// Com a base, as três situações se separam:
//
//   • mudou só lá      → aceitar é seguro;
//   • mudou só aqui    → nem deveria pedir decisão;
//   • mudou nos dois   → conflito de verdade, e costuma ser pouca coisa.
//
// Guarda HASH por nó, não o conteúdo: a pergunta é só "este nó mudou desde a
// última sincronização?". Guardar as árvores inteiras custaria megabytes por
// workspace para responder um sim ou não.
// ─────────────────────────────────────────────────────────────────────────

/** nodeId → hash do conteúdo na última sincronização. */
export type NodeHashes = Record<string, string>;

// Arquivo próprio, como o histórico de runs: o localStorage é cota
// compartilhada, e são milhares de entradas por workspace.
const store = new LazyStore('sync-base.json', { autoSave: 300 });

const KEY_PREFIX = 'base:';

export async function loadSyncBase(workspace: string): Promise<NodeHashes | null> {
  if (!workspace) return null;
  try {
    const stored = await store.get<NodeHashes>(KEY_PREFIX + workspace);
    return stored && typeof stored === 'object' ? stored : null;
  } catch (e) {
    console.log('Could not read the sync base:', e);
    return null;
  }
}

/**
 * Grava o estado comum depois de uma sincronização.
 *
 * `merge` porque push e pull tocam partes diferentes: enviar UMA collection
 * não torna as outras sincronizadas, e sobrescrever o arquivo inteiro faria o
 * resto perder a base e voltar a avisar demais.
 */
export async function recordSyncBase(workspace: string, hashes: NodeHashes): Promise<void> {
  if (!workspace) return;
  try {
    const current = (await loadSyncBase(workspace)) ?? {};
    await store.set(KEY_PREFIX + workspace, { ...current, ...hashes });
  } catch (e) {
    // Perder a base não pode derrubar o push que acabou de dar certo: a
    // comparação só volta a avisar demais até a próxima sincronização.
    console.log('Could not record the sync base:', e);
  }
}

export async function clearSyncBase(workspace: string): Promise<void> {
  if (!workspace) return;
  try {
    await store.delete(KEY_PREFIX + workspace);
  } catch (e) {
    console.log('Could not clear the sync base:', e);
  }
}

/**
 * FNV-1a. Não é criptográfico, e nem precisa: uma colisão aqui faria um nó
 * alterado passar por intocado, e o custo disso é um aviso de conflito a
 * menos — não perda de dado, porque o conteúdo em si nunca sai daqui.
 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Hash de cada nó da árvore, pelo conteúdo PRÓPRIO dele.
 *
 * Sem os filhos de propósito: incluí-los faria toda pasta de um fluxo mudar
 * quando uma request lá dentro mudasse, e a pasta apareceria como conflito
 * sem ninguém ter tocado nela.
 */
/** Conteúdo próprio do nó, sem filhos e sem as marcas locais de favorito. */
function ownContent(item: CollectionItem): Omit<CollectionItem, 'item'> {
  const own = { ...stripStarredFlags(item) };
  delete own.item;
  return own;
}

export function nodeHashes(roots: CollectionItem[] | undefined | null): NodeHashes {
  const out: NodeHashes = {};

  const walk = (items: CollectionItem[]) => {
    for (const item of items) {
      if (!item?.id) continue;
      out[item.id] = hash(canonicalString(ownContent(item)));
      if (item.item?.length) walk(item.item);
    }
  };

  walk(roots ?? []);
  return out;
}

/** O nó mudou desde a base? `null` quando a base não o conhece. */
export function changedSinceBase(
  base: NodeHashes | null,
  nodeId: string,
  local: CollectionItem | undefined
): boolean | null {
  if (!base) return null;
  const recorded = base[nodeId];
  if (recorded === undefined) {
    // Nó que a base não tem é nó criado depois dela — portanto, trabalho local.
    return true;
  }
  if (!local) return null;
  return hash(canonicalString(ownContent(local))) !== recorded;
}
