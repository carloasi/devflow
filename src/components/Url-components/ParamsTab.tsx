'use client'

import { Trash2 } from 'lucide-react'
import { QueryParam } from '@/app/types/QueryParam'
import { TabsContent } from '../ui/tabs'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { UrlInputWithVariables } from './UrlInputWithVariables'


interface Props {
  url: string
  queryParams: QueryParam[]
  pathParams: QueryParam[]

  onUrlChange: (url: string) => void

  onChangeQueryParams: (
    params: QueryParam[]
  ) => void

  onChangePathParams: (
    params: QueryParam[]
  ) => void
}

// Antes usávamos um id fixo (__empty_row__) pra linha vazia — mas assim que
// o usuário digitava o 1º caractere, essa linha "virava" uma linha real com
// um id NOVO (crypto.randomUUID()), e uma nova linha vazia era anexada no
// fim MANTENDO o id fixo antigo. Como o React reconcilia por key, ele
// "movia" o node DOM focado (key __empty_row__) pra essa nova linha vazia
// no fim da lista — e criava um node novo pra linha recém-promovida. Na
// prática: o cursor "pulava de linha" e o campo voltava a ficar vazio a
// cada tecla digitada.
//
// Fix: o id da linha placeholder agora é dinâmico (guardado numa ref). Ao
// promover a linha pro array real, ela LEVA o id que tinha como
// placeholder — e só DEPOIS geramos um id novo pra a PRÓXIMA linha vazia.
// Assim a identidade (key) da linha que o usuário está editando nunca muda
// no meio da digitação; só a linha vazia nova (nunca focada ainda) nasce
// com key diferente.

// decodeURIComponent lança URIError em "% malformado" (ex: um "%" solto que
// não é parte de um escape válido, comum quando a query string tem
// {{variavel}}, JSON colado, ou qualquer texto digitado à mão que não foi
// encodado certinho). Sem esse fallback, digitar isso na URL quebrava a tela
// inteira. Se não der pra decodificar, usa o texto cru mesmo.
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// Casa o texto atual da URL com a tabela de Query Params já existente, SEM
// derrubar linhas desabilitadas (que nunca aparecem no texto da URL de
// propósito — ver comentário grande no useEffect "URL -> QUERY PARAMS").
// Retorna a lista mesclada, ou `null` se nada mudou (evita loop/render à
// toa).
//   - Linha desabilitada -> mantida do jeito que está, sempre.
// - Linha habilitada cuja key sumiu do texto da URL -> removida (usuário
//   apagou esse trecho direto na barra de URL).
// - Linha habilitada cuja key continua no texto mas o valor mudou ->
//   atualiza o valor (usuário editou direto na barra de URL).
// - Pares da URL que sobraram sem linha correspondente -> viram linhas
//   novas, habilitadas (usuário digitou um "&novaChave=valor" direto na
//   barra de URL).
function mergeParamsFromUrl(url: string, currentParams: QueryParam[]): QueryParam[] | null {
  const queryString = url.split('?')[1] ?? ''

  const remaining = queryString
    .split('&')
    .filter(Boolean)
    .map((item) => {
      const [rawKey = '', rawValue = ''] = item.split('=')
      return {
        key: safeDecodeURIComponent(rawKey),
        value: safeDecodeURIComponent(rawValue),
      }
    })

  const takeMatch = (key: string) => {
    const idx = remaining.findIndex((p) => p.key === key)
    if (idx === -1) return undefined
    return remaining.splice(idx, 1)[0]
  }

  let changed = false
  const merged: QueryParam[] = []

  for (const param of currentParams) {
    if (!param.enabled) {
      merged.push(param)
      continue
    }

    const match = takeMatch(param.key)

    if (!match) {
      changed = true
      continue
    }

    if (match.value !== param.value) {
      changed = true
      merged.push({ ...param, value: match.value })
    } else {
      merged.push(param)
    }
  }

  for (const leftover of remaining) {
    changed = true
    merged.push({
      id: crypto.randomUUID(),
      key: leftover.key,
      value: leftover.value,
      enabled: true,
    })
  }

  return changed ? merged : null
}

// Reconstrói a URL a partir dos query params — usada só quando o usuário
// edita uma LINHA da tabela de Params (não reage a toda mudança de
// queryParams via useEffect — ver comentário grande no bloco "QUERY PARAMS
// -> URL" removido, isso é o que causava o conflito com a digitação direta
// na barra de URL).
function buildUrlFromParams(url: string, params: QueryParam[]): string {
  const baseUrl = url.split('?')[0]

  const encode = (value: string) => {
    const hasVariable = value.includes('{{') && value.includes('}}')
    return hasVariable ? value : encodeURIComponent(value)
  }

  const query = params
    .filter((param) => param.enabled && param.key.trim() !== '')
    .map((param) => `${encode(param.key)}=${encode(param.value)}`)
    .join('&')

  return query ? `${baseUrl}?${query}` : baseUrl
}

//muda o valor dos parametros
export function ParamsTab({
  url,
  queryParams,
  pathParams,
  onUrlChange,
  onChangeQueryParams,
  onChangePathParams,
}: Props) {
  const syncingRef = useRef(false)
  const placeholderIdRef = useRef<string>(crypto.randomUUID())

  const [keyWidth, setKeyWidth] =
    useState(220)

  const [valueWidth, setValueWidth] =
    useState(260)

  /*
   * ============================================================
   * AUTOCURA DE IDS AUSENTES/DUPLICADOS
   * ============================================================
   * Requests importadas de collections do Postman trazem os path
   * variables sem "id" (só {key, value}). Como o update de cada linha
   * casa por id, várias linhas com id undefined faziam TODAS mudarem
   * juntas ao editar uma só. Aqui a gente detecta isso (id ausente ou
   * repetido) e reatribui ids únicos automaticamente, tanto pra tabs
   * novas quanto pra tabs antigas já salvas com o bug.
   */

  function withUniqueIds(list: QueryParam[]): QueryParam[] | null {
    const seen = new Set<string>()
    let needsFix = false

    const fixed = list.map((item) => {
      const hasValidId = !!item.id && !seen.has(item.id)
      if (!hasValidId) needsFix = true
      const id = hasValidId ? item.id : crypto.randomUUID()
      seen.add(id)
      return { ...item, id }
    })

    return needsFix ? fixed : null
  }

  /*
   * ============================================================
   * AUTOCURA DE CHAVES SUJAS/DUPLICADAS (só path params)
   * ============================================================
   * Algumas collections importadas do Postman trazem a chave do path
   * variable com um ":" grudado (ex: "journeyKey:" em vez de
   * "journeyKey") — normalmente um typo de quem criou a request
   * originalmente. Como ":journeyKey:" e ":journeyKey" viram strings
   * diferentes, isso resultava em DUAS linhas pro mesmo path variable.
   * Aqui a gente limpa ":" do início/fim da chave e junta duplicatas
   * (mantendo o primeiro valor não vazio encontrado).
   */
  function withCleanPathKeys(list: QueryParam[]): QueryParam[] | null {
    let needsFix = false
    const order: string[] = []
    const byKey = new Map<string, QueryParam>()

    for (const item of list) {
      const cleanKey = item.key.replace(/^:+|:+$/g, '').trim()
      if (cleanKey !== item.key) needsFix = true

      const existing = byKey.get(cleanKey)
      if (!existing) {
        order.push(cleanKey)
        byKey.set(cleanKey, { ...item, key: cleanKey })
        continue
      }

      needsFix = true
      if (!existing.value && item.value) {
        byKey.set(cleanKey, { ...existing, value: item.value })
      }
    }

    return needsFix ? order.map((k) => byKey.get(k)!) : null
  }

  useEffect(() => {
    const cleaned = withCleanPathKeys(pathParams || [])
    const fixed = withUniqueIds(cleaned ?? (pathParams || []))
    const result = fixed ?? cleaned
    if (result) onChangePathParams(result)
  }, [pathParams])

  useEffect(() => {
    const fixed = withUniqueIds(queryParams || [])
    if (fixed) onChangeQueryParams(fixed)
  }, [queryParams])

  /*
   * ============================================================
   * POSTMAN BEHAVIOR
   * ============================================================
   */

  const displayQueryParams = useMemo(() => {
    const params = [...(queryParams || [])]

    const last =
      params[params.length - 1]

    const needsEmptyRow =
      !last ||
      last.key !== '' ||
      last.value !== ''

    if (needsEmptyRow) {
      params.push({
        id: placeholderIdRef.current,
        key: '',
        value: '',
        enabled: false,
      })
    }

    return params
  }, [queryParams])

  /*
   * ============================================================
   * URL -> QUERY PARAMS
   * ============================================================
   * IMPORTANTE: isso não pode ser um "replace" ingênuo (jogar fora
   * queryParams e reconstruir do zero a partir do texto da URL). Uma linha
   * DESABILITADA nunca aparece no texto da URL de propósito (é assim que o
   * Postman evita mandar esse param) — se a gente reconstruísse do zero toda
   * vez que a URL mudasse (inclusive quando ELA MESMA mudou só porque
   * desabilitamos uma linha, via buildUrlFromParams), a linha desabilitada
   * sumiria da tabela pra sempre, em vez de só ficar cinza/inutilizável.
   *
   * Por isso aqui é um MERGE: linhas desabilitadas são sempre preservadas
   * como estão; só linhas HABILITADAS são casadas com o texto da URL (pra
   * suportar editar/apagar um param digitando direto na barra de URL); e
   * pares novos que sobrarem no texto da URL viram linhas novas habilitadas.
   */

  useEffect(() => {
    if (syncingRef.current) return

    const merged = mergeParamsFromUrl(url, queryParams)
    if (!merged) return

    syncingRef.current = true

    onChangeQueryParams(merged)

    queueMicrotask(() => {
      syncingRef.current = false
    })
  }, [url])

  /*
   * ============================================================
   * QUERY PARAMS -> URL
   * ============================================================
   * Antes isso era um useEffect reagindo a TODA mudança de queryParams —
   * inclusive quando queryParams mudava só porque a URL_BAR (fora do
   * ParamsTab) já tinha acabado de reescrever ela via handleUrlChange
   * (AppLayout.tsx), que já sincroniza url -> queryParams sozinho.
   * Resultado: a cada tecla digitada na barra de URL, esse efeito recalculava
   * a URL "canônica" a partir dos params recém-sincronizados e, se o
   * resultado reconstruído diferisse do texto ainda sendo digitado (ex:
   * "?a" sem "=" vira "?a=" na reconstrução), sobrescrevia o campo NO MEIO
   * da digitação — dava a impressão de não conseguir digitar querystring.
   *
   * Agora a reconstrução só acontece como consequência DIRETA de editar uma
   * linha da tabela de Params (handleQueryParamChange / removeQueryParam
   * chamam buildUrlFromParams explicitamente) — nunca mais como reação
   * automática a qualquer mudança de queryParams.
   */

  /*
   * ============================================================
   * PATH PARAMS
   * ============================================================
   */


  useEffect(() => {
  if (syncingRef.current) return

  const cleanUrl =
    url.split('?')[0]

  /*
   * PASSO 1: separar a origin (protocolo://host:porta)
   * do resto do path, pra porta nunca entrar na busca.
   *
   * Exemplo:
   *   http://localhost:6001/api/v1/order/journeys/:journeyKey
   *   origin -> "http://localhost:6001"
   *   path   -> "/api/v1/order/journeys/:journeyKey"
   */
  const originMatch = cleanUrl.match(
    /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/[^/]+/
  )

  const pathOnly = originMatch
    ? cleanUrl.slice(originMatch[0].length)
    : cleanUrl

  /*
   * PASSO 2: agora sim, buscar path params.
   * Exige a barra ANTES do ":" pra garantir
   * que só pega segmentos de path, tipo /:id
   */
  const matches =
    pathOnly.match(
      /\/:([a-zA-Z0-9_]+)/g
    ) || []

  /*
   * REMOVE "/:" (barra + dois pontos)
   */
  const extractedKeys =
    matches.map((m) =>
      m.replace(/^\/:/, '').trim()
    )

  /*
   * Reconstrói a lista de path params A PARTIR do que está na URL agora:
   * mantém id/value de quem continua (casando por key), cria os novos que
   * apareceram, e — o que faltava aqui — DEIXA DE FORA quem sumiu do
   * texto (ex: usuário apagou ":journeyKey" da URL), removendo a linha
   * correspondente da tabela de Path Variables.
   */
  const updated = extractedKeys.map((key) => {
    const existing = pathParams.find(
      (p) => p.key.trim() === key
    )

    return existing ?? {
      id: crypto.randomUUID(),
      key,
      value: '',
      enabled: true,
    }
  })

  const currentSerialized = JSON.stringify(
    (pathParams || []).map((p) => ({
      key: p.key,
      value: p.value,
    }))
  )

  const updatedSerialized = JSON.stringify(
    updated.map((p) => ({
      key: p.key,
      value: p.value,
    }))
  )

  if (currentSerialized !== updatedSerialized) {
    syncingRef.current = true

    onChangePathParams(updated)

    queueMicrotask(() => {
      syncingRef.current = false
    })
  }
}, [url])

  // useEffect(() => {
  //   if (syncingRef.current) return

  //   const cleanUrl =
  //     url.split('?')[0]

  //   /*
  //    * MATCH:
  //    * /:id
  //    * /:teste
  //    */
  //   const matches =
  //     cleanUrl.match(
  //       /:[a-zA-Z0-9_]+/g
  //     ) || []

  //   /*
  //    * REMOVE :
  //    */
  //   const extractedKeys =
  //     matches.map((m) =>
  //       m.replace(':', '').trim()
  //     )

  //   /*
  //    * MANTÉM O VALUE ORIGINAL
  //    */
  //   const updated = extractedKeys.map(
  //     (key) => {
  //       const existing =
  //         pathParams.find(
  //           (p) =>
  //             p.key.trim() === key
  //         )

  //       return {
  //         id:
  //           existing?.id ||
  //           crypto.randomUUID(),

  //         key,

  //         value:
  //           existing?.value || '',

  //         enabled: true,
  //       }
  //     }
  //   )

  //   const currentSerialized =
  //     JSON.stringify(
  //       pathParams.map((p) => ({
  //         key: p.key,
  //         value: p.value,
  //       }))
  //     )

  //   const updatedSerialized =
  //     JSON.stringify(
  //       updated.map((p) => ({
  //         key: p.key,
  //         value: p.value,
  //       }))
  //     )

  //   if (
  //     currentSerialized !==
  //     updatedSerialized
  //   ) {
  //     syncingRef.current = true

  //     onChangePathParams(updated)

  //     queueMicrotask(() => {
  //       syncingRef.current = false
  //     })
  //   }
  // }, [url])

  /*
   * ============================================================
   * UPDATE QUERY PARAM
   * ============================================================
   */

  const handleQueryParamChange = (
    id: string,
    field: keyof QueryParam,
    value: any
  ) => {
    if (id === placeholderIdRef.current) {
      const newParam: QueryParam = {
        // Mantém o MESMO id que a linha tinha como placeholder — se
        // trocássemos aqui, o React perderia a identidade do input focado
        // (ver comentário grande no topo do arquivo) e o cursor "pularia"
        // pra linha vazia nova.
        id: placeholderIdRef.current,

        key:
          field === 'key'
            ? value
            : '',

        value:
          field === 'value'
            ? value
            : '',

        enabled: true,
      }

      // A PRÓXIMA linha vazia (ainda não existe, nunca foi focada) recebe
      // um id novo — só ela, não a que acabou de ser promovida acima.
      placeholderIdRef.current = crypto.randomUUID()

      const nextParams = [...queryParams, newParam]
      onChangeQueryParams(nextParams)
      onUrlChange(buildUrlFromParams(url, nextParams))

      return
    }

    const updated = queryParams.map(
      (param) => {
        if (param.id !== id)
          return param

        return {
          ...param,
          [field]: value,
        }
      }
    )

    onChangeQueryParams(updated)
    onUrlChange(buildUrlFromParams(url, updated))
  }

  /*
   * ============================================================
   * REMOVE QUERY PARAM
   * ============================================================
   */

  const removeQueryParam = (
    id: string
  ) => {
    const updated = queryParams.filter(
      (param) => param.id !== id
    )
    onChangeQueryParams(updated)
    onUrlChange(buildUrlFromParams(url, updated))
  }

  /*
   * ============================================================
   * UPDATE PATH PARAM
   * ============================================================
   */

  const updatePathParam = (
    id: string,
    value: string
  ) => {
    const updated = pathParams.map(
      (p) => {
        if (p.id !== id) return p

        return {
          ...p,
          value,
        }
      }
    )

    onChangePathParams(updated)
  }

  /*
   * ============================================================
   * RESIZE
   * ============================================================
   */

  const startResize = (
    e: React.MouseEvent,
    column: 'key' | 'value'
  ) => {
    e.preventDefault()

    const startX = e.clientX

    const initialWidth =
      column === 'key'
        ? keyWidth
        : valueWidth

    const onMouseMove = (
      moveEvent: MouseEvent
    ) => {
      const delta =
        moveEvent.clientX - startX

      const nextWidth = Math.max(
        80,
        initialWidth + delta
      )

      if (column === 'key') {
        setKeyWidth(nextWidth)
      } else {
        setValueWidth(nextWidth)
      }
    }

    const onMouseUp = () => {
      document.removeEventListener(
        'mousemove',
        onMouseMove
      )

      document.removeEventListener(
        'mouseup',
        onMouseUp
      )
    }

    document.addEventListener(
      'mousemove',
      onMouseMove
    )

    document.addEventListener(
      'mouseup',
      onMouseUp
    )
  }

  /*
   * ============================================================
   * RENDER TABLE
   * ============================================================
   */

  const renderTable = (
    title: string,
    params: QueryParam[],
    isPathParam: boolean
  ) => {
    if (
      isPathParam &&
      params.length === 0
    ) {
      return null
    }

    const gridStyle = {
      gridTemplateColumns: `40px ${keyWidth}px ${valueWidth}px 40px`,
    }

    return (
      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[12px] font-bold tracking-tight text-pm-text-muted">
            {title}
          </span>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-full w-max border-l border-r border-pm-border">
            {/* HEADER */}

            <div
              className="grid items-stretch border-t border-b border-pm-border"
              style={gridStyle}
            >
              <div className="h-full self-stretch border-r border-pm-border" />

              <div className="relative flex h-full items-center border-r border-pm-border bg-pm-hover/40 px-2 py-1 text-[11px] font-medium text-pm-text-muted">
                Key

                <div
                  onMouseDown={(e) =>
                    startResize(
                      e,
                      'key'
                    )
                  }
                  className="absolute -right-[2px] top-0 bottom-0 z-20 w-[1px] cursor-col-resize hover:bg-pm-border"
                />
              </div>

              <div className="relative flex h-full items-center border-r border-pm-border px-2 py-1 text-[11px] font-medium text-pm-text-muted">
                Value

                <div
                  onMouseDown={(e) =>
                    startResize(
                      e,
                      'value'
                    )
                  }
                  className="absolute -right-[2px] top-0 bottom-0 z-20 w-[1px] cursor-col-resize hover:bg-pm-border"
                />
              </div>

              <div />
            </div>

            {/* ROWS */}

            {params.map((param, index) => {
              const isPlaceholder =
                param.id ===
                placeholderIdRef.current

              // Desmarcar o checkbox só desabilita a linha (não manda o
              // param na request) — igual o Postman, ela continua na tabela,
              // só fica esmaecida/inutilizável.
              const isDisabledRow =
                !isPathParam &&
                !param.enabled &&
                !isPlaceholder

              return (
                <div
                  key={param.id || `${param.key}-${index}`}
                  className={`group grid items-stretch border-b border-pm-border transition-colors ${
                    isDisabledRow ? 'opacity-45' : ''
                  }`}
                  style={gridStyle}
                >
                  {/* CHECKBOX */}

                  <div className="flex h-full items-center justify-center border-r border-pm-border">
                    {!isPathParam ? (
                      <input
                        type="checkbox"
                        checked={
                          param.enabled
                        }
                        disabled={
                          isPlaceholder
                        }
                        onChange={(e) =>
                          handleQueryParamChange(
                            param.id,
                            'enabled',
                            e.target.checked
                          )
                        }
                        className="rounded accent-pm-text-muted disabled:opacity-30 opacity-0 group-hover:opacity-100 checked:opacity-100"
                      />
                    ) : (
                      <div className="h-1.5 w-1.5 rounded-full bg-pm-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                  </div>

                  {/* KEY */}

                  <div className="flex h-full items-center overflow-hidden border-r border-pm-border bg-pm-hover/40">
                    <input
                      value={param.key}
                      disabled={
                        isPathParam
                      }
                      placeholder="key"
                      onChange={(e) =>
                        handleQueryParamChange(
                          param.id,
                          'key',
                          e.target.value
                        )
                      }
                      className="h-full w-full truncate bg-transparent px-2 py-1 text-[12px] text-pm-text outline-none placeholder-pm-text-muted disabled:text-pm-text-secondary"
                    />
                  </div>

                  {/* VALUE */}

                  <div className="flex h-full items-center overflow-hidden border-r border-pm-border pl-2">

                    {isPathParam ? (
                      // Mesmo input com destaque/autocomplete de {{variavel}}
                      // usado nos Query Params.
                      <UrlInputWithVariables
                        value={param.value}
                        onChange={(value) =>
                          updatePathParam(
                            param.id,
                            value
                          )
                        }
                        params={pathParams}
                        onPathParamsChange={onChangePathParams}
                        placeholder="value"
                        className="h-full w-full border-0 bg-transparent"
                      />
                    ) : (
                    <UrlInputWithVariables
                      value={param.value}
                      onChange={(value) => {
                        handleQueryParamChange(
                          param.id,
                          'value',
                          value
                        )
                      }}

                      /*
                      * PATH PARAMS
                      */
                      params={pathParams}

                      /*
                      * UPDATE PATH PARAMS
                      */
                      onPathParamsChange={onChangePathParams}

                      placeholder="value"
                      className="h-full w-full border-0 bg-transparent"
                    />
                    )}
                  </div>

                  {/* ACTION */}

                  <div className="flex h-full items-center justify-center">
                    {!isPathParam ? (
                      <button
                        disabled={
                          isPlaceholder
                        }
                        onClick={() =>
                          removeQueryParam(
                            param.id
                          )
                        }
                        className="p-2 text-pm-text-muted cursor-pointer transition-colors hover:text-red-400 opacity-0 group-hover:opacity-100 disabled:opacity-0"
                      >
                        <Trash2
                          size={13}
                        />
                      </button>
                    ) : (
                      <span className="font-mono text-[9px] tracking-tight text-pm-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
                        PATH
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  /*
   * ============================================================
   * RENDER
   * ============================================================
   */

  return (
    <TabsContent
      value="params"
      className="m-0 h-full p-0 outline-none"
    >
      <div className="h-full overflow-y-auto p-4">
        {renderTable(
          'Query Params',
          displayQueryParams,
          false
        )}

        {renderTable(
          'Path Variables',
          pathParams,
          true
        )}
      </div>
    </TabsContent>
  )
}