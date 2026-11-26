// 5.12.112: an option group that lets customers pick several options, each only once.
//
// Peter, 26 Nov 2026: "any of the pizza options they can select multiple but only one of each",
// "launch for the entire system", "add it to the options only under the several choices setting"
// and "it needs to work the same no matter where you order".
//
// Before: "Several choices" let the same option be picked twice on the POS and the kiosk (many
// venues rely on that: two syrups, an extra sausage twice) but never online. There was no way to
// ask for "each only once". Now:
//   * a new kind of choice, multiple_once, set by ONE tick box that shows only under Several
//     choices (Menu Manager's Pick many, and the Multi site menu);
//   * plain "multiple" is unchanged on the POS and kiosk, and online ordering now lets the same
//     option be added again too, so every way of ordering follows one rule;
//   * the two group menu database lists take the new kind (20261213a).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ONCE_EACH, isOnceEach, isSeveral, choiceKindOf } from './choiceKinds.js';
import { formFromGroup, ruleFromForm, formSentence, newGroupForm } from './msm/msmGroupView.js';
import { CHOICE_WORDS } from './msm/msmWords.js';
import { categoryGuardWords, KINDS_RULE_OLD_WORDS } from './msm/msmEdit.js';
import { SELECTION_TYPES, checkChange } from '../../supabase/functions/_shared/msmModel.js';
import { proposeImport, buildCentral } from '../../supabase/functions/_shared/msmImport.js';
import { planSite, touchedFromChanges, lineWords } from '../../supabase/functions/_shared/msmPlan.js';
import { applyChanges } from '../../supabase/functions/_shared/msmDiff.js';
import { A, ORG, idGen } from './msm/msmFixture.js';
import { groupVenues, groupSites } from './msm/msmGroupFixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

// ── The rule ────────────────────────────────────────────────────────────────

test('the new kind is read in either spelling, and only that kind is once each', () => {
  assert.equal(ONCE_EACH, 'multiple_once');
  assert.equal(isOnceEach({ selectionType: 'multiple_once' }), true, 'a store row');
  assert.equal(isOnceEach({ selection_type: 'multiple_once' }), true, 'a database row');
  assert.equal(isOnceEach({ _selectionType: 'multiple_once' }), true, 'a kiosk group');
  for (const k of ['single', 'multiple', 'quantity', '', null, undefined]) assert.equal(isOnceEach({ selectionType: k }), false, `${k} is not once each`);
  assert.equal(isOnceEach(null), false);
  assert.equal(isSeveral({ selectionType: 'multiple' }), true);
  assert.equal(isSeveral({ selection_type: 'multiple_once' }), true);
  assert.equal(isSeveral({ selectionType: 'quantity' }), false);
  assert.equal(choiceKindOf({ selection_type: 'single' }), 'single');
});

test('plain several choices is untouched: nothing turns a group into once each by itself', () => {
  // A group saved before 5.12.112, in every shape the screens meet.
  for (const g of [{ selectionType: 'multiple', max: 2 }, { selection_type: 'multiple', max: 99 }, { max: 3 }, { selectionType: 'quantity', max: 6 }]) {
    assert.equal(isOnceEach(g), false);
  }
  const f = formFromGroup({ selection_type: 'multiple', min: 0, max: 2 });
  assert.equal(f.onceEach, false);
  assert.deepEqual(ruleFromForm(f), { min: 0, max: 2, selection_type: 'multiple' });
  assert.equal(newGroupForm('g1').form.onceEach, false, 'a new group starts without the tick');
});

// ── The Multi site menu form ────────────────────────────────────────────────

test('the tick sits under Several choices: it is never a fourth button, and it round trips', () => {
  const f = formFromGroup({ selection_type: 'multiple_once', min: 0, max: 2 });
  assert.equal(f.choice, 'multiple', 'shown as Several choices');
  assert.equal(f.onceEach, true);
  assert.deepEqual(ruleFromForm(f), { min: 0, max: 2, selection_type: 'multiple_once' });
  // Ticked, unticked, must choose, as many as they like.
  assert.deepEqual(ruleFromForm({ choice: 'multiple', onceEach: true, mustChoose: true, min: 1, max: 99 }), { min: 1, max: 99, selection_type: 'multiple_once' });
  assert.deepEqual(ruleFromForm({ choice: 'multiple', onceEach: false, max: 3 }), { min: 0, max: 3, selection_type: 'multiple' });
  // The tick means nothing on the other two kinds.
  assert.equal(ruleFromForm({ choice: 'single', onceEach: true }).selection_type, 'single');
  assert.equal(ruleFromForm({ choice: 'quantity', onceEach: true, max: 6 }).selection_type, 'quantity');
  assert.match(formSentence({ choice: 'multiple', onceEach: true, max: 2 }), /Each option only once\.$/);
  assert.doesNotMatch(formSentence({ choice: 'multiple', onceEach: false, max: 2 }), /only once/);
  assert.equal(CHOICE_WORDS.multiple_once, 'Several choices, each option only once');
});

// ── The group menu: the model, a staged change, a publish ───────────────────

test('the group menu takes the new kind and still refuses a made up one', () => {
  assert.deepEqual([...SELECTION_TYPES], ['single', 'multiple', 'quantity', 'multiple_once']);
  const ch = (t) => ({ target: 'modifier_group', entity_id: 'aaaaaaaa-0000-4000-8000-000000000001', location_id: null, op: 'update', after: { selection_type: t } });
  assert.equal(checkChange(ch('multiple_once')).ok, true);
  assert.equal(checkChange(ch('multiple')).ok, true);
  assert.equal(checkChange(ch('anything')).ok, false);
});

test('publishing the tick writes the kind to the site group, and nothing else', () => {
  const v = groupVenues();
  const sites = groupSites(v);
  const { central } = buildCentral(proposeImport(sites, { idGen: idGen() }), sites, {}, { idGen: idGen('g') });
  central.menu = { id: '99999999-0000-4000-8000-000000000001', name: 'Group menu', description: '', use_name_everywhere: false, refreshed_at: '2026-10-17' };
  const gs = central.groupSites.find((r) => r.location_id === A && r.venue_group_id && !(r.kept && 'selection_type' in r.kept));
  assert.ok(gs, 'a group at site A that follows the group menu');
  const g = central.groups.find((x) => x.id === gs.group_id);
  const change = { target: 'modifier_group', entity_id: g.id, location_id: null, op: 'update', after: { selection_type: 'multiple_once' }, before: { selection_type: g.selection_type } };
  const plan = planSite({ central: applyChanges(central, [change]).central, touched: touchedFromChanges([change]), locationId: A, orgId: ORG, venue: v[A] });
  assert.deepEqual(plan.problems.filter((p) => p.level === 'block'), []);
  const line = plan.lines.find((l) => l.column === 'selection_type');
  assert.ok(line, 'the kind of choice is written');
  assert.equal(line.after, 'multiple_once');
  assert.match(lineWords(line, { [g.id]: g.name }), /several choices, each option only once/);
  assert.equal(plan.applied.groups.find((x) => x.id === gs.venue_group_id).selection_type, 'multiple_once');
  assert.equal(plan.lines.filter((l) => l.column !== 'selection_type').length, 0, 'no price, option or product is touched');
});

// ── The database file ───────────────────────────────────────────────────────

test('20261213a swaps the one list in the two group menu functions, as they are on the database', () => {
  const sql = read('../../supabase/migrations/20261213a_OPS_option_group_once_each.sql');
  const rb = read('../../supabase/migrations/20261213a_OPS_option_group_once_each_ROLLBACK.sql');
  const list = (kinds) => `array[${kinds.map((k) => `''${k}''`).join(', ')}]`;
  assert.ok(sql.includes(`v_old  constant text := '${list(SELECTION_TYPES.filter((k) => k !== ONCE_EACH))}';`), 'from the list before');
  assert.ok(sql.includes(`v_new  constant text := '${list([...SELECTION_TYPES])}';`), 'to msmModel.SELECTION_TYPES');
  assert.match(sql, /p\.proname in \('msm_changes_guard', 'msm_apply_site'\)/);
  assert.match(sql, /v_def := pg_get_functiondef\(f\);/, 'the live function, not a copy kept in this file');
  assert.match(sql, /if v_n <> 1 then\s+raise exception/, 'stops unless the list is there exactly once');
  assert.match(sql, /if v_seen <> 2 then\s+raise exception/);
  assert.match(sql, /if position\(v_new in v_def\) > 0 then continue; end if;/, 'safe to run twice');
  // No table, no row, no grant: only the two functions are made again.
  assert.doesNotMatch(sql, /\b(alter|drop|create) table\b|\b(insert into|update|delete from) public\./i);
  assert.doesNotMatch(sql, /grant |revoke /i);
  assert.doesNotMatch(sql, /^\s*(begin|commit);/im, 'bare statements: the SQL editor runs the paste as one transaction');
  assert.match(sql, /as guard_takes_once_each,[\s\S]*as publish_takes_once_each,[\s\S]*as guards_in_order;\s*$/);
  // The roll back swaps the list back, and refuses while a group or a draft still uses the kind.
  assert.ok(rb.includes(`v_old  constant text := '${list([...SELECTION_TYPES])}';`));
  assert.match(rb, /g\.selection_type = 'multiple_once'\) then\s+raise exception/);
  assert.match(rb, /c\.after ->> 'selection_type' = 'multiple_once'\) then\s+raise exception/);
  for (const [f, s] of [['20261213a', sql], ['20261213a roll back', rb]]) assert.doesNotMatch(s, /[^\t\n\r -~]/, `${f} is pure ASCII`);
});

test('before 20261213a has run, the refusal is turned into what to do about it', () => {
  // The database's own words for a kind it does not know, as Ops holds them today (20261017c).
  const m = /selection_type', ''\) <> all \(v_selection\) then\s+raise exception '([^']+)'/.exec(read('../../supabase/migrations/20261017c_OPS_multi_site_menu_groups.sql'));
  assert.ok(m, 'the guard line in 20261017c');
  assert.equal(m[1], KINDS_RULE_OLD_WORDS);
  assert.match(categoryGuardWords(`ERROR: ${m[1]}`), /Each option only once needs one database update that has not been run yet \(SQL 20261213a\)/);
  // The Back Office's own words for a made up kind are different, so they are never mistaken for it.
  assert.notEqual(checkChange({ target: 'modifier_group', entity_id: 'x', op: 'update', after: { selection_type: 'bogus' } }).words, KINDS_RULE_OLD_WORDS);
});

// ── Every way of ordering asks the one rule ─────────────────────────────────

const SCREENS = {
  'the POS': '../components/InlineItemFlow.jsx',
  'the older POS product screens': '../components/ProductModal.jsx',
  'the phone POS': '../surfaces/mpos/MItemDetail.jsx',
  'the kiosk': '../surfaces/KioskProductModal.jsx',
  'the new kiosk sheet': '../surfaces/kiosk/KioskItemSheet.jsx',
  'online ordering, catering and the booking widget': '../surfaces/online/OnlineItemSheet.jsx',
};

test('every ordering screen asks isOnceEach, and none tests the word itself', () => {
  for (const [name, file] of Object.entries(SCREENS)) {
    const src = read(file);
    assert.match(src, /import \{[^}]*\bisOnceEach\b[^}]*\} from '[./]+\/lib\/choiceKinds'/, `${name} imports the rule`);
    assert.match(src, /isOnceEach\(/, `${name} asks the rule`);
    assert.doesNotMatch(src, /multiple_once/, `${name} never writes the word itself`);
  }
});

test('the POS: a second tap on a picked once each option takes it off, and it has no stepper', () => {
  const pos = read('../components/InlineItemFlow.jsx');
  assert.match(pos, /const onceEach\s+= isMulti && isOnceEach\(group\);/);
  assert.match(pos, /if \(onceEach && isSel\) \{\s+onRemoveMulti\(group\.id, /);
  assert.match(pos, /\{isSel && isMulti && !onceEach && \(/, 'no plus and minus badge');
  // Several choices without the tick still adds another on every tap.
  assert.match(pos, /\} else if \(isMulti\) \{\s+if \(!atMax\) onAddMulti\(/);
});

test('online ordering: the same option can be added again unless the group is once each', () => {
  const online = read('../surfaces/online/OnlineItemSheet.jsx');
  assert.match(online, /const canRepeat = !isSingle && !isOnceEach\(g\) && copies > 0;/);
  assert.match(online, /\{canRepeat && \(\s+<div data-testid="online-option-repeat"/);
  assert.match(online, /if \(arr\.length >= max\) return s; return \{ \.\.\.s, \[g\.id\]: \[\.\.\.arr, opt\] \};/, 'never past the group limit');
});

test('the kiosk: a second tap takes a once each option off; the phone POS too', () => {
  const kiosk = read('../surfaces/KioskProductModal.jsx');
  assert.match(kiosk, /if \(isOnceEach\(group\) && \(selections\[group\.id\] \|\| \[\]\)\.includes\(optId\)\) \{/);
  assert.match(kiosk, /const showStepper = \([^;]+\) && !isOnceEach\(g\);/);
  const sheet = read('../surfaces/kiosk/KioskItemSheet.jsx');
  assert.equal((sheet.match(/!g\._isSingle && !isOnceEach\(g\) && st\.count > 0/g) || []).length, 2);
  const phone = read('../surfaces/mpos/MItemDetail.jsx');
  assert.match(phone, /if \(existing && isOnceEach\(group\)\) return \{ \.\.\.prev, \[group\.id\]: current\.filter\(m => m\.id !== opt\.id\) \};/);
  assert.match(phone, /selectionType: def\.selectionType \?\? def\.selection_type \?\? null,/, 'the phone POS now carries the kind of choice');
});

// ── The tick box: only under Several choices ────────────────────────────────

test('Menu Manager: one tick box, only under Pick many, and the hint no longer says each once', () => {
  const mm = read('../backoffice/sections/MenuManager.jsx');
  assert.match(mm, /\{isSeveral\(sel\) && \(\s+<label data-testid="mm-group-once-each"/);
  assert.match(mm, /checked=\{isOnceEach\(sel\)\} onChange=\{e=>upd\(\{ selectionType: e\.target\.checked \? ONCE_EACH : 'multiple' \}\)\}/);
  assert.doesNotMatch(mm, /hint:'Different options, each selectable once'/, 'that was never true on the POS');
  assert.match(mm, /\|\| \(mode\.id === 'multiple' && isOnceEach\(sel\)\)/, 'Pick many stays lit when the tick is on');
});

test('the Multi site menu: one tick box, only under Several choices', () => {
  const sheet = read('../backoffice/sections/msm/MsmGroupSheet.jsx');
  assert.match(sheet, /\{f\.choice === 'multiple' && \(\s+<Field label="The same option twice"/);
  assert.match(sheet, /data-testid="msm-group-once-each" disabled=\{!editable\} checked=\{!!f\.onceEach\} onChange=\{\(e\) => setForm\(\{ onceEach: e\.target\.checked \}\)\}/);
  assert.equal((sheet.match(/msm-group-once-each/g) || []).length, 1);
});
