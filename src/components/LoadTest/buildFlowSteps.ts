import { CollectionItem } from '@/app/types/CollectionItem';
import { LoadTestFlowStep } from './types';
import { requestHasBody } from '@/lib/defaultHeaders';

// Conversão puramente estrutural CollectionItem[] -> LoadTestFlowStep[] — SEM
// resolver {{variáveis}} ou :pathParams aqui. A partir da Fase 3 isso é feito
// no lado Rust, por VU, a cada request do fluxo (porque o envMap de cada VU
// evolui durante o fluxo via post-response script, então resolver uma vez só
// no frontend não é mais suficiente).
export function buildFlowSteps(items: CollectionItem[]): LoadTestFlowStep[] {
  return items
    // gRPC ainda não entra no motor de carga (que é só HTTP).
    .filter(item => !!item.request && item.protocol !== 'grpc')
    .map((item): LoadTestFlowStep => {
      const req = item.request!;
      const auth = req.auth as any;

      return {
        method: item.method || 'GET',
        url: req.url || '',
        pathParams: (req.urlexport?.variable || []).map(p => ({
          key: p.key,
          value: p.value || '',
          enabled: p.enabled !== false,
        })),
        headers: (req.headers || []).map(h => ({
          key: h.key,
          value: h.value || '',
          enabled: h.enabled !== false,
        })),
        disabledDefaultHeaders: req.disabledDefaultHeaders ?? [],
        // bodyType 'none' não manda body (mesma regra do envio normal).
        body: requestHasBody(req.bodyType, req.body) ? req.body : undefined,
        auth: auth
          ? {
              type: auth.type,
              token: auth.token,
              username: auth.username,
              password: auth.password,
              key: auth.key,
              value: auth.value,
            }
          : undefined,
        postResponseScript: req.scripts?.postResponse?.trim() ? req.scripts.postResponse : undefined,
      };
    });
}
