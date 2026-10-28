import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { GameState, RoomState, Session } from '../shared/types';
import { TERRITORIES } from '../shared/world';
import { openBoardIfNeeded } from './boardPresentation';

test.skip(process.env.RISK_TEST_HTTP !== '1', 'Renderer clarity checks use real durable HTTP rooms.');
type Reply = { ok: boolean; error?: string; state?: RoomState; session?: Session };
async function command(request: APIRequestContext, event: string, payload: unknown = {}, session?: Session) {
  const response = await request.post('/api/command', { data: { event, payload, ...(session ? { session } : {}) } });
  expect(response.ok()).toBe(true);
  const body = await response.json() as Reply;
  expect(body.ok, body.error).toBe(true);
  return body;
}
async function humanRoom(request: APIRequestContext) {
  const created = await command(request, 'room:create', { name: 'Renderer host', mode: 'private', bots: 0, difficulty: 'veteran' });
  const seats = [created.session!];
  for (let i = 1; i < 3; i++) seats.push((await command(request, 'room:join', { name: `Renderer guest ${i}`, code: seats[0].code })).session!);
  const state = (await command(request, 'room:start', {}, seats[0])).state!;
  const actor = seats.find(seat => seat.playerId === state.game!.players[state.game!.currentPlayer].id)!;
  return { actor, state };
}
async function openSeat(page: Page, session: Session) {
  await page.addInitScript(value => sessionStorage.setItem('risk-world-command-session', JSON.stringify(value)), session);
  await page.goto('/'); await openBoardIfNeeded(page);
  await expect(page.locator('.campaign')).toBeVisible();
  await expect(page.getByTestId('turn-status')).toContainText('Your turn');
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Open table menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Table menu', exact: true }).getByRole('button', { name: 'Display settings', exact: true }).click();
  return page.getByRole('dialog', { name: 'Set your table.', exact: true });
}
function observe(page: Page) {
  const errors: string[] = [], orders: unknown[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/command' && request.postDataJSON().event === 'game:action') orders.push(request.postDataJSON());
  });
  return { errors, orders };
}
function logical(game: GameState) {
  return { ...game, players: game.players.map(({ connected: _connected, ...player }) => player) };
}
async function unchanged(request: APIRequestContext, actor: Session, expected: GameState) {
  const response = await request.post('/api/poll', { data: { session: actor } });
  const body = await response.json() as Reply;
  expect(body.ok).toBe(true);
  expect(logical(body.state!.game!)).toEqual(logical(expected));
}

test('unavailable WebGL reports the active tactical map while preserving the preferred mode and real campaign', async ({ playwright, request, baseURL }, info) => {
  const room = await humanRoom(request);
  const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-webgl'] });
  try {
    const page = await browser.newPage({ baseURL }); const observed = observe(page);
    await openSeat(page, room.actor);
    await expect(page.locator('.world-map-svg')).toBeVisible();
    const dialog = await settings(page);
    await expect(dialog.getByTestId('active-renderer-status')).toContainText('Active: 2D tactical map');
    await expect(dialog.getByTestId('renderer-fallback-reason')).toContainText(/WebGL.*unavailable/i);
    await expect(dialog.getByLabel('Board presentation', { exact: true })).toHaveValue('3d');
    await expect(dialog.getByLabel('Graphics quality', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Piece animations', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Retry 3D renderer', exact: true })).toBeVisible();
    await page.screenshot({ path: '/tmp/risk-renderer-fallback-settings.png' });
    await info.attach('Truthful fallback settings', { path: '/tmp/risk-renderer-fallback-settings.png', contentType: 'image/png' });
    await dialog.getByLabel('Board presentation', { exact: true }).selectOption('2d');
    await expect(dialog.getByTestId('active-renderer-status')).toContainText('Active: 2D tactical map');
    await expect(dialog.getByRole('button', { name: 'Retry 3D renderer', exact: true })).toHaveCount(0);
    await expect(dialog.getByTestId('renderer-fallback-reason')).toHaveCount(0);
    await expect(dialog.getByLabel('Graphics quality', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Piece animations', { exact: true })).toBeDisabled();
    await dialog.getByLabel('Board presentation', { exact: true }).selectOption('3d');
    await expect(dialog.getByTestId('active-renderer-status')).toContainText('Active: 2D tactical map');
    await dialog.getByRole('button', { name: 'Retry 3D renderer', exact: true }).click();
    await expect(dialog.getByTestId('active-renderer-status')).toContainText('Active: 2D tactical map');
    await expect(dialog.getByLabel('Graphics quality', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Piece animations', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Fold board', exact: true }).click();
    await expect(page.getByRole('main', { name: 'Risk tabletop', exact: true })).toHaveAttribute('data-board-state', 'folded');
    await openBoardIfNeeded(page);
    const owned = TERRITORIES.find(t => room.state.game!.territories[t.id].owner === room.actor.playerId)!;
    const label = page.locator(`.world-map-svg [data-territory="${owned.id}"]`);
    await label.focus(); await page.keyboard.press('Enter');
    await expect(label).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Deploy armies', exact: true })).toBeEnabled();
    await unchanged(request, room.actor, room.state.game!);
    expect(observed.orders).toEqual([]); expect(observed.errors).toEqual([]);
  } finally { await browser.close(); }
});

test('working 3D settings and optional first-turn help explain legal moves and dice without issuing orders', async ({ page, request }, info) => {
  const room = await humanRoom(request), observed = observe(page);
  await openSeat(page, room.actor);
  await expect(page.locator('.board3d canvas')).toBeVisible();
  const dialog = await settings(page);
  await expect(dialog.getByTestId('active-renderer-status')).toContainText('Active: 3D tabletop');
  await expect(dialog.getByLabel('Board presentation', { exact: true })).toHaveValue('3d');
  await expect(dialog.getByLabel('Graphics quality', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Piece animations', { exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Retry 3D renderer', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const prompt = page.getByTestId('first-turn-guide');
  await expect(prompt).toBeVisible();
  const marked = await page.locator('.board3d-labels [data-eligible-source="true"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-territory')).sort());
  expect(marked).toEqual(TERRITORIES.filter(t => room.state.game!.territories[t.id].owner === room.actor.playerId).map(t => t.id).sort());
  await prompt.getByRole('button', { name: 'Show legal moves', exact: true }).click();
  const guide = page.getByRole('dialog', { name: 'Your turn, explained', exact: true });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole('tab', { name: 'Reinforce', exact: true })).toHaveAttribute('aria-selected', 'true');
  await guide.getByRole('tab', { name: 'Attack', exact: true }).click();
  await expect(guide.getByRole('tabpanel')).toContainText(/ties favor the defender/i);
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await page.reload(); await openBoardIfNeeded(page);
  await expect(page.getByTestId('first-turn-guide')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open table menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Table menu', exact: true }).getByRole('button', { name: 'Explain this phase', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your turn, explained', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: '/tmp/risk-renderer-readable-board.png' });
  await info.attach('Printed labels and optional coaching', { path: '/tmp/risk-renderer-readable-board.png', contentType: 'image/png' });
  // Lose an actual live graphics context, then recover through the player-facing
  // retry action. This exercises runtime failure as well as constructor failure.
  const contextLossSupported = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.board3d canvas')!;
    const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    extension.loseContext(); return true;
  });
  expect(contextLossSupported).toBe(true);
  await expect(page.locator('.world-map-svg')).toBeVisible();
  const recoveredSettings = await settings(page);
  await expect(recoveredSettings.getByTestId('active-renderer-status')).toContainText('Active: 2D tactical map');
  await expect(recoveredSettings.getByLabel('Graphics quality', { exact: true })).toBeDisabled();
  await expect(recoveredSettings.getByLabel('Piece animations', { exact: true })).toBeDisabled();
  await recoveredSettings.getByRole('button', { name: 'Retry 3D renderer', exact: true }).click();
  await expect(page.locator('.board3d canvas')).toBeVisible();
  await expect(recoveredSettings.getByTestId('active-renderer-status')).toContainText('Active: 3D tabletop');
  await expect(recoveredSettings.getByLabel('Graphics quality', { exact: true })).toBeEnabled();
  await expect(recoveredSettings.getByLabel('Piece animations', { exact: true })).toBeEnabled();
  expect(await page.locator('.board3d canvas').evaluate((canvas: HTMLCanvasElement) => canvas.getContext('webgl2')?.isContextLost())).toBe(false);
  await page.keyboard.press('Escape');
  await unchanged(request, room.actor, room.state.game!);
  expect(observed.orders).toEqual([]); expect(observed.errors).toEqual([]);
});
