import { test, expect, type Page } from '@playwright/test';
import { TERRITORIES } from '../shared/world';
import type { RoomState, Session } from '../shared/types';
const http = process.env.RISK_TEST_HTTP === '1';
const screenshot = (name: string) => `/tmp/risk-${process.env.RISK_TEST_SCREENSHOT_PREFIX || (http ? 'worker-' : '')}${name}.png`;
const errors = (page: Page) => { const found: string[] = []; page.on('pageerror', e => found.push(e.message)); page.on('console', m => { if (m.type() === 'error') found.push(`${m.text()} ${m.location().url}`); }); return found; };
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __riskBoardStats: { frames: number; drawCalls: number; triangles: number; renderer: string } }).__riskBoardStats);
function traffic(page: Page) {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const socketRequests: string[] = []; const externalRequests: string[] = []; const polls: { state?: RoomState; ok: boolean }[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/socket.io')) socketRequests.push(url.href);
    if (/^https?:$/.test(url.protocol) && url.origin !== origin) externalRequests.push(url.href);
  });
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (url.pathname.startsWith('/socket.io')) socketRequests.push(url.href);
    if (url.origin.replace(/^ws/, 'http') !== origin) externalRequests.push(url.href);
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/poll') void response.json().then(body => polls.push(body)).catch(() => undefined);
  });
  return { socketRequests, externalRequests, polls };
}
function expectLocalHttp(network: ReturnType<typeof traffic>) { expect(network.socketRequests).toEqual([]); expect(network.externalRequests).toEqual([]); }
const session = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('risk-world-command-session') || 'null') as Session | null);
async function privateLobby(page: Page, name: string) {
  await page.goto('/'); await page.getByLabel('COMMANDER NAME').fill(name); await page.getByRole('tab', { name: 'Multiplayer' }).click();
  await page.getByRole('button', { name: 'Create private room' }).click(); await expect(page.locator('.lobby-player')).toHaveCount(1);
  return page.locator('.room-code span').innerText();
}
async function joinLobby(page: Page, code: string, name: string) {
  await page.goto('/'); await page.getByLabel('COMMANDER NAME').fill(name); await page.getByRole('tab', { name: 'Multiplayer' }).click();
  await page.getByRole('button', { name: 'Join a room' }).click(); await page.getByLabel('ROOM CODE', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Join the table' }).click(); await expect(page.locator('.lobby-player')).toHaveCount(2);
}
async function territoryState(page: Page) {
  return page.locator('.board3d-labels [role=button], .world-map-svg [role=button]').evaluateAll(els => els.map(el => el.getAttribute('aria-label') || ''));
}
test('real WebGL tabletop, idle render budget, 2D switch, keyboard and reduced motion', async ({ page }, info) => {
  const failures = errors(page); const network = traffic(page); await page.goto('/');
  await expect(page.locator('.board3d canvas')).toBeVisible();
  await expect.poll(async () => (await stats(page))?.drawCalls).toBeGreaterThan(0);
  await page.waitForTimeout(350); const before = await stats(page); await page.waitForTimeout(500); const after = await stats(page);
  console.log('WebGL idle metrics', JSON.stringify({ before, after })); expect(after.frames).toBe(before.frames); expect(after.triangles).toBeGreaterThan(0);
  await info.attach('WebGL idle metrics', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
  await page.screenshot({ path: screenshot('desktop'), fullPage: true });
  const zoom = page.getByRole('button', { name: 'Zoom in', exact: true }); await zoom.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Reset table view' })).toHaveText('1.5×');
  await page.getByRole('button', { name: '2D MAP', exact: true }).click(); await expect(page.locator('.world-map-svg')).toBeVisible(); await expect(page.locator('canvas')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.getByRole('button', { name: 'Open display settings' }).click();
  await expect(page.getByText('Your system requests reduced motion.')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); expect(failures).toEqual([]); if (http) expectLocalHttp(network);
});
test('private network room, portable command IDs, separate seats, reload resume and complete human turn', async ({ browser, baseURL }, info) => {
  const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
  try {
    // Ordinary LAN HTTP and older browsers can lack the secure-context randomUUID API.
    for (const context of contexts) await context.addInitScript(() => { Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true }); });
    const [host, guest] = await Promise.all(contexts.map(c => c.newPage())); const failures = [...[host, guest].map(errors)]; const network = [host, guest].map(traffic);
    for (const [page, name] of [[host, 'BrowserHost'], [guest, 'BrowserGuest']] as const) { await page.goto('/'); await page.getByLabel('COMMANDER NAME').fill(name); await page.getByRole('tab', { name: 'Multiplayer' }).click(); }
    await host.getByRole('button', { name: 'Create private room' }).click(); const code = await host.locator('.room-code span').innerText();
    await guest.getByRole('button', { name: 'Join a room' }).click(); await guest.getByLabel('ROOM CODE', { exact: true }).fill(code); await guest.getByRole('button', { name: 'Join the table' }).click();
    await expect(host.getByText('BrowserGuest', { exact: true })).toBeVisible(); await host.getByRole('button', { name: 'Add AI', exact: true }).click();
    await expect(host.locator('.lobby-player')).toHaveCount(3); await host.getByRole('button', { name: 'Begin world conquest' }).click();
    await expect(guest.locator('.campaign')).toBeVisible(); await guest.reload(); await expect(guest.locator('.campaign')).toBeVisible();
    const originalSeat = await guest.evaluate(() => sessionStorage.getItem('risk-world-command-session'));
    await guest.getByRole('button', { name: 'Leave table', exact: true }).click();
    await expect(guest.getByRole('dialog', { name: 'Leave the table?' })).toBeVisible();
    await guest.getByRole('button', { name: 'Return to command center' }).click();
    await expect(guest.getByText('Your campaign is waiting.', { exact: true })).toBeVisible();
    await expect(guest.locator('.resume-campaign')).toContainText(code);
    await guest.getByRole('button', { name: 'Rejoin campaign' }).click(); await expect(guest.locator('.campaign')).toBeVisible();
    expect(await guest.evaluate(() => sessionStorage.getItem('risk-world-command-session'))).toBe(originalSeat);
    await expect(guest.locator('.campaign-heading')).toContainText(code);
    await expect.poll(async () => (await host.getByRole('heading', { name: 'Rally your forces.' }).count()) + (await guest.getByRole('heading', { name: 'Rally your forces.' }).count()), { timeout: 60_000 }).toBe(1);
    const page = await host.getByRole('heading', { name: 'Rally your forces.' }).count() ? host : guest; const name = page === host ? 'BrowserHost' : 'BrowserGuest';
    // Equal-revision HTTP presence polls must leave the actual tabletop asleep.
    await page.waitForTimeout(1200); const idleBefore = await stats(page); const pollCounts = network.map(client => client.polls.length);
    if (http) await expect.poll(() => Math.min(...network.map((client, index) => client.polls.length - pollCounts[index])), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    else await page.waitForTimeout(1500);
    const idleAfter = await stats(page); expect(idleAfter.frames).toBe(idleBefore.frames);
    await info.attach('Network campaign idle render metrics', { body: JSON.stringify({ idleBefore, idleAfter, polls: network.map(client => client.polls.length) }), contentType: 'application/json' });
    const labels = await territoryState(page);
    const owned = TERRITORIES.filter(t => labels.some(l => l.startsWith(`${t.name}, ${name},`)));
    const strength = (t: typeof TERRITORIES[number]) => Number(labels.find(l => l.startsWith(`${t.name},`))?.match(/, (\d+) armies/)?.[1] || 0);
    const pairs = owned.flatMap(from => from.neighbors.filter(id => !owned.some(t => t.id === id)).map(id => ({ from, to: TERRITORIES.find(t => t.id === id)! }))).sort((a,b) => (strength(b.from)-strength(b.to))-(strength(a.from)-strength(a.to)));
    expect(pairs.length).toBeGreaterThan(0); const { from, to } = pairs[0];
    await page.getByLabel('Choose a territory').selectOption(from.id); await page.getByRole('button', { name: 'MAX', exact: true }).click();
    const preDeploy = await stats(page); await page.getByRole('button', { name: 'Deploy armies' }).click(); await expect(page.getByRole('heading', { name: 'Make your move.' })).toBeVisible();
    await page.waitForTimeout(1000); const postDeploy = await stats(page); console.log('Animation metrics', JSON.stringify({ preDeploy, postDeploy })); expect(postDeploy.frames).toBeGreaterThan(preDeploy.frames);
    await info.attach('Deployment animation render metrics', { body: JSON.stringify({ preDeploy, postDeploy }), contentType: 'application/json' });
    await page.getByLabel('Choose a territory').selectOption(to.id);
    let rolls = 0;
    while (rolls < 30 && await page.getByRole('button', { name: 'Roll for battle' }).isEnabled().catch(() => false)) {
      await page.getByRole('button', { name: 'Roll for battle' }).click(); rolls++; await page.waitForTimeout(180);
      if (await page.getByRole('button', { name: 'Advance armies' }).count()) break;
    }
    expect(rolls).toBeGreaterThan(0); await expect(page.locator('.dice-row').first()).toBeVisible();
    const conquered = await page.getByRole('button', { name: 'Advance armies' }).count() > 0;
    if (conquered) { await page.getByRole('button', { name: 'Advance armies' }).click(); await expect(page.getByRole('heading', { name: 'Make your move.' })).toBeVisible(); }
    await page.screenshot({ path: screenshot('gameplay'), fullPage: true });
    await page.getByRole('button', { name: 'Finish attacking' }).click(); await expect(page.getByRole('heading', { name: 'Secure the frontier.' })).toBeVisible();
    const turn = await page.locator('.turn-counter b').innerText();
    let fortified = false;
    if (conquered) {
      await page.getByLabel('Choose a territory').selectOption(to.id); await page.getByLabel('Choose a territory').selectOption(from.id);
      if (await page.getByRole('button', { name: 'Fortify & end turn' }).isEnabled()) { await page.getByRole('button', { name: 'Fortify & end turn' }).click(); fortified = true; }
    }
    if (!fortified) await page.getByRole('button', { name: 'Skip & end turn' }).click();
    await expect(page.locator('.turn-counter b')).not.toHaveText(turn);
    await page.getByRole('button', { name: /Your territory cards/ }).click(); await expect(page.getByRole('dialog', { name: 'A hand worth playing.' })).toBeVisible();
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
    console.log('Human turn result', JSON.stringify({ rolls, conquered, fortified, player: name })); await info.attach('Human turn result', { body: JSON.stringify({ rolls, conquered, fortified, player: name }), contentType: 'application/json' });
    expect(failures.flat()).toEqual([]);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});
test('mobile touch layout and tactical map', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  try { const page = await context.newPage(); const failures = errors(page); const network = traffic(page); await page.goto('/'); await expect(page.getByRole('button', { name: 'Launch campaign' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '2D MAP', exact: true }).tap(); await expect(page.locator('.world-map-svg')).toBeVisible();
    await page.screenshot({ path: screenshot('mobile'), fullPage: true });
    await page.getByRole('button', { name: 'Launch campaign' }).tap(); await expect(page.locator('.campaign')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('Choose a territory').selectOption('alaska'); await expect(page.locator('.map-status b')).toHaveText('Alaska');
    const shortcuts = page.locator('.mobile-orders-shortcut'); await expect(shortcuts).toBeVisible();
    await shortcuts.getByRole('button', { name: /Issue orders|Command post/ }).tap();
    await expect.poll(() => page.locator('#command-post').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(150);
    await expect(page.locator('#command-post h2')).toBeInViewport();
    await shortcuts.getByRole('button', { name: 'Map', exact: true }).tap();
    await expect.poll(() => page.locator('#world-table').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(150);
    await expect(page.locator('#world-table .board-section-head')).toBeInViewport();
    await page.screenshot({ path: screenshot('mobile-gameplay'), fullPage: true }); expect(failures).toEqual([]); if (http) expectLocalHttp(network);
  } finally { await context.close(); }
});
test('WebGL unavailable falls back to a functional accessible map', async ({ playwright, baseURL }) => {
  const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-webgl'] });
  try {
    const page = await browser.newPage(); const pageErrors: string[] = []; const network = traffic(page); page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(baseURL!); await expect(page.getByText('2D map · WebGL unavailable')).toBeVisible(); await expect(page.locator('.world-map-svg')).toBeVisible();
    await page.getByRole('button', { name: 'Launch campaign' }).click(); await expect(page.locator('.campaign')).toBeVisible();
    await page.getByLabel('Choose a territory').selectOption('alaska'); await expect(page.locator('.map-status b')).toHaveText('Alaska'); expect(pageErrors).toEqual([]); if (http) expectLocalHttp(network);
  } finally { await browser.close(); }
});

test.describe('durable HTTP browser synchronization', () => {
  test.skip(!http, 'Run against the Worker with RISK_TEST_HTTP=1.');

  test('polling disconnect recovers automatically without losing the seat', async ({ page }) => {
    const network = traffic(page); const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
    await privateLobby(page, 'RecoveringHost'); const originalSeat = await session(page);
    await expect.poll(() => network.polls.length).toBeGreaterThan(0);
    await page.route('**/api/poll', route => route.abort('internetdisconnected'));
    await expect(page.locator('.connection')).toHaveText('RECONNECTING');
    await expect(page.getByRole('alert')).toContainText('Reconnecting automatically');
    await expect(page.locator('.lobby-player')).toHaveCount(1);
    await page.unroute('**/api/poll');
    await expect(page.locator('.connection')).toHaveText('SYSTEMS ONLINE', { timeout: 15_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await session(page)).toEqual(originalSeat);
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
      await privateLobby(page, 'RevisionHost');
      await expect.poll(() => captured).toBe(true);
      await page.getByRole('button', { name: 'Add AI', exact: true }).click(); await expect(page.locator('.lobby-player')).toHaveCount(2);
      release(); await expect.poll(() => released).toBe(true); await page.waitForTimeout(250);
      expect(await page.locator('.lobby-player').count()).toBe(2);
      await expect.poll(() => network.polls.some(reply => reply.state?.players.length === 2)).toBe(true);
      expectLocalHttp(network);
    } finally { release(); await page.unroute('**/api/poll'); }
  });

  test('host removal returns the guest home and stops authenticated polling', async ({ browser, baseURL }) => {
    const contexts = await Promise.all([browser.newContext({ baseURL }), browser.newContext({ baseURL })]);
    try {
      const [host, guest] = await Promise.all(contexts.map(context => context.newPage())); const network = traffic(guest); const hostNetwork = traffic(host);
      const code = await privateLobby(host, 'RemovingHost'); await joinLobby(guest, code, 'RemovedGuest');
      await expect(host.getByText('RemovedGuest', { exact: true })).toBeVisible();
      await host.getByRole('button', { name: 'Remove RemovedGuest' }).click(); await expect(host.locator('.lobby-player')).toHaveCount(1);
      await expect(guest.getByRole('alert')).toContainText(/removed|invalid|expired/i); await expect(guest.locator('.home')).toBeVisible();
      expect(await session(guest)).toBeNull(); await expect(guest.locator('.lobby-page')).toHaveCount(0);
      const pollCount = network.polls.length; await guest.waitForTimeout(2600); expect(network.polls.length).toBe(pollCount);
      expectLocalHttp(network); expectLocalHttp(hostNetwork);
    } finally { await Promise.all(contexts.map(context => context.close())); }
  });

  test('an expired membership clears the campaign and permits a new room', async ({ page }) => {
    const network = traffic(page); const code = await privateLobby(page, 'ExpiredHost');
    await page.route('**/api/poll', route => route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'This room has expired.' }) }));
    await expect(page.locator('.home')).toBeVisible(); await expect(page.getByRole('alert')).toContainText(/expired/i); expect(await session(page)).toBeNull();
    const pollCount = network.polls.length; await page.waitForTimeout(2600); expect(network.polls.length).toBe(pollCount);
    await page.unroute('**/api/poll'); await page.getByRole('button', { name: 'Create private room' }).click();
    await expect(page.locator('.lobby-player')).toHaveCount(1); expect(await page.locator('.room-code span').innerText()).not.toBe(code);
    expectLocalHttp(network);
  });
});
