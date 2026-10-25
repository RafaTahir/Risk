import { createWorker, type WorkerEnv } from './app';

export interface EmbeddedAsset {
  base64: string;
  contentType: string;
  etag: string;
  size: number;
  immutable: boolean;
}

/** Static content is supplied at build time; the deployed Worker only needs DB. */
export function createStandaloneWorker(assets: Record<string, EmbeddedAsset>) {
  const api = createWorker();
  // The cache can grow only to the fixed size of the embedded frontend.
  const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
  const plain = (message: string, status: number, extra: Record<string, string> = {}) => new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra },
  });
  const bodyOf = (pathname: string, asset: EmbeddedAsset) => {
    let bytes = decoded.get(pathname);
    if (!bytes) {
      const binary = atob(asset.base64);
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      decoded.set(pathname, bytes);
    }
    return bytes;
  };

  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      // Reserve the entire API namespace, including requests it does not handle.
      if (url.pathname.startsWith('/api/')) return api.fetch(request, env);
      if (url.pathname === '/api') return plain('Not found', 404);
      if (request.method !== 'GET' && request.method !== 'HEAD') return plain('Use GET or HEAD', 405, { Allow: 'GET, HEAD' });

      let pathname: string;
      try {
        if (/%2f|%5c/i.test(url.pathname)) return plain('Invalid path', 400);
        pathname = decodeURIComponent(url.pathname);
      } catch { return plain('Invalid path', 400); }
      if (/[\\%\x00-\x1f\x7f]/.test(pathname) || pathname.includes('//')
        || pathname.split('/').some(segment => segment === '.' || segment === '..')) return plain('Invalid path', 400);
      // Encoded API aliases must never receive the HTML application shell.
      if (pathname === '/api' || pathname.startsWith('/api/')) return plain('Not found', 404);

      let key = pathname === '/' ? '/index.html' : pathname;
      if (!Object.prototype.hasOwnProperty.call(assets, key)) {
        const segments = pathname.split('/').filter(Boolean);
        if (pathname === '/assets' || pathname.startsWith('/assets/')
          || segments.some(segment => segment.startsWith('.')) || segments.at(-1)?.includes('.')) return plain('Not found', 404);
        key = '/index.html';
      }
      const asset = assets[key];
      if (!asset) return plain('Not found', 404);
      const headers = new Headers({
        'Content-Type': asset.contentType,
        'Content-Length': String(asset.size),
        'X-Content-Type-Options': 'nosniff',
        ETag: asset.etag,
        'Cache-Control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      const matches = request.headers.get('if-none-match')?.split(',')
        .some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === asset.etag);
      if (matches) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : bodyOf(key, asset), { headers });
    },
  };
}
