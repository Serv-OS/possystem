// scripts/screenshots.mjs
//
// Marketing screenshot harness — drives the LIVE app with Playwright and captures
// retina PNGs of every surface for the sales deck. Reads BO credentials from
// SHOT_CREDS_FILE (JSON {email,password}) so no secrets live in the repo.
//
//   node scripts/screenshots.mjs            # capture everything
//   node scripts/screenshots.mjs pos kds    # capture only named shots
//
// Staff surfaces boot as an already-paired device by pre-seeding the rpos-device
// localStorage entry (a dedicated "Front till" device row exists for this), then the
// harness types a staff PIN when the PIN pad appears. Back-office shots sign in with
// the dedicated screenshots@ BO user and click through the sidebar.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.SHOT_BASE || 'https://possystem-liard.vercel.app';
const OUT = process.env.SHOT_OUT || path.resolve(process.cwd(), '../screenshots-mozz');
const CREDS = JSON.parse(fs.readFileSync(process.env.SHOT_CREDS_FILE || '/tmp/shot_creds', 'utf8'));
const LOC = '7218c716-eeb4-4f96-b284-f3500823595c';
const PIN = '1111';   // Jane Smith (demo venue)

// One paired device row PER surface: reusing one device across surfaces trips the
// "each POS device can only be active in one place" session kick.
const DEVICE_IDS = {
  pos: ['ffbfe321-e1ed-40c3-b259-bfc3b46b2dba', 'Main till', 'MOZZA-7748'],
  tables: ['5241f0b2-deb8-4e1c-8432-a1ece643a38f', 'Floor station', 'MOZZA-7742'],
  kds: ['d26bf135-1170-410e-a14d-11c2965ab3a7', 'Kitchen screen', 'MOZZA-7743'],
  bar: ['5b5f8cf0-5e75-4c3d-904e-e79a39b10bd1', 'Bar till', 'MOZZA-7744'],
  orders: ['43508bb8-9a74-4b50-9988-25eacac8e080', 'Orders hub', 'MOZZA-7745'],
  clock: ['ba17bae1-1396-4263-912e-a0f747737e37', 'Time clock', 'MOZZA-7746'],
  waitlist: ['65750875-a578-42ac-a23b-dc7c37ad4b07', 'Host stand', 'MOZZA-7747'],
};
const deviceFor = (mode) => {
  const [id, name, pairingCode] = DEVICE_IDS[mode] || DEVICE_IDS.pos;
  return {
    id, name, type: mode === 'kds' ? 'kds' : 'pos',   // surface dispatch keys off device TYPE
    locationId: LOC, locationName: 'MOZZ',
    orgId: 'a59a6d97-ffaa-470e-8bb7-04cba789f335', profileId: 'prof-1776183121937',
    pairingCode, pairedAt: new Date().toISOString(),
  };
};

// Click one of the left-rail surface tabs (Bar / Floor / POS / Orders …) — small
// labelled icons at x < 110.
async function clickRail(page, label) {
  for (const el of await page.getByText(label, { exact: true }).all()) {
    const bb = await el.boundingBox();
    if (bb && bb.x < 110) { await el.click(); return true; }
  }
  return false;
}

// Build a realistic in-progress order on the till for the hero shot.
async function buildBasket(page) {
  const tap = async (text) => {
    try {
      await page.getByText(text, { exact: false }).first().click({ timeout: 4000 });
      await sleep(900);
      // If an options/configure modal opened, confirm it.
      for (const btnName of [/^Add(\s|$)/i, /Add to order/i, /^Done$/i]) {
        const b = page.getByRole('button', { name: btnName }).first();
        if (await b.isVisible().catch(() => false)) { await b.click(); await sleep(700); break; }
      }
    } catch { /* item not found — skip */ }
  };
  await tap('Sourdough Pizza');      // category
  await tap('Margherita');
  await tap('Pepperoni');
  await tap('Starters');             // category
  await tap('Hummus');
  await tap('Soft Drinks');
  await sleep(800);
}

fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const want = (name) => !only.length || only.some(o => name.includes(o));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function shoot(page, name) {
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('✓', name);
}

async function ensurePin(page) {
  // If a PIN pad is showing, tap the digits.
  try {
    const pad = page.getByRole('button', { name: '1', exact: true }).first();
    await pad.waitFor({ state: 'visible', timeout: 6000 });
    for (const d of PIN) {
      await page.getByRole('button', { name: d, exact: true }).first().click();
      await sleep(120);
    }
    await sleep(1500);
  } catch { /* no PIN pad — already in */ }
}

async function boLogin(page) {
  await page.goto(`${BASE}/?mode=office`, { waitUntil: 'domcontentloaded' });
  try {
    const email = page.locator('input[type="email"], input[name="email"]').first();
    await email.waitFor({ state: 'visible', timeout: 8000 });
    await email.fill(CREDS.email);
    await page.locator('input[type="password"]').first().fill(CREDS.password);
    await page.keyboard.press('Enter');
  } catch { /* already signed in */ }
  await page.getByText('Overview', { exact: true }).first().waitFor({ timeout: 30000 });
  await sleep(2500);   // data load
}

// Click a sidebar target. Sidebar GROUP headers sit at x≈8; section children at x≈43.
// Names can collide (the 'Reports' group vs Inventory's 'Reports' child), so resolve by
// position: prefer an already-visible child; otherwise expand the group (x<25) first.
async function clickSidebar(page, name, { group = false } = {}) {
  const candidates = await page.getByRole('button', { name, exact: true }).all();
  const inSidebar = [];
  for (const c of candidates) {
    const bb = await c.boundingBox();
    if (bb && bb.x <= 300) inSidebar.push({ c, x: bb.x });
  }
  const pref = inSidebar.find(e => (group ? e.x < 25 : e.x >= 25)) || (!group && inSidebar[0]);  // singles sit at x≈8 too
  if (pref) {
    // Decorative overlays (gradients/toasts) can cover the sidebar and swallow the
    // actionability check — try a normal click briefly, then force through the overlay.
    try { await pref.c.click({ timeout: 3000 }); }
    catch { await pref.c.click({ force: true }); }
    return true;
  }
  return false;
}
async function boSection(page, group, child) {
  if (!child) { if (group) await clickSidebar(page, group, { group: true }); await sleep(2600); return; }
  if (!(await clickSidebar(page, child))) {                // not visible → expand its group
    if (group) await clickSidebar(page, group, { group: true });
    await sleep(500);
    if (!(await clickSidebar(page, child))) throw new Error(`sidebar item not found: ${child}`);
  }
  await sleep(2600);
}

const run = async () => {
  const browser = await chromium.launch();

  // ── Desktop: back office ──────────────────────────────────────────────────
  const boCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const bo = await boCtx.newPage();
  let boReady = false;
  const BO_SHOTS = [
    ['bo-01-dashboard', null, null],
    ['bo-02-menu-manager', 'Menu', 'Items & modifiers'],
    ['bo-03-floor-plan', null, 'Floor plan'],
    ['bo-04-sales-reports', 'Reports', 'Sales reports'],
    ['bo-05-daily-trading', 'Reports', 'Close day'],
    ['bo-06-rota', 'Workforce', 'Rota'],
    ['bo-07-stock-overview', 'Inventory', 'Overview'],
    ['bo-08-campaigns', 'Customers', 'Campaigns'],
    ['bo-09-reviews', 'Customers', 'Reviews'],
    ['bo-10-loyalty', 'Customers', 'Loyalty'],
    ['bo-11-gift-cards', 'Customers', 'Gift cards'],
    ['bo-12-online-ordering', 'Channels', 'Online ordering'],
    ['bo-13-menu-boards', 'Channels', 'Menu boards'],
    ['bo-14-print-menu', 'Channels', 'Print menu'],
    ['bo-15-xero', 'Settings', 'Xero (accounting)'],
  ];
  for (const [name, group, child] of BO_SHOTS) {
    if (!want(name)) continue;
    if (!boReady) { await boLogin(bo); boReady = true; }
    try { await boSection(bo, group, child); await shoot(bo, name); }
    catch (e) { console.warn('✗', name, e.message.split('\n')[0]); }
  }
  await boCtx.close();

  // ── Desktop: staff surfaces — fresh context + own device per surface ──────
  const STAFF_SHOTS = [
    // [name, mode, settle, postAction]
    ['pos-01-till', 'pos', 26000, (p) => buildBasket(p)],
    ['pos-02-tables', 'tables', 12000, (p) => clickRail(p, 'Floor')],
    ['pos-03-kds', 'kds', 12000, null],
    ['pos-04-bar', 'bar', 12000, (p) => clickRail(p, 'Bar')],
    ['pos-05-orders-hub', 'orders', 12000, (p) => clickRail(p, 'Orders')],
    ['pos-06-time-clock', 'clock', 9000, null],
    ['pos-07-waitlist', 'waitlist', 12000, null],
  ];
  for (const [name, mode, settle, postAction] of STAFF_SHOTS) {
    if (!want(name)) continue;
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(([dev]) => {
      try { localStorage.setItem('rpos-device', JSON.stringify(dev)); } catch { /* ignore */ }
    }, [deviceFor(mode)]);
    const till = await ctx.newPage();
    try {
      await till.goto(`${BASE}/?mode=${mode}`, { waitUntil: 'domcontentloaded' });
      await sleep(Math.min(settle, 8000));
      // Session-kick recovery: if the "disconnected" screen shows, reclaim and carry on.
      for (let i = 0; i < 2; i++) {
        const kicked = await till.getByRole('button', { name: 'Reconnect this terminal' }).first().isVisible().catch(() => false);
        if (!kicked) break;
        await till.getByRole('button', { name: 'Reconnect this terminal' }).first().click();
        await sleep(5000);
      }
      if (mode !== 'clock') await ensurePin(till);
      await sleep(Math.max(0, settle - 8000) + 1500);
      if (postAction) { await postAction(till); await sleep(1200); }
      // Never save a kicked frame.
      if (await till.getByText('has been disconnected').first().isVisible().catch(() => false)) throw new Error('kicked');
      await shoot(till, name);
    } catch (e) { console.warn('✗', name, e.message.split('\n')[0]); }
    await ctx.close();
    await sleep(1200);
  }

  // ── Desktop: menu board (TV) ──────────────────────────────────────────────
  if (want('board')) {
    const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const tv = await tvCtx.newPage();
    try {
      await tv.goto(`${BASE}/?mode=menuboard&board=b489a39f-919c-4688-b473-b04fd84fe0da`, { waitUntil: 'domcontentloaded' });
      await sleep(9000);
      await shoot(tv, 'tv-01-menu-board');
    } catch (e) { console.warn('✗ tv-01-menu-board', e.message.split('\n')[0]); }
    await tvCtx.close();
  }

  // ── Mobile: customer + manager surfaces ───────────────────────────────────
  const mobCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mob = await mobCtx.newPage();
  const MOB_URL_SHOTS = [
    ['mob-01-online-ordering', `${BASE}/online/location1`, 9000],
    ['mob-02-review-card', `${BASE}/?loc=${LOC}&surface=review`, 7000],
  ];
  for (const [name, url, settle] of MOB_URL_SHOTS) {
    if (!want(name)) continue;
    try { await mob.goto(url, { waitUntil: 'domcontentloaded' }); await sleep(settle); await shoot(mob, name); }
    catch (e) { console.warn('✗', name, e.message.split('\n')[0]); }
  }
  if (want('manager')) {
    try {
      await mob.goto(`${BASE}/?mode=manager`, { waitUntil: 'domcontentloaded' });
      try {
        const email = mob.locator('input[type="email"], input[name="email"]').first();
        await email.waitFor({ state: 'visible', timeout: 8000 });
        await email.fill(CREDS.email);
        await mob.locator('input[type="password"]').first().fill(CREDS.password);
        await mob.keyboard.press('Enter');
      } catch { /* maybe already in */ }
      await sleep(9000);
      await shoot(mob, 'mob-03-manager-app');
    } catch (e) { console.warn('✗ mob-03-manager-app', e.message.split('\n')[0]); }
  }
  await mobCtx.close();

  await browser.close();
  console.log('\nSaved to', OUT);
};

run().catch(e => { console.error(e); process.exit(1); });
