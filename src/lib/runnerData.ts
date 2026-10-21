// ─────────────────────────────────────────────────────────────────────────
// Tabela de dados para rodar um fluxo uma vez por linha.
//
// Existe porque o padrão de uso era duplicar a sessão. Num perfil real, cinco
// sessões chamadas "BPE bloqueio pagamento …" (passport, CPF, Mercosur…)
// referenciavam EXATAMENTE as mesmas cinco requests: era um fluxo só,
// copiado cinco vezes para variar um campo. Quatro famílias assim, doze das
// trinta e seis sessões. Com uma tabela, "mais um cenário" custa uma linha em
// vez de uma cópia que envelhece sozinha.
//
// O parser é escrito à mão, e não um `split(',')`, porque planilha de caso de
// teste tem vírgula dentro de campo, aspas e quebra de linha no meio de uma
// célula. Split ingênuo não falha: ele desloca as colunas em silêncio, e o
// teste roda com os dados errados.
// ─────────────────────────────────────────────────────────────────────────

export interface DataSet {
  columns: string[];
  rows: Record<string, string>[];
}

export type DataParseResult = { ok: true; data: DataSet } | { ok: false; error: string };

/** Até onde uma linha de cabeçalho é dividida por cada candidato. */
const DELIMITERS = [',', ';', '\t'] as const;

/**
 * Descobre o separador pelo cabeçalho.
 *
 * Excel em português exporta com `;`, e o resto do mundo com `,`. Exigir um
 * só obrigaria a converter o arquivo antes — e quem converte erra.
 */
export function detectDelimiter(headerLine: string): string {
  let best = ',';
  let bestCount = 0;

  for (const d of DELIMITERS) {
    // Conta só fora de aspas: `"Smith, John";42` tem uma vírgula que não separa.
    let count = 0;
    let quoted = false;
    for (let i = 0; i < headerLine.length; i++) {
      const ch = headerLine[i];
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }

  return best;
}

/** Divide o texto inteiro em células, respeitando aspas e quebras dentro delas. */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        // `""` dentro de campo com aspas é uma aspa literal.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      records.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  // Última linha sem quebra no fim.
  if (field !== '' || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  return records;
}

export function parseCsv(text: string): DataParseResult {
  // BOM do Excel: se ficar, o nome da primeira coluna vira "﻿id" e
  // nenhuma {{id}} resolve.
  const clean = text.replace(/^﻿/, '');
  if (!clean.trim()) return { ok: false, error: 'The file is empty.' };

  const firstLineEnd = clean.search(/\r?\n/);
  const headerLine = firstLineEnd < 0 ? clean : clean.slice(0, firstLineEnd);
  const records = splitRecords(clean, detectDelimiter(headerLine));

  if (records.length === 0) return { ok: false, error: 'The file is empty.' };

  const columns = records[0].map(c => c.trim());
  if (columns.every(c => c === '')) return { ok: false, error: 'The header row has no column names.' };

  const rows: Record<string, string>[] = [];
  for (const record of records.slice(1)) {
    // Linha em branco no fim do arquivo é ruído de editor, não um caso.
    if (record.every(cell => cell.trim() === '')) continue;

    const row: Record<string, string> = {};
    columns.forEach((name, i) => {
      if (name) row[name] = record[i] ?? '';
    });
    rows.push(row);
  }

  if (rows.length === 0) return { ok: false, error: 'The file has a header but no rows.' };

  return { ok: true, data: { columns: columns.filter(Boolean), rows } };
}

export function parseJsonRows(text: string): DataParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Expected an array of objects, one per iteration.' };
  }
  if (parsed.length === 0) return { ok: false, error: 'The array is empty.' };

  const columns: string[] = [];
  const rows: Record<string, string>[] = [];

  for (const [i, item] of parsed.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `Item ${i + 1} is not an object.` };
    }
    const row: Record<string, string> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (!columns.includes(key)) columns.push(key);
      // Variável de ambiente é texto. Objeto vira JSON para caber num
      // {{campo}} usado dentro de um body.
      row[key] =
        value === null || value === undefined
          ? ''
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
    }
    rows.push(row);
  }

  return { ok: true, data: { columns, rows } };
}

export function parseDataFile(text: string, fileName = ''): DataParseResult {
  // Pela extensão quando dá; senão, pelo conteúdo — um arquivo arrastado de
  // outro lugar pode não ter extensão nenhuma.
  const looksJson = /\.json$/i.test(fileName) || /^\s*\[/.test(text.replace(/^﻿/, ''));
  return looksJson ? parseJsonRows(text) : parseCsv(text);
}

/**
 * Como a linha aparece no relatório.
 *
 * O valor da primeira coluna, porque numa planilha de caso de teste ela é o
 * identificador do cenário ("passport válido"). Vazio cai no número, que ao
 * menos localiza a linha no arquivo.
 */
export function rowLabel(row: Record<string, string>, columns: string[], index: number): string {
  const first = columns[0] ? row[columns[0]]?.trim() : '';
  return first || `Row ${index + 1}`;
}

/**
 * Ambiente de uma iteração: a base, com a linha por cima.
 *
 * A linha vence porque é o que distingue este caso dos outros — se o
 * environment já tiver `cpf`, o da tabela é o que vale.
 */
export function envForRow(
  baseEnv: Record<string, string>,
  row: Record<string, string>
): Record<string, string> {
  return { ...baseEnv, ...row };
}
