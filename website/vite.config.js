import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

/**
 * Client build for the JSails docs site.
 *
 * Server-side page/UI modules are compiled by `tsc -p tsconfig.json` into
 * `dist/`. This config only bundles the browser entry (`client/main.tsx`).
 * Output lands in `public/assets/`, which the JSails app copies into `out/`
 * during the static export.
 *
 * The entry is emitted as a stable `app.js` and the extracted stylesheet as
 * `app.css` at the root of the output directory, so the SSR document shell
 * can link them by fixed path; any secondary chunk or asset goes into a
 * hashed `assets/` subdirectory.
 */
export default defineConfig({
  base: '/assets/',
  plugins: [preact()],
  build: {
    outDir: 'public/assets',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'client/main.tsx',
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const name = assetInfo.names?.[0] ?? '';
          return name.endsWith('.css') ? 'app.css' : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
