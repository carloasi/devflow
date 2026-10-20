// Superseded pela Fase 3: a resolução de {{variáveis}} e :pathParams agora é
// feita no lado Rust, por VU, a cada request do fluxo (necessário porque o
// envMap de cada VU evolui durante o fluxo via post-response script — não dá
// mais pra resolver tudo de uma vez só no frontend como nas Fases 1/2).
// Este arquivo fica só como redirecionamento pra quem ainda importar pelo
// nome antigo; a lógica real está em ./buildFlowSteps.ts.
export { buildFlowSteps as resolveLoadTestRequest } from './buildFlowSteps';
