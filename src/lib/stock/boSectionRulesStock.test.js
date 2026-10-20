// node --test: the Stock control helpers in supabase/functions/_shared/boSectionRules.js (multi site
// stock Drop 0, map 6.3 and 7.9 "boSectionRules stock level rules"). The level is always per company:
// an owner of company A linked into company B as a manager is 'sites' in B, a role owner with no
// company is 'sites' everywhere, ServOS staff are 'all' everywhere. The database gives the same
// answers (public.stock_level); supabase/tests/stock_native/run.mjs checks the two agree for every
// test login. Ids are made up (the repo is public).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK_LEVELS, stockLevelOf, canEditCompany, canEditSitePrice, EVERYTHING_ROLES, BO_SECTION_KEYS,
} from '../../../supabase/functions/_shared/boSectionRules.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const p = (role, org_id, stock_control = null, sections = null) => ({ role, org_id, stock_control, sections });

test('the three levels, lowest first, and the everything roles are not changed', () => {
  assert.deepEqual([...STOCK_LEVELS], ['sites', 'sites_full', 'all']);
  assert.ok(Object.isFrozen(STOCK_LEVELS));
  assert.deepEqual([...EVERYTHING_ROLES], ['owner', 'super_admin']);
});

test('an owner of company A linked into company B as a manager: all in A, sites in B', () => {
  const owner = p('owner', A);
  assert.equal(stockLevelOf(owner, A), 'all');
  assert.equal(stockLevelOf(owner, B), 'sites');
  assert.equal(canEditCompany(owner, 'inventory', true, A), true);
  assert.equal(canEditCompany(owner, 'inventory', true, B), false, 'never a company editor in another company');
  assert.equal(canEditSitePrice(owner, true, B), false);
  assert.equal(canEditSitePrice(owner, true, A), true);
  // in a one site company the sections rule decides, exactly as today
  assert.equal(canEditCompany(owner, 'inventory', false, B), true);
  // a stored level on an owner never carries into another company
  assert.equal(stockLevelOf(p('owner', A, 'all'), B), 'sites');
});

test('a role owner with no company is sites everywhere, even when no company is named', () => {
  const noOrg = p('owner', null);
  for (const org of [A, B, null, undefined, '']) assert.equal(stockLevelOf(noOrg, org), 'sites', String(org));
  assert.equal(canEditCompany(noOrg, 'inventory', true, A), false);
  assert.equal(canEditSitePrice(noOrg, true, A), false);
  // null org on both sides is never "the same company"
  assert.equal(stockLevelOf(p('manager', null, 'all'), null), 'sites');
  assert.equal(stockLevelOf(p('owner', ''), ''), 'sites');
});

test('ServOS staff are all in every company, with or without a company of their own', () => {
  for (const org of [A, B, C, null]) {
    assert.equal(stockLevelOf(p('super_admin', null), org), 'all');
    assert.equal(canEditCompany(p('super_admin', null, null, []), 'purchasing', true, org), true, 'staff pass the sections rule too');
    assert.equal(canEditSitePrice(p('super_admin', null), true, org), true);
  }
});

test('each stored level, read only in the login\'s own company', () => {
  assert.equal(stockLevelOf(p('manager', A, null), A), 'sites');
  assert.equal(stockLevelOf(p('manager', A, 'sites'), A), 'sites');
  assert.equal(stockLevelOf(p('manager', A, 'sites_full'), A), 'sites_full');
  assert.equal(stockLevelOf(p('manager', A, 'all'), A), 'all');
  for (const lv of [null, 'sites', 'sites_full', 'all']) assert.equal(stockLevelOf(p('manager', A, lv), B), 'sites', `${lv} in another company`);
  // anything that is not one of the three is sites (fails closed), and so is the old head office idea
  for (const bad of ['head_office', 'ALL', 'everything', 1, true, {}, []]) assert.equal(stockLevelOf(p('manager', A, bad), A), 'sites', JSON.stringify(bad));
  // camelCase fields (orgCtx style) read the same; ids compare without case
  assert.equal(stockLevelOf({ role: 'manager', orgId: A, stockControl: 'sites_full' }, A), 'sites_full');
  assert.equal(stockLevelOf(p('manager', A.toUpperCase(), 'all'), A), 'all');
  // the role is compared exactly as the database compares it
  assert.equal(stockLevelOf(p('Owner', A), A), 'sites');
  assert.equal(stockLevelOf(p('SUPER_ADMIN', null), A), 'sites');
});

test('no profile, or not an object: sites, and never an editor', () => {
  for (const x of [null, undefined, 'owner', 42]) {
    assert.equal(stockLevelOf(x, A), 'sites');
    assert.equal(canEditCompany(x, 'inventory', false, A), false);
    assert.equal(canEditSitePrice(x, false, A), false);
  }
});

test('company fields: one site company follows the sections rule; multi site needs all and the section', () => {
  const mgr = p('manager', A, null, null);
  assert.equal(canEditCompany(mgr, 'inventory', false, A), true, 'one site company: today\'s rights');
  assert.equal(canEditCompany(mgr, 'inventory', true, A), false, 'multi site: sites is not enough');
  assert.equal(canEditCompany(p('manager', A, 'sites_full'), 'inventory', true, A), false);
  assert.equal(canEditCompany(p('manager', A, 'all'), 'inventory', true, A), true);
  const buyer = p('manager', A, 'all', ['purchasing']);
  assert.equal(canEditCompany(buyer, 'purchasing', true, A), true);
  assert.equal(canEditCompany(buyer, 'inventory', true, A), false, 'all sites, but only the sections it can open');
  assert.equal(canEditCompany(buyer, 'inventory', false, A), false);
  assert.equal(canEditCompany({ role: 'manager', org_id: A, stock_control: 'all', bo_sections: ['produce'] }, 'produce', true, A), true, 'bo_sections read too');
  assert.equal(canEditCompany({ role: 'manager', org_id: A, stock_control: 'all' }, 'inventory', true, A), false, 'no sections value at all: closed');
  assert.equal(canEditCompany(p('manager', A, 'all'), 'menus', true, A), false, 'an unknown section key');
  assert.equal(canEditCompany(p('manager', A, 'all'), 'inventory', undefined, A), true, 'multi not known: the multi site rule');
  assert.equal(canEditCompany(mgr, 'inventory', undefined, A), false);
  // an owner of the company passes the sections rule whatever is stored on it
  assert.equal(canEditCompany(p('owner', A, null, []), 'inventory', true, A), true);
  assert.equal(canEditCompany(p('owner', B, null, []), 'inventory', false, A), false, 'an owner elsewhere is held to its stored list here');
});

test('site prices: one site company yes; multi site needs sites_full or all in that company', () => {
  assert.equal(canEditSitePrice(p('manager', A), false, A), true);
  assert.equal(canEditSitePrice(p('manager', A), true, A), false);
  assert.equal(canEditSitePrice(p('manager', A, 'sites_full'), true, A), true);
  assert.equal(canEditSitePrice(p('manager', A, 'all'), true, A), true);
  assert.equal(canEditSitePrice(p('manager', A, 'sites_full'), true, B), false, 'a franchisee level never carries into another company');
  assert.equal(canEditSitePrice(p('manager', A, 'sites_full'), undefined, A), true);
  assert.equal(canEditSitePrice(p('manager', A), undefined, A), false);
});

// A seeded random run: a small generator, the same answers every time for one seed.
function rng(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

test('property: 5,000 random logins and companies keep every rule (seeded)', () => {
  const SEED = 20261020;
  const rand = rng(SEED);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const roles = ['owner', 'manager', 'super_admin', 'staff', 'Owner', '', null];
  const orgs = [A, B, C, null, undefined, ''];
  const levels = [null, undefined, 'sites', 'sites_full', 'all', 'head_office'];
  const sectionLists = [null, undefined, [], ['inventory'], ['purchasing'], ['inventory', 'produce', 'purchasing'], 'inventory'];
  const rank = (lv) => STOCK_LEVELS.indexOf(lv);
  for (let k = 0; k < 5000; k++) {
    const prof = { role: pick(roles), org_id: pick(orgs), stock_control: pick(levels), sections: pick(sectionLists) };
    const company = pick(orgs);
    const section = pick(['inventory', 'produce', 'purchasing', 'menu', 'nope']);
    const multi = pick([true, false, undefined]);
    const why = `seed ${SEED} step ${k}: ${JSON.stringify({ prof, company, section, multi })}`;
    const lv = stockLevelOf(prof, company);
    assert.ok(STOCK_LEVELS.includes(lv), why);
    const sameCompany = typeof company === 'string' && company !== '' && prof.org_id === company;
    if (prof.role === 'super_admin') assert.equal(lv, 'all', why);
    else if (!sameCompany) assert.equal(lv, 'sites', `${why}: another company or none is always sites`);
    else if (prof.role === 'owner') assert.equal(lv, 'all', why);
    else assert.equal(lv, STOCK_LEVELS.includes(prof.stock_control) ? prof.stock_control : 'sites', why);
    const editCo = canEditCompany(prof, section, multi, company);
    const editPrice = canEditSitePrice(prof, multi, company);
    if (editCo && multi !== false) assert.equal(lv, 'all', `${why}: a multi site company editor is level all`);
    if (editCo) assert.ok(BO_SECTION_KEYS.includes(section), why);
    if (multi === false) assert.equal(editPrice, true, why);
    else assert.equal(editPrice, rank(lv) >= 1, why);
    // a higher level never takes a right away (same login, same section list)
    if (prof.role === 'manager' && sameCompany) {
      const up = { ...prof, stock_control: 'all' };
      if (editCo) assert.equal(canEditCompany(up, section, multi, company), true, why);
      if (editPrice) assert.equal(canEditSitePrice(up, multi, company), true, why);
    }
  }
});
