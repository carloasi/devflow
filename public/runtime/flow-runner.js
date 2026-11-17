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

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /** Base64 dos bytes UTF-8 do texto (btoa só aceita Latin-1). */
  function utf8Base64(text) {
    var bytes = [];
    var encoded = encodeURIComponent(String(text));
    for (var i = 0; i < encoded.length; i++) {
      if (encoded[i] === '%') {
        bytes.push(parseInt(encoded.substr(i + 1, 2), 16));
        i += 2;
      } else {
        bytes.push(encoded.charCodeAt(i));
      }
    }
    return bytesBase64(bytes);
  }

  function bytesBase64(bytes) {
    var out = '';
    for (var j = 0; j < bytes.length; j += 3) {
      var n = (bytes[j] << 16) | ((bytes[j + 1] || 0) << 8) | (bytes[j + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
        (j + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (j + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
  }

  /** URL, headers e body do passo com as variáveis de `env`. */
  function buildParts(step, env) {
    var headers = {};
    Object.keys(step.headers || {}).forEach(function (key) {
      headers[substitute(key, env)] = substitute(step.headers[key], env);
    });
    // Auth Basic: o base64 só pode ser montado com usuário e senha já
    // trocados — e vale por cima de um Authorization escrito à mão, como no app.
    if (step.basicAuth) {
      Object.keys(headers).forEach(function (k) { if (k.toLowerCase() === 'authorization') delete headers[k]; });
      headers.Authorization = 'Basic ' + utf8Base64(substitute(step.basicAuth.username, env) + ':' + substitute(step.basicAuth.password, env));
    }
    return { url: substitute(step.url, env), headers: headers, body: step.body ? substitute(step.body, env) : '' };
  }

  /**
   * O passo falhou? A mesma regra do Runner do DevFlow (runVerdict.ts): erro
   * de envio ou de script falha sempre; com pm.test, as asserções decidem
   * (um 400 esperado passa); sem nenhuma, HTTP 4xx/5xx é falha. Antes um 500
   * sem testes ficava verde e o "Stop on failure" não parava.
   */
  function isFailure(outcome) {
    if (!outcome || outcome.status === 'skipped') return false;
    if (outcome.status === 'error' || outcome.scriptError) return true;
    var tests = outcome.tests || [];
    if (tests.length) return tests.some(function (t) { return !t.passed; });
    return typeof outcome.httpStatus === 'number' && outcome.httpStatus >= 400;
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

  /** Tipo de conteúdo que não é texto — lido como bytes, não como string. */
  function isBinaryType(contentType) {
    var type = String(contentType || '').toLowerCase().split(';')[0].trim();
    if (!type) return false;
    if (/^text\//.test(type) || /json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|csv|html/.test(type)) return false;
    return /^(image|audio|video|font)\//.test(type) || /octet-stream|pdf|zip|gzip|protobuf|msgpack|excel|spreadsheet|msword|officedocument/.test(type);
  }

  /** Tamanho em bytes de um texto (UTF-8) — o HAR fala em bytes, não em caracteres. */
  function byteLength(text) {
    var s = String(text || '');
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /** Bytes de uma resposta em base64 → quantos bytes ela tinha. */
  function base64Bytes(b64) {
    var clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
    var pad = clean.slice(-2) === '==' ? 2 : clean.slice(-1) === '=' ? 1 : 0;
    return Math.max(0, Math.floor(clean.length * 3 / 4) - pad);
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

  async function runStep(step, envIn, assets) {
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
    // Connection…): saem do envio e aparecem como "não enviados".
    var split = splitForbidden(parts.headers);
    parts = { url: parts.url, headers: split.allowed, body: parts.body };
    out.notSentHeaders = split.dropped;
    out.method = method;
    out.sent = parts;
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
    var res;
    try {
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
        '3. Network/VPN — the host is only reachable inside the company network.';
      out.envAfter = env;
      return out;
    }
    var headersIn = {};
    res.headers.forEach(function (value, key) { headersIn[key] = value; });
    try {
      // Binário (imagem, PDF…) como bytes: lido como texto, vinha corrompido.
      if (isBinaryType(headersIn['content-type']) && res.arrayBuffer) {
        var raw = new Uint8Array(await res.arrayBuffer());
        response = { status: res.status, headers: headersIn, body: bytesBase64(raw), time: null, binary: true };
      } else {
        response = { status: res.status, headers: headersIn, body: await res.text(), time: null };
      }
    } catch (err) {
      out.status = 'error';
      out.httpStatus = res.status;
      out.time = Math.round(performance.now() - started);
      out.errorMessage = 'The response from ' + parts.url + ' was cut off while reading it (' + (err && err.message ? err.message : err) + ').';
      out.envAfter = env;
      return out;
    }
    var body = response.body;
    var headers = response.headers;
    out.time = response.time != null ? response.time : Math.round(performance.now() - started);
    out.httpStatus = response.status;
    out.response = { status: response.status, headers: headers, body: body, binary: response.binary === true };

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
          headersSize: -1, bodySize: hasBody ? byteLength(sent.body) : 0,
        },
        response: res ? (function () {
          // Binário vem em base64 (o HAR diz isso no `encoding`); tamanho em bytes.
          var size = res.binary ? base64Bytes(res.body) : byteLength(res.body);
          var content = { size: size, mimeType: headerValue(res.headers, 'content-type') || 'x-unknown', text: res.body };
          if (res.binary) content.encoding = 'base64';
          return {
            status: res.status, statusText: '', httpVersion: 'HTTP/1.1', cookies: [], headers: harPairs(res.headers),
            content: content, redirectURL: headerValue(res.headers, 'location'), headersSize: -1, bodySize: size,
          };
        })() : {
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

  // ── Valores guardados no navegador ───────────────────────────────────
  // Só o que difere do arquivo: o que a pessoa digitou e o que os scripts
  // definiram. Antes ia o environment inteiro, e um HTML exportado de novo
  // (com a baseUrl corrigida, por exemplo) continuava usando o valor antigo
  // guardado — sem nada dizendo isso.

  /** O que guardar: `{ v: 2, values }` só com o que mudou em relação a `defaults`. */
  function storedOverrides(env, defaults) {
    var values = {};
    Object.keys(env).forEach(function (k) {
      if (!has(defaults, k) || String(env[k]) !== String(defaults[k])) values[k] = env[k];
    });
    return { v: 2, values: values };
  }

  /**
   * As variáveis ao abrir: as do arquivo com o que foi guardado por cima.
   * Formato antigo (o environment inteiro, sem `v`): só vale o que o arquivo
   * não trazia ou trazia vazio — o resto pode ser um valor velho do export.
   */
  function valuesFromStore(saved, defaults) {
    var env = {};
    Object.keys(defaults).forEach(function (k) { env[k] = defaults[k]; });
    if (!saved || typeof saved !== 'object') return env;
    if (saved.v === 2 && saved.values && typeof saved.values === 'object') {
      Object.keys(saved.values).forEach(function (k) { env[k] = saved.values[k]; });
      return env;
    }
    Object.keys(saved).forEach(function (k) {
      if (!has(defaults, k) || String(defaults[k]) === '') env[k] = saved[k];
    });
    return env;
  }

  /**
   * Tipo do environment pelo nome (env-prd, hml, tst…) — decide a cor e o
   * aviso da faixa do topo e se o envio pede confirmação. Nome que não diz
   * nada fica neutro.
   */
  function envKind(name) {
    var n = String(name || '').toLowerCase();
    var matches = function (re) { return re.test(n); };
    if (matches(/(^|[^a-z])(prd|prod|production|produc[aã]o)([^a-z]|$)/)) {
      return { id: 'prod', label: 'PRODUCTION', note: 'Requests go to real systems and real data.' };
    }
    if (matches(/(^|[^a-z])(hml|hmg|homolog\w*|stg|staging|uat|pre|preprod|sandbox)([^a-z]|$)/)) {
      return { id: 'staging', label: 'STAGING', note: 'Pre-production environment.' };
    }
    if (matches(/(^|[^a-z])(dev|develop\w*|tst|test|testing|qa|local)([^a-z]|$)/)) {
      return { id: 'test', label: 'TEST', note: 'Test environment.' };
    }
    return { id: 'other', label: 'ENVIRONMENT', note: '' };
  }

  /** A mensagem que a API escreveu no corpo do erro, nos formatos comuns. */
  function apiErrorMessage(body) {
    var json;
    try { json = JSON.parse(body); } catch (e) { return ''; }
    if (!json || typeof json !== 'object') return '';
    var pick = function (v) { return typeof v === 'string' && v.trim() ? v.trim() : ''; };
    var fromList = function (list) {
      if (!Array.isArray(list)) return '';
      return list.map(function (x) {
        return typeof x === 'string' ? x : x && (pick(x.message) || pick(x.description) || pick(x.detail));
      }).filter(Boolean).join(' · ');
    };
    return pick(json.message) || pick(json.error_description) || pick(json.detail) ||
      (json.error && typeof json.error === 'object' ? pick(json.error.message) : pick(json.error)) ||
      fromList(json.notifications) || fromList(json.errors) || pick(json.title) || '';
  }

  /** Variáveis usadas nas credenciais do passo (chave de API, token, basic). */
  function credentialVariables(step) {
    var names = [];
    var collect = function (text) {
      String(text || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (_, n) {
        if (names.indexOf(n) === -1) names.push(n);
        return '';
      });
    };
    Object.keys(step.headers || {}).forEach(function (k) {
      if (/authorization|api-?key|subscription-key|token/i.test(k)) collect(step.headers[k]);
    });
    if (step.basicAuth) { collect(step.basicAuth.username); collect(step.basicAuth.password); }
    return names;
  }

  /**
   * Explicação em linguagem de negócio de uma resposta HTTP de erro: o que
   * aconteceu, o que conferir e o que a API disse. null se não for erro.
   */
  function describeHttpFailure(status, body, step) {
    if (typeof status !== 'number' || status < 400) return null;
    var vars = credentialVariables(step || {}).map(function (n) { return '{{' + n + '}}'; });
    var checkCreds = vars.length
      ? 'Check ' + vars.join(', ') + ' in the Variables panel.'
      : 'Check the API key or token in the Variables panel.';
    var text;
    if (status === 401) text = 'Access denied: the API did not accept the access credentials. ' + checkCreds;
    else if (status === 403) text = 'Not allowed: the credentials were accepted, but they have no permission for this operation in this environment.';
    else if (status === 404) text = 'Not found: the address or an ID in it does not exist in this environment. Check the URL and the variables it uses.';
    else if (status === 408 || status === 504) text = 'The API took too long to answer. Try again in a moment.';
    else if (status === 429) text = 'Too many requests in a short time. Wait a moment and try again.';
    else if (status >= 500) text = 'The API had an internal error. Try again later; if it keeps failing, download the .har and send it to the API team.';
    else text = 'The API rejected the data that was sent. Check the Body and the variables it uses.';
    var said = apiErrorMessage(body);
    return { title: 'HTTP ' + status, text: text, apiMessage: said };
  }

  var core = {
    envKind: envKind,
    describeHttpFailure: describeHttpFailure,
    buildRunHar: buildRunHar,
    substitute: substitute,
    buildParts: buildParts,
    resolveAfterPreRequest: resolveAfterPreRequest,
    unresolvedIn: unresolvedIn,
    toCurl: toCurl,
    utf8Base64: utf8Base64,
    isFailure: isFailure,
    isBinaryType: isBinaryType,
    storedOverrides: storedOverrides,
    valuesFromStore: valuesFromStore,
    splitForbidden: splitForbidden,
    emptyUrlVariables: emptyUrlVariables,
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

    // Body editado na página: vale pra Send, Run all e cURL, fica neste
    // navegador (um por passo) e o "Reset" volta ao exportado. Sem edição, o
    // passo manda o body do arquivo como sempre mandou.
    var bodyKey = function (stepId) { return storageKey + ':body:' + stepId; };
    // A edição guarda junto o body exportado em que foi feita: um HTML novo
    // do mesmo flow, com o body mudado no DevFlow, não pode ser atropelado
    // por uma edição antiga guardada no navegador.
    var bodyEdits = {};
    flow.steps.forEach(function (step) {
      try {
        var saved = JSON.parse(localStorage.getItem(bodyKey(step.id)) || 'null');
        if (saved && saved.base === step.body && typeof saved.text === 'string') bodyEdits[step.id] = saved.text;
        else if (saved !== null) localStorage.removeItem(bodyKey(step.id));
      } catch (e) {
        try { localStorage.removeItem(bodyKey(step.id)); } catch (err) { /* sem storage */ }
      }
    });
    function setBodyEdit(stepId, text) {
      var step = flow.steps.filter(function (s) { return s.id === stepId; })[0];
      if (text === null) delete bodyEdits[stepId];
      else bodyEdits[stepId] = text;
      try {
        if (text === null) localStorage.removeItem(bodyKey(stepId));
        else localStorage.setItem(bodyKey(stepId), JSON.stringify({ base: step ? step.body : '', text: text }));
      } catch (e) { /* sem storage: a edição vale só enquanto a página estiver aberta */ }
    }
    function effectiveStep(step) {
      return has(bodyEdits, step.id) ? Object.assign({}, step, { body: bodyEdits[step.id] }) : step;
    }
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
    function defaultsOf(name) {
      var out = {};
      envDef(name).variables.forEach(function (v) { out[v.key] = v.value || ''; });
      return out;
    }
    function loadEnv(name) {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(valuesKey(name)) || 'null'); } catch (e) { saved = null; }
      env = valuesFromStore(saved, defaultsOf(name));
    }
    loadEnv(currentEnvName);

    var results = {};
    var running = false;
    var stopRequested = false;
    var stopOnFailure = true;

    function persist() {
      try {
        localStorage.setItem(valuesKey(currentEnvName), JSON.stringify(storedOverrides(env, defaultsOf(currentEnvName))));
      } catch (e) { /* sem storage */ }
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

    // Faixa do environment: sempre visível (fica no cabeçalho fixo) e com a
    // cor do tipo — quem roda o flow precisa saber, sem procurar, se as
    // chamadas vão pra produção.
    var envBannerName = el('strong', { class: 'env-banner-name' });
    var envBannerKind = el('span', { class: 'env-banner-kind' });
    var envBannerNote = el('span', { class: 'env-banner-note' });
    var envBanner = el('div', { class: 'env-banner' }, [envBannerKind, envBannerName, envBannerNote]);
    function refreshEnvBanner() {
      var kind = envKind(currentEnvName);
      envBanner.className = 'env-banner env-' + kind.id;
      envSelect.className = 'env-' + kind.id;
      envBannerKind.textContent = kind.label;
      envBannerName.textContent = currentEnvName;
      envBannerNote.textContent = kind.note;
    }

    var envSelect = el('select', {
      title: 'Environment — switches every variable at once',
      onchange: function (e) {
        currentEnvName = e.target.value;
        try { localStorage.setItem(envChoiceKey, currentEnvName); } catch (err) { /* ok */ }
        loadEnv(currentEnvName);
        renderVariables();
        refreshEnvBanner();
        progress.textContent = 'Environment: ' + currentEnvName + ' — ' + flow.steps.length + ' steps';
      },
    }, flow.environments.map(function (e) {
      return el('option', { value: e.name, text: e.name, selected: e.name === currentEnvName ? 'selected' : null });
    }));
    refreshEnvBanner();
    app.appendChild(el('header', { class: 'top' }, [
      envBanner,
      el('div', {}, [
        el('h1', { text: flow.name }),
        el('div', { class: 'muted small', text: flow.path.join(' / ') + ' · exported from DevFlow ' + new Date(flow.generatedAt).toLocaleString() }),
        flow.description ? el('p', { class: 'desc', text: flow.description }) : null,
      ]),
      el('div', { class: 'actions' }, [
        el('label', { class: 'env-picker' }, ['Environment ', envSelect]),
        el('label', { class: 'toggle' }, [stopToggle, ' Stop on failure']),
        harBtn, stopBtn, runAllBtn,
      ]),
    ]));
    app.appendChild(el('div', { class: 'progress' }, [progress]));

    // Variáveis
    var varRows = el('tbody');
    var varInputs = {};
    // URL de cada passo como vai sair: com as variáveis do env trocadas (o
    // template fica no title). Atualiza quando o env muda — troca de
    // environment, edição de variável ou script que setou valor.
    var urlViews = [];
    function refreshUrls() {
      urlViews.forEach(function (view) {
        view.code.textContent = substitute(view.step.url, env) || '(none)';
      });
    }
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
          oninput: function (e) { env[key] = e.target.value; persist(); refreshUrls(); },
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
      refreshUrls();
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

    /** Body do passo num campo editável; os {{...}} são trocados no envio. */
    function bodyEditor(step) {
      var original = pretty(step.body);
      var edited = has(bodyEdits, step.id);
      var badge = el('span', { class: 'badge edited', text: 'edited' });
      var resetBtn = el('button', { class: 'ghost tiny', text: 'Reset body', title: 'Back to the body that was exported' });
      var area = el('textarea', { class: 'body-edit', spellcheck: 'false' });
      area.value = edited ? bodyEdits[step.id] : original;
      function fit() { area.rows = Math.min(Math.max(area.value.split('\n').length, 3), 24); }
      function sync() {
        var isEdited = has(bodyEdits, step.id);
        badge.style.display = isEdited ? '' : 'none';
        resetBtn.style.display = isEdited ? '' : 'none';
      }
      area.addEventListener('input', function () {
        // Voltou ao texto exportado: deixa de contar como edição.
        setBodyEdit(step.id, area.value === original ? null : area.value);
        fit();
        sync();
      });
      resetBtn.addEventListener('click', function () {
        setBodyEdit(step.id, null);
        area.value = original;
        fit();
        sync();
      });
      fit();
      sync();
      return el('details', { open: edited ? 'open' : null }, [
        el('summary', {}, ['Body', badge]),
        area,
        el('div', { class: 'row body-actions' }, [
          el('span', { class: 'muted small', text: 'Editable — saved in this browser. {{variables}} are replaced when sending.' }),
          resetBtn,
        ]),
      ]);
    }

    // Passos
    var stepViews = flow.steps.map(function (step, index) {
      var status = el('span', { class: 'chip', text: step.kind === 'grpc' ? 'not runnable' : 'not run' });
      var resultBox = el('div', { class: 'result' });
      // Headers como serão enviados; a Basic aparece com usuário e senha (o
      // base64 só existe na hora de enviar).
      var shownHeaders = Object.keys(step.headers).filter(function (k) {
        return !(step.basicAuth && k.toLowerCase() === 'authorization');
      }).map(function (k) { return k + ': ' + step.headers[k]; });
      if (step.basicAuth) shownHeaders.push('Authorization: Basic base64(' + step.basicAuth.username + ':' + step.basicAuth.password + ')');
      var urlCode = el('code', { text: substitute(step.url, env) || '(none)', title: step.url || '' });
      urlViews.push({ step: step, code: urlCode });
      var bodyBox = el('div', { class: 'step-body' }, [
        step.description ? el('p', { class: 'desc', text: step.description }) : null,
        el('div', { class: 'kv' }, [el('span', { class: 'label', text: 'URL' }), urlCode]),
        shownHeaders.length
          ? el('details', {}, [el('summary', { text: 'Headers (' + shownHeaders.length + ')' }), el('pre', { text: shownHeaders.join('\n') })])
          : null,
        step.body ? bodyEditor(step) : null,
        step.preRequest ? el('details', {}, [el('summary', { text: 'Pre-request script' }), el('pre', { text: step.preRequest })]) : null,
        step.postResponse ? el('details', {}, [el('summary', { text: 'Post-response script' }), el('pre', { text: step.postResponse })]) : null,
        el('div', { class: 'row' }, [
          el('button', { class: 'primary', text: 'Send', disabled: step.kind === 'grpc' ? 'disabled' : null, onclick: function () { runOne(index); } }),
          el('button', { class: 'ghost', text: 'Run from here', disabled: step.kind === 'grpc' ? 'disabled' : null, onclick: function () { runFrom(index); } }),
          el('button', { class: 'ghost', text: 'Copy as cURL', onclick: function (e) {
            // Com os valores de AGORA (body editado, variável trocada). O que foi
            // enviado só vale se um pre-request script mexeu no pedido — aí
            // o template sozinho não reproduz o envio.
            var last = results[step.id];
            var useSent = last && last.sent && step.preRequest && step.preRequest.trim();
            var parts = useSent ? last.sent : buildParts(effectiveStep(step), env);
            var text = toCurl((useSent && last.method) || step.method || 'GET', parts);
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

    /** Volta o passo a "not run": sem resultado na tela nem no .har. */
    function clearResult(index) {
      var step = flow.steps[index];
      var view = stepViews[index];
      delete results[step.id];
      view.status.className = 'chip';
      view.status.textContent = step.kind === 'grpc' ? 'not runnable' : 'not run';
      view.result.innerHTML = '';
    }

    function renderResult(index, outcome) {
      var view = stepViews[index];
      var failed = isFailure(outcome);
      view.status.className = 'chip ' + (outcome.status === 'skipped' ? 'skipped' : failed ? 'error' : 'success');
      var failedTests = outcome.tests.filter(function (t) { return !t.passed; }).length;
      // Com resposta, o chip mostra o status (e os testes) mesmo quando falhou.
      view.status.textContent = outcome.status === 'skipped'
        ? 'skipped'
        : outcome.httpStatus
          ? outcome.httpStatus + ' · ' + outcome.time + ' ms' + (outcome.tests.length ? ' · tests ' + (outcome.tests.length - failedTests) + '/' + outcome.tests.length : '') + (failed ? ' · failed' : '')
          : failed ? 'failed' : 'ok';
      var box = view.result;
      box.innerHTML = '';
      // Resposta de erro: a explicação em linguagem de negócio vem primeiro, e
      // o erro de script que ela causou (ler o token de uma resposta 401…)
      // vai pros detalhes técnicos — a causa é a resposta, não o script.
      var httpFailure = failed && outcome.response ? describeHttpFailure(outcome.response.status, outcome.response.body, flow.steps[index]) : null;
      var technical = [];
      if (httpFailure) {
        box.appendChild(el('div', { class: 'alert error friendly' }, [
          el('strong', { text: httpFailure.title + ' — ' }), httpFailure.text,
          httpFailure.apiMessage ? el('div', { class: 'api-said', text: 'The API said: "' + httpFailure.apiMessage + '"' }) : null,
        ]));
        if (outcome.scriptError) technical.push(outcome.scriptError + '\n(caused by the HTTP ' + outcome.response.status + ' response above)');
      }
      if (technical.length) {
        box.appendChild(el('details', { class: 'technical' }, [el('summary', { text: 'Technical details' }), el('pre', { text: technical.join('\n\n') })]));
      }
      if (outcome.errorMessage) box.appendChild(el('div', { class: 'alert error', text: outcome.errorMessage }));
      if (outcome.openUrl) {
        box.appendChild(el('div', { class: 'row' }, [
          el('a', { class: 'button-link', href: outcome.openUrl, target: '_blank', rel: 'noopener', text: 'Open ' + outcome.openUrl + ' to check the certificate' }),
        ]));
      }
      if (outcome.note) box.appendChild(el('div', { class: 'alert info', text: outcome.note }));
      if (outcome.scriptError && !httpFailure) box.appendChild(el('div', { class: 'alert error', text: outcome.scriptError }));
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
        // Sem teste, um 4xx/5xx é falha (como no DevFlow): a tela diz o porquê.
        if (failed && !httpFailure && !outcome.errorMessage && !outcome.scriptError && !outcome.tests.length) {
          box.appendChild(el('div', { class: 'alert error', text: 'HTTP ' + outcome.response.status + ' with no tests counts as a failure. Add a pm.test to the post-response script if this status is expected.' }));
        }
        box.appendChild(el('pre', { class: 'response', text: outcome.response.binary
          ? '(binary response, ' + headerValue(outcome.response.headers, 'content-type') + ' — included in the .har as base64)'
          : pretty(outcome.response.body).slice(0, 200000) }));
        box.appendChild(el('details', {}, [el('summary', { text: 'Response headers' }),
          el('pre', { text: Object.keys(outcome.response.headers).map(function (k) { return k + ': ' + outcome.response.headers[k]; }).join('\n') || '(the browser only exposes the headers the API allows)' })]));
      }
      if (outcome.sent) {
        box.appendChild(el('details', {}, [el('summary', { text: 'What was sent' }),
          el('pre', { text: outcome.method + ' ' + outcome.sent.url + '\n' +
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
      var startedAt = new Date().toISOString();
      var outcome;
      try {
        outcome = await runStep(effectiveStep(step), env, assets);
      } catch (err) {
        // Erro que o passo não previu: o passo fica como falho (e não preso
        // em "running…"), e o "Run all" para por ele.
        outcome = { status: 'error', tests: [], logs: [], setVariables: [], envAfter: env,
          errorMessage: 'Unexpected error while running this step: ' + (err && err.message ? err.message : String(err)) };
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
      // Trocar de environment no meio gravava os valores do que estava
      // rodando no recém-escolhido.
      envSelect.disabled = on;
      envSelect.title = on ? 'Wait for the run to finish to switch environments' : 'Environment — switches every variable at once';
    }

    /**
     * Em produção, cada envio pede confirmação — a faixa vermelha avisa, mas
     * um clique em "Run all" no ambiente errado não tem volta.
     */
    function confirmProduction(stepCount) {
      if (envKind(currentEnvName).id !== 'prod') return true;
      return window.confirm(
        'You are about to run ' + stepCount + (stepCount === 1 ? ' step' : ' steps') + ' in PRODUCTION (' + currentEnvName + ').\n' +
        'Requests go to real systems and real data.\n\nContinue?'
      );
    }

    async function runOne(index) {
      if (running) return;
      if (!confirmProduction(1)) return;
      setRunning(true);
      try { await execute(index); } finally { setRunning(false); }
    }

    async function runFrom(startIndex) {
      if (running) return;
      var toRun = flow.steps.slice(startIndex).filter(function (s) { return s.kind !== 'grpc'; }).length;
      if (!confirmProduction(toRun)) return;
      // Os passos desta execução começam do zero: um verde de antes, num
      // passo que nem chegou a rodar (parou na falha), parecia sucesso — e
      // ia pro .har como se fosse desta vez.
      for (var j = startIndex; j < flow.steps.length; j++) clearResult(j);
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
          if (isFailure(outcome)) {
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
