// src/staff/tillSites.test.js
//
// 5.12.39: Back Office, Team, Sites (Peter, 2 Nov 2026: "I also can't see any way within Team to be
// able to set which sites they work at", "we need both", "people might work across all sites").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { otherSites, linkCandidates, sitesToAdd, asTillRecords } from './peopleAcrossSites.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const SITES = [{ id: 'provo', name: 'Provo' }, { id: 'day', name: 'Daybreak' }, { id: 'milk', name: 'Milk Block' }, { id: 'wood', name: 'Woodbine' }];
const NAMES = Object.fromEntries(SITES.map((s) => [s.id, s.name]));

test('till users read as the Sites rules read records: switched off is a leaver, no site is dropped', () => {
  const recs = asTillRecords([
    { id: 'a', name: 'Ann', location_id: 'provo', person_id: 'p', active: true },
    { id: 'b', name: 'Ann', location_id: 'day', person_id: 'p', active: false },
    { id: 'c', name: 'Org only', location_id: null },
    null,
  ]);
  assert.deepEqual(recs.map((r) => [r.id, r.status]), [['a', 'active'], ['b', 'leaver']]);
});

test('a till user can be added at every other site; linked sites and suggestions as in Workforce', () => {
  const recs = asTillRecords([
    { id: 'ann', name: 'Ann A', location_id: 'provo', person_id: 'p', active: true },
    { id: 'ann-day', name: 'Ann A', location_id: 'day', person_id: 'p', active: true },
    { id: 'ann-milk', name: 'Ann A', location_id: 'milk', person_id: null, active: true },   // made by hand
  ]);
  const me = { id: 'ann', name: 'Ann A', personId: 'p', locationId: 'provo' };
  assert.deepEqual(otherSites(me, recs, NAMES).map((x) => x.site), ['Daybreak']);
  assert.deepEqual(linkCandidates(me, recs, NAMES).map((x) => [x.site, x.why]), [['Milk Block', 'same name']]);
  assert.deepEqual(sitesToAdd(me, recs, SITES).map((x) => x.id), ['milk', 'wood']);   // Select all = both
});

test('Team shows the Sites panel and it goes through the three till doors', () => {
  const team = read('../backoffice/sections/StaffManager.jsx');
  assert.match(team, /<TillSitesPanel member=\{sel\} orgCtx=\{orgCtx\} showToast=\{showToast\} \/>/);
  const panel = read('../backoffice/sections/TillSitesPanel.jsx');
  assert.match(panel, /tillDoor\('wf_till_add_site', \{ p_member: member\.id, p_location: id \}\)/);
  assert.match(panel, /tillDoor\('wf_till_link', \{ p_member: member\.id, p_other: c\.staffId \}\)/);
  assert.match(panel, /tillDoor\('wf_till_unlink', \{ p_member: member\.id \}\)/);
  assert.match(panel, /Select all/);
  const wf = read('../backoffice/sections/Workforce.jsx');
  assert.match(wf, /Select all/);
  assert.match(wf, /tick every site that applies, with their position and pay rate there/);
  const sql = read('../../supabase/migrations/20261113a_OPS_till_users_across_sites.sql');
  assert.match(sql, /return public\.wf_staff_add_site\(v_staff, p_location, null, null\);/);   // a Workforce record: both records
  assert.match(sql, /return public\.wf_staff_link\(v_sa, v_sb\);/);
  assert.match(sql, /'function \(public\\\.\)\?wf_\(staff\|till\)_\(add_site\|link\|unlink\)\\\('/);
  assert.match(sql, /create trigger wf_staff_zz_person_inherit_trg/);
});
