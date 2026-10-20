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

export function removeNode(
  items: CollectionItem[],
  id: string
): CollectionItem[] {
  return items
    .filter((item: CollectionItem) => item.id !== id)
    .map((item: CollectionItem) => ({
      ...item,
      item: item.item
        ? removeNode(item.item, id)
        : undefined,
    }))
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
  // Ids novos em toda a subárvore, nomes intocados: um id repetido faz o
  // findNodeById devolver o primeiro, e editar a cópia passaria a editar o
  // original.
  const cloneChild = (node: CollectionItem): CollectionItem => {
    const cloned: CollectionItem = { ...node, id: crypto.randomUUID() }
    if (node.item) cloned.item = node.item.map(cloneChild)
    return cloned
  }

  // Só o nó duplicado ganha "(Copy)". Antes o sufixo descia pra subárvore
  // inteira, e duplicar uma pasta de dez requests devolvia dez nomes sujos —
  // num fluxo, onde o nome da request é o passo ("1 - Gerar token"), isso
  // estraga justamente o que se lê pra entender a ordem.
  const cloneNode = (node: CollectionItem): CollectionItem => ({
    ...cloneChild(node),
    name: `${node.name} (Copy)`,
  })

  return items.flatMap((item: CollectionItem) => {
    if (item.id === id) {
      return [item, cloneNode(item)]
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

export function filterTree(
  items: CollectionItem[],
  query: string
): CollectionItem[] {
  const tokens = parseTreeQuery(query)
  if (tokens.length === 0) return items

  const walk = (list: CollectionItem[]): CollectionItem[] =>
    list
      .map((item) => {
        const children = item.item ? walk(item.item) : []
        // Filhos que batem -> mostra só eles (some o que não bate, mesmo
        // dentro de uma pasta que bate pelo nome).
        if (children.length > 0) return { ...item, item: children }

        // Nenhum filho bate, mas o próprio item bate -> mantém a subárvore
        // INTEIRA, senão uma pasta achada pelo nome apareceria vazia.
        if (tokens.every((t) => itemMatchesToken(item, t))) return item

        return null
      })
      .filter((item): item is CollectionItem => item !== null)

  return walk(items)
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
  const cloned: CollectionItem = {
    ...node,
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
  if (parentId === null) {
    return [...items, ...nodes]
  }

  return items.map((item: CollectionItem) => {
    if (item.id === parentId) {
      return {
        ...item,
        item: [...(item.item || []), ...nodes],
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

/** Só dá pra sair de uma pasta quando se está dentro de alguma. */
export function canMoveOut(items: CollectionItem[], id: string): boolean {
  return !!findParentId(items, id)
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

export function moveNode(
  items: CollectionItem[],
  activeId: string,
  overId: string,
  position: DropPosition = 'after'
): CollectionItem[] {
  if (activeId === overId) return items

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

// export function moveNode(
//   items: CollectionItem[],
//   activeId: string,
//   overId: string,
//   position: DropPosition = 'after'
// ): CollectionItem[] {
//   if (activeId === overId) return items

//   // 1. Extrair o nó ativo
//   let activeNode: CollectionItem | null = null

//   const extract = (list: CollectionItem[]): CollectionItem[] =>
//     list.reduce<CollectionItem[]>((acc: CollectionItem[], item: CollectionItem) => {
//       if (item.id === activeId) {
//         activeNode = { ...item }
//         return acc
//       }
//       acc.push(
//         item.item ? { ...item, item: extract(item.item) } : item
//       )
//       return acc
//     }, [])

//   const treeWithout = extract(items)

//   if (!activeNode) return items

//   // Evita soltar uma pasta dentro dela mesma (ou dentro de um descendente dela)
//   const containsId = (node: CollectionItem, id: string): boolean => {
//     if (node.id === id) return true
//     if (!node.item) return false
//     return node.item.some((child: CollectionItem) => containsId(child, id))
//   }

//   if (position === 'inside' && containsId(activeNode, overId)) {
//     return items
//   }

//   // 2a. Soltar DENTRO de uma pasta → vira o último filho dela
//   const insertInside = (list: CollectionItem[]): CollectionItem[] =>
//     list.map((item: CollectionItem) => {
//       if (item.id === overId) {
//         return {
//           ...item,
//       result.splice(insertAt, 0, activeNode!)
//       return result
//     }

//     return list.map((item: CollectionItem) =>
//       item.item ? { ...item, item: insertBesides(item.item) } : item
//     )
//   }

//   const result =
//     position === 'inside' ? insertInside(treeWithout) : insertBesides(treeWithout)

//   const wasInserted = JSON.stringify(result) !== JSON.stringify(treeWithout)
//   if (!wasInserted) return [...treeWithout, activeNode!]

//   return result
// }

//-----------------------------------------

// import { CollectionItem } from '@/app/types/CollectionItem'

// export type DropPosition = 'before' | 'after' | 'inside'

// function removeNode(
//   items: CollectionItem[],
//   id: string
// ): { items: CollectionItem[]; removed: CollectionItem | null } {
//   let removed: CollectionItem | null = null

//   const walk = (list: CollectionItem[]): CollectionItem[] =>
//     list
//         node.item ? { ...node, item: walk(node.item) } : node
//     next.splice(insertAt, 0, node)
//     return next
//   }

//   return items.map(item =>
//     item.item
//       ? { ...item, item: insertNode(item.item, targetId, node, position) }
//       : item
//   )
// }


// export function moveNode(
//   items: CollectionItem[],
//   activeId: string,
//   overId: string,
//   position: DropPosition = 'after'
// ): CollectionItem[] {
//   if (activeId === overId) return items

//   // 1. Extrair o nó ativo (mesma lógica de extração que você já tinha)
//   let activeNode: CollectionItem | null = null

//   const extract = (list: CollectionItem[]): CollectionItem[] =>
//     list.reduce<CollectionItem[]>((acc, item) => {
//       if (item.id === activeId) {
//         activeNode = { ...item }
//         return acc
//       }
//       acc.push(
//         item.item ? { ...item, item: extract(item.item) } : item
//       )
//       return acc
//     }, [])

//   const treeWithout = extract(items)

//   if (!activeNode) return items

//   // Evita soltar uma pasta dentro dela mesma (ou dentro de um descendente dela)
//   const containsId = (node: CollectionItem, id: string): boolean => {
//     if (node.id === id) return true
//     if (!node.item) return false
//     return node.item.some(child => containsId(child, id))
//   }

//   if (position === 'inside' && containsId(activeNode, overId)) {
//     return items
//   }

//   // 2a. Soltar DENTRO de uma pasta → vira o último filho dela
//   const insertInside = (list: CollectionItem[]): CollectionItem[] =>
//     list.map(item => {
//       if (item.id === overId) {
//         return {
//           ...item,
//       result.splice(insertAt, 0, activeNode!)
//       return result
//     }

//     return list.map(item =>
//       item.item ? { ...item, item: insertBesides(item.item) } : item
//     )
//   }

//   const result =
//     position === 'inside' ? insertInside(treeWithout) : insertBesides(treeWithout)

//   // Se não encontrou o "over" em nenhum nível, adiciona no final da raiz
//   const wasInserted = JSON.stringify(result) !== JSON.stringify(treeWithout)
//   if (!wasInserted) return [...treeWithout, activeNode!]

//   return result
// }


// import { CollectionItem } from '@/app/types/CollectionItem'

// export function renameNode(
//   items: CollectionItem[],
//   id: string,
//   newName: string
// ): CollectionItem[] {
//   return items.map(item => {
//     if (item.id === id) {
//       return {
//         ...item,
//         name: newName,
//       }
//     }

//     if (item.item) {
//       return {
//         ...item,
//       ...item,
//       item: item.item
//         ? removeNode(item.item, id)
//         : undefined,
//         ...item,
//         item: [...(item.item || []), node],
//       }
//     }

//     if (item.item) {
//       return {
//         ...item,
//       ...node,
//       id: crypto.randomUUID(),
//       name: `${node.name} (Copy)`,
//     }

//     if (node.item) {
//       cloned.item = node.item.map(cloneNode)
//     }

//     return cloned
//   }

//   return items.flatMap(item => {
//     if (item.id === id) {
//       return [item, cloneNode(item)]
//     }

//     if (item.item) {
//       return [
//         {
//           ...item,
//           item: duplicateNode(item.item, id),
//         },
//       ]
//     }

//     return [item]
//   })
// }

// export function filterTree(
//   items: CollectionItem[],
//   query: string
// ): CollectionItem[] {
//   const lower = query.toLowerCase()

//   return items
//     .map(item => {
//       const matches = item.name.toLowerCase().includes(lower)

//       const filtereditem = item.item
//         ? filterTree(item.item, query)
//         : []

//       if (matches || filtereditem.length > 0) {
//         return {
//           ...item,
//     list.reduce<CollectionItem[]>((acc, item) => {
//       if (item.id === activeId) {
//         activeNode = { ...item }
//         return acc
//       }
//       acc.push(
//         item.item ? { ...item, item: extract(item.item) } : item
//       )
//       return acc
//     }, [])

//   const treeWithout = extract(items)

//   if (!activeNode) return items

//   // 2. Inserir após o nó "over" no mesmo nível
//   const insert = (list: CollectionItem[]): CollectionItem[] => {
//     const idx = list.findIndex((i) => i.id === overId)

//     if (idx !== -1) {
//       const result = [...list]
//       result.splice(idx + 1, 0, activeNode!)
//       return result
//     }

//     return list.map((item) =>
//       item.item ? { ...item, item: insert(item.item) } : item
//     )
//   }

//   // 3. Caso especial: "over" é a raiz
//   const overIsRoot = treeWithout.findIndex((i) => i.id === overId) !== -1
//     || items.findIndex((i) => i.id === overId) !== -1

//   // Tenta inserir em qualquer nível
//   const result = insert(treeWithout)

//   // Se não encontrou o over em nenhum nível, adiciona no final da raiz
//   const wasInserted = JSON.stringify(result).length !== JSON.stringify(treeWithout).length
//   if (!wasInserted) return [...treeWithout, activeNode!]

//   return result
// }