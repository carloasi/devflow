import { AuthorizationDetails } from '@/app/types/AuthorizationDetails';

// ─────────────────────────────────────────────────────────────────────────
// Headers que o DevFlow manda automaticamente em toda request — o mesmo
// papel dos "hidden headers" do Postman. Fonte única pro envio normal
// (AppLayout), snippet, Collection Runner e MCP. O Load Test (Rust) tem uma
// cópia em load_test.rs com as mesmas regras.
//
// Regras:
//   • um header da request com o mesmo nome substitui o padrão, sem
//     diferenciar maiúsculas/minúsculas (antes "Content-Type" do usuário e
//     "Content-type" padrão iam os dois);
//   • a request pode desligar cada padrão (disabledDefaultHeaders);
//   • Content-type só vai quando a request tem body.
// ─────────────────────────────────────────────────────────────────────────

export interface DefaultHeader {
  key: string;
  value: string;
  // Só faz sentido quando há body (ex: Content-type num GET sem body).
  onlyWithBody?: boolean;
}

export const DEFAULT_HEADERS: DefaultHeader[] = [
  { key: 'User-Agent', value: 'DevFlowRuntime/1.0.0' },
  { key: 'Accept', value: '*/*' },
  { key: 'Connection', value: 'keep-alive' },
  { key: 'Cache-Control', value: 'no-cache' },
  { key: 'Content-type', value: 'application/json', onlyWithBody: true },
];

export type DefaultHeaderStatus = 'sent' | 'disabled' | 'overridden' | 'no-body';

export interface DefaultHeaderState extends DefaultHeader {
  status: DefaultHeaderStatus;
  // Nome do header da request que substitui este (quando 'overridden').
  overriddenBy?: string;
}

interface HeaderInput {
  key: string;
  value: string;
  enabled?: boolean;
}

function isDisabled(key: string, disabledDefaults: string[] | undefined): boolean {
  const lower = key.toLowerCase();
  return (disabledDefaults ?? []).some(k => k.toLowerCase() === lower);
}

// Header que o auth da request gera (Bearer/Basic → Authorization, API Key →
// a key configurada). Conta como "header da request" pra override.
function authHeaderName(auth: AuthorizationDetails | undefined, resolve: (s: string) => string): string | null {
  if (!auth) return null;
  if (auth.type === 'bearer' && auth.token?.trim()) return 'Authorization';
  if (auth.type === 'basic') return 'Authorization';
  if (auth.type === 'apikey' && auth.key?.trim()) return resolve(auth.key);
  return null;
}

// Estado de cada header padrão pra mostrar na aba Headers.
export function getDefaultHeaderStates(options: {
  userHeaders: HeaderInput[];
  disabledDefaults?: string[];
  hasBody: boolean;
  auth?: AuthorizationDetails;
}): DefaultHeaderState[] {
  const userNames = options.userHeaders
    .filter(h => h.enabled !== false && h.key.trim())
    .map(h => h.key.trim());
  const authName = authHeaderName(options.auth, s => s);
  if (authName) userNames.push(authName);

  return DEFAULT_HEADERS.map(header => {
    const override = userNames.find(name => name.toLowerCase() === header.key.toLowerCase());
    if (override) return { ...header, status: 'overridden', overriddenBy: override };
    if (isDisabled(header.key, options.disabledDefaults)) return { ...header, status: 'disabled' };
    if (header.onlyWithBody && !options.hasBody) return { ...header, status: 'no-body' };
    return { ...header, status: 'sent' };
  });
}

// Headers finais da request: padrões → headers da request → auth, cada
// camada substituindo a anterior sem diferenciar maiúsculas/minúsculas.
export function buildRequestHeaders(options: {
  userHeaders: HeaderInput[];
  disabledDefaults?: string[];
  hasBody: boolean;
  auth?: AuthorizationDetails;
  resolve: (value: string) => string;
}): Record<string, string> {
  const { resolve } = options;
  // lower-case → [nome como vai no request, valor]
  const merged = new Map<string, [string, string]>();
  const set = (key: string, value: string) => merged.set(key.toLowerCase(), [key, value]);

  for (const header of DEFAULT_HEADERS) {
    if (isDisabled(header.key, options.disabledDefaults)) continue;
    if (header.onlyWithBody && !options.hasBody) continue;
    set(header.key, header.value);
  }

  for (const h of options.userHeaders) {
    if (h.enabled !== false && h.key.trim()) set(h.key, resolve(h.value || ''));
  }

  const auth = options.auth;
  if (auth) {
    if (auth.type === 'bearer' && auth.token?.trim()) {
      set('Authorization', `Bearer ${resolve(auth.token)}`);
    } else if (auth.type === 'basic') {
      const user = resolve(auth.username || '');
      const pass = resolve(auth.password || '');
      set('Authorization', `Basic ${btoa(`${user}:${pass}`)}`);
    } else if (auth.type === 'apikey' && auth.key?.trim()) {
      set(resolve(auth.key), resolve(auth.value || ''));
    }
  }

  return Object.fromEntries([...merged.values()]);
}

// "A request tem body?" — mesma regra do envio: bodyType 'none' não manda
// nada, mesmo que tenha texto guardado no editor.
export function requestHasBody(bodyType: string | undefined, body: string | undefined): boolean {
  return bodyType !== 'none' && !!body?.trim();
}
