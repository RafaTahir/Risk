import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomState, ServerResponse, Session } from '../shared/types';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://risk.test';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Reply = ServerResponse & { state?: RoomState };

describe.sequential('single-file Sites Worker with embedded frontend and real D1', () => {
  let runtime: Miniflare;
  let persistence: string;
  const frontend = new Map<string, Buffer>();
  const createRuntime = () => new Miniflare({
    modules: true,
    scriptPath: path.join(root, 'dist-sites/server/index.js'),
    compatibilityDate: '2026-08-01',
    d1Databases: { DB: 'risk-standalone-test' },
    d1Persist: persistence,
    log: new Log(LogLevel.ERROR),
    // Deliberately no ASSETS binding: this file is the entire application.
  });

  beforeAll(async () => {
    try { await access(path.join(root, 'dist/index.html')); }
    catch { await promisify(execFile)(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root }); }
    await promisify(execFile)(process.execPath, [path.join(root, 'scripts/build-sites-standalone.mjs')], { cwd: root });
    const collect = async (directory: string, prefix = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || ['server', 'dist-sites', 'dist-worker', 'node_modules'].includes(entry.name)) continue;
        const relative = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative);
        else if (entry.isFile()) frontend.set(relative, await readFile(path.join(directory, entry.name)));
      }
    };
    await collect(path.join(root, 'dist'));
    persistence = await mkdtemp(path.join(tmpdir(), 'risk-standalone-d1-'));
    runtime = createRuntime();
    const database = await runtime.getD1Database('DB');
    const migration = await readFile(path.join(root, 'migrations/0001_rooms.sql'), 'utf8');
    for (const statement of migration.split(';').map(sql => sql.trim()).filter(Boolean)) await database.prepare(statement).run();
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (persistence) await rm(persistence, { recursive: true, force: true });
  }, 10_000);

  it('serves every built frontend file with its exact binary bytes and MIME type', async () => {
    expect(frontend.size).toBeGreaterThan(10);
    const types: Record<string, string> = {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
    };
    for (const [pathname, original] of frontend) {
      const response = await runtime.dispatchFetch(`${origin}${pathname}`);
      expect(response.status, pathname).toBe(200);
      expect(response.headers.get('content-type'), pathname).toContain(types[path.extname(pathname)]);
      expect(response.headers.get('x-content-type-options'), pathname).toBe('nosniff');
      // Workerd may compress text responses and remove their wire Content-Length.
      const length = response.headers.get('content-length');
      if (length !== null) expect(length, pathname).toBe(String(original.byteLength));
      expect(response.headers.get('etag'), pathname).toBe(`"${hash(original)}"`);
      expect(hash(new Uint8Array(await response.arrayBuffer())), pathname).toBe(hash(original));
    }
    const response = await runtime.dispatchFetch(`${origin}/`);
    expect(hash(new Uint8Array(await response.arrayBuffer()))).toBe(hash(frontend.get('/index.html')!));
  });

  it('preserves reachable HTML, JavaScript lazy chunk, CSS, and binary font references', async () => {
    let references = 0;
    let lazyChunks = 0;
    let fonts = 0;
    for (const [pathname, original] of frontend) {
      if (!/\.(html|js|css)$/.test(pathname)) continue;
      const source = original.toString('utf8');
      const paths = new Set<string>();
      const pattern = pathname.endsWith('.html') ? /(?:src|href)=["']([^"']+)["']/g
        : pathname.endsWith('.css') ? /url\(["']?([^)'"\s]+)["']?\)/g
          : /["']((?:\.\/|\/assets\/)[^"']+\.(?:js|css|woff2?))["']/g;
      for (const match of source.matchAll(pattern)) {
        const reference = match[1];
        if (reference.startsWith('data:') || /^[a-z]+:/i.test(reference) || reference.startsWith('#')) continue;
        paths.add(new URL(reference, `${origin}${pathname}`).pathname);
      }
      for (const reference of paths) {
        expect(frontend.has(reference), `${pathname} references ${reference}`).toBe(true);
        expect((await runtime.dispatchFetch(`${origin}${reference}`)).status).toBe(200);
        references++;
        if (reference.includes('Board3D-') && reference.endsWith('.js')) lazyChunks++;
        if (/\.woff2?$/.test(reference)) fonts++;
      }
    }
    expect(references).toBeGreaterThan(5);
    expect(lazyChunks).toBeGreaterThan(0);
    expect(fonts).toBeGreaterThan(0);
  });

  it('uses immutable hashed assets, revalidated HTML, and correct HEAD and conditional requests', async () => {
    const fontPath = [...frontend.keys()].find(name => name.endsWith('.woff2'))!;
    const initial = await runtime.dispatchFetch(`${origin}${fontPath}`);
    const etag = initial.headers.get('etag')!;
    expect(initial.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const head = await runtime.dispatchFetch(`${origin}${fontPath}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('font/woff2');
    expect(head.headers.get('content-length')).toBe(String(frontend.get(fontPath)!.byteLength));
    expect(head.headers.get('etag')).toBe(etag);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    for (const condition of [etag, `W/${etag}`, `"unrelated", W/${etag}`, '*']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await runtime.dispatchFetch(`${origin}${fontPath}`, { method, headers: { 'If-None-Match': condition } });
        expect(response.status).toBe(304);
        expect(response.headers.get('etag')).toBe(etag);
        expect(response.headers.get('content-type')).toBe('font/woff2');
        expect((await response.arrayBuffer()).byteLength).toBe(0);
      }
    }
    for (const pathname of ['/', '/index.html', '/campaign/ABC123']) {
      const response = await runtime.dispatchFetch(`${origin}${pathname}?view=map`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(hash(new Uint8Array(await response.arrayBuffer()))).toBe(hash(frontend.get('/index.html')!));
    }
  });

  it('keeps missing assets, malformed paths, and unsupported methods out of the SPA fallback', async () => {
    for (const pathname of ['/assets', '/assets/missing.js', '/assets/missing', '/missing.css', '/.env', '/server/index.js', '/__proto__/missing.js']) {
      const response = await runtime.dispatchFetch(`${origin}${pathname}`);
      expect(response.status, pathname).toBe(404);
      expect(response.headers.get('content-type')).toContain('text/plain');
    }
    for (const pathname of ['/%E0%A4%A', '/assets/%252e%252e/index.html', '/assets//missing', '/api%2fhealth', '/assets/%5cmissing']) {
      const response = await runtime.dispatchFetch(`${origin}${pathname}`);
      expect(response.status, pathname).toBe(400);
      expect(response.headers.get('content-type')).toContain('text/plain');
    }
    const post = await runtime.dispatchFetch(`${origin}/`, { method: 'POST', body: 'ignored' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('retains API routing and real D1 authenticated room state without an ASSETS binding', async () => {
    expect(await (await runtime.dispatchFetch(`${origin}/api/health`)).json()).toEqual({ ok: true });
    expect(await (await runtime.dispatchFetch(`${origin}/api/transport`)).json()).toEqual({ mode: 'http', persistence: 'd1', pollIntervalMs: 1200 });
    const missing = await runtime.dispatchFetch(`${origin}/api/unknown`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ ok: false });
    expect((await runtime.dispatchFetch(`${origin}/api`)).status).toBe(404);
    expect((await runtime.dispatchFetch(`${origin}/api/command`)).status).toBe(405);
    const post = (pathname: string, body: unknown) => runtime.dispatchFetch(`${origin}${pathname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
    });
    const command = async (event: string, payload: unknown = {}, session?: Session) => {
      const response = await post('/api/command', { event, payload, ...(session ? { session } : {}) });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return await response.json() as Reply;
    };
    const created = await command('room:create', { name: 'Host', mode: 'private', bots: 1, difficulty: 'general' });
    expect(created.ok).toBe(true);
    const host = created.session!;
    const joined = await command('room:join', { code: host.code, name: 'Guest' });
    expect(joined.ok).toBe(true);
    expect((await command('room:start', {}, joined.session)).ok).toBe(false);
    const started = await command('room:start', {}, host);
    expect(started.ok).toBe(true);
    expect(started.state!.status).toBe('playing');
    const stored = await (await runtime.getD1Database('DB')).prepare('SELECT data FROM rooms WHERE code = ?').bind(host.code).first<{ data: string }>();
    expect(stored).not.toBeNull();
    expect(stored!.data).not.toContain(host.token);
    expect(stored!.data).toContain('tokenHash');
    await runtime.dispose();
    runtime = createRuntime();
    const forged = await post('/api/poll', { session: { ...host, token: '0'.repeat(64) } });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ ok: false });
    const restoredResponse = await post('/api/poll', { session: host });
    const restored = await restoredResponse.json() as Reply;
    expect(restoredResponse.status).toBe(200);
    expect(restored.ok).toBe(true);
    expect(restored.state!.code).toBe(host.code);
    expect(restored.state!.status).toBe('playing');
    expect(restored.state!.game!.deck).toEqual([]);
    expect(JSON.stringify(restored)).not.toContain(host.token);
  }, 30_000);
});
