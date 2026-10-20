// Declarações de tipos (.d.ts) da API `pm.*` disponível dentro dos scripts
// de Pre-request/Post-response (aba "Scripts" do RequestEditor). Isso NÃO
// afeta o runtime — os scripts continuam rodando no sandbox QuickJS do lado
// Rust (ver `execute_script_backend` em src-tauri/src/lib.rs), que é quem
// realmente injeta `globalThis.pm`/`tests`/`postman`/etc. Esse arquivo só
// ensina o Monaco (via `javascriptDefaults.addExtraLib`, ver CodeEditor.tsx)
// a reconhecer essas globais pra dar autocomplete, assinatura de função e
// hover-docs em vez de tratar `pm` como undefined.
//
// Precisa ficar em sincronia manual com o bootstrap JS em lib.rs — qualquer
// método novo adicionado lá (ou removido) deve ser espelhado aqui.
export const PM_API_TYPES = `
interface PmKeyValueStore {
  /** Lê o valor da variável. Retorna undefined se ela não existir. */
  get(key: string): string | undefined;
  /** Cria ou atualiza a variável com o valor informado (sempre salvo como string). */
  set(key: string, value: any): void;
  /** true se a variável existir (e não for null/undefined). */
  has(key: string): boolean;
  /** Remove a variável. */
  unset(key: string): void;
}

interface PmAssertion {
  // Encadeamento fluente estilo chai — cada uma dessas só devolve a mesma
  // assertion pra deixar a frase legível (pm.expect(x).to.be.a("string")).
  readonly to: PmAssertion;
  readonly be: PmAssertion;
  readonly been: PmAssertion;
  readonly is: PmAssertion;
  readonly and: PmAssertion;
  readonly has: PmAssertion;
  readonly have: PmAssertion;
  readonly with: PmAssertion;
  readonly at: PmAssertion;
  readonly of: PmAssertion;
  readonly same: PmAssertion;
  /** Ativa comparação profunda (deep equal) na próxima .equal()/.include(). */
  readonly deep: PmAssertion;
  /** Inverte o resultado da próxima verificação. */
  readonly not: PmAssertion;

  readonly ok: PmAssertion;
  readonly true: PmAssertion;
  readonly false: PmAssertion;
  readonly null: PmAssertion;
  readonly undefined: PmAssertion;
  readonly exist: PmAssertion;
  readonly empty: PmAssertion;

  equal(expected: any): PmAssertion;
  /** Comparação profunda (equivalente a .deep.equal). */
  eql(expected: any): PmAssertion;
  a(type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'undefined' | 'function' | 'null'): PmAssertion;
  an(type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'undefined' | 'function' | 'null'): PmAssertion;
  include(expected: any): PmAssertion;
  property(name: string, expected?: any): PmAssertion;
  length(n: number): PmAssertion;
  lengthOf(n: number): PmAssertion;
  above(n: number): PmAssertion;
  below(n: number): PmAssertion;
  least(n: number): PmAssertion;
  most(n: number): PmAssertion;
  match(regex: RegExp): PmAssertion;
  oneOf(list: any[]): PmAssertion;
}

interface PmRequestHeaders {
  get(key: string): string | undefined;
  has(key: string): boolean;
  add(opts: { key: string; value: string }): void;
  upsert(opts: { key: string; value: string }): void;
  remove(key: string): void;
}

interface PmRequestBody {
  raw: string;
  toString(): string;
}

interface PmRequest {
  method: string;
  url: string;
  body: PmRequestBody | string;
  headers: PmRequestHeaders;
}

interface PmResponseHeaders {
  get(key: string): string | undefined;
  has(key: string): boolean;
}

interface PmResponse {
  /** Status HTTP da resposta (ex: 200, 404). */
  code: number;
  /** Alias de \`code\`. */
  status: number;
  /** Tempo da requisição em ms. */
  responseTime: number;
  /** Corpo da resposta como texto puro. */
  text(): string;
  /** Corpo da resposta parseado como JSON (lança se não for JSON válido). */
  json(): any;
  headers: PmResponseHeaders;
  to: {
    readonly be: { readonly ok: boolean };
    have: {
      status(expected: number | string): boolean;
      header(key: string): boolean;
      jsonBody(): boolean;
    };
  };
}

interface PmApi {
  /** Variáveis do environment ativo. */
  environment: PmKeyValueStore;
  /** Alias de \`environment\` neste app (mesmo mapa, sem escopo separado). */
  variables: PmKeyValueStore;
  /** Alias de \`environment\` neste app (mesmo mapa, sem escopo separado). */
  globals: PmKeyValueStore;
  /** Alias de \`environment\` neste app (mesmo mapa, sem escopo separado). */
  collectionVariables: PmKeyValueStore;
  /** Só disponível no script de post-response — a resposta HTTP recebida. */
  response: PmResponse;
  /** A request que foi (ou vai ser) enviada — leitura e escrita. */
  request: PmRequest;
  /** Registra um teste; passa se \`fn\` não lançar. Aparece na aba Test Results. */
  test(name: string, fn: () => void): void;
  /** Cria uma assertion fluente estilo chai pro valor informado. */
  expect(value: any): PmAssertion;
}

/** API principal dos scripts (Pre-request e Post-response). */
declare const pm: PmApi;

// ── Globais "legados" (API pré-pm.*, ainda comuns em collections antigas) ──

/** @deprecated Prefira \`pm.response.text()\`. Só disponível no post-response. */
declare const responseBody: string;
/** @deprecated Prefira \`pm.response.code\`. Só disponível no post-response. */
declare const responseCode: { code: number; name: string; detail: string };
/** @deprecated Prefira \`pm.response.headers\`. Só disponível no post-response. */
declare const responseHeaders: Record<string, string>;
/** @deprecated Prefira \`pm.response.responseTime\`. Só disponível no post-response. */
declare const responseTime: number;
/** @deprecated Prefira \`pm.request\`. */
declare const request: { method: string; url: string; data: string; headers: Record<string, string> };
/** @deprecated Prefira \`pm.test(...)\`. Atribua \`tests["nome do teste"] = condição\`. */
declare const tests: Record<string, boolean>;
/** @deprecated Prefira \`pm.environment.*\`. */
declare const postman: {
  setEnvironmentVariable(key: string, value: any): void;
  getEnvironmentVariable(key: string): string | undefined;
  clearEnvironmentVariable(key: string): void;
  setGlobalVariable(key: string, value: any): void;
  getGlobalVariable(key: string): string | undefined;
  clearGlobalVariable(key: string): void;
};

/** Biblioteca moment.js, disponível globalmente (e via require('moment')). */
declare const moment: any;
declare function require(name: 'moment'): any;
`;
