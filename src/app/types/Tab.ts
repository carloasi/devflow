import { AuthorizationDetails } from "./AuthorizationDetails";
import { ExampleData } from "./CollectionItem";
import { GrpcCallResult, GrpcRequestData, GrpcStreamState } from "./Grpc";
import { ApiResponse } from "./DataResponse";
import { QueryParam } from "./QueryParam";
import { TestResult } from "./TestResult";

export type RequestSubTab = 'params' | 'authorization' | 'headers' | 'body' | 'scripts';

export interface Tab {
  id: string;
  // Grupo desta aba na barra (ver lib/tabGroups). Não confundir com os
  // "session groups", que guardam um CONJUNTO de abas para reabrir depois —
  // aqui as abas continuam abertas, o grupo só organiza a barra.
  groupId?: string;
  name: string;
  method: string;
  urlInput: string;
  requestBodyValue: string;
  bodyType: 'none' | 'raw' | 'graphql';
  // Array (não Record) de propósito — um Record<string,string> não consegue
  // representar um header DESABILITADO (só chave/valor), então desmarcar a
  // flag de um header acabava apagando ele de vez do request salvo (ele só
  // "sobrevivia" visualmente enquanto o HeadersManager não desmontava). Ver
  // HeadersManager.tsx.
  requestHeadersValue: QueryParam[];
  // Headers automáticos (User-Agent, Accept...) que esta request desligou —
  // ver lib/defaultHeaders.ts.
  disabledDefaultHeaders?: string[];
  response: ApiResponse | null;
  responseTime?: number; // <--- Adicionado para guardar o tempo em ms
  testResults?: TestResult[]; // <--- Resultados de pm.test(...) do último post-response script
  auth: AuthorizationDetails; // <--- Adicione o estado de auth na aba ativa
  queryParams: QueryParam[]
  params: QueryParam[]
  scripts?: {
  preRequest: string;
    postResponse: string;
    preRequestError?: boolean;
    postResponseError?: boolean;
    preRequestLog?: string;
    postResponseLog?: string;
  };
  activeRequestTab?: RequestSubTab;
  isDirty?: boolean;
  // 'example' = aba aberta a partir de um Saved Example (Add Example / Save
  // as Example) — igual o Postman, abre direto no espaço de abas normal em
  // vez de um painel lateral, reaproveitando o mesmo RequestEditor +
  // response viewer. undefined/'request' = aba de request normal.
  kind?: 'request' | 'example';
  // Abas de example: a resposta salva sendo editada (status, headers, body).
  // É isso que o Save grava no example — o envio nunca mexe nela.
  exampleDraft?: ExampleData;
  // Aba aberta pelo "Try" de um example: id do example de origem, pra
  // oferecer "Update example" com a resposta recebida.
  tryOfExampleId?: string;
  // Abas gRPC (ver CollectionItem.protocol): a request e o último resultado.
  protocol?: 'http' | 'grpc';
  grpc?: GrpcRequestData;
  grpcResult?: GrpcCallResult | null;
  grpcStream?: GrpcStreamState | null;
}