**Preferred final integration:** the parent simple starter copies only one Worker file. The now-tested self-contained variant embeds all frontend assets and needs only DB, avoiding the separate asset routing requirement below. See [PARENT-HANDOFF.md](PARENT-HANDOFF.md) and [SITES.md](SITES.md). The user has approved transfer through a new release branch in the existing repository and parent-run Sites deployment; no main overwrite, force-push, sharing change, or paid service is authorized.

# Current Sites release handoff

The original game, AI, 3D board, and conventional Node backend are preserved. A compatible **Worker ESM + D1 backend is now implemented and tested**. It reuses the classic rules/AI and provides real network multiplayer through authenticated HTTP commands and polling, durable room state, and atomic conditional updates.

The parent task has verified Sites Worker/D1 support and owns the native deployment tools. This child has no Sites/Library tools, so it prepares exact source/artifacts and validation evidence for that final native deployment step.

## Files to transfer

The deployment-only artifact is `/workspace/artifacts/risk/world-command-sites-built.tar.gz`. Its extracted layout is:

- `public/`: all compiled Vite browser assets, including `index.html`, fonts, and favicon.
- `server/worker.js`: bundled Worker ESM with standard default fetch export. No Node imports, Socket.IO server, external service calls, or process timers.
- `migrations/0001_rooms.sql`: schema-only rooms table and expiry index.
- `bundle-info.json`: descriptive transfer metadata, not a hosting-platform manifest.
- `SITES.md`: integration/runtime details.

The complete source-plus-built-assets release remains `/workspace/artifacts/risk/world-command-release.tar.gz`, with `SHA256SUMS` and `release-manifest.json` adjacent. Screenshots are in the same artifact directory. No local D1 files, browser sessions, dependencies, environment files, or credentials are packaged.

## Parent native deployment steps

1. Apply the parent's **verified `.openai/hosting.json` schema/template** to the extracted files. Do not guess manifest fields. Point its Worker entry at `server/worker.js` and its static assets at `public/` according to the supported starter conventions.
2. Declare the logical D1 binding **`DB`** using the verified manifest convention, allowing Sites to provision/connect it. No new account, credential grant, paid plan, or application secret is required by this code.
3. Apply `migrations/0001_rooms.sql` through Sites' bounded migration mechanism. It contains only two schema statements. Prepare one SQL statement at a time, or batch the two prepared statements. Do not edit an applied migration later.
4. Ensure `/api/*` reaches the Worker before SPA fallback. The standalone local Worker uses the standard optional `ASSETS.fetch` binding for non-API files; confirm the exact Sites asset helper/routing convention and adapt that small wrapper if needed. Do not infer a binding from this guide.
5. Use compatibility date `2026-08-01` if the schema requires one; this is the date validated by the installed runtime. Preserve the site's existing/private access. Deployment authorization did not authorize unrelated access widening.
6. Run the native preview/review/deploy flow, then verify the actual private endpoint: transport reports `http`/`d1`, two independent browser clients can join, act, and reconnect; other hands/tokens stay private; migrations/bindings work on the published runtime. Publishing/upload success alone is not a gameplay check.

No external endpoint has been published by this child, and no native deployment operation is in flight or uncertain.

## Verified behavior

- Clean locked install, `npm run build:sites`, and TypeScript pass.
- `npm test`: **54 tests**:31 rules/AI,7 Node/socket,5 Worker command tests,9 forced-CAS/security tests,2 actual workerd/D1 persistence tests.
- Fifteen complete seeded AI campaigns cover all difficulties and supported player counts3–6.
- Node production browser run:4 shared tests passed,4 intended HTTP-only skips.
- Worker production browser run:8 tests passed, including actual human conquest/occupation/fortification/card gain, private multiplayer, saved-seat return, mobile/keyboard/reduced motion, WebGL fallback, private snapshot filtering, idle rendering, network recovery, stale-response rejection, membership removal, and expiry.
- A separately coordinated open-browser check survives a full local Worker restart using the same persisted D1 database; final outcome is recorded in VALIDATION.md.

Worker rooms survive runtime restarts and expire after24 hours without persisted activity. Node rooms remain RAM-only. The client still stores its seat token in session storage; closing a tab can lose it. This is durable server-side room storage, not user-account recovery, public matchmaking, or an account-based save system.

## Resource and operational scope

The backend bundle is about45KB uncompressed. Local rendering remains around10,264 triangles/138 draw calls with no idle frame churn. Worker D1 use is bounded by body/command/room/receipt limits and one AI action per eligible poll; it does not use process-local IP throttles as a cross-isolate guarantee. Keep private access and the platform's request/quota controls, and measure actual deployed memory and D1 usage before enabling a broader audience or paid scaling.

The Node container alternative and its earlier Docker DNS limitation are in DEPLOYMENT.md. They do not block the new Worker route. Rules and automated setup/defender choices remain in RULES.md; the official printed-edition PDF could not be retrieved, so an exact printed-edition audit is not claimed.
