'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { McpContext, executeMcpTool } from '@/mcp/mcpTools';

// ─────────────────────────────────────────────────────────────────────────
// Host de extensões (fase 1).
//
// Cada extensão roda dentro de um <iframe sandbox="allow-scripts"> com o
// HTML entregue via srcdoc — sem acesso ao DOM do app, ao localStorage, nem
// à mesma origem. A única via de comunicação é postMessage, e do lado de cá
// toda mensagem passa por três checagens: veio de um iframe registrado, de
// qual extensão, e se ela declarou a permissão daquele método.
//
// A execução em si reaproveita o mesmo dispatcher das ferramentas MCP — a
// API que o Claude usa e a que a extensão usa são a mesma, definida uma vez.
// ─────────────────────────────────────────────────────────────────────────

import { BUILTIN_EXTENSIONS } from './builtin/dateDiffExtension';

const DEV_PATHS_KEY = 'devflow_extension_dev_paths';
const DISABLED_KEY = 'devflow_extension_disabled';
const STORAGE_PREFIX = 'devflow_ext_storage:';

export interface ExtensionRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  contributes: {
    statusBarItems?: { id: string }[];
    // Aceleradores globais ("Ctrl+Shift+D"). O host captura em qualquer
    // lugar do app e repassa pro iframe — de dentro do sandbox a extensão
    // só veria teclas digitadas nela mesma.
    shortcuts?: string[];
  } | null;
  permissions: string[];
  path: string;
  source: 'installed' | 'dev' | 'builtin' | string;
  html: string;
  error: string | null;
}

// Método exposto → ferramenta que executa + permissão exigida.
const TOOL_METHODS: Record<string, { tool: string; permission: string }> = {
  'requests.list': { tool: 'list_requests', permission: 'requests:read' },
  'requests.get': { tool: 'get_request', permission: 'requests:read' },
  'requests.run': { tool: 'run_request', permission: 'requests:run' },
  'response.get': { tool: 'get_response', permission: 'response:read' },
  'environments.list': { tool: 'list_environments', permission: 'environments:read' },
};

export interface ExtensionFrameSize {
  width: number;
  height: number;
  expanded: boolean;
  // Largura que o widget ocupa na barra de status. Expandido, o iframe vira
  // um overlay e `width` cresce pro tamanho do painel — sem guardar a
  // largura colapsada, a barra de status abriria um buraco do tamanho do
  // painel toda vez que a extensão expandisse.
  collapsedWidth: number;
}

export interface UseExtensionHostResult {
  extensions: ExtensionRecord[];
  disabledIds: string[];
  devPaths: string[];
  loading: boolean;
  frameSizes: Record<string, ExtensionFrameSize>;
  reload: () => Promise<void>;
  toggleEnabled: (id: string) => void;
  addDevPath: (path: string) => Promise<void>;
  removeDevPath: (path: string) => Promise<void>;
  registerFrame: (id: string, frame: Window | null) => void;
}

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, values: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch (e) {
    console.error('Erro ao salvar configuração de extensões:', e);
  }
}

export function useExtensionHost(getContext: () => McpContext, onToast?: (message: string) => void): UseExtensionHostResult {
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([]);
  const [disabledIds, setDisabledIds] = useState<string[]>([]);
  const [devPaths, setDevPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [frameSizes, setFrameSizes] = useState<Record<string, ExtensionFrameSize>>({});

  // Janela de cada iframe montado → id da extensão. É o que permite saber
  // QUEM está mandando cada mensagem: o payload não é confiável pra isso,
  // porque a própria extensão poderia mentir o id.
  const frameOwners = useRef(new Map<Window, string>());
  const extensionsRef = useRef<ExtensionRecord[]>([]);
  extensionsRef.current = extensions;
  const getContextRef = useRef(getContext);
  getContextRef.current = getContext;
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const disabledRef = useRef<string[]>([]);
  disabledRef.current = disabledIds;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const paths = readList(DEV_PATHS_KEY);
      const found = await invoke<ExtensionRecord[]>('list_extensions', { devPaths: paths });
      // Built-ins primeiro: elas vêm do binário, não do disco, então
      // continuam funcionando mesmo se a pasta de extensões não existir (ou
      // se o comando do backend falhar — ver o catch abaixo).
      setExtensions([...BUILTIN_EXTENSIONS, ...found]);
      setDevPaths(paths);
    } catch (e) {
      console.error('Erro ao carregar extensões:', e);
      setExtensions([...BUILTIN_EXTENSIONS]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setDisabledIds(readList(DISABLED_KEY));
    reload();
  }, [reload]);

  const registerFrame = useCallback((id: string, frame: Window | null) => {
    if (!frame) return;
    frameOwners.current.set(frame, id);
  }, []);

  // ── Bridge ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      const source = event.source as Window | null;
      if (!source) return;

      const extensionId = frameOwners.current.get(source);
      if (!extensionId) return; // mensagem de qualquer outra origem: ignora

      const data = event.data;
      if (!data || typeof data !== 'object' || data.channel !== 'devflow') return;

      const { id: callId, method, params } = data as {
        id: number;
        method: string;
        params?: any;
      };

      const reply = (payload: any) =>
        source.postMessage({ channel: 'devflow', id: callId, ...payload }, '*');

      const extension = extensionsRef.current.find(e => e.id === extensionId);
      const permissions = extension?.permissions ?? [];

      try {
        // ── Métodos nativos do host ──────────────────────────────────────
        if (method.startsWith('ui.')) {
          if (method === 'ui.toast') {
            onToastRef.current?.(String(params?.message ?? ''));
          } else if (method === 'ui.resize' || method === 'ui.expand') {
            const width = Math.max(24, Math.min(900, Number(params?.width) || 120));
            const height = Math.max(18, Math.min(700, Number(params?.height) || 22));
            const expanded = method === 'ui.expand';
            setFrameSizes(prev => {
              const current = prev[extensionId];
              return {
                ...prev,
                [extensionId]: {
                  width,
                  height,
                  expanded,
                  // Expandir não redefine o espaço ocupado na barra: só um
                  // resize normal (widget colapsado) atualiza isso.
                  collapsedWidth: expanded ? current?.collapsedWidth ?? width : width,
                },
              };
            });
          } else if (method === 'ui.collapse') {
            setFrameSizes(prev => {
              const current = prev[extensionId];
              return {
                ...prev,
                [extensionId]: {
                  width: current?.collapsedWidth ?? current?.width ?? 120,
                  height: 22,
                  expanded: false,
                  collapsedWidth: current?.collapsedWidth ?? current?.width ?? 120,
                },
              };
            });
          }
          reply({ ok: true, result: null });
          return;
        }

        if (method.startsWith('storage.')) {
          if (!permissions.includes('storage')) {
            reply({ ok: false, error: 'Missing permission: storage' });
            return;
          }
          // Prefixo por extensão: uma não enxerga o storage da outra, e
          // desinstalar é apagar as chaves desse prefixo.
          const key = `${STORAGE_PREFIX}${extensionId}:${String(params?.key ?? '')}`;
          if (method === 'storage.get') {
            reply({ ok: true, result: localStorage.getItem(key) });
          } else if (method === 'storage.set') {
            localStorage.setItem(key, String(params?.value ?? ''));
            reply({ ok: true, result: null });
          } else if (method === 'storage.remove') {
            localStorage.removeItem(key);
            reply({ ok: true, result: null });
          } else {
            reply({ ok: false, error: `Unknown method: ${method}` });
          }
          return;
        }

        // ── Métodos que caem nas ferramentas do app ──────────────────────
        const mapped = TOOL_METHODS[method];
        if (!mapped) {
          reply({ ok: false, error: `Unknown method: ${method}` });
          return;
        }
        if (!permissions.includes(mapped.permission)) {
          reply({ ok: false, error: `Missing permission: ${mapped.permission}` });
          return;
        }

        const result = await executeMcpTool(mapped.tool, params ?? {}, getContextRef.current());
        reply({ ok: true, result });
      } catch (e: any) {
        reply({ ok: false, error: e?.message ?? String(e) });
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Atalhos globais ─────────────────────────────────────────────────────
  // Uma extensão em iframe sandbox só recebe teclas digitadas dentro dela.
  // Pra ter atalho de app inteiro (ex: Ctrl+Shift+D da calculadora de
  // datas), ela declara o acelerador em `contributes.shortcuts` e o host
  // repassa. Só aceleradores DECLARADOS dão preventDefault — nenhuma
  // extensão consegue engolir teclas que não pediu.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey && !event.altKey) return;

      const parts: string[] = [];
      if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
      if (event.shiftKey) parts.push('Shift');
      if (event.altKey) parts.push('Alt');
      parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
      const accelerator = parts.join('+').toLowerCase();

      for (const extension of extensionsRef.current) {
        if (extension.error) continue;
        if (disabledRef.current.includes(extension.id)) continue;

        const declared = extension.contributes?.shortcuts ?? [];
        if (!declared.some(a => a.toLowerCase() === accelerator)) continue;

        let target: Window | null = null;
        frameOwners.current.forEach((id, frame) => {
          if (id === extension.id) target = frame;
        });
        if (!target) continue;

        event.preventDefault();
        (target as Window).postMessage(
          { channel: 'devflow', event: 'shortcut', accelerator: parts.join('+') },
          '*'
        );
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const toggleEnabled = useCallback((id: string) => {
    setDisabledIds(prev => {
      const next = prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id];
      writeList(DISABLED_KEY, next);
      return next;
    });
  }, []);

  const addDevPath = useCallback(async (path: string) => {
    const paths = readList(DEV_PATHS_KEY);
    if (!paths.includes(path)) writeList(DEV_PATHS_KEY, [...paths, path]);
    await reload();
  }, [reload]);

  const removeDevPath = useCallback(async (path: string) => {
    writeList(DEV_PATHS_KEY, readList(DEV_PATHS_KEY).filter(p => p !== path));
    await reload();
  }, [reload]);

  return {
    extensions,
    disabledIds,
    devPaths,
    loading,
    frameSizes,
    reload,
    toggleEnabled,
    addDevPath,
    removeDevPath,
    registerFrame,
  };
}

// Script injetado no topo de toda extensão: embrulha o postMessage numa API
// de promises, pra extensão não precisar lidar com correlação de mensagem.
export const EXTENSION_API_SCRIPT = `
<script>
(function () {
  let nextId = 1;
  const pending = new Map();
  const shortcutHandlers = [];

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (!data || data.channel !== 'devflow') return;

    if (data.event === 'shortcut') {
      shortcutHandlers.forEach(function (handler) {
        try { handler(data.accelerator); } catch (e) { console.error(e); }
      });
      return;
    }

    if (!pending.has(data.id)) return;
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.ok) resolve(data.result);
    else reject(new Error(data.error || 'DevFlow call failed'));
  });

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      const id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ channel: 'devflow', id: id, method: method, params: params }, '*');
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('DevFlow call timed out: ' + method));
        }
      }, 60000);
    });
  }

  window.devflow = {
    call: call,
    requests: {
      list: function (p) { return call('requests.list', p || {}); },
      get: function (p) { return call('requests.get', p); },
      run: function (p) { return call('requests.run', p); }
    },
    response: { get: function (p) { return call('response.get', p || {}); } },
    environments: { list: function () { return call('environments.list', {}); } },
    storage: {
      get: function (key) { return call('storage.get', { key: key }); },
      set: function (key, value) { return call('storage.set', { key: key, value: value }); },
      remove: function (key) { return call('storage.remove', { key: key }); }
    },
    ui: {
      resize: function (s) { return call('ui.resize', s); },
      expand: function (s) { return call('ui.expand', s); },
      collapse: function () { return call('ui.collapse', {}); },
      toast: function (message) { return call('ui.toast', { message: message }); },
      // Aceleradores declarados no manifesto ("contributes.shortcuts"): o
      // host captura no app inteiro e entrega aqui.
      onShortcut: function (handler) { shortcutHandlers.push(handler); }
    }
  };
})();
</script>
`;
