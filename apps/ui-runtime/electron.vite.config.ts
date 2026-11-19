import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const mainDir = resolve(import.meta.dirname, 'src/main');
const mainEntries = Object.fromEntries(
  readdirSync(mainDir)
    .filter(file => file.endsWith('.ts'))
    .map(file => [file.replace(/\.ts$/, ''), resolve(mainDir, file)])
);

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: mainEntries,
      },
    },
  },
  // windows are sandboxed, and a sandboxed preload can't import anything: it
  // has to be one CommonJS file, with what it uses bundled in
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  // the host's own page: a card or a form
  renderer: {
    plugins: [react()],
    resolve: {
      alias: { '@rjsf/validator-ajv8': resolve(import.meta.dirname, 'src/renderer/no-ajv.ts') },
    },
    build: {
      rollupOptions: {
        input: { view: resolve(import.meta.dirname, 'src/renderer/view.html') },
      },
    },
  },
});
