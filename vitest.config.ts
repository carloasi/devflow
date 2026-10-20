import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    // Mesmo alias do tsconfig. Sem isto, qualquer módulo que importe
    // '@/app/types/...' quebra na hora de resolver.
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    // Ambiente Node, não jsdom: estes testes cobrem lógica pura. WebCrypto,
    // que o syncCrypto usa, existe no Node global desde a 18 — não precisa
    // de navegador simulado.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
