// ─────────────────────────────────────────────────────────────────────────
// Geração de snippet de código a partir de uma request já RESOLVIDA.
//
// A entrada é o mesmo material que o generateCurl do AppLayout monta: URL com
// {{variáveis}} e :path params já substituídos, headers finais (incluindo os
// de auth) e o body resolvido. Este módulo não sabe nada de aba, environment
// ou collection de propósito — é função pura, e é o que permite testá-lo.
//
// O ponto delicado aqui é ESCAPE. Um snippet que não cola e roda não serve
// pra nada, e cada linguagem quebra de um jeito diferente com aspas, quebra
// de linha e barra invertida dentro do body.
// ─────────────────────────────────────────────────────────────────────────

export interface SnippetRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Corpo já resolvido. Vazio ou ausente = request sem corpo. */
  body?: string;
}

export type SnippetLanguage =
  | 'curl'
  | 'javascript'
  | 'python'
  | 'csharp'
  | 'powershell';

export const SNIPPET_LANGUAGES: { id: SnippetLanguage; label: string; editorLanguage: string }[] = [
  { id: 'curl', label: 'cURL', editorLanguage: 'shell' },
  { id: 'javascript', label: 'JavaScript (fetch)', editorLanguage: 'javascript' },
  { id: 'python', label: 'Python (requests)', editorLanguage: 'python' },
  { id: 'csharp', label: 'C# (HttpClient)', editorLanguage: 'csharp' },
  { id: 'powershell', label: 'PowerShell', editorLanguage: 'powershell' },
];

const hasBody = (req: SnippetRequest): boolean => !!req.body && req.body.trim().length > 0;

// Em shell, aspas simples não interpretam NADA — então basta tratar a própria
// aspa simples. O truque é fechar a string, emitir uma aspa escapada e
// reabrir: ' -> '\''
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// JSON.stringify produz um literal válido em JavaScript, Python e C# ao mesmo
// tempo: os três entendem \", \\, \n e \uXXXX com o mesmo significado. É o
// que evita escrever três escapadores quase idênticos e errar em um deles.
function quoted(value: string): string {
  return JSON.stringify(value);
}

// Em PowerShell, aspas simples também não interpolam ($ e ` ficam literais) e
// a aspa simples é escapada dobrando.
function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function curlSnippet(req: SnippetRequest): string {
  const parts = [`curl --location ${shellSingleQuote(req.url)}`];
  if (req.method.toUpperCase() !== 'GET') parts.push(`--request ${req.method.toUpperCase()}`);
  for (const [key, value] of Object.entries(req.headers)) {
    parts.push(`--header ${shellSingleQuote(`${key}: ${value}`)}`);
  }
  if (hasBody(req)) parts.push(`--data-raw ${shellSingleQuote(req.body!)}`);
  return parts.join(' \\\n  ');
}

function javascriptSnippet(req: SnippetRequest): string {
  const lines: string[] = [];
  const headerEntries = Object.entries(req.headers);

  lines.push(`const response = await fetch(${quoted(req.url)}, {`);
  lines.push(`  method: ${quoted(req.method.toUpperCase())},`);

  if (headerEntries.length > 0) {
    lines.push('  headers: {');
    for (const [key, value] of headerEntries) {
      lines.push(`    ${quoted(key)}: ${quoted(value)},`);
    }
    lines.push('  },');
  }

  if (hasBody(req)) lines.push(`  body: ${quoted(req.body!)},`);

  lines.push('});');
  lines.push('');
  lines.push('console.log(await response.text());');
  return lines.join('\n');
}

function pythonSnippet(req: SnippetRequest): string {
  const lines: string[] = ['import requests', ''];
  const headerEntries = Object.entries(req.headers);

  lines.push(`url = ${quoted(req.url)}`);

  if (headerEntries.length > 0) {
    lines.push('headers = {');
    for (const [key, value] of headerEntries) {
      lines.push(`    ${quoted(key)}: ${quoted(value)},`);
    }
    lines.push('}');
  } else {
    lines.push('headers = {}');
  }

  const args = ['url', 'headers=headers'];
  if (hasBody(req)) {
    // encode() porque requests manda str como latin-1; com UTF-8 no corpo
    // isso quebraria em acento.
    lines.push(`payload = ${quoted(req.body!)}`);
    args.push('data=payload.encode("utf-8")');
  }

  lines.push('');
  lines.push(`response = requests.${req.method.toLowerCase()}(${args.join(', ')})`);
  lines.push('print(response.text)');
  return lines.join('\n');
}

function csharpSnippet(req: SnippetRequest): string {
  const lines: string[] = [
    'using var client = new HttpClient();',
    `using var request = new HttpRequestMessage(new HttpMethod(${quoted(req.method.toUpperCase())}), ${quoted(req.url)});`,
  ];

  // Content-Type não entra em request.Headers no HttpClient: ele pertence ao
  // conteúdo, e tentar adicioná-lo ali lança InvalidOperationException em
  // tempo de execução. Por isso ele é separado e vai no StringContent.
  let contentType = 'application/json';
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === 'content-type') {
      contentType = value.split(';')[0].trim();
      continue;
    }
    lines.push(`request.Headers.Add(${quoted(key)}, ${quoted(value)});`);
  }

  if (hasBody(req)) {
    lines.push(
      `request.Content = new StringContent(${quoted(req.body!)}, Encoding.UTF8, ${quoted(contentType)});`
    );
  }

  lines.push('');
  lines.push('var response = await client.SendAsync(request);');
  lines.push('Console.WriteLine(await response.Content.ReadAsStringAsync());');
  return lines.join('\n');
}

function powershellSnippet(req: SnippetRequest): string {
  const lines: string[] = [];
  const headerEntries = Object.entries(req.headers);

  if (headerEntries.length > 0) {
    lines.push('$headers = @{');
    for (const [key, value] of headerEntries) {
      lines.push(`    ${psSingleQuote(key)} = ${psSingleQuote(value)}`);
    }
    lines.push('}');
  }

  const args = [`-Uri ${psSingleQuote(req.url)}`, `-Method ${req.method.toUpperCase()}`];
  if (headerEntries.length > 0) args.push('-Headers $headers');

  if (hasBody(req)) {
    // Here-string de aspas simples: preserva quebra de linha e não interpola
    // $ nem crase. O terminador precisa começar na coluna 0, por isso ele
    // não é indentado junto com o resto.
    lines.push("$body = @'");
    lines.push(req.body!);
    lines.push("'@");
    args.push('-Body $body');
  }

  lines.push(`Invoke-RestMethod ${args.join(' ')}`);
  return lines.join('\n');
}

export function generateSnippet(req: SnippetRequest, language: SnippetLanguage): string {
  switch (language) {
    case 'curl':
      return curlSnippet(req);
    case 'javascript':
      return javascriptSnippet(req);
    case 'python':
      return pythonSnippet(req);
    case 'csharp':
      return csharpSnippet(req);
    case 'powershell':
      return powershellSnippet(req);
  }
}
