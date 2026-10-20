'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Monaco } from '@monaco-editor/react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  Lock,
  LockOpen,
  Play,
  X,
  RefreshCw,
  FileCode2,
  Plus,
  Trash2,
  Wand2,
  Copy,
  Send,
  Square,
  ShieldOff,
} from 'lucide-react';
import {
  GrpcMethodInfo,
  GrpcMethodKind,
  GrpcRequestData,
  GrpcSchema,
  GrpcServiceInfo,
  GrpcStreamState,
  methodKindOf,
} from '@/app/types/Grpc';
import { UrlInputWithVariables } from '@/components/Url-components/UrlInputWithVariables';
import { useTheme } from '@/components/ThemeContext';
import { getMonacoThemeName, registerDevflowMonacoThemes } from '@/lib/monacoThemes';
import { buildGrpcurlCommand } from './grpcurl';

// Editor de uma request gRPC — unária ou streaming. Ocupa o lugar da barra de
// URL + RequestEditor quando a aba é gRPC (ver AppLayout).

const KIND_LABEL: Record<GrpcMethodKind, string> = {
  unary: '',
  server: 'server stream',
  client: 'client stream',
  bidi: 'bidi stream',
};

const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[12px] text-pm-text-muted">Loading editor...</div>
  ),
});

interface Props {
  grpc: GrpcRequestData;
  onChange: (next: GrpcRequestData) => void;
  // Unário: chama o método. Streaming: abre o stream (server stream já
  // manda a mensagem do editor e fecha o envio).
  onRun: (kind: GrpcMethodKind) => void;
  // Client/bidi stream aberto: manda a mensagem do editor.
  onSend: () => void;
  // Client/bidi stream: avisa o servidor que o cliente terminou de enviar.
  onEndStream: () => void;
  onCancel: () => void;
  isInvoking: boolean;
  stream: GrpcStreamState | null | undefined;
  // Resolve {{variáveis}} com o environment ativo.
  resolve: (text: string) => string;
}

type SubTab = 'message' | 'metadata' | 'settings';

export function GrpcRequestPanel({
  grpc,
  onChange,
  onRun,
  onSend,
  onEndStream,
  onCancel,
  isInvoking,
  stream,
  resolve,
}: Props) {
  const { effectiveThemeId } = useTheme();
  const [subTab, setSubTab] = useState<SubTab>('message');
  // Serviços do schema, guardados junto do schema de onde vieram: trocar ou
  // apagar o schema invalida a lista sem precisar zerar estado num efeito.
  const [described, setDescribed] = useState<{ descriptorSet: string; services: GrpcServiceInfo[] } | null>(null);
  const services = useMemo(
    () => (grpc.descriptorSet && described?.descriptorSet === grpc.descriptorSet ? described.services : []),
    [described, grpc.descriptorSet]
  );
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [loadingSchema, setLoadingSchema] = useState<null | 'reflection' | 'proto'>(null);

  const set = (patch: Partial<GrpcRequestData>) => onChange({ ...grpc, ...patch });

  // Schema salvo na request → lista de serviços/métodos. Recalcula só quando
  // o schema muda (abrir a aba, carregar de novo).
  useEffect(() => {
    let cancelled = false;
    const descriptorSet = grpc.descriptorSet;
    if (!descriptorSet) return;
    invoke<GrpcSchema>('grpc_describe', { descriptorSet })
      .then(schema => {
        if (cancelled) return;
        setDescribed({ descriptorSet, services: schema.services });
        setSchemaError(null);
      })
      .catch(e => {
        if (cancelled) return;
        setDescribed({ descriptorSet, services: [] });
        setSchemaError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [grpc.descriptorSet]);

  const selectedMethod: GrpcMethodInfo | undefined = useMemo(() => {
    for (const service of services) {
      const found = service.methods.find(m => m.fullName === grpc.method);
      if (found) return found;
    }
    return undefined;
  }, [services, grpc.method]);

  const templateText = (method: GrpcMethodInfo) => JSON.stringify(method.inputTemplate ?? {}, null, 2);

  // Novo schema: mantém o método se ele ainda existe; senão escolhe o
  // primeiro método unário. Mensagem vazia ganha o modelo do método.
  const applySchema = (schema: GrpcSchema, patch: Partial<GrpcRequestData>) => {
    const all = schema.services.flatMap(s => s.methods);
    const keep = all.find(m => m.fullName === grpc.method);
    const method = keep ?? all[0];
    const messageIsEmpty = !grpc.message.trim() || grpc.message.trim() === '{}';
    onChange({
      ...grpc,
      ...patch,
      descriptorSet: schema.descriptorSet,
      method: method?.fullName ?? '',
      methodKind: method ? methodKindOf(method) : undefined,
      message: method && (messageIsEmpty || !keep) ? templateText(method) : grpc.message,
    });
    setSchemaError(null);
    const count = schema.services.reduce((n, s) => n + s.methods.length, 0);
    toast.success(`Schema loaded — ${schema.services.length} service(s), ${count} method(s).`);
  };

  const loadFromServer = async () => {
    setLoadingSchema('reflection');
    try {
      const schema = await invoke<GrpcSchema>('grpc_reflect', {
        target: resolve(grpc.target),
        useTls: grpc.useTls,
        insecureTls: !!grpc.insecureTls,
        metadata: grpc.metadata
          .filter(m => m.enabled && m.key.trim())
          .map(m => ({ key: m.key, value: resolve(m.value) })),
      });
      applySchema(schema, { schemaSource: 'reflection', protoFiles: undefined });
    } catch (e) {
      setSchemaError(String(e));
    } finally {
      setLoadingSchema(null);
    }
  };

  const importProtos = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      multiple: true,
      title: 'Select the .proto files',
      filters: [{ name: 'Protocol Buffers', extensions: ['proto'] }],
    });
    const files = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (files.length === 0) return;

    setLoadingSchema('proto');
    try {
      const schema = await invoke<GrpcSchema>('grpc_compile_protos', { files, includeDirs: [] });
      applySchema(schema, { schemaSource: 'proto', protoFiles: files });
    } catch (e) {
      setSchemaError(String(e));
    } finally {
      setLoadingSchema(null);
    }
  };

  const chooseMethod = (fullName: string) => {
    let method: GrpcMethodInfo | undefined;
    for (const service of services) {
      method = service.methods.find(m => m.fullName === fullName) ?? method;
    }
    const messageIsEmpty = !grpc.message.trim() || grpc.message.trim() === '{}';
    // Trocar de método troca o modelo só se a mensagem atual ainda era o
    // modelo do método anterior (ou vazia) — edição do usuário é preservada.
    const wasTemplate = selectedMethod && grpc.message.trim() === templateText(selectedMethod).trim();
    set({
      method: fullName,
      methodKind: method ? methodKindOf(method) : undefined,
      ...(method && (messageIsEmpty || wasTemplate) ? { message: templateText(method) } : {}),
    });
  };

  const copyGrpcurl = async () => {
    try {
      await navigator.clipboard.writeText(buildGrpcurlCommand(grpc, resolve));
      toast.success('grpcurl command copied');
    } catch {
      toast.error("Couldn't copy the command");
    }
  };

  const kind: GrpcMethodKind = selectedMethod ? methodKindOf(selectedMethod) : grpc.methodKind ?? 'unary';
  const canRun = !!grpc.target.trim() && !!grpc.descriptorSet && !!grpc.method;
  const streamOpen = !!stream?.active;
  // Client/bidi: enquanto o stream está aberto e o envio não foi fechado,
  // o editor manda uma mensagem por vez.
  const canSend = streamOpen && !stream?.sendingClosed && (kind === 'client' || kind === 'bidi');
  const runLabel = kind === 'unary' ? 'Invoke' : kind === 'server' ? 'Start' : 'Start stream';

  const schemaLabel = grpc.descriptorSet
    ? grpc.schemaSource === 'proto'
      ? `From ${grpc.protoFiles?.length ?? 0} .proto file(s)`
      : 'From server reflection'
    : 'No schema loaded';

  return (
    <div className="flex h-full min-h-0 flex-col bg-pm-bg">
      {/* Endereço + TLS + Invoke */}
      <div className="px-3 py-2.5">
        <div className="flex h-9 gap-2">
          <div className="flex flex-1 items-center rounded-lg border border-pm-border bg-pm-bg transition-colors focus-within:border-blue-500/50">
            <span className="ml-3 mr-2 shrink-0 rounded bg-teal-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold text-teal-300">
              gRPC
            </span>
            <div className="mr-2 h-8 w-px shrink-0 bg-pm-hover" />
            <UrlInputWithVariables
              value={grpc.target}
              onChange={target => set({ target })}
              placeholder="host:port — e.g. localhost:50051 or {{grpcHost}}"
            />
            <button
              type="button"
              onClick={() => set({ useTls: !grpc.useTls })}
              title={grpc.useTls ? 'TLS on — click for plaintext' : 'Plaintext — click to use TLS'}
              className={`mr-2 flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors ${
                grpc.useTls ? 'bg-emerald-500/10 text-emerald-400' : 'text-pm-text-muted hover:bg-pm-hover hover:text-pm-text'
              }`}
            >
              {grpc.useTls ? <Lock size={12} /> : <LockOpen size={12} />}
              {grpc.useTls ? 'TLS' : 'Plaintext'}
            </button>
            {grpc.useTls && (
              <button
                type="button"
                onClick={() => set({ insecureTls: !grpc.insecureTls })}
                title={
                  grpc.insecureTls
                    ? 'Accepting any certificate (self-signed, expired, other host). Click to verify it again.'
                    : 'Accept an invalid certificate (self-signed, expired, other host). The connection stays encrypted.'
                }
                className={`mr-2 flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors ${
                  grpc.insecureTls
                    ? 'bg-amber-500/15 text-amber-400'
                    : 'text-pm-text-muted hover:bg-pm-hover hover:text-pm-text'
                }`}
              >
                <ShieldOff size={12} />
                {grpc.insecureTls ? 'Cert not verified' : 'Verify cert'}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={isInvoking ? onCancel : () => onRun(kind)}
            disabled={!isInvoking && !canRun}
            title={
              isInvoking
                ? kind === 'unary' ? 'Cancel' : 'Cancel the stream'
                : !grpc.descriptorSet
                  ? 'Load the schema first (server reflection or .proto files)'
                  : kind === 'unary'
                    ? 'Invoke (Ctrl+Enter)'
                    : kind === 'server'
                      ? 'Send the message and receive the stream (Ctrl+Enter)'
                      : 'Open the stream, then send messages one by one (Ctrl+Enter)'
            }
            className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-5 text-[12px] font-semibold text-white transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
              isInvoking ? 'bg-red-500 hover:bg-red-500' : 'bg-pm-accent hover:brightness-110 active:brightness-90'
            }`}
          >
            {isInvoking ? <X size={12} strokeWidth={2.5} /> : <Play size={12} strokeWidth={2.5} />}
            {isInvoking ? 'Cancel' : runLabel}
          </button>
        </div>

        {/* Schema + método */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={grpc.method}
            onChange={e => chooseMethod(e.target.value)}
            disabled={services.length === 0 || streamOpen}
            title={streamOpen ? 'Cancel or finish the stream to change the method' : 'Method'}
            className="h-8 min-w-[260px] max-w-full flex-1 cursor-pointer rounded-lg border border-pm-border bg-pm-surface px-2 font-mono text-[12px] text-pm-text outline-none focus:border-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {services.length === 0 && <option value="">Load the schema to pick a method</option>}
            {grpc.method && !selectedMethod && services.length > 0 && (
              <option value={grpc.method}>{grpc.method} (not in schema)</option>
            )}
            {services.map(service => (
              <optgroup key={service.name} label={service.name}>
                {service.methods.map(method => {
                  const label = KIND_LABEL[methodKindOf(method)];
                  return (
                    <option key={method.fullName} value={method.fullName}>
                      {method.name}
                      {label ? ` — ${label}` : ''}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>

          <button
            type="button"
            onClick={loadFromServer}
            disabled={!!loadingSchema || !grpc.target.trim()}
            title="Ask the server for its services (gRPC reflection)"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-pm-border bg-pm-hover/60 px-2.5 text-[11px] font-medium text-pm-text transition-colors hover:bg-pm-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RefreshCw size={12} className={loadingSchema === 'reflection' ? 'animate-spin' : ''} />
            Load from server
          </button>
          <button
            type="button"
            onClick={importProtos}
            disabled={!!loadingSchema}
            title="Compile .proto files on this computer"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-pm-border bg-pm-hover/60 px-2.5 text-[11px] font-medium text-pm-text transition-colors hover:bg-pm-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <FileCode2 size={12} className={loadingSchema === 'proto' ? 'animate-pulse' : ''} />
            Import .proto
          </button>
        </div>

        <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-pm-text-muted">
          <span title={grpc.protoFiles?.join('\n')}>{schemaLabel}</span>
          {selectedMethod && (
            <span className="truncate font-mono">
              {selectedMethod.clientStreaming ? 'stream ' : ''}
              {selectedMethod.inputType} → {selectedMethod.serverStreaming ? 'stream ' : ''}
              {selectedMethod.outputType}
            </span>
          )}
        </div>
        {schemaError && (
          <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-[11px] text-red-300">
            {schemaError}
          </div>
        )}
      </div>

      {/* Sub-abas */}
      <div className="flex shrink-0 items-center justify-between px-4">
        <div className="flex h-9 items-center gap-1">
          {(['message', 'metadata', 'settings'] as const).map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setSubTab(tab)}
              className={`h-6 cursor-pointer rounded-sm px-1.5 text-[12px] font-medium capitalize transition-colors ${
                subTab === tab ? 'bg-pm-hover text-pm-text' : 'text-pm-text-muted hover:text-pm-text-secondary'
              }`}
            >
              {tab}
              {tab === 'metadata' && grpc.metadata.filter(m => m.enabled && m.key.trim()).length > 0 && (
                <span className="ml-1 text-pm-text-muted">{grpc.metadata.filter(m => m.enabled && m.key.trim()).length}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {canSend && (
            <>
              <button
                type="button"
                onClick={onSend}
                title="Send the message in the editor on the open stream (Ctrl+Enter)"
                className="flex h-6 cursor-pointer items-center gap-1 rounded-md bg-pm-accent px-2.5 text-[11px] font-semibold text-white transition-all hover:brightness-110"
              >
                <Send size={11} />
                Send
              </button>
              <button
                type="button"
                onClick={onEndStream}
                title="Tell the server you are done sending — its remaining answers still arrive"
                className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-pm-border bg-pm-hover/60 px-2 text-[11px] font-medium text-pm-text transition-colors hover:bg-pm-hover"
              >
                <Square size={10} />
                End stream
              </button>
              <div className="mx-1 h-4 w-px bg-pm-hover" />
            </>
          )}
          {subTab === 'message' && selectedMethod && (
            <button
              type="button"
              onClick={() => set({ message: templateText(selectedMethod) })}
              title="Replace the message with an example of every field"
              className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text"
            >
              <Wand2 size={12} />
              Template
            </button>
          )}
          <button
            type="button"
            onClick={copyGrpcurl}
            disabled={!grpc.method}
            title="Copy as a grpcurl command"
            className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text disabled:opacity-40"
          >
            <Copy size={12} />
            grpcurl
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-2 pb-2">
        {subTab === 'message' && (
          <Editor
            height="100%"
            language="json"
            theme={getMonacoThemeName(effectiveThemeId)}
            beforeMount={(monaco: Monaco) => registerDevflowMonacoThemes(monaco)}
            value={grpc.message}
            onChange={value => set({ message: value ?? '' })}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              padding: { top: 10 },
              wordWrap: 'on',
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        )}

        {subTab === 'metadata' && (
          <div className="h-full overflow-y-auto px-2">
            <p className="mb-2 text-[11px] text-pm-text-muted">
              Sent as gRPC metadata (HTTP/2 headers). Values accept {'{{variables}}'}; keys ending in{' '}
              <code className="font-mono">-bin</code> take base64.
            </p>
            <div className="grid grid-cols-[28px_minmax(0,2fr)_minmax(0,3fr)_32px] border-l border-r border-t border-pm-border text-[12px]">
              {grpc.metadata.map((entry, i) => (
                <div key={i} className="contents">
                  <div className="flex items-center justify-center border-b border-r border-pm-border">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onChange={e =>
                        set({ metadata: grpc.metadata.map((m, j) => (j === i ? { ...m, enabled: e.target.checked } : m)) })
                      }
                      className="h-3.5 w-3.5 cursor-pointer accent-pm-accent"
                    />
                  </div>
                  <input
                    value={entry.key}
                    onChange={e => set({ metadata: grpc.metadata.map((m, j) => (j === i ? { ...m, key: e.target.value } : m)) })}
                    placeholder="key"
                    className="h-8 border-b border-r border-pm-border bg-pm-hover/40 px-2 font-mono text-pm-text outline-none placeholder:text-pm-text-muted focus:bg-pm-accent/[0.06]"
                  />
                  <input
                    value={entry.value}
                    onChange={e => set({ metadata: grpc.metadata.map((m, j) => (j === i ? { ...m, value: e.target.value } : m)) })}
                    placeholder="value"
                    className="h-8 border-b border-r border-pm-border bg-transparent px-2 font-mono text-pm-text outline-none placeholder:text-pm-text-muted focus:bg-pm-accent/[0.06]"
                  />
                  <button
                    type="button"
                    onClick={() => set({ metadata: grpc.metadata.filter((_, j) => j !== i) })}
                    title="Remove"
                    className="flex cursor-pointer items-center justify-center border-b border-pm-border text-pm-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => set({ metadata: [...grpc.metadata, { key: '', value: '', enabled: true }] })}
              className="mt-2 flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-pm-text-muted transition-colors hover:bg-pm-hover hover:text-pm-text"
            >
              <Plus size={12} />
              Add metadata
            </button>
          </div>
        )}

        {subTab === 'settings' && (
          <div className="flex flex-col gap-3 px-2 py-1 text-[12px]">
            <label className="flex items-center gap-3">
              <span className="w-28 text-pm-text-muted">Deadline (ms)</span>
              <input
                value={grpc.timeoutMs ?? ''}
                onChange={e => {
                  const digits = e.target.value.replace(/\D/g, '');
                  set({ timeoutMs: digits ? Number(digits) : undefined });
                }}
                inputMode="numeric"
                placeholder="30000"
                className="h-8 w-32 rounded-md border border-pm-border bg-pm-hover/40 px-2 font-mono text-pm-text outline-none focus:border-blue-500/40"
              />
              <span className="text-[11px] text-pm-text-muted">Empty = 30 s</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
