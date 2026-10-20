// lib/curlParser.ts

export interface ParsedHeader {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ParsedQueryParam {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ParsedCurlRequest {
  method: string;
  url: string;
  baseUrl: string;
  headers: ParsedHeader[];
  queryParams: ParsedQueryParam[];
  body: string | null;
  bodyType: "json" | "form-data" | "x-www-form-urlencoded" | "raw" | "none";
  auth?: {
    type: "bearer" | "basic";
    token?: string;
    username?: string;
    password?: string;
  };
}

/**
 * Tokeniza uma string de shell respeitando aspas simples/duplas e
 * quebras de linha com backslash (comuns em curl copiado do Chrome/Postman).
 */
function tokenize(input: string): string[] {
  // Normaliza continuações de linha: "\" no fim da linha ou "^" (Windows cmd)
  const normalized = input
    .replace(/\\\r?\n/g, " ")
    .replace(/\^\r?\n/g, " ")
    .trim();

  const tokens: string[] = [];
  let current = "";
  let quoteChar: string | null = null;

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];

    if (quoteChar) {
      if (char === quoteChar) {
        quoteChar = null;
      } else if (char === "\\" && quoteChar === '"' && normalized[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quoteChar = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function stripCurlPrefix(tokens: string[]): string[] {
  // Remove "curl" do início, se presente
  if (tokens[0]?.toLowerCase() === "curl") {
    return tokens.slice(1);
  }
  return tokens;
}

function splitHeader(raw: string): ParsedHeader {
  const idx = raw.indexOf(":");
  if (idx === -1) {
    return { key: raw.trim(), value: "", enabled: true };
  }
  return {
    key: raw.slice(0, idx).trim(),
    value: raw.slice(idx + 1).trim(),
    enabled: true,
  };
}

function detectBodyType(headers: ParsedHeader[], body: string | null): ParsedCurlRequest["bodyType"] {
  if (!body) return "none";
  const contentType = headers.find(h => h.key.toLowerCase() === "content-type")?.value ?? "";
  if (contentType.includes("json")) return "json";
  if (contentType.includes("multipart/form-data")) return "form-data";
  if (contentType.includes("x-www-form-urlencoded")) return "x-www-form-urlencoded";
  return "raw";
}

function splitUrlAndParams(fullUrl: string): {
  baseUrl: string;
  queryParams: ParsedQueryParam[];
} {
  try {
    const url = new URL(fullUrl);
    const queryParams: ParsedQueryParam[] = [];
    url.searchParams.forEach((value, key) => {
      queryParams.push({ key, value, enabled: true });
    });
    url.search = "";
    return { baseUrl: url.toString(), queryParams };
  } catch {
    // URL relativa ou com variável de ambiente tipo {{baseUrl}}/foo?x=1
    const [base, query] = fullUrl.split("?");
    if (!query) return { baseUrl: fullUrl, queryParams: [] };
    const safeDecode = (v: string) => {
      try { return decodeURIComponent(v); } catch { return v; }
    };
    const queryParams = query.split("&").map(pair => {
      const [key, value = ""] = pair.split("=");
      return { key: safeDecode(key), value: safeDecode(value), enabled: true };
    });
    return { baseUrl: base, queryParams };
  }
}

/**
 * Parseia um comando curl (copiado do DevTools do Chrome, Postman, etc.)
 * para uma estrutura de request utilizável no client.
 */
export function parseCurl(input: string): ParsedCurlRequest {
  const tokens = stripCurlPrefix(tokenize(input));

  let method = "GET";
  let url = "";
  const headers: ParsedHeader[] = [];
  let body: string | null = null;
  let bodyExplicitlySet = false;
  let auth: ParsedCurlRequest["auth"];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    switch (token) {
      case "-X":
      case "--request":
        method = tokens[++i]?.toUpperCase() ?? method;
        break;

      case "-H":
      case "--header":
        headers.push(splitHeader(tokens[++i] ?? ""));
        break;

      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii": {
        const value = tokens[++i] ?? "";
        body = body ? `${body}&${value}` : value;
        bodyExplicitlySet = true;
        if (method === "GET") method = "POST"; // curl faz isso implicitamente
        break;
      }

      case "-u":
      case "--user": {
        const value = tokens[++i] ?? "";
        const [username, password] = value.split(":");
        auth = { type: "basic", username, password };
        break;
      }

      case "-b":
      case "--cookie":
        headers.push({ key: "Cookie", value: tokens[++i] ?? "", enabled: true });
        break;

      case "-A":
      case "--user-agent":
        headers.push({ key: "User-Agent", value: tokens[++i] ?? "", enabled: true });
        break;

      case "-e":
      case "--referer":
        headers.push({ key: "Referer", value: tokens[++i] ?? "", enabled: true });
        break;

      // flags booleanas comuns que não carregam valor — apenas ignora
      case "-k":
      case "--insecure":
      case "-i":
      case "--include":
      case "-s":
      case "--silent":
      case "-v":
      case "--verbose":
      case "-L":
      case "--location":
      case "--compressed":
        break;

      default:
        // Se não é uma flag conhecida e ainda não temos URL, assume que é a URL
        if (!token.startsWith("-") && !url) {
          url = token;
        }
        break;
    }
  }

  // Detecta Bearer token no header Authorization
  const authHeader = headers.find(h => h.key.toLowerCase() === "authorization");
  if (authHeader?.value.toLowerCase().startsWith("bearer ")) {
    auth = { type: "bearer", token: authHeader.value.slice(7).trim() };
  }

  const { baseUrl, queryParams } = splitUrlAndParams(url);
  const bodyType = bodyExplicitlySet ? detectBodyType(headers, body) : "none";

  return {
    method,
    url,
    baseUrl,
    headers,
    queryParams,
    body,
    bodyType,
    auth,
  };
}