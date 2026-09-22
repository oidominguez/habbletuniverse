import { defineConfig } from 'vitest/config';

/**
 * Testes unitários da camada de protocolo e dos motores (código puro, sem Electron nem DOM).
 * `atob`/`btoa`/TextDecoder existem no Node 20+, então o ambiente é o Node mesmo.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/protocol/**', 'src/addons/protocol/**', 'shared/**'] },
  },
});
