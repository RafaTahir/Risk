The current preferred Sites route is the implemented Worker/D1 adapter described in [SITES.md](SITES.md). It does not require a continuously running Node process. This document covers the retained Node/container alternative.

# Node/container deployment (alternative to Worker/D1)

The Node/Socket.IO mode needs a continuously running Node.js server with HTTP and Socket.IO WebSocket/polling support. A static-site upload or an edge worker that cannot run this server is insufficient. No public endpoint has been deployed. A compatible hosting target, within the user's existing free access, remains to be selected before an actual deployment can proceed. The provided container requires no application credentials, external database, or paid API.

## Build and run

The Dockerfile installs from the npm lockfile, runs the automated tests and production build, and copies the server, shared rules, browser bundle, and dependencies into a Node.js 22 runtime image. The runtime uses the unprivileged `node` user. It retains development dependencies because `tsx`, which executes the TypeScript server, is currently declared there. The image build needs access to the Node base-image registry and npm registry.

From the repository root:

```sh
docker build -t risk-world-command:local .
docker run --detach --name risk-world-command \
  --publish 127.0.0.1:3002:3000 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  --stop-timeout 15 \
  risk-world-command:local
```

This binds the container to the local machine's loopback interface. It does not publish a public site or widen network access. A separately selected hosting platform would route its approved external endpoint to container port 3000. Do not expose the Docker daemon or add credentials to the image.

Local functional checks:

```sh
curl --fail http://127.0.0.1:3002/api/health
curl --fail --output /dev/null http://127.0.0.1:3002/
docker inspect --format '{{.State.Health.Status}}' risk-world-command
docker logs risk-world-command
```

The health endpoint must return `{"ok":true}` and the root route must serve the built application. Docker checks health every 30 seconds after startup. Logs do not contain session tokens. To stop only this container:

```sh
docker stop --time 15 risk-world-command
docker rm risk-world-command
```

Node runs directly as the container process. SIGTERM/SIGINT stop Socket.IO and HTTP resources; shutdown is bounded to ten seconds. Allow at least fifteen seconds before an external supervisor force-kills the container.

## Routing and hosting requirements

Use exactly one application instance. Preserve the original browser-facing `Host` header, support WebSocket upgrades, and forward HTTP polling as well as WebSocket traffic on `/socket.io/`. Serve browser assets and Socket.IO from the same origin, with TLS terminated by the chosen host or reverse proxy. Handshake origin checks apply to both transports. The server deliberately does not enable wildcard CORS or trust arbitrary forwarded client-address headers.

The application binds `0.0.0.0` inside the container, using `PORT` or 3000. The Docker healthcheck follows the same environment variable; if changing `PORT`, adjust the container port mapping too. No writable application directory is needed; a writable ephemeral `/tmp` supports runtime temporary files. No persistent volume currently preserves games.

Source-address event limits see the transport peer. Behind a proxy, clients share that proxy address's allowance, so a large deployment needs appropriate upstream connection and rate handling. The current app is sized for small private games, with six commanders per room and bounded in-memory rooms and command receipts.

## Persistence and release limitations

**All rooms, game positions, tokens, and reconnect sessions live only in RAM.** A restart, crash, deployment, or hosting platform scale-to-zero event loses every active campaign. Offline rooms expire after 24 hours. Never present an upgrade or restart as preserving games. A rolling deployment across multiple independent instances also cannot preserve or coordinate existing sessions.

For reliable long-lived public campaigns, add and test durable state storage and a shared multiplayer coordinator before enabling multiple replicas or automatic replacement. The present container is appropriate for one continuously running instance whose players understand the restart limitation. A free host with short request lifetimes, no WebSocket support, forced suspension, or automatic replica changes is unsuitable without additional engineering.

The base image uses the maintained `node:22-bookworm-slim` tag. A release process may pin the verified image digest after pulling and checking it; no unverified digest is supplied here. The repository's `.dockerignore` excludes local dependency trees, build output, Git history, environment files, and common local credential/configuration directories.

Actual deployment remains blocked on selecting an available compatible host within existing authorization. These files neither provision a service nor grant network access, and they do not establish that a public campaign endpoint exists.

## Validation in this workspace

The Docker client and daemon were available, and the official Node base image pulled successfully. The application image build did not complete: `npm ci` in Docker's isolated build network stalled, and a separate bounded npm registry probe using the environment's existing proxy bindings failed with `EAI_AGAIN` (DNS resolution failure). The owned build was stopped. TLS verification remained enabled; no network policy or credential changes were made.

The full primary Dockerfile installation/build remains **unverified**. Re-run it in a target with working registry DNS/network access before treating that release process as validated.

An earlier Node-release offline runtime check succeeded using the already downloaded official Node base image and the verified workspace dependencies and production assets. Only `package.json`, `tsconfig.json`, `node_modules`, `shared`, `server`, and `dist` were copied to a disposable context under `/tmp/risk-offline-container`; no environment files, Git data, browser storage, or credentials were copied. A temporary Dockerfile used the primary runtime command and healthcheck. The image `risk-world-command:validated-local` built with `--network=none`.

That runtime image passed Docker health checks, production HTML retrieval, real Socket.IO solo-game creation, computer-turn progression, and an authoritative human deployment action. It ran as user `node` with a read-only root, writable `/tmp`, all capabilities dropped, and only a loopback port binding. SIGTERM stopped it cleanly with exit code 0, and the test container was removed. This validates container runtime behavior from trusted workspace artifacts; it does not establish that the primary Dockerfile can install/build in this environment or that anything has been publicly deployed.

The offline container image evidence above predates the Worker transport addition. Do not present that image as the current Sites release. The current Worker bundle, durable D1 backend, and browser flows are validated separately with actual workerd/D1 and both frontend transports; see [VALIDATION.md](VALIDATION.md).
