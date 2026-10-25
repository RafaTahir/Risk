import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import type { GameState, RoomState, Session } from '../shared/types';
import { TERRITORIES } from '../shared/world';

test.skip(process.env.RISK_TEST_HTTP !== '1', 'Fold persistence checks use real durable HTTP rooms.');

type Reply = { ok: boolean; error?: string; session?: Session; state?: RoomState };
type FoldState = 'folded' | 'opening' | 'open' | 'folding';
type BoardStats = {
  frames: number; drawCalls: number; rotation: number; tilt: number; zoom: number;
  foldProgress: number; leafAngles: number[]; foldTarget: boolean; foldTransitioning: boolean;
  territoryUnits: number; reserveUnits: number; countTokens: number;
  visibleFigures: number; clippedCountryParts: number; pieceWorldSamples: { half: number; x: number; y: number; z: number }[];
  surfaceLabelSamples: { id: string; corners: { x: number; y: number }[] }[];
};
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __riskBoardStats: BoardStats }).__riskBoardStats);
const presentation = (page: Page) => page.getByRole('main', { name: 'Risk tabletop', exact: true });
const labels = (page: Page) => page.locator('.board3d-labels [data-territory], .world-map-svg [data-territory]');
const territory = (page: Page, id: string) => labels(page).and(page.locator(`[data-territory="${id}"]`));
const foldButton = (page: Page, folded: boolean) => page.getByRole('button', { name: folded ? 'Open board' : 'Fold board', exact: true });

async function command(request: APIRequestContext, event: string, payload: unknown = {}, session?: Session): Promise<Reply> {
  const response = await request.post('/api/command', { data: { event, payload, ...(session ? { session } : {}) } });
  expect(response.ok()).toBe(true);
  const body = await response.json() as Reply;
  expect(body.ok, body.error).toBe(true);
  return body;
}
async function humanRoom(request: APIRequestContext) {
  const created = await command(request, 'room:create', { name: 'Fold host', mode: 'private', bots: 0, difficulty: 'veteran' });
  const seats = [created.session!];
  for (let i = 1; i < 3; i++) seats.push((await command(request, 'room:join', { name: `Fold guest ${i}`, code: seats[0].code })).session!);
  const started = await command(request, 'room:start', {}, seats[0]);
  const state = started.state!;
  const actor = seats.find(seat => seat.playerId === state.game!.players[state.game!.currentPlayer].id)!;
  return { actor, peer: seats.find(seat => seat.playerId !== actor.playerId)!, state };
}
async function poll(request: APIRequestContext, session: Session) {
  const response = await request.post('/api/poll', { data: { session } });
  expect(response.ok()).toBe(true);
  const body = await response.json() as Reply;
  expect(body.ok).toBe(true);
  return body.state!;
}
function logicalGame(game: GameState) {
  return { ...game, players: game.players.map(({ connected: _connected, ...player }) => player) };
}
function observe(page: Page) {
  const orders: unknown[] = [], errors: string[] = [], revisions: number[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/command') return;
    const body = request.postDataJSON();
    if (body.event === 'game:action') orders.push(body);
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/poll') void response.json().then((body: Reply) => { if (body.ok && body.state) revisions.push(body.state.revision); }).catch(() => undefined);
  });
  page.on('pageerror', error => errors.push(error.message));
  return { orders, errors, revisions };
}
async function sceneReady(page: Page) {
  await expect(page.locator('.board3d canvas')).toBeVisible();
  await expect.poll(async () => (await stats(page))?.drawCalls).toBeGreaterThan(0);
}
async function endpoint(page: Page, folded: boolean, use3D = true) {
  await expect(presentation(page)).toHaveAttribute('data-board-state', folded ? 'folded' : 'open');
  await expect(foldButton(page, folded)).toBeVisible();
  await expect(foldButton(page, folded)).toHaveAttribute('aria-expanded', folded ? 'false' : 'true');
  if (use3D) {
    await expect.poll(async () => (await stats(page)).foldProgress).toBeCloseTo(folded ? 1 : 0, 5);
    const scene = await stats(page);
    expect(scene.foldTransitioning).toBe(false);
    expect(scene.foldTarget).toBe(folded);
    expect(scene.leafAngles).toHaveLength(2);
    expect(scene.leafAngles[0]).toBeCloseTo(0, 5);
    expect(Math.abs(scene.leafAngles[1])).toBeCloseTo(folded ? Math.PI : 0, 5);
  }
}
async function openBoard(page: Page, use3D = true) {
  if (await presentation(page).getAttribute('data-board-state') !== 'open') await foldButton(page, true).click();
  await endpoint(page, false, use3D);
}
async function seat(page: Page, session: Session) {
  await page.addInitScript(value => sessionStorage.setItem('risk-world-command-session', JSON.stringify(value)), session);
  await page.goto('/');
  await expect(page.locator('.campaign')).toBeVisible();
}
async function select(page: Page, id: string) {
  await territory(page, id).focus();
  await page.keyboard.press('Enter');
  await expect(territory(page, id)).toHaveAttribute('aria-pressed', 'true');
}
async function deployOne(page: Page, id: string) {
  await select(page, id);
  await page.getByLabel('Number of armies', { exact: true }).fill('1');
  const reply = page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/command') return false;
    const body = response.request().postDataJSON();
    return body.event === 'game:action' && body.payload?.action?.type === 'deploy';
  });
  await page.getByRole('button', { name: 'Deploy armies', exact: true }).click();
  const result = await (await reply).json() as Reply;
  expect(result.ok, result.error).toBe(true);
  return result.state!;
}
async function menu(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open table menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Table menu', exact: true }).getByRole('button', { name, exact: true }).click();
}
async function capture(page: Page, info: TestInfo, name: string) {
  const path = `/tmp/risk-fold-${name}.png`;
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('initial physical board is genuinely folded; keyboard opening, closing and reversed hinges expose the same map', async ({ page }, info) => {
  const observed = observe(page);
  await page.goto('/');
  await sceneReady(page);
  await endpoint(page, true);
  expect((await stats(page)).territoryUnits).toBe(0);
  expect((await stats(page)).reserveUnits).toBe(0);
  expect((await stats(page)).countTokens).toBe(0);
  expect((await stats(page)).clippedCountryParts).toBeGreaterThan(42);
  await expect(page.getByRole('button', { name: 'Play solo', exact: true })).toHaveCount(0);
  await expect(labels(page).and(page.locator('[aria-disabled="false"]'))).toHaveCount(0);
  const closedChina = (await stats(page)).surfaceLabelSamples.find(sample => sample.id === 'china')!;
  await capture(page, info, 'initial-closed-back');
  await foldButton(page, true).focus();
  await page.keyboard.press('Enter');
  await endpoint(page, false);
  await expect(page.getByRole('button', { name: 'Play solo', exact: true })).toBeVisible();
  expect((await stats(page)).surfaceLabelSamples.find(sample => sample.id === 'china')!.corners).not.toEqual(closedChina.corners);
  await expect(page.locator('.board3d-labels text')).toHaveCount(0);
  await capture(page, info, 'open-printed-map');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await stats(page)).zoom).toBe(2);
  await capture(page, info, 'smooth-outline-detail');
  await page.getByRole('button', { name: 'Reset table view', exact: true }).click();
  // Both public button requests occur in one JS task. Even if React batches
  // them back to the original target, presentation callbacks must settle open.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Fold board"]')!;
    button.click(); button.click();
  });
  await endpoint(page, false);
  await expect(page.getByRole('button', { name: 'Play solo', exact: true })).toBeVisible();
  // Use the real public buttons from one browser-frame observer so protocol
  // latency cannot turn a requested reversal into a later complete cycle.
  const reversedAt = await page.evaluate(() => {
    const browser = window as unknown as { __riskBoardStats: BoardStats };
    document.querySelector<HTMLButtonElement>('button[aria-label="Fold board"]')!.click();
    return new Promise<number>((resolve, reject) => {
      const started = performance.now();
      const samples: { time: number; progress: number; frames: number; target: boolean }[] = [];
      const check = () => {
        const progress = browser.__riskBoardStats.foldProgress;
        samples.push({ time: Math.round(performance.now() - started), progress, frames: browser.__riskBoardStats.frames, target: browser.__riskBoardStats.foldTarget });
        if (progress > .4 && progress < .9) {
          document.querySelector<HTMLButtonElement>('button[aria-label="Open board"]')!.click();
          resolve(progress);
        } else if (progress >= .99 || performance.now() - started > 3000) reject(new Error(`No physical intermediate hinge pose was observed before reversal: ${JSON.stringify(samples.slice(-12))}`));
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  });
  expect(reversedAt).toBeGreaterThan(.4);
  expect(reversedAt).toBeLessThan(.9);
  await capture(page, info, 'hinge-reversal');
  await endpoint(page, false);
  for (let i = 0; i < 2; i++) {
    await foldButton(page, false).click(); await endpoint(page, true);
    await foldButton(page, true).click(); await endpoint(page, false);
  }
  expect(observed.orders).toEqual([]);
  expect(observed.errors).toEqual([]);
});

test('folding during real play cancels visual motion, blocks orders and reopens the latest multiplayer state', async ({ browser, request, baseURL }, info) => {
  const game = await humanRoom(request);
  const actorContext = await browser.newContext({ baseURL }), peerContext = await browser.newContext({ baseURL });
  try {
    const actor = await actorContext.newPage(), peer = await peerContext.newPage();
    const actorObserved = observe(actor), peerObserved = observe(peer);
    await seat(actor, game.actor); await sceneReady(actor); await endpoint(actor, true);
    await seat(peer, game.peer); await sceneReady(peer); await endpoint(peer, true);
    await openBoard(actor);
    await expect(labels(actor).and(actor.locator('[aria-disabled="false"]'))).toHaveCount(42);
    const origin = TERRITORIES.find(item => game.state.game!.territories[item.id].owner === game.actor.playerId)!;
    const view = await stats(actor);
    expect(view.visibleFigures).toBeGreaterThan(0);
    const rightFigure = view.pieceWorldSamples.find(sample => sample.half === 1)!;
    expect(rightFigure).toBeDefined();
    const settings = await actor.evaluate(() => Object.fromEntries(['risk-name', 'risk-quality', 'risk-table-view', 'risk-motion', 'risk-sound', 'risk-contrast'].map(key => [key, localStorage.getItem(key)])));
    // Pause only main-world animation frames to hold a real confirmed visual
    // order. Restore and click Fold synchronously before a renderer callback
    // can clear it; mechanics still use the real server throughout.
    await actor.evaluate(() => {
      const browser = window as unknown as { __foldOriginalRAF: typeof requestAnimationFrame };
      browser.__foldOriginalRAF = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 0;
    });
    const first = await deployOne(actor, origin.id);
    await expect(actor.getByRole('button', { name: 'Skip animation', exact: true })).toBeVisible();
    const transitionBlocked = await actor.evaluate(() => {
      const browser = window as unknown as { __foldOriginalRAF: typeof requestAnimationFrame };
      window.requestAnimationFrame = browser.__foldOriginalRAF;
      document.querySelector<HTMLButtonElement>('button[aria-label="Fold board"]')!.click();
      return new Promise<{ blocked: boolean; skipPresent: boolean }>((resolve, reject) => {
        const started = performance.now();
        const check = () => {
          const state = document.querySelector('main[aria-label="Risk tabletop"]')?.getAttribute('data-board-state');
          if (state === 'folding') resolve({ blocked: document.querySelectorAll('.board3d-labels [data-territory][aria-disabled="false"]').length === 0, skipPresent: Boolean(document.querySelector('button.skip-animation')) });
          else if (state === 'folded' || performance.now() - started > 3000) reject(new Error('No folding interaction gate was observed.'));
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
    });
    expect(transitionBlocked.blocked).toBe(true);
    expect(transitionBlocked.skipPresent).toBe(false);
    await endpoint(actor, true);
    expect((await stats(actor)).visibleFigures).toBe(0);
    expect((await stats(actor)).pieceWorldSamples.find(sample => sample.half === 1)).not.toEqual(rightFigure);
    await expect(actor.getByRole('button', { name: 'Skip animation', exact: true })).toHaveCount(0);
    await expect(actor.getByRole('complementary', { name: 'Turn controls', exact: true })).toHaveCount(0);
    await expect(labels(actor).and(actor.locator('[aria-disabled="false"]'))).toHaveCount(0);
    if (await labels(actor).count()) {
      const selection = await labels(actor).evaluateAll(nodes => nodes.filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.getAttribute('data-territory')));
      const another = TERRITORIES.find(item => item.id !== origin.id)!;
      await territory(actor, another.id).dispatchEvent('keydown', { key: 'Enter', bubbles: true });
      expect(await labels(actor).evaluateAll(nodes => nodes.filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.getAttribute('data-territory')))).toEqual(selection);
    }
    const finder = actor.getByRole('button', { name: 'Find territory', exact: true });
    if (await finder.count()) await expect(finder.first()).toBeDisabled();
    await actor.getByRole('button', { name: 'Open table menu', exact: true }).click();
    await expect(actor.getByRole('navigation', { name: 'Table menu', exact: true }).getByRole('button', { name: 'Find territory', exact: true })).toBeDisabled();
    await actor.keyboard.press('Escape');
    const beforeReopen = await poll(request, game.actor);
    expect(logicalGame(beforeReopen.game!)).toEqual(logicalGame(first.game!));
    expect(actorObserved.orders).toHaveLength(1);
    await openBoard(actor);
    expect((await stats(actor)).rotation).toBeCloseTo(view.rotation, 6);
    expect((await stats(actor)).tilt).toBeCloseTo(view.tilt, 6);
    expect((await stats(actor)).zoom).toBeCloseTo(view.zoom, 6);
    expect((await stats(actor)).visibleFigures).toBeGreaterThan(0);
    const reopenedFigure = (await stats(actor)).pieceWorldSamples.find(sample => sample.half === 1)!;
    expect(reopenedFigure.x).toBeCloseTo(rightFigure.x, 5);
    expect(reopenedFigure.y).toBeCloseTo(rightFigure.y, 5);
    expect(reopenedFigure.z).toBeCloseTo(rightFigure.z, 5);
    expect(await actor.evaluate(() => Object.fromEntries(['risk-name', 'risk-quality', 'risk-table-view', 'risk-motion', 'risk-sound', 'risk-contrast'].map(key => [key, localStorage.getItem(key)])))).toEqual(settings);
    const second = await deployOne(actor, origin.id);
    await expect.poll(() => peerObserved.revisions.some(revision => revision >= second.revision)).toBe(true);
    await endpoint(peer, true);
    await expect(peer.getByRole('button', { name: 'Skip animation', exact: true })).toHaveCount(0);
    expect(logicalGame((await poll(request, game.peer)).game!)).toEqual(logicalGame(second.game!));
    await openBoard(peer);
    await expect(territory(peer, origin.id)).toHaveAttribute('aria-label', new RegExp(`, ${second.game!.territories[origin.id].armies} armies`));
    await capture(peer, info, 'reopened-live-room');
    expect(logicalGame((await poll(request, game.peer)).game!)).toEqual(logicalGame(second.game!));
    expect(peerObserved.orders).toEqual([]);
    // Reload/resume may intentionally present a folded board again; it must
    // recover the same campaign and armies rather than deal a new setup.
    await actor.reload(); await expect(actor.locator('.campaign')).toBeVisible(); await sceneReady(actor);
    await openBoard(actor);
    expect(logicalGame((await poll(request, game.actor)).game!)).toEqual(logicalGame(second.game!));
    expect(actorObserved.errors).toEqual([]); expect(peerObserved.errors).toEqual([]);
  } finally { await actorContext.close(); await peerContext.close(); }
});

test('touch and reduced motion reach immediate physical fold endpoints without changing the campaign', async ({ browser, request, baseURL }, info) => {
  const game = await humanRoom(request);
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage(), observed = observe(page);
    await seat(page, game.actor); await sceneReady(page); await endpoint(page, true);
    await capture(page, info, 'mobile-folded');
    for (let i = 0; i < 3; i++) {
      await foldButton(page, true).tap(); await endpoint(page, false);
      expect((await stats(page)).foldTransitioning).toBe(false);
      await foldButton(page, false).tap(); await endpoint(page, true);
    }
    await foldButton(page, true).focus(); await page.keyboard.press('Space'); await endpoint(page, false);
    await capture(page, info, 'mobile-open');
    const state = await poll(request, game.actor);
    expect(logicalGame(state.game!)).toEqual(logicalGame(game.state.game!));
    expect(observed.orders).toEqual([]); expect(observed.errors).toEqual([]);
    const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
    expect(overflow.x).toBeLessThanOrEqual(1); expect(overflow.y).toBeLessThanOrEqual(1);
  } finally { await context.close(); }
});

test('WebGL-unavailable fallback keeps accessible Fold/Open and exact real armies', async ({ playwright, request, baseURL }) => {
  const game = await humanRoom(request);
  const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-webgl'] });
  try {
    const page = await browser.newPage({ baseURL }), observed = observe(page);
    await seat(page, game.actor);
    await endpoint(page, true, false);
    await openBoard(page, false);
    await expect(page.getByText('2D map · WebGL unavailable', { exact: true })).toBeVisible();
    await expect(page.locator('.world-map-svg')).toBeVisible();
    const origin = TERRITORIES.find(item => game.state.game!.territories[item.id].owner === game.actor.playerId)!;
    const confirmed = await deployOne(page, origin.id);
    await foldButton(page, false).click(); await endpoint(page, true, false);
    await expect(page.getByRole('button', { name: 'Skip animation', exact: true })).toHaveCount(0);
    await expect(labels(page).and(page.locator('[aria-disabled="false"]'))).toHaveCount(0);
    expect(logicalGame((await poll(request, game.actor)).game!)).toEqual(logicalGame(confirmed.game!));
    await openBoard(page, false);
    await expect(territory(page, origin.id)).toHaveAttribute('aria-label', new RegExp(`, ${confirmed.game!.territories[origin.id].armies} armies`));
    expect(observed.orders).toHaveLength(1); expect(observed.errors).toEqual([]);
  } finally { await browser.close(); }
});
