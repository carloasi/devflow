use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rquickjs::{prelude::Func, Context, Runtime};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use base64::{engine::general_purpose, Engine as _};

mod secure_storage;
use secure_storage::{save_secret, get_secret, delete_secret};

mod user_photo;
use user_photo::get_windows_user_photo;

mod load_test;
use load_test::{start_load_test, stop_load_test, LoadTestRegistry};

mod mcp_server;
use mcp_server::{start_mcp_server, stop_mcp_server, mcp_respond};

mod claude_cli;
use claude_cli::{
    claude_auth_login, claude_auth_logout, claude_auth_status, claude_available, claude_cancel,
    claude_send,
};

mod extensions;
mod grpc;
use grpc::{
    grpc_compile_protos, grpc_describe, grpc_invoke, grpc_reflect, grpc_stream_cancel, grpc_stream_end,
    grpc_stream_send, grpc_stream_start, GrpcStreams,
};
use extensions::{list_extensions, extensions_folder, scaffold_extension};

use tauri_plugin_store::StoreExt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tauri_plugin_opener::OpenerExt;
// Estado global em memória, espelhando o valor persistido
// pub(crate) pra ser visível também no submódulo load_test.
pub(crate) struct SslVerifyState(pub(crate) AtomicBool);

// Timeout (em ms) aplicado a toda request disparada pelo Send normal
// (make_http_request) — 0 significa "sem timeout" (comportamento antigo,
// esperar indefinidamente). Guardado em ms (não segundos) pra permitir
// granularidade fina sem precisar de outro tipo de estado.
pub(crate) struct RequestTimeoutState(pub(crate) AtomicU64);
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;

/// Pote de cookies compartilhado por todas as requests do Send e do runner.
///
/// Precisa viver fora do cliente porque o cliente é RECONSTRUÍDO a cada
/// request (verificação de SSL e timeout podem ter mudado nas configurações).
/// Sem um pote externo, todo `Set-Cookie` morria junto com o cliente e
/// qualquer API que autentica por cookie de sessão ficava inutilizável.
///
/// Fica em Mutex porque "limpar cookies" é implementado trocando o pote por
/// um novo: o `Jar` do reqwest não expõe remoção.
pub(crate) struct CookieJarState(pub(crate) std::sync::Mutex<std::sync::Arc<reqwest::cookie::Jar>>);

impl Default for CookieJarState {
    fn default() -> Self {
        Self(std::sync::Mutex::new(std::sync::Arc::new(
            reqwest::cookie::Jar::default(),
        )))
    }
}

const MOMENT_JS: &str = include_str!("../../src/utils/moment.min.js");

#[tauri::command]
fn open_browser_url(url: String) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}

fn is_binary_content_type(ct: &str) -> bool {
    let binary_types = [
        "application/zip",
        "application/x-zip",
        "application/octet-stream",
        "application/pdf",
        "application/vnd.",      
        "image/",
        "audio/",
        "video/",
    ];
    binary_types.iter().any(|t| ct.contains(t))
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRequest {
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScriptContext {
    pub env: HashMap<String, String>,
    pub response_body: Option<String>,
    pub response: Option<serde_json::Value>,
    // ✅ Estado real da request (method/url/headers/body). Pre-request scripts
    //    podem ler E modificar isso via pm.request — o valor de volta é
    //    aplicado na request de verdade antes do envio (não é só "cosmético"
    //    como o stub antigo, que sempre retornava undefined/"").
    #[serde(default)]
    pub request: Option<ScriptRequest>,
    // Tempo da request em ms — só é relevante pro post-response script (pm.response.responseTime).
    #[serde(default)]
    pub response_time: Option<f64>,
    // Resultados de pm.test(...) coletados durante a execução do script.
    // Não é enviado pelo frontend (fica vazio no input), só populado na saída.
    #[serde(default)]
    pub tests: Vec<TestResult>,
    // Se o script quebrou com uma exceção não tratada (erro de sintaxe, ou
    // código fora de qualquer pm.test que lançou), o erro fica aqui — mas
    // env/request/tests parciais (o que já tinha rodado até a linha que
    // quebrou) ainda são retornados normalmente, em vez de serem descartados.
    #[serde(default)]
    pub script_error: Option<String>,
    // Logs de console.log/info/warn/error coletados durante a execução do
    // script. Não é enviado pelo frontend (fica vazio no input), só
    // populado na saída — mesmo padrão de `tests`.
    #[serde(default)]
    pub logs: Vec<ScriptLogEntry>,
    // Cada chamada de pm.environment.set(...)/pm.variables.set(...)/
    // pm.globals.set(...)/pm.collectionVariables.set(...) (todas passam pelo
    // mesmo __env_set) durante a execução do script, na ordem em que
    // rodaram. IMPORTANTE: registra a chamada em si, não um diff do mapa de
    // env antes/depois — se o script atribuir um valor IGUAL ao que já
    // existia (ex: um endpoint de teste/sandbox que devolve sempre o mesmo
    // token), um diff não detectaria nenhuma mudança e a atribuição some do
    // relatório do Runner, mesmo tendo acontecido de verdade.
    #[serde(default)]
    pub set_variables: Vec<VariableSetEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub name: String,
    pub passed: bool,
    pub message: String,
}

// Entrada de console.log/info/warn/error emitida durante a execução do
// script. Além de continuar sendo emitida em tempo real via evento
// "script-log" (pro Console global do app), agora também é coletada e
// devolvida no retorno do invoke — o Collection Runner roda vários scripts
// em sequência headless (sem o painel de Console aberto) e precisa recuperar
// esse conteúdo ao final de cada request, não só ao vivo.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScriptLogEntry {
    pub level: String,
    pub message: String,
}

// Uma chamada de pm.environment.set(key, value) (ou equivalente) capturada
// no momento em que aconteceu — ver comentário em ScriptContext.set_variables.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VariableSetEntry {
    pub key: String,
    pub value: String,
}


#[derive(Debug, Serialize, Deserialize)]
pub struct HttpResponse {
    status: u16,
    body: String,
    headers: HashMap<String, String>,
    is_binary: bool,  // ← novo campo
}

#[tauri::command]
fn execute_script_backend(
    window: tauri::Window,
    script: String,
    context: ScriptContext,
) -> Result<ScriptContext, String> {

    const MAX_JSON_SIZE: usize = 5 * 1024 * 1024;

    let raw_body = context
        .response_body
        .clone()
        .unwrap_or_else(|| "{}".to_string());

    if raw_body.len() > MAX_JSON_SIZE {
        return Err(format!("JSON muito grande: {} bytes", raw_body.len()));
    }

    let shared_env = Arc::new(Mutex::new(context.env.clone()));
    let shared_request = Arc::new(Mutex::new(context.request.clone().unwrap_or_default()));
    let shared_tests: Arc<Mutex<Vec<TestResult>>> = Arc::new(Mutex::new(Vec::new()));
    let shared_logs: Arc<Mutex<Vec<ScriptLogEntry>>> = Arc::new(Mutex::new(Vec::new()));
    let shared_set_ops: Arc<Mutex<Vec<VariableSetEntry>>> = Arc::new(Mutex::new(Vec::new()));

    // Dados de resposta usados por pm.response (code/headers/responseTime) e
    // pelas assertions pm.response.to.have.status/header. Extraídos aqui do
    // JSON solto que o frontend manda (mesmo shape do DataResponse: status/headers).
    let response_status: i64 = context
        .response
        .as_ref()
        .and_then(|v| v.get("status"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let response_headers: HashMap<String, String> = context
        .response
        .as_ref()
        .and_then(|v| v.get("headers"))
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.to_lowercase(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let response_time_ms: f64 = context.response_time.unwrap_or(0.0);

    let runtime = Runtime::new().map_err(|e| e.to_string())?;

    runtime.set_memory_limit(64 * 1024 * 1024);
    runtime.set_max_stack_size(1024 * 1024);

    let ctx = Context::full(&runtime).map_err(|e| e.to_string())?;

    let script_error: Option<String> = ctx.with(|ctx| {
        let globals = ctx.globals();

    // 1. Injeta o código do moment globalmente
    ctx.eval::<(), _>(MOMENT_JS)
        .map_err(|e| format!("Erro ao carregar Moment: {}", e))?;

    // 2. Define o require falso para o usuário poder usar require('moment')
    let bootstrap = r#"
        globalThis.require = (name) => {
            if (name === 'moment') return globalThis.moment;
            throw new Error('Modulo nao encontrado: ' + name);
        };
    "#;
    ctx.eval::<(), _>(bootstrap).map_err(|e| e.to_string())?;

        let window_for_log = window.clone();
        let logs_record = Arc::clone(&shared_logs);
        let console_log = Func::from(move |level: String, message: String| {
            let payload = serde_json::json!({ "level": level.clone(), "message": message.clone() }).to_string();
            let _ = window_for_log.emit("script-log", payload);
            if let Ok(mut logs) = logs_record.lock() {
                logs.push(ScriptLogEntry { level, message });
            }
        });

        globals
            .set("__console_log", console_log)
            .map_err(|e| e.to_string())?;

        let env_get = Arc::clone(&shared_env);

        let get_fn = Func::from(move |key: String| -> Option<String> {
            env_get.lock().ok().and_then(|env| env.get(&key).cloned())
        });

        globals
            .set("__env_get", get_fn)
            .map_err(|e| e.to_string())?;


    
        let env_set = Arc::clone(&shared_env);
        let set_ops_record = Arc::clone(&shared_set_ops);

        let set_fn = Func::from(move |key: String, value: String| {
            if let Ok(mut env) = env_set.lock() {
                env.insert(key.clone(), value.clone());
            }
            if let Ok(mut ops) = set_ops_record.lock() {
                ops.push(VariableSetEntry { key, value });
            }
        });

        globals
            .set("__env_set", set_fn)
            .map_err(|e| e.to_string())?;

        globals
            .set("__response_body", raw_body.clone())
            .map_err(|e| e.to_string())?;

        let env_unset = Arc::clone(&shared_env);

        let unset_fn = Func::from(move |key: String| {
            if let Ok(mut env) = env_unset.lock() {
                env.remove(&key);
            }
        });

        globals
            .set("__env_unset", unset_fn)
            .map_err(|e| e.to_string())?;

        // ── pm.request: method/url/body (get + set) ──────────────────────
        let req_get_method = Arc::clone(&shared_request);
        let get_method_fn = Func::from(move || -> String {
            req_get_method.lock().map(|r| r.method.clone()).unwrap_or_default()
        });
        globals.set("__req_get_method", get_method_fn).map_err(|e| e.to_string())?;

        let req_set_method = Arc::clone(&shared_request);
        let set_method_fn = Func::from(move |value: String| {
            if let Ok(mut r) = req_set_method.lock() { r.method = value; }
        });
        globals.set("__req_set_method", set_method_fn).map_err(|e| e.to_string())?;

        let req_get_url = Arc::clone(&shared_request);
        let get_url_fn = Func::from(move || -> String {
            req_get_url.lock().map(|r| r.url.clone()).unwrap_or_default()
        });
        globals.set("__req_get_url", get_url_fn).map_err(|e| e.to_string())?;

        let req_set_url = Arc::clone(&shared_request);
        let set_url_fn = Func::from(move |value: String| {
            if let Ok(mut r) = req_set_url.lock() { r.url = value; }
        });
        globals.set("__req_set_url", set_url_fn).map_err(|e| e.to_string())?;

        let req_get_body = Arc::clone(&shared_request);
        let get_body_fn = Func::from(move || -> String {
            req_get_body.lock().map(|r| r.body.clone()).unwrap_or_default()
        });
        globals.set("__req_get_body", get_body_fn).map_err(|e| e.to_string())?;

        let req_set_body = Arc::clone(&shared_request);
        let set_body_fn = Func::from(move |value: String| {
            if let Ok(mut r) = req_set_body.lock() { r.body = value; }
        });
        globals.set("__req_set_body", set_body_fn).map_err(|e| e.to_string())?;

        // ── pm.request.headers: get/has/add/upsert/remove ────────────────
        let headers_get = Arc::clone(&shared_request);
        let headers_get_fn = Func::from(move |key: String| -> Option<String> {
            headers_get.lock().ok().and_then(|r| r.headers.get(&key).cloned())
        });
        globals.set("__headers_get", headers_get_fn).map_err(|e| e.to_string())?;

        let headers_has = Arc::clone(&shared_request);
        let headers_has_fn = Func::from(move |key: String| -> bool {
            headers_has.lock().map(|r| r.headers.contains_key(&key)).unwrap_or(false)
        });
        globals.set("__headers_has", headers_has_fn).map_err(|e| e.to_string())?;

        let headers_set = Arc::clone(&shared_request);
        let headers_set_fn = Func::from(move |key: String, value: String| {
            if let Ok(mut r) = headers_set.lock() { r.headers.insert(key, value); }
        });
        globals.set("__headers_set", headers_set_fn).map_err(|e| e.to_string())?;

        let headers_remove = Arc::clone(&shared_request);
        let headers_remove_fn = Func::from(move |key: String| {
            if let Ok(mut r) = headers_remove.lock() { r.headers.remove(&key); }
        });
        globals.set("__headers_remove", headers_remove_fn).map_err(|e| e.to_string())?;

        // Usado pelo global legado `request.headers` (API antiga do Postman,
        // pré pm.*) — precisa de todos os headers de uma vez, não só get/has.
        let headers_get_all = Arc::clone(&shared_request);
        let headers_get_all_fn = Func::from(move || -> String {
            headers_get_all
                .lock()
                .ok()
                .and_then(|r| serde_json::to_string(&r.headers).ok())
                .unwrap_or_else(|| "{}".to_string())
        });
        globals.set("__req_get_headers_json", headers_get_all_fn).map_err(|e| e.to_string())?;

        // ── pm.response: status/headers/tempo (só leitura) ───────────────
        globals.set("__response_status_code", response_status).map_err(|e| e.to_string())?;
        globals.set("__response_time", response_time_ms).map_err(|e| e.to_string())?;

        let response_headers_json =
            serde_json::to_string(&response_headers).unwrap_or_else(|_| "{}".to_string());
        globals
            .set("__response_headers_json", response_headers_json)
            .map_err(|e| e.to_string())?;

        let response_headers_arc = Arc::new(response_headers);
        let response_headers_for_get = Arc::clone(&response_headers_arc);
        let response_header_get_fn = Func::from(move |key: String| -> Option<String> {
            response_headers_for_get.get(&key.to_lowercase()).cloned()
        });
        globals.set("__response_header_get", response_header_get_fn).map_err(|e| e.to_string())?;

        // ── pm.test: coleta os resultados em shared_tests ─────────────────
        let tests_record = Arc::clone(&shared_tests);
        let test_record_fn = Func::from(move |name: String, passed: bool, message: String| {
            if let Ok(mut t) = tests_record.lock() {
                t.push(TestResult { name, passed, message });
            }
        });
        globals.set("__test_record", test_record_fn).map_err(|e| e.to_string())?;

        let bootstrap = r#"

        function __formatConsoleArgs(args) {
            return args.map(v => {
                if (typeof v === "object") {
                    try {
                        return JSON.stringify(v, null, 2);
                    }
                    catch {
                        return "[Object]";
                    }
                }
                return String(v);
            }).join(" ");
        }

        globalThis.console = {
            log(...args) { __console_log("log", __formatConsoleArgs(args)); },
            info(...args) { __console_log("info", __formatConsoleArgs(args)); },
            warn(...args) { __console_log("warn", __formatConsoleArgs(args)); },
            error(...args) { __console_log("error", __formatConsoleArgs(args)); }
        };

        // ── Mini biblioteca de assertions estilo chai, usada por pm.expect() ──
        // Cobre os padrões mais comuns usados em testes do Postman. Não é uma
        // implementação completa do chai, mas suporta encadeamento fluente
        // (.to.be.a / .to.have.property / .to.deep.equal / .not / etc).
        function __deepEqual(a, b) {
            if (a === b) return true;
            if (typeof a !== typeof b) return false;
            if (a === null || b === null) return a === b;
            if (typeof a !== "object") return false;
            if (Array.isArray(a) !== Array.isArray(b)) return false;
            const ak = Object.keys(a), bk = Object.keys(b);
            if (ak.length !== bk.length) return false;
            return ak.every(k => __deepEqual(a[k], b[k]));
        }

        function __makeAssertion(value, negate) {
            negate = !!negate;
            let deepMode = false;

            const fmt = (v) => {
                try { return JSON.stringify(v); } catch { return String(v); }
            };

            const passOrFail = (cond, msgIfFail, msgIfShouldFail) => {
                const ok = negate ? !cond : cond;
                if (!ok) {
                    throw new Error(negate ? (msgIfShouldFail || "expected assertion to fail but it passed") : msgIfFail);
                }
                return assertion;
            };

            const assertion = {
                get to() { return assertion; },
                get be() { return assertion; },
                get been() { return assertion; },
                get is() { return assertion; },
                get and() { return assertion; },
                get has() { return assertion; },
                get have() { return assertion; },
                get with() { return assertion; },
                get at() { return assertion; },
                get of() { return assertion; },
                get same() { return assertion; },
                get deep() { deepMode = true; return assertion; },
                get not() { return __makeAssertion(value, !negate); },

                get ok() {
                    return passOrFail(!!value, "expected " + fmt(value) + " to be truthy", "expected " + fmt(value) + " to not be truthy");
                },
                get true() {
                    return passOrFail(value === true, "expected " + fmt(value) + " to be true", "expected value to not be true");
                },
                get false() {
                    return passOrFail(value === false, "expected " + fmt(value) + " to be false", "expected value to not be false");
                },
                get null() {
                    return passOrFail(value === null, "expected " + fmt(value) + " to be null", "expected value to not be null");
                },
                get undefined() {
                    return passOrFail(value === undefined, "expected value to be undefined", "expected value to not be undefined");
                },
                get exist() {
                    return passOrFail(value !== null && value !== undefined, "expected value to exist", "expected value to not exist");
                },
                get empty() {
                    let isEmpty;
                    if (typeof value === "string" || Array.isArray(value)) isEmpty = value.length === 0;
                    else if (value && typeof value === "object") isEmpty = Object.keys(value).length === 0;
                    else isEmpty = !value;
                    return passOrFail(isEmpty, "expected value to be empty", "expected value to not be empty");
                },

                equal(expected) {
                    const ok = deepMode ? __deepEqual(value, expected) : value === expected;
                    return passOrFail(ok, "expected " + fmt(value) + " to equal " + fmt(expected), "expected " + fmt(value) + " to not equal " + fmt(expected));
                },
                eql(expected) {
                    return passOrFail(__deepEqual(value, expected), "expected " + fmt(value) + " to deeply equal " + fmt(expected), "expected value to not deeply equal " + fmt(expected));
                },
                a(type) {
                    const actual = Array.isArray(value) ? "array" : (value === null ? "null" : typeof value);
                    return passOrFail(actual === type, "expected " + fmt(value) + " to be a " + type + " but got " + actual, "expected value to not be a " + type);
                },
                an(type) { return assertion.a(type); },
                include(expected) {
                    let ok;
                    if (typeof value === "string") ok = value.indexOf(expected) !== -1;
                    else if (Array.isArray(value)) ok = value.indexOf(expected) !== -1;
                    else if (value && typeof value === "object") ok = Object.prototype.hasOwnProperty.call(value, expected);
                    else ok = false;
                    return passOrFail(ok, "expected " + fmt(value) + " to include " + fmt(expected), "expected value to not include " + fmt(expected));
                },
                property(name, expected) {
                    const has = !!(value && typeof value === "object" && name in value);
                    if (arguments.length < 2) {
                        return passOrFail(has, "expected object to have property '" + name + "'", "expected object to not have property '" + name + "'");
                    }
                    const ok = has && __deepEqual(value[name], expected);
                    return passOrFail(ok, "expected property '" + name + "' to equal " + fmt(expected), "expected property '" + name + "' to not equal " + fmt(expected));
                },
                length(n) {
                    const len = value && (value.length !== undefined ? value.length : Object.keys(value).length);
                    return passOrFail(len === n, "expected length " + len + " to equal " + n, "expected length to not equal " + n);
                },
                lengthOf(n) { return assertion.length(n); },
                above(n) {
                    return passOrFail(value > n, "expected " + fmt(value) + " to be above " + n, "expected " + fmt(value) + " to not be above " + n);
                },
                below(n) {
                    return passOrFail(value < n, "expected " + fmt(value) + " to be below " + n, "expected " + fmt(value) + " to not be below " + n);
                },
                least(n) {
                    return passOrFail(value >= n, "expected " + fmt(value) + " to be at least " + n, "expected " + fmt(value) + " to not be at least " + n);
                },
                most(n) {
                    return passOrFail(value <= n, "expected " + fmt(value) + " to be at most " + n, "expected " + fmt(value) + " to not be at most " + n);
                },
                match(regex) {
                    return passOrFail(regex.test(value), "expected " + fmt(value) + " to match " + regex, "expected value to not match " + regex);
                },
                oneOf(list) {
                    return passOrFail(list.indexOf(value) !== -1, "expected " + fmt(value) + " to be one of " + fmt(list), "expected value to not be one of " + fmt(list));
                }
            };

            return assertion;
        }

        globalThis.pm = {

            environment: {
                get(key) { return __env_get(key); },
                set(key, value) { __env_set(key, String(value)); },
                has(key) { return __env_get(key) !== undefined && __env_get(key) !== null; },
                unset(key) { __env_unset(key); }
            },

            variables: {
                get(key) { return __env_get(key); },
                set(key, value) { __env_set(key, String(value)); },
                has(key) { return __env_get(key) !== undefined && __env_get(key) !== null; },
                unset(key) { __env_unset(key); }
            },

            globals: {
                get(key) { return __env_get(key); },
                set(key, value) { __env_set(key, String(value)); },
                has(key) { return __env_get(key) !== undefined && __env_get(key) !== null; },
                unset(key) { __env_unset(key); }
            },

            collectionVariables: {
                get(key) { return __env_get(key); },
                set(key, value) { __env_set(key, String(value)); },
                has(key) { return __env_get(key) !== undefined && __env_get(key) !== null; },
                unset(key) { __env_unset(key); }
            },

            response: {
                code: __response_status_code,
                status: __response_status_code,
                responseTime: __response_time,
                text() { return __response_body; },
                json() { return JSON.parse(__response_body); },
                headers: {
                    get(key) { return __response_header_get(String(key)); },
                    has(key) {
                        const v = __response_header_get(String(key));
                        return v !== undefined && v !== null;
                    }
                },
                to: {
                    get be() {
                        return {
                            get ok() {
                                const code = __response_status_code;
                                if (!(code >= 200 && code < 300)) {
                                    throw new Error("expected response to have an ok status but got " + code);
                                }
                                return true;
                            }
                        };
                    },
                    have: {
                        status(expected) {
                            const actual = __response_status_code;
                            const ok = typeof expected === "string" ? String(actual) === expected : actual === expected;
                            if (!ok) throw new Error("expected response to have status '" + expected + "' but got '" + actual + "'");
                            return true;
                        },
                        header(key) {
                            const v = __response_header_get(String(key));
                            if (v === undefined || v === null) throw new Error("expected response to have header '" + key + "'");
                            return true;
                        },
                        jsonBody() {
                            try { JSON.parse(__response_body); }
                            catch { throw new Error("expected response to have a valid JSON body"); }
                            return true;
                        }
                    }
                }
            },

            request: {
                get method() { return __req_get_method(); },
                set method(v) { __req_set_method(String(v)); },

                get url() {
                    return {
                        toString() { return __req_get_url(); },
                        valueOf() { return __req_get_url(); }
                    };
                },
                set url(v) { __req_set_url(String(v)); },

                get body() {
                    return {
                        get raw() { return __req_get_body(); },
                        set raw(v) { __req_set_body(String(v)); },
                        toString() { return __req_get_body(); }
                    };
                },
                set body(v) {
                    if (v && typeof v === "object" && "raw" in v) {
                        __req_set_body(String(v.raw));
                    } else {
                        __req_set_body(String(v));
                    }
                },

                headers: {
                    get(key) { return __headers_get(String(key)); },
                    has(key) { return __headers_has(String(key)); },
                    add(opts) {
                        if (opts && typeof opts === "object" && "key" in opts) {
                            __headers_set(String(opts.key), String(opts.value ?? ""));
                        }
                    },
                    upsert(opts) {
                        if (opts && typeof opts === "object" && "key" in opts) {
                            __headers_set(String(opts.key), String(opts.value ?? ""));
                        }
                    },
                    remove(key) { __headers_remove(String(key)); }
                }
            }
        };

        globalThis.pm.expect = function(value) { return __makeAssertion(value, false); };

        globalThis.pm.test = function(name, fn) {
            try {
                fn();
                __test_record(String(name), true, "");
            } catch (e) {
                const message = (e && e.message) ? String(e.message) : String(e);
                __test_record(String(name), false, message);
            }
        };

        // ── Globais "legados" do Postman (API anterior ao pm.*, ainda muito
        // comum em collections antigas importadas) — responseBody, responseCode,
        // responseHeaders, responseTime, request e tests[...] direto no escopo
        // global, além do objeto postman.setEnvironmentVariable/getGlobalVariable.
        globalThis.responseBody = __response_body;

        globalThis.responseCode = {
            code: __response_status_code,
            name: (__response_status_code >= 200 && __response_status_code < 300) ? "OK" : "",
            detail: "",
        };

        globalThis.responseHeaders = (function() {
            try { return JSON.parse(__response_headers_json); } catch (e) { return {}; }
        })();

        globalThis.responseTime = __response_time;

        globalThis.request = {
            method: __req_get_method(),
            url: __req_get_url(),
            data: __req_get_body(),
            headers: (function() {
                try { return JSON.parse(__req_get_headers_json()); } catch (e) { return {}; }
            })()
        };

        // tests["algum nome"] = true/false; — coletado pro final do script,
        // depois de rodar (ver harvest_tests no lado Rust), igual ao pm.test.
        globalThis.tests = {};

        globalThis.postman = {
            setEnvironmentVariable(key, value) { __env_set(String(key), String(value)); },
            getEnvironmentVariable(key) { return __env_get(String(key)); },
            clearEnvironmentVariable(key) { __env_unset(String(key)); },
            setGlobalVariable(key, value) { __env_set(String(key), String(value)); },
            getGlobalVariable(key) { return __env_get(String(key)); },
            clearGlobalVariable(key) { __env_unset(String(key)); },
        };

        "#;

        ctx.eval::<(), _>(bootstrap).map_err(|e| e.to_string())?;

    // Se o script quebrar com uma exceção não tratada (fora de qualquer
    // pm.test, ou erro de sintaxe), a gente NÃO aborta o comando inteiro —
    // captura o erro aqui e continua, pra env/request/tests parciais (o que
    // já rodou até a linha que quebrou, incluindo pm.test's que já passaram)
    // não serem jogados fora.
    let mut script_error: Option<String> = None;

    if let Err(e) = ctx.eval::<(), _>(script.as_str()) {
        let detailed_error = if let rquickjs::Error::Exception = e {
            let caught = ctx.catch();

            if let Some(exception) = caught.as_exception() {
                // Em versões estáveis do rquickjs, Exception implementa Display.
                // O método .stack() contém a stack trace completa (incluindo linha e arquivo).
                let message = exception.message().unwrap_or_else(|| "Unknown Error".to_string());
                let stack = exception.stack().unwrap_or_else(|| "No stack trace available".to_string());

                format!(
                    "❌ JS Error: {}\n📜 Stack Trace:\n{}",
                    message, stack
                )
            } else {
                format!("❌ JS Threw: {:?}", caught)
            }
        } else {
            format!("❌ JS Error: {}", e)
        };

        // Não emite via "script-log" aqui — esse evento é só pro forwarding
        // de console.log/info/warn/error em tempo real. O erro da exceção já
        // volta pro chamador via `script_error` no retorno do invoke (ver
        // ScriptContext), que é onde o frontend efetivamente loga; emitir os
        // dois duplicava a entrada no console E com nível errado (o listener
        // do "script-log" não conseguia fazer JSON.parse desse texto bruto e
        // caía no fallback, que registrava como 'log' em vez de 'error').
        script_error = Some(detailed_error);
    }

    // Coleta o objeto legado `tests` (ex: tests["Status is 200"] = responseCode.code === 200;)
    // como TestResult, igual ao que pm.test(...) já faz. Roda sempre, mesmo se
    // o script quebrou no meio — aproveita o que já tinha sido setado até ali.
    let harvest_legacy_tests = r#"
        (function() {
            try {
                if (typeof tests === "object" && tests !== null) {
                    Object.keys(tests).forEach(function(k) {
                        __test_record(k, !!tests[k], "");
                    });
                }
            } catch (e) {}
        })();
    "#;
    let _ = ctx.eval::<(), _>(harvest_legacy_tests);

        Ok::<Option<String>, String>(script_error)
    })?;

    let final_env = shared_env.lock().unwrap().clone();
    let final_request = shared_request.lock().unwrap().clone();
    let final_tests = shared_tests.lock().unwrap().clone();
    let final_logs = shared_logs.lock().unwrap().clone();
    let final_set_ops = shared_set_ops.lock().unwrap().clone();

    Ok(ScriptContext {
        env: final_env,
        response_body: context.response_body,
        response: context.response,
        request: Some(final_request),
        response_time: context.response_time,
        tests: final_tests,
        script_error,
        logs: final_logs,
        set_variables: final_set_ops,
    })
}

use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder, WebviewUrl};

#[derive(Clone, serde::Serialize)]
struct OAuthCallbackPayload {
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Fecha a janela de login, se estiver aberta.
///
/// O fluxo OAuth só termina quando o callback chega — se ninguém concluir o
/// login, a promise do frontend fica pendurada pra sempre e o botão trava em
/// "Fetching Token...". Este comando é o que permite desistir: o cancelamento
/// do lado do app fecha a janela aqui.
#[tauri::command]
fn cancel_login_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("login-microsoft") {
        let _ = w.close();
    }
}

#[tauri::command]
async fn start_login_window(
    app: AppHandle,
    auth_url: String,
    redirect_uri: String,
) -> Result<(), String> {
    // Se já existir uma janela de login aberta, fecha antes de abrir outra
    if let Some(w) = app.get_webview_window("login-microsoft") {
        let _ = w.close();
    }

    let parsed_auth_url = auth_url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let app_handle = app.clone();

    WebviewWindowBuilder::new(&app, "login-microsoft", WebviewUrl::External(parsed_auth_url))
        .title("Fazer login com a Microsoft")
        .inner_size(600.0, 700.0)
        .on_navigation(move |url| {
            let url_str = url.as_str();

            if url_str.starts_with(&redirect_uri) {
                let mut code = None;
                let mut error = None;
                let mut error_description = None;

                for (key, value) in url.query_pairs() {
                    match key.as_ref() {
                        "code" => code = Some(value.to_string()),
                        "error" => error = Some(value.to_string()),
                        "error_description" => error_description = Some(value.to_string()),
                        _ => {}
                    }
                }

                let _ = app_handle.emit(
                    "oauth-callback",
                    OAuthCallbackPayload { code, error, error_description },
                );

                if let Some(w) = app_handle.get_webview_window("login-microsoft") {
                    let _ = w.close();
                }

                // false = cancela a navegação; o request nunca chega no servidor real
                return false;
            }

            // permite todas as outras navegações (tela de login, MFA, etc.)
            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenResponse {
    access_token: Option<String>,
    id_token: Option<String>,
    refresh_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[tauri::command]
async fn exchange_code_for_token(
    access_token_url: String,
    client_id: String,
    client_secret: String,
    code: String,
    redirect_uri: String,
    code_verifier: String,
    scope: String,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();

    let params = [
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("code_verifier", code_verifier.as_str()),
        ("scope", scope.as_str()),
    ];

    let response = client
        .post(&access_token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;

    serde_json::from_str::<TokenResponse>(&body).map_err(|e| {
        format!("Erro ao interpretar resposta ({}): {} — corpo: {}", status, e, body)
    })
}

#[tauri::command]
fn get_ssl_verification(state: tauri::State<SslVerifyState>) -> bool {
    state.0.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_ssl_verification(
    app: AppHandle,
    state: tauri::State<SslVerifyState>,
    value: bool,
) -> Result<(), String> {
    state.0.store(value, Ordering::Relaxed);

    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set("verify_ssl", serde_json::json!(value));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_request_timeout_ms(state: tauri::State<RequestTimeoutState>) -> u64 {
    state.0.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_request_timeout_ms(
    app: AppHandle,
    state: tauri::State<RequestTimeoutState>,
    value: u64,
) -> Result<(), String> {
    state.0.store(value, Ordering::Relaxed);

    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set("request_timeout_ms", serde_json::json!(value));
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn save_environments(
    app: AppHandle,
    environments: serde_json::Value,
) -> Result<(), String> {

    let store = app
        .store("environments.json")
        .map_err(|e| e.to_string())?;

    store.set(
        "environments",
        environments
    );

    store.save()
        .map_err(|e| e.to_string())?;

    Ok(())
}


#[tauri::command]
fn load_environments(
    app: AppHandle,
) -> Result<Option<serde_json::Value>, String> {

    let store = app
        .store("environments.json")
        .map_err(|e| e.to_string())?;

    Ok(
        store.get("environments")
    )
}

#[tauri::command]
fn store_get(
    app: AppHandle,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    let store = app
        .store("settings.json")
        .map_err(|e| e.to_string())?;

    Ok(store.get(&key))
}


#[tauri::command]
fn store_set(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {

    let store = app
        .store("settings.json")
        .map_err(|e| e.to_string())?;

    store.set(key, value);

    store
        .save()
        .map_err(|e| e.to_string())?;

    Ok(())
}


#[tauri::command]
fn store_delete(
    app: AppHandle,
    key: String,
) -> Result<(), String> {

    let store = app
        .store("settings.json")
        .map_err(|e| e.to_string())?;

    store.delete(key);

    store
        .save()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn save_local_store(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {

    let store = app
        .store("settings.json")
        .map_err(|e| e.to_string())?;

    store.set(key, value);

    store.save()
        .map_err(|e| e.to_string())?;

    Ok(())
}


#[tauri::command]
fn get_local_store(
    app: AppHandle,
    key: String,
) -> Result<Option<serde_json::Value>, String> {

    let store = app
        .store("settings.json")
        .map_err(|e| e.to_string())?;

    Ok(store.get(key))
}

// Apaga todas as chaves de settings.json que começam com `prefix` — usado
// pelo "Clear all history" das settings pra limpar o histórico de load test
// (chaves "load_test_history:<itemId>") sem precisar saber de antemão quais
// itemIds existem, já que get_local_store/save_local_store só operam numa
// chave conhecida por vez.
#[tauri::command]
fn clear_local_store_prefix(app: AppHandle, prefix: String) -> Result<(), String> {
    let store = app
        .store("settings.json")
        .map_err(|e| e.to_string())?;

    let keys_to_remove: Vec<String> = store
        .keys()
        .into_iter()
        .map(|k| k.to_string())
        .filter(|k| k.starts_with(&prefix))
        .collect();

    for key in keys_to_remove {
        store.delete(key);
    }

    store
        .save()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(SslVerifyState(AtomicBool::new(true)))
        .manage(RequestTimeoutState(AtomicU64::new(DEFAULT_REQUEST_TIMEOUT_MS)))
        .manage(LoadTestRegistry::default())
        .manage(GrpcStreams::default())
        .manage(CookieJarState::default())
        .manage(HttpCancelRegistry::default())
        .invoke_handler(tauri::generate_handler![
            make_http_request,
            cancel_http_request,
            clear_cookies,
            execute_script_backend,
            start_load_test,
            stop_load_test,
            open_browser_url,
            start_login_window,
            cancel_login_window,
            exchange_code_for_token,
            open_url,
            get_windows_username,
            save_secret,
            get_secret,
            delete_secret,
            get_windows_user_photo,
            get_ssl_verification,
            set_ssl_verification,
            get_request_timeout_ms,
            set_request_timeout_ms,
            save_environments,
            load_environments,
            store_get,
            store_set,
            store_delete,
            save_local_store,
            get_local_store,
            clear_local_store_prefix,
            start_mcp_server,
            stop_mcp_server,
            mcp_respond,
            claude_available,
            claude_send,
            claude_cancel,
            claude_auth_status,
            claude_auth_login,
            claude_auth_logout,
            list_extensions,
            extensions_folder,
            scaffold_extension,
            grpc_compile_protos,
            grpc_describe,
            grpc_invoke,
            grpc_reflect,
            grpc_stream_start,
            grpc_stream_send,
            grpc_stream_end,
            grpc_stream_cancel,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Carrega settings.json e sincroniza o estado em memória
            let store = app.store("settings.json")?;
            if let Some(val) = store.get("verify_ssl") {
                if let Some(b) = val.as_bool() {
                    let state = app.state::<SslVerifyState>();
                    state.0.store(b, Ordering::Relaxed);
                }
            }
            if let Some(val) = store.get("request_timeout_ms") {
                if let Some(n) = val.as_u64() {
                    let state = app.state::<RequestTimeoutState>();
                    state.0.store(n, Ordering::Relaxed);
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}




// #[tauri::command]
// async fn open_url(url: String) -> Result<(), String> {
//     #[cfg(target_os = "windows")]
//     {
// println!("rundll32 stdout: {}", "inicio");

//         let output = std::process::Command::new("rundll32")
//             .args(["url.dll,FileProtocolHandler", &url])
//             .output()
//             .map_err(|e| e.to_string())?;
        
//         println!("rundll32 stdout: {}", String::from_utf8_lossy(&output.stdout));
//         println!("rundll32 stderr: {}", String::from_utf8_lossy(&output.stderr));
//         println!("rundll32 status: {}", output.status);
//     }

//     Ok(())
// }


#[tauri::command]
async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
} 

/// Esquece todos os cookies guardados.
///
/// Troca o pote por um novo em vez de remover entrada por entrada: o `Jar` do
/// reqwest só sabe guardar e devolver, não expõe remoção. As requests
/// seguintes pegam o pote novo porque o cliente é construído na hora.
#[tauri::command]
fn clear_cookies(cookies: tauri::State<'_, CookieJarState>) -> Result<(), String> {
    let mut guard = cookies.0.lock().map_err(|e| e.to_string())?;
    *guard = std::sync::Arc::new(reqwest::cookie::Jar::default());
    Ok(())
}

#[tauri::command]
fn get_windows_username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "Usuário".to_string())
}

// ── Cancelamento de request ─────────────────────────────────────────────────
// Antes o "Cancel" da tela só destravava o botão: a request seguia até o fim
// e a resposta ainda era aplicada (script, histórico, variáveis). Agora cada
// envio da tela vem com um id; cancel_http_request dispara o sinal e o
// select! abaixo DESCARTA o future da request — o reqwest fecha a conexão.
// (O que já chegou ao servidor não tem como ser desfeito; nenhum cliente
// consegue isso.)

const REQUEST_CANCELLED: &str = "Request cancelled by user";

#[derive(Default)]
struct HttpCancelRegistry(Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>);

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn make_http_request(
    state: tauri::State<'_, SslVerifyState>,
    timeout_state: tauri::State<'_, RequestTimeoutState>,
    cookies: tauri::State<'_, CookieJarState>,
    cancels: tauri::State<'_, HttpCancelRegistry>,
    method: String,
    url: String,
    body: Option<String>,
    headers_input: Option<HashMap<String, String>>,
    // Opcional: só quem pode cancelar manda (o envio da tela). Runner, MCP e
    // chamadas internas continuam iguais.
    request_id: Option<String>,
) -> Result<HttpResponse, String> {
    let Some(request_id) = request_id else {
        return perform_http_request(state, timeout_state, cookies, method, url, body, headers_input).await;
    };

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    cancels
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(request_id.clone(), cancel_tx);

    let result = tokio::select! {
        result = perform_http_request(state, timeout_state, cookies, method, url, body, headers_input) => result,
        // Só um envio de verdade conta: se o sender sumir sem enviar, o
        // branch fica desabilitado e a request segue normal.
        Ok(()) = cancel_rx => Err(REQUEST_CANCELLED.to_string()),
    };

    if let Ok(mut registry) = cancels.0.lock() {
        registry.remove(&request_id);
    }
    result
}

/// Interrompe um make_http_request em andamento (botão Cancel da tela).
#[tauri::command]
fn cancel_http_request(cancels: tauri::State<'_, HttpCancelRegistry>, request_id: String) -> Result<bool, String> {
    let sender = cancels.0.lock().map_err(|e| e.to_string())?.remove(&request_id);
    Ok(match sender {
        Some(tx) => tx.send(()).is_ok(),
        // Já terminou (ou nunca existiu): nada a cancelar.
        None => false,
    })
}

async fn perform_http_request(
    state: tauri::State<'_, SslVerifyState>,
    timeout_state: tauri::State<'_, RequestTimeoutState>,
    cookies: tauri::State<'_, CookieJarState>,
    method: String,
    url: String,
    body: Option<String>,
    headers_input: Option<HashMap<String, String>>,
) -> Result<HttpResponse, String> {
    let start_time = Instant::now();

    let verify_ssl = state.0.load(Ordering::Relaxed);
    // 0 = sem timeout (configurável em Settings > Network) — mantém o
    // comportamento antigo de esperar indefinidamente se o usuário zerar.
    let timeout_ms = timeout_state.0.load(Ordering::Relaxed);

    // Clona só o Arc: o pote em si é o mesmo entre as requests, que é o
    // ponto. O lock é solto antes do await — guard de Mutex não é Send.
    let jar = {
        let guard = cookies.0.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let mut client_builder = reqwest::Client::builder()
        .danger_accept_invalid_certs(!verify_ssl)
        .cookie_provider(jar);
    if timeout_ms > 0 {
        client_builder = client_builder.timeout(Duration::from_millis(timeout_ms));
    }
    let client = client_builder.build().map_err(|e| e.to_string())?;

    let reqwest_method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| {
            let err = format!("❌ [HTTP] Método inválido '{}': {}", method, e);
            eprintln!("{}", err);
            "Método HTTP inválido".to_string()
        })?;

    let mut request_builder = client.request(reqwest_method, &url);

    if let Some(h_map) = headers_input {
        let mut headers = HeaderMap::new();
        for (k, v) in h_map {
            if k.eq_ignore_ascii_case("accept-encoding") {
                continue;
            }
            let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| {
                let err = format!("❌ [HTTP] Nome de header inválido: {} ({})", k, e);
                eprintln!("{}", err);
                err
            })?;
            let val = HeaderValue::from_str(&v).map_err(|e| {
                let err = format!("❌ [HTTP] Valor de header inválido para {}: {} ({})", k, v, e);
                eprintln!("{}", err);
                err
            })?;
            headers.insert(name, val);
        }
        request_builder = request_builder.headers(headers);
    }

    if let Some(b) = body {
        println!("   📦 Body enviado: {} bytes", b.len());
        request_builder = request_builder.body(b);
    } else {
        let m = method.to_uppercase();
        if m == "POST" || m == "PUT" || m == "DELETE" || m == "PATCH" {
            println!("   ⚠️ [HTTP] Injetando Content-Length: 0 (Necessário para métodos de escrita sem body)");
            request_builder = request_builder.header(reqwest::header::CONTENT_LENGTH, 0);
        }
    }

    let response = request_builder.send().await.map_err(|e| {
        // Timeout tem uma mensagem PRÓPRIA, curta e no início da string — o
        // painel de erro na UI mostra só a 1ª linha truncada, então o motivo
        // "genérico" com debug/causa detalhados (que continua sendo logado
        // no console via eprintln, pra debug) ficaria cortado antes de
        // explicar o que aconteceu.
        if e.is_timeout() {
            let err = format!(
                "Request timed out after {}ms (configured in Settings > Network) — {} {}",
                timeout_ms, method, url
            );
            eprintln!("⏱️ [HTTP] {}", err);
            return err;
        }

        let mut err = format!(
            "❌ [HTTP] Falha ao enviar requisição {} {} (após {:?})\n   Debug: {:?}",
            method, url, start_time.elapsed(), e
        );

        if e.is_connect() {
            err.push_str("\n   Tipo: erro de CONEXÃO (DNS/TCP/TLS)");
        }

        let mut source = std::error::Error::source(&e);
        while let Some(s) = source {
            err.push_str(&format!("\n   Causa: {}", s));
            source = s.source();
        }

        eprintln!("{}", err);
        err
    })?;

    let status = response.status().as_u16();

    let mut response_headers = HashMap::new();
    for (name, value) in response.headers().iter() {
        response_headers.insert(
            name.to_string(),
            value.to_str().unwrap_or("").to_string(),
        );
    }

    let content_type = response_headers
        .get("content-type")
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let binary = is_binary_content_type(&content_type);

    let body_string = if binary {
        let bytes = response.bytes().await.map_err(|e| {
            let err = format!(
                "❌ [HTTP] Falha ao ler bytes da resposta ({} {}): {}",
                method, url, e
            );
            eprintln!("{}", err);
            err
        })?;
        general_purpose::STANDARD.encode(&bytes)
    } else {
        response.text().await.map_err(|e| {
            let err = format!(
                "❌ [HTTP] Falha ao ler texto da resposta ({} {}): {}",
                method, url, e
            );
            eprintln!("{}", err);
            err
        })?
    };

    println!(
        "Request to {} finished. Status: {} (Took {:?})",
        url,
        status,
        start_time.elapsed()
    );

    Ok(HttpResponse {
        status,
        body: body_string,
        headers: response_headers,
        is_binary: binary,
    })
}


// use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
// use rquickjs::{prelude::Func, Context, Runtime};
// use serde::{Deserialize, Serialize};
// use std::{
//     collections::HashMap,
//     sync::{Arc, Mutex},
//     time::Instant,
// };
// //use tauri::Emitter;
// //use tokio::net::TcpListener;
// //use tokio::io::{AsyncReadExt, AsyncWriteExt};
// use base64::{engine::general_purpose, Engine as _};

// mod secure_storage;
// use secure_storage::{save_secret, get_secret, delete_secret};

// mod user_photo;
// use user_photo::get_windows_user_photo;

// const MOMENT_JS: &str = include_str!("../../src/utils/moment.min.js");

// #[tauri::command]
// fn open_browser_url(url: String) -> Result<(), String> {
//     open::that(url).map_err(|e| e.to_string())
// }

// fn is_binary_content_type(ct: &str) -> bool {
//     let binary_types = [
//         "application/zip",
//         "application/x-zip",
//         "application/octet-stream",
//         "application/pdf",
//         "application/vnd.",      
//         "image/",
//         "audio/",
//         "video/",
//     ];
//     binary_types.iter().any(|t| ct.contains(t))
// }

// #[derive(Debug, Serialize, Deserialize, Clone)]
// #[serde(rename_all = "camelCase")]
// pub struct ScriptContext {
//     pub env: HashMap<String, String>,
//     pub response_body: Option<String>,
//     pub response: Option<serde_json::Value>,
// }


// #[derive(Debug, Serialize, Deserialize)]
// pub struct HttpResponse {
//     status: u16,
//     body: String,
//     headers: HashMap<String, String>,
//     is_binary: bool,  // ← novo campo
// }

// #[tauri::command]
// fn execute_script_backend(
//     window: tauri::Window,
//     script: String,
//     context: ScriptContext,
// ) -> Result<ScriptContext, String> {

//     const MAX_JSON_SIZE: usize = 5 * 1024 * 1024;

//     let raw_body = context
//         .response_body
//         .clone()
//         .unwrap_or_else(|| "{}".to_string());

//     if raw_body.len() > MAX_JSON_SIZE {
//         return Err(format!("JSON muito grande: {} bytes", raw_body.len()));
//     }

//     let shared_env = Arc::new(Mutex::new(context.env.clone()));
//     let runtime = Runtime::new().map_err(|e| e.to_string())?;

//     runtime.set_memory_limit(64 * 1024 * 1024);
//     runtime.set_max_stack_size(1024 * 1024);

//     let ctx = Context::full(&runtime).map_err(|e| e.to_string())?;

//     ctx.with(|ctx| {
//         let globals = ctx.globals();

//     // 1. Injeta o código do moment globalmente
//     ctx.eval::<(), _>(MOMENT_JS)
//         .map_err(|e| format!("Erro ao carregar Moment: {}", e))?;

//     // 2. Define o require falso para o usuário poder usar require('moment')
//     let bootstrap = r#"
//         globalThis.require = (name) => {
//             if (name === 'moment') return globalThis.moment;
//             throw new Error('Modulo nao encontrado: ' + name);
//         };
//     "#;
//     ctx.eval::<(), _>(bootstrap).map_err(|e| e.to_string())?;

//         let window_for_log = window.clone();
//         let console_log = Func::from(move |message: String| {
//             let _ = window_for_log.emit("script-log", message);
//         });

//         globals
//             .set("__console_log", console_log)
//             .map_err(|e| e.to_string())?;

//         let env_get = Arc::clone(&shared_env);

//         let get_fn = Func::from(move |key: String| -> Option<String> {
//             env_get.lock().ok().and_then(|env| env.get(&key).cloned())
//         });

//         globals
//             .set("__env_get", get_fn)
//             .map_err(|e| e.to_string())?;


    
//         let env_set = Arc::clone(&shared_env);

//         let set_fn = Func::from(move |key: String, value: String| {
//             if let Ok(mut env) = env_set.lock() {
//                 env.insert(key, value);
//             }
//         });

//         globals
//             .set("__env_set", set_fn)
//             .map_err(|e| e.to_string())?;

//         globals
//             .set("__response_body", raw_body.clone())
//             .map_err(|e| e.to_string())?;

//         let env_unset = Arc::clone(&shared_env);

//         let unset_fn = Func::from(move |key: String| {
//             if let Ok(mut env) = env_unset.lock() {
//                 env.remove(&key);
//             }
//         });

//         globals
//             .set("__env_unset", unset_fn)
//             .map_err(|e| e.to_string())?;

//         let bootstrap = r#"

//         globalThis.console = {

//             log(...args) {

//                 const parts = args.map(v => {

//                     if (
//                         typeof v === "object"
//                     ) {

//                         try {
//                             return JSON.stringify(
//                                 v,
//                                 null,
//                                 2
//                             );
//                         }
//                         catch {

//                             return "[Object]";
//                         }
//                     }

//                     return String(v);
//                 });

//                 __console_log(
//                     parts.join(" ")
//                 );
//             }
//         };

//         globalThis.pm = {

//             environment: {
//                 get(key) { return __env_get(key); },
//                 set(key, value) { __env_set(key, String(value)); },
//                 has(key) { return __env_get(key) !== undefined && __env_get(key) !== null; },
//                 unset(key) { __env_unset(key); }
//             },

//             variables: {
//                 get(key) { return __env_get(key); },
//                 set(key, value) { __env_set(key, String(value)); },
//                 has(key) { return __env_get(key) !== undefined && __env_get(key) !== null; },
//                 unset(key) { __env_unset(key); }
//             },

//             globals: {
//                 get(key) { return __env_get(key); },
//                 set(key, value) { __env_set(key, String(value)); },
//                 has(key) { return __env_get(key) !== undefined && __env_get(key) !== null; },
//                 unset(key) { __env_unset(key); }
//             },

//             collectionVariables: {
//                 get(key) { return __env_get(key); },
//                 set(key, value) { __env_set(key, String(value)); },
//                 has(key) { return __env_get(key) !== undefined && __env_get(key) !== null; },
//                 unset(key) { __env_unset(key); }
//             },

//             response: {
//                 text() { return __response_body; },
//                 json() { return JSON.parse(__response_body); }
//             },

//             request: {
//                 headers: { get() { return undefined; } },
//                 url: { toString() { return ""; } }
//             }
//         };

//         "#;

//         ctx.eval::<(), _>(bootstrap).map_err(|e| e.to_string())?;

//     ctx.eval::<(), _>(
//         script.as_str()
//     )
//     .map_err(|e| {
//         let mut detailed_error = String::new();

//         if let rquickjs::Error::Exception = e {
//             let caught = ctx.catch();
            
//             if let Some(exception) = caught.as_exception() {
//                 // Em versões estáveis do rquickjs, Exception implementa Display.
//                 // O método .stack() contém a stack trace completa (incluindo linha e arquivo).
//                 let message = exception.message().unwrap_or_else(|| "Unknown Error".to_string());
//                 let stack = exception.stack().unwrap_or_else(|| "No stack trace available".to_string());

//                 detailed_error = format!(
//                     "❌ JS Error: {}\n📜 Stack Trace:\n{}",
//                     message, stack
//                 );
//             } else {
//                 detailed_error = format!("❌ JS Threw: {:?}", caught);
//             }
//         } else {
//             detailed_error = format!("❌ JS Error: {}", e);
//         }

//         // Emite o log para o frontend
//         let _ = window.emit("script-log", detailed_error.clone());
//         detailed_error
//     })?;
//         Ok::<(), String>(())
//     })?;

//     let final_env = shared_env.lock().unwrap().clone();

//     Ok(ScriptContext {
//         env: final_env,
//         response_body: context.response_body,
//         response: context.response,
//     })
// }

// use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder, WebviewUrl};

// #[derive(Clone, serde::Serialize)]
// struct OAuthCallbackPayload {
//     code: Option<String>,
//     error: Option<String>,
//     error_description: Option<String>,
// }

// #[tauri::command]
// async fn start_login_window(
//     app: AppHandle,
//     auth_url: String,
//     redirect_uri: String,
// ) -> Result<(), String> {
//     // Se já existir uma janela de login aberta, fecha antes de abrir outra
//     if let Some(w) = app.get_webview_window("login-microsoft") {
//         let _ = w.close();
//     }

//     let parsed_auth_url = auth_url.parse().map_err(|e: url::ParseError| e.to_string())?;
//     let app_handle = app.clone();

//     WebviewWindowBuilder::new(&app, "login-microsoft", WebviewUrl::External(parsed_auth_url))
//         .title("Fazer login com a Microsoft")
//         .inner_size(600.0, 700.0)
//         .on_navigation(move |url| {
//             let url_str = url.as_str();

//             if url_str.starts_with(&redirect_uri) {
//                 let mut code = None;
//                 let mut error = None;
//                 let mut error_description = None;

//                 for (key, value) in url.query_pairs() {
//                     match key.as_ref() {
//                         "code" => code = Some(value.to_string()),
//                         "error" => error = Some(value.to_string()),
//                         "error_description" => error_description = Some(value.to_string()),
//                         _ => {}
//                     }
//                 }

//                 let _ = app_handle.emit(
//                     "oauth-callback",
//                     OAuthCallbackPayload { code, error, error_description },
//                 );

//                 if let Some(w) = app_handle.get_webview_window("login-microsoft") {
//                     let _ = w.close();
//                 }

//                 // false = cancela a navegação; o request nunca chega no servidor real
//                 return false;
//             }

//             // permite todas as outras navegações (tela de login, MFA, etc.)
//             true
//         })
//         .build()
//         .map_err(|e| e.to_string())?;

//     Ok(())
// }

// #[derive(Debug, Serialize, Deserialize)]
// pub struct TokenResponse {
//     access_token: Option<String>,
//     id_token: Option<String>,
//     refresh_token: Option<String>,
//     token_type: Option<String>,
//     expires_in: Option<u64>,
//     error: Option<String>,
//     error_description: Option<String>,
// }

// #[tauri::command]
// async fn exchange_code_for_token(
//     access_token_url: String,
//     client_id: String,
//     client_secret: String,
//     code: String,
//     redirect_uri: String,
//     code_verifier: String,
//     scope: String,
// ) -> Result<TokenResponse, String> {
//     let client = reqwest::Client::new();

//     let params = [
//         ("client_id", client_id.as_str()),
//         ("client_secret", client_secret.as_str()),
//         ("grant_type", "authorization_code"),
//         ("code", code.as_str()),
//         ("redirect_uri", redirect_uri.as_str()),
//         ("code_verifier", code_verifier.as_str()),
//         ("scope", scope.as_str()),
//     ];

//     let response = client
//         .post(&access_token_url)
//         .form(&params)
//         .send()
//         .await
//         .map_err(|e| e.to_string())?;

//     let status = response.status();
//     let body = response.text().await.map_err(|e| e.to_string())?;

//     serde_json::from_str::<TokenResponse>(&body).map_err(|e| {
//         format!("Erro ao interpretar resposta ({}): {} — corpo: {}", status, e, body)
//     })
// }

// #[cfg_attr(mobile, tauri::mobile_entry_point)]
// pub fn run() {
//     tauri::Builder::default()
//         .plugin(tauri_plugin_opener::init())
//         .plugin(tauri_plugin_dialog::init())
//         .plugin(tauri_plugin_fs::init())
//         .plugin(tauri_plugin_oauth::init())
//         .plugin(tauri_plugin_http::init())
        
//         .invoke_handler(tauri::generate_handler![
//             make_http_request,
//             execute_script_backend,
//             open_browser_url,
//             start_login_window,
//             exchange_code_for_token,
//             open_url,
//             get_windows_username,
//             save_secret,
//             get_secret,
//             delete_secret,
//             get_windows_user_photo,
//         ])
//         .setup(|app| {
//             #[cfg(debug_assertions)]
//             {
//                 app.handle().plugin(
//                     tauri_plugin_log::Builder::default()
//                         .level(log::LevelFilter::Info)
//                         .build(),
//                 )?;
//             }

//             Ok(())
//         })
//         .run(tauri::generate_context!())
//         .expect("error while running tauri application");
// }


// #[tauri::command]
// async fn open_url(url: String) -> Result<(), String> {
//     #[cfg(target_os = "windows")]
//     {
// println!("rundll32 stdout: {}", "inicio");

//         let output = std::process::Command::new("rundll32")
//             .args(["url.dll,FileProtocolHandler", &url])
//             .output()
//             .map_err(|e| e.to_string())?;
        
//         println!("rundll32 stdout: {}", String::from_utf8_lossy(&output.stdout));
//         println!("rundll32 stderr: {}", String::from_utf8_lossy(&output.stderr));
//         println!("rundll32 status: {}", output.status);
//     }

//     Ok(())
// }

// // #[tauri::command]
// // async fn start_oauth_server(app: tauri::AppHandle) -> Result<u16, String> {
// //     let listener = TcpListener::bind("127.0.0.1:0")
// //         .await
// //         .map_err(|e| e.to_string())?;

// //     let port = listener.local_addr()
// //         .map_err(|e| e.to_string())?
// //         .port();

// //     let app_handle = app.clone();

// //     tauri::async_runtime::spawn(async move {
// //         if let Ok((mut stream, _)) = listener.accept().await {
// //             let mut buffer = vec![0u8; 8192];
// //             let n = stream.read(&mut buffer).await.unwrap_or(0);
// //             let request = String::from_utf8_lossy(&buffer[..n]).to_string();

// //             // Pega o path da requisição: "GET /?code=ABC&... HTTP/1.1"
// //             let path = request
// //                 .lines()
// //                 .next()
// //                 .and_then(|l| l.split_whitespace().nth(1))
// //                 .unwrap_or("/")
// //                 .to_string();

// //             let html = "<html><body><h2>Autenticado!</h2><p>Pode fechar esta aba.</p></body></html>";
// //             let response = format!(
// //                 "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
// //                 html.len(), html
// //             );
// //             let _ = stream.write_all(response.as_bytes()).await;

// //             let _ = app_handle.emit("oauth-callback", path);
// //         }
// //     });

// //     Ok(port)
// // }

// #[tauri::command]
// fn get_windows_username() -> String {
//     std::env::var("USERNAME")
//         .or_else(|_| std::env::var("USER"))
//         .unwrap_or_else(|_| "Usuário".to_string())
// }

// #[tauri::command]
// async fn make_http_request(
//     method: String,
//     url: String,
//     body: Option<String>,
//     headers_input: Option<HashMap<String, String>>,
// ) -> Result<HttpResponse, String> {
//     let start_time = Instant::now();
//     let client = reqwest::Client::new();

//     let reqwest_method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
//         .map_err(|e| {
//             let err = format!("❌ [HTTP] Método inválido '{}': {}", method, e);
//             eprintln!("{}", err);
//             "Método HTTP inválido".to_string()
//         })?;

//     let mut request_builder = client.request(reqwest_method, &url);

//     if let Some(h_map) = headers_input {
//         let mut headers = HeaderMap::new();
//         for (k, v) in h_map {
//             if k.eq_ignore_ascii_case("accept-encoding") {
//                 continue;
//             }
//             let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| {
//                 let err = format!("❌ [HTTP] Nome de header inválido: {} ({})", k, e);
//                 eprintln!("{}", err);
//                 err
//             })?;
//             let val = HeaderValue::from_str(&v).map_err(|e| {
//                 let err = format!("❌ [HTTP] Valor de header inválido para {}: {} ({})", k, v, e);
//                 eprintln!("{}", err);
//                 err
//             })?;
//             headers.insert(name, val);
//         }
//         request_builder = request_builder.headers(headers);
//     }

//     if let Some(b) = body {
//         println!("   📦 Body enviado: {} bytes", b.len());
//         request_builder = request_builder.body(b);
//     } else {
//         let m = method.to_uppercase();
//         if m == "POST" || m == "PUT" || m == "DELETE" || m == "PATCH" {
//             println!("   ⚠️ [HTTP] Injetando Content-Length: 0 (Necessário para métodos de escrita sem body)");
//             request_builder = request_builder.header(reqwest::header::CONTENT_LENGTH, 0);
//         }
//     }

//     let response = request_builder.send().await.map_err(|e| {
//         let mut err = format!(
//             "❌ [HTTP] Falha ao enviar requisição {} {} (após {:?})\n   Debug: {:?}",
//             method, url, start_time.elapsed(), e
//         );

//         if e.is_connect() {
//             err.push_str("\n   Tipo: erro de CONEXÃO (DNS/TCP/TLS)");
//         }
//         if e.is_timeout() {
//             err.push_str("\n   Tipo: TIMEOUT");
//         }

//         let mut source = std::error::Error::source(&e);
//         while let Some(s) = source {
//             err.push_str(&format!("\n   Causa: {}", s));
//             source = s.source();
//         }

//         eprintln!("{}", err);
//         err
//     })?;

//     let status = response.status().as_u16();

//     let mut response_headers = HashMap::new();
//     for (name, value) in response.headers().iter() {
//         response_headers.insert(
//             name.to_string(),
//             value.to_str().unwrap_or("").to_string(),
//         );
//     }

//     let content_type = response_headers
//         .get("content-type")
//         .map(|s| s.to_lowercase())
//         .unwrap_or_default();

//     let binary = is_binary_content_type(&content_type);

//     let body_string = if binary {
//         let bytes = response.bytes().await.map_err(|e| {
//             let err = format!(
//                 "❌ [HTTP] Falha ao ler bytes da resposta ({} {}): {}",
//                 method, url, e
//             );
//             eprintln!("{}", err);
//             err
//         })?;
//         general_purpose::STANDARD.encode(&bytes)
//     } else {
//         response.text().await.map_err(|e| {
//             let err = format!(
//                 "❌ [HTTP] Falha ao ler texto da resposta ({} {}): {}",
//                 method, url, e
//             );
//             eprintln!("{}", err);
//             err
//         })?
//     };

//     println!(
//         "Request to {} finished. Status: {} (Took {:?})",
//         url,
//         status,
//         start_time.elapsed()
//     );

//     Ok(HttpResponse {
//         status,
//         body: body_string,
//         headers: response_headers,
//         is_binary: binary,
//     })
// }