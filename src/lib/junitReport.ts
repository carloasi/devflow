import type { TestResult } from '@/app/types/TestResult';

// ─────────────────────────────────────────────────────────────────────────
// Relatório JUnit XML de uma execução do runner.
//
// JUnit porque é o formato que praticamente todo CI lê nativamente — GitHub
// Actions, GitLab, Jenkins, Azure DevOps. Sem isso, um runner que roda numa
// esteira só consegue dizer "passou" ou "não passou" em texto, e ninguém vê
// qual asserção quebrou sem abrir o log.
//
// Módulo puro, sem React nem Tauri: é testável, e é o mesmo gerador que o
// runner em linha de comando vai usar.
// ─────────────────────────────────────────────────────────────────────────

export interface JUnitRequest {
  /** Nome da request, como aparece na árvore. */
  name: string;
  method?: string;
  /** Iteração, quando o runner roda a collection mais de uma vez. */
  iteration?: number;
  durationMs: number;
  tests: TestResult[];
  /** Falha da própria request (rede, status, erro de script), se houve. */
  failure?: string;
}

export interface JUnitRun {
  suiteName: string;
  requests: JUnitRequest[];
  timestamp?: Date;
}

// XML não aceita estes caracteres crus em texto nem em atributo. Sem escapar,
// um corpo de resposta com "<" ou um & numa querystring produz um arquivo que
// o CI recusa a ler — e o resultado some sem explicação.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Caracteres de controle são proibidos em XML 1.0 mesmo escapados. Aparecem
// em corpo binário ou resposta truncada, e invalidariam o arquivo inteiro.
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

const clean = (value: string) => escapeXml(stripControlChars(value));

function caseName(req: JUnitRequest): string {
  const method = req.method ? `${req.method.toUpperCase()} ` : '';
  const iteration = req.iteration && req.iteration > 1 ? ` (#${req.iteration})` : '';
  return `${method}${req.name}${iteration}`;
}

export function buildJUnitXml(run: JUnitRun): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];

  let tests = 0;
  let failures = 0;
  let totalMs = 0;
  const body: string[] = [];

  for (const req of run.requests) {
    totalMs += req.durationMs;
    const seconds = (req.durationMs / 1000).toFixed(3);
    const classname = clean(caseName(req));

    // A request falhar é, ela própria, um caso de teste: senão uma collection
    // que nem chegou a responder apareceria como "0 testes, tudo certo".
    if (req.failure) {
      tests++;
      failures++;
      body.push(`    <testcase classname="${classname}" name="request" time="${seconds}">`);
      body.push(`      <failure message="${clean(req.failure.split('\n')[0])}">${clean(req.failure)}</failure>`);
      body.push('    </testcase>');
    }

    for (const t of req.tests) {
      tests++;
      const name = clean(t.name);
      if (t.passed) {
        body.push(`    <testcase classname="${classname}" name="${name}" time="${seconds}" />`);
      } else {
        failures++;
        body.push(`    <testcase classname="${classname}" name="${name}" time="${seconds}">`);
        body.push(`      <failure message="${clean(t.message || 'assertion failed')}" />`);
        body.push('    </testcase>');
      }
    }
  }

  const timestamp = (run.timestamp ?? new Date()).toISOString();
  lines.push('<testsuites>');
  lines.push(
    `  <testsuite name="${clean(run.suiteName)}" tests="${tests}" failures="${failures}" errors="0" ` +
      `time="${(totalMs / 1000).toFixed(3)}" timestamp="${timestamp}">`
  );
  lines.push(...body);
  lines.push('  </testsuite>');
  lines.push('</testsuites>');

  return lines.join('\n');
}
