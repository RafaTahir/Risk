import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['worker/index.ts'],
  outfile: 'dist-worker/worker.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  logLevel: 'info',
});
