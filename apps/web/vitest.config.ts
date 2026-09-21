import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vitest does NOT read tsconfig `paths`, so every workspace alias the app uses
 * has to be re-declared here. Missing one is the classic
 * "Cannot find package '@ai-pushup-coach/...'" failure.
 */
const packages = ['types', 'pose', 'biomechanics', 'rep-counter', 'form-engine'] as const;

const alias: Record<string, string> = {
  // tsconfig maps "@/*" to "./*", so the bare "@" prefix points at apps/web.
  '@': here,
};

for (const name of packages) {
  alias[`@ai-pushup-coach/${name}`] = path.resolve(here, `../../packages/${name}/src/index.ts`);
}

/**
 * jsdom is the preferred DOM environment, but it is an *optional* dependency
 * and is absent from this offline install. Probe for it and fall back to the
 * plain node environment; suites that need `localStorage` install their own
 * in-memory shim when `window.localStorage` is missing, so behaviour is
 * identical either way.
 */
function pickEnvironment(): 'jsdom' | 'node' {
  try {
    require.resolve('jsdom');
    return 'jsdom';
  } catch {
    return 'node';
  }
}

export default defineConfig({
  resolve: { alias },
  test: {
    environment: pickEnvironment(),
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
    globals: false,
    restoreMocks: true,
  },
});
