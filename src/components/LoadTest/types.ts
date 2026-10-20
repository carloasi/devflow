// Espelha as structs Rust em src-tauri/src/load_test.rs (serde rename_all =
// "camelCase"). Mantenha os dois lados em sincronia manualmente — não há
// geração automática de tipos entre Rust e TS neste projeto.

export interface LoadTestKeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

export interface LoadTestAuthConfig {
  type: string; // 'none' | 'bearer' | 'basic' | 'apikey'
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  value?: string;
}

export interface LoadTestFlowStep {
  method: string;
  url: string;
  pathParams: LoadTestKeyValue[];
  headers: LoadTestKeyValue[];
  // Headers automáticos que a request desligou (ver lib/defaultHeaders.ts).
  disabledDefaultHeaders?: string[];
  body?: string;
  auth?: LoadTestAuthConfig;
  // Fase 3 — só post-response por enquanto (correlação: extrair um valor da
  // resposta e gravar no envMap do VU pra usar nos próximos passos do fluxo).
  postResponseScript?: string;
}

export interface LoadTestStage {
  targetVus: number;
  durationSecs: number;
}

export type ThresholdMetric = 'p50' | 'p90' | 'p95' | 'p99' | 'avg' | 'min' | 'max' | 'errorRate' | 'rps';
export type ThresholdOperator = '<' | '<=' | '>' | '>=';

export interface LoadTestThreshold {
  metric: ThresholdMetric;
  operator: ThresholdOperator;
  value: number;
}

export interface LoadTestThresholdResult extends LoadTestThreshold {
  actual: number;
  passed: boolean;
}

export interface LoadTestConfig {
  flow: LoadTestFlowStep[];
  // Ambiente base — semeia o envMap de cada VU (cada um evolui o seu próprio
  // depois, via post-response script).
  environment: Record<string, string>;
  // Modo constante — usado só quando `stages` está ausente/vazio.
  vus?: number;
  durationSecs?: number;
  iterationsPerVu?: number;
  // Modo ramp — se presente e não-vazio, tem prioridade sobre vus/duration.
  stages?: LoadTestStage[];
  thresholds?: LoadTestThreshold[];
  timeoutSecs?: number;
}

export interface LoadTestSnapshot {
  testId: string;
  elapsedMs: number;
  vusActive: number;
  requestsTotal: number;
  requestsOk: number;
  requestsFailed: number;
  rpsCurrent: number;
  rpsAvg: number;
  latencyMinMs: number;
  latencyAvgMs: number;
  latencyMaxMs: number;
  latencyP50Ms: number;
  latencyP90Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  // Chave é o status code como string (ex: "200") ou "error" pra falhas de
  // rede/timeout.
  statusCodes: Record<string, number>;
  // Post-response scripts que lançaram exceção — não abortam o teste, só
  // sinalizam que a correlação pode estar quebrada.
  scriptErrors: number;
  thresholdResults: LoadTestThresholdResult[];
  done: boolean;
}

export type LoadTestMode = 'duration' | 'iterations' | 'ramp';

export const THRESHOLD_METRICS: ThresholdMetric[] = ['p50', 'p90', 'p95', 'p99', 'avg', 'min', 'max', 'errorRate', 'rps'];
export const THRESHOLD_OPERATORS: ThresholdOperator[] = ['<', '<=', '>', '>='];

// ─── Fase 4: histórico de runs ─────────────────────────────────────────────
// Um registro por execução concluída (ou parada manualmente), guardado
// localmente (settings.json via save_local_store) por item.id, pra comparar
// runs anteriores da mesma request/pasta sem precisar re-configurar tudo.
export interface LoadTestRunRecord {
  id: string;
  itemId: string;
  itemName: string;
  startedAt: string; // ISO timestamp
  mode: LoadTestMode;
  config: LoadTestConfig;
  summary: LoadTestSnapshot;
}
