// Conversor da árvore interna para o formato Postman Collection v2.1 (o
// "Export" do menu da collection). Separado do hook pra ser testável sem o
// Tauri.
import type { CollectionItem, RequestDetails } from '@/app/types/CollectionItem'
import { toPostmanUrl as buildPostmanUrl } from '@/lib/postmanUrl'
import { toPostmanScript } from '@/lib/postmanScriptCompat'

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
    // Todos os campos guardados, como estão. Antes ia uma lista fixa de dez:
    // o que veio do Postman fora dela (grant type de client credentials,
    // client_authentication, addTokenTo...) sumia no export, e o que a
    // request não tinha ia vazio — um grantType "" no lugar do padrão.
    // Desligados ficam de fora, como no app (ver lib/oauth2Token).
    return {
      type: 'oauth2',
      oauth2: (auth.oauth2 ?? [])
        .filter((entry) => entry.enabled !== false && entry.key)
        .map((entry) => ({ key: entry.key, value: entry.value ?? '', type: 'string' })),
    }
  }

  return { type: 'noauth' }
}

/**
 * URL no formato Postman, SEMPRE derivada do texto cru.
 *
 * Antes isto preferia `urlexport.host`/`path`, preenchidos na importação.
 * Mas editar a URL no app atualiza só o `raw` (ver AppLayout), então numa
 * request importada e depois editada as duas versões se contradiziam — e o
 * Postman monta a URL pelas PARTES, ignorando o `raw`. O resultado era um
 * export apontando para outro endpoint, sem erro e sem aviso: 296 das 8.279
 * requests de uma base real.
 *
 * Derivando do `raw`, elas concordam por construção. `variable` continua
 * vindo do `urlexport` porque os path params são guardados à parte e
 * acompanham a edição.
 */
function toPostmanUrl(request: RequestDetails) {
  const raw = request.urlexport?.raw ?? request.url ?? ''
  return buildPostmanUrl(raw, request.urlexport?.variable ?? [])
}

function toPostmanEvents(scripts: RequestDetails['scripts']) {
  if (!scripts) return []  // 👈 scripts é opcional

  const events = []

  if (scripts.preRequest?.trim()) {
    events.push({
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: toPostmanScript(scripts.preRequest).code.split(/\r?\n/),
      },
    })
  }

  if (scripts.postResponse?.trim()) {
    events.push({
      listen: 'test',
      script: {
        type: 'text/javascript',
        exec: toPostmanScript(scripts.postResponse).code.split(/\r?\n/),
      },
    })
  }

  return events
}

function toPostmanHeaders(headers: RequestDetails['headers']) {
  if (!headers?.length) return []

  // Linha em branco (a do fim da tabela de headers) não vai. E header sem
  // `enabled` — de import antigo — está LIGADO: o app o envia (ver
  // lib/defaultHeaders), e `!h.enabled` o exportava desligado.
  return headers
    .filter((h) => h.key?.trim() || h.value?.trim())
    .map((h) => ({
      key:      h.key,
      value:    h.value,
      type:     'text',
      disabled: h.enabled === false,
    }))
}

function toPostmanBody(body: RequestDetails['body'], bodyType: RequestDetails['bodyType'], contentType?: string) {
  // Tipo "none" com texto guardado (o editor guarda o texto ao trocar o
  // tipo): o app não envia esse corpo, então o export também não — no
  // Postman ele iria em toda chamada.
  if (bodyType === 'none' || !body?.trim()) return undefined

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

// `description` só entra quando tem texto: a chave vazia em todo item
// engorda o arquivo e vira ruído no diff de quem importa no Postman.
const withDescription = (item: CollectionItem) =>
  item.description?.trim() ? { description: item.description.trim() } : {}

/** Converte CollectionItem (interno) → item do formato Postman v2.1 */
function toPostmanItem(item: CollectionItem): object {
  if (item.type === 'folder') {
    return {
      name: item.name,
      ...withDescription(item),
      item: (item.item ?? []).filter(isExportable).map(toPostmanItem),
    }
  }

  const req = item.request  // pode ser undefined em requests mal formados
  // Saved Examples ficam guardados como filhos type='example' na árvore
  // interna (ver CollectionItem.ts) — no Postman de verdade eles são um
  // array `response[]` irmão de `request`, não filhos de `item[]`.
  const examples = (item.item ?? []).filter((c) => c.type === 'example')

  if (!req) {
    return { name: item.name, ...withDescription(item), request: buildPostmanRequest(item), response: examples.map(toPostmanExample) }
  }

  return {
    name:    item.name,
    ...withDescription(item),
    event:   toPostmanEvents(req.scripts),
    request: buildPostmanRequest(item),
    response: examples.map(toPostmanExample),
  }
}

/** Monta o JSON raiz no padrão Postman Collection v2.1 */
export function toPostmanCollection(root: CollectionItem) {
  return {
    info: {
      _postman_id: root.id,
      name:        root.name,
      ...withDescription(root),
      schema:      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: (root.item ?? []).filter(isExportable).map(toPostmanItem),
  }
}


/**
 * Nome sugerido do arquivo exportado. O nome da collection vai como está
 * menos o que o Windows recusa em nome de arquivo (/ \ : * ? " < > | e
 * caracteres de controle) — com "Order/Groups" o diálogo de salvar recebia
 * um caminho, não um nome.
 */
export function exportFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().replace(/[. ]+$/, '')
  return `${clean || 'collection'}.json`
}

/**
 * Quantas requests gRPC o export deixa de fora (o formato Postman v2.1 não
 * tem gRPC — ver isExportable). Antes saíam caladas.
 */
export function countSkippedGrpc(root: CollectionItem): number {
  let count = 0
  const walk = (list: CollectionItem[]) => {
    for (const node of list) {
      if (!isExportable(node)) count++
      else if (node.type === 'folder' && node.item) walk(node.item)
    }
  }
  walk(root.item ?? [])
  return count
}
