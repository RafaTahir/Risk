import { test, expect, type Page, type Locator, type TestInfo } from '@playwright/test';
import { TERRITORIES } from '../shared/world';
import type { RoomState, Session } from '../shared/types';

const http = process.env.RISK_TEST_HTTP === '1';
const screenshot = (name: string) => `/tmp/risk-${process.env.RISK_TEST_SCREENSHOT_PREFIX || (http ? 'worker-' : '')}${name}.png`;
type BoardStats = { frames: number; drawCalls: number; triangles: number; renderer: string; zoom: number; rotation: number; tilt: number; opening: boolean };
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __riskBoardStats: BoardStats }).__riskBoardStats);
const errors = (page: Page) => {
  const found: string[] = [];
  page.on('pageerror', error => found.push(error.message));
  page.on('console', message => { if (message.type() === 'error') found.push(`${message.text()} ${message.location().url}`); });
  return found;
};
function traffic(page: Page) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const socketRequests: string[] = []; const externalRequests: string[] = []; const polls: { state?: RoomState; ok: boolean }[] = []; const gameActions: unknown[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/socket.io')) socketRequests.push(url.href);
    if (/^https?:$/.test(url.protocol) && url.origin !== origin) externalRequests.push(url.href);
    if (url.pathname === '/api/command' && request.method() === 'POST') {
      const command = request.postDataJSON() as { event?: string } | null;
      if (command?.event === 'game:action') gameActions.push(command);
    }
  });
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (url.pathname.startsWith('/socket.io')) socketRequests.push(url.href);
    if (url.origin.replace(/^ws/, 'http') !== origin) externalRequests.push(url.href);
    socket.on('framesent', frame => { if (typeof frame.payload === 'string' && frame.payload.includes('"game:action"')) gameActions.push(frame.payload); });
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/poll') void response.json().then(body => polls.push(body)).catch(() => undefined);
  });
  return { socketRequests, externalRequests, polls, gameActions };
}
function expectLocalHttp(network: ReturnType<typeof traffic>) { expect(network.socketRequests).toEqual([]); expect(network.externalRequests).toEqual([]); }
const session = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('risk-world-command-session') || 'null') as Session | null);
async function tableMenu(page: Page, action: string) {
  await page.getByRole('button', { name: 'Open table menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Table menu', exact: true }).getByRole('button', { name: new RegExp(`^${action}(?:\\s*\\d+)?$`) }).click();
}
async function closeDialog(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function newPrivateSetup(page: Page, name: string) {
  await page.getByRole('button', { name: 'Play with friends', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New game', exact: true })).toBeVisible();
  await page.getByLabel('COMMANDER NAME', { exact: true }).fill(name);
  await page.getByRole('tab', { name: 'Multiplayer', exact: true }).click();
}
async function privateLobby(page: Page, name: string) {
  await page.goto('/'); await newPrivateSetup(page, name);
  await page.getByRole('button', { name: 'Create private room', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Players', exact: true })).toBeVisible();
  await expect(page.locator('.lobby-player')).toHaveCount(1);
  return page.locator('.room-code span').innerText();
}
async function joinLobby(page: Page, code: string, name: string) {
  await page.goto('/'); await newPrivateSetup(page, name);
  await page.getByRole('button', { name: 'Join a room', exact: true }).click();
  await page.getByLabel('ROOM CODE', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Join the table', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Players', exact: true })).toBeVisible();
  await expect(page.locator('.lobby-player')).toHaveCount(2);
}
const territory = (page: Page, id: string) => {
  const name = TERRITORIES.find(item => item.id === id)!.name;
  return page.locator('.board3d-labels [role=button], .world-map-svg [role=button]').and(page.getByRole('button', { name: new RegExp(`^${name},`) }));
};
async function territoryState(page: Page) {
  return page.locator('.board3d-labels [role=button], .world-map-svg [role=button]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') || ''));
}
async function center(locator: Locator) {
  const box = await locator.boundingBox(); expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}
async function canHit(locator: Locator) {
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect(); const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    return x > 0 && y > 0 && x < innerWidth && y < innerHeight && element.contains(document.elementFromPoint(x, y));
  });
}
async function settleCamera(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function tapTerritory(page: Page, id: string) {
  const label = territory(page, id); expect(await canHit(label)).toBe(true);
  const point = await center(label); await page.touchscreen.tap(point.x, point.y);
  await expect(label).toHaveAttribute('aria-pressed', 'true');
}
async function chooseTerritory(page: Page, id: string) {
  const label = territory(page, id);
  if (await canHit(label)) await label.click();
  else {
    // The optional finder also reaches territories behind the small floating dock.
    await tableMenu(page, 'Find territory');
    await page.getByLabel('Choose a territory', { exact: true }).selectOption(id);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
}
async function expectBoardViewport(page: Page, minimum: number) {
  const measurements = await page.locator('.board3d canvas, .world-map-svg').evaluate(element => {
    const rect = element.getBoundingClientRect();
    const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
    const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    return { coverage: width * height / (innerWidth * innerHeight), scrollX: document.documentElement.scrollWidth - innerWidth, scrollY: document.documentElement.scrollHeight - innerHeight };
  });
  expect(measurements.coverage).toBeGreaterThanOrEqual(minimum);
  expect(measurements.scrollX).toBeLessThanOrEqual(1);
  expect(measurements.scrollY).toBeLessThanOrEqual(1);
  return measurements;
}
async function expectSelectionClearOfDock(page: Page) {
  await expect(page.locator('.board3d-labels [data-selected="true"]')).toBeVisible();
  const overlap = await page.locator('.board3d-labels [data-selected="true"]').evaluate(element => {
    const selected = element.getBoundingClientRect(); const dock = document.querySelector('.cdock')?.getBoundingClientRect();
    if (!dock) return null;
    const width = Math.max(0, Math.min(selected.right, dock.right) - Math.max(selected.left, dock.left));
    const height = Math.max(0, Math.min(selected.bottom, dock.bottom) - Math.max(selected.top, dock.top));
    return { area: width * height, selected: { x: selected.x, y: selected.y, width: selected.width, height: selected.height }, dock: { x: dock.x, y: dock.y, width: dock.width, height: dock.height } };
  });
  expect(overlap, 'The contextual dock is present for a selected territory').not.toBeNull();
  expect(overlap!.area, `The selected territory remains visible above the contextual dock: ${JSON.stringify(overlap)}`).toBe(0);
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: screenshot(name), fullPage: false });
  await info.attach(name, { path: screenshot(name), contentType: 'image/png' });
}
async function boardView(page: Page, view: '2d' | '3d') {
  await tableMenu(page, 'Display settings');
  await page.getByLabel('Board presentation', { exact: true }).selectOption(view);
  await closeDialog(page);
}
async function touchGesture(page: Page, start: { x: number; y: number }[], end: { x: number; y: number }[]) {
  const client = await page.context().newCDPSession(page);
  try {
    const points = (list: { x: number; y: number }[]) => list.map((point, id) => ({ ...point, id, radiusX: 2, radiusY: 2, force: 1 }));
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(start) });
    for (let step = 1; step <= 6; step++) {
      const list = start.map((point, index) => ({ x: point.x + (end[index].x - point.x) * step / 6, y: point.y + (end[index].y - point.y) * step / 6 }));
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(list) });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await client.detach(); }
}

test('viewport tabletop, real camera controls, fold, idle budget and accessible 2D view', async ({ page }, info) => {
  const failures = errors(page); const network = traffic(page); await page.goto('/');
  await expect(page.locator('.board3d canvas')).toBeVisible();
  await expect.poll(async () => (await stats(page))?.drawCalls).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  const measurements = await expectBoardViewport(page, .7);
  await expect(page.getByRole('button', { name: 'Play solo', exact: true })).toBeVisible();
  await capture(page, info, 'desktop');
  const before = await stats(page); await page.waitForTimeout(500); const after = await stats(page);
  expect(after.frames).toBe(before.frames); expect(after.triangles).toBeGreaterThan(0);
  await info.attach('WebGL idle metrics', { body: JSON.stringify({ before, after, measurements }), contentType: 'application/json' });
  const anchor = territory(page, 'north-africa'); const initialPosition = await center(anchor);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await stats(page)).zoom).toBeGreaterThan(before.zoom);
  await expect.poll(() => center(anchor)).not.toEqual(initialPosition);
  await page.getByLabel('Table view options', { exact: true }).click();
  const beforeOrbit = await stats(page); const preOrbitPosition = await center(anchor);
  await page.getByRole('button', { name: 'Rotate right', exact: true }).click();
  await expect.poll(async () => (await stats(page)).rotation).not.toBe(beforeOrbit.rotation);
  await expect.poll(() => center(anchor)).not.toEqual(preOrbitPosition);
  const beforeTilt = await stats(page); const preTiltPosition = await center(anchor);
  await page.getByRole('button', { name: 'Lower viewing angle', exact: true }).click();
  await expect.poll(async () => (await stats(page)).tilt).not.toBe(beforeTilt.tilt);
  await expect.poll(() => center(anchor)).not.toEqual(preTiltPosition);
  const prePanPosition = await center(anchor); await page.getByRole('button', { name: 'Pan east', exact: true }).click();
  await expect.poll(() => center(anchor)).not.toEqual(prePanPosition);
  const preFold = await stats(page); await page.getByRole('button', { name: 'Open board', exact: true }).click();
  await expect.poll(async () => (await stats(page)).opening).toBe(true);
  await expect.poll(async () => (await stats(page)).frames).toBeGreaterThan(preFold.frames);
  await page.waitForTimeout(800);
  const folded = await stats(page); await page.waitForTimeout(300); expect((await stats(page)).frames).toBe(folded.frames);
  await page.getByRole('button', { name: 'Reset table view', exact: true }).click();
  await boardView(page, '2d');
  await expect(page.locator('.world-map-svg')).toBeVisible(); await expect(page.locator('canvas')).toHaveCount(0);
  await expectBoardViewport(page, .7);
  const viewBox = await page.locator('.world-map-svg').getAttribute('viewBox');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.world-map-svg')).not.toHaveAttribute('viewBox', viewBox!);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await tableMenu(page, 'Display settings');
  await expect(page.getByText('Your system requests reduced motion.', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await tableMenu(page, 'Field manual');
  await expect(page.getByRole('dialog', { name: 'The art of conquest.', exact: true }).getByRole('heading', { name: 'Reinforce', exact: true })).toBeVisible();
  await closeDialog(page);
  expect(failures).toEqual([]); if (http) expectLocalHttp(network);
});

test('private seats, reload and rejoin, board selection and complete human turn', async ({ browser, baseURL }, info) => {
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  try {
    // Ordinary LAN HTTP and older browsers can lack secure-context randomUUID.
    for (const context of contexts) await context.addInitScript(() => { Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true }); });
    const [host, guest] = await Promise.all(contexts.map(context => context.newPage()));
    const failures = [host, guest].map(errors); const network = [host, guest].map(traffic);
    const code = await privateLobby(host, 'BrowserHost'); await joinLobby(guest, code, 'BrowserGuest');
    await expect(host.locator('.lobby-player').filter({ hasText: 'BrowserGuest' })).toBeVisible();
    await host.getByRole('button', { name: 'Add AI', exact: true }).click();
    await expect(host.locator('.lobby-player')).toHaveCount(3);
    await host.getByRole('button', { name: 'Begin world conquest', exact: true }).click();
    await expect(guest.locator('.campaign')).toBeVisible(); await expect(guest.getByRole('dialog')).toHaveCount(0);
    await guest.reload(); await expect(guest.locator('.campaign')).toBeVisible();
    const originalSeat = await session(guest);
    await tableMenu(guest, 'Leave table');
    await expect(guest.getByRole('dialog', { name: 'Leave the table?' })).toBeVisible();
    await guest.getByRole('dialog').getByRole('button', { name: 'Leave table', exact: true }).click();
    await expect(guest.locator('.resume-campaign')).toContainText(code);
    await guest.getByRole('button', { name: 'Rejoin campaign', exact: true }).click();
    await expect(guest.locator('.campaign')).toBeVisible(); expect(await session(guest)).toEqual(originalSeat);
    await expect.poll(async () => (await host.getByTestId('turn-status').filter({ hasText: 'Your turn' }).count()) + (await guest.getByTestId('turn-status').filter({ hasText: 'Your turn' }).count()), { timeout: 60_000 }).toBe(1);
    const page = await host.getByTestId('turn-status').filter({ hasText: 'Your turn' }).count() ? host : guest;
    const name = page === host ? 'BrowserHost' : 'BrowserGuest';
    await expectBoardViewport(page, .7);
    await page.waitForTimeout(1200); const idleBefore = await stats(page); const pollCounts = network.map(client => client.polls.length);
    if (http) await expect.poll(() => Math.min(...network.map((client, index) => client.polls.length - pollCounts[index])), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    else await page.waitForTimeout(1500);
    const idleAfter = await stats(page); expect(idleAfter.frames).toBe(idleBefore.frames);
    await info.attach('Network campaign idle render metrics', { body: JSON.stringify({ idleBefore, idleAfter, polls: network.map(client => client.polls.length) }), contentType: 'application/json' });
    const labels = await territoryState(page); const owned = TERRITORIES.filter(item => labels.some(label => label.startsWith(`${item.name}, ${name},`)));
    const strength = (item: typeof TERRITORIES[number]) => Number(labels.find(label => label.startsWith(`${item.name},`))?.match(/, (\d+) armies/)?.[1] || 0);
    const pairs = owned.flatMap(from => from.neighbors.filter(id => !owned.some(item => item.id === id)).map(id => ({ from, to: TERRITORIES.find(item => item.id === id)! })))
      .sort((a, b) => (strength(b.from) - strength(b.to)) - (strength(a.from) - strength(a.to)));
    expect(pairs.length).toBeGreaterThan(0);
    let pair: typeof pairs[number] | undefined;
    for (const candidate of pairs) {
      if (!await canHit(territory(page, candidate.from.id)) || !await canHit(territory(page, candidate.to.id))) continue;
      await territory(page, candidate.from.id).click();
      // Selecting an owned territory expands the contextual orders dock.
      if (await canHit(territory(page, candidate.to.id))) { pair = candidate; break; }
    }
    expect(pair, 'An adjacent battle pair can be selected directly on the board').toBeDefined();
    const { from, to } = pair!;
    await expect(territory(page, from.id)).toHaveAttribute('aria-pressed', 'true');
    // Moving beyond the gesture threshold orbits without changing the selection.
    const point = await center(territory(page, from.id)); const resetEnemyPoint = await center(territory(page, to.id)); const camera = await stats(page);
    const actionCount = network.reduce((total, client) => total + client.gameActions.length, 0);
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 65, point.y + 20, { steps: 6 }); await page.mouse.up();
    await expect.poll(async () => (await stats(page)).rotation).not.toBe(camera.rotation);
    await expect(territory(page, from.id)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Reset table view', exact: true }).click();
    await expect.poll(() => center(territory(page, to.id))).toEqual(resetEnemyPoint);
    // Natural pointer jitter below the threshold must still select a territory.
    const enemyPoint = await center(territory(page, to.id));
    await page.mouse.move(enemyPoint.x, enemyPoint.y); await page.mouse.down(); await page.mouse.move(enemyPoint.x + 2, enemyPoint.y + 1); await page.mouse.up();
    await expect(territory(page, to.id)).toHaveAttribute('aria-pressed', 'true');
    expect(network.reduce((total, client) => total + client.gameActions.length, 0)).toBe(actionCount);
    await territory(page, from.id).click(); await page.getByRole('button', { name: 'MAX', exact: true }).click();
    const preDeploy = await stats(page); await page.getByRole('button', { name: 'Deploy armies', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Finish attacking', exact: true })).toBeVisible();
    await page.waitForTimeout(1000); const postDeploy = await stats(page); expect(postDeploy.frames).toBeGreaterThan(preDeploy.frames);
    await info.attach('Deployment animation render metrics', { body: JSON.stringify({ preDeploy, postDeploy }), contentType: 'application/json' });
    await chooseTerritory(page, to.id);
    let rolls = 0;
    while (rolls < 30 && await page.getByRole('button', { name: 'Roll for battle', exact: true }).isEnabled().catch(() => false)) {
      await page.getByRole('button', { name: 'Roll for battle', exact: true }).click(); rolls++; await page.waitForTimeout(180);
      if (await page.getByRole('button', { name: 'Advance armies', exact: true }).count()) break;
    }
    expect(rolls).toBeGreaterThan(0); await expect(page.locator('.dice-row').first()).toBeVisible();
    const conquered = await page.getByRole('button', { name: 'Advance armies', exact: true }).count() > 0;
    if (conquered) { await page.getByRole('button', { name: 'Advance armies', exact: true }).click(); await expect(page.getByRole('button', { name: 'Finish attacking', exact: true })).toBeVisible(); }
    await capture(page, info, 'gameplay');
    await page.getByRole('button', { name: 'Finish attacking', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Skip & end turn', exact: true })).toBeVisible();
    const turn = await page.getByTestId('turn-status').innerText(); let fortified = false;
    if (conquered) {
      await chooseTerritory(page, to.id); await chooseTerritory(page, from.id);
      if (await page.getByRole('button', { name: 'Fortify & end turn', exact: true }).isEnabled()) { await page.getByRole('button', { name: 'Fortify & end turn', exact: true }).click(); fortified = true; }
    }
    if (!fortified) await page.getByRole('button', { name: 'Skip & end turn', exact: true }).click();
    await expect(page.getByTestId('turn-status')).not.toHaveText(turn);
    await tableMenu(page, 'Cards'); await expect(page.getByRole('dialog', { name: 'A hand worth playing.' })).toBeVisible();
    if (conquered) await expect(page.locator('.territory-card')).toHaveCount(1);
    await page.keyboard.press('Escape');
    if (http) {
      const sessions = await Promise.all([host, guest].map(session));
      expect(sessions.every(Boolean)).toBe(true); expect(sessions[0]!.playerId).not.toBe(sessions[1]!.playerId);
      await expect.poll(() => network.every(client => client.polls.some(reply => reply.state?.game))).toBe(true);
      for (const [index, client] of network.entries()) {
        expectLocalHttp(client);
        for (const reply of client.polls) {
          for (const member of sessions) expect(JSON.stringify(reply)).not.toContain(member!.token);
          expect(JSON.stringify(reply)).not.toContain('tokenHash');
          if (reply.state?.game) {
            expect(reply.state.game.deck).toEqual([]); expect(reply.state.game.discard).toEqual([]);
            expect(reply.state.game.players.filter(player => player.id !== sessions[index]!.playerId).every(player => player.cards.length === 0)).toBe(true);
          }
        }
      }
      if (conquered) {
        const opponent = page === host ? 1 : 0; const actor = sessions[1 - opponent]!.playerId;
        await expect.poll(() => network[opponent].polls.some(reply => reply.state?.game?.players.some(player => player.id === actor && player.cardCount >= 1 && player.cards.length === 0))).toBe(true);
      }
    }
    await info.attach('Human turn result', { body: JSON.stringify({ rolls, conquered, fortified, player: name }), contentType: 'application/json' });
    expect(failures.flat()).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('mobile emulation keeps the board visible and supports touch selection, orbit and pinch', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage(); const failures = errors(page); const network = traffic(page); await page.goto('/');
    await expect(page.locator('.board3d canvas')).toBeVisible(); await expectBoardViewport(page, .65);
    await capture(page, info, 'mobile');
    await page.getByRole('button', { name: 'Play solo', exact: true }).tap();
    await expect(page.locator('.campaign')).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('turn-status')).toContainText('Your turn', { timeout: 60_000 });
    await expectBoardViewport(page, .65);
    const labels = await territoryState(page);
    const commander = await page.evaluate(() => localStorage.getItem('risk-name') || 'Commander');
    const owned = TERRITORIES.filter(item => labels.some(label => label.startsWith(`${item.name}, ${commander},`)));
    let selectedId = ''; let lowest = -1;
    for (const item of owned) if (await canHit(territory(page, item.id))) {
      const point = await center(territory(page, item.id));
      if (point.y > lowest) { selectedId = item.id; lowest = point.y; }
    }
    expect(selectedId).not.toBe('');
    await tapTerritory(page, selectedId);
    await expect(page.getByRole('button', { name: 'Deploy armies', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Number of armies', { exact: true })).toBeVisible();
    await expectSelectionClearOfDock(page);
    const point = await center(territory(page, selectedId)); const beforeOrbit = await stats(page);
    const actionCount = network.gameActions.length;
    await touchGesture(page, [point], [{ x: point.x + 55, y: point.y + 15 }]);
    await expect.poll(async () => (await stats(page)).rotation).not.toBe(beforeOrbit.rotation);
    await expect(territory(page, selectedId)).toHaveAttribute('aria-pressed', 'true');
    const beforePinch = await stats(page);
    await touchGesture(page, [{ x: 145, y: 350 }, { x: 245, y: 350 }], [{ x: 105, y: 350 }, { x: 285, y: 350 }]);
    await expect.poll(async () => (await stats(page)).zoom).toBeGreaterThan(beforePinch.zoom);
    expect(network.gameActions.length).toBe(actionCount);
    await settleCamera(page);
    await expectBoardViewport(page, .65);
    let zoomedId = '';
    for (const item of owned) if (await canHit(territory(page, item.id))) { zoomedId = item.id; break; }
    expect(zoomedId).not.toBe(''); await tapTerritory(page, zoomedId);
    await expectSelectionClearOfDock(page);
    await page.getByRole('button', { name: 'Reset table view', exact: true }).tap();
    await expectSelectionClearOfDock(page);
    await capture(page, info, 'mobile-gameplay');
    await page.getByRole('button', { name: 'Deploy armies', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Finish attacking', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 844, height: 390 }); await expectBoardViewport(page, .65);
    // Rotating the emulated device must fit the board across the wider viewport.
    await expect.poll(() => page.locator('.board3d-labels [role=button]').evaluateAll(elements => {
      const boxes = elements.filter(element => getComputedStyle(element).visibility !== 'hidden').map(element => element.getBoundingClientRect());
      return (Math.max(...boxes.map(box => box.right)) - Math.min(...boxes.map(box => box.left))) / innerWidth;
    })).toBeGreaterThan(.4);
    await settleCamera(page);
    let landscapeId = '';
    for (const item of owned) if (await canHit(territory(page, item.id))) { landscapeId = item.id; break; }
    expect(landscapeId).not.toBe(''); await tapTerritory(page, landscapeId);
    await expectSelectionClearOfDock(page);
    await capture(page, info, 'mobile-landscape');
    await tableMenu(page, 'Players');
    await expect(page.locator('.lobby-player')).toHaveCount(4);
    await expect(page.locator('.lobby-player').first()).toContainText(/\d+ territories · \d+ armies · \d+ cards/);
    await closeDialog(page);
    await tableMenu(page, 'Cards');
    await expect(page.getByRole('dialog', { name: 'A hand worth playing.', exact: true })).toBeVisible();
    await closeDialog(page);
    await boardView(page, '2d'); await expect(page.locator('.world-map-svg')).toBeVisible(); await expectBoardViewport(page, .65);
    let tacticalId = '';
    for (const item of TERRITORIES) if (await canHit(territory(page, item.id))) { tacticalId = item.id; break; }
    expect(tacticalId).not.toBe(''); await tapTerritory(page, tacticalId);
    expect(failures).toEqual([]); if (http) expectLocalHttp(network);
  } finally { await context.close(); }
});

test('WebGL unavailable uses a functional accessible full-viewport map', async ({ playwright, baseURL }) => {
  const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-webgl'] });
  try {
    const page = await browser.newPage(); const pageErrors: string[] = []; const network = traffic(page); page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(baseURL!); await expect(page.getByText('2D map · WebGL unavailable')).toBeVisible();
    await expect(page.locator('.world-map-svg')).toBeVisible(); await expectBoardViewport(page, .7);
    await page.getByRole('button', { name: 'Play solo', exact: true }).click(); await expect(page.locator('.campaign')).toBeVisible();
    await territory(page, 'north-africa').click(); await expect(territory(page, 'north-africa')).toHaveAttribute('aria-pressed', 'true');
    expect(pageErrors).toEqual([]); if (http) expectLocalHttp(network);
  } finally { await browser.close(); }
});

test.describe('durable HTTP browser synchronization', () => {
  test.skip(!http, 'Run against the Worker with RISK_TEST_HTTP=1.');

  test('polling disconnect recovers automatically without losing the seat', async ({ page }) => {
    const network = traffic(page); const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
    await privateLobby(page, 'RecoveringHost'); const originalSeat = await session(page);
    await expect.poll(() => network.polls.length).toBeGreaterThan(0);
    await page.route('**/api/poll', route => route.abort('internetdisconnected'));
    await expect(page.locator('.connection')).toHaveAttribute('aria-label', 'RECONNECTING');
    await expect(page.getByRole('alert')).toContainText('Reconnecting automatically');
    await expect(page.locator('.lobby-player')).toHaveCount(1); await page.unroute('**/api/poll');
    await expect(page.locator('.connection')).toHaveAttribute('aria-label', 'Connected', { timeout: 15_000 });
    await expect(page.getByRole('alert')).toHaveCount(0); expect(await session(page)).toEqual(originalSeat);
    await page.getByRole('button', { name: 'Add AI', exact: true }).click(); await expect(page.locator('.lobby-player')).toHaveCount(2);
    expectLocalHttp(network); expect(pageErrors).toEqual([]);
  });

  test('an older in-flight poll cannot replace a newer command response', async ({ page }) => {
    const network = traffic(page); let captured = false; let released = false;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/poll', async route => {
      if (captured) { await route.continue(); return; }
      const response = await route.fetch(); const body = await response.json(); captured = true;
      await held; await route.fulfill({ response, json: body }); released = true;
    });
    try {
      await privateLobby(page, 'RevisionHost'); await expect.poll(() => captured).toBe(true);
      await page.getByRole('button', { name: 'Add AI', exact: true }).click(); await expect(page.locator('.lobby-player')).toHaveCount(2);
      release(); await expect.poll(() => released).toBe(true); await page.waitForTimeout(250);
      expect(await page.locator('.lobby-player').count()).toBe(2);
      await expect.poll(() => network.polls.some(reply => reply.state?.players.length === 2)).toBe(true); expectLocalHttp(network);
    } finally { release(); await page.unroute('**/api/poll'); }
  });

  test('host removal returns the guest home and stops authenticated polling', async ({ browser, baseURL }) => {
    const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
    try {
      const [host, guest] = await Promise.all(contexts.map(context => context.newPage())); const network = traffic(guest); const hostNetwork = traffic(host);
      const code = await privateLobby(host, 'RemovingHost'); await joinLobby(guest, code, 'RemovedGuest');
      await expect(host.locator('.lobby-player').filter({ hasText: 'RemovedGuest' })).toBeVisible();
      await host.getByRole('button', { name: 'Remove RemovedGuest', exact: true }).click(); await expect(host.locator('.lobby-player')).toHaveCount(1);
      await expect(guest.getByRole('alert')).toContainText(/removed|invalid|expired/i); await expect(guest.locator('.home')).toBeVisible();
      expect(await session(guest)).toBeNull(); await expect(guest.getByRole('dialog', { name: 'Players', exact: true })).toHaveCount(0);
      const pollCount = network.polls.length; await guest.waitForTimeout(2600); expect(network.polls.length).toBe(pollCount);
      expectLocalHttp(network); expectLocalHttp(hostNetwork);
    } finally { await Promise.all(contexts.map(context => context.close())); }
  });

  test('an expired membership clears the campaign and permits a new room', async ({ page }) => {
    const network = traffic(page); const code = await privateLobby(page, 'ExpiredHost');
    await page.route('**/api/poll', route => route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'This room has expired.' }) }));
    await expect(page.locator('.home')).toBeVisible(); await expect(page.getByRole('alert')).toContainText(/expired/i); expect(await session(page)).toBeNull();
    const pollCount = network.polls.length; await page.waitForTimeout(2600); expect(network.polls.length).toBe(pollCount);
    await page.unroute('**/api/poll'); await newPrivateSetup(page, 'ExpiredHost');
    await page.getByRole('button', { name: 'Create private room', exact: true }).click();
    await expect(page.locator('.lobby-player')).toHaveCount(1); expect(await page.locator('.room-code span').innerText()).not.toBe(code); expectLocalHttp(network);
  });
});
