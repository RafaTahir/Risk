import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { RoomState, Session } from '../shared/types';
import { TERRITORIES } from '../shared/world';
import { openBoardIfNeeded } from './boardPresentation';

test.skip(process.env.RISK_TEST_HTTP !== '1', 'Animation recovery checks use real HTTP Worker rooms.');
type Reply = { ok: boolean; error?: string; session?: Session; state?: RoomState };

async function command(request: APIRequestContext, event: string, payload: unknown, session?: Session) {
  const response = await request.post('/api/command', { data: { event, payload, ...(session ? { session } : {}) } });
  expect(response.ok()).toBe(true);
  const result = await response.json() as Reply;
  expect(result.ok, result.error).toBe(true);
  return result;
}

async function room(request: APIRequestContext) {
  const host = await command(request, 'room:create', { name: 'Animation host', mode: 'private', bots: 0, difficulty: 'veteran' });
  const second = await command(request, 'room:join', { name: 'Animation second', code: host.session!.code });
  const third = await command(request, 'room:join', { name: 'Animation third', code: host.session!.code });
  const started = await command(request, 'room:start', {}, host.session!);
  const state = started.state!;
  const actor = [host.session!, second.session!, third.session!].find(seat => seat.playerId === state.game!.players[state.game!.currentPlayer].id)!;
  const from = TERRITORIES.find(territory => state.game!.territories[territory.id].owner === actor.playerId && territory.neighbors.some(id => state.game!.territories[id].owner !== actor.playerId))!;
  const to = from.neighbors.find(id => state.game!.territories[id].owner !== actor.playerId)!;
  return { state, actor, from: from.id, to };
}

async function openSeat(page: Page, actor: Session) {
  await page.addInitScript(seat => sessionStorage.setItem('risk-world-command-session', JSON.stringify(seat)), actor);
  await page.goto('/');
  await openBoardIfNeeded(page);
  await expect(page.locator('.campaign')).toBeVisible();
  await expect(page.getByTestId('turn-status')).toContainText('Your turn');
}

const label = (page: Page, id: string) => page.locator('.board3d-labels [data-territory], .world-map-svg [data-territory]').and(page.locator(`[data-territory="${id}"]`));
async function select(page: Page, id: string) {
  await label(page, id).focus();
  await page.keyboard.press('Enter');
  await expect(label(page, id)).toHaveAttribute('aria-pressed', 'true');
}

async function action(page: Page, name: string, type: string) {
  const reply = page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/command') return false;
    const data = response.request().postDataJSON() as { event?: string; payload?: { action?: { type?: string } } };
    return data.event === 'game:action' && data.payload?.action?.type === type;
  });
  await page.getByRole('button', { name, exact: true }).click();
  const result = await (await reply).json() as Reply;
  expect(result.ok, result.error).toBe(true);
  return result.state!;
}

async function tableMenu(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open table menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Table menu', exact: true }).getByRole('button', { name, exact: true }).click();
}

async function expectUnchanged(request: APIRequestContext, actor: Session, expected: RoomState) {
  const response = await request.post('/api/poll', { data: { session: actor } });
  const current = await response.json() as Reply;
  expect(current.ok).toBe(true);
  expect(current.state!.game).toEqual(expected.game);
}

test('WebGL fallback completes combat feedback without leaving Skip animation on the idle map', async ({ playwright, request, baseURL }) => {
  const game = await room(request);
  // A genuinely unavailable renderer exercises the fallback, rather than just
  // selecting the ordinary 2D preference with a working WebGL context.
  const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-webgl'] });
  try {
    const page = await browser.newPage({ baseURL });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const orders: unknown[] = [];
    page.on('request', req => {
      if (new URL(req.url()).pathname === '/api/command') { const data = req.postDataJSON(); if (data.event === 'game:action') orders.push(data); }
    });
    await openSeat(page, game.actor);
    await expect(page.getByText('2D map · WebGL unavailable', { exact: true })).toBeVisible();
    await select(page, game.from);
    await action(page, 'Deploy armies', 'deploy');
    await expect(page.getByRole('button', { name: 'Finish attacking', exact: true })).toBeVisible();
    await select(page, game.from); await select(page, game.to);
    const confirmed = await action(page, 'Roll for battle', 'attack');
    const combat = confirmed.game!.combat!;
    await expect(page.getByRole('button', { name: 'Skip animation', exact: true })).toHaveCount(0, { timeout: 1000 });
    await expect(label(page, game.from)).toHaveAttribute('aria-label', new RegExp(`, ${confirmed.game!.territories[game.from].armies} armies`));
    await expect(label(page, game.to)).toHaveAttribute('aria-label', new RegExp(`, ${confirmed.game!.territories[game.to].armies} armies`));
    const beforeReading = orders.length;
    await tableMenu(page, 'Battle report');
    const report = page.getByRole('dialog', { name: 'Battle report', exact: true });
    await expect(report.getByTestId('battle-casualties')).toContainText(`Attacker −${combat.attackerLoss}`);
    await expect(report.getByTestId('battle-casualties')).toContainText(`Defender −${combat.defenderLoss}`);
    await expect(report.getByLabel(`attacker dice: ${combat.attackDice.join(', ')}`, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await tableMenu(page, 'History');
    await expect(page.getByRole('dialog')).toContainText(confirmed.game!.log.slice().reverse().find(entry => entry.type === 'attack')!.text);
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByRole('button', { name: 'Skip animation', exact: true })).toHaveCount(0);
    await expectUnchanged(request, game.actor, confirmed);
    expect(orders).toHaveLength(beforeReading);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});

for (const transition of ['2D presentation', 'reduced motion'] as const) {
  test(`${transition} settles queued feedback without waiting for a stopped renderer`, async ({ page, request }) => {
    const game = await room(request);
    await openSeat(page, game.actor);
    await expect(page.locator('.board3d canvas')).toBeVisible();
    await select(page, game.from);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __riskBoardStats?: { opening: boolean } }).__riskBoardStats?.opening)).toBe(false);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // Presentation-only fixture: pause main-world browser animation frames.
    // React's scheduler, utility-world input and real HTTP orders remain live,
    // while the renderer cannot deliver its animation-end callback.
    await page.evaluate(() => {
      const browser = window as unknown as { __riskSuppressedAnimationFrames: number };
      browser.__riskSuppressedAnimationFrames = 0;
      window.requestAnimationFrame = () => { browser.__riskSuppressedAnimationFrames++; return 0; };
    });
    const confirmed = await action(page, 'Deploy armies', 'deploy');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __riskSuppressedAnimationFrames: number }).__riskSuppressedAnimationFrames)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Skip animation', exact: true })).toBeVisible();
    if (transition === '2D presentation') {
      await tableMenu(page, 'Display settings');
      await page.getByLabel('Board presentation', { exact: true }).selectOption('2d');
      await page.keyboard.press('Escape');
      await expect(page.locator('.world-map-svg')).toBeVisible();
    } else await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByRole('button', { name: 'Skip animation', exact: true })).toHaveCount(0, { timeout: 1000 });
    await expect(label(page, game.from)).toHaveAttribute('aria-label', new RegExp(`, ${confirmed.game!.territories[game.from].armies} armies`));
    await expectUnchanged(request, game.actor, confirmed);
  });
}
