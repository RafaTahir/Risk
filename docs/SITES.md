# Worker + D1 deployment adapter

The game now has two real multiplayer backends sharing the same classic rules and AI:

- The existing Node process uses Socket.IO and keeps rooms in process memory.
- The Worker ESM backend uses HTTP commands, polling, and durable D1 records. It needs no incoming raw TCP, process timers, Socket.IO server, Durable Objects, accounts, or application secrets.

The browser discovers the active backend through `GET /api/transport`. No build-time API URL or separate-origin credential configuration is required.

## Build and local validation

```sh
npm ci --include=dev
npm run build:sites
npm run dev:worker
```

The local Worker serves the production browser bundle and API together on internal port 3001 using Miniflare. It applies checked-in schema migrations to persistent local D1 storage under `.worker-local/d1`; applied migration checksums cannot change. That directory contains private test game/session data and must never be uploaded or committed. The local listener is loopback-only and is not an external deployment.

`npm run test:worker` runs actual SQL concurrency/authentication tests and a bundled Worker in the real workerd/D1 runtime. `npm test` includes these and the original engine/Node tests. The browser suite can target the local Worker using `RISK_TEST_BASE_URL=http://127.0.0.1:3001 RISK_TEST_HTTP=1 npm run test:browser`.

## Required hosting inputs

- Worker ESM entry: `dist-worker/worker.js` (built from `worker/index.ts`). It exports the standard default `{ fetch(request, env) }` handler and contains no Node imports.
- Browser assets: all files from `dist/`.
- Logical D1 binding: **`DB`**. The hosting platform provisions/connects the actual database; do not insert database credentials or invent a database ID.
- Schema migration: `migrations/0001_rooms.sql`. It creates `rooms` and an expiry index. It contains no data writes, external calls, or seed tokens. Apply each statement once through the platform's migration mechanism; prepare one SQL statement at a time, or batch prepared statements. Once applied, preserve the migration and add a later migration for future changes.
- API routing: `/api/health`, `/api/transport`, `/api/command`, and `/api/poll` must reach the Worker before any SPA fallback. Static requests can use the platform asset router; the standalone Worker also supports the standard optional **`ASSETS.fetch`** binding for non-API routes. Confirm that binding/route convention against the hosting starter rather than assuming it.
- Compatibility date tested locally: **`2026-08-01`**. The installed workerd rejects dates newer than `2026-08-06`; there is no reason to require a newer date for this adapter.

The parent task has verified that Sites supports Worker ESM plus manifest-provisioned D1 with logical binding `DB`. This child task does not have the Sites schema or native deployment tools. The parent must apply its verified `.openai/hosting.json` template and asset routing; no speculative hosting manifest is supplied here.

## Durable authority and concurrency

One D1 row stores the private room document, roster, game, hashed member credentials, bounded command receipts, expiry, and next AI deadline. The SQL `revision` column is a private CAS generation. Every mutation uses `UPDATE ... WHERE code = ? AND revision = ?`; state changes and their command receipts commit together. Public `RoomState.revision` advances only for game/lobby actions, so presence heartbeats do not invalidate human commands.

The server authenticates room membership and the session token before reading a private hand or applying commands. It validates turn ownership and every action through the original engine. Session tokens are cryptographically random and sent only in JSON request bodies and the owner's create/join/resume response. D1 stores SHA-256 hashes. Other players receive neither tokens/hashes nor card identities; decks/discards are removed from snapshots.

A successful command ID cannot be reused for a different payload. Repeating the same command after an uncertain response or runtime restart returns its stored receipt and current state without applying again. Receipts are capped at 256 per player; older receipts evicted from that window are still protected by stale public revisions. Concurrent different commands for the same revision cannot both commit. Bounded CAS retries re-read durable state after conflicts and do not expose a losing, uncommitted candidate.

AI advances at most one action per authenticated poll/resume, after a committed 450 ms deadline. Concurrent polls compete through the same CAS, preventing duplicate moves. There are no cross-request process timers. With no connected clients polling, AI pauses; the next authenticated client can resume it from D1. Presence expires after 20 seconds, with heartbeat writes bounded to once per five seconds per active member. The frontend polls faster during AI actions and suppresses unchanged snapshots so idle graphics do not render continuously.

## HTTP protocol

All responses use `Cache-Control: no-store`. Send same-origin `application/json` requests. Request bodies are bounded to 16 KiB and game commands to 1 KiB.

- `GET /api/transport` returns `{mode:"http",persistence:"d1",pollIntervalMs:1200}`.
- `POST /api/command` takes `{event,payload,session?}`. Events match the Node UI protocol: `room:create`, `room:join`, `room:resume`, `room:addBot`, `room:removePlayer`, `room:start`, `room:leave`, and `game:action`. Authenticated events include `session:{code,playerId,token}` at the top level. Resume can also supply it as its payload. Replies are `{ok,error?,session?,state?}`.
- `game:action` payload is `{id,revision,action}`; IDs are 32 lowercase hex characters. A retry must keep the same ID, revision, and action.
- `POST /api/poll` takes `{session,revision?}` and returns the authenticated public snapshot. Tokens never go in a URL/query string.
- Invalid membership/token returns 401; missing/expired rooms 404; foreign origin 403; malformed body 400; oversized body 413; wrong content type 415. Legal request/business validation errors use `{ok:false,error,state?}` without mutating the game.

## Persistence and limits

Worker rooms survive Worker restarts because D1 owns the state. A room expires after 24 hours without persisted activity. Cleanup is bounded to 100 expired rows per allocation, with an atomic 500-room cap. These are storage bounds, not a substitute for platform access and request limits.

The Worker does not copy Node's process-local per-IP limiter, which would be unreliable across isolates. Use the hosting platform's existing private-site access and request/quota controls; do not widen access or silently enable paid scaling. D1 operation quotas and resource measurements must be checked on the actual deployment before a broader audience is enabled.

The browser still keeps its reconnect token in session storage. Closing the tab can lose that token even though the server-side room persists; this is not an account-based cloud-save/recovery feature. Multiple tabs with the same bearer token represent the same player and are serialized by revision checks; HTTP mode does not enforce Socket.IO's single-socket replacement behavior.

No external deployment or binding provision has been performed from this task. A successful local Worker/D1 run does not prove that the parent has published the correct asset routes, applied migrations, or passed live private-site validation.

## Preferred single-file starter package

The parent clarified that its simple Worker starter copies only `worker/index.js` to `dist/server/index.js`. Use the self-contained variant for that starter:

```sh
npm run build:sites:standalone
npm run dev:sites:standalone
```

The output `dist-sites/server/index.js` is a standard ESM default Worker with the complete API plus all16 frontend files embedded. It is1,693,799bytes raw and697,830bytes gzip. The client still receives the original individual frontend chunks/fonts with their original bytes and URLs; the browser does not download the entire Worker bundle. Decode caching is bounded by the fixed1,230,947-byte asset inventory.

This variant requires **only `DB`**, with no ASSETS binding, separate static upload, external imports, runtime filesystem, external fetch, or Vinext conversion. It supports correct MIME types, strong ETags, HEAD/304, immutable hashed-asset caching, safe SPA fallback, and strict API routing.

Place that exact compiled module at the starter's input `worker/index.js`; the official starter can copy it to `dist/server/index.js`. The parent must still generate `dist/.openai/hosting.json` from its verified schema and declare/apply logical DB plus `migrations/0001_rooms.sql`. No such hosting manifest has been fabricated here.

Five additional actual workerd/D1 tests validate every asset hash, fonts and lazy chunk references, cache/path/method behavior, API authentication, and restart durability without any ASSETS binding. The full automated suite now has59 passing tests. All8 HTTP browser cases also passed against the self-contained variant, with zero other-origin or Socket.IO requests.
