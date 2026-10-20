import { describe, it, expect } from 'vitest';
import { generateSnippet, SNIPPET_LANGUAGES, type SnippetRequest } from './codeSnippets';

// Request hostil de propósito: aspas simples e duplas, quebra de linha, barra
// invertida, acento e cifrão (que o PowerShell interpolaria). É onde
// geradores de snippet costumam quebrar.
const nasty: SnippetRequest = {
  method: 'post',
  url: "https://api.exemplo.com/v1/it's?q=a b&x=1",
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Note': `aspa' dupla" barra\\ fim`,
    Authorization: 'Bearer abc.def',
  },
  body: `{\n  "nome": "José O'Brien",\n  "path": "C:\\\\temp",\n  "valor": "$PATH"\n}`,
};

const simple: SnippetRequest = { method: 'GET', url: 'https://api.exemplo.com/health', headers: {} };

// Desfaz o quoting POSIX de aspas simples, como o shell faria. Vale mais que
// inspecionar a saída a olho: prova que o argumento chega ao programa
// exatamente como entrou.
function shellUnquote(token: string): string {
  let out = '';
  let i = 0;
  if (token[i] !== "'") throw new Error('não começa com aspa');
  i++;
  while (i < token.length) {
    const c = token[i];
    if (c === "'") {
      if (token.slice(i, i + 4) === "'\\''") {
        out += "'";
        i += 4;
        continue;
      }
      i++;
      if (i !== token.length) throw new Error('lixo após o fechamento: ' + token.slice(i));
      return out;
    }
    out += c;
    i++;
  }
  throw new Error('aspa não fechada');
}

const token = (s: string) => s.trim().replace(/\s*\\$/, '');

describe('generateSnippet', () => {
  it.each(SNIPPET_LANGUAGES.map(l => l.id))('%s produz saída', id => {
    expect(generateSnippet(nasty, id).length).toBeGreaterThan(20);
  });

  describe('cURL', () => {
    const curl = generateSnippet(nasty, 'curl');

    it('a URL sobrevive ao round-trip do shell', () => {
      expect(shellUnquote(token(curl.split('\n')[0].replace('curl --location ', '')))).toBe(nasty.url);
    });

    it('o corpo sobrevive ao round-trip do shell', () => {
      expect(shellUnquote(token(curl.split('--data-raw ')[1]))).toBe(nasty.body);
    });

    it('header com aspas sobrevive', () => {
      const line = curl.split('\n').find(l => l.includes('X-Note'))!;
      expect(shellUnquote(token(line.replace('--header ', '')))).toBe(`X-Note: ${nasty.headers['X-Note']}`);
    });

    it('usa o método em maiúsculo e omite --request em GET', () => {
      expect(curl).toContain('--request POST');
      expect(generateSnippet(simple, 'curl')).not.toContain('--request');
    });
  });

  describe('JavaScript', () => {
    const js = generateSnippet(nasty, 'javascript');

    it('o corpo é um literal de string válido', () => {
      // [\s\S] em vez da flag /s: o target do tsconfig é anterior ao es2018,
      // que é quando dotAll apareceu.
      const literal = js.match(/body: ("[\s\S]*")/)![1];
      expect(() => new Function('return ' + literal)).not.toThrow();
    });

    it('escapa a quebra de linha em vez de deixá-la literal', () => {
      expect(js).toContain('\\n');
    });
  });

  describe('Python', () => {
    const py = generateSnippet(nasty, 'python');

    it('usa o verbo certo do requests', () => expect(py).toContain('requests.post('));

    // requests manda str como latin-1; sem o encode, acento quebra.
    it('codifica o corpo em utf-8', () => expect(py).toContain('encode("utf-8")'));
  });

  describe('C#', () => {
    const cs = generateSnippet(nasty, 'csharp');

    // Content-Type pertence ao conteúdo; em request.Headers o HttpClient
    // lança InvalidOperationException em runtime.
    it('não põe Content-Type em request.Headers', () => {
      expect(cs).not.toContain('request.Headers.Add("Content-Type"');
    });

    it('põe Content-Type no StringContent', () => expect(cs).toContain('"application/json")'));
    it('mantém os demais headers', () => expect(cs).toContain('request.Headers.Add("X-Note"'));
  });

  describe('PowerShell', () => {
    const ps = generateSnippet(nasty, 'powershell');

    it('dobra a aspa simples', () => expect(ps).toContain("it''s"));

    // Here-string de aspas simples não interpola: $PATH precisa sair literal.
    it('usa here-string e não interpola o corpo', () => {
      expect(ps).toContain("@'");
      expect(ps).toContain('"valor": "$PATH"');
    });

    it('fecha o here-string na coluna 0', () => {
      expect(ps.split('\n').some(l => l === "'@")).toBe(true);
    });
  });

  describe('request sem corpo', () => {
    it.each(SNIPPET_LANGUAGES.map(l => l.id))('%s não inventa corpo', id => {
      expect(generateSnippet(simple, id)).not.toMatch(/--data-raw|body:|payload|StringContent|-Body/);
    });
  });
});
