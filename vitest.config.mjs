// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    // Prints what is and is not available before anything is skipped.
    globalSetup: ['test/prerequisites.mjs'],
    // Several tests invoke the Compact compiler; an interface takes about a
    // second, and a few tests compile several in a row.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Bundles are imported by absolute path from scratch directories; running
    // files in one process keeps the module cache and the temp trees predictable.
    fileParallelism: false,
    server: {
      deps: {
        // Generated contract wrappers are plain ESM and reference an
        // `index.js.map` the bundle deliberately does not ship. Let Node import
        // them directly instead of transforming them, so Vite does not warn
        // about the missing source map on every bundle.
        external: [/[\\/](build|bundle|tmp|sim)[\\/]/],
      },
    },
  },
});
