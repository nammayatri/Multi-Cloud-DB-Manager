import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `npm run build` emits compiled copies of every *.test.ts into dist/.
    // Without this, a test run after a build executes both the source and the
    // build output, and the build output fails on its own import of vitest.
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
