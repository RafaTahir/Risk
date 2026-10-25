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

## Printed physical board, setup and direct manipulation

The physical-board correction passes TypeScript, the self-contained build and 84 automated tests across 8 suites, including 9 camera-input tests with actual Three.js projections. All 18 HTTP browser scenarios are verified on the final renderer: the existing 14 gameplay/network/accessibility/fallback cases plus 4 physical-board cases. One legacy mobile hit-check initially waited for an off-screen accessible button; its helper now reads the stable territory DOM entry so it can skip a genuinely hidden country. The corrected mobile scenario passes with actual touch/selection assertions retained. The final exact-asset/API/D1 standalone suite also passes 5/5.

New real-room flows verify zero territory/reserve figures and count discs before start, explicit quick auto setup with correct allowances for every 3–6-player count, reload, setup cancellation, leaving to an empty table and rejoining the same saved game. Printed-label quads follow the real board projection, and no SVG country text remains. Mouse and native touch checks verify screen-axis direction, fixed radius, capture outside the viewport, small-click thresholds, pinch-to-single-contact rebasing, and zero gesture-issued game orders. A held-drag wheel test reproduced zoom snapping back to its old anchor and passes after preserving current zoom/pan while applying only the anchored angles.

Actual final screenshots were inspected for correct texture orientation, country-surface ink, empty pregame and useful upright phone zoom. Specific Australia/South Africa/Indonesia label placements avoid count-disc overlap. Native touch protocol delivery is awaited with camera predicates rather than arbitrary sleeps; the surviving-contact test uses real pointer delivery.

Measured rendering work at the captured views: desktop 1.5×: 183 draw calls/25,548 triangles; phone upright 2.0×: 120 draw calls/23,844 triangles. Idle rendering stops, pixel ratio stays capped and no heavy shadows or external visual assets were added. These are software-Chromium workload observations, not physical-handset or old-hardware FPS guarantees. See PHYSICAL-BOARD.md for official reference provenance, the intentionally automated setup and preservation requirements. Rules, AI, backend authority, persistence, schema and migrations are unchanged.

## Shared smooth contours and real folding

The contour/folding update passes TypeScript, the self-contained build, 89 automated checks across 9 suites, all 4 new fold browser scenarios and all 18 existing browser scenarios (22 total). Final exact packaged-asset/API/D1 checks pass 5/5. Existing gameplay tests now intentionally open the initially folded board; no game/gesture/state assertions were removed.

Five geometry checks verify identical reversed shared boundaries, original edge ownership, no new crossings, bounded displacement/area drift, preserved components/sea separation and substantially smoother turn angles. The same 2604 sampled contour points drive 3D land, outlines, text clipping, raycasting and the SVG fallback. The 89-check suite retains full AI campaigns, authority/privacy/CAS/reconnect tests and setup allowances.

The new real HTTP browser flows verify the actual 180° right-leaf hinge/back and zero pregame units; explicit keyboard/mouse/touch Open/Fold; same-task repeated requests and actual mid-pose reversals; disabled territory/Find/orders while closed or moving; cosmetic troop cancellation; unchanged game/preferences/camera; reload/resume; receiving a peer's real state revision while folded and reopening its latest armies. Right-leaf figure anchors move with their actual parent and restore when opened; visible figures are concealed inside the closed board without removing logical armies. Reduced-motion endpoints and an actually WebGL-disabled fallback pass.

Screenshots of closed back, open map, smooth 2×detail and mobile endpoints were visually reviewed. The ordinary reversal screenshot completed after reopening, so it is not offered as an intermediate-pose image; genuine intermediate progress was asserted in the browser test. Rendering remains on demand. Captured open views measured 146 draw calls/26,344 triangles on desktop 1.5× and 103 draw calls/25,135 triangles on emulated phone 2×; these are workload observations, not hardware FPS claims. No rules, AI, server/Worker transport, session keys, DB schema or migrations changed.

## Reversed drag and discoverable opening

The requested direct-drag correction reverses horizontal swivel and vertical tilt for both mouse and one-finger touch. Nine anchored-input tests pass, including actual Three.js projections at multiple board orientations, clamping and rebase behavior. The four physical-board HTTP scenarios pass with real captured mouse/native touch: reversed signs, held-drag wheel zoom, pinch zoom, surviving-contact rebase, click thresholds, printed labels, empty pregame and real setup/rejoin remain correct.

Three new opening scenarios pass on the exact self-contained app. They verify the prominent folded-view Open board action, arrow and first-use instructions; a central target at least44×44px; visible persistent Open/Fold text on desktop and390px phone; keyboard/touch activation; isolated pointer input; idempotent double-click opening; and repeated folding with an unchanged real campaign, camera and preferences. One test initially assumed a fixed zoom endpoint; it was corrected to compare against the actual starting zoom, then passed without a product change. Desktop/mobile closed screenshots were visually inspected. Phone evidence is Chromium touch emulation, not a physical handset.

All four existing fold scenarios also pass, including live peer updates while folded, immediate reduced-motion endpoints and an actually disabled-WebGL fallback. This release reran11 relevant browser scenarios,9 input unit tests and5 exact packaged-asset/API/D1 checks; TypeScript and the self-contained production build pass. The prior89-test/22-browser release evidence above is retained for unchanged rules, AI and authority code; those unaffected full suites were not repeated. The browser suite now contains25 scenarios in total. No server, transport, game rules, schema, migration or session-key change.
