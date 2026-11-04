// 5.12.59 (Peter's decisions 2.4 and 2.5, 4 Nov 2026): identity document files and pay rate overrides
// read through the same door as ID numbers and bank details (20261121a). Pins the browser side; the
// database side is proved by supabase/tests/private_details/run.sh (39 checks).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { otherSites } from '../staff/peopleAcrossSites.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('private documents and rates (5.12.59)', () => {
  it('loadStaff never reads rate_override from the table; it comes through the door', () => {
    const src = read('src/staff/wfData.js');
    const cols = src.match(/const STAFF_COLS = '([^']+)'/)[1];
    assert.ok(!cols.split(',').includes('rate_override'));
    assert.ok(src.includes("const rates = await loadSiteRates(locationId);"));
    assert.ok(!src.includes("role_key, rate_override, status"), 'the company wide read has no rate');
  });

  it('the Sites panel shows rate hidden for a site the login may not see', () => {
    const me = { id: 'a', personId: 'P' };
    const records = [{ id: 'a', person_id: 'P', location_id: 'L1' }, { id: 'b', person_id: 'P', location_id: 'L2', role_key: 'chef', rate_override: 14 }];
    const open = otherSites(me, records, { L2: 'Daybreak' }, { L2: { byId: { b: 15 }, hidden: false } });
    assert.equal(open[0].rate, 15);
    assert.equal(open[0].rateHidden, false);
    const hidden = otherSites(me, records, { L2: 'Daybreak' }, { L2: { byId: {}, hidden: true } });
    assert.equal(hidden[0].rate, null);
    assert.equal(hidden[0].rateHidden, true);
    const before = otherSites(me, records, { L2: 'Daybreak' });   // before 20261121a: the row's own value
    assert.equal(before[0].rate, 14);
    const wf = read('src/backoffice/sections/Workforce.jsx');
    assert.ok(wf.includes("l.rateHidden ? ' · rate hidden'"));
    assert.ok(wf.includes("otherSites(me, state.records, names, state.rates)"));
  });

  it('an identity file that will not open says Hidden next to View; the row stays', () => {
    const src = read('src/backoffice/sections/workforce/WfCompliance.jsx');
    assert.ok(src.includes('else setRefused(true)'));
    assert.ok(src.includes('{refused && <span'));
    assert.ok(src.includes("import { HIDDEN_WORDS } from '../../../staff/privateDetails';"));
  });

  it('the SQL fences RTW files by name and rate_override by column, and the re grant keeps both closed', () => {
    const sql = read('supabase/migrations/20261121a_OPS_wf_private_docs_rates.sql');
    assert.ok(sql.includes("storage.foldername(objects.name)"), 'objects.name, never a bare name');
    assert.ok(sql.includes("'rate_override');"), 'rate_override in the re grant exclusion');
    assert.ok(sql.includes("raise exception 'Hidden (owner, admin or payroll details access only)' using errcode = '42501'"));
    assert.ok(!/[\u2013\u2014]/.test(sql));
    assert.ok(/[^\x00-\x7F]/.test(sql) === false, 'ASCII only');
  });
});
