import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const standalone = process.env.RISK_STANDALONE === '1';
const port = Number(process.env.PORT || (standalone ? 3002 : 3001));
const runtime = new Miniflare({
  modules: true, scriptPath: path.join(root, standalone ? 'dist-sites/server/index.js' : 'dist-worker/worker.js'),
  compatibilityDate: '2026-08-01', host: '127.0.0.1', port,
  d1Databases: { DB: 'risk-world-command' }, d1Persist: path.join(root, standalone ? '.worker-local/standalone-d1' : '.worker-local/d1'),
  ...(standalone ? {} : { assets: {
    directory: path.join(root, 'dist'), binding: 'ASSETS',
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    assetConfig: { not_found_handling: 'single-page-application' },
  } }),
});
try {
  await runtime.ready;
  const db = await runtime.getD1Database('DB');
  await db.prepare('CREATE TABLE IF NOT EXISTS _risk_local_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)').run();
  for (const name of (await readdir(path.join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    const source = await readFile(path.join(root, 'migrations', name), 'utf8');
    const checksum = createHash('sha256').update(source).digest('hex');
    const applied = await db.prepare('SELECT checksum FROM _risk_local_migrations WHERE name = ?').bind(name).first();
    if (applied) {
      if (applied.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    // These checked-in migrations contain only simple schema DDL, no SQL strings.
    const statements = source.replace(/--[^\n]*/g, '').split(';').map(sql => sql.trim()).filter(Boolean);
    await db.batch([...statements.map(sql => db.prepare(sql)), db.prepare('INSERT INTO _risk_local_migrations (name, checksum) VALUES (?, ?)').bind(name, checksum)]);
  }
  console.log(`Risk ${standalone ? 'self-contained ' : ''}Worker + durable local D1 listening on port ${port}`);
} catch (error) { await runtime.dispose(); throw error; }
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void runtime.dispose().then(() => process.exit(0), () => process.exit(1));
});
