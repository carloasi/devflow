import { ClaudeMessage } from './useClaudeChat';

// Conversas do painel do Claude, persistidas em localStorage. Sem isso,
// fechar o app (ou clicar em "nova conversa") jogava fora as perguntas e as
// respostas — inclusive resultados de execução que valia a pena reler.
const STORAGE_KEY = 'devflow_claude_conversations';
// Teto pra não crescer sem limite: bodies de resposta citados numa conversa
// podem ser grandes, e localStorage costuma ficar na casa de 5MB.
const MAX_CONVERSATIONS = 30;

export interface ClaudeConversation {
  id: string;
  title: string;
  updatedAt: number;
  // Id da sessão do CLI, pra reabrir uma conversa e continuar com --resume
  // em vez de recomeçar do zero.
  sessionId: string | null;
  messages: ClaudeMessage[];
}

function readAll(): ClaudeConversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Erro ao ler conversas do Claude:', e);
    return [];
  }
}

function writeAll(conversations: ClaudeConversation[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.slice(0, MAX_CONVERSATIONS)));
  } catch (e) {
    // Cota estourada: derruba as mais antigas e tenta de novo antes de
    // desistir, senão o painel silenciosamente para de salvar.
    console.error('Erro ao salvar conversas do Claude:', e);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.slice(0, 5)));
    } catch {
      /* desiste: a conversa segue funcionando, só não persiste */
    }
  }
}

export function listConversations(): ClaudeConversation[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

// Título derivado da primeira pergunta — é o que identifica a conversa na
// lista sem precisar pedir nome pro usuário.
export function deriveTitle(messages: ClaudeMessage[]): string {
  const firstUser = messages.find(m => m.role === 'user');
  const text = firstUser?.text.trim() ?? 'Conversation';
  const singleLine = text.replace(/\s+/g, ' ');
  return singleLine.length > 60 ? `${singleLine.slice(0, 60)}…` : singleLine;
}

export function saveConversation(conversation: ClaudeConversation): void {
  const all = readAll().filter(c => c.id !== conversation.id);
  writeAll([conversation, ...all].sort((a, b) => b.updatedAt - a.updatedAt));
}

export function deleteConversation(id: string): void {
  writeAll(readAll().filter(c => c.id !== id));
}

export function clearConversations(): void {
  writeAll([]);
}
