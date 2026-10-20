import type { CollectionItem } from '@/app/types/CollectionItem';
import { stripStarredFlags } from '@/components/collection-tree/utils/tree.utils';
import { canonicalString } from './canonicalCompare';

// ─────────────────────────────────────────────────────────────────────────
// Descobre QUAIS collections mudaram entre dois estados da árvore.
//
// Existe porque a alternativa era passar o id da collection em cada mutação —
// criar, renomear, excluir, colar, reordenar, arrastar, salvar aba. São
// dezenas de pontos, e qualquer um esquecido vira uma alteração que nunca é
// enviada: o pior defeito possível numa feature de sync, porque falha em
// silêncio. Comparar o antes e o depois num lugar só não tem como esquecer.
//
// A impressão é tirada do conteúdo JÁ SEM as marcas de favorito, que é
// exatamente o que o push grava (stripStarredFlags). Assim a pergunta que o
// fingerprint responde é "o arquivo remoto mudaria?", e não "algo mudou na
// tela" — favoritar continua marcando pendência, mas só porque favoritar de
// fato reordena os irmãos e isso vai pro arquivo.
//
// O custo é serializar a árvore a cada alteração. É da mesma ordem do que o
// app já faz: toda mudança em `collections` grava o workspace inteiro em
// disco logo em seguida.
// ─────────────────────────────────────────────────────────────────────────

export type RootFingerprints = Map<string, string>;

/**
 * Impressão de cada collection raiz.
 *
 * `canonicalize` existe porque os dois usos querem coisas diferentes. Para
 * detectar pendência local, compara-se a árvore consigo mesma ao longo do
 * tempo: a ordem das chaves é estável, e a forma literal basta — mais barata,
 * e isto roda a cada edição.
 *
 * Para comparar com o GITHUB não basta: aquele lado é reconstruído pelo
 * importData, que monta os objetos na ordem dele, e a forma literal acusaria
 * diferença em toda collection, sempre.
 */
export function fingerprintRoots(
  roots: CollectionItem[] | undefined | null,
  canonicalize = false
): RootFingerprints {
  const map: RootFingerprints = new Map();
  for (const root of roots ?? []) {
    if (!root?.id) continue;
    const stripped = stripStarredFlags(root);
    map.set(root.id, canonicalize ? canonicalString(stripped) : JSON.stringify(stripped));
  }
  return map;
}

export interface RootChanges {
  /** Criadas ou alteradas — o push seletivo sabe reenviar estas. */
  changed: string[];
  /**
   * Sumiram da árvore. Não dá pra marcá-las como pendentes (não há mais id
   * que o push possa resolver), então quem chama precisa exigir push completo
   * — é o único que reconcilia arquivo removido no remoto.
   */
  removed: string[];
}

export function diffRoots(previous: RootFingerprints, next: RootFingerprints): RootChanges {
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [id, print] of next) {
    if (previous.get(id) !== print) changed.push(id);
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) removed.push(id);
  }

  return { changed, removed };
}
