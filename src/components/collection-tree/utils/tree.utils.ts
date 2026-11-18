import { CollectionItem } from '@/app/types/CollectionItem'

export function renameNode(
  items: CollectionItem[],
  id: string,
  newName: string
): CollectionItem[] {
  return items.map((item: CollectionItem) => {
    if (item.id === id) {
      return {
        ...item,
        name: newName,
      }
    }

    if (item.item) {
      return {
        ...item,
        item: renameNode(item.item, id, newName),
      }
    }

    return item
  })
}

// Alterna o campo `starred` de um item — pasta, request ou example (ver
// TreeActionMenu.tsx e a estrela na linha da árvore, em TreeNode.tsx).
//
// Favoritar MOVE a pasta pro topo dos irmãos de verdade, mexendo na ordem
// guardada. Antes isso era feito só na hora de desenhar, por um sort que
// empurrava favoritos pra cima: como a ordem real continuava outra, a
// renderização desfazia silenciosamente qualquer drag-and-drop — com uma
// pasta favoritada dentro dela, nada conseguia ser arrastado pra cima da
// collection. Movendo de fato, o que está na tela é o que está no estado.
//
// Desfavoritar devolve a pasta pro lugar de onde ela saiu, usando o irmão que
// vinha antes dela como âncora (`starredAfterId`). Se esse irmão não estiver
// mais na lista — foi apagado, ou a pasta foi arrastada pra outro pai — não há
// "lugar de origem" que ainda faça sentido, então ela só perde a estrela e
// fica onde está.
export function toggleStarNode(
  items: CollectionItem[],
  id: string
): CollectionItem[] {
  const index = items.findIndex((item) => item.id === id)

  if (index === -1) {
    return items.map((item: CollectionItem) =>
      item.item ? { ...item, item: toggleStarNode(item.item, id) } : item
    )
  }

  const target = items[index]
  const rest = items.filter((item) => item.id !== id)

  if (!target.starred) {
    const anchorId = index === 0 ? null : items[index - 1].id
    return [{ ...target, starred: true, starredAfterId: anchorId }, ...rest]
  }

  const { starred: _starred, starredAfterId, ...cleared } = target
  const restored = cleared as CollectionItem

  if (starredAfterId === undefined) {
    // Favoritada antes deste recurso existir: sem âncora pra onde voltar.
    return items.map((item) => (item.id === id ? restored : item))
  }

  const anchorAt =
    starredAfterId === null
      ? -1
      : rest.findIndex((item) => item.id === starredAfterId)

  if (starredAfterId !== null && anchorAt === -1) {
    return items.map((item) => (item.id === id ? restored : item))
  }

  return [...rest.slice(0, anchorAt + 1), restored, ...rest.slice(anchorAt + 1)]
}

// Galhos que não continham o nó voltam como o MESMO objeto: antes cada
// exclusão recriava todos os nós de todas as collections (e punha um
// `item: undefined` em cada request), o que fazia a árvore inteira
// re-renderizar.
export function removeNode(
  items: CollectionItem[],
  id: string
): CollectionItem[] {
  let changed = false
  const out: CollectionItem[] = []
  for (const item of items) {
    if (item.id === id) {
      changed = true
      continue
    }
    if (item.item) {
      const children = removeNode(item.item, id)
      if (children !== item.item) {
        changed = true
        out.push({ ...item, item: children })
        continue
      }
    }
    out.push(item)
  }
  return changed ? out : items
}

export function addNode(
  items: CollectionItem[],
  parentId: string,
  node: CollectionItem
): CollectionItem[] {
  return items.map((item: CollectionItem) => {
    if (item.id === parentId) {
      return {
        ...item,
        item: [...(item.item || []), node],
      }
    }

    if (item.item) {
      return {
        ...item,
        item: addNode(item.item, parentId, node),
      }
    }

    return item
  })
}

// Migração defensiva: examples criados/importados ANTES do fix que passou a
// copiar `request`/`method` do request pai (bug em createExample e no
// import de response[]/originalRequest) ficaram salvos sem o snapshot da
// request original — abrindo mostravam method GET e body vazio. Roda a
// cada load/import: qualquer example sem URL no request próprio herda o
// `.request`/`.method` atuais do request pai. Não mexe em examples que já
// têm request válido.
export function backfillExampleRequests(items: CollectionItem[]): CollectionItem[] {
  return items.map((item) => {
    if (item.type === 'request' && item.item?.length) {
      const fixedChildren = item.item.map((child) => {
        if (child.type !== 'example') return child
        const hasUrl = Boolean(child.request?.urlexport?.raw || child.request?.url)
        if (hasUrl) return child
        return {
          ...child,
          method: child.method ?? item.method,
          request: item.request ? { ...item.request } : child.request,
        }
      })
      return { ...item, item: fixedChildren }
    }

    if (item.item) {
      return { ...item, item: backfillExampleRequests(item.item) }
    }

    return item
  })
}

// Acha e devolve o nó com o id informado (ou undefined), buscando em
// qualquer nível da árvore — usado pra pegar um snapshot de outro nó (ex:
// copiar o `.request` da request original ao criar um Saved Example a
// partir da resposta atual).
export function findNodeById(
  items: CollectionItem[],
  id: string
): CollectionItem | undefined {
  for (const item of items) {
    if (item.id === id) return item
    if (item.item) {
      const found = findNodeById(item.item, id)
      if (found) return found
    }
  }
  return undefined
}

// Aplica um patch parcial (merge raso) no nó com o id informado, em
// qualquer nível da árvore — usado pra salvar edições feitas fora do
// componente dono da árvore (ex: ExampleEditorPanel dentro do
// AppLayout, que não tem acesso direto ao useCollectionTree hook que
// vive dentro de CollectionTree.tsx).
export function patchNode(
  items: CollectionItem[],
  id: string,
  patch: Partial<CollectionItem>
): CollectionItem[] {
  return items.map((item: CollectionItem) => {
    if (item.id === id) {
      return {
        ...item,
        ...patch,
      }
    }

    if (item.item) {
      return {
        ...item,
        item: patchNode(item.item, id, patch),
      }
    }

    return item
  })
}

export function duplicateNode(
  items: CollectionItem[],
  id: string
): CollectionItem[] {
  // Ids novos em toda a subárvore (cloneItemWithNewIds), nomes intocados: um
  // id repetido faz o findNodeById devolver o primeiro, e editar a cópia
  // passaria a editar o original.
  //
  // Mesmo nome do original — sem sufixo. O "(Copy)" só servia pra distinguir
  // os dois na lista, mas num fluxo o nome da request é o passo ("1 - Gerar
  // token"), e ver o nome marcado logo depois de duplicar é mais confuso do
  // que ajuda: o rename (F2) é o caminho de quem quer renomear a cópia.
  return items.flatMap((item: CollectionItem) => {
    if (item.id === id) {
      return [item, cloneItemWithNewIds(item)]
    }

    if (item.item) {
      return [
        {
          ...item,
          item: duplicateNode(item.item, id),
        },
      ]
    }

    return [item]
  })
}

// Quebra a busca em termos (separados por espaço, minúsculos). Cada termo
// precisa aparecer em algum lugar do item — assim "post quote" acha um POST
// cujo nome ou URL contém "quote", em qualquer ordem.
export function parseTreeQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

// URL "crua" de uma request salva — mesma fonte que a aba usa ao abrir
// (ver buildTabFromItem em AppLayout.tsx).
export function getItemUrl(item: CollectionItem): string {
  return item.request?.urlexport?.raw || item.request?.url || ''
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options'])

// Regras de cada termo da busca:
//   - por padrão procura só no NOME (é o que está na tela e é destacado —
//     achar pela URL mostrava itens que pareciam não bater com a busca);
//   - termo que é um método HTTP ("post") também casa com o método;
//   - termo começando com "/" procura na URL ("/airSearch").
function itemMatchesToken(item: CollectionItem, token: string): boolean {
  if (token.startsWith('/') && token.length > 1) {
    return item.type !== 'folder' && getItemUrl(item).toLowerCase().includes(token)
  }
  if (item.name.toLowerCase().includes(token)) return true
  if (HTTP_METHODS.has(token) && item.method) {
    const method = item.method.toLowerCase()
    return method === token || (token === 'del' && method === 'delete')
  }
  return false
}

/**
 * Recorta a árvore pela busca.
 *
 * Cada termo pode casar com o próprio item OU com o nome de uma pasta acima
 * dele: "payments create" acha a request "Create" dentro de
 * "Order.Groups.Payments". Antes todos os termos tinham que estar no mesmo
 * item, e numa collection organizada por pastas o termo que distingue a
 * request costuma estar no nome da pasta, não no dela. Pelo menos um termo
 * precisa casar com o item (ou com a pasta mais funda que casou) — senão
 * cada termo cairia em uma pasta e a busca devolveria tudo abaixo delas.
 *
 * `keepIds`: itens que ficam mesmo sem casar (o que acabou de ser criado com
 * o filtro ativo — sem isto o "New Request" sumia no próprio clique).
 */
export function filterTree(
  items: CollectionItem[],
  query: string,
  keepIds?: ReadonlySet<string>
): CollectionItem[] {
  const tokens = parseTreeQuery(query)
  if (tokens.length === 0) return items

  // `pending`: termos que nenhuma pasta acima casou ainda.
  const walk = (list: CollectionItem[], pending: string[]): CollectionItem[] =>
    list
      .map((item) => {
        if (keepIds?.has(item.id)) return item

        const own = pending.filter((t) => itemMatchesToken(item, t))
        const left = pending.filter((t) => !own.includes(t))

        // O próprio item fecha a busca -> mantém a subárvore INTEIRA, senão
        // uma pasta achada pelo nome apareceria vazia. Precisa ter casado
        // algum termo AQUI (ver o comentário acima).
        if (left.length === 0 && own.length > 0) {
          // Filhos que também casam sozinhos -> mostra só eles (some o que
          // não bate, mesmo dentro de uma pasta que bate pelo nome).
          const narrowed = item.item ? walk(item.item, tokens) : []
          return narrowed.length > 0 ? { ...item, item: narrowed } : item
        }

        // Só pasta passa termos pra baixo: o nome de uma request não
        // qualifica os examples dela. Um filho que casaria TODOS os termos
        // sozinho também casa o que sobrou, então não precisa de uma segunda
        // busca do zero.
        const childPending = item.type === 'folder' ? left : pending
        const children = item.item ? walk(item.item, childPending) : []
        return children.length > 0 ? { ...item, item: children } : null
      })
      .filter((item): item is CollectionItem => item !== null)

  return walk(items, tokens)
}

// Ids de todo nó que pode expandir (pastas e requests com examples) — usado
// pra abrir tudo durante a busca.
export function collectExpandableIds(items: CollectionItem[]): Set<string> {
  const ids = new Set<string>()
  const walk = (list: CollectionItem[]) => {
    for (const item of list) {
      if (item.item && item.item.length > 0) {
        ids.add(item.id)
        walk(item.item)
      }
    }
  }
  walk(items)
  return ids
}

export function collectAllIds(items: CollectionItem[]): Set<string> {
  const ids = new Set<string>()
  const walk = (list: CollectionItem[]) => {
    for (const item of list) {
      ids.add(item.id)
      if (item.item) walk(item.item)
    }
  }
  walk(items)
  return ids
}

/**
 * Separa os ids que existem na árvore dos que não existem.
 *
 * Serve ao salvamento de abas. Gravar é procurar o nó pelo id e trocá-lo; um
 * id que não está lá faz a busca não encontrar nada e devolver a árvore
 * intacta — sem erro. Quem chama precisa saber disso para não dar a edição
 * por salva, porque nesse caso ela não foi para lugar nenhum.
 *
 * Acontece de verdade em dois casos: restaurar uma sessão de abas salva
 * noutro workspace, e excluir da árvore uma request que está aberta.
 */
export function partitionExisting(
  items: CollectionItem[],
  ids: string[]
): { present: string[]; missing: string[] } {
  const existing = collectAllIds(items)
  const present: string[] = []
  const missing: string[] = []

  for (const id of ids) {
    if (existing.has(id)) present.push(id)
    else missing.push(id)
  }

  return { present, missing }
}

// Quantidade de requests (não conta pastas nem examples) dentro do nó.
export function countRequests(item: CollectionItem): number {
  let total = 0
  for (const child of item.item ?? []) {
    if (child.type === 'request') total++
    else if (child.type === 'folder') total += countRequests(child)
  }
  return total
}

// Pastas favoritadas em qualquer nível, na ordem da árvore, com o nome da
// collection (raiz) a que pertencem — alimenta a seção "Favorites".
export function collectStarred(
  items: CollectionItem[]
): Array<{ item: CollectionItem; rootName: string | null }> {
  const result: Array<{ item: CollectionItem; rootName: string | null }> = []
  const walk = (list: CollectionItem[], rootName: string | null) => {
    for (const item of list) {
      if (item.starred) result.push({ item, rootName })
      if (item.item) walk(item.item, rootName ?? item.name)
    }
  }
  walk(items, null)
  return result
}

// Acha o id do pai de um nó — retorna `null` se o nó está na raiz, ou
// `undefined` se o id não existe na árvore (distinção necessária pra saber
// se "colar como irmão" deve ir pra raiz ou simplesmente falhar).
export function findParentId(
  items: CollectionItem[],
  id: string
): string | null | undefined {
  const search = (
    list: CollectionItem[],
    parent: string | null
  ): string | null | undefined => {
    for (const item of list) {
      if (item.id === id) return parent
      if (item.item) {
        const res = search(item.item, item.id)
        if (res !== undefined) return res
      }
    }
    return undefined
  }

  return search(items, null)
}

// Retorna os ids das pastas ancestrais (do topo até o pai direto) do item
// com o id informado — usado pra saber quais pastas precisam se abrir
// automaticamente pra revelar um item na árvore (ex: ao trocar de aba).
// Não inclui o próprio id. [] quando o item já está na raiz, null quando o
// id não existe na árvore.
export function findPathToItem(
  items: CollectionItem[],
  id: string
): string[] | null {
  for (const item of items) {
    if (item.id === id) return []
    if (item.item) {
      const childPath = findPathToItem(item.item, id)
      if (childPath !== null) return [item.id, ...childPath]
    }
  }
  return null
}

// `starred` é uma marca de uso pessoal e NÃO vai pro GitHub: ela sujaria o
// arquivo da collection com preferência de quem sincronizou por último, e
// todo mundo do repositório herdaria os favoritos dessa pessoa. As três
// funções abaixo mantêm isso: tira a marca do que sobe, e recoloca as marcas
// locais no que desce (um pull substitui a árvore inteira — sem isso, baixar
// atualizações apagaria os favoritos de quem puxou).
//
// O item ter sido MOVIDO pro topo ao ser favoritado continua indo pro GitHub
// normalmente: isso é ordem da árvore, conteúdo de verdade, não preferência.

// O que uma pasta favoritada guarda localmente: a estrela e a âncora pra onde
// ela volta se for desfavoritada.
export interface StarMark {
  starredAfterId?: string | null
}

// Cópia da árvore sem nenhuma marca de favorito — usada na hora de enviar.
export function stripStarredFlags(node: CollectionItem): CollectionItem {
  const { starred: _starred, starredAfterId: _anchor, ...rest } = node
  return {
    ...rest,
    ...(node.item ? { item: node.item.map(stripStarredFlags) } : {}),
  }
}

// Marcas de favorito de toda a árvore, indexadas por id da pasta.
export function collectStarMarks(
  items: CollectionItem[]
): Map<string, StarMark> {
  const marks = new Map<string, StarMark>()
  const walk = (list: CollectionItem[]) => {
    for (const item of list) {
      if (item.starred) marks.set(item.id, { starredAfterId: item.starredAfterId })
      if (item.item?.length) walk(item.item)
    }
  }
  walk(items)
  return marks
}

// Recoloca as marcas de favorito nas pastas correspondentes.
export function applyStarMarks(
  items: CollectionItem[],
  marks: Map<string, StarMark>
): CollectionItem[] {
  if (marks.size === 0) return items
  return items.map((item) => {
    const mark = marks.get(item.id)
    return {
      ...item,
      ...(mark ? { starred: true, starredAfterId: mark.starredAfterId } : {}),
      ...(item.item ? { item: applyStarMarks(item.item, marks) } : {}),
    }
  })
}

// Clona um item (e recursivamente todos os seus filhos) gerando IDs novos
// para cada nó — usado ao colar itens copiados, pra nunca duplicar um id já
// existente na árvore (o que quebraria seleção, DnD, etc).
export function cloneItemWithNewIds(node: CollectionItem): CollectionItem {
  // A cópia não é favorita: a estrela é do original, e a âncora
  // (starredAfterId) aponta pros irmãos dele, não pros da cópia.
  const { starred: _starred, starredAfterId: _anchor, ...rest } = node
  const cloned: CollectionItem = {
    ...rest,
    id: crypto.randomUUID(),
  }

  if (node.item) {
    cloned.item = node.item.map(cloneItemWithNewIds)
  }

  return cloned
}

// Cola uma lista de nós (já clonados com novos ids) dentro do parentId
// informado — ou na raiz da árvore se parentId for null. Segue o mesmo
// padrão recursivo de addNode.
export function pasteNodes(
  items: CollectionItem[],
  parentId: string | null,
  nodes: CollectionItem[]
): CollectionItem[] {
  // O que não pode morar nesse pai (ver canPlaceNode) fica de fora.
  if (parentId === null) {
    const fitting = nodes.filter(n => canPlaceNode(null, n))
    return fitting.length ? [...items, ...fitting] : items
  }

  return items.map((item: CollectionItem) => {
    if (item.id === parentId) {
      const fitting = nodes.filter(n => canPlaceNode(item, n))
      if (fitting.length === 0) return item
      return {
        ...item,
        item: [...(item.item || []), ...fitting],
      }
    }

    if (item.item) {
      return {
        ...item,
        item: pasteNodes(item.item, parentId, nodes),
      }
    }

    return item
  })
}

// Cola uma lista de nós (já clonados com novos ids) como IRMÃOS de
// `targetId`, logo antes ou logo depois dele — em vez de sempre no fim da
// lista do pai, como pasteNodes já fazia. Mesma técnica de splice usada por
// moveNode (insertBesides), só que inserindo nós novos em vez de realocar um
// nó já existente.
export function pasteNodesBeside(
  items: CollectionItem[],
  targetId: string,
  nodes: CollectionItem[],
  position: 'before' | 'after'
): CollectionItem[] {
  // Irmão de targetId = filho do pai dele; o que não cabe nesse pai sai.
  const parentId = findParentId(items, targetId)
  if (parentId === undefined) return items
  const parent = parentId === null ? null : findNodeById(items, parentId) ?? null
  const fitting = nodes.filter(n => canPlaceNode(parent, n))
  if (fitting.length === 0) return items
  return insertBeside(items, targetId, fitting, position)
}

function insertBeside(
  items: CollectionItem[],
  targetId: string,
  nodes: CollectionItem[],
  position: 'before' | 'after'
): CollectionItem[] {
  const idx = items.findIndex((item) => item.id === targetId)

  if (idx !== -1) {
    const result = [...items]
    const insertAt = position === 'before' ? idx : idx + 1
    result.splice(insertAt, 0, ...nodes)
    return result
  }

  return items.map((item) =>
    item.item
      ? { ...item, item: insertBeside(item.item, targetId, nodes, position) }
      : item
  )
}

export type DropPosition = 'before' | 'after' | 'inside'

// Uma linha visível da árvore, na ordem em que é desenhada (pré-ordem).
export interface TreeRow {
  id: string
  depth: number
}

export interface ProjectedDrop {
  // De quem o item arrastado vira irmão.
  targetId: string
  // Nível em que ele cai — é o recuo desenhado no traço de inserção.
  depth: number
  // Lado de targetId em que ele entra; ausente = depois.
  position?: 'before'
}

// Resolve um drop "entre duas linhas" quando o usuário puxa o ponteiro pra
// esquerda pra tirar o item de dentro das pastas.
//
// O ponto de inserção é logo ABAIXO de `aboveIndex`. Sem puxar nada, o item
// vira irmão dessa linha. Cada nível de `outdent` sobe um degrau: o item passa
// a ser irmão do ancestral daquela linha naquele nível — o que permite tirar
// uma pasta de dentro de outra em qualquer profundidade, inclusive até a raiz.
//
// O nível é limitado dos dois lados: no máximo o da linha de cima (mais fundo
// que isso seria "virar filho dela", que é o gesto de soltar no miolo da
// linha), e no mínimo o da linha de baixo — abaixo disso o item passaria a
// frente de linhas que ainda vêm depois dele, e o traço mentiria sobre onde
// ele vai parar.
export function projectSiblingDrop(
  rows: TreeRow[],
  aboveIndex: number,
  outdent: number
): ProjectedDrop {
  const above = rows[aboveIndex]
  const below = rows[aboveIndex + 1]

  // Logo abaixo de uma pasta aberta (a linha de baixo é filha dela): o traço
  // fica entre a pasta e o primeiro filho, então o item vira esse primeiro
  // filho. Antes virava "irmão depois da pasta" — ia parar abaixo da
  // subárvore inteira, longe do traço; e como o nível mínimo é o da linha de
  // baixo, puxar pra esquerda não mudava nada ali.
  if (below && below.depth > above.depth) {
    return { targetId: below.id, depth: below.depth, position: 'before' }
  }

  const maxDepth = above.depth
  // O mínimo nunca passa do máximo: encostar no topo do primeiro filho de uma
  // pasta aberta daria um "mínimo" mais fundo que o próprio máximo.
  const minDepth = Math.min(below ? below.depth : 0, maxDepth)

  const depth = Math.min(maxDepth, Math.max(minDepth, above.depth - outdent))

  if (depth === above.depth) {
    return { targetId: above.id, depth }
  }

  // A árvore é desenhada em pré-ordem, então o ancestral procurado é a
  // primeira linha ACIMA com a profundidade projetada.
  for (let i = aboveIndex - 1; i >= 0; i--) {
    if (rows[i].depth === depth) {
      return { targetId: rows[i].id, depth }
    }
  }

  return { targetId: above.id, depth: above.depth }
}

export interface NamedMatch {
  id: string
  /** Caminho até o item, da collection raiz ao pai — para exibir. */
  path: string[]
}

/**
 * Requests com exatamente este nome, fora a que se está editando.
 *
 * Serve ao "salvar em todas com o mesmo nome": quando o mesmo fluxo foi
 * duplicado por várias collections, corrigir uma request significa repetir a
 * correção N vezes à mão.
 *
 * Comparação exata, sem aparar nem ignorar maiúsculas: aqui um falso positivo
 * SOBRESCREVE uma request que ninguém mandou mexer, então vale exigir que o
 * nome seja o mesmo mesmo. Também não casa pastas nem examples — só requests.
 */
export function findRequestsByName(
  items: CollectionItem[],
  name: string,
  excludeId: string
): NamedMatch[] {
  const matches: NamedMatch[] = []
  if (!name) return matches

  const walk = (list: CollectionItem[], path: string[]) => {
    for (const item of list) {
      if (item.type === 'request' && item.name === name && item.id !== excludeId) {
        matches.push({ id: item.id, path })
      }
      if (item.item?.length) walk(item.item, [...path, item.name])
    }
  }

  walk(items, [])
  return matches
}

// ── Mover pelo menu (sem arrastar) ───────────────────────────────────────
//
// Construídas sobre o moveNode do drag de propósito: é ele que já trata
// extração, reinserção e o descarte da âncora de favorito. Duas implementações
// de "mover" divergiriam no primeiro ajuste, e o menu passaria a fazer algo
// sutilmente diferente do arraste.

/** Irmãos do nó, ou lista vazia se ele não existe na árvore. */
function siblingsOf(items: CollectionItem[], id: string): CollectionItem[] {
  const parentId = findParentId(items, id)
  if (parentId === undefined) return []
  if (parentId === null) return items
  return findNodeById(items, parentId)?.item ?? []
}

export function canMoveUp(items: CollectionItem[], id: string): boolean {
  const siblings = siblingsOf(items, id)
  return siblings.findIndex(s => s.id === id) > 0
}

export function canMoveDown(items: CollectionItem[], id: string): boolean {
  const siblings = siblingsOf(items, id)
  const index = siblings.findIndex(s => s.id === id)
  return index !== -1 && index < siblings.length - 1
}

/**
 * Só dá pra sair de uma pasta quando se está dentro de alguma — e quando o
 * lugar de destino aceita o item. Um example não tem "fora": sair da request
 * dona o deixaria solto numa pasta, sem a request que ele documenta.
 */
export function canMoveOut(items: CollectionItem[], id: string): boolean {
  const parentId = findParentId(items, id)
  if (!parentId) return false
  return canDropAt(items, id, parentId, 'after')
}

export function moveUp(items: CollectionItem[], id: string): CollectionItem[] {
  const siblings = siblingsOf(items, id)
  const index = siblings.findIndex(s => s.id === id)
  if (index <= 0) return items
  return moveNode(items, id, siblings[index - 1].id, 'before')
}

export function moveDown(items: CollectionItem[], id: string): CollectionItem[] {
  const siblings = siblingsOf(items, id)
  const index = siblings.findIndex(s => s.id === id)
  if (index === -1 || index >= siblings.length - 1) return items
  return moveNode(items, id, siblings[index + 1].id, 'after')
}

// "Pular" direto pra ponta, em vez de um passo por vez — útil numa pasta com
// dezenas de irmãos, onde "Move up" trinta vezes não é uma opção séria.
// canMoveUp/canMoveDown servem pra habilitar os dois: a condição é a MESMA
// ("não está já na ponta"), só o destino do pulo é diferente.
export function moveToFirst(items: CollectionItem[], id: string): CollectionItem[] {
  const siblings = siblingsOf(items, id)
  const index = siblings.findIndex(s => s.id === id)
  if (index <= 0) return items
  return moveNode(items, id, siblings[0].id, 'before')
}

export function moveToLast(items: CollectionItem[], id: string): CollectionItem[] {
  const siblings = siblingsOf(items, id)
  const index = siblings.findIndex(s => s.id === id)
  if (index === -1 || index >= siblings.length - 1) return items
  return moveNode(items, id, siblings[siblings.length - 1].id, 'after')
}

/**
 * Sobe um nível: o nó sai da pasta atual e passa a ficar logo DEPOIS dela,
 * entre os irmãos dela.
 *
 * Depois, e não antes, porque é de onde ele veio — pôr antes faria o item
 * aparecer acima da pasta que o continha, o que lê como se tivesse subido
 * dois lugares de uma vez.
 */
export function moveOut(items: CollectionItem[], id: string): CollectionItem[] {
  const parentId = findParentId(items, id)
  if (!parentId) return items
  return moveNode(items, id, parentId, 'after')
}

// ── Onde cada tipo de item pode morar ────────────────────────────────────
//
// Os filhos de uma request são os Saved Examples dela (type 'example'), e só
// eles; examples só existem dentro de uma request. Antes nada disso era
// conferido: soltar uma request na linha de um example (com a request aberta)
// a enfiava entre os examples — some do Runner, do export e da contagem, e só
// aparece abrindo a request. O caminho inverso tirava um example da request
// pra uma pasta, onde vira uma "request" sem método. Colar sobre um example
// fazia o mesmo que o arraste.

/** `node` pode ser filho de `parent` (null = raiz)? */
export function canPlaceNode(parent: CollectionItem | null, node: CollectionItem): boolean {
  if (node.type === 'example') return parent?.type === 'request'
  // A raiz é a lista de collections: só pasta mora ali. Uma request solta na
  // raiz aparecia como se fosse uma collection (e era sincronizada como uma)
  // — o "Move out" de uma request direto na collection, o arraste puxado até
  // o nível 0 e o colar no espaço vazio a punham lá. Mesma regra do MCP
  // (treeEdit: "only folders can be at the top level").
  if (parent === null) return node.type === 'folder'
  return parent.type === 'folder'
}

/**
 * Os nós de `ids` que existem, na ordem da árvore, sem os que estão dentro
 * de outro também escolhido — esses já vêm junto com o de cima. Copiar uma
 * pasta e um filho dela colava o filho duas vezes.
 */
export function topLevelInTreeOrder(items: CollectionItem[], ids: Iterable<string>): CollectionItem[] {
  return captureRemoval(items, ids).map((entry) => entry.node)
}

/** Quantos de `nodes` cabem como filhos de `parentId` (null = raiz). */
export function countPlaceable(
  items: CollectionItem[],
  parentId: string | null,
  nodes: CollectionItem[]
): number {
  const parent = parentId === null ? null : findNodeById(items, parentId) ?? null
  if (parentId !== null && !parent) return 0
  return nodes.filter((n) => canPlaceNode(parent, n)).length
}

/**
 * Soltar `activeId` em relação a `overId` deixa a árvore válida? Mesmas
 * regras do moveNode — existe à parte pra o indicador do arraste não
 * desenhar um destino que o drop vai recusar.
 */
export function canDropAt(
  items: CollectionItem[],
  activeId: string,
  overId: string,
  position: DropPosition
): boolean {
  if (activeId === overId) return false
  const active = findNodeById(items, activeId)
  const over = findNodeById(items, overId)
  if (!active || !over) return false
  // Ciclo: pasta pra dentro (ou pro lado de algo de dentro) dela mesma.
  if (findNodeById(active.item ?? [], overId)) return false

  if (position === 'inside') {
    return over.type === 'folder' && canPlaceNode(over, active)
  }

  const parentId = findParentId(items, overId)
  if (parentId === undefined) return false
  const parent = parentId === null ? null : findNodeById(items, parentId) ?? null
  return canPlaceNode(parent, active)
}

/**
 * Pai em que um colar deve cair, dado o item clicado.
 *
 * Pasta recebe dentro; request recebe examples dentro e manda o resto pro
 * lado dela; example manda examples pro lado dele (na mesma request) e o
 * resto pro lado da request dona. Sem alvo, a raiz.
 */
export function resolvePasteParent(
  items: CollectionItem[],
  target: CollectionItem | null,
  nodes: CollectionItem[]
): string | null {
  if (!target) return null
  if (target.type === 'folder') return target.id

  const allExamples = nodes.length > 0 && nodes.every(n => n.type === 'example')
  const parentOf = (id: string) => findParentId(items, id) ?? null

  if (target.type === 'request') return allExamples ? target.id : parentOf(target.id)

  const owner = parentOf(target.id)
  if (allExamples) return owner
  return owner ? parentOf(owner) : null
}

/**
 * Ids de pastas abertas que continuam valendo depois de a árvore mudar.
 *
 * Tira só o que SUMIU entre a árvore anterior e a nova (item apagado aqui ou
 * num pull). Antes a poda era "o que não está na árvore atual" — e a árvore
 * atual é só a do workspace aberto: trocar de workspace e fechar o app
 * apagava todas as pastas abertas do outro.
 *
 * Sem nenhuma collection em comum entre as duas árvores é troca de
 * workspace, não exclusão; árvore vazia é carregamento. Nos dois casos nada
 * sai. Devolve o mesmo Set quando nada mudou.
 */
export function pruneExpandedIds(
  expanded: Set<string>,
  prevItems: CollectionItem[],
  nextItems: CollectionItem[]
): Set<string> {
  if (expanded.size === 0 || prevItems.length === 0 || nextItems.length === 0) return expanded
  const nextRoots = new Set(nextItems.map(i => i.id))
  if (!prevItems.some(i => nextRoots.has(i.id))) return expanded

  const before = collectAllIds(prevItems)
  const after = collectAllIds(nextItems)
  let next: Set<string> | null = null
  for (const id of expanded) {
    if (before.has(id) && !after.has(id)) {
      next ??= new Set(expanded)
      next.delete(id)
    }
  }
  return next ?? expanded
}

// ── Desfazer (excluir e mover) ───────────────────────────────────────────
//
// O desfazer devolve SÓ o que a ação mexeu, em vez de restaurar a árvore
// inteira de antes: entre o clique e o "Undo" do toast a pessoa pode ter
// renomeado ou salvo outra coisa, e voltar a árvore toda apagaria isso.

/** Onde um nó está: pai (null = raiz) e posição entre os irmãos. */
export interface TreePosition {
  parentId: string | null
  index: number
}

export interface RemovedEntry extends TreePosition {
  node: CollectionItem
}

/**
 * O que excluir `ids` vai tirar da árvore, e de onde. Um id dentro de outro
 * que também sai não entra: some junto com o de cima e volta junto com ele.
 * Vem em pré-ordem — a ordem em que restoreRemoved precisa reinserir para os
 * índices continuarem certos.
 */
export function captureRemoval(items: CollectionItem[], ids: Iterable<string>): RemovedEntry[] {
  const wanted = new Set(ids)
  const out: RemovedEntry[] = []
  const walk = (list: CollectionItem[], parentId: string | null) => {
    list.forEach((node, index) => {
      if (wanted.has(node.id)) {
        out.push({ node, parentId, index })
        return
      }
      if (node.item) walk(node.item, node.id)
    })
  }
  walk(items, null)
  return out
}

/** Insere `node` como filho de `parentId` (null = raiz) na posição `index`. */
function insertAt(
  items: CollectionItem[],
  parentId: string | null,
  index: number,
  node: CollectionItem
): CollectionItem[] | null {
  if (parentId === null) {
    const next = [...items]
    next.splice(Math.min(index, next.length), 0, node)
    return next
  }
  let done = false
  const walk = (list: CollectionItem[]): CollectionItem[] =>
    list.map((item) => {
      if (done) return item
      if (item.id === parentId) {
        done = true
        const children = [...(item.item ?? [])]
        children.splice(Math.min(index, children.length), 0, node)
        return { ...item, item: children }
      }
      return item.item ? { ...item, item: walk(item.item) } : item
    })
  const next = walk(items)
  return done ? next : null
}

/**
 * Devolve à árvore o que captureRemoval guardou, cada um no lugar de onde
 * saiu. Pula o que já voltou (Undo clicado duas vezes) e o que perdeu o pai
 * nesse meio-tempo — não há lugar honesto pra ele.
 */
export function restoreRemoved(items: CollectionItem[], removed: RemovedEntry[]): CollectionItem[] {
  let next = items
  const present = collectAllIds(items)
  for (const entry of removed) {
    if (present.has(entry.node.id)) continue
    const inserted = insertAt(next, entry.parentId, entry.index, entry.node)
    if (inserted) next = inserted
  }
  return next
}

/** Posição atual do nó, ou null se ele não está na árvore. */
export function positionOf(items: CollectionItem[], id: string): TreePosition | null {
  const parentId = findParentId(items, id)
  if (parentId === undefined) return null
  const siblings = parentId === null ? items : findNodeById(items, parentId)?.item ?? []
  return { parentId, index: siblings.findIndex((s) => s.id === id) }
}

/** Leva o nó de volta pra `position` (o desfazer de um mover). */
export function restorePosition(
  items: CollectionItem[],
  id: string,
  position: TreePosition
): CollectionItem[] {
  const node = findNodeById(items, id)
  if (!node) return items
  const without = removeNode(items, id)
  return insertAt(without, position.parentId, position.index, node) ?? items
}

export function moveNode(
  items: CollectionItem[],
  activeId: string,
  overId: string,
  position: DropPosition = 'after'
): CollectionItem[] {
  if (activeId === overId) return items
  if (!canDropAt(items, activeId, overId, position)) return items

  // 1. Localizar e extrair o nó ativo
  let activeNode: CollectionItem | null = null

  const extract = (list: CollectionItem[]): CollectionItem[] =>
    list.reduce<CollectionItem[]>((acc, item) => {
      if (item.id === activeId) {
        // Arrastar a pasta esquece de onde ela foi favoritada: o usuário
        // acabou de escolher um lugar novo pra ela na mão, então
        // desfavoritar não pode puxá-la de volta pro lugar antigo.
        const { starredAfterId: _anchor, ...moved } = item
        activeNode = moved as CollectionItem
        return acc
      }
      acc.push(
        item.item ? { ...item, item: extract(item.item) } : item
      )
      return acc
    }, [])

  const treeWithout = extract(items)

  // Se o nó arrastado não existia na árvore, não altera nada
  if (!activeNode) return items

  // Função para verificar se 'targetId' está dentro da subárvore de 'node'
  const isDescendant = (node: CollectionItem, targetId: string): boolean => {
    if (node.id === targetId) return true
    if (!node.item) return false
    return node.item.some((child) => isDescendant(child, targetId))
  }

  // IMPEDE CICLOS: Evita mover uma pasta para dentro/perto de seus próprios filhos
  if (isDescendant(activeNode, overId)) {
    return items
  }

  // 2a. Soltar DENTRO de um nó (Apenas se o destino for uma 'folder')
  const insertInside = (list: CollectionItem[]): { updated: CollectionItem[]; inserted: boolean } => {
    let inserted = false

    const updated = list.map((item) => {
      if (item.id === overId) {
        // Garantia extra: só insere 'inside' se for do tipo pasta
        if (item.type !== 'folder') return item

        inserted = true
        return {
          ...item,
          item: [...(item.item ?? []), activeNode!],
        }
      }

      if (item.item) {
        const res = insertInside(item.item)
        if (res.inserted) inserted = true
        return { ...item, item: res.updated }
      }

      return item
    })

    return { updated, inserted }
  }

  // 2b. Soltar ANTES ou DEPOIS de um nó (Virar irmão)
  const insertBesides = (list: CollectionItem[]): { updated: CollectionItem[]; inserted: boolean } => {
    const idx = list.findIndex((i) => i.id === overId)

    if (idx !== -1) {
      const result = [...list]
      const insertAt = position === 'before' ? idx : idx + 1
      result.splice(insertAt, 0, activeNode!)
      return { updated: result, inserted: true }
    }

    let inserted = false
    const updated = list.map((item) => {
      if (item.item) {
        const res = insertBesides(item.item)
        if (res.inserted) inserted = true
        return { ...item, item: res.updated }
      }
      return item
    })

    return { updated, inserted }
  }

  // Executa a inserção baseada na posição
  if (position === 'inside') {
    const { updated, inserted } = insertInside(treeWithout)
    // Se não encontrou a pasta de destino ou se o destino não era pasta, aborta a movimentação sem mover para a raiz
    return inserted ? updated : items
  } else {
    const { updated, inserted } = insertBesides(treeWithout)
    return inserted ? updated : items
  }
}

/**
 * Tira um prefixo de numeração do começo do nome.
 *
 * Sem isto, renumerar duas vezes empilharia: `01 - 01 - Booking Flow`. Casa
 * o formato que a própria numeração escreve (dígitos, espaço, hífen, espaço)
 * e também o sem espaços, que aparece em nome digitado à mão.
 */
export function stripNumberPrefix(name: string): string {
  return name.replace(/^\s*\d+\s*-\s*/, '')
}

/** Largura do número: 2 por padrão, mais quando a pasta exige. */
export function numberWidth(total: number): number {
  return Math.max(2, String(total).length)
}

/**
 * Renumera os filhos DIRETOS de uma pasta: `01 - `, `02 - `, na ordem da
 * árvore.
 *
 * Só os diretos. Descer recursivamente faria cada subpasta recomeçar do 01, e
 * o item escolhido no menu é esta pasta — renomear coisas que não estão à
 * vista é o tipo de efeito que ninguém pediu.
 *
 * Devolve a árvore nova e os nomes anteriores, para quem chama poder desfazer:
 * são muitos renomes de uma vez e não há undo no app.
 */
export function numberFolderChildren(
  items: CollectionItem[],
  folderId: string
): { items: CollectionItem[]; previous: Array<{ id: string; name: string }> } {
  const previous: Array<{ id: string; name: string }> = []

  const walk = (list: CollectionItem[]): CollectionItem[] =>
    list.map(item => {
      if (item.id !== folderId) {
        return item.item ? { ...item, item: walk(item.item) } : item
      }

      const children = item.item ?? []
      const width = numberWidth(children.length)

      return {
        ...item,
        item: children.map((child, i) => {
          const name = `${String(i + 1).padStart(width, '0')} - ${stripNumberPrefix(child.name)}`
          if (name === child.name) return child
          previous.push({ id: child.id, name: child.name })
          return { ...child, name }
        }),
      }
    })

  return { items: walk(items), previous }
}

/** Devolve os nomes guardados por numberFolderChildren. */
export function restoreNames(
  items: CollectionItem[],
  previous: Array<{ id: string; name: string }>
): CollectionItem[] {
  if (previous.length === 0) return items
  const byId = new Map(previous.map(p => [p.id, p.name]))

  const walk = (list: CollectionItem[]): CollectionItem[] =>
    list.map(item => {
      const name = byId.get(item.id)
      const next = name !== undefined ? { ...item, name } : item
      return next.item ? { ...next, item: walk(next.item) } : next
    })

  return walk(items)
}

/**
 * Grava (ou apaga) a descrição de um nó, em qualquer nível.
 *
 * Texto em branco remove o campo em vez de guardar string vazia: `description: ''`
 * em todo item incharia o arquivo da collection e apareceria como alteração
 * no diff do sync — a mesma razão do `markers` ausente em vez de `[]`.
 */
export function setDescription(
  items: CollectionItem[],
  id: string,
  text: string
): CollectionItem[] {
  const clean = text.trim()

  const walk = (list: CollectionItem[]): CollectionItem[] => {
    let changed = false
    const out = list.map((item) => {
      if (item.id === id) {
        if ((item.description ?? '') === clean) return item
        changed = true
        if (!clean) {
          const { description: _dropped, ...rest } = item
          return rest
        }
        return { ...item, description: clean }
      }
      if (item.item?.length) {
        const children = walk(item.item)
        if (children !== item.item) {
          changed = true
          return { ...item, item: children }
        }
      }
      return item
    })
    return changed ? out : list
  }

  return walk(items)
}

/**
 * Grava a URL de uma request, em qualquer nível da árvore.
 *
 * Mesma razão do setRequestScript logo abaixo: o Collection Runner só tem o
 * id da request (não um Tab aberto) — usado pelo popover de variável da URL
 * pra trocar um token `{{var}}` por outro direto dali ("switch to variable
 * list"), sem abrir a request.
 */
export function setRequestUrl(
  items: CollectionItem[],
  id: string,
  url: string
): CollectionItem[] {
  const walk = (list: CollectionItem[]): CollectionItem[] => {
    let changed = false
    const out = list.map((item) => {
      if (item.id === id) {
        if (!item.request || item.request.url === url) return item
        changed = true
        return { ...item, request: { ...item.request, url } }
      }
      if (item.item?.length) {
        const children = walk(item.item)
        if (children !== item.item) {
          changed = true
          return { ...item, item: children }
        }
      }
      return item
    })
    return changed ? out : list
  }

  return walk(items)
}

/**
 * Grava o script de uma fase (pre-request ou post-response) de uma request,
 * em qualquer nível da árvore.
 *
 * Existe pra o Collection Runner poder editar o script sem abrir a aba da
 * request — ele só tem o id, não um Tab inteiro. Mescla com o `request`
 * existente (url, headers, auth, body…) e com a OUTRA fase do script, em
 * vez de substituir o objeto inteiro: gravar só teria o texto da fase que
 * mudou, e a outra sumiria.
 */
export function setRequestScript(
  items: CollectionItem[],
  id: string,
  phase: 'preRequest' | 'postResponse',
  value: string
): CollectionItem[] {
  const walk = (list: CollectionItem[]): CollectionItem[] => {
    let changed = false
    const out = list.map((item) => {
      if (item.id === id) {
        // Nó sem `request` (pasta, request mal formada) não tem onde gravar.
        if (!item.request || item.request.scripts?.[phase] === value) return item
        changed = true
        return {
          ...item,
          request: {
            ...item.request,
            scripts: {
              preRequest: item.request.scripts?.preRequest ?? '',
              postResponse: item.request.scripts?.postResponse ?? '',
              [phase]: value,
            },
          },
        }
      }
      if (item.item?.length) {
        const children = walk(item.item)
        if (children !== item.item) {
          changed = true
          return { ...item, item: children }
        }
      }
      return item
    })
    return changed ? out : list
  }

  return walk(items)
}

/**
 * Todas as requests de uma subárvore, em ordem de tela, descendo nas pastas.
 *
 * Examples ficam de fora: são filhos `type: 'example'` de uma request (ver
 * CollectionItem.ts) e abrir um por um junto encheria a barra de abas de
 * snapshots que ninguém pediu.
 *
 * Existe um `flattenRequests` igual no runCollectionRequest.ts. São dez
 * linhas repetidas de propósito: importá-lo aqui arrastaria o módulo do
 * Runner (e o `invoke` do Tauri junto) pra dentro da árvore.
 */
export function collectRequests(items: CollectionItem[]): CollectionItem[] {
  const out: CollectionItem[] = []
  const walk = (list: CollectionItem[]) => {
    for (const item of list) {
      if (item.type === 'request') out.push(item)
      else if (item.type === 'folder' && item.item?.length) walk(item.item)
    }
  }
  walk(items)
  return out
}
