import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from './app';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer();
let closeAssets: (() => Promise<void>) | undefined;
if (process.env.NODE_ENV === 'production') {
  server.app.use(express.static(path.join(root, 'dist')));
  server.app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server: server.httpServer } }, appType: 'spa' });
  server.app.use(vite.middlewares);
  closeAssets = () => vite.close();
}
const port = Number(process.env.PORT ?? 3000);
server.httpServer.listen(port, '0.0.0.0', () => console.log(`World Command listening on port ${port}`));
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // Bound shutdown even when a peer leaves a transport request open.
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  void Promise.all([server.close(), closeAssets?.()]).then(
    () => { clearTimeout(deadline); process.exit(0); },
    () => { console.error('Server shutdown failed.'); process.exit(1); },
  );
});
