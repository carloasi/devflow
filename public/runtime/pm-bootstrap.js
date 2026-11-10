// ─────────────────────────────────────────────────────────────────────────
// Runtime da API pm.* dos scripts de Pre-request / Post-response.
//
// FONTE ÚNICA, usada em dois lugares:
//   • DevFlow — src-tauri/src/lib.rs (execute_script_backend) embute este
//     arquivo com include_str! e roda no QuickJS;
//   • HTML exportado de um flow (src/lib/flowHtml) — roda num Web Worker.
//
// Depende de funções nativas que cada lado fornece ANTES de avaliar este
// arquivo: __console_log, __env_get/__env_set/__env_unset, __req_get_*/
// __req_set_*, __headers_get/has/set/remove, __req_get_headers_json,
// __response_body, __response_status_code, __response_time,
// __response_headers_json, __response_header_get e __test_record.
//
// Mexer aqui muda o comportamento dos scripts NOS DOIS lugares — e os tipos
// do editor (src/lib/pmApiTypes.ts) precisam acompanhar.
// ─────────────────────────────────────────────────────────────────────────

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
                // Igual ao RequestBody.update do Postman: string vira
                // o raw; objeto usa o .raw. É o jeito que funciona
                // nos dois apps (o export reescreve pra isso).
                update(v) {
                    if (v && typeof v === "object") {
                        if ("raw" in v) __req_set_body(String(v.raw));
                    } else {
                        __req_set_body(String(v ?? ""));
                    }
                },
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
