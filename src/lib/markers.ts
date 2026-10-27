import type { CollectionItem } from '@/app/types/CollectionItem';

// ─────────────────────────────────────────────────────────────────────────
// Marcadores — categorias coloridas aplicáveis a QUALQUER nó da árvore
// (collection, pasta, request ou example), no espírito das Categorias do
// Outlook.
//
// Dois dados separados, de propósito:
//
//   • o CATÁLOGO (`Marker[]`): a lista de marcadores que existem, com nome e
//     cor. É um por workspace, não por collection — marcar "flaky" numa
//     collection e "flaky" noutra tem que ser o MESMO marcador, senão
//     filtrar por ele não junta as duas.
//
//   • as ATRIBUIÇÕES (`CollectionItem.markers`): só os ids, dentro do nó. É
//     o que faz a marca viajar junto com a collection no push pro GitHub,
//     sem nenhum arquivo extra a manter em sincronia com a árvore.
//
// Guardar o nome e a cor DENTRO do nó foi descartado: renomear um marcador
// teria que varrer e reescrever a árvore inteira, e duas pessoas com grafias
// diferentes ("Flaky" e "flaky") acabariam com dois marcadores distintos.
// ─────────────────────────────────────────────────────────────────────────

export interface Marker {
  id: string;
  name: string;
  /** Hex. Sempre uma das MARKER_COLORS — ver pickColor. */
  color: string;
}

/**
 * Paleta fechada em vez de cor livre.
 *
 * Um seletor de cor arbitrária deixa a árvore ilegível (cinza sobre cinza,
 * dois marcadores em tons indistinguíveis) e muda de sentido entre o tema
 * claro e o escuro. Estas são as mesmas famílias de cor que o resto do app
 * já usa para método HTTP, variável e status.
 */
export const MARKER_COLORS = [
  '#e06c75', // vermelho
  '#f26b3a', // laranja
  '#e5c07b', // amarelo
  '#4ff09d', // verde
  '#2fb8a8', // turquesa
  '#3c89e0', // azul
  '#63b3ed', // azul claro
  '#a78bfa', // roxo
  '#e07bc0', // rosa
  '#8b96a8', // cinza
] as const;

export const MAX_MARKER_NAME = 40;

type IdFactory = () => string;

const defaultId: IdFactory = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `mk-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

// Nomes são comparados sem caixa e sem espaço nas pontas: "Flaky", "flaky" e
// " flaky " são o mesmo marcador. Sem isso, o catálogo do time acumula
// variações da mesma ideia e o filtro passa a mentir.
function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_MARKER_NAME);
}

function sameName(a: string, b: string): boolean {
  return normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();
}

/**
 * Próxima cor livre do catálogo. Repete só quando a paleta acabou — duas
 * cores iguais é ruído, mas bloquear a criação do 11º marcador seria pior.
 */
export function pickColor(catalog: Marker[]): string {
  const used = new Set(catalog.map(m => m.color));
  return MARKER_COLORS.find(c => !used.has(c)) ?? MARKER_COLORS[catalog.length % MARKER_COLORS.length];
}

export interface CreateResult {
  catalog: Marker[];
  marker: Marker;
  /** true quando o nome já existia e nada foi criado. */
  existed: boolean;
}

/**
 * Cria um marcador — ou devolve o que já tem esse nome.
 *
 * Devolver o existente em vez de recusar é o que permite "criar e aplicar"
 * num gesto só no menu da árvore: quem digita um nome que já existe quer
 * aplicar aquele, não ver um erro.
 */
export function createMarker(
  catalog: Marker[],
  name: string,
  opts: { color?: string; id?: string | IdFactory } = {}
): CreateResult {
  const clean = normalizeName(name);
  if (!clean) throw new Error('Marker name cannot be empty');

  const existing = catalog.find(m => sameName(m.name, clean));
  if (existing) return { catalog, marker: existing, existed: true };

  const makeId = typeof opts.id === 'function' ? opts.id : opts.id ? () => opts.id as string : defaultId;
  const marker: Marker = {
    id: makeId(),
    name: clean,
    color: opts.color && (MARKER_COLORS as readonly string[]).includes(opts.color)
      ? opts.color
      : pickColor(catalog),
  };
  return { catalog: [...catalog, marker], marker, existed: false };
}

/** Renomeia. Devolve o catálogo inalterado se o nome colidir com outro. */
export function renameMarker(catalog: Marker[], id: string, name: string): Marker[] {
  const clean = normalizeName(name);
  if (!clean) return catalog;
  if (catalog.some(m => m.id !== id && sameName(m.name, clean))) return catalog;
  return catalog.map(m => (m.id === id ? { ...m, name: clean } : m));
}

export function recolorMarker(catalog: Marker[], id: string, color: string): Marker[] {
  if (!(MARKER_COLORS as readonly string[]).includes(color)) return catalog;
  return catalog.map(m => (m.id === id ? { ...m, color } : m));
}

export function deleteMarker(catalog: Marker[], id: string): Marker[] {
  return catalog.filter(m => m.id !== id);
}

// ─── Atribuições na árvore ───────────────────────────────────────────────

export function markersOf(item: CollectionItem): string[] {
  return item.markers ?? [];
}

export function hasMarker(item: CollectionItem, markerId: string): boolean {
  return markersOf(item).includes(markerId);
}

// Devolve o MESMO nó quando nada muda. É o que permite a árvore inteira
// passar por aqui sem invalidar as referências de quem não foi tocado —
// React só re-renderiza o ramo alterado.
function setMarkers(item: CollectionItem, next: string[]): CollectionItem {
  const current = markersOf(item);
  const sameIds =
    current.length === next.length && current.every((id, i) => id === next[i]);

  // Nota de marcador que saiu do nó não pode ficar para trás: ela voltaria
  // sozinha se a mesma marca fosse reaplicada depois, trazendo um texto que
  // já não vale — e, sem a marca, nenhuma tela a mostra para apagar.
  const notes = item.markerNotes;
  const keptNotes = notes
    ? Object.fromEntries(Object.entries(notes).filter(([id]) => next.includes(id)))
    : undefined;
  const notesChanged =
    !!notes && Object.keys(keptNotes!).length !== Object.keys(notes).length;

  if (sameIds && !notesChanged) return item;

  const base = { ...item };
  if (notesChanged) {
    if (Object.keys(keptNotes!).length === 0) delete base.markerNotes;
    else base.markerNotes = keptNotes;
  }

  if (next.length === 0) {
    // Campo ausente, não array vazio: `markers: []` em todo nó incharia o
    // arquivo da collection e apareceria como alteração no diff do sync.
    const { markers: _dropped, ...rest } = base;
    return rest;
  }
  return { ...base, markers: next };
}

// ─── Nota por marca ──────────────────────────────────────────────────────

export function markerNote(item: CollectionItem, markerId: string): string {
  return item.markerNotes?.[markerId] ?? '';
}

/**
 * Grava (ou apaga) a nota de um marcador num nó.
 *
 * Só grava onde a marca existe: nota sem marca não aparece em lugar nenhum
 * e sobreviveria invisível no arquivo da collection.
 */
export function setMarkerNote(
  items: CollectionItem[],
  nodeId: string,
  markerId: string,
  text: string
): CollectionItem[] {
  const clean = text.trim();
  return mapNodes(items, item => {
    if (item.id !== nodeId || !hasMarker(item, markerId)) return item;
    if (markerNote(item, markerId) === clean) return item;

    const next = { ...(item.markerNotes ?? {}) };
    if (clean) next[markerId] = clean;
    else delete next[markerId];

    if (Object.keys(next).length === 0) {
      const { markerNotes: _dropped, ...rest } = item;
      return rest;
    }
    return { ...item, markerNotes: next };
  });
}

function mapNodes(
  items: CollectionItem[],
  fn: (item: CollectionItem) => CollectionItem
): CollectionItem[] {
  let changed = false;
  const out = items.map(item => {
    const children = item.item ? mapNodes(item.item, fn) : undefined;
    const withChildren = children && children !== item.item ? { ...item, item: children } : item;
    const next = fn(withChildren);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : items;
}

/** Aplica um marcador a um conjunto de nós (por id). */
export function applyMarker(
  items: CollectionItem[],
  nodeIds: Iterable<string>,
  markerId: string
): CollectionItem[] {
  const targets = new Set(nodeIds);
  if (targets.size === 0) return items;
  return mapNodes(items, item =>
    targets.has(item.id) && !hasMarker(item, markerId)
      ? setMarkers(item, [...markersOf(item), markerId])
      : item
  );
}

export function removeMarker(
  items: CollectionItem[],
  nodeIds: Iterable<string>,
  markerId: string
): CollectionItem[] {
  const targets = new Set(nodeIds);
  if (targets.size === 0) return items;
  return mapNodes(items, item =>
    targets.has(item.id) && hasMarker(item, markerId)
      ? setMarkers(item, markersOf(item).filter(id => id !== markerId))
      : item
  );
}

/**
 * Liga/desliga para uma seleção inteira.
 *
 * A regra do "tudo ou nada" vem do Outlook: se ALGUM dos selecionados ainda
 * não tem o marcador, o gesto aplica a todos; só quando todos já têm é que
 * ele tira. O contrário (alternar item a item) devolve uma seleção metade
 * marcada, que é o estado que ninguém pediu.
 */
export function toggleMarker(
  items: CollectionItem[],
  nodeIds: Iterable<string>,
  markerId: string
): CollectionItem[] {
  const targets = new Set(nodeIds);
  if (targets.size === 0) return items;

  let seen = 0;
  let marked = 0;
  walk(items, item => {
    if (!targets.has(item.id)) return;
    seen++;
    if (hasMarker(item, markerId)) marked++;
  });
  if (seen === 0) return items;

  return marked === seen
    ? removeMarker(items, targets, markerId)
    : applyMarker(items, targets, markerId);
}

/** Tira o marcador da árvore inteira — o que apagá-lo do catálogo exige. */
export function purgeMarker(items: CollectionItem[], markerId: string): CollectionItem[] {
  return mapNodes(items, item =>
    hasMarker(item, markerId)
      ? setMarkers(item, markersOf(item).filter(id => id !== markerId))
      : item
  );
}

function walk(items: CollectionItem[], visit: (item: CollectionItem) => void): void {
  for (const item of items) {
    visit(item);
    if (item.item?.length) walk(item.item, visit);
  }
}

/** Quantos nós usam cada marcador. Alimenta a tela de gerenciar. */
export function markerCounts(items: CollectionItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  walk(items, item => {
    for (const id of markersOf(item)) counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  return counts;
}

/**
 * Ids atribuídos na árvore que não existem no catálogo.
 *
 * Acontece de verdade: alguém do time apaga um marcador e dá push; quem
 * puxa recebe a árvore com o id ainda nos nós. Sem isso, a marca vira um
 * ponto invisível que nenhum filtro alcança e nenhuma tela mostra.
 */
export function orphanMarkerIds(items: CollectionItem[], catalog: Marker[]): string[] {
  const known = new Set(catalog.map(m => m.id));
  const orphans = new Set<string>();
  walk(items, item => {
    for (const id of markersOf(item)) if (!known.has(id)) orphans.add(id);
  });
  return [...orphans];
}

/** Tira da árvore toda marca sem marcador correspondente no catálogo. */
export function purgeOrphans(items: CollectionItem[], catalog: Marker[]): CollectionItem[] {
  const known = new Set(catalog.map(m => m.id));
  return mapNodes(items, item => {
    const current = markersOf(item);
    if (current.length === 0) return item;
    const kept = current.filter(id => known.has(id));
    return kept.length === current.length ? item : setMarkers(item, kept);
  });
}

// ─── Filtro ──────────────────────────────────────────────────────────────

export type MarkerFilterMode = 'any' | 'all';

export function nodeMatchesMarkers(
  item: CollectionItem,
  markerIds: string[],
  mode: MarkerFilterMode = 'any'
): boolean {
  if (markerIds.length === 0) return true;
  const own = markersOf(item);
  return mode === 'all'
    ? markerIds.every(id => own.includes(id))
    : markerIds.some(id => own.includes(id));
}

/**
 * Recorta a árvore pelos marcadores, com a MESMA regra do filterTree de
 * busca: descendente que bate manda (mostra só ele); se nenhum bate mas o
 * próprio nó bate, a subárvore vem inteira — marcar uma pasta tem que
 * mostrar o que há dentro dela, senão a pasta aparece vazia.
 */
export function filterTreeByMarkers(
  items: CollectionItem[],
  markerIds: string[],
  mode: MarkerFilterMode = 'any'
): CollectionItem[] {
  if (markerIds.length === 0) return items;

  const walkFilter = (list: CollectionItem[]): CollectionItem[] =>
    list
      .map(item => {
        const children = item.item ? walkFilter(item.item) : [];
        if (children.length > 0) return { ...item, item: children };
        if (nodeMatchesMarkers(item, markerIds, mode)) return item;
        return null;
      })
      .filter((item): item is CollectionItem => item !== null);

  return walkFilter(items);
}

// ─── Catálogo vindo do Git ───────────────────────────────────────────────

/**
 * Junta o catálogo local com o que veio do repositório.
 *
 * União, nunca substituição: duas pessoas criando marcadores em paralelo é o
 * caso normal, e quem puxa não pode perder os seus. O id manda — mesmo id é
 * o mesmo marcador, e o remoto ganha no nome/cor (é o que o time combinou).
 * Nome igual com ids diferentes (duas pessoas criaram "flaky" cada uma na
 * sua máquina) colapsa no remoto, e `remapped` diz quais ids locais passam a
 * apontar pro id do time — é o que a árvore precisa reescrever.
 */
export function mergeCatalogs(
  local: Marker[],
  remote: Marker[]
): { catalog: Marker[]; remapped: Map<string, string> } {
  const byId = new Map(remote.map(m => [m.id, m]));
  const byName = new Map(remote.map(m => [normalizeName(m.name).toLowerCase(), m]));
  const remapped = new Map<string, string>();
  const catalog = [...remote];

  for (const mine of local) {
    if (byId.has(mine.id)) continue;
    const twin = byName.get(normalizeName(mine.name).toLowerCase());
    if (twin) {
      remapped.set(mine.id, twin.id);
      continue;
    }
    catalog.push(mine);
    byId.set(mine.id, mine);
    byName.set(normalizeName(mine.name).toLowerCase(), mine);
  }

  return { catalog, remapped };
}

/** Reescreve na árvore os ids que o merge do catálogo colapsou. */
export function remapMarkers(
  items: CollectionItem[],
  remapped: Map<string, string>
): CollectionItem[] {
  if (remapped.size === 0) return items;
  return mapNodes(items, item => {
    const current = markersOf(item);
    if (current.length === 0) return item;
    // Set porque o remap pode fundir dois ids num só dentro do mesmo nó.
    const next = [...new Set(current.map(id => remapped.get(id) ?? id))];

    // As notas viajam com o id. Tem que ser ANTES do setMarkers, que poda
    // nota sem marca — passando depois, a nota ficaria órfã do id antigo e
    // seria apagada junto. Quando dois ids se fundem e os dois têm nota,
    // fica a do id que o time manteve: é a que o resto da equipe vê.
    const notes = item.markerNotes;
    let withNotes = item;
    if (notes) {
      const moved: Record<string, string> = {};
      let moveu = false;
      for (const [id, note] of Object.entries(notes)) {
        const target = remapped.get(id) ?? id;
        if (target !== id) moveu = true;
        // Dois ids caindo no mesmo alvo: fica a nota do id que o time já
        // tinha, não a do id local que está sendo absorvido.
        if (moved[target] === undefined || !remapped.has(id)) moved[target] = note;
      }
      if (moveu) withNotes = { ...item, markerNotes: moved };
    }

    return setMarkers(withNotes, next);
  });
}
