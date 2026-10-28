// ---------------------------------------------------------------------------
// 测试空壳 mod build — one self-contained IIFE bundle: dist/index.js
//
// `vite build --config mods/library/vite.config.ts` from the repo root.
//
// React / ReactDOM are NOT bundled: the `react`, `react/jsx-runtime`,
// `react-dom` and `react-dom/client` specifiers are aliased to the shims in
// src/shims, which read the single instances off `window.__DOLA__`. Everything
// else (epub.js, pdf.js, jszip, zustand, shared constants) is bundled in.
// ---------------------------------------------------------------------------

import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Vite injects `__dirname` for bundled config files; modRoot === mods/library.
const modRoot = __dirname
const repoRoot = resolve(modRoot, '..', '..')

export default defineConfig({
  root: modRoot,
  // no index.html / public dir in a lib build
  publicDir: false,
  resolve: {
    alias: [
      // exact-match aliases: a bare 'react' alias would also swallow
      // 'react-dom' and 'react/jsx-runtime'.
      { find: /^react$/, replacement: resolve(modRoot, 'src/shims/react.ts') },
      { find: /^react\/jsx-runtime$/, replacement: resolve(modRoot, 'src/shims/react-jsx-runtime.ts') },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolve(modRoot, 'src/shims/react-jsx-runtime.ts') },
      { find: /^react-dom$/, replacement: resolve(modRoot, 'src/shims/react-dom.ts') },
      { find: /^react-dom\/client$/, replacement: resolve(modRoot, 'src/shims/react-dom-client.ts') },
      // shared constants/types with the app (types are erased, the constant
      // modules such as @shared/fonts are tiny and get bundled)
      { find: '@shared', replacement: resolve(repoRoot, 'src/shared') }
    ]
  },
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  build: {
    outDir: resolve(modRoot, 'dist'),
    emptyOutDir: true,
    copyPublicDir: false,
    target: 'esnext',
    // The distributable is a single index.js, so any asset a dependency pulls
    // in (notably pdf.js' worker module) must be inlined as a data URL.
    assetsInlineLimit: 16 * 1024 * 1024,
    chunkSizeWarningLimit: 8192,
    lib: {
      entry: resolve(modRoot, 'src/index.tsx'),
      formats: ['iife'],
      name: 'DolaMod_testshell',
      fileName: () => 'index.js'
    },
    rollupOptions: {
      // The IIFE format has no chunk loading, so rolldown disables code
      // splitting (the dynamic `import('pdfjs-dist')` in Reader is inlined
      // into the same file). `exports: 'named'` keeps the module object shape
      // the host registry expects and silences the mixed-exports warning.
      output: {
        exports: 'named'
      }
    }
  }
})
