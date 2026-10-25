import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { GameState, RoomState, Session } from '../shared/types';
import { TERRITORIES } from '../shared/world';
import { openBoardIfNeeded } from './boardPresentation';

test.skip(process.env.RISK_TEST_HTTP !== '1', 'Physical board checks use the real durable HTTP Worker.');
type Reply = { ok: boolean; error?: string; session?: Session; state?: RoomState };
type SurfaceSample = { id: string; corners: { x: number; y: number }[] };
type BoardStats = {
  frames: number; drawCalls: number; triangles: number; rotation: number; tilt: number; zoom: number; opening: boolean; fitDistance: number;
  territoryUnits: number; reserveUnits: number; countTokens: number; printedNameCount: number;
  labelPresentation: string; surfaceLabelSamples: SurfaceSample[];
};
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __riskBoardStats: BoardStats }).__riskBoardStats);
const labels = (page: Page) => page.locator('.board3d-labels [data-territory]');
const territory = (page: Page, id: string) => labels(page).and(page.locator(`[data-territory="${id}"]`));
async function command(request: APIRequestContext, event: string, payload: unknown = {}, session?: Session): Promise<Reply> {
  const response = await request.post('/api/command', { data: { event, payload, ...(session ? { session } : {}) } });
  expect(response.ok()).toBe(true);
  const body = await response.json() as Reply;
  expect(body.ok, body.error).toBe(true);
  return body;
}
async function tableMenu(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open table menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Table menu', exact: true }).getByRole('button', { name, exact: true }).click();
}
async function sceneReady(page: Page) {
  await expect(page.locator('.board3d canvas')).toBeVisible();
  await expect.poll(async () => (await stats(page))?.drawCalls).toBeGreaterThan(0);
  await expect.poll(async () => (await stats(page)).opening).toBe(false);
}
async function expectEmptyBoard(page: Page) {
  await sceneReady(page);
  await expect.poll(async () => {
    const scene = await stats(page);
    return [scene.territoryUnits, scene.reserveUnits, scene.countTokens];
  }).toEqual([0, 0, 0]);
  expect((await stats(page)).printedNameCount).toBe(42);
  await expect(labels(page)).toHaveCount(42);
  expect(await labels(page).evaluateAll(nodes => nodes.some(node => /, \d+ armies/.test(node.getAttribute('aria-label') || '')))).toBe(false);
}
function logicalGame(game: GameState) {
  // Presence changes while leaving/resuming are intentional; armies, setup,
  // turn, cards and history must survive without a new deal or demonstration.
  return { ...game, players: game.players.map(({ connected: _connected, ...player }) => player) };
}
function expectSetup(state: RoomState, playerCount: number) {
  const game = state.game!;
  expect(state.status).toBe('playing');
  expect(game.players).toHaveLength(playerCount);
  expect(Object.keys(game.territories)).toHaveLength(42);
  const allowance = ({ 3: 35, 4: 30, 5: 25, 6: 20 } as Record<number, number>)[playerCount];
  for (const player of game.players) {
    const owned = Object.values(game.territories).filter(item => item.owner === player.id);
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.reduce((sum, item) => sum + item.armies, 0)).toBe(allowance);
  }
  expect(Object.values(game.territories).every(item => game.players.some(player => player.id === item.owner) && item.armies >= 1)).toBe(true);
}
async function humanRoom(request: APIRequestContext, count = 3) {
  const host = await command(request, 'room:create', { name: 'Physical host', mode: 'private', bots: 0, difficulty: 'veteran' });
  const seats = [host.session!];
  for (let index = 1; index < count; index++) seats.push((await command(request, 'room:join', { name: `Physical ${index + 1}`, code: host.session!.code })).session!);
  const started = await command(request, 'room:start', {}, host.session!);
  expectSetup(started.state!, count);
  const actor = seats.find(seat => seat.playerId === started.state!.game!.players[started.state!.game!.currentPlayer].id)!;
  return { actor, state: started.state! };
}
async function openSeat(page: Page, seat: Session) {
  await page.addInitScript(value => sessionStorage.setItem('risk-world-command-session', JSON.stringify(value)), seat);
  await page.goto('/');
  await openBoardIfNeeded(page);
  await expect(page.locator('.campaign')).toBeVisible();
  await sceneReady(page);
}
async function capture(page: Page, info: TestInfo, name: string) {
  const path = `/tmp/risk-physical-${name}.png`;
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
  if (name === 'desktop-surface' || name === 'mobile-surface') {
    const scene = await stats(page);
    const workload = { drawCalls: scene.drawCalls, triangles: scene.triangles, frames: scene.frames, zoom: scene.zoom, territoryUnits: scene.territoryUnits, reserveUnits: scene.reserveUnits };
    const metricsPath = `/tmp/risk-physical-${name}-scene.json`;
    await writeFile(metricsPath, JSON.stringify(workload, null, 2));
    await info.attach(`${name} workload`, { path: metricsPath, contentType: 'application/json' });
  }
}
async function ownedHitPoint(page: Page, state: RoomState, playerId: string) {
  for (const item of TERRITORIES.filter(item => state.game!.territories[item.id].owner === playerId)) {
    const point = await territory(page, item.id).evaluate(element => {
      const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
      return { x, y, hit: x > 0 && x < innerWidth && y > 140 && y < innerHeight - 220 && element.contains(document.elementFromPoint(x, y)) };
    });
    if (point.hit) return { ...point, id: item.id };
  }
  throw new Error('No owned territory is directly reachable at this board view.');
}
function observeActions(page: Page) {
  const actions: unknown[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/command') return;
    const body = request.postDataJSON();
    if (body.event === 'game:action') actions.push(body);
  });
  return actions;
}
async function freshLobby(page: Page, name: string) {
  await page.getByRole('button', { name: 'Play with friends', exact: true }).click();
  await page.getByLabel('COMMANDER NAME', { exact: true }).fill(name);
  await page.getByRole('tab', { name: 'Multiplayer', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(/quick.*setup/i);
  const response = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/command' && reply.request().postDataJSON().event === 'room:create');
  await page.getByRole('button', { name: 'Create private room', exact: true }).click();
  const body = await (await response).json() as Reply;
  expect(body.ok, body.error).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Players', exact: true })).toBeVisible();
  return body.session!;
}

test('pregame and lobby stay empty; explicit quick setup, reload, cancellation and rejoin preserve real armies', async ({ page, request }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const actions = observeActions(page);
  await page.goto('/');
  await openBoardIfNeeded(page);
  await expectEmptyBoard(page);
  await capture(page, info, 'empty-pregame');
  const host = await freshLobby(page, 'Table host');
  await expectEmptyBoard(page);
  await command(request, 'room:join', { name: 'Table second', code: host.code });
  await command(request, 'room:join', { name: 'Table third', code: host.code });
  await expect(page.locator('.lobby-player')).toHaveCount(3);
  const startedReply = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/command' && reply.request().postDataJSON().event === 'room:start');
  await page.getByRole('button', { name: 'Begin world conquest', exact: true }).click();
  const started = (await (await startedReply).json() as Reply).state!;
  expectSetup(started, 3);
  await expect(page.locator('.campaign')).toBeVisible();
  await expect.poll(async () => (await stats(page)).territoryUnits).toBe(42);
  expect((await stats(page)).reserveUnits).toBeGreaterThan(0);
  expect((await stats(page)).countTokens).toBe(42);
  const expectedLabels = TERRITORIES.map(item => `${item.name}, ${started.game!.players.find(player => player.id === started.game!.territories[item.id].owner)!.name}, ${started.game!.territories[item.id].armies} armies`);
  for (const [index, item] of TERRITORIES.entries()) await expect(territory(page, item.id)).toHaveAttribute('aria-label', new RegExp(`^${expectedLabels[index]}`));
  await capture(page, info, 'started');
  await page.reload();
  await openBoardIfNeeded(page);
  await expect(page.locator('.campaign')).toBeVisible();
  await sceneReady(page);
  const resumed = (await request.post('/api/poll', { data: { session: host } })).json() as Promise<Reply>;
  expect(logicalGame((await resumed).state!.game!)).toEqual(logicalGame(started.game!));
  await tableMenu(page, 'New game');
  await expect(page.getByRole('dialog', { name: 'Leave the table?', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stay here', exact: true }).click();
  expect((await stats(page)).territoryUnits).toBe(42);
  await tableMenu(page, 'Leave table');
  await page.getByRole('dialog').getByRole('button', { name: 'Leave table', exact: true }).click();
  await expect(page.locator('.home')).toBeVisible();
  await expectEmptyBoard(page);
  const resumeReply = page.waitForResponse(reply => new URL(reply.url()).pathname === '/api/command' && reply.request().postDataJSON().event === 'room:resume');
  await page.getByRole('button', { name: 'Rejoin campaign', exact: true }).click();
  const rejoined = (await (await resumeReply).json() as Reply).state!;
  await expect(page.locator('.campaign')).toBeVisible();
  await expect.poll(async () => (await stats(page)).territoryUnits).toBe(42);
  expect(logicalGame(rejoined.game!)).toEqual(logicalGame(started.game!));
  await tableMenu(page, 'Leave table');
  await page.getByRole('dialog').getByRole('button', { name: 'Leave table', exact: true }).click();
  await expectEmptyBoard(page);
  await page.getByRole('button', { name: 'New game', exact: true }).click();
  await page.getByLabel('COMMANDER NAME', { exact: true }).fill('Fresh table');
  await page.getByRole('tab', { name: 'Multiplayer', exact: true }).click();
  await page.getByRole('button', { name: 'Create private room', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Players', exact: true })).toBeVisible();
  await expectEmptyBoard(page);
  expect(await page.locator('.room-code span').innerText()).not.toBe(host.code);
  expect(actions).toEqual([]);
  expect(errors).toEqual([]);
});

test('quick setup uses the documented initial allowance for every supported player count', async ({ request }) => {
  for (const count of [3, 4, 5, 6]) await humanRoom(request, count);
});

function sampleAngle(sample: SurfaceSample) {
  return Math.atan2(sample.corners[1].y - sample.corners[0].y, sample.corners[1].x - sample.corners[0].x);
}
async function settleCamera(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
  await settleCamera(page);
}

test('printed surface typography follows the board while captured mouse orbit and tilt use reversed drag axes', async ({ page, request }, info) => {
  const game = await humanRoom(request);
  const actions = observeActions(page);
  await openSeat(page, game.actor);
  await expect(page.locator('.board3d-labels text')).toHaveCount(0);
  const initial = await stats(page);
  expect(initial.fitDistance).toBeGreaterThan(0);
  expect(initial.labelPresentation).toBe('board-surface');
  expect(initial.printedNameCount).toBe(42);
  const labelSample = initial.surfaceLabelSamples.find(sample => sample.id === 'north-africa')!;
  expect(labelSample.corners).toHaveLength(4);
  expect(labelSample.corners.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  const viewport = page.viewportSize()!;
  const anchor = { x: viewport.width * .52, y: viewport.height * .44 };
  await drag(page, anchor, { x: anchor.x + 120, y: anchor.y });
  const right = await stats(page);
  expect(right.fitDistance).toBe(initial.fitDistance);
  expect(right.rotation - initial.rotation).toBeCloseTo(-120 / viewport.width * Math.PI, 2);
  const angle = sampleAngle(right.surfaceLabelSamples.find(sample => sample.id === 'north-africa')!);
  expect(Math.abs(angle - sampleAngle(labelSample))).toBeGreaterThan(.02);
  await drag(page, anchor, { x: anchor.x - 120, y: anchor.y });
  expect((await stats(page)).rotation).toBeCloseTo(initial.rotation, 2);
  await drag(page, anchor, { x: anchor.x, y: anchor.y - 80 });
  expect((await stats(page)).tilt - initial.tilt).toBeCloseTo(-80 / viewport.height * 60, 2);
  expect((await stats(page)).fitDistance).toBe(initial.fitDistance);
  await drag(page, anchor, { x: anchor.x, y: anchor.y + 80 });
  expect((await stats(page)).tilt).toBeCloseTo(initial.tilt, 2);
  await expect(labels(page).and(page.locator('[aria-pressed="true"]'))).toHaveCount(0);
  // Zoom is independent of orbit: continuing a held drag must not restore the
  // zoom stored when that drag began.
  await page.mouse.move(anchor.x, anchor.y); await page.mouse.down();
  try {
    await page.mouse.move(anchor.x + 40, anchor.y, { steps: 4 });
    const beforeWheel = (await stats(page)).zoom;
    await page.mouse.wheel(0, -160);
    await expect.poll(async () => (await stats(page)).zoom).toBeGreaterThan(beforeWheel);
    const wheelZoom = (await stats(page)).zoom;
    await page.mouse.move(anchor.x + 80, anchor.y, { steps: 4 });
    await settleCamera(page);
    expect((await stats(page)).zoom).toBeCloseTo(wheelZoom, 6);
  } finally { await page.mouse.up(); }
  await page.getByRole('button', { name: 'Reset table view', exact: true }).click();
  await settleCamera(page);
  // Pointer capture survives an excursion beyond the canvas/viewport and releases
  // after pointer-up. It must never become a territory order or leave a drag live.
  await page.evaluate(() => window.addEventListener('pointerdown', event => { (window as unknown as { __physicalPointer: number }).__physicalPointer = event.pointerId; }, { once: true }));
  await page.mouse.move(anchor.x, anchor.y); await page.mouse.down();
  expect(await page.locator('.board3d').evaluate(element => element.hasPointerCapture((window as unknown as { __physicalPointer: number }).__physicalPointer))).toBe(true);
  await page.mouse.move(-25, anchor.y, { steps: 6 }); await page.mouse.up();
  expect(await page.locator('.board3d').evaluate(element => element.hasPointerCapture((window as unknown as { __physicalPointer: number }).__physicalPointer))).toBe(false);
  await page.getByRole('button', { name: 'Reset table view', exact: true }).click();
  await expect.poll(async () => (await stats(page)).rotation).toBeCloseTo(initial.rotation, 2);
  await settleCamera(page);
  // This point comes from the actual printed North Africa surface, rather than
  // an invisible SVG hit rectangle. Picking must match the country beneath it.
  const physicalName = (await stats(page)).surfaceLabelSamples.find(sample => sample.id === 'north-africa')!;
  await page.mouse.click(physicalName.corners.reduce((sum, point) => sum + point.x, 0) / 4, physicalName.corners.reduce((sum, point) => sum + point.y, 0) / 4);
  await expect(territory(page, 'north-africa')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  const clickPoint = await ownedHitPoint(page, game.state, game.actor.playerId);
  await drag(page, clickPoint, { x: clickPoint.x + 3, y: clickPoint.y + 1 });
  await expect(territory(page, clickPoint.id)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(labels(page).and(page.locator('[aria-pressed="true"]'))).toHaveCount(0);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await settleCamera(page);
  await capture(page, info, 'desktop-surface');
  expect(actions).toEqual([]);
});

async function touchSequence(page: Page, points: { x: number; y: number; id: number }[], moves: { x: number; y: number; id: number }[][], lifted?: { x: number; y: number; id: number }[]) {
  const client = await page.context().newCDPSession(page);
  try {
    const input = (list: typeof points) => list.map(point => ({ ...point, radiusX: 2, radiusY: 2, force: 1 }));
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: input(points) });
    for (const move of moves) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: input(move) });
    if (lifted) {
      // CDP touchEnd lists the contacts being lifted, not those left on screen.
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: input(lifted) });
      return client;
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { if (!lifted) await client.detach(); }
  return null;
}

test('touch orbit, pinch and one-finger rebase keep the physical board controllable without issuing orders', async ({ browser, request, baseURL }, info) => {
  const game = await humanRoom(request);
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const actions = observeActions(page);
    await openSeat(page, game.actor);
    await expect(page.locator('.board3d-labels text')).toHaveCount(0);
    const initial = await stats(page);
    await touchSequence(page, [{ x: 180, y: 350, id: 0 }], [[{ x: 210, y: 350, id: 0 }], [{ x: 240, y: 350, id: 0 }]]);
    await expect.poll(async () => (await stats(page)).rotation - initial.rotation).toBeCloseTo(-60 / 390 * Math.PI, 2);
    const beforeUp = await stats(page);
    await touchSequence(page, [{ x: 180, y: 350, id: 0 }], [[{ x: 180, y: 325, id: 0 }], [{ x: 180, y: 300, id: 0 }]]);
    await expect.poll(async () => (await stats(page)).tilt - beforeUp.tilt).toBeCloseTo(-50 / 844 * 60, 2);
    const beforePinch = await stats(page);
    const client = await touchSequence(page, [{ x: 145, y: 360, id: 0 }, { x: 245, y: 360, id: 1 }], [
      [{ x: 135, y: 360, id: 0 }, { x: 255, y: 360, id: 1 }],
      [{ x: 120, y: 360, id: 0 }, { x: 270, y: 360, id: 1 }],
    ], [{ x: 270, y: 360, id: 1 }]);
    try {
      const pinched = await stats(page);
      expect(pinched.zoom).toBeGreaterThan(beforePinch.zoom);
      await client!.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 135, y: 360, id: 0, radiusX: 2, radiusY: 2, force: 1 }] });
      await expect.poll(async () => (await stats(page)).rotation - pinched.rotation).toBeCloseTo(-15 / 390 * Math.PI, 2);
      await client!.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await client!.detach(); }
    await page.getByRole('button', { name: 'Reset table view', exact: true }).tap();
    await settleCamera(page);
    const point = await ownedHitPoint(page, game.state, game.actor.playerId);
    await page.touchscreen.tap(point.x, point.y);
    await expect(territory(page, point.id)).toHaveAttribute('aria-pressed', 'true');
    await capture(page, info, 'mobile-overview');
    const overview = await stats(page);
    // The long-axis overview turns the printed board with the phone. A real
    // rightward drag with reversed swivel brings its lettering upright for closer reading.
    await touchSequence(page, [{ x: 95, y: 330, id: 0 }], [[{ x: 193, y: 330, id: 0 }], [{ x: 290, y: 330, id: 0 }]]);
    await expect.poll(async () => (await stats(page)).rotation).toBeCloseTo(overview.rotation - Math.PI / 2, 2);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
    await settleCamera(page);
    await capture(page, info, 'mobile-surface');
    expect(actions).toEqual([]);
    const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
    expect(overflow.x).toBeLessThanOrEqual(1); expect(overflow.y).toBeLessThanOrEqual(1);
  } finally { await context.close(); }
});
