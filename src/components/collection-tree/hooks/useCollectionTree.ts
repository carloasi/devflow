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
  removeNode,
  renameNode,
  toggleStarNode,
} from '../utils/tree.utils'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { ParsedCurlRequest } from '@/lib/curlParser'

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

// ─── Conversor para formato Postman Collection v2.1 ───────────────────────────

function toPostmanAuth(auth: RequestDetails['auth']) {
  if (!auth || auth.type === 'none') {
    return { type: 'noauth' }
  }

  if (auth.type === 'bearer') {
    return {
      type: 'bearer',
      bearer: [{ key: 'token', value: auth.token ?? '', type: 'string' }],
    }
  }

  // Antes caía direto em "noauth" — Basic Auth e API Key eram descartados
  // silenciosamente no export, perdendo usuário/senha ou chave/valor.
  if (auth.type === 'basic') {
    return {
      type: 'basic',
      basic: [
        { key: 'username', value: auth.username ?? '', type: 'string' },
        { key: 'password', value: auth.password ?? '', type: 'string' },
      ],
    }
  }

  if (auth.type === 'apikey') {
    return {
      type: 'apikey',
      apikey: [
        { key: 'key',   value: auth.key   ?? '', type: 'string' },
        { key: 'value', value: auth.value ?? '', type: 'string' },
        { key: 'in',    value: 'header',         type: 'string' },
      ],
    }
  }

  if (auth.type === 'oauth2') {
    const getValue = (key: string) =>
      auth.oauth2?.find((item) => item.key === key)?.value ?? ''

    return {
      type: 'oauth2',
      oauth2: [
        { key: 'accessToken',   value: getValue('accessToken'),   type: 'string' },
        { key: 'headerPrefix',  value: getValue('headerPrefix'),  type: 'string' },
        { key: 'tokenName',     value: getValue('tokenName'),     type: 'string' },
        { key: 'grantType',     value: getValue('grantType'),     type: 'string' },
        { key: 'callbackUrl',   value: getValue('callbackUrl'),   type: 'string' },
        { key: 'authUrl',       value: getValue('authUrl'),       type: 'string' },
        { key: 'accessTokenUrl',value: getValue('accessTokenUrl'),type: 'string' },
        { key: 'clientId',      value: getValue('clientId'),      type: 'string' },
        { key: 'clientSecret',  value: getValue('clientSecret'),  type: 'string' },
        { key: 'scope',         value: getValue('scope'),         type: 'string' },
      ],
    }
  }

  return { type: 'noauth' }
}

// Divide a URL raw em host[]/path[] igual o Postman faz, só usada quando
// urlexport.host/path não foram preenchidos (caso comum pra requests criadas
// ou editadas dentro do próprio app, que só mantêm `raw` atualizado).
function splitHostPath(raw: string): { host: string[]; path: string[] } {
  const withoutProtocol = raw.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//, '')
  const [hostAndPort, ...rest] = withoutProtocol.split('/')
  const pathAndQuery = rest.join('/')
  const pathOnly = pathAndQuery.split('?')[0].split('#')[0]

  const host = hostAndPort ? hostAndPort.split('.') : []
  const path = pathOnly ? pathOnly.split('/').filter(Boolean) : []
  return { host, path }
}

// Extrai `?key=value&...` da URL raw pro array `query` do Postman — sem
// isso, abrir o export no Postman real mostra a aba Params vazia mesmo com
// query string presente na URL.
function extractQuery(raw: string): Array<{ key: string; value: string }> {
  const queryString = raw.split('?')[1]?.split('#')[0]
  if (!queryString) return []
  const safeDecode = (v: string) => {
    try { return decodeURIComponent(v) } catch { return v }
  }
  return queryString.split('&').filter(Boolean).map((pair) => {
    const [key = '', value = ''] = pair.split('=')
    return { key: safeDecode(key), value: safeDecode(value) }
  })
}

function toPostmanUrl(request: RequestDetails) {
  const raw = request.urlexport?.raw ?? request.url ?? ''
  const hasHostPath = !!(request.urlexport?.host?.length || request.urlexport?.path?.length)
  const derived = hasHostPath ? null : splitHostPath(raw)

  return {
    raw,
    host:     hasHostPath ? request.urlexport!.host : derived!.host,
    path:     hasHostPath ? request.urlexport!.path : derived!.path,
    query:    extractQuery(raw),
    variable: request.urlexport?.variable ?? [],
  }
}

function toPostmanEvents(scripts: RequestDetails['scripts']) {
  if (!scripts) return []  // 👈 scripts é opcional

  const events = []

  if (scripts.preRequest?.trim()) {
    events.push({
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: scripts.preRequest.split('\n'),
      },
    })
  }

  if (scripts.postResponse?.trim()) {
    events.push({
      listen: 'test',
      script: {
        type: 'text/javascript',
        exec: scripts.postResponse.split('\n'),
      },
    })
  }

  return events
}

function toPostmanHeaders(headers: RequestDetails['headers']) {
  if (!headers?.length) return []

  return headers.map((h) => ({
    key:      h.key,
    value:    h.value,
    type:     'text',
    disabled: !h.enabled,  // 👈 seu tipo usa 'enabled', Postman usa 'disabled'
  }))
}

function toPostmanBody(body: RequestDetails['body'], bodyType: RequestDetails['bodyType'], contentType?: string) {
  if (!body?.trim()) return undefined  // 👈 body é opcional

  // Corpo GraphQL é guardado internamente como JSON.stringify({query, variables})
  // — desmonta de volta pro formato { mode: 'graphql', graphql: {...} } que o
  // Postman espera, em vez de exportar como texto raw ilegível.
  if (bodyType === 'graphql') {
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed.query === 'string') {
        const variables = typeof parsed.variables === 'string' ? parsed.variables : JSON.stringify(parsed.variables ?? {})
        return {
          mode: 'graphql',
          graphql: { query: parsed.query, variables },
        }
      }
    } catch {
      // não era o JSON esperado — cai no fallback raw abaixo
    }
  }

  if (contentType?.includes('application/json') || isJsonString(body)) {
    return {
      mode: 'raw',
      raw: body,
      options: { raw: { language: 'json' } },
    }
  }

  return {
    mode: 'raw',
    raw: body,
  }
}

function isJsonString(str: string): boolean {
  try {
    const trimmed = str.trim()
    return (trimmed.startsWith('{') || trimmed.startsWith('['))
  } catch {
    return false
  }
}

function parseFormData(body: string) {
  try {
    const parsed = JSON.parse(body)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return []
}

/** Monta só o bloco `request: {...}` do formato Postman — reaproveitado
 * tanto pela request "de verdade" quanto pelo `originalRequest` de cada
 * example salvo dela (ambos guardam o snapshot no mesmo campo `request`). */
function buildPostmanRequest(item: CollectionItem) {
  const req = item.request
  if (!req) return { method: item.method ?? 'GET', header: [], url: { raw: '' } }

  const contentTypeHeader = req.headers?.find(
    (h) => h.key.toLowerCase() === 'content-type'
  )

  return {
    method: item.method ?? 'GET',
    header: toPostmanHeaders(req.headers),
    url:    toPostmanUrl(req),
    auth:   req.auth ? toPostmanAuth(req.auth) : undefined,
    body:   toPostmanBody(req.body, req.bodyType, contentTypeHeader?.value),
  }
}

/** Converte um CollectionItem type='example' → um item do array
 * `item.response[]` do Postman v2.1 (Saved Examples). */
function toPostmanExample(ex: CollectionItem): object {
  const data = ex.example
  return {
    id:      ex.id,
    name:    ex.name,
    originalRequest: buildPostmanRequest(ex),
    status:  data?.status ?? 'OK',
    code:    data?.code ?? 200,
    _postman_previewlanguage: data?.previewLanguage ?? 'json',
    header: (data?.headers ?? [])
      .filter((h) => h.enabled !== false)
      .map((h) => ({ key: h.key, value: h.value })),
    cookie: [],
    body: data?.body ?? '',
  }
}

// O formato Postman v2.1 não tem request gRPC (o Postman guarda gRPC à
// parte) — essas ficam fora do export em vez de virar uma HTTP quebrada.
function isExportable(item: CollectionItem): boolean {
  return item.protocol !== 'grpc'
}

/** Converte CollectionItem (interno) → item do formato Postman v2.1 */
function toPostmanItem(item: CollectionItem): object {
  if (item.type === 'folder') {
    return {
      name: item.name,
      item: (item.item ?? []).filter(isExportable).map(toPostmanItem),
    }
  }

  const req = item.request  // pode ser undefined em requests mal formados
  // Saved Examples ficam guardados como filhos type='example' na árvore
  // interna (ver CollectionItem.ts) — no Postman de verdade eles são um
  // array `response[]` irmão de `request`, não filhos de `item[]`.
  const examples = (item.item ?? []).filter((c) => c.type === 'example')

  if (!req) {
    return { name: item.name, request: buildPostmanRequest(item), response: examples.map(toPostmanExample) }
  }

  return {
    name:    item.name,
    event:   toPostmanEvents(req.scripts),
    request: buildPostmanRequest(item),
    response: examples.map(toPostmanExample),
  }
}

/** Monta o JSON raiz no padrão Postman Collection v2.1 */
function toPostmanCollection(root: CollectionItem) {
  return {
    info: {
      _postman_id: root.id,
      name:        root.name,
      schema:      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: (root.item ?? []).filter(isExportable).map(toPostmanItem),
  }
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

  const createRequest = useCallback((parentId: string) => {
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
  }, [items, onUpdateItems])

  // Request gRPC vazia — o schema vem depois (reflection ou .proto), na aba.
  const createGrpcRequest = useCallback((parentId: string) => {
    const node: CollectionItem = {
      id:       crypto.randomUUID(),
      name:     'New gRPC Request',
      type:     'request',
      protocol: 'grpc',
      grpc:     emptyGrpcRequest(),
    }
    onUpdateItems(addNode(items, parentId, node))
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

  const createFolder = useCallback((parentId: string) => {
    const node: CollectionItem = {
      id:   crypto.randomUUID(),
      name: 'New Folder',
      type: 'folder',
      item: [],
    }
    onUpdateItems(addNode(items, parentId, node))
  }, [items, onUpdateItems])

  const createRequestFromCurl = useCallback((
  parentId: string,
  parsed: ParsedCurlRequest
) => {
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
}, [items, onUpdateItems])


  const exportCollection = useCallback(async (item: CollectionItem) => {
    // Converte para o padrão Postman v2.1
    const postmanJson = toPostmanCollection(item)
    const json = JSON.stringify(postmanJson, null, 2)

    const filePath = await save({
      defaultPath: `${item.name}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })

    if (!filePath) return

    await writeTextFile(filePath, json)
  }, [])

    const rename = (id: string, newName: string) => {
    onUpdateItems(renameNode(items, id, newName))
    onRename?.(id, newName) // avisa quem estiver ouvindo (ex: as tabs abertas)
  }

  // const rename = useCallback((id: string, name: string) => {
  //   onUpdateItems(renameNode(items, id, name))
  // }, [items, onUpdateItems])

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

  const filteredItems = useMemo(() => {
    if (!search) return items
    return filterTree(items, search)
  }, [items, search])


  return {
    search,
    setSearch,
    filteredItems,
    actions: {
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
    },
  }
}

