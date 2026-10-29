import { randomBytes } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { GameState, RoomState, Session } from '../shared/types';
import { TERRITORIES, TERRITORY_BY_ID } from '../shared/world';
import { openBoardIfNeeded } from './boardPresentation';

// These scenarios supplement the complete multiplayer/browser suite. The first
// uses only real Worker rooms and commands; later presentation fixtures are
// explicitly identified and never presented as authoritative backend evidence.
test.skip(process.env.RISK_TEST_HTTP !== '1', 'Tactical UX checks use the durable HTTP Worker.');

type Reply = { ok: boolean; error?: string; session?: Session; state?: RoomState };
const boardLabels = (page: Page) => page.locator('.board3d-labels [data-territory], .world-map-svg [data-territory]');
const label = (page: Page, id: string) => boardLabels(page).and(page.locator(`[data-territory="${id}"]`));
function pageErrors(page: Page) { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); return errors; }

async function command(request: APIRequestContext, event: string, payload: unknown, session?: Session): Promise<Reply> {
  const response = await request.post('/api/command', { data: { event, payload, ...(session ? { session } : {}) } });
  expect(response.ok()).toBe(true);
  const body = await response.json() as Reply;
  expect(body.ok, body.error).toBe(true);
  return body;
}

async function humanRoom(request: APIRequestContext) {
  const host = await command(request, 'room:create', { name: 'Clarity host', mode: 'private', bots: 0, difficulty: 'veteran' });
  const second = await command(request, 'room:join', { name: 'Clarity second', code: host.session!.code });
  const third = await command(request, 'room:join', { name: 'Clarity third', code: host.session!.code });
  const started = await command(request, 'room:start', {}, host.session!);
  const sessions = [host.session!, second.session!, third.session!];
  const state = started.state!;
  const actor = sessions.find(seat => seat.playerId === state.game!.players[state.game!.currentPlayer].id)!;
  return { actor, sessions, state };
}

async function openSeat(page: Page, seat: Session) {
  await page.addInitScript(value => sessionStorage.setItem('risk-world-command-session', JSON.stringify(value)), seat);
  await page.goto('/');
  await openBoardIfNeeded(page);
  await expect(page.locator('.campaign')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('turn-status')).toContainText('Your turn');
  await expect(page.locator('.board3d canvas')).toBeVisible();
}

async function select(page: Page, id: string) {
  // Keyboard activation reaches even an off-screen/overlaid projected badge,
  // exercising the same accessible selection handler as visible board input.
  await label(page, id).focus();
  await page.keyboard.press('Enter');
  await expect(label(page, id)).toHaveAttribute('aria-pressed', 'true');
}

async function marked(page: Page, attribute: string) {
  return boardLabels(page).evaluateAll((elements, name) => elements.filter(element => element.getAttribute(name) === 'true').map(element => element.getAttribute('data-territory')!).sort(), attribute);
}

function eligible(game: GameState, player: string) {
  if (game.phase === 'reinforce') return TERRITORIES.filter(item => game.territories[item.id].owner === player).map(item => item.id).sort();
  return TERRITORIES.filter(item => {
    const state = game.territories[item.id];
    return state.owner === player && state.armies > 1 && item.neighbors.some(id => game.phase === 'attack' ? game.territories[id].owner !== player : game.territories[id].owner === player);
  }).map(item => item.id).sort();
}

async function tableMenu(page: Page, action: string) {
  await page.getByRole('button', { name: 'Open table menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Table menu', exact: true }).getByRole('button', { name: new RegExp(`^${action}(?:\\s*\\d+)?$`) }).click();
}

test('real multiplayer: legal origins and targets, truthful previews, cancel, pending protection and turn ownership', async ({ page, request }, info) => {
  const errors = pageErrors(page);
  const { actor, state } = await humanRoom(request);
  const game = state.game!;
  const observed: { event?: string; payload?: unknown }[] = [];
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/command') observed.push(req.postDataJSON()); });
  await openSeat(page, actor);
  await expect.poll(() => marked(page, 'data-eligible-source')).toEqual(eligible(game, actor.playerId));
  const source = TERRITORIES.find(item => game.territories[item.id].owner === actor.playerId && item.neighbors.some(id => game.territories[id].owner !== actor.playerId))!;
  await select(page, source.id);
  await page.getByRole('button', { name: 'MAX', exact: true }).click();
  await expect(page.getByTestId('action-preview')).toContainText(`${game.territories[source.id].armies + game.reinforcements} armies here`);
  await expect(page.getByTestId('action-preview')).toContainText('0 in reserve');
  // Keep the real server response in flight to inspect the pending UI. The
  // server commits exactly one deploy; this is not a fabricated command result.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let sent = 0;
  let deployed!: RoomState;
  await page.route('**/api/command', async route => {
    const data = route.request().postDataJSON() as { event?: string; payload?: { action?: { type?: string } } };
    if (data.event !== 'game:action' || data.payload?.action?.type !== 'deploy') return route.continue();
    sent++;
    const response = await route.fetch();
    deployed = (await response.json() as Reply).state!;
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Deploy armies', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(page.getByRole('button', { name: 'Deploy armies', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Deploy armies', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => sent).toBe(1);
    release();
    await expect(page.getByRole('button', { name: 'Finish attacking', exact: true })).toBeVisible();
  } finally { release(); await page.unroute('**/api/command'); }
  expect(sent).toBe(1);
  await expect.poll(() => marked(page, 'data-eligible-source')).toEqual(eligible(deployed.game!, actor.playerId));
  await select(page, source.id);
  const expectedTargets = source.neighbors.filter(id => deployed.game!.territories[id].owner !== actor.playerId).sort();
  await expect.poll(() => marked(page, 'data-valid-target')).toEqual(expectedTargets);
  const destination = expectedTargets.find(id => Math.abs(TERRITORY_BY_ID[id].x - source.x) < 550) ?? expectedTargets[0];
  await select(page, destination);
  await expect(page.getByRole('button', { name: 'Roll for battle', exact: true })).toBeEnabled();
  await expect(page.getByTestId('action-preview')).toContainText('ties defend');
  await expect(page.getByTestId('action-preview')).toContainText(/\d+% chance to remove a defender this roll/);
  if (Math.abs(TERRITORY_BY_ID[destination].x - source.x) < 550) await expect(page.getByTestId('board-route-preview')).toBeVisible();
  await page.screenshot({ path: '/tmp/risk-tactical-desktop.png' });
  await info.attach('Board-first tactical route', { path: '/tmp/risk-tactical-desktop.png', contentType: 'image/png' });
  const beforeCancel = observed.filter(item => item.event === 'game:action').length;
  await page.keyboard.press('Escape');
  await expect(boardLabels(page).and(page.locator('[aria-pressed="true"]'))).toHaveCount(0);
  expect(observed.filter(item => item.event === 'game:action')).toHaveLength(beforeCancel);
  await select(page, source.id); await select(page, destination);
  await page.getByRole('button', { name: 'Clear territory selection', exact: true }).click();
  await expect(boardLabels(page).and(page.locator('[aria-pressed="true"]'))).toHaveCount(0);
  expect(observed.filter(item => item.event === 'game:action')).toHaveLength(beforeCancel);
  await page.getByRole('button', { name: 'Finish attacking', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Skip & end turn', exact: true })).toBeVisible();
  const polled = await request.post('/api/poll', { data: { session: actor } });
  const fortified = (await polled.json() as Reply).state!;
  await expect.poll(() => marked(page, 'data-eligible-source')).toEqual(eligible(fortified.game!, actor.playerId));
  const moveFrom = eligible(fortified.game!, actor.playerId)[0];
  if (moveFrom) {
    const moveTo = TERRITORY_BY_ID[moveFrom].neighbors.find(id => fortified.game!.territories[id].owner === actor.playerId)!;
    await select(page, moveFrom); await select(page, moveTo);
    await expect(page.getByTestId('action-preview')).toContainText(`${fortified.game!.territories[moveFrom].armies - 1} left behind`);
    await expect(page.getByTestId('action-preview')).toContainText(`${fortified.game!.territories[moveTo].armies + 1} at destination`);
  }
  await page.getByRole('button', { name: 'Skip & end turn', exact: true }).click();
  await expect(page.getByTestId('turn-status')).not.toContainText('Your turn');
  await expect(boardLabels(page).and(page.locator('[aria-pressed="true"]'))).toHaveCount(0);
  await expect.poll(() => marked(page, 'data-eligible-source')).toEqual([]);
  await select(page, source.id);
  await expect(page.getByRole('complementary', { name: 'Turn controls', exact: true })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Selected territory', exact: true })).toBeVisible();
  const latest = await request.post('/api/poll', { data: { session: actor } });
  const before = (await latest.json() as Reply).state!;
  await tableMenu(page, 'Explain this phase');
  const guide = page.getByRole('dialog', { name: 'Your turn, explained', exact: true });
  await expect(guide).toContainText('This is your normal turn allowance');
  await expect(guide).not.toContainText(`${before.game!.reinforcements} remain to place now.`);
  await page.keyboard.press('Escape');
  const illegal = await request.post('/api/command', { data: { event: 'game:action', session: actor, payload: { id: randomBytes(16).toString('hex'), revision: before.revision, action: { type: 'deploy', territory: source.id, count: 1 } } } });
  const rejected = await illegal.json() as Reply;
  expect(rejected.ok).toBe(false); expect(rejected.error).toContain('Wait for your turn');
  expect(rejected.state?.game?.territories).toEqual(before.game!.territories);
  expect(errors).toEqual([]);
});

test('mobile: optional phase help dismisses and reopens, contextual rules and contrast remain accessible', async ({ browser, request, baseURL }, info) => {
  const { actor, state } = await humanRoom(request);
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    const errors = pageErrors(page);
    const gameActions: unknown[] = [];
    page.on('request', req => {
      if (new URL(req.url()).pathname === '/api/command') { const body = req.postDataJSON(); if (body.event === 'game:action') gameActions.push(body); }
    });
    await openSeat(page, actor);
    await page.getByRole('button', { name: 'Explain this phase', exact: true }).tap();
    const guide = page.getByRole('dialog', { name: 'Your turn, explained', exact: true });
    await expect(guide).toBeVisible();
    await expect(guide.getByRole('tab', { name: 'Reinforce', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(guide).toContainText('Your table:');
    for (const [name, text] of [['Attack', 'Ties favor the defender'], ['Fortify', 'adjacent-only fortification'], ['Advance', 'cannot be canceled']] as const) {
      await guide.getByRole('tab', { name, exact: true }).tap();
      await expect(guide.getByRole('tabpanel')).toContainText(new RegExp(text, 'i'));
    }
    await guide.getByRole('button', { name: 'Close dialog', exact: true }).tap();
    await expect(guide).toHaveCount(0);
    await page.getByRole('button', { name: 'Explain this phase', exact: true }).tap();
    await expect(guide.getByRole('tab', { name: 'Reinforce', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await tableMenu(page, 'Display settings');
    await page.getByRole('switch', { name: 'Tactical contrast', exact: true }).tap();
    await expect(page.getByRole('switch', { name: 'Tactical contrast', exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).tap();
    await expect(page.locator('.tabletop-app')).toHaveClass(/tactical-contrast/);
    await page.reload();
    await openBoardIfNeeded(page);
    await expect(page.locator('.campaign')).toBeVisible();
    await expect(page.locator('.tabletop-app')).toHaveClass(/tactical-contrast/);
    const sources = eligible(state.game!, actor.playerId);
    let visibleSource = '';
    for (const id of sources) if (await label(page, id).evaluate(element => {
      const box = element.getBoundingClientRect(); const x = box.x + box.width / 2, y = box.y + box.height / 2;
      return x > 0 && x < innerWidth && y > 120 && y < innerHeight - 230 && element.contains(document.elementFromPoint(x, y));
    })) { visibleSource = id; break; }
    expect(visibleSource, 'A legal territory is directly reachable on the emulated phone board').not.toBe('');
    const point = await label(page, visibleSource).evaluate(element => {
      const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
      return { x, y, hit: x > 0 && x < innerWidth && y > 0 && y < innerHeight && element.contains(document.elementFromPoint(x, y)) };
    });
    expect(point.hit).toBe(true);
    await page.touchscreen.tap(point.x, point.y);
    await expect(label(page, visibleSource)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('action-preview')).toBeVisible();
    const overlaps = await label(page, visibleSource).evaluate(element => {
      const a = element.getBoundingClientRect(), b = document.querySelector('.cdock')!.getBoundingClientRect();
      return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    });
    expect(overlaps).toBe(0);
    await page.screenshot({ path: '/tmp/risk-tactical-mobile.png' });
    await info.attach('Emulated touch phone with tactical contrast', { path: '/tmp/risk-tactical-mobile.png', contentType: 'image/png' });
    await page.getByRole('button', { name: 'Explain this phase', exact: true }).tap();
    await expect(guide).toContainText(TERRITORY_BY_ID[visibleSource].name);
    await expect(guide).toContainText('Adjacent:');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Escape');
    await tableMenu(page, 'Display settings');
    await expect(page.getByText('Your system requests reduced motion.', { exact: false })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(gameActions).toEqual([]);
    const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
    expect(overflow.x).toBeLessThanOrEqual(1); expect(overflow.y).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('phone battle preview updates exact one-roll odds when dice change', async ({ browser, request, baseURL }, info) => {
  const { actor, state } = await humanRoom(request);
  const initial = state.game!;
  const source = TERRITORIES.find(item => initial.territories[item.id].owner === actor.playerId && item.neighbors.some(id => initial.territories[id].owner !== actor.playerId))!;
  const started = await command(request, 'game:action', { id: randomBytes(16).toString('hex'), revision: state.revision, action: { type: 'deploy', territory: source.id, count: initial.reinforcements } }, actor);
  const target = source.neighbors.find(id => started.state!.game!.territories[id].owner !== actor.playerId)!;
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage(), errors = pageErrors(page);
    await openSeat(page, actor); await select(page, source.id); await select(page, target);
    const preview = page.getByTestId('action-preview');
    await page.getByRole('button', { name: '1 attacking die', exact: true }).tap();
    const expected = started.state!.game!.territories[target].armies >= 2 ? '25%' : '42%';
    await expect(preview).toContainText(`${expected} chance to remove a defender this roll`);
    const box = await preview.boundingBox();
    expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: '/tmp/risk-battle-odds-mobile.png' });
    await info.attach('Mobile one-roll odds', { path: '/tmp/risk-battle-odds-mobile.png', contentType: 'image/png' });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('presentation fixtures: paired ties, casualties and capture explain the same confirmed result with reduced motion', async ({ page, request }, info) => {
  const errors = pageErrors(page);
  const { actor, state } = await humanRoom(request);
  const source = TERRITORIES.find(item => state.game!.territories[item.id].owner === actor.playerId && item.neighbors.some(id => state.game!.territories[id].owner !== actor.playerId))!;
  const destination = source.neighbors.find(id => state.game!.territories[id].owner !== actor.playerId)!;
  // Only poll presentation is intercepted. Real server state is never mutated
  // into these deterministic tie/capture examples, nor called a live roll.
  let fixture = structuredClone(state);
  fixture.revision += 100_000;
  fixture.game!.phase = 'attack'; fixture.game!.reinforcements = 0;
  fixture.game!.territories[source.id].armies = 9;
  fixture.game!.territories[destination].armies = 3;
  await page.route('**/api/poll', route => route.fulfill({ status: 200, json: { ok: true, state: fixture } }));
  const gameActions: unknown[] = [];
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/api/command') { const body = req.postDataJSON(); if (body.event === 'game:action') gameActions.push(body); }
  });
  await openSeat(page, actor);
  await expect(label(page, source.id)).toHaveAttribute('aria-label', /, 9 armies/);
  fixture = structuredClone(fixture); fixture.revision++;
  fixture.game!.territories[source.id].armies = 8; fixture.game!.territories[destination].armies = 2;
  fixture.game!.combat = { from: source.id, to: destination, attackDice: [6, 4, 2], defenseDice: [6, 3], attackerLoss: 1, defenderLoss: 1, conquered: false, at: Date.now() };
  fixture.game!.log.push({ id: (fixture.game!.log.at(-1)?.id || 0) + 1, text: 'Deterministic presentation fixture: a tie and one defender loss.', type: 'attack' });
  await page.getByRole('button', { name: 'Explain latest battle', exact: true }).click();
  const report = page.getByRole('dialog', { name: 'Battle report', exact: true });
  await expect(report).toBeVisible();
  const table = report.getByRole('table', { name: 'Dice comparisons', exact: true });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').nth(1)).toContainText('Tie · Attacker loses 1');
  await expect(table.getByRole('row').nth(2)).toContainText('Defender loses 1');
  await expect(report.getByTestId('battle-casualties')).toContainText('Attacker −1');
  await expect(report.getByTestId('battle-casualties')).toContainText('Defender −1');
  await expect(report.getByLabel('attacker dice: 6, 4, 2', { exact: true })).toBeVisible();
  await expect(report).toContainText('The defender held this roll.');
  const normalResult = await report.getByTestId('battle-casualties').innerText();
  await page.screenshot({ path: '/tmp/risk-tactical-battle-report.png' });
  await info.attach('Deterministic paired-dice presentation fixture', { path: '/tmp/risk-tactical-battle-report.png', contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await tableMenu(page, 'Battle report');
  await expect(report).toBeVisible();
  expect(await report.getByTestId('battle-casualties').innerText()).toBe(normalResult);
  await expect(table.getByRole('row').nth(1)).toContainText('Tie · Attacker loses 1');
  // A later poll may arrive while a player studies a roll. Keep the opened
  // historical report stable, then show the new roll only when reopened.
  fixture = structuredClone(fixture); fixture.revision++;
  fixture.game!.territories[destination] = { owner: actor.playerId, armies: 0 };
  fixture.game!.phase = 'occupy';
  fixture.game!.occupation = { from: source.id, to: destination, minimum: 3, maximum: 7 };
  fixture.game!.combat = { from: source.id, to: destination, attackDice: [6, 5, 4], defenseDice: [2, 1], attackerLoss: 0, defenderLoss: 2, conquered: true, at: Date.now() + 1 };
  fixture.game!.log.push({ id: (fixture.game!.log.at(-1)?.id || 0) + 1, text: 'Deterministic presentation fixture: territory captured.', type: 'conquest' });
  await expect(label(page, destination)).toHaveAttribute('aria-label', /, 0 armies/);
  await expect(report).toContainText('The defender held this roll.');
  expect(await report.getByTestId('battle-casualties').innerText()).toBe(normalResult);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Advance armies', exact: true })).toBeVisible();
  await expect(page.getByTestId('action-preview')).toContainText('1 left behind');
  await expect(page.getByTestId('action-preview')).toContainText('7 at destination');
  await expect(page.getByRole('button', { name: 'Clear territory selection', exact: true })).toHaveCount(0);
  await tableMenu(page, 'Battle report');
  await expect(report).toContainText('Territory captured.');
  await expect(report).toContainText('This roll transferred ownership to the attacker.');
  await expect(report.getByTestId('battle-casualties')).toContainText('Defender −2');
  await page.keyboard.press('Escape');
  // Occupation is mandatory for the acting player, but does not lock another
  // commander's read-only territory inspection or its cancel controls.
  fixture = structuredClone(fixture); fixture.revision++;
  fixture.game!.currentPlayer = (fixture.game!.currentPlayer + 1) % fixture.game!.players.length;
  await expect(page.getByTestId('turn-status')).not.toContainText('Your turn');
  await select(page, source.id);
  await page.getByRole('button', { name: 'Clear territory selection', exact: true }).click();
  await expect(label(page, source.id)).toHaveAttribute('aria-pressed', 'false');
  await select(page, source.id);
  await page.keyboard.press('Escape');
  await expect(label(page, source.id)).toHaveAttribute('aria-pressed', 'false');
  expect(gameActions).toEqual([]);
  expect(errors).toEqual([]);
  await info.attach('Presentation fixture caveat', { body: 'Tie/capture states were deterministic intercepted client-poll fixtures. Real engine/network outcome validation remains in unit, Worker and complete multiplayer browser suites.', contentType: 'text/plain' });
});
