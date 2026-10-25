# World Command

A browser world-conquest game inspired by classic Risk, with a lightweight 3D board, computer opponents, and private multiplayer rooms. Both multiplayer backends validate human and computer moves through the same rules engine: Node/Socket.IO for a conventional server, and Worker/HTTP with durable D1 storage for Sites.

## Run locally

Use Node.js 22 or later and npm. From this checkout:

```sh
npm ci
npm run dev
```

The application listens on port **3000**, on all network interfaces. Development serves React through Vite middleware on the same HTTP server as Socket.IO. Set `PORT` to choose another port. `GET /api/health` returns `{"ok":true}` when the HTTP service is responding.

```sh
npm test
npm run build
npm start
```

`npm test` runs the rules and actual Socket.IO integration tests. `npm run build` checks TypeScript and generates the browser bundle in `dist/`. `npm start` serves that bundle through Express in production mode; run the build first. The production entry point currently uses `tsx`, so retain development dependencies when installing this project for production, or add a separate server compilation step before using an install that omits them.

## Playing with other people

Create a private room and share its ten-character room code. Each person opens this application on the **same server** and enters that code with a commander name. The host manages the lobby and starts when 3–6 commanders, including any computer opponents, are present. A solo campaign starts immediately with one human and 2–5 computers. Turn order is randomized at the start.

A room code is an invitation to join a lobby, not a separate hosted game URL. On a LAN, other players must reach the machine running the server through its LAN address and configured port. Connections from outside that network require a separately arranged reachable host. **This repository does not include a deployed public endpoint, and no public deployment is performed by these instructions.**

Sessions reconnect to the existing player slot using a private token returned when joining. Opening a replacement connection with that token disconnects the previous socket for the same player. Keep tokens private. A network disconnect preserves the player's position; human turns wait for the human to return. Computers are never silently substituted for missing humans. When every human is offline, computer play pauses and resumes after a human reconnects.

## Rules

Campaigns use the 42-territory world map, six continent bonuses, automatic randomized initial placement, classic initial army allowances, and a minimum of three reinforcement armies. Reinforce, attack, occupy conquered territories, then make at most one adjacent-territory fortification or end the turn. Combat uses up to three attacker dice and two defender dice; ties favor the defender. At least one army remains behind.

Conquering at least one territory earns one card at the end of a turn. Exchange three matching symbols or one of each, with wild cards substituting; exchange values progress globally through 4, 6, 8, 10, 12, 15, then increase by 5. An owned territory represented in a traded set receives a two-army bonus. Eliminating an opponent transfers their cards. Forced inherited-card exchanges interrupt attacking as required. The last commander controlling the world wins.

## Architecture and deployment

- `shared/world.ts` defines territory geography and adjacency; `shared/game.ts` implements game rules; `shared/ai.ts` chooses legal computer actions.
- `server/app.ts` exports `createServer(options)` for embedding and integration tests. It returns the Express app, HTTP server, Socket.IO server, and an asynchronous `close()` cleanup function. Tests inject randomness, timer intervals, and room limits without opening a fixed port.
- `server/index.ts` binds the service and selects Vite middleware or production static assets. Shutdown closes transport and development asset resources.
- Clients receive room snapshots after accepted changes. Snapshots include public army positions and card counts, only the recipient's card identities, and empty deck/discard arrays. Private session tokens never appear in snapshots.

In **Node/Socket.IO mode**, rooms, tokens, games, and command receipts exist **only in server RAM**. Restarting the process loses every campaign and invalidates saved sessions. Offline rooms expire after 24 hours of inactivity, and empty lobbies are removed immediately when the final human explicitly leaves. This implementation supports one Node process; independent replicas do not share games. Durable storage and a shared multiplayer coordinator would be needed before running multiple interchangeable instances.

For a separately authorized deployment, serve the browser and Socket.IO from the same origin, terminate TLS at the host or a reverse proxy, preserve the original `Host` header, and forward WebSocket upgrades and HTTP polling for `/socket.io/`. The server checks browser handshake origins for both transports against that host and does not enable wildcard CORS. No credentials, database, third-party game service, or external API is needed. Origin checks protect browser cross-origin use; they are not authentication for arbitrary non-browser clients.

Limits include six commanders per room, 500 retained rooms, 16 KiB transport messages, 1 KiB serialized game commands, 24-character commander names, 120 events per socket per ten seconds, and 600 events per source address per ten seconds. Source-address rate bookkeeping is capped at 4,096 entries. With a reverse proxy, the transport sees the proxy's address, so that address's event allowance is shared; the app does not blindly trust forwarded IP headers. Place suitable connection/rate limits at the proxy for a larger public deployment. Successful command receipts are capped at 256 per player; replayed older commands still fail their stale revision check.

## Socket protocol

Connect Socket.IO to the application's origin. Every request takes the object payload below and an acknowledgement callback receiving `{ok:boolean,error?:string,session?:Session}`. `Session` contains `{code,playerId,token}`. Use an empty object for payload-free requests.

| Event | Payload | Behavior |
| --- | --- | --- |
| `room:create` | `{name,bots,difficulty,mode}` | Returns a session; mode is `solo` or `private`; difficulty is `recruit`, `veteran`, or `general`. |
| `room:join` | `{code,name}` | Joins an open private lobby and returns a session. Room codes are case-insensitive when joining. |
| `room:resume` | `Session` | Authenticates the original session, replaces any old socket, and sends the current snapshot. |
| `room:addBot` | `{difficulty}` | Host-only lobby action. |
| `room:removePlayer` | `{playerId}` | Host-only lobby action; the host cannot remove themself. |
| `room:start` | `{}` | Host-only; requires 3–6 players with all humans connected. |
| `game:action` | `{id,revision,action}` | Validates the authenticated player's turn and applies one legal game command. |
| `room:leave` | `{}` | Removes a lobby player; during a game it marks the player offline and preserves their slot for resumption. |

`room:state` emits the full sanitized `RoomState`, including a monotonically increasing `revision`. Create and join may emit the first snapshot before their acknowledgement. Subscribe before sending requests. A game command's `revision` must equal the latest received revision. Give each new command a unique `id` containing 1–80 letters, digits, underscores, or hyphens. Retry an uncertain delivery with the **same id, revision, and action**: cached successful commands acknowledge without applying again. Reusing an id for a different payload fails. Send a new id only for a genuinely new command. Invalid or stale commands return an error without changing the game.

`GameAction` is defined in `shared/types.ts`: `deploy`, `trade` (with optional `bonusTerritory`), `attack`, `occupy`, `endAttack`, `fortify`, or `endTurn`. Clients cannot provide dice results, modify player ownership, choose other players' actions, or directly replace game state.

`room:removed` informs a connected lobby player that the host removed their seat. `session:replaced` precedes disconnection when another socket resumes that same session. A client should clear the removed room, stop sending commands after replacement, and retain session credentials only as appropriate for its explicit leave/rejoin experience.

## Browser checks and review

With the application running on port 3000, run `npm run test:browser`. The provided Playwright configuration uses `/usr/bin/chromium`; set `CHROMIUM_PATH` for another compatible installation. Four scenarios cover actual production gameplay, separate networked clients, reconnect/return to a saved seat, mobile controls, reduced motion, real WebGL rendering, and disabled-WebGL fallback. See [the validation report](docs/VALIDATION.md) for measured results and scope.

The display offers polished or low-power 3D, an SVG tactical map, brief skippable army movements, optional sound, and system reduced-motion support. Fonts are self-hosted. A seat is retained in this tab when leaving an unfinished campaign; use **Rejoin campaign** in the command center while the server still exists. Closing the tab loses its session storage. Restarting Node mode loses its rooms; Worker/D1 rooms survive runtime restarts and expire after 24 hours of inactivity.

[Rules and automated choices](docs/RULES.md) · [Container deployment and current blockers](docs/DEPLOYMENT.md)

[Release handoff and compatible hosting paths](docs/RELEASE-HANDOFF.md)

## Sites-compatible Worker mode

The Worker adapter reuses the existing rules, AI, and interface. It uses authenticated HTTP commands and polling, with durable D1 state and optimistic concurrency protection. Session tokens are hashed in storage; card privacy, duplicate commands, concurrent AI requests, and restart recovery are tested.

```sh
npm run build:sites
npm run dev:worker
```

The local Worker serves the production UI and real D1 API together on internal port3001. Local D1 files are under `.worker-local/d1`, excluded from Git and release packages. The browser discovers `/api/transport` and switches automatically; there is no hardcoded external API endpoint.

Run `RISK_TEST_BASE_URL=http://127.0.0.1:3001 RISK_TEST_HTTP=1 npm run test:browser` for the Worker browser flows. `npm test` includes all54 engine, socket, SQLite concurrency/security, and actual workerd/D1 tests. Node browser runs execute four shared cases and skip four HTTP-only cases; Worker runs execute all eight.

Deployment inputs are `dist/` browser assets, `dist-worker/worker.js`, logical D1 binding `DB`, and `migrations/0001_rooms.sql`. The parent task has the Sites tools and verified manifest schema; this child produces the tested source/artifacts but does not provision or publish the site. See [the complete Worker guide](docs/SITES.md) and [current release handoff](docs/RELEASE-HANDOFF.md).

## Single-file Sites starter

Use `npm run build:sites:standalone` to produce `dist-sites/server/index.js`, which embeds the exact frontend and API and needs only the DB binding. `npm run dev:sites:standalone` validates it locally on port3002 without an ASSETS binding. The official parent starter can copy this module from worker/index.js to dist/server/index.js, generate dist/.openai/hosting.json, and apply migrations/0001_rooms.sql. All59 automated tests and8 standalone browser scenarios pass. See [the exact parent handoff](docs/PARENT-HANDOFF.md).
