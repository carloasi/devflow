// Tipos do gRPC (fase 1: chamadas unárias) — espelham src-tauri/src/grpc.rs.

export interface GrpcMethodInfo {
  name: string;
  // "pacote.Servico/Metodo"
  fullName: string;
  inputType: string;
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  // Mensagem de entrada com cada campo preenchido com um valor de exemplo.
  inputTemplate: unknown;
}

export interface GrpcServiceInfo {
  name: string;
  methods: GrpcMethodInfo[];
}

export interface GrpcSchema {
  // FileDescriptorSet em base64.
  descriptorSet: string;
  services: GrpcServiceInfo[];
}

export interface GrpcMetadataEntry {
  key: string;
  value: string;
  enabled: boolean;
}

// O que fica salvo numa request gRPC (CollectionItem.grpc / Tab.grpc).
export interface GrpcRequestData {
  // "host:port" — aceita {{variáveis}}.
  target: string;
  useTls: boolean;
  // Com TLS: aceita certificado inválido (autoassinado, expirado, de outro
  // host). A conexão continua cifrada; só a identidade do servidor não é
  // conferida.
  insecureTls?: boolean;
  // "pacote.Servico/Metodo"
  method: string;
  // Tipo do método escolhido (unário ou qual streaming) — gravado junto pra
  // o app saber o que fazer sem precisar ler o schema.
  methodKind?: GrpcMethodKind;
  // Mensagem em JSON — aceita {{variáveis}}.
  message: string;
  metadata: GrpcMetadataEntry[];
  // De onde veio o schema salvo em descriptorSet.
  schemaSource: 'reflection' | 'proto';
  // Schema compilado (base64). Fica na request pra ela funcionar em outra
  // máquina sem os .proto e sem reflection no servidor.
  descriptorSet?: string;
  // Arquivos .proto usados (só referência, pra recarregar nesta máquina).
  protoFiles?: string[];
  timeoutMs?: number;
}

export interface GrpcCallResult {
  statusCode: number;
  statusName: string;
  statusMessage: string;
  // JSON formatado; null quando a chamada falhou.
  response: string | null;
  metadata: [string, string][];
  timeMs: number;
}

export function emptyGrpcRequest(): GrpcRequestData {
  return {
    target: '',
    useTls: false,
    method: '',
    message: '{}',
    metadata: [],
    schemaSource: 'reflection',
  };
}

// ── Streaming (fase 2) ─────────────────────────────────────────────────────

export type GrpcMethodKind = 'unary' | 'server' | 'client' | 'bidi';

export function methodKindOf(method: Pick<GrpcMethodInfo, 'clientStreaming' | 'serverStreaming'>): GrpcMethodKind {
  if (method.clientStreaming && method.serverStreaming) return 'bidi';
  if (method.clientStreaming) return 'client';
  if (method.serverStreaming) return 'server';
  return 'unary';
}

// Evento emitido pelo Rust durante um stream (grpc-stream-event).
export interface GrpcStreamEvent {
  streamId: string;
  kind: 'sent' | 'headers' | 'message' | 'end' | 'error';
  message: string | null;
  statusCode: number | null;
  statusName: string | null;
  statusMessage: string | null;
  metadata: [string, string][];
  elapsedMs: number;
}

// Estado do stream da aba (não é salvo na collection).
export interface GrpcStreamState {
  streamId: string;
  methodKind: GrpcMethodKind;
  active: boolean;
  // "End stream" usado: o cliente não manda mais nada.
  sendingClosed: boolean;
  events: GrpcStreamEvent[];
  // Eventos mais antigos descartados pelo limite da linha do tempo.
  droppedEvents: number;
}
