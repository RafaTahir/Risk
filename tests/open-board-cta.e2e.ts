import { expect, test, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { GameState, RoomState, Session } from '../shared/types';

test.skip(process.env.RISK_TEST_HTTP !== '1', 'Open-board controls are checked against the real HTTP app.');

type Reply = { ok: boolean; error?: string; state?: RoomState; session?: Session };
type BoardStats = {
  drawCalls: number; rotation: number; tilt: number; zoom: number;
  foldProgress: number; territoryUnits: number; reserveUnits: number; countTokens: number;
};
const table = (page: Page) => page.getByRole('main', { name: 'Risk tabletop', exact: true });
const primary = (page: Page) => page.getByTestId('open-board-cta');
const header = (page: Page, folded: boolean) => page.getByRole('button', { name: folded ? 'Open board' : 'Fold board', exact: true });
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __riskBoardStats: BoardStats }).__riskBoardStats);
const preferences = (page: Page) => page.evaluate(() => Object.fromEntries(
  ['risk-name', 'risk-quality', 'risk-table-view', 'risk-motion', 'risk-sound', 'risk-contrast'].map(key => [key, localStorage.getItem(key)]),
));

function observe(page: Page) {
  const commands: string[] = [], errors: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/command') commands.push(request.postDataJSON().event);
  });
  page.on('pageerror', error => errors.push(error.message));
  return { commands, errors };
}
async function ready(page: Page) {
  await expect(page.locator('.board3d canvas')).toBeVisible();
  await expect.poll(async () => (await stats(page))?.drawCalls).toBeGreaterThan(0);
}
async function endpoint(page: Page, folded: boolean) {
  await expect(table(page)).toHaveAttribute('data-board-state', folded ? 'folded' : 'open');
  await expect(header(page, folded)).toBeVisible();
  await expect(header(page, folded)).toHaveAttribute('aria-expanded', folded ? 'false' : 'true');
  await expect.poll(async () => (await stats(page)).foldProgress).toBeCloseTo(folded ? 1 : 0, 5);
  await expect(primary(page)).toHaveCount(folded ? 1 : 0);
}
async function visibleHeaderText(page: Page, folded: boolean) {
  const button = header(page, folded);
  const visibleText = await button.locator('span').evaluateAll(nodes => nodes
    .filter(node => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0)
    .map(node => node.textContent).join(' '));
  expect(visibleText).toMatch(folded ? /Open/ : /Fold/);
}
async function targetSize(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  return box!;
}
async function prompt(page: Page, firstUse: boolean) {
  const card = page.getByTestId('fold-open-prompt');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('open-board-arrow')).toBeVisible();
  await expect(primary(page)).toHaveAccessibleName('Open board and reveal map');
  await expect(primary(page).getByText('Open board', { exact: true })).toBeVisible();
  if (firstUse) await expect(card).toContainText(/Click or tap Open board.*Keyboard: Tab, then Enter/);
  const box = await targetSize(primary(page)), viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect((box.x + box.width / 2) / viewport.width).toBeGreaterThan(.25);
  expect((box.x + box.width / 2) / viewport.width).toBeLessThan(.75);
  expect((box.y + box.height / 2) / viewport.height).toBeGreaterThan(.2);
  expect((box.y + box.height / 2) / viewport.height).toBeLessThan(.8);
  await visibleHeaderText(page, true);
  await expect(page.getByRole('navigation', { name: 'Table menu', exact: true })).toHaveCount(0);
}
function expectCameraSame(actual: BoardStats, before: BoardStats) {
  expect(actual.rotation).toBeCloseTo(before.rotation, 6);
  expect(actual.tilt).toBeCloseTo(before.tilt, 6);
  expect(actual.zoom).toBeCloseTo(before.zoom, 6);
}
async function installInputObserver(page: Page) {
  await page.evaluate(() => {
    const browser = window as unknown as { __ctaBoardPointers: number };
    browser.__ctaBoardPointers = 0;
    document.querySelector('.board3d')!.addEventListener('pointerdown', () => browser.__ctaBoardPointers++);
  });
}
async function noAccidentalBoardInput(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __ctaBoardPointers: number }).__ctaBoardPointers)).toBe(0);
  await expect(page.locator('[data-territory][aria-pressed="true"]')).toHaveCount(0);
}
async function capture(page: Page, info: TestInfo, name: string) {
  const path = `/tmp/risk-open-cta-${name}.png`;
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function command(request: APIRequestContext, event: string, payload: unknown = {}, session?: Session) {
  const response = await request.post('/api/command', { data: { event, payload, ...(session ? { session } : {}) } });
  expect(response.ok()).toBe(true);
  const body = await response.json() as Reply;
  expect(body.ok, body.error).toBe(true);
  return body;
}
async function humanRoom(request: APIRequestContext) {
  const created = await command(request, 'room:create', { name: 'Open host', mode: 'private', bots: 0, difficulty: 'veteran' });
  const seats = [created.session!];
  for (let index = 1; index < 3; index++) seats.push((await command(request, 'room:join', { name: `Open guest ${index}`, code: seats[0].code })).session!);
  const state = (await command(request, 'room:start', {}, seats[0])).state!;
  return { state, actor: seats.find(seat => seat.playerId === state.game!.players[state.game!.currentPlayer].id)! };
}
async function poll(request: APIRequestContext, session: Session) {
  const response = await request.post('/api/poll', { data: { session } });
  expect(response.ok()).toBe(true);
  const body = await response.json() as Reply;
  expect(body.ok, body.error).toBe(true);
  return body.state!;
}
function logicalGame(game: GameState) {
  return { ...game, players: game.players.map(({ connected: _connected, ...player }) => player) };
}

test('folded desktop board advertises an in-board Open action without menu discovery or accidental orbit', async ({ page }, info) => {
  const observed = observe(page);
  await page.goto('/'); await ready(page); await endpoint(page, true);
  await prompt(page, true);
  const before = await stats(page);
  expect(before.territoryUnits).toBe(0); expect(before.reserveUnits).toBe(0); expect(before.countTokens).toBe(0);
  await expect(page.getByRole('button', { name: 'Play solo', exact: true })).toHaveCount(0);
  await capture(page, info, 'desktop-folded');
  await installInputObserver(page);
  await primary(page).click(); await endpoint(page, false);
  await expect(page.getByTestId('fold-open-prompt')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play solo', exact: true })).toBeVisible();
  await visibleHeaderText(page, false);
  expectCameraSame(await stats(page), before);
  await noAccidentalBoardInput(page);
  // A real fast double click must still mean "open", while the separate
  // persistent header control remains available for an intentional close.
  await header(page, false).click(); await endpoint(page, true);
  await primary(page).dblclick(); await endpoint(page, false);
  expectCameraSame(await stats(page), before);
  await expect(page.locator('[data-territory][aria-pressed="true"]')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('risk-world-command-session'))).toBeNull();
  expect(observed.commands).toEqual([]); expect(observed.errors).toEqual([]);
});

test('phone Open prompt and persistent Fold label work with touch and keyboard', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage(), observed = observe(page);
    await page.goto('/'); await ready(page); await endpoint(page, true); await prompt(page, true);
    await targetSize(header(page, true));
    await capture(page, info, 'mobile-folded');
    const before = await stats(page);
    await installInputObserver(page);
    await primary(page).tap(); await endpoint(page, false); await visibleHeaderText(page, false);
    await targetSize(header(page, false));
    await header(page, false).tap(); await endpoint(page, true); await prompt(page, false);
    await primary(page).focus();
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect(primary(page)).toBeFocused();
    await page.keyboard.press('Space'); await endpoint(page, false); await visibleHeaderText(page, false);
    expectCameraSame(await stats(page), before);
    await noAccidentalBoardInput(page);
    const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
    expect(overflow.x).toBeLessThanOrEqual(1); expect(overflow.y).toBeLessThanOrEqual(1);
    expect(observed.commands).toEqual([]); expect(observed.errors).toEqual([]);
  } finally { await context.close(); }
});

test('repeated prominent Open and persistent Fold preserve a real campaign, camera and preferences', async ({ browser, request, baseURL }, info) => {
  const game = await humanRoom(request);
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage(), observed = observe(page);
    await page.addInitScript(value => sessionStorage.setItem('risk-world-command-session', JSON.stringify(value)), game.actor);
    await page.goto('/'); await expect(page.locator('.campaign')).toBeVisible(); await ready(page); await endpoint(page, true);
    await prompt(page, true);
    const initialCommands = [...observed.commands];
    expect(initialCommands.every(event => event === 'room:resume')).toBe(true);
    await primary(page).click(); await endpoint(page, false);
    const startingZoom = (await stats(page)).zoom;
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect.poll(async () => (await stats(page)).zoom).toBeGreaterThan(startingZoom);
    const before = await stats(page), settings = await preferences(page);
    await installInputObserver(page);
    for (let iteration = 0; iteration < 2; iteration++) {
      await header(page, false).click(); await endpoint(page, true); await prompt(page, false);
      if (iteration === 0) await capture(page, info, 'campaign-folded');
      await primary(page).click(); await endpoint(page, false); await visibleHeaderText(page, false);
      expectCameraSame(await stats(page), before);
      expect(await preferences(page)).toEqual(settings);
    }
    const recovered = await poll(request, game.actor);
    expect(logicalGame(recovered.game!)).toEqual(logicalGame(game.state.game!));
    expect((await stats(page)).territoryUnits).toBeGreaterThan(0);
    await noAccidentalBoardInput(page);
    expect(observed.commands).toEqual(initialCommands); expect(observed.errors).toEqual([]);
  } finally { await context.close(); }
});
