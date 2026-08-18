import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Renderer tests opt into jsdom with a per-file `@vitest-environment` pragma.
    environment: 'node',
    globals: false,
    restoreMocks: true,
  },
});
