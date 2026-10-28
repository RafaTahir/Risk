import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import type { GameAction, GameState, RoomState, Session } from '../shared/types';
import { TERRITORIES } from '../shared/world';

test.skip(process.env.RISK_TEST_HTTP !== '1', 'Four-panel tabletop checks use the real durable HTTP app.');
type Reply = { ok: boolean; error?: string; session?: Session; state?: RoomState };
type Stats = {
  drawCalls: number; foldProgress: number; foldTransitioning: boolean;
  panelAngles: { x: number; y: number }[]; settleHeight: number;
  panelWorldSamples: { panel: number; corners: { x: number; y: number; z: number }[] }[];
  territoryUnits: number; reserveUnits: number; reserveArmies: number; countTokens: number;
  motionType: string | null; motionProgress: number; defenseVisible: boolean;
  attackerLoss: number; defenderLoss: number;
  reserveSamples: { playerId: string; armies: number; infantry: number; artillery: number; overflow: number }[];
  setupPlaced: number; setupTotal: number;
};
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __riskBoardStats: Stats }).__riskBoardStats);
const table = (page: Page) => page.getByRole('main', { name: 'Risk tabletop', exact: true });
const header = (page: Page, folded: boolean) => page.getByRole('button', { name: folded ? 'Open board' : 'Fold board', exact: true });
const territory = (page: Page, id: string) => page.locator(`.board3d-labels [data-territory="${id}"]`);
async function ready(page: Page) {
  await expect(page.locator('.board3d canvas')).toBeVisible();
  await expect.poll(async () => (await stats(page))?.drawCalls).toBeGreaterThan(0);
}
async function endpoint(page: Page, folded: boolean) {
  await expect(table(page)).toHaveAttribute('data-board-state', folded ? 'folded' : 'open');
  await expect.poll(async () => (await stats(page)).foldProgress).toBeCloseTo(folded ? 1 : 0, 6);
  const state = await stats(page);
  expect(state.panelAngles).toHaveLength(4);
  expect(state.foldTransitioning).toBe(false);
  if (!folded) for (const angle of state.panelAngles) {
    expect(angle.x).toBeCloseTo(0, 5); expect(angle.y).toBeCloseTo(0, 5);
  }
}
async function command(request: APIRequestContext, event: string, payload: unknown = {}, session?: Session): Promise<Reply> {
  const response = await request.post('/api/command', { data: { event, payload, ...(session ? { session } : {}) } });
  expect(response.ok()).toBe(true);
  const reply = await response.json() as Reply;
  expect(reply.ok, reply.error).toBe(true);
  return reply;
}
async function poll(request: APIRequestContext, session: Session) {
  const response = await request.post('/api/poll', { data: { session } });
  expect(response.ok()).toBe(true);
  const reply = await response.json() as Reply;
  expect(reply.ok, reply.error).toBe(true);
  return reply.state!;
}
async function act(request: APIRequestContext, seat: Session, action: GameAction) {
  const current = await poll(request, seat);
  return (await command(request, 'game:action', { id: randomBytes(16).toString('hex'), revision: current.revision, action }, seat)).state!;
}
async function lobby(request: APIRequestContext) {
  const host = await command(request, 'room:create', { name: 'Physical table', mode: 'private', bots: 0, difficulty: 'veteran' });
  const seats = [host.session!];
  for (let i = 1; i < 3; i++) seats.push((await command(request, 'room:join', { name: `Table guest ${i}`, code: seats[0].code })).session!);
  return { host: seats[0], seats };
}
async function seat(page: Page, session: Session) {
  await page.addInitScript(value => sessionStorage.setItem('risk-world-command-session', JSON.stringify(value)), session);
  await page.goto('/'); await ready(page);
  await expect(table(page)).toHaveAttribute('data-game-state', 'lobby');
  await expect(page.getByRole('dialog', { name: 'Players', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await header(page, true).click(); await endpoint(page, false);
}
function logical(game: GameState) {
  return { ...game, players: game.players.map(({ connected: _connected, ...player }) => player) };
}
async function capture(page: Page, info: TestInfo, name: string) {
  const path = `/tmp/risk-four-panel-${name}.png`;
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}
function observe(page: Page) {
  const errors: string[] = [], actions: unknown[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/command' && request.postDataJSON().event === 'game:action') actions.push(request.postDataJSON());
  });
  return { errors, actions };
}

// Each observation runs in the same frame loop as the actual WebGL rig. This
// avoids mistaking a delayed screenshot of a settled board for a hinge pose.
test('four real panels unfold through both hinge axes, settle, and reverse safely from an intermediate pose', async ({ page }, info) => {
  const observed = observe(page);
  await page.goto('/'); await ready(page); await endpoint(page, true);
  const closed = await stats(page);
  expect([closed.territoryUnits, closed.reserveUnits, closed.countTokens]).toEqual([0, 0, 0]);
  expect(closed.panelAngles.some(angle => Math.abs(angle.x) > 3)).toBe(true);
  expect(closed.panelAngles.some(angle => Math.abs(angle.y) > 3)).toBe(true);
  await capture(page, info, 'closed');
  const samples = await page.evaluate(() => {
    const browser = window as unknown as { __riskBoardStats: Stats };
    document.querySelector<HTMLButtonElement>('[data-testid="open-board-cta"]')!.click();
    return new Promise<Stats[]>((resolve, reject) => {
      const started = performance.now(), samples: Stats[] = [];
      const check = () => {
        const state = browser.__riskBoardStats;
        samples.push({ ...state, panelAngles: state.panelAngles.map(angle => ({ ...angle })) });
        if (document.querySelector('main')?.getAttribute('data-board-state') === 'open') resolve(samples);
        else if (performance.now() - started > 6000) reject(new Error('Four-panel opening did not settle.'));
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  });
  await endpoint(page, false);
  const opened = await stats(page);
  expect(opened.panelWorldSamples).toHaveLength(4);
  expect(closed.panelWorldSamples).toHaveLength(4);
  const footprint = (state: Stats) => {
    const corners = state.panelWorldSamples.flatMap(panel => panel.corners);
    return { width: Math.max(...corners.map(p => p.x)) - Math.min(...corners.map(p => p.x)), height: Math.max(...corners.map(p => p.y)) - Math.min(...corners.map(p => p.y)) };
  };
  const compact = footprint(closed), laidOut = footprint(opened);
  expect(laidOut.width).toBeGreaterThan(1000); expect(laidOut.height).toBeGreaterThan(600);
  expect(compact.width).toBeLessThan(laidOut.width * .55);
  expect(compact.height).toBeLessThan(laidOut.height * .55);
  expect(samples.some(sample => sample.panelAngles.some(angle => Math.abs(angle.y) > .15 && Math.abs(angle.y) < Math.PI - .15))).toBe(true);
  expect(samples.some(sample => sample.panelAngles.some(angle => Math.abs(angle.x) > .15 && Math.abs(angle.x) < Math.PI - .15))).toBe(true);
  expect(samples.some(sample => sample.settleHeight > .1)).toBe(true);
  expect((await stats(page)).settleHeight).toBeCloseTo(0, 5);
  const reversal = await page.evaluate(() => {
    const browser = window as unknown as { __riskBoardStats: Stats };
    document.querySelector<HTMLButtonElement>('button[aria-label="Fold board"]')!.click();
    return new Promise<number>((resolve, reject) => {
      const started = performance.now();
      const check = () => {
        const value = browser.__riskBoardStats.foldProgress;
        if (value > .25 && value < .8) {
          document.querySelector<HTMLButtonElement>('button[aria-label="Open board"]')!.click(); resolve(value);
        } else if (value >= .99 || performance.now() - started > 5000) reject(new Error('No intermediate four-panel pose was observed.'));
        else requestAnimationFrame(check);
      }; requestAnimationFrame(check);
    });
  });
  expect(reversal).toBeGreaterThan(.25); expect(reversal).toBeLessThan(.8);
  await endpoint(page, false); await capture(page, info, 'open');
  expect(observed.actions).toEqual([]); expect(observed.errors).toEqual([]);
});


test('real setup lifts armies from player trays; reserve deployment and both combat sides reflect confirmed rules', async ({ page, request }, info) => {
  const room = await lobby(request), observed = observe(page);
  await seat(page, room.host);
  expect((await stats(page)).territoryUnits).toBe(0);
  expect((await stats(page)).reserveArmies).toBe(0);
  await page.evaluate(() => {
    const browser = window as unknown as { __riskBoardStats: Stats; __setupSamples: Stats[]; __setupDone: boolean };
    browser.__setupSamples = []; browser.__setupDone = false;
    const started = performance.now(); let sawSetup = false;
    const check = () => {
      const state = browser.__riskBoardStats;
      if (state.motionType === 'setup') {
        sawSetup = true;
        browser.__setupSamples.push({ ...state, reserveSamples: state.reserveSamples.map(sample => ({ ...sample })) });
      }
      if ((sawSetup && state.motionType !== 'setup') || performance.now() - started > 12000) browser.__setupDone = true;
      else requestAnimationFrame(check);
    }; requestAnimationFrame(check);
  });
  const initial = (await command(request, 'room:start', {}, room.host)).state!;
  await expect(page.locator('.campaign')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __setupDone: boolean }).__setupDone), { timeout: 15000 }).toBe(true);
  const setup = await page.evaluate(() => (window as unknown as { __setupSamples: Stats[] }).__setupSamples);
  expect(setup.length).toBeGreaterThan(1);
  expect(setup.some(sample => sample.setupPlaced > 0 && sample.setupPlaced < 42)).toBe(true);
  expect(setup.every(sample => sample.setupTotal === 42)).toBe(true);
  const trays = setup.find(sample => sample.reserveSamples.length === 3 && sample.reserveSamples.some(tray => tray.armies > 0));
  expect(trays).toBeDefined();
  expect(trays!.reserveSamples.map(tray => tray.playerId).sort()).toEqual(initial.game!.players.map(player => player.id).sort());
  for (const tray of trays!.reserveSamples) {
    expect(tray.armies).toBeGreaterThanOrEqual(0); expect(tray.armies).toBeLessThanOrEqual(35);
    expect(tray.infantry + tray.artillery * 10 + tray.overflow).toBe(tray.armies);
  }
  for (const player of initial.game!.players) expect(Object.values(initial.game!.territories).filter(item => item.owner === player.id).reduce((sum, item) => sum + item.armies, 0)).toBe(35);
  await expect.poll(async () => (await stats(page)).reserveArmies).toBe(initial.game!.reinforcements);
  expect((await stats(page)).territoryUnits).toBe(42);
  await capture(page, info, 'starting-armies');
  const actor = room.seats.find(seat => seat.playerId === initial.game!.players[initial.game!.currentPlayer].id)!;
  const source = TERRITORIES.find(item => initial.game!.territories[item.id].owner === actor.playerId && item.neighbors.some(id => initial.game!.territories[id].owner !== actor.playerId))!;
  const deployed = await act(request, actor, { type: 'deploy', territory: source.id, count: initial.game!.reinforcements });
  await expect.poll(async () => (await stats(page)).reserveArmies).toBe(0);
  expect((await stats(page)).reserveUnits).toBe(0);
  await expect(territory(page, source.id)).toHaveAttribute('aria-label', new RegExp(`, ${deployed.game!.territories[source.id].armies} armies`));
  const target = source.neighbors.find(id => deployed.game!.territories[id].owner !== actor.playerId)!;
  // Observe the real renderer while the real server chooses and commits dice.
  await page.evaluate(() => {
    const browser = window as unknown as { __riskBoardStats: Stats; __battleSamples: Stats[]; __battleDone: boolean };
    browser.__battleSamples = []; browser.__battleDone = false;
    const started = performance.now(); let sawAttack = false;
    const check = () => {
      const state = browser.__riskBoardStats;
      if (state.motionType === 'attack') { sawAttack = true; browser.__battleSamples.push({ ...state }); }
      if ((sawAttack && state.motionType !== 'attack') || performance.now() - started > 12000) browser.__battleDone = true;
      else requestAnimationFrame(check);
    }; requestAnimationFrame(check);
  });
  const fought = await act(request, actor, { type: 'attack', from: source.id, to: target, dice: Math.min(3, deployed.game!.territories[source.id].armies - 1) });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __battleDone: boolean }).__battleDone), { timeout: 15000 }).toBe(true);
  const battle = await page.evaluate(() => (window as unknown as { __battleSamples: Stats[] }).__battleSamples);
  expect(battle.length).toBeGreaterThan(1);
  expect(battle.some(sample => sample.defenseVisible)).toBe(true);
  expect(battle.every(sample => sample.attackerLoss === fought.game!.combat!.attackerLoss && sample.defenderLoss === fought.game!.combat!.defenderLoss)).toBe(true);
  expect(fought.game!.territories[source.id].armies).toBe(deployed.game!.territories[source.id].armies - fought.game!.combat!.attackerLoss);
  expect(fought.game!.territories[target].armies).toBe(deployed.game!.territories[target].armies - fought.game!.combat!.defenderLoss);
  const after = await poll(request, actor);
  expect(logical(after.game!)).toEqual(logical(fought.game!));
  expect(observed.actions).toEqual([]); expect(observed.errors).toEqual([]);
});

test('phone touch deployment and immediate four-panel folding preserve the confirmed campaign', async ({ browser, request, baseURL }, info) => {
  const room = await lobby(request);
  const state = (await command(request, 'room:start', {}, room.host)).state!;
  const actor = room.seats.find(seat => seat.playerId === state.game!.players[state.game!.currentPlayer].id)!;
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage(), observed = observe(page);
    await page.addInitScript(value => sessionStorage.setItem('risk-world-command-session', JSON.stringify(value)), actor);
    await page.goto('/'); await ready(page); await endpoint(page, true);
    await page.getByTestId('open-board-cta').tap(); await endpoint(page, false);
    await expect.poll(async () => (await stats(page)).reserveArmies).toBe(state.game!.reinforcements);
    const own = TERRITORIES.filter(item => state.game!.territories[item.id].owner === actor.playerId);
    let reachable = '';
    for (const item of own) if (await territory(page, item.id).evaluate(element => {
      const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
      return x > 0 && x < innerWidth && y > 140 && y < innerHeight - 230 && element.contains(document.elementFromPoint(x, y));
    })) { reachable = item.id; break; }
    expect(reachable, 'A legal territory is directly tappable on the phone board').not.toBe('');
    await territory(page, reachable).tap();
    await page.getByLabel('Number of armies', { exact: true }).fill('1');
    const reply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/command' && response.request().postDataJSON().payload?.action?.type === 'deploy');
    await page.getByRole('button', { name: 'Deploy armies', exact: true }).tap();
    const confirmed = await (await reply).json() as Reply;
    expect(confirmed.ok, confirmed.error).toBe(true);
    await expect.poll(async () => (await stats(page)).reserveArmies).toBe(state.game!.reinforcements - 1);
    for (let i = 0; i < 2; i++) {
      await header(page, false).tap(); await endpoint(page, true);
      await header(page, true).tap(); await endpoint(page, false);
    }
    expect((await stats(page)).motionType).toBeNull();
    await capture(page, info, 'mobile');
    expect(logical((await poll(request, actor)).game!)).toEqual(logical(confirmed.state!.game!));
    expect(observed.actions).toHaveLength(1); expect(observed.errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  } finally { await context.close(); }
});
