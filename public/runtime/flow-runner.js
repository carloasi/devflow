// ─────────────────────────────────────────────────────────────────────────
// Runtime do HTML exportado de um flow (src/lib/flowHtml).
//
// Roda os passos do flow no navegador do jeito que o Runner do DevFlow roda
// (src/components/CollectionRunner/runCollectionRequest.ts):
//
//   variáveis → pre-request → envio → post-response/testes → próximo passo,
//   com o environment passando de um passo pro outro.
//
// Os scripts rodam num Web Worker com o MESMO runtime do pm.* do DevFlow
// (public/runtime/pm-bootstrap.js) — o worker só fornece as funções nativas
// que no DevFlow vêm do Rust.
//
// Arquivo sem dependências e sem build: é embutido inteiro no HTML. Por isso
// nada de "</script" literal em lugar nenhum aqui dentro.
// ─────────────────────────────────────────────────────────────────────────
(function (root) {
  'use strict';

  // ── Núcleo (sem DOM) ─────────────────────────────────────────────────

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null;
  }

  /** Igual ao replaceWithEnv do Runner: variável sem valor fica como {{nome}}. */
  function substitute(text, env) {
    if (!text) return '';
    return String(text).replace(/\{\{(.*?)\}\}/g, function (_, raw) {
      var key = String(raw).trim();
      return has(env, key) ? String(env[key]) : '{{' + key + '}}';
    });
  }

  /** URL, headers e body do passo com as variáveis de `env`. */
  function buildParts(step, env) {
    var headers = {};
    Object.keys(step.headers || {}).forEach(function (key) {
      headers[substitute(key, env)] = substitute(step.headers[key], env);
    });
    return { url: substitute(step.url, env), headers: headers, body: step.body ? substitute(step.body, env) : '' };
  }

  function sameHeaders(a, b) {
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    return ka.length === kb.length && ka.every(function (k) { return b[k] === a[k]; });
  }

  /**
   * Port de src/lib/preRequestResolution.ts: depois do pre-request, a parte
   * que o script NÃO mexeu é refeita dos templates com o env novo; a que ele
   * mexeu fica como ele deixou, só com os {{...}} que sobraram resolvidos.
   */
  function resolveAfterPreRequest(before, after, rebuild, env) {
    var rebuilt = null;
    function fresh() {
      if (!rebuilt) {
        try { rebuilt = rebuild(env); } catch (e) { rebuilt = before; }
      }
      return rebuilt;
    }
    var url = after && after.url && after.url !== before.url ? substitute(after.url, env) : fresh().url;
    var headers;
    if (after && after.headers && !sameHeaders(after.headers, before.headers)) {
      headers = {};
      Object.keys(after.headers).forEach(function (k) {
        headers[substitute(k, env)] = substitute(String(after.headers[k] == null ? '' : after.headers[k]), env);
      });
    } else {
      headers = fresh().headers;
    }
    var body = after && after.body !== undefined && after.body !== before.body ? substitute(after.body, env) : fresh().body;
    return { url: url, headers: headers, body: body };
  }

  /** Variáveis que ficaram sem valor ({{nome}} ainda no texto). */
  function unresolvedIn(parts) {
    var names = {};
    var scan = function (text) {
      String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (_, n) { names[n] = true; return ''; });
    };
    scan(parts.url);
    scan(parts.body);
    Object.keys(parts.headers).forEach(function (k) { scan(k); scan(parts.headers[k]); });
    return Object.keys(names);
  }

  // Headers que o navegador não deixa um script definir — o fetch os ignora
  // em silêncio. Saem do envio e aparecem como "não enviados", pra a tela não
  // mostrar algo que não foi pra rede.
  var FORBIDDEN_HEADERS = ['accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie', 'date', 'dnt', 'expect',
    'host', 'keep-alive', 'origin', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'user-agent', 'via'];

  function splitForbidden(headers) {
    var allowed = {};
    var dropped = [];
    Object.keys(headers).forEach(function (k) {
      var lower = k.toLowerCase();
      if (FORBIDDEN_HEADERS.indexOf(lower) !== -1 || lower.indexOf('proxy-') === 0 || lower.indexOf('sec-') === 0) dropped.push(k);
      else allowed[k] = headers[k];
    });
    return { allowed: allowed, dropped: dropped };
  }

  /** Variáveis do template da URL que estão vazias ou sem valor no env. */
  function emptyUrlVariables(template, env) {
    var out = [];
    String(template || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (_, name) {
      if (!has(env, name) || String(env[name]) === '') out.push(name);
      return '';
    });
    return out;
  }

  /**
   * "devflow-relay://127.0.0.1:47821/<chave>" (Settings → Network do DevFlow)
   * → { base, key }. null se o texto não for um código de conexão.
   */
  function parseConnectionCode(code) {
    var m = String(code || '').trim().match(/^devflow-relay:\/\/((?:127\.0\.0\.1|localhost):\d{1,5})\/([0-9a-f]{32,})$/i);
    return m ? { base: 'http://' + m[1], key: m[2] } : null;
  }

  /**
   * Envia pelo relay do DevFlow (src-tauri/src/relay_server.rs): a requisição
   * sai do DevFlow, com o cliente HTTP dele — sem bloqueio de certificado
   * interno nem de CORS. Lança Error com a mensagem pra tela.
   */
  async function sendViaRelay(relay, method, parts, hasBody) {
    var res;
    try {
      res = await fetch(relay.base + '/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DevFlow-Relay-Key': relay.key },
        body: JSON.stringify({ method: method, url: parts.url, headers: parts.headers, body: hasBody ? parts.body : null }),
      });
    } catch (err) {
      throw new Error('Could not reach DevFlow at ' + relay.base + '. Open DevFlow on this computer and turn on ' +
        'Settings → Network → "HTML runner relay".');
    }
    var payload = {};
    try { payload = await res.json(); } catch (e) { payload = {}; }
    if (res.status === 401) {
      throw new Error('DevFlow refused the connection code. Copy it again from Settings → Network → "HTML runner relay" and paste it in "Send via".');
    }
    if (!res.ok) throw new Error('DevFlow could not send the request: ' + (payload.error || ('HTTP ' + res.status)));
    return { status: payload.status, headers: payload.headers || {}, body: payload.body || '', time: payload.timeMs };
  }

  function shellQuote(text) {
    return "'" + String(text).replace(/'/g, "'\\''") + "'";
  }

  function toCurl(method, parts) {
    var lines = ['curl --request ' + method + ' ' + shellQuote(parts.url)];
    Object.keys(parts.headers).forEach(function (k) { lines.push('  --header ' + shellQuote(k + ': ' + parts.headers[k])); });
    if (parts.body) lines.push('  --data-raw ' + shellQuote(parts.body));
    return lines.join(' \\\n');
  }

  // ── Worker dos scripts ───────────────────────────────────────────────
  // Vira o código do Worker por toString(): tudo que ele usa tem que estar
  // aqui dentro. Fornece as funções nativas que o pm-bootstrap.js espera —
  // as mesmas que o lado Rust (execute_script_backend) define.
  function workerMain() {
    self.onmessage = function (event) {
      var data = event.data;
      var ctx = data.ctx;
      var env = {};
      Object.keys(ctx.env || {}).forEach(function (k) { env[k] = String(ctx.env[k]); });
      var req = {
        method: ctx.request.method,
        url: ctx.request.url,
        body: ctx.request.body || '',
        headers: Object.assign({}, ctx.request.headers || {}),
      };
      var logs = [];
      var tests = [];
      var setOps = [];
      var responseHeaders = {};
      var rawHeaders = (ctx.response && ctx.response.headers) || {};
      Object.keys(rawHeaders).forEach(function (k) { responseHeaders[k.toLowerCase()] = String(rawHeaders[k]); });

      self.__console_log = function (level, message) { logs.push({ level: level, message: message }); };
      self.__env_get = function (key) { return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined; };
      self.__env_set = function (key, value) {
        env[key] = value;
        setOps.push({ key: key, value: value, removed: false });
      };
      self.__env_unset = function (key) {
        var previous = Object.prototype.hasOwnProperty.call(env, key) ? env[key] : '';
        delete env[key];
        setOps.push({ key: key, value: previous, removed: true });
      };
      self.__req_get_method = function () { return req.method; };
      self.__req_set_method = function (v) { req.method = v; };
      self.__req_get_url = function () { return req.url; };
      self.__req_set_url = function (v) { req.url = v; };
      self.__req_get_body = function () { return req.body; };
      self.__req_set_body = function (v) { req.body = v; };
      self.__headers_get = function (key) { return Object.prototype.hasOwnProperty.call(req.headers, key) ? req.headers[key] : undefined; };
      self.__headers_has = function (key) { return Object.prototype.hasOwnProperty.call(req.headers, key); };
      self.__headers_set = function (key, value) { req.headers[key] = value; };
      self.__headers_remove = function (key) { delete req.headers[key]; };
      self.__req_get_headers_json = function () { return JSON.stringify(req.headers); };
      self.__response_body = ctx.responseBody == null ? '{}' : ctx.responseBody;
      self.__response_status_code = ctx.response ? ctx.response.status : 0;
      self.__response_time = ctx.responseTime || 0;
      self.__response_headers_json = JSON.stringify(responseHeaders);
      self.__response_header_get = function (key) { return responseHeaders[String(key).toLowerCase()]; };
      self.__test_record = function (name, passed, message) { tests.push({ name: name, passed: passed, message: message }); };

      var scriptError = null;
      var globalEval = eval;
      try {
        if (data.moment) globalEval(data.moment);
        self.require = function (name) {
          if (name === 'moment' && self.moment) return self.moment;
          throw new Error('Modulo nao encontrado: ' + name);
        };
        globalEval(data.bootstrap);
      } catch (err) {
        scriptError = 'The script runtime failed to load: ' + (err && err.message ? err.message : String(err));
      }
      if (!scriptError) {
        try {
          globalEval(data.script);
        } catch (err) {
          var name = err && err.name ? err.name : 'Error';
          var message = err && err.message !== undefined ? err.message : String(err);
          scriptError = name + ': ' + message;
        }
        // Mesmo harvest do Rust: tests["nome"] = condição (API antiga).
        try {
          if (typeof self.tests === 'object' && self.tests !== null) {
            Object.keys(self.tests).forEach(function (k) { self.__test_record(k, !!self.tests[k], ''); });
          }
        } catch (e) { /* ignora */ }
      }
      self.postMessage({ env: env, request: req, tests: tests, logs: logs, setVariables: setOps, scriptError: scriptError });
    };
  }

  var SCRIPT_TIMEOUT_MS = 10000;

  function runScript(assets, script, ctx) {
    return new Promise(function (resolve) {
      var fallback = function (message) {
        return { env: ctx.env, request: ctx.request, tests: [], logs: [], setVariables: [], scriptError: message };
      };
      var url;
      var worker;
      try {
        url = URL.createObjectURL(new Blob(['(' + workerMain.toString() + ')()'], { type: 'text/javascript' }));
        worker = new Worker(url);
      } catch (e) {
        resolve(fallback('This browser blocked the script sandbox (Web Worker): ' + (e && e.message ? e.message : e)));
        return;
      }
      var done = function (result) {
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      var timer = setTimeout(function () {
        done(fallback('Script stopped after ' + SCRIPT_TIMEOUT_MS / 1000 + 's (infinite loop?).'));
      }, SCRIPT_TIMEOUT_MS);
      worker.onmessage = function (e) { done(e.data); };
      worker.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        done(fallback('Script runtime error: ' + (e && e.message ? e.message : 'unknown')));
      };
      worker.postMessage({ bootstrap: assets.bootstrap, moment: assets.moment || null, script: script, ctx: ctx });
    });
  }

  // ── Execução de um passo (espelha runCollectionRequest) ──────────────

  async function runStep(step, envIn, assets, relay) {
    var env = Object.assign({}, envIn);
    var out = {
      status: 'success', httpStatus: null, time: 0, method: step.method, sent: null,
      response: null, tests: [], logs: [], setVariables: [], scriptError: null, errorMessage: null,
      unresolved: [], envAfter: env,
    };
    var tag = function (list, phase) { return (list || []).map(function (x) { return Object.assign({ phase: phase }, x); }); };

    if (step.kind === 'grpc') {
      out.status = 'skipped';
      out.errorMessage = 'gRPC requests cannot run in a browser — run this step in DevFlow.';
      return out;
    }
    if (step.kind === 'token') {
      // O login (OAuth/MSAL) acontece no DevFlow; aqui o token vem colado.
      if (has(env, step.tokenVariable) && env[step.tokenVariable] !== '') {
        out.errorMessage = null;
        out.note = 'Using the token in {{' + step.tokenVariable + '}} from the variables panel.';
        return out;
      }
      out.status = 'error';
      out.errorMessage = 'This step signs in with OAuth 2.0, which only runs in DevFlow. Paste a valid token into {{' +
        step.tokenVariable + '}} in the variables panel and run again.';
      return out;
    }

    var method = step.method || 'GET';
    var parts = buildParts(step, env);

    if (step.preRequest && step.preRequest.trim()) {
      var before = { url: parts.url, headers: parts.headers, body: parts.body };
      var pre = await runScript(assets, step.preRequest, {
        env: env, response: null, request: { method: method, url: before.url, headers: before.headers, body: before.body },
      });
      env = pre.env || env;
      out.setVariables = out.setVariables.concat(tag(pre.setVariables, 'pre-request'));
      out.logs = out.logs.concat(tag(pre.logs, 'pre-request'));
      method = (pre.request && pre.request.method) || method;
      parts = resolveAfterPreRequest(before, pre.request, function (e) { return buildParts(step, e); }, env);
      if (pre.scriptError) {
        out.status = 'error';
        out.errorMessage = 'Pre-request script error: ' + pre.scriptError;
        out.envAfter = env;
        return out;
      }
    }

    // Pelo navegador, alguns headers não podem ser definidos (User-Agent,
    // Connection…). Pelo DevFlow vão todos, como no app.
    if (!relay) {
      var split = splitForbidden(parts.headers);
      parts = { url: parts.url, headers: split.allowed, body: parts.body };
      out.notSentHeaders = split.dropped;
    }
    out.method = method;
    out.sent = parts;
    out.via = relay ? 'DevFlow' : 'browser';
    out.unresolved = unresolvedIn(parts);
    var hasBody = parts.body && method !== 'GET' && method !== 'HEAD';

    // URL sem http(s):// — quase sempre a variável da base vazia. Sem isto o
    // navegador resolvia "/api/v1/token" contra o próprio arquivo e o erro
    // parecia CORS.
    if (!/^https?:\/\//i.test(parts.url)) {
      var empty = emptyUrlVariables(step.url, env);
      out.status = 'error';
      out.errorMessage = 'The URL is not complete: "' + parts.url + '". ' + (empty.length
        ? 'Fill in ' + empty.map(function (n) { return '{{' + n + '}}'; }).join(', ') + ' in the Variables panel and run again.'
        : 'It must start with http:// or https://.');
      out.envAfter = env;
      return out;
    }

    var started = performance.now();
    var response;
    if (relay) {
      try {
        response = await sendViaRelay(relay, method, parts, hasBody);
      } catch (err) {
        out.status = 'error';
        out.time = Math.round(performance.now() - started);
        out.errorMessage = err && err.message ? err.message : String(err);
        out.envAfter = env;
        return out;
      }
    }
    var res;
    if (!relay) try {
      res = await fetch(parts.url, { method: method, headers: parts.headers, body: hasBody ? parts.body : undefined });
    } catch (err) {
      out.status = 'error';
      out.time = Math.round(performance.now() - started);
      // O navegador não diz POR QUE recusou (de propósito) — tudo vira
      // "Failed to fetch". As três causas reais, na ordem em que aparecem:
      // certificado que o navegador não aceita (hosts internos com CA da
      // empresa — o DevFlow passa porque não verifica SSL), CORS e rede/VPN.
      var origin = '';
      try { origin = new URL(parts.url).origin; } catch (e) { /* URL já validada acima */ }
      out.openUrl = origin;
      out.errorMessage = 'The browser did not deliver a response from ' + origin + ' (' + (err && err.message ? err.message : err) + '). Possible causes:\n' +
        '1. The site certificate is not trusted by this browser — common on internal hosts (.corp) signed by the company. ' +
        'Open the link below; if the browser warns that the connection is not private, continue to the site, come back and run again.\n' +
        '2. CORS — the API does not accept calls from a page opened from a file. The console (F12) says so explicitly.\n' +
        '3. Network/VPN — the host is only reachable inside the company network.\n' +
        'Switching "Send via" to DevFlow (top of the page) avoids 1 and 2.';
      out.envAfter = env;
      return out;
    }
    if (!relay) {
      var headersIn = {};
      res.headers.forEach(function (value, key) { headersIn[key] = value; });
      response = { status: res.status, headers: headersIn, body: await res.text(), time: null };
    }
    var body = response.body;
    var headers = response.headers;
    out.time = response.time != null ? response.time : Math.round(performance.now() - started);
    out.httpStatus = response.status;
    out.response = { status: response.status, headers: headers, body: body };

    if (step.postResponse && step.postResponse.trim()) {
      var post = await runScript(assets, step.postResponse, {
        env: env, response: { status: response.status, headers: headers }, responseBody: body,
        request: { method: method, url: parts.url, headers: parts.headers, body: parts.body }, responseTime: out.time,
      });
      env = post.env || env;
      out.tests = post.tests || [];
      out.setVariables = out.setVariables.concat(tag(post.setVariables, 'post-response'));
      out.logs = out.logs.concat(tag(post.logs, 'post-response'));
      if (post.scriptError) out.scriptError = 'Post-response script error: ' + post.scriptError;
    }
    out.envAfter = env;
    return out;
  }

  // ── HAR da execução ───────────────────────────────────────────────────
  // O que cada passo ENVIOU e RECEBEU, no formato HTTP Archive 1.2 (abre no
  // DevTools do Chrome, Fiddler, Postman…) — a evidência de um teste ou o
  // anexo de um bug. Só entram os passos que rodaram.

  function harPairs(map) {
    return Object.keys(map || {}).map(function (k) { return { name: k, value: String(map[k]) }; });
  }

  function harQuery(url) {
    var at = url.indexOf('?');
    if (at < 0) return [];
    return url.slice(at + 1).split('#')[0].split('&').filter(Boolean).map(function (pair) {
      var eq = pair.indexOf('=');
      var dec = function (x) { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch (e) { return x; } };
      return { name: dec(eq < 0 ? pair : pair.slice(0, eq)), value: dec(eq < 0 ? '' : pair.slice(eq + 1)) };
    });
  }

  function headerValue(map, name) {
    var found = Object.keys(map || {}).filter(function (k) { return k.toLowerCase() === name; })[0];
    return found ? String(map[found]) : '';
  }

  function buildRunHar(flow, results, envName) {
    var entries = [];
    flow.steps.forEach(function (step) {
      var out = results[step.id];
      if (!out || !out.sent) return;
      var sent = out.sent;
      var res = out.response;
      var hasBody = sent.body && out.method !== 'GET' && out.method !== 'HEAD';
      var failedTests = (out.tests || []).filter(function (t) { return !t.passed; }).length;
      var notes = [[].concat(step.path, [step.name]).join(' / ')];
      if (out.via === 'DevFlow') notes.push('Sent through DevFlow.');
      if ((out.tests || []).length) notes.push('Tests: ' + (out.tests.length - failedTests) + '/' + out.tests.length + ' passed' +
        (failedTests ? ' — failed: ' + out.tests.filter(function (t) { return !t.passed; }).map(function (t) { return t.name; }).join(', ') : ''));
      if (out.errorMessage) notes.push('Error: ' + out.errorMessage);
      if (out.scriptError) notes.push(out.scriptError);
      entries.push({
        startedDateTime: out.startedAt || new Date().toISOString(),
        time: out.time || 0,
        request: {
          method: out.method, url: sent.url, httpVersion: 'HTTP/1.1', cookies: [],
          headers: harPairs(sent.headers), queryString: harQuery(sent.url),
          postData: hasBody ? { mimeType: headerValue(sent.headers, 'content-type') || 'application/octet-stream', text: sent.body } : undefined,
          headersSize: -1, bodySize: hasBody ? sent.body.length : 0,
        },
        response: res ? {
          status: res.status, statusText: '', httpVersion: 'HTTP/1.1', cookies: [], headers: harPairs(res.headers),
          content: { size: res.body.length, mimeType: headerValue(res.headers, 'content-type') || 'x-unknown', text: res.body },
          redirectURL: headerValue(res.headers, 'location'), headersSize: -1, bodySize: res.body.length,
        } : {
          // Sem resposta (bloqueado, rede): status 0, como o próprio Chrome grava.
          status: 0, statusText: '', httpVersion: 'HTTP/1.1', cookies: [], headers: [],
          content: { size: 0, mimeType: 'x-unknown' }, redirectURL: '', headersSize: -1, bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: out.time || 0, receive: 0 },
        comment: notes.join('\n'),
      });
    });
    return {
      log: {
        version: '1.2',
        creator: { name: 'DevFlow HTML runner', version: '1' },
        comment: 'Flow "' + (flow.path.join(' / ') || flow.name) + '" — environment "' + envName + '" — run on ' + new Date().toLocaleString(),
        entries: entries,
      },
    };
  }

  var core = {
    buildRunHar: buildRunHar,
    substitute: substitute,
    buildParts: buildParts,
    resolveAfterPreRequest: resolveAfterPreRequest,
    unresolvedIn: unresolvedIn,
    toCurl: toCurl,
    splitForbidden: splitForbidden,
    emptyUrlVariables: emptyUrlVariables,
    parseConnectionCode: parseConnectionCode,
    workerMain: workerMain,
    runStep: runStep,
  };
  root.FlowCore = core;

  // ── Interface ────────────────────────────────────────────────────────
  if (typeof document === 'undefined') return;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function pretty(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }

  function start() {
    var dataNode = document.getElementById('flow-data');
    if (!dataNode) return;
    var flow = JSON.parse(dataNode.textContent);
    var assets = { bootstrap: flow.runtime.bootstrap, moment: flow.runtime.moment };
    var storageKey = 'devflow-flow:' + flow.id;

    // Environments que vieram no arquivo — o seletor do topo troca entre
    // eles. Valores digitados ficam neste navegador (nunca no arquivo), um
    // conjunto por environment, e a última escolha é lembrada.
    var envChoiceKey = storageKey + ':env';
    var valuesKey = function (name) { return storageKey + ':values:' + name; };
    var envDef = function (name) {
      for (var i = 0; i < flow.environments.length; i++) if (flow.environments[i].name === name) return flow.environments[i];
      return flow.environments[0];
    };
    var currentEnvName = flow.defaultEnvironment;
    try {
      var lastChoice = localStorage.getItem(envChoiceKey);
      if (lastChoice && envDef(lastChoice).name === lastChoice) currentEnvName = lastChoice;
    } catch (e) { /* ok */ }

    var env = {};
    function loadEnv(name) {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem(valuesKey(name)) || '{}') || {}; } catch (e) { saved = {}; }
      env = {};
      envDef(name).variables.forEach(function (v) { env[v.key] = has(saved, v.key) ? saved[v.key] : (v.value || ''); });
      Object.keys(saved).forEach(function (k) { if (!has(env, k)) env[k] = saved[k]; });
    }
    loadEnv(currentEnvName);

    var results = {};
    var running = false;
    var stopRequested = false;
    var stopOnFailure = true;

    function persist() {
      try { localStorage.setItem(valuesKey(currentEnvName), JSON.stringify(env)); } catch (e) { /* sem storage */ }
    }

    var app = document.getElementById('app');

    // Cabeçalho
    var runAllBtn = el('button', { class: 'primary', text: 'Run all', onclick: function () { runFrom(0); } });
    var harBtn = el('button', {
      class: 'ghost', text: 'Download .har',
      title: 'HTTP Archive of what this run sent and received — opens in Chrome DevTools, Fiddler, Postman…',
      onclick: function () {
        var har = buildRunHar(flow, results, currentEnvName);
        if (!har.log.entries.length) {
          progress.textContent = 'Run at least one step before downloading the .har.';
          return;
        }
        var link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' }));
        link.download = (flow.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'flow') + ' - run.har';
        document.body.appendChild(link);
        link.click();
        setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
      },
    });
    var stopBtn = el('button', { class: 'ghost', text: 'Stop', disabled: 'disabled', onclick: function () { stopRequested = true; } });
    var stopToggle = el('input', { type: 'checkbox', checked: 'checked', onchange: function (e) { stopOnFailure = e.target.checked; } });
    var progress = el('span', { class: 'muted', text: flow.steps.length + ' steps' });
    // Como as requisições saem: direto do navegador, ou pelo DevFlow aberto
    // nesta máquina (relay). A escolha e o código de conexão valem pra todo
    // HTML de flow neste navegador, não só este.
    var VIA_KEY = 'devflow-flow:send-via';
    var RELAY_KEY = 'devflow-flow:relay-connection';
    var via = 'browser';
    var relayCode = '';
    try {
      via = localStorage.getItem(VIA_KEY) === 'devflow' ? 'devflow' : 'browser';
      relayCode = localStorage.getItem(RELAY_KEY) || '';
    } catch (e) { /* ok */ }
    var relayStatus = el('span', { class: 'muted small' });
    var relayInput = el('input', {
      value: relayCode, spellcheck: 'false', placeholder: 'devflow-relay://127.0.0.1:47821/…',
      oninput: function (e) {
        relayCode = e.target.value.trim();
        try { localStorage.setItem(RELAY_KEY, relayCode); } catch (err) { /* ok */ }
        relayStatus.textContent = '';
      },
    });
    var relayBox = el('section', { class: 'card relay' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: 'Send via DevFlow' }),
        el('span', { class: 'muted small', text: 'In DevFlow: Settings → Network → turn on "HTML runner relay" and copy the connection code. DevFlow must be open on this computer.' }),
      ]),
      el('div', { class: 'relay-row' }, [
        relayInput,
        el('button', { class: 'ghost', text: 'Test connection', onclick: async function () {
          var relay = parseConnectionCode(relayCode);
          if (!relay) { relayStatus.textContent = 'That is not a connection code — copy it from DevFlow.'; return; }
          relayStatus.textContent = 'Testing…';
          try {
            var r = await fetch(relay.base + '/ping', { headers: { 'X-DevFlow-Relay-Key': relay.key } });
            relayStatus.textContent = r.ok ? '✓ Connected to DevFlow.' : r.status === 401 ? 'DevFlow refused this code — copy it again.' : 'DevFlow answered HTTP ' + r.status + '.';
          } catch (err) {
            relayStatus.textContent = 'DevFlow is not reachable — is it open with the relay turned on?';
          }
        } }),
        relayStatus,
      ]),
    ]);
    function currentRelay() { return via === 'devflow' ? parseConnectionCode(relayCode) : null; }
    var viaSelect = el('select', {
      title: 'Browser: requests go straight from this page. DevFlow: they go through DevFlow open on this computer (internal hosts, CORS).',
      onchange: function (e) {
        via = e.target.value;
        try { localStorage.setItem(VIA_KEY, via); } catch (err) { /* ok */ }
        relayBox.style.display = via === 'devflow' ? '' : 'none';
      },
    }, [
      el('option', { value: 'browser', text: 'Browser', selected: via === 'browser' ? 'selected' : null }),
      el('option', { value: 'devflow', text: 'DevFlow', selected: via === 'devflow' ? 'selected' : null }),
    ]);
    relayBox.style.display = via === 'devflow' ? '' : 'none';

    var envSelect = el('select', {
      title: 'Environment — switches every variable at once',
      onchange: function (e) {
        currentEnvName = e.target.value;
        try { localStorage.setItem(envChoiceKey, currentEnvName); } catch (err) { /* ok */ }
        loadEnv(currentEnvName);
        renderVariables();
        progress.textContent = 'Environment: ' + currentEnvName + ' — ' + flow.steps.length + ' steps';
      },
    }, flow.environments.map(function (e) {
      return el('option', { value: e.name, text: e.name, selected: e.name === currentEnvName ? 'selected' : null });
    }));
    app.appendChild(el('header', { class: 'top' }, [
      el('div', {}, [
        el('h1', { text: flow.name }),
        el('div', { class: 'muted small', text: flow.path.join(' / ') + ' · exported from DevFlow ' + new Date(flow.generatedAt).toLocaleString() }),
        flow.description ? el('p', { class: 'desc', text: flow.description }) : null,
      ]),
      el('div', { class: 'actions' }, [
        el('label', { class: 'env-picker' }, ['Environment ', envSelect]),
        el('label', { class: 'env-picker' }, ['Send via ', viaSelect]),
        el('label', { class: 'toggle' }, [stopToggle, ' Stop on failure']),
        harBtn, stopBtn, runAllBtn,
      ]),
    ]));
    app.appendChild(el('div', { class: 'progress' }, [progress]));
    app.appendChild(relayBox);

    // Variáveis
    var varRows = el('tbody');
    var varInputs = {};
    function renderVariables() {
      varRows.innerHTML = '';
      var keys = Object.keys(env).sort(function (a, b) { return a.localeCompare(b); });
      if (typeof varsTitle !== 'undefined') varsTitle.textContent = 'Variables (' + keys.length + ')';
      var secretKeys = {};
      envDef(currentEnvName).variables.forEach(function (v) { if (v.secret) secretKeys[v.key] = true; });
      keys.forEach(function (key) {
        var input = el('input', {
          value: env[key], type: secretKeys[key] ? 'password' : 'text', spellcheck: 'false',
          placeholder: secretKeys[key] ? 'secret — not included in the file, paste it here' : '',
          oninput: function (e) { env[key] = e.target.value; persist(); },
        });
        varInputs[key] = input;
        var reveal = secretKeys[key]
          ? el('button', { class: 'ghost tiny', text: 'show', onclick: function (e) {
              input.type = input.type === 'password' ? 'text' : 'password';
              e.target.textContent = input.type === 'password' ? 'show' : 'hide';
            } })
          : null;
        varRows.appendChild(el('tr', {}, [
          el('td', { class: 'key' }, [key, secretKeys[key] ? el('span', { class: 'badge secret', text: 'secret' }) : null]),
          el('td', {}, [input]),
          el('td', { class: 'narrow' }, [reveal]),
        ]));
      });
    }
    renderVariables();
    // Recolhível pelo cabeçalho — com muitas variáveis, o painel empurrava os
    // passos pra baixo da tela. A escolha fica guardada neste navegador.
    var collapsedKey = storageKey + ':vars-collapsed';
    var varsTitle = el('h2', { text: 'Variables (' + Object.keys(env).length + ')' });
    var varsCard = el('section', { class: 'card vars' }, [
      el('div', { class: 'card-head', title: 'Click to collapse or expand', onclick: function (e) {
        if (e.target.closest('button')) return;
        varsCard.classList.toggle('collapsed');
        try { localStorage.setItem(collapsedKey, varsCard.classList.contains('collapsed') ? '1' : '0'); } catch (err) { /* ok */ }
      } }, [
        el('span', { class: 'chev', text: '▾' }),
        varsTitle,
        el('span', { class: 'muted small vars-note', text: 'Values you type stay in this browser only. Scripts update them as the flow runs.' }),
        el('button', { class: 'ghost tiny', text: 'Reset to exported values', onclick: function () {
          try { localStorage.removeItem(valuesKey(currentEnvName)); } catch (e) { /* ok */ }
          loadEnv(currentEnvName);
          renderVariables();
        } }),
      ]),
      flow.includesSecrets
        ? el('div', { class: 'alert warn vars-body', text: 'This file contains secret values (tokens, API keys) from: ' +
            flow.environments.map(function (e) { return e.name; }).join(', ') + '. Use it only with test environments and share it only within the team.' })
        : null,
      el('table', { class: 'vars-body' }, [varRows]),
    ]);
    try { if (localStorage.getItem(collapsedKey) === '1') varsCard.classList.add('collapsed'); } catch (e) { /* ok */ }
    app.appendChild(varsCard);

    // Passos
    var stepViews = flow.steps.map(function (step, index) {
      var status = el('span', { class: 'chip', text: step.kind === 'grpc' ? 'not runnable' : 'not run' });
      var resultBox = el('div', { class: 'result' });
      var bodyBox = el('div', { class: 'step-body' }, [
        step.description ? el('p', { class: 'desc', text: step.description }) : null,
        el('div', { class: 'kv' }, [el('span', { class: 'label', text: 'URL' }), el('code', { text: step.url || '(none)' })]),
        Object.keys(step.headers).length
          ? el('details', {}, [el('summary', { text: 'Headers (' + Object.keys(step.headers).length + ')' }),
              el('pre', { text: Object.keys(step.headers).map(function (k) { return k + ': ' + step.headers[k]; }).join('\n') })])
          : null,
        step.body ? el('details', {}, [el('summary', { text: 'Body' }), el('pre', { text: pretty(step.body) })]) : null,
        step.preRequest ? el('details', {}, [el('summary', { text: 'Pre-request script' }), el('pre', { text: step.preRequest })]) : null,
        step.postResponse ? el('details', {}, [el('summary', { text: 'Post-response script' }), el('pre', { text: step.postResponse })]) : null,
        el('div', { class: 'row' }, [
          el('button', { class: 'primary', text: 'Send', disabled: step.kind === 'grpc' ? 'disabled' : null, onclick: function () { runOne(index); } }),
          el('button', { class: 'ghost', text: 'Run from here', disabled: step.kind === 'grpc' ? 'disabled' : null, onclick: function () { runFrom(index); } }),
          el('button', { class: 'ghost', text: 'Copy as cURL', onclick: function (e) {
            var last = results[step.id];
            var parts = last && last.sent ? last.sent : buildParts(step, env);
            var text = toCurl((last && last.method) || step.method || 'GET', parts);
            navigator.clipboard.writeText(text).then(function () { e.target.textContent = 'Copied'; setTimeout(function () { e.target.textContent = 'Copy as cURL'; }, 1500); });
          } }),
        ]),
        resultBox,
      ]);
      var card = el('section', { class: 'card step', id: 'step-' + index }, [
        el('div', { class: 'step-head', onclick: function () { card.classList.toggle('open'); } }, [
          el('span', { class: 'index', text: String(index + 1).padStart(2, '0') }),
          el('span', { class: 'method m-' + (step.kind === 'token' ? 'token' : (step.method || 'GET').toLowerCase()),
            text: step.kind === 'token' ? 'TOKEN' : step.kind === 'grpc' ? 'gRPC' : (step.method || 'GET') }),
          el('span', { class: 'name' }, [
            el('span', { text: step.name }),
            step.path.length ? el('span', { class: 'muted small path', text: step.path.join(' / ') }) : null,
          ]),
          status,
        ]),
        bodyBox,
      ]);
      app.appendChild(card);
      return { card: card, status: status, result: resultBox };
    });

    function renderResult(index, outcome) {
      var view = stepViews[index];
      view.status.className = 'chip ' + outcome.status;
      var failedTests = outcome.tests.filter(function (t) { return !t.passed; }).length;
      view.status.textContent = outcome.status === 'success'
        ? (outcome.httpStatus ? outcome.httpStatus + ' · ' + outcome.time + ' ms' : 'ok') + (outcome.tests.length ? ' · tests ' + (outcome.tests.length - failedTests) + '/' + outcome.tests.length : '')
        : outcome.status === 'skipped' ? 'skipped' : 'failed';
      var box = view.result;
      box.innerHTML = '';
      if (outcome.errorMessage) box.appendChild(el('div', { class: 'alert error', text: outcome.errorMessage }));
      if (outcome.openUrl) {
        box.appendChild(el('div', { class: 'row' }, [
          el('a', { class: 'button-link', href: outcome.openUrl, target: '_blank', rel: 'noopener', text: 'Open ' + outcome.openUrl + ' to check the certificate' }),
        ]));
      }
      if (outcome.note) box.appendChild(el('div', { class: 'alert info', text: outcome.note }));
      if (outcome.scriptError) box.appendChild(el('div', { class: 'alert error', text: outcome.scriptError }));
      if (outcome.unresolved && outcome.unresolved.length) {
        box.appendChild(el('div', { class: 'alert warn', text: 'Sent with variables that have no value: ' + outcome.unresolved.map(function (n) { return '{{' + n + '}}'; }).join(', ') }));
      }
      if (outcome.tests.length) {
        box.appendChild(el('div', { class: 'tests' }, outcome.tests.map(function (t) {
          return el('div', { class: 'test ' + (t.passed ? 'pass' : 'fail') }, [(t.passed ? '✓ ' : '✗ ') + t.name, t.message ? el('span', { class: 'muted small', text: ' — ' + t.message }) : null]);
        })));
      }
      if (outcome.response) {
        box.appendChild(el('div', { class: 'kv' }, [el('span', { class: 'label', text: 'Response' }), el('span', { text: 'HTTP ' + outcome.response.status + ' · ' + outcome.time + ' ms' })]));
        box.appendChild(el('pre', { class: 'response', text: pretty(outcome.response.body).slice(0, 200000) }));
        box.appendChild(el('details', {}, [el('summary', { text: 'Response headers' }),
          el('pre', { text: Object.keys(outcome.response.headers).map(function (k) { return k + ': ' + outcome.response.headers[k]; }).join('\n') || '(the browser only exposes the headers the API allows)' })]));
      }
      if (outcome.sent) {
        box.appendChild(el('details', {}, [el('summary', { text: 'What was sent' }),
          el('pre', { text: (outcome.via === 'DevFlow' ? '(sent through DevFlow)\n' : '') + outcome.method + ' ' + outcome.sent.url + '\n' +
            Object.keys(outcome.sent.headers).map(function (k) { return k + ': ' + outcome.sent.headers[k]; }).join('\n') +
            (outcome.sent.body ? '\n\n' + pretty(outcome.sent.body) : '') +
            (outcome.notSentHeaders && outcome.notSentHeaders.length
              ? '\n\n(not sent — browsers do not let a page set: ' + outcome.notSentHeaders.join(', ') + ')'
              : '') })]));
      }
      if (outcome.setVariables.length) {
        box.appendChild(el('details', { open: 'open' }, [el('summary', { text: 'Variables set by scripts (' + outcome.setVariables.length + ')' }),
          el('pre', { text: outcome.setVariables.map(function (v) { return (v.removed ? 'unset ' : '') + v.key + (v.removed ? '' : ' = ' + v.value) + '   (' + v.phase + ')'; }).join('\n') })]));
      }
      if (outcome.logs.length) {
        box.appendChild(el('details', {}, [el('summary', { text: 'Console (' + outcome.logs.length + ')' }),
          el('pre', { text: outcome.logs.map(function (l) { return '[' + l.phase + '] ' + l.level + ': ' + l.message; }).join('\n') })]));
      }
    }

    async function execute(index) {
      var step = flow.steps[index];
      var view = stepViews[index];
      view.card.classList.add('open');
      view.status.className = 'chip running';
      view.status.textContent = 'running…';
      var relay = currentRelay();
      var startedAt = new Date().toISOString();
      var outcome;
      if (via === 'devflow' && !relay) {
        outcome = { status: 'error', tests: [], logs: [], setVariables: [], envAfter: env,
          errorMessage: '"Send via" is DevFlow, but there is no valid connection code. Paste it in the "Send via DevFlow" box at the top.' };
      } else {
        outcome = await runStep(step, env, assets, relay);
      }
      outcome.startedAt = startedAt;
      results[step.id] = outcome;
      env = outcome.envAfter;
      persist();
      renderVariables();
      renderResult(index, outcome);
      return outcome;
    }

    function setRunning(on) {
      running = on;
      runAllBtn.disabled = on;
      stopBtn.disabled = !on;
    }

    async function runOne(index) {
      if (running) return;
      setRunning(true);
      try { await execute(index); } finally { setRunning(false); }
    }

    async function runFrom(startIndex) {
      if (running) return;
      setRunning(true);
      stopRequested = false;
      var ok = 0;
      var failed = 0;
      try {
        for (var i = startIndex; i < flow.steps.length; i++) {
          if (stopRequested) break;
          if (flow.steps[i].kind === 'grpc') continue;
          progress.textContent = 'Running step ' + (i + 1) + ' of ' + flow.steps.length + '…';
          stepViews[i].card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          var outcome = await execute(i);
          var testsFailed = outcome.tests.some(function (t) { return !t.passed; });
          if (outcome.status === 'error' || testsFailed) {
            failed++;
            if (stopOnFailure) break;
          } else {
            ok++;
          }
        }
      } finally {
        setRunning(false);
        progress.textContent = (stopRequested ? 'Stopped. ' : 'Done. ') + ok + ' passed, ' + failed + ' failed.';
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
