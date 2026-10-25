import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = path.join(root, 'dist');
const output = path.join(root, 'dist-sites/server/index.js');
const excludedDirectories = new Set(['server', 'dist-sites', 'dist-worker', 'node_modules']);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

const assets = Object.create(null);
let totalBytes = 0;
async function collect(directory, prefix = '') {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    // Build output and hosting metadata must never be recursively embedded.
    if (entry.name.startsWith('.') || excludedDirectories.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(filename, relative);
    else if (entry.isFile()) {
      const bytes = await readFile(filename);
      assets[`/${relative}`] = {
        base64: bytes.toString('base64'),
        contentType: contentTypes[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
        etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
        size: bytes.byteLength,
        immutable: /^assets\/[^/]+-[\w-]{8,}\.[\w]+$/.test(relative),
      };
      totalBytes += bytes.byteLength;
    } else throw new Error(`Frontend output contains a non-regular file: ${relative}`);
  }
}

await collect(frontend);
if (!assets['/index.html']) throw new Error('Build the frontend before packaging Sites: dist/index.html is missing.');
await mkdir(path.dirname(output), { recursive: true });
await build({
  absWorkingDir: root,
  stdin: {
    contents: 'import { createStandaloneWorker } from "./worker/standalone.ts"; import assets from "risk:embedded-assets"; export default createStandaloneWorker(assets);',
    resolveDir: root,
    sourcefile: 'sites-entry.js',
    loader: 'js',
  },
  outfile: output,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  plugins: [{
    name: 'embedded-frontend',
    setup(builder) {
      builder.onResolve({ filter: /^risk:embedded-assets$/ }, () => ({ path: 'frontend', namespace: 'risk-assets' }));
      builder.onLoad({ filter: /.*/, namespace: 'risk-assets' }, () => ({ contents: `export default ${JSON.stringify(assets)};`, loader: 'js' }));
    },
  }],
  logLevel: 'info',
});
const bundled = await readFile(output);
console.log(`Sites standalone: ${Object.keys(assets).length} assets (${totalBytes} bytes); Worker ${bundled.byteLength} bytes, ${gzipSync(bundled).byteLength} bytes gzip.`);
