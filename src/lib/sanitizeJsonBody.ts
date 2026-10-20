import { stripComments } from 'jsonc-parser';

// O editor de body (HttpBodyEditor.tsx) configura o Monaco com
// `allowComments: true` e `trailingCommas: 'ignore'` só pra deixar o
// usuário digitar/documentar o JSON mais livremente (comentários "//" e
// "/* */", vírgula sobrando antes de "}"/"]") — mas nada disso é JSON
// válido de verdade. Sem limpar antes de usar, o servidor de destino
// recebia esse texto quebrado no body de verdade, e
// JSON.parse(pm.request.body.raw) nos scripts pre/post-response quebrava
// igual (ver "Expected property name or '}' in JSON at position ...").
//
// stripComments (jsonc-parser) é string-aware — não mexe em "//" que
// apareça DENTRO de um valor de string (ex: "http://exemplo.com"), só
// remove comentário de verdade. A troca de vírgula sobrando é um regex
// simples porque nesse ponto o texto já não tem mais comentários no meio.
export function sanitizeJsonBodyForSend(rawBody: string): string {
  if (!rawBody) return rawBody;
  const withoutComments = stripComments(rawBody);
  return withoutComments.replace(/,(\s*[}\]])/g, '$1');
}
