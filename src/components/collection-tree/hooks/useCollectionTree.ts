'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CollectionItem, ExampleData, RequestDetails } from '@/app/types/CollectionItem'
import { emptyGrpcRequest } from '@/app/types/Grpc'
import {
  addNode,
  cloneItemWithNewIds,
  duplicateNode,
  filterTree,
  pasteNodes,
  pasteNodesBeside,
  removeNode,
  renameNode,
  toggleStarNode,
} from '../utils/tree.utils'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { ParsedCurlRequest } from '@/lib/curlParser'
import { toPostmanCollection, exportFileName, countSkippedGrpc } from '@/lib/postmanExport'

interface Params {
  items: CollectionItem[]
  onUpdateItems: (items: CollectionItem[]) => void
  onRename?: (id: string, newName: string) => void 
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

const VALID_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']

function normalizeMethod(method: string): HttpMethod {
  const upper = method.trim().toUpperCase()
  return (VALID_METHODS as string[]).includes(upper)
    ? (upper as HttpMethod)
    : 'GET'
}

// ─── Hook ────────────────────────────────────────────────────────────────────

const LEGACY_COLLECTIONS_KEY = 'postman_clone_collections'

export function useCollectionTree({ items, onUpdateItems,onRename }: Params) {
  const [search, setSearch] = useState('')

  // Antes isto gravava a árvore inteira no localStorage a cada alteração, numa
  // chave que ninguém lê (as collections são salvas no store do Tauri, ver
  // saveWorkspaceCollections). Com collections grandes passava da cota de
  // ~5 MB e o setItem estourava QuotaExceededError — além de tirar espaço do
  // histórico de respostas, dos rascunhos de abas e do log de erros, que
  // dividem a mesma cota. Agora só apaga o que sobrou de versões anteriores.
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_COLLECTIONS_KEY)
    } catch {
      // Sem acesso ao storage: nada a limpar.
    }
  }, [])

  // Os "create*" devolvem o id criado: a árvore usa pra revelar o item novo
  // (mesmo com filtro ativo) e já abrir o rename nele.
  const createRequest = useCallback((parentId: string): string => {
    const node: CollectionItem = {
      id:     crypto.randomUUID(),
      name:   'New Request',
      type:   'request',
      method: 'GET',
      request: {
        url: '',
        urlexport: { host: [], path: [], raw: '', variable: [] },
        headers: [],
        body: '',
        auth:    { type: 'none', token: '' },
        scripts: { preRequest: '', postResponse: '' },
      },
    }
    onUpdateItems(addNode(items, parentId, node))
    return node.id
  }, [items, onUpdateItems])

  // Request gRPC vazia — o schema vem depois (reflection ou .proto), na aba.
  const createGrpcRequest = useCallback((parentId: string): string => {
    const node: CollectionItem = {
      id:       crypto.randomUUID(),
      name:     'New gRPC Request',
      type:     'request',
      protocol: 'grpc',
      grpc:     emptyGrpcRequest(),
    }
    onUpdateItems(addNode(items, parentId, node))
    return node.id
  }, [items, onUpdateItems])

  // Cria um Saved Example em branco (igual ao "Add Example" do Postman) como
  // filho do request informado, e devolve o node criado pra quem chamou já
  // poder abrir o editor sem precisar esperar o próximo render. `seed` deixa
  // popular o example a partir de uma resposta real (fluxo "Save as Example"
  // no painel de resposta), em vez de sempre nascer vazio.
  const createExample = useCallback((parentItem: CollectionItem, seed?: Partial<ExampleData>): CollectionItem => {
    const node: CollectionItem = {
      id: crypto.randomUUID(),
      name: seed?.status ? `${parentItem.name} - Example` : 'New Example',
      type: 'example',
      // O method mora em `item.method` (fora de `.request` — mesmo padrão do
      // Postman), não copiar aqui fazia o example herdar sempre "GET".
      method: parentItem.method,
      request: parentItem.request ? { ...parentItem.request } : undefined,
      example: {
        status: seed?.status ?? 'OK',
        code: seed?.code ?? 200,
        headers: seed?.headers ?? [],
        body: seed?.body ?? '',
        previewLanguage: seed?.previewLanguage ?? 'json',
      },
    }
    onUpdateItems(addNode(items, parentItem.id, node))
    return node
  }, [items, onUpdateItems])

  // Salva as edições feitas no editor de example (nome, request original e
  // dados da resposta salva) de volta na árvore.
  const updateExample = useCallback((
    id: string,
    patch: { name?: string; request?: RequestDetails; example?: Partial<ExampleData> }
  ) => {
    const applyPatch = (list: CollectionItem[]): CollectionItem[] => list.map((it) => {
      if (it.id === id) {
        return {
          ...it,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.request !== undefined ? { request: patch.request } : {}),
          example: { ...(it.example as ExampleData), ...(patch.example ?? {}) },
        }
      }
      if (it.item) return { ...it, item: applyPatch(it.item) }
      return it
    })
    onUpdateItems(applyPatch(items))
  }, [items, onUpdateItems])

  const createFolder = useCallback((parentId: string): string => {
    const node: CollectionItem = {
      id:   crypto.randomUUID(),
      name: 'New Folder',
      type: 'folder',
      item: [],
    }
    onUpdateItems(addNode(items, parentId, node))
    return node.id
  }, [items, onUpdateItems])

  const createRequestFromCurl = useCallback((
  parentId: string,
  parsed: ParsedCurlRequest
): string => {
  const rawUrl = parsed.queryParams.length
    ? `${parsed.baseUrl}?${parsed.queryParams
        .map((p) => `${p.key}=${p.value}`)
        .join('&')}`
    : parsed.baseUrl

  const node: CollectionItem = {
    id:     crypto.randomUUID(),
    name:   parsed.baseUrl || 'Imported Request',
    type:   'request',
    method: normalizeMethod(parsed.method),
    request: {
      url: rawUrl,
      urlexport: {
        host: [],
        path: [],
        raw: rawUrl,
        variable: parsed.queryParams.map((p) => ({
          id:      crypto.randomUUID(), // 👈 obrigatório pelo tipo QueryParam
          key:     p.key,
          value:   p.value,
          enabled: true,                // 👈 obrigatório pelo tipo QueryParam
        })),
      },
      headers: parsed.headers.map((h) => ({
        key: h.key,
        value: h.value,
        enabled: true,
      })),
      body: parsed.body ?? '',
      auth:    { type: 'none', token: '' },
      scripts: { preRequest: '', postResponse: '' },
    },
  }
  onUpdateItems(addNode(items, parentId, node))
  return node.id
}, [items, onUpdateItems])


  // Devolve o que aconteceu pra quem chamou avisar: antes o export não dava
  // retorno nenhum — nem de sucesso, nem de falha ao gravar (que virava uma
  // promise rejeitada que ninguém via), nem das gRPC deixadas de fora.
  const exportCollection = useCallback(async (
    item: CollectionItem
  ): Promise<{ saved: boolean; skippedGrpc: number }> => {
    // Converte para o padrão Postman v2.1
    const postmanJson = toPostmanCollection(item)
    const json = JSON.stringify(postmanJson, null, 2)

    const filePath = await save({
      defaultPath: exportFileName(item.name),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })

    if (!filePath) return { saved: false, skippedGrpc: 0 }

    await writeTextFile(filePath, json)
    return { saved: true, skippedGrpc: countSkippedGrpc(item) }
  }, [])

  const rename = useCallback((id: string, newName: string) => {
    onUpdateItems(renameNode(items, id, newName))
    onRename?.(id, newName) // avisa quem estiver ouvindo (ex: as tabs abertas)
  }, [items, onUpdateItems, onRename])

  const remove = useCallback((id: string) => {
    onUpdateItems(removeNode(items, id))
  }, [items, onUpdateItems])

  // Marca/desmarca uma pasta como favorita — marcar move ela pro topo dos
  // irmãos (ver toggleStarNode).
  const toggleStar = useCallback((id: string) => {
    onUpdateItems(toggleStarNode(items, id))
  }, [items, onUpdateItems])

  const duplicate = useCallback((id: string) => {
    onUpdateItems(duplicateNode(items, id))
  }, [items, onUpdateItems])

  // Cola os itens copiados (clonando cada um com ids novos, recursivamente,
  // pra nunca duplicar ids já existentes na árvore) dentro de parentId — ou
  // na raiz se parentId for null.
  const pasteItems = useCallback((parentId: string | null, nodes: CollectionItem[]) => {
    const cloned = nodes.map(cloneItemWithNewIds)
    onUpdateItems(pasteNodes(items, parentId, cloned))
  }, [items, onUpdateItems])

  // Mesma clonagem do pasteItems, mas como irmão de targetId — logo antes ou
  // logo depois dele — em vez de sempre no fim da lista do pai.
  const pasteItemsBeside = useCallback((targetId: string, nodes: CollectionItem[], position: 'before' | 'after') => {
    const cloned = nodes.map(cloneItemWithNewIds)
    onUpdateItems(pasteNodesBeside(items, targetId, cloned, position))
  }, [items, onUpdateItems])

  // Itens criados com o filtro ativo: aparecem mesmo sem casar com a busca,
  // até ela mudar (ver filterTree). Sem isto o item novo sumia no clique.
  const [revealIds, setRevealIds] = useState<ReadonlySet<string>>(() => new Set())
  const reveal = useCallback((id: string) => {
    setRevealIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])
  const changeSearch = useCallback((value: string) => {
    setSearch(value)
    setRevealIds(prev => (prev.size === 0 ? prev : new Set()))
  }, [])

  const filteredItems = useMemo(() => {
    if (!search) return items
    return filterTree(items, search, revealIds)
  }, [items, search, revealIds])


  // Objeto estável enquanto `items` não muda: ele desce como prop pra cada
  // TreeNode (memo), e um objeto novo a cada render fazia as centenas de
  // linhas re-renderizarem a cada abrir de menu, foco ou digitação.
  const actions = useMemo(() => ({
    createRequest,
    createGrpcRequest,
    createFolder,
    createExample,
    updateExample,
    rename,
    remove,
    toggleStar,
    duplicate,
    export: exportCollection,
    createRequestFromCurl,
    pasteItems,
    pasteItemsBeside,
  }), [
    createRequest, createGrpcRequest, createFolder, createExample, updateExample, rename,
    remove, toggleStar, duplicate, exportCollection, createRequestFromCurl, pasteItems,
    pasteItemsBeside,
  ])

  return {
    search,
    setSearch: changeSearch,
    filteredItems,
    revealIds,
    reveal,
    actions,
  }
}

