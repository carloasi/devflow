export interface AuthorizationDetails {
  type: | 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2'
  token?: string
  username?: string
  password?: string
  key?: string
  value?: string
  oauth2?:Array<{ key: string; value: string; enabled: boolean }>;
}

// O Postman usa 'noauth' pra "sem autenticação"; internamente o app sempre
// usou 'none'. Sem essa normalização, uma collection importada do Postman
// guardava o type literal 'noauth' (fora do union acima), quebrando o
// seletor de Auth na UI. Usar em TODO ponto que lê `type` vindo de um JSON
// externo (import de collection, cURL, etc).
export function normalizeAuthType(type: unknown): AuthorizationDetails['type'] {
  const t = String(type ?? 'none')
  return t === 'noauth' ? 'none' : (t as AuthorizationDetails['type'])
}