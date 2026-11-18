// ─────────────────────────────────────────────────────────────────────────
// Nome do example criado por "Save this response as an example".
//
// Só o status ("400 Bad Request") deixava vários examples da mesma request
// com o mesmo nome — e o que distingue um cenário do outro costuma ser a
// mensagem da notificação que a API devolve ("CPF inválido", "Voo
// esgotado"...). Ela entra junto do status:
//
//   400 Bad Request - CPF inválido
// ─────────────────────────────────────────────────────────────────────────

/** Acima disto a mensagem é cortada: é um nome na árvore, não o body. */
const MAX_MESSAGE = 120;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Valor da chave sem diferenciar maiúsculas ("Notifications", "notifications"). */
function pick(obj: Record<string, unknown>, key: string): unknown {
  const found = Object.keys(obj).find(k => k.toLowerCase() === key);
  return found === undefined ? undefined : obj[found];
}

function messageOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.trim() || null;
  if (!isRecord(entry)) return null;
  const message = pick(entry, 'message');
  return typeof message === 'string' && message.trim() ? message.trim() : null;
}

/**
 * As mensagens das notificações do body: `notifications: [{ message }]` ou
 * `notification: { message }` — no topo ou dentro de `data`/`result`.
 */
export function notificationMessages(body: unknown): string[] {
  let parsed = body;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  const scopes: Record<string, unknown>[] = [];
  if (isRecord(parsed)) {
    scopes.push(parsed);
    for (const key of ['data', 'result']) {
      const inner = pick(parsed, key);
      if (isRecord(inner)) scopes.push(inner);
    }
  }
  for (const scope of scopes) {
    const list = pick(scope, 'notifications');
    const single = pick(scope, 'notification');
    const entries = Array.isArray(list) ? list : single !== undefined ? [single] : [];
    const messages = entries.map(messageOf).filter((m): m is string => !!m);
    if (messages.length > 0) return messages;
  }
  return [];
}

/** "400 Bad Request - CPF inválido" (ou só o status, sem notificação). */
export function exampleNameFor(status: number, statusText: string, body: unknown): string {
  const head = `${status} ${statusText}`.trim();
  const messages = notificationMessages(body);
  if (messages.length === 0) return head;
  let message = messages[0].replace(/\s+/g, ' ');
  if (message.length > MAX_MESSAGE) message = `${message.slice(0, MAX_MESSAGE - 1)}…`;
  const more = messages.length > 1 ? ` (+${messages.length - 1})` : '';
  return `${head} - ${message}${more}`;
}
