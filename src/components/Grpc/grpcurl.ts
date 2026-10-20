import { GrpcRequestData } from '@/app/types/Grpc';

// Comando grpcurl equivalente à request — o "snippet" do gRPC. Variáveis já
// resolvidas, igual o snippet de cURL.

function quote(text: string): string {
  // Aspas simples do shell: fecha, escapa e reabre.
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function buildGrpcurlCommand(grpc: GrpcRequestData, resolve: (text: string) => string): string {
  const parts: string[] = ['grpcurl'];

  const target = resolve(grpc.target).trim().replace(/^https?:\/\//, '');
  if (!grpc.useTls && !/^https:\/\//.test(grpc.target.trim())) parts.push('-plaintext');
  else if (grpc.insecureTls) parts.push('-insecure');

  for (const entry of grpc.metadata) {
    if (!entry.enabled || !entry.key.trim()) continue;
    parts.push('-H', quote(`${entry.key.trim()}: ${resolve(entry.value)}`));
  }

  // Schema por .proto: aponta os arquivos (o grpcurl precisa deles se o
  // servidor não tiver reflection).
  if (grpc.schemaSource === 'proto' && grpc.protoFiles?.length) {
    const dirs = new Set<string>();
    for (const file of grpc.protoFiles) {
      const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
      dirs.add(slash >= 0 ? file.slice(0, slash) : '.');
    }
    for (const dir of dirs) parts.push('-import-path', quote(dir));
    for (const file of grpc.protoFiles) {
      const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
      parts.push('-proto', quote(slash >= 0 ? file.slice(slash + 1) : file));
    }
  }

  if (grpc.timeoutMs) parts.push('-max-time', String(Math.ceil(grpc.timeoutMs / 1000)));

  const message = resolve(grpc.message).trim();
  if (message && message !== '{}') {
    // Compacta o JSON quando dá, pra caber numa linha só.
    let compact = message;
    try {
      compact = JSON.stringify(JSON.parse(message));
    } catch {
      // JSON inválido: manda como está, o grpcurl mostra o erro.
    }
    parts.push('-d', quote(compact));
  }

  parts.push(target || '<host:port>', grpc.method || '<package.Service/Method>');
  return parts.join(' ');
}
