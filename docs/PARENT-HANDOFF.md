# Exact transfer and starter integration

## Original packages retained unchanged

- `world-command-release.tar.gz`:689,496bytes; full source plus the earlier separately built frontend/Worker. SHA256 `0020d252892846e85aca1d12108fb4d9caf49e9614c270241047db4cf147c8be`.
- `world-command-sites-built.tar.gz`:560,791bytes; `public/` assets, `server/worker.js`, migration, SITES.md, and descriptive bundle-info.json. SHA256 `9eacd04ec90e872f6b914279c4f59c7676a17cf98aeef5e1761d898cc7ba39c1`.
- Earlier API-only Worker:46,394bytes, SHA256 `99562835770ba45475a0a91cb67f09586270d6639c83c1772fe860def141efe5`. It needs asset routing/ASSETS in addition to DB and is not the preferred simple-starter input.
- Frontend:16 files totalling1,230,947bytes:913,201bytes JS,44,048 CSS,272,836 fonts,618 HTML,244 faviconSVG.

These original artifacts are not overwritten during transfer preparation.

## Preferred self-contained Worker

The new standalone package has `worker/index.js` as its complete starter source input, plus the immutable schema migration and this handoff. The official simple starter copies that exact file to `dist/server/index.js`. It needs no external frontend directory, asset helper, ASSETS binding, npm runtime dependency, external import, or Vinext rewrite.

The compiled module is1,693,799bytes raw /697,830bytes gzip. It embeds the unchanged frontend assets and existing API. The public browser still downloads the original individual files. The module has a standard ESM default object with `fetch(request,env)`; a third `ctx` argument may be passed normally and is unused. The sole required runtime binding is logical **DB**, provisioned as D1 by Sites.

The parent must provide its official manifest at `dist/.openai/hosting.json`, declaring Worker ESM and DB/migration wiring according to its supported schema. There is currently **no hosting manifest** in this checkout or the generated packages. `bundle-info.json` and `transfer-report.json` are descriptive metadata, not platform manifests.

Migration source path: `migrations/0001_rooms.sql` (398bytes). It contains only:

```sql
CREATE TABLE rooms (
  code TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  next_ai_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX rooms_expiry ON rooms (expires_at);
```

Prepare one statement at a time or batch the two prepared statements through the official migration mechanism. Do not edit it after applying. Tested compatibility date:2026-08-01. The parent should preserve private access and perform actual endpoint validation after native preview/publication.

Validation:59 automated tests pass;8 standalone browser cases pass, including real private multiplayer/game turns, card privacy, reconnect, polling faults/stale state/removal/expiry, mobile/keyboard, and WebGL fallback. The live external-assets Worker restart check also preserved the browser's seat/42territories/turn/room; standalone actual-runtime tests verify persistent D1 restart without ASSETS.

## Git state and permission evidence

Read-only Git checks show existing origin `https://github.com/RafaTahir/Risk.git`, local unborn branch `work`, no local commit, and no remote refs or commit tip. Git does not advertise a default branch for this empty repo; onboarding requested `main`. The tested implementation was created from that empty checkout and is not based on any existing committed tip.

Native Git reads succeed. The existing authenticated credential binding can retrieve the Git receive-pack advertisement (HTTP200). That is read-only service-access evidence, not proof that a branch update is authorized or that repository/branch policies will allow it. A read-only GitHub permissions API request was blocked at CONNECT403, so API write permissions were not verified. No push, dry-run push, commit, branch change, merge, reset, or overwrite was performed.

No second repository or release branch is necessary. If the user approves Git transfer, the simplest path is a single initial commit to **main in the existing Risk repo**, after checking that the remote is still empty. The user need not manage branches. A first main push would create that remote branch; nothing should be force-pushed or overwrite a newly appeared remote commit. The user subsequently approved transfer through a new release branch and Sites deployment. The approved action preserves main and does not merge, force-push, change sharing, add accounts, or buy services. The parent handles the final Sites deployment.

For the approved transfer, the current source is committed to a dedicated release branch rather than main. The user does not need to manage that branch. Exact branch and verified remote commit SHA are reported after the push; previous empty-repository facts describe the pre-transfer baseline.
