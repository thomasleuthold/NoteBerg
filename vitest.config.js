import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    // *.nextcloud.test.js files exercise the Nextcloud build's code paths
    // (IS_NEXTCLOUD branches) and run under the separate
    // vitest.config.nextcloud.js / `npm run test:nextcloud` instead — that
    // config defines VITE_PLATFORM=nextcloud and aliases storage.js to
    // storage.webdav.js, matching vite.config.js's real NC build. Running
    // them here would silently pass with IS_NEXTCLOUD permanently false.
    exclude: ['**/node_modules/**', '**/*.nextcloud.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**'],
      exclude: ['src/**/*.css', 'src/**/*.json', 'src/**/*.woff2', 'src/i18n/locales/**'],
    },
  },
});
