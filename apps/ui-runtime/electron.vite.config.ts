import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
  preload: {}
});
