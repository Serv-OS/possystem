// src/staff/peopleAcrossSites.test.js
//
// 5.12.36: one person, many sites. The Sites panel rules (peopleAcrossSites.js), and pins that the
// payroll, the SQL and the Back Office use them the way Peter asked (2 Nov 2026): "one member of staff
// might work at 2 sites or 3 sites" and "a pos user shared between sites with the same pin, changed at
// one location changed at both".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { otherSites, linkCandidates, sitesToAdd, linkErrorWords } from './peopleAcrossSites.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const SITES = [{ id: 'provo', name: 'Provo' }, { id: 'daybreak', name: 'Daybreak' }, { id: 'milk', name: 'Milk Block' }];
const NAMES = Object.fromEntries(SITES.map((s) => [s.id, s.name]));

test('otherSites: the linked records anywhere but here, leavers last', () => {
  const me = { id: 'j1', personId: 'p', locationId: 'provo' };
  const recs = [
    { id: 'j1', person_id: 'p', location_id: 'provo', role_key: 'floor' },
    { id: 'j3', person_id: 'p', location_id: 'milk', role_key: 'bar', status: 'leaver' },
    { id: 'j2', person_id: 'p', location_id: 'daybreak', role_key: 'bar', rate_override: '17.00' },
    { id: 'x', person_id: 'q', location_id: 'daybreak' },
  ];
  assert.deepEqual(otherSites(me, recs, NAMES).map((r) => [r.site, r.rate, r.leaver]), [['Daybreak', 17, false], ['Milk Block', null, true]]);
  assert.deepEqual(otherSites({ id: 'j1', personId: null }, recs, NAMES), []);
});

test('linkCandidates: same name, email or mobile at another site; never at a site they are at, never a leaver', () => {
  const me = { id: 'c1', name: 'Cara  Cole', email: 'Cara@Mozz.com', mobile: '(801) 555-0102', personId: null, locationId: 'provo' };
  const recs = [
    { id: 'c1', name: 'Cara Cole', location_id: 'provo' },
    { id: 'c2', name: 'cara cole', email: 'cara@mozz.com', location_id: 'daybreak' },
    { id: 'c3', name: 'C. Cole', mobile: '+1 801 555 0102', location_id: 'milk' },
    { id: 'c4', name: 'Cara Cole', location_id: 'provo' },                    // same site: never
    { id: 'c5', name: 'Cara Cole', location_id: 'milk', status: 'leaver' },  // leaver: never
    { id: 'z', name: 'Zed', location_id: 'milk' },
  ];
  const c = linkCandidates(me, recs, NAMES);
  assert.deepEqual(c.map((x) => [x.staffId, x.why]), [['c2', 'same name, same email'], ['c3', 'same mobile']]);
  // Once linked to Daybreak, Daybreak is one of their sites: no more Daybreak suggestions.
  const linked = linkCandidates({ ...me, personId: 'p' }, recs.map((r) => (r.id === 'c2' ? { ...r, person_id: 'p' } : r)), NAMES);
  assert.deepEqual(linked.map((x) => x.staffId), ['c3']);
  assert.deepEqual(linkCandidates(null, recs), []);
});

test('sitesToAdd: the company sites with no live record of theirs', () => {
  const me = { id: 'j1', personId: 'p', locationId: 'provo' };
  const recs = [{ id: 'j2', person_id: 'p', location_id: 'daybreak' }, { id: 'j3', person_id: 'p', location_id: 'milk', status: 'leaver' }];
  assert.deepEqual(sitesToAdd(me, recs, SITES).map((s) => s.id), ['milk']);
  assert.deepEqual(sitesToAdd({ id: 'a', locationId: 'provo' }, [], SITES).map((s) => s.id), ['daybreak', 'milk']);
});

test('linkErrorWords: the database refusal in plain words', () => {
  assert.match(linkErrorWords({ code: 'PGRST202', message: 'Could not find the function public.wf_staff_add_site' }), /database update first/);
  assert.match(linkErrorWords({ code: '42501', message: 'You need access to every site this person works at to do that' }), /access to both sites/);
  assert.equal(linkErrorWords({ code: '23505', message: 'That PIN is already used by Bea B at Barnsley . Pick another PIN' }), 'That PIN is already used by Bea B at Barnsley. Pick another PIN');
  assert.match(linkErrorWords({ code: '23505', message: 'They already work at that site' }), /Link it instead/);
  assert.match(linkErrorWords(null), /Try again/);
});

test('payroll counts a linked person across sites (workforce-compute reads person_id and the shared rule)', () => {
  const fn = read('../../supabase/functions/workforce-compute/index.ts');
  assert.match(fn, /import \{ overtimeAcrossSites \} from '\.\.\/_shared\/multiSiteOvertime\.js'/);
  assert.match(fn, /select\('id, person_id, role_key'\)\.eq\('location_id', location_id\)/);
  assert.match(fn, /\.eq\('org_id', org\)\.in\('person_id', persons\)\.neq\('location_id', location_id\)/);
  assert.match(fn, /overtimeAcrossSites\(all, pack\.overtimeWeeklyHours, \{ tz: venue\.timezone, weekStartDow: wsd, from, to, here: location_id \}\)/);
  assert.match(fn, /line\.overtime_premium = o\?\.overtimePremium \?\? 0;/);
  assert.match(fn, /line\.total = round2\(line\.total \+ line\.overtime_premium\);/);
  assert.doesNotMatch(fn, /overtimeSplit\(weekSheets/);
});

test('the US export carries the hours at other sites, the blended rate and the overtime premium', () => {
  const ui = read('../backoffice/sections/workforce/WfPayroll.jsx');
  assert.match(ui, /'Hours at other sites', 'Regular rate \(blended\)', 'Overtime premium'/);
  assert.match(ui, /at other sites<\/div>/);
});

test('the SQL: one link column on both tables, three doors, a shared PIN that checks every site', () => {
  const sql = read('../../supabase/migrations/20261111a_OPS_wf_people_across_sites.sql');
  for (const re of [
    /alter table public\.wf_staff add column person_id uuid;/,
    /alter table public\.staff_members add column person_id uuid;/,
    /'portal_invite_expires', 'person_id'\)/,                   // the regrant leaves person_id out
    /select public\.wf_staff_regrant_api\(\) as columns_granted;/, // a new wf_staff column regrants
    /create function public\.wf_staff_add_site\(p_staff_id uuid, p_location_id uuid, p_role_key text default null, p_rate numeric default null\)/,
    /create function public\.wf_staff_link\(p_staff_id uuid, p_other_id uuid\)/,
    /create function public\.wf_staff_unlink\(p_staff_id uuid\)/,
    /You need access to every site this person works at to do that/,
    /perform public\.wf_people_assert_access\(new\.org_id, v_locs\);/,  // a shared PIN changes only with every site
    /after update of pin, nfc_card_id, auth_method, name, initials, color on public\.staff_members/,
  ]) assert.match(sql, re);
  // Role, permissions and rate are never synced: a manager at one site can be staff at another.
  const tillSync = sql.slice(sql.indexOf('create function public.wf_people_sync_till()'), sql.indexOf('create trigger staff_members_person_sync_trg'));
  assert.doesNotMatch(tillSync, /\brole\s*=|permissions\s*=/);
  const staffSync = sql.slice(sql.indexOf('create function public.wf_people_sync_staff()'), sql.indexOf('create trigger wf_staff_person_sync_trg'));
  assert.doesNotMatch(staffSync, /role_key\s*=|rate_override\s*=|status\s*=|section_ids\s*=/);
  assert.ok(fs.existsSync(new URL('../../supabase/migrations/20261111a_OPS_wf_people_across_sites_ROLLBACK.sql', import.meta.url)));
});

test('the Back Office Sites panel uses the doors and reads person_id safely before the SQL has run', () => {
  const wf = read('../backoffice/sections/Workforce.jsx');
  assert.match(wf, /<SectionTitle>Sites<\/SectionTitle>/);
  assert.match(wf, /addStaffSite\(s\.id, addSite/);
  assert.match(wf, /linkStaffRecords\(s\.id, c\.staffId\)/);
  assert.match(wf, /unlinkStaffRecord\(s\.id\)/);
  const data = read('./wfData.js');
  assert.match(data, /peopleDoor\('wf_staff_add_site'/);
  assert.match(data, /if \(error && \/person_id\|42703\|PGRST204\/i\.test/);
  assert.doesNotMatch(data, /from\('wf_staff'\)\.update\(\{ ?person_id/);
});
