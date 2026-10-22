import type { RunEntry } from '@/components/CollectionRunner/runCollectionRequest';

// ─────────────────────────────────────────────────────────────────────────
// Export de uma execução do runner com o fluxo inteiro: cada passo com o que
// foi enviado, o que voltou, testes, variáveis gravadas, console e QUANDO
// rodou.
//
// Complementa o JUnit, que é pra CI e só carrega nome, duração e asserções.
// Este é pra gente: anexar num card, mandar pra quem mantém a API ou
// comparar dois runs — e pra isso o horário de cada passo importa (logs do
// servidor são procurados por horário, não por nome de request).
//
// Módulo puro, sem React nem Tauri, pra ser testável.
// ─────────────────────────────────────────────────────────────────────────

export interface RunReportInput {
  collectionName: string;
  environmentName?: string;
  /** ISO. */
  startedAt?: string;
  /** ISO. */
  finishedAt?: string;
  entries: RunEntry[];
  /** Diz se o passo falhou — injetado pra usar o mesmo veredito da tela. */
  isFailure: (entry: RunEntry) => boolean;
  failureReason: (entry: RunEntry) => string;
}

export function buildRunReport(input: RunReportInput) {
  const { entries, isFailure } = input;
  const ran = entries.filter(e => e.outcome);
  const failed = ran.filter(isFailure).length;
  const tests = ran.flatMap(e => e.outcome!.tests);

  // Sem os dois horários do run (gravado antes desta versão), a duração vem
  // dos passos — melhor um número aproximado que nenhum.
  const startedAt = input.startedAt ?? ran.find(e => e.startedAt)?.startedAt;
  const finishedAt = input.finishedAt ?? [...ran].reverse().find(e => e.finishedAt)?.finishedAt;
  const durationMs =
    startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : undefined;

  return {
    collection: input.collectionName,
    environment: input.environmentName ?? null,
    exportedAt: new Date().toISOString(),
    startedAt: startedAt ?? null,
    finishedAt: finishedAt ?? null,
    durationMs: durationMs ?? null,
    summary: {
      steps: entries.length,
      executed: ran.length,
      // 'pending' que sobrou = Stop no meio; sem isto um run interrompido
      // pareceria completo no arquivo.
      notExecuted: entries.length - ran.length,
      passed: ran.length - failed,
      failed,
      tests: { total: tests.length, passed: tests.filter(t => t.passed).length },
    },
    steps: entries.map((e, index) => {
      const o = e.outcome;
      return {
        order: index + 1,
        iteration: e.iteration,
        rowLabel: e.rowLabel ?? null,
        name: e.name,
        method: o?.sentMethod ?? e.method ?? null,
        result: !o ? 'not-executed' : isFailure(e) ? 'failed' : 'passed',
        startedAt: e.startedAt ?? null,
        finishedAt: e.finishedAt ?? null,
        responseTimeMs: o?.responseTime ?? null,
        failure: o && isFailure(e) ? input.failureReason(e) : null,
        request: o
          ? {
              url: o.resolvedUrl ?? null,
              headers: o.sentHeaders ?? {},
              body: o.sentBody ?? null,
            }
          : null,
        response: o
          ? {
              status: o.httpStatus ?? null,
              error: o.errorMessage ?? null,
              sizeBytes: o.responseSize ?? null,
              body: o.fullResponseBody || o.responseBodySnippet || null,
            }
          : null,
        tests: o?.tests ?? [],
        variablesSet: o?.variablesSet ?? [],
        scriptError: o?.scriptError ?? null,
        console: o?.logs ?? [],
      };
    }),
  };
}

export type RunReport = ReturnType<typeof buildRunReport>;
