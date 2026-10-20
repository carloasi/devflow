// ─────────────────────────────────────────────────────────────────────────
// Criptografia do conteúdo sincronizado com o GitHub.
//
// O formato ANTIGO derivava a chave de uma constante embutida no código. Isso
// nunca protegeu nada de verdade — a constante já viajava dentro do binário —
// e com o código aberto passaria a ser pública, tornando legível qualquer
// repositório sincronizado pelo app a que alguém tivesse acesso de leitura.
//
// O formato novo deriva a chave de uma SENHA do usuário, guardada no
// armazenamento seguro do SO. Quem não tem a senha não lê o repositório.
//
// ── Compatibilidade ──────────────────────────────────────────────────────
// O conteúdo novo é marcado com um prefixo de versão. Na leitura:
//   "DFv2:" presente  -> chave derivada da senha (formato novo)
//   sem prefixo       -> chave legada embutida (formato antigo)
// Assim repositórios existentes continuam legíveis, e cada push vai
// reescrevendo os arquivos no formato novo — sem um momento de migração
// forçada em que algo poderia se perder.
//
// A chave legada permanece aqui SÓ PARA LEITURA, de propósito: ela não
// protege nada que já não estivesse exposto, e removê-la tornaria ilegível o
// que já foi sincronizado.
// ─────────────────────────────────────────────────────────────────────────

const LEGACY_SECRET = 'PostmanClone@2026!SecureKey#Global';
const LEGACY_SALT = 'postman-clone-github-sync-salt';
const LEGACY_ITERATIONS = 100_000;

const V2_PREFIX = 'DFv2:';
const V2_SALT_BYTES = 16;
const IV_BYTES = 12;
// Bem acima das 100k do formato antigo: a derivação acontece uma vez por
// sessão (ver cache abaixo), então o custo não aparece por arquivo.
const V2_ITERATIONS = 600_000;

export class MissingPassphraseError extends Error {
  constructor() {
    super('No sync passphrase is set. Add one in GitHub Sync settings.');
    this.name = 'MissingPassphraseError';
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Could not decrypt with the current sync passphrase.');
    this.name = 'WrongPassphraseError';
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(
  secret: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// 600k iterações custam centenas de ms. Um push toca vários arquivos, e
// derivar por arquivo deixaria o sync lento sem ganhar segurança nenhuma —
// a chave é a mesma. O cache guarda a última derivação por (senha, salt).
let cached: { secret: string; saltB64: string; key: CryptoKey } | null = null;

async function deriveV2Key(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const saltB64 = toBase64(salt);
  if (cached && cached.secret === passphrase && cached.saltB64 === saltB64) {
    return cached.key;
  }
  const key = await deriveKey(passphrase, salt, V2_ITERATIONS);
  cached = { secret: passphrase, saltB64, key };
  return key;
}

/** Esquece a chave derivada — usar ao trocar de senha ou ao desconectar. */
export function clearDerivedKeyCache(): void {
  cached = null;
}

/** true quando o conteúdo está no formato novo (exige senha pra ler). */
export function isV2(cipherText: string): boolean {
  return cipherText.trimStart().startsWith(V2_PREFIX);
}

export async function encryptData(data: unknown, passphrase: string): Promise<string> {
  if (!passphrase) throw new MissingPassphraseError();

  // O salt viaja dentro de cada arquivo, pra outra máquina derivar a mesma
  // chave tendo só a senha. Dentro de uma sessão ele é REAPROVEITADO: um push
  // grava vários arquivos, e sortear um salt por arquivo forçaria uma
  // derivação de 600k iterações em cada um — segundos de espera sem ganho,
  // já que o IV, esse sim sorteado por arquivo, é o que garante cifras
  // diferentes para conteúdos iguais.
  const salt =
    cached && cached.secret === passphrase
      ? fromBase64(cached.saltB64)
      : crypto.getRandomValues(new Uint8Array(V2_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveV2Key(passphrase, salt);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(data))
  );

  const payload = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  payload.set(salt, 0);
  payload.set(iv, salt.length);
  payload.set(new Uint8Array(encrypted), salt.length + iv.length);

  return V2_PREFIX + toBase64(payload);
}

export async function decryptData(
  cipherText: string,
  passphrase: string | null
): Promise<unknown> {
  const trimmed = cipherText.trim();

  if (trimmed.startsWith(V2_PREFIX)) {
    if (!passphrase) throw new MissingPassphraseError();

    const payload = fromBase64(trimmed.slice(V2_PREFIX.length));
    const salt = payload.slice(0, V2_SALT_BYTES);
    const iv = payload.slice(V2_SALT_BYTES, V2_SALT_BYTES + IV_BYTES);
    const body = payload.slice(V2_SALT_BYTES + IV_BYTES);
    const key = await deriveV2Key(passphrase, salt);

    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        body as BufferSource
      );
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      // AES-GCM falha na verificação da tag quando a chave está errada, que é
      // o caso esmagadoramente mais comum aqui: senha diferente da usada pra
      // gravar.
      throw new WrongPassphraseError();
    }
  }

  // Formato antigo: chave embutida.
  const payload = fromBase64(trimmed);
  const iv = payload.slice(0, IV_BYTES);
  const body = payload.slice(IV_BYTES);
  const key = await deriveKey(
    LEGACY_SECRET,
    new TextEncoder().encode(LEGACY_SALT),
    LEGACY_ITERATIONS
  );

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      body as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('Failed to decrypt data. The file may be corrupted or use a different key.');
  }
}
