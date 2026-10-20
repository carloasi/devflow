import { describe, it, expect, beforeEach } from 'vitest';
import { encryptData, decryptData, isV2, clearDerivedKeyCache } from './syncCrypto';

// Reproduz o formato ANTIGO exatamente como o app gravava antes da migração.
// Sem isso não há como provar que repositórios já sincronizados continuam
// legíveis — que é a única coisa que torna a troca de chave segura.
async function legacyEncrypt(data: unknown): Promise<string> {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    'raw',
    enc.encode('PostmanClone@2026!SecureKey#Global'),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode('postman-clone-github-sync-salt'),
      iterations: 100000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), 12);
  let binary = '';
  combined.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

const collection = {
  info: { name: 'Barramento B2B' },
  item: [{ name: 'Order', request: { url: 'https://api/x', auth: { token: 'sk-live-segredo' } } }],
};

describe('syncCrypto', () => {
  beforeEach(() => clearDerivedKeyCache());

  describe('formato novo', () => {
    it('ida e volta preserva o objeto', async () => {
      const cipher = await encryptData(collection, 'minha-senha');
      expect(await decryptData(cipher, 'minha-senha')).toEqual(collection);
    });

    it('marca a versão no conteúdo', async () => {
      const cipher = await encryptData(collection, 'minha-senha');
      expect(cipher.startsWith('DFv2:')).toBe(true);
      expect(isV2(cipher)).toBe(true);
    });

    it('não deixa o segredo aparecer na cifra', async () => {
      const cipher = await encryptData(collection, 'minha-senha');
      expect(cipher).not.toContain('sk-live-segredo');
    });

    it('gera cifras diferentes para o mesmo conteúdo', async () => {
      const a = await encryptData(collection, 'minha-senha');
      const b = await encryptData(collection, 'minha-senha');
      expect(a).not.toBe(b);
      expect(await decryptData(b, 'minha-senha')).toEqual(collection);
    });
  });

  describe('senha ausente ou errada', () => {
    it('recusa descriptografar com a senha errada', async () => {
      const cipher = await encryptData(collection, 'minha-senha');
      await expect(decryptData(cipher, 'senha-errada')).rejects.toThrow(/WrongPassphrase|decrypt/i);
    });

    it('recusa descriptografar sem senha', async () => {
      const cipher = await encryptData(collection, 'minha-senha');
      await expect(decryptData(cipher, null)).rejects.toThrow(/passphrase/i);
    });

    it('recusa criptografar sem senha', async () => {
      await expect(encryptData(collection, '')).rejects.toThrow(/passphrase/i);
    });

    it('falha em cifra truncada', async () => {
      const cipher = await encryptData(collection, 'minha-senha');
      await expect(decryptData(cipher.slice(0, -8), 'minha-senha')).rejects.toThrow();
    });
  });

  // O ponto que torna a migração segura: o que já está no GitHub continua
  // legível, sem exigir que o usuário faça nada.
  describe('compatibilidade com o formato antigo', () => {
    it('não confunde o formato antigo com o novo', async () => {
      expect(isV2(await legacyEncrypt(collection))).toBe(false);
    });

    it('lê conteúdo antigo sem senha', async () => {
      expect(await decryptData(await legacyEncrypt(collection), null)).toEqual(collection);
    });

    it('lê conteúdo antigo mesmo com senha configurada', async () => {
      expect(await decryptData(await legacyEncrypt(collection), 'qualquer')).toEqual(collection);
    });
  });
});
