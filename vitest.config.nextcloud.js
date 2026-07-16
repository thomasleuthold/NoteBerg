import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Standalone config for exercising the Nextcloud build's code paths
// (IS_NEXTCLOUD branches) — run via `npm run test:nextcloud`, a fully
// separate `vitest` CLI invocation from the default config/`npm test`.
//
// This must NOT be merged into vitest.config.js via `test.projects`: doing
// so caused the `define` below (VITE_PLATFORM=nextcloud) to leak into the
// default project's esbuild transform for shared source files (observed
// with Vitest 4.1.5 — StrokeManager.js came back IS_NEXTCLOUD=true even when
// running `--project default` alone, as soon as a second project existed in
// the array, regardless of separate config files or separate cacheDirs).
// Two independent `vitest run` processes sidestep the shared-transform-cache
// issue entirely.
//
// Mirrors vite.config.js's platform === 'nextcloud' branch: storage.js is
// redirected to the WebDAV backend, and VITE_PLATFORM is defined so
// IS_NEXTCLOUD flags evaluate true, matching the real Nextcloud build.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /.*\/storage\.js$/,
        replacement: resolve(process.cwd(), 'src/modules/storage.webdav.js'),
      },
    ],
  },
  define: {
    'import.meta.env.VITE_PLATFORM': JSON.stringify('nextcloud'),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.nextcloud.test.js'],
  },
});
