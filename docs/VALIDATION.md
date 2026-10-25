# Current validation report

Validated on2026-10-25 in the existing cloud checkout with Node24.19.0, npm11.9.0, Linuxx86_64, installed Chromium, and actual workerd/D1 through Miniflare. No external endpoint has been published by this task.

## Build and automated suites

A clean `npm ci --include=dev --cache /workspace/.npm-cache --no-audit --no-fund` succeeded from the lockfile. `npm run build:sites` passed TypeScript, browser bundling, and browser-platform Worker ESM bundling. The Worker is about45.3KB and has no Node runtime dependencies.

`npm test` passed **59 tests** across six suites:

- 31 rules/AI tests, including15 complete seeded campaigns across all three difficulties and all supported player counts3–6. They verify armies, turns, elimination, occupation, continent/border data, all44 cards, card bonuses/trades, and victory.
- 7 actual Node/Socket.IO integration tests covering turn authority, illegal/stale/duplicate commands, hidden hands, reconnect/socket replacement, AI pause, origins, bounds/expiry, and online host handoff after explicit lobby departure.
- 5 Worker HTTP/D1 command tests against real SQLite SQL.
- 9 Worker security/concurrency tests, including five forced same-generation read races: competing human actions, duplicate attack rolls with durable receipts, simultaneous AI polls, heartbeat/endTurn, and AI/human-leave interaction. Tests also exercise token hashes/privacy, invalidated membership, origins, streamed-body limits, expiry, and restart state.
- 5 self-contained Worker tests validate all16 frontend asset hashes, MIME/lazy references, HEAD/ETag304/caching, safe paths/methods, API/authentication, and D1 restart without ASSETS.
- 2 actual bundled Worker/workerd/D1 runtime tests, covering applied migration, HTTP validation, multiplayer commands, private cards, persisted receipts, and disposal/recreation with the same D1 directory.

Every D1 state/receipt update uses a conditional SQL generation. Presence-only writes do not advance public game revision. Tokens are256-bit random values stored as SHA-256 hashes. Other hands, decks, and private membership metadata are excluded from snapshots.

## Browser validation

The same production browser interface discovers the backend through `/api/transport`.

**Node:**4 shared browser scenarios passed in20.1seconds;4 HTTP-only scenarios were intentionally skipped. An observed human turn conquered, occupied, fortified, ended, and earned a card. The portable command-ID regression ran with `crypto.randomUUID` disabled.

**Worker:**all8 browser scenarios passed in47.7seconds. They cover the same gameplay and controls plus:

- HTTP-only networking with zero Socket.IO requests.
- Poll snapshots filtering tokens, decks/discards, and other card identities.
- Transient polling failure followed by automatic connection recovery.
- An immediately asserted stale response that cannot roll a newer lobby back.
- Actual host removal clearing the guest's seat.
- Expiry clearing credentials, stopping polling, displaying the correct reason, and permitting a new campaign.
- Unchanged polling snapshots leaving the idle canvas frame count unchanged.

Shared cases use independent browser contexts, private lobbies, AI, reload, saved-seat leave/rejoin, keyboard controls, a390×844 touch viewport without horizontal overflow, mobile Map/Orders shortcuts, reduced motion, manual2D switching, and a separately launched browser with WebGL actually disabled.

The final observed Worker human turn conquered, occupied, fortified, ended, and earned a card. Browser conquest branches depend on genuine dice and remain conditional in the general flow; deterministic rules tests independently verify those branches.

A separate **live browser survived a real local Worker process restart**. It observed RECONNECTING, recovered automatically from the same persisted D1 storage, retained the identical seat/session, all42 territory labels/army counts, the same room and turn02, then refreshed and resumed successfully. That check had zero page errors and zero Socket.IO requests. It proves local full-stack restart recovery; it does not substitute for a check on the deployed Sites endpoint.

Normal browser scenarios reported no console/page errors. Synthetic network-failure tests deliberately abort requests. Screenshot artifacts come from these real browser runs.

## Rendering and delivery

The preview board measured138 draw calls and10,264 triangles. Idle frame count stayed2→2 over500ms on both backends. An observed Worker deployment animation increased3→13frames. These are software-Chromium workload measurements, not universal frame-rate or old-hardware guarantees.

The board uses instanced pieces, on-demand rendering, no shadow maps, capped DPR1.5/1,380ms skippable marches, reduced motion, zoom/pan, an HTML territory selector, and SVG fallback. Browser fonts/visuals are local. The main JavaScript is about344KB/107KB gzip, with separately loaded3D around569KB/146KB gzip. Vite's standard500KB chunk warning applies to Three.js.

## Review fixes and scope

The final independent review reproduced and fixed explicit lobby-host handoff to an offline guest and secure-context-only command-ID failure over LAN HTTP. Both regressions failed before their fixes and pass now. No further substantive rules/AI/authority/privacy/CAS defect was found within review scope.

Node mode stores rooms only in process RAM. Worker mode stores rooms in D1 and survives runtime restarts; inactive rooms expire after24hours. Browser seat tokens remain in session storage, so closing a tab can lose access despite durable room storage. There are no user accounts, account recovery, ranked matchmaking, or account-based saves.

Traditional rules and automated setup/defender choices are in [RULES.md](RULES.md). The official Hasbro PDF was blocked by the environment proxy, so an exact printed-edition audit is not claimed.

The earlier Node offline-container validation is recorded in [DEPLOYMENT.md](DEPLOYMENT.md); its image predates the Worker addition and is not the current Sites release. The primary Dockerfile clean-install stage remains unverified here because isolated Docker DNS returned EAI_AGAIN. That does not block the separately verified Worker route.

Cloud install/start instructions were updated and saved successfully to build and run both modes. The configuration still requires product review/save/publication. The parent task has native Sites tools and must apply its verified manifest, provision logical DB, apply immutable schema migrations, preserve private access, publish, and validate the actual endpoint. This child has neither performed nor claimed those operations. See [SITES.md](SITES.md) and [RELEASE-HANDOFF.md](RELEASE-HANDOFF.md).

## Self-contained deployment starter verification

`npm run build:sites:standalone` passed and generates `dist-sites/server/index.js` with the unchanged16 frontend files embedded. Size:1,693,799bytes raw,697,830bytes gzip. It exports a standard Worker default fetch handler, needs only DB, and has no external runtime imports/fetches or ASSETS dependency. All8 HTTP browser scenarios passed against this exact one-file deployment in49.6seconds, with zero outside-origin or Socket.IO requests. Full human conquest/card/fortification, mobile, fallback, network recovery, stale state, removal, and expiry were observed. This is the preferred input for the parent simple starter, which copies worker/index.js to dist/server/index.js and generates its official hosting manifest.

Mobile scope: responsive layout and touch-input smoke checks used Chromium mobile emulation at390×844 with isMobile/hasTouch enabled, checking no horizontal overflow, touch map selection, Map/Orders shortcuts, reduced motion, and fallback. This verifies the mobile-browser workflow, not a native app-store application or a physical iPhone/Android device. The published private endpoint still needs its deployment smoke check; no physical-phone proof is claimed.

## Board-first release validation

The later board-first UX update passes the same59 automated tests and a clean8/8 self-contained Worker browser run. It adds actual orbit/tilt/pan/zoom/fold checks, gesture network audits proving no troop commands, direct map clicks/taps, readable portrait/landscape framing, touch deployment, and zero selected-badge/dock overlap in representative normal/zoomed/reset/landscape states. Players/cards/rules remain accessible without permanent panels. Typical scene load is181 draw calls and about24–25k triangles, with rendering idle after short animations. These later metrics supersede the earlier138draw/10k triangle scene. Mobile proof remains emulation, not a physical handset. See BOARD-FIRST.md for exact scope and preservation/update instructions.

## Tactical clarity and teaching update

The researched UX update passes TypeScript and the self-contained build,75 automated tests across seven suites, and a clean11/11 HTTP browser run (about1.8minutes). Sixteen new unit checks compare all42×42 attack/fortification pairs and reinforcement origins across3/4/6-player setups against actual rules-engine acceptance, plus mandatory exchanges, occupation, Pacific adjacency, unavailable players and dice-pair casualty equivalence.

Three new browser scenarios add real three-human multiplayer checks for legal markers, previews, immediate duplicate-click protection, pending controls, safe button/Escape cancellation and turn authority. Touch/mobile checks cover optional phase lessons, close/reopen, selected adjacency/continent details, persisted contrast and selected-territory visibility. Explicit presentation-only intercepted poll fixtures cover ties, capture, fixed mandatory movement, reduced-motion equivalence and a report remaining stable while a later roll arrives. Those fixtures are not represented as live backend outcomes; the original real-game browser and engine suites validate outcomes independently.

Review corrected observers' cancel controls during another player's occupation and prevented contextual help from labeling an opponent's current reinforcement reserve as the observer's. A test-only SVG coordinate mismatch was diagnosed with actual pointer targets: the hit check and tap had used different SVG midpoint APIs. Helpers now verify and tap the exact same DOM point, preserving genuine touch input and selection assertions.

No shared rules, AI, server/Worker authority, schema, migrations or session keys changed. Existing D1 storage and audience must be preserved when the parent reviews and updates the existing Site. No push or deployment is part of this handoff. Mobile remains emulated Chromium, not a physical handset certification. See PLAYER-EXPERIENCE.md for sourced design rationale and exact scope.

After the final CSS-only preview-marker cleanup, the standalone package was rebuilt; the three mobile/battle browser scenarios passed again, and all five exact-asset/API/D1 standalone checks passed against the final embedded bytes. The full11-case run already covered the unchanged application logic. No additional rendering geometry or idle animation loop was added by these affordances.

## Animation fallback cleanup

A live WebGL-unavailable fallback left Skip animation visible after confirmed combat because no 3D renderer could deliver its completion callback. The fallback now completes only the queued presentation motion; choosing 2D or reduced/instant motion also clears that queue independently. Authoritative state, battle dice/casualties, history and rules are unchanged.

The new real-room/WebGL-disabled regression failed on the previous bundle and passes after the fix. All 3 targeted regressions pass, including 2D/reduced transitions while main-world animation frames are deliberately paused and suppression is asserted. Exact server game snapshots remain unchanged by visual cleanup and reading reports/history sends no orders. The normal 3D camera/idle/fold case, complete human turn and paired-result case pass, and all 5 exact standalone-asset/API/D1 checks pass. One camera run missed the short opening flag because its first post-click sample arrived 1.1 seconds after a 520ms opening; the trace showed frames advancing and an isolated recheck passed. No unrelated animation or rules behavior was changed to mask that timing-sensitive test.
