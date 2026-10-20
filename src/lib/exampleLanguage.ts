// Formato do body de um Saved Example — os que o editor de example oferece.
export type ExampleLanguage = 'json' | 'xml' | 'html' | 'text';

const KNOWN: ExampleLanguage[] = ['json', 'xml', 'html', 'text'];

// O Postman grava `_postman_previewlanguage` com valores como "json", "xml",
// "html", "text" e às vezes "javascript" — ou nem grava. Normaliza pros
// quatro do editor; sem valor reconhecido, deduz pelo Content-Type e, por
// último, pelo próprio body.
export function normalizeExampleLanguage(
  language: unknown,
  headers: { key: string; value: string }[] = [],
  body = ''
): ExampleLanguage {
  const given = String(language ?? '').trim().toLowerCase();
  if ((KNOWN as string[]).includes(given)) return given as ExampleLanguage;

  const contentType = headers.find(h => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('xml')) return 'xml';
  if (contentType.includes('html')) return 'html';

  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Parece JSON mas não é (comentário, template) — segue pras outras.
    }
  }
  if (/^<!doctype html|^<html/i.test(trimmed)) return 'html';
  if (trimmed.startsWith('<')) return 'xml';
  return given === 'javascript' ? 'text' : trimmed ? 'text' : 'json';
}
