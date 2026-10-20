import { CollectionItem } from '@/app/types/CollectionItem'
import { sanitizeJsonBodyForSend } from '@/lib/sanitizeJsonBody'
import { getItemUrl } from './tree.utils'

// "Copy URL" / "Copy as cURL" direto da árvore, a partir da request SALVA
// (não da aba aberta — o generateCurl do AppLayout depende da aba ativa).
// Resolve path params (:id) e variáveis {{env}} do environment ativo, igual
// ao que é enviado de verdade; variável sem valor fica como {{nome}}.

function replaceEnv(text: string, env: Record<string, string>): string {
  let result = text
  // Várias passadas: variável cujo valor referencia outra variável.
  for (let i = 0; i < 10; i++) {
    let changed = false
    result = result.replace(/\{\{(.*?)\}\}/g, (match, key: string) => {
      const k = key.trim()
      if (!(k in env)) return match
      changed = true
      return env[k]
    })
    if (!changed) break
  }
  return result
}

export function buildItemUrl(item: CollectionItem, env: Record<string, string>): string {
  const pathVars = item.request?.urlexport?.variable ?? []
  const withPath = getItemUrl(item).replace(/\/:([a-zA-Z0-9_]+)/g, (match, name: string) => {
    const found = pathVars.find((v) => v.key === name && v.enabled !== false)
    return found && found.value ? `/${found.value}` : match
  })
  return replaceEnv(withPath, env)
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

export function buildItemCurl(item: CollectionItem, env: Record<string, string>): string {
  const req = item.request
  const method = item.method || 'GET'
  const parts = [`curl --location ${shellQuote(buildItemUrl(item, env))}`]

  if (method !== 'GET') parts.push(`--request ${method}`)

  for (const h of req?.headers ?? []) {
    if (h.enabled === false || !h.key?.trim()) continue
    parts.push(`--header ${shellQuote(`${h.key}: ${replaceEnv(h.value ?? '', env)}`)}`)
  }

  const auth = req?.auth
  if (auth?.type === 'bearer' && auth.token?.trim()) {
    parts.push(`--header ${shellQuote(`Authorization: Bearer ${replaceEnv(auth.token, env)}`)}`)
  } else if (auth?.type === 'basic' && (auth.username || auth.password)) {
    parts.push(`--user ${shellQuote(`${replaceEnv(auth.username ?? '', env)}:${replaceEnv(auth.password ?? '', env)}`)}`)
  } else if (auth?.type === 'apikey' && auth.key?.trim()) {
    parts.push(`--header ${shellQuote(`${auth.key}: ${replaceEnv(auth.value ?? '', env)}`)}`)
  }

  const bodyType = req?.bodyType ?? (req?.body ? 'raw' : 'none')
  if (bodyType !== 'none' && req?.body?.trim()) {
    parts.push(`--data-raw ${shellQuote(sanitizeJsonBodyForSend(replaceEnv(req.body, env)))}`)
  }

  return parts.join(' \\\n  ')
}
