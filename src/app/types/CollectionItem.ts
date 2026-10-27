import { QueryParam } from "./QueryParam";
import { AuthorizationDetails } from "./AuthorizationDetails";
import { GrpcRequestData } from "./Grpc";

export interface RequestDetails {
  url: string;
  urlexport: UrlItem;
  headers: Array<{ key: string; value: string; enabled: boolean }>;
  // Headers automáticos que esta request desligou (ver lib/defaultHeaders.ts).
  disabledDefaultHeaders?: string[];
  body?: string;
  // Mesmo tipo usado pela Tab (editor aberto) — antes esse campo declarava só
  // {type, token, oauth2}, então Basic Auth (username/password) e API Key
  // (key/value) eram aceitos em runtime (JS não erasure campo extra) mas
  // invisíveis pro TypeScript, forçando "as any" em vários lugares e
  // escondendo o bug de handleRequestSelect que truncava esses campos ao
  // reabrir uma request salva.
  auth?: AuthorizationDetails;
  // Preservado entre sessões pra reabrir uma request GraphQL corretamente
  // (sem isso, toda request reaberta cai em bodyType 'raw').
  bodyType?: 'none' | 'raw' | 'graphql';
  scripts?: {
    preRequest: string;
    postResponse: string;
  };
}

// Uma "resposta salva" (Saved Example) do Postman — presa a uma request,
// guarda um snapshot fixo de status/headers/body que NÃO muda quando a
// request de verdade é reenviada (diferente do histórico de respostas, que é
// rotativo e efêmero). No formato Postman v2.1 isso vive em `item.response[]`
// (irmão de `item.request`, não filho de `item[]`); aqui representamos como
// um CollectionItem filho de type 'example' pra reaproveitar toda a árvore
// (expand/collapse, rename, duplicate, delete, drag) de graça — a conversão
// pra/da estrutura real do Postman acontece só no import/export.
export interface ExampleData {
  status: string;   // ex: "OK", "Not Found"
  code: number;      // ex: 200, 404
  headers: Array<{ key: string; value: string; enabled?: boolean }>;
  body: string;
  previewLanguage?: string; // _postman_previewlanguage do Postman: 'json' | 'html' | 'xml' | 'text'
}

export interface CollectionItem {
  id: string;
  name: string;
  type: 'folder' | 'request' | 'example';
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; // Apenas para requests
  request?: RequestDetails;                      // Requests E examples (snapshot da request original)
  item?: CollectionItem[];
  variable?: Array<{ key: string; value: string; enabled?: boolean }>; // ← novo
  example?: ExampleData;                          // Apenas para examples
  // Requests gRPC: protocol 'grpc' + os dados em `grpc` (o `request` HTTP
  // fica sem uso). Sem protocol = HTTP, como todas as requests antigas.
  protocol?: 'http' | 'grpc';
  grpc?: GrpcRequestData;
  // Favoritar um item (pasta, request ou example) o move pro topo da lista de irmãos (a ordem real
  // muda — ver toggleStarNode) e acende a estrela na árvore. É marca de uso
  // pessoal: nunca sobe pro GitHub, e o pull recoloca as marcas locais.
  starred?: boolean;
  // Id do irmão que vinha logo ANTES desta pasta quando ela foi favoritada —
  // `null` se ela já era a primeira. É o que permite devolvê-la ao lugar de
  // origem ao desfavoritar. Guardado por posição relativa, e não por índice,
  // porque os irmãos podem ter sido criados, apagados ou reordenados nesse
  // meio tempo. Local como o `starred`: não sobe pro GitHub.
  starredAfterId?: string | null;
  // Ids dos marcadores aplicados a este nó (ver lib/markers.ts). Ao
  // contrário do `starred`, que é marca de uso pessoal, o marcador é do
  // TIME: sobe no push e chega pra todo mundo no pull. Só os ids ficam aqui
  // — nome e cor vivem no catálogo do workspace, pra que renomear um
  // marcador não exija reescrever a árvore inteira.
  markers?: string[];
  // Nota de UM marcador NESTE nó, indexada pelo id do marcador.
  //
  // É diferente da `description` abaixo, que fala do item em si: aqui o
  // texto explica por que ESTA marca está AQUI — "flaky desde que mudou o
  // gateway", "smoke só com cartão de teste". A mesma marca em dois itens
  // tem motivos diferentes, e um campo só no catálogo não daria conta.
  markerNotes?: Record<string, string>;
  // Texto livre sobre o item — o que a request faz, de que ela depende, por
  // que existe. Aparece no tooltip da linha e vai junto no export (é o
  // `description` do formato Postman).
  //
  // Nasce no nó, e não dentro de `request`, porque pasta também tem: metade
  // do valor está em explicar a PASTA ("este fluxo precisa de reserva em
  // Hold"), e pasta não tem `request`.
  description?: string;
}

export interface UrlItem {
  raw: string;
  host: Array<string>;
  path: Array<string>;
  variable?: Array<QueryParam>;
}