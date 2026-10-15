// src/lib/menuBoardCleanupSql.test.js
//
// 12 Oct 2026. The clean up for the screen rows the night of 11 to 12 Oct left behind is three
// files Peter runs by hand in the Ops SQL editor: a PREVIEW that only lists, the REMOVE file that
// removes the same list, and an undo note. They live in supabase/data_fixes with the other row
// only fixes (they change no schema, so they are not migrations). These tests hold the promises
// their headers make: the two files list by the SAME rule, the preview cannot change anything,
// the REMOVE file is one statement (so one transaction) with both locks, reasons A and B can
// never list the row a TV is using and reason C only a never paired row silent for 7 days, and
// none of them changes the schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../../supabase/data_fixes/${f}`, import.meta.url), 'utf8');
const PREVIEW = read('20261012a_menu_board_screens_cleanup_PREVIEW.sql');
const REMOVE = read('20261012b_menu_board_screens_cleanup_REMOVE.sql');
const NOTE = read('20261012b_menu_board_screens_cleanup_UNDO_NOTE.sql');
// Built from the character numbers so this file holds no long dash itself.
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

/** The SQL with comments taken out, and (when asked) the text inside quotes emptied. */
function code(sql, { keepText = false } = {}) {
  let out = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i += 1; out += '\n'; continue; }
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; } if (sql[j] === "'") break; j += 1; }
      out += keepText ? sql.slice(i, j + 1) : "''";
      i = j; continue;
    }
    out += ch;
  }
  return out;
}
const words = (sql) => code(sql).toLowerCase();
const has = (sql, word) => new RegExp(`\\b${word}\\b`).test(words(sql));
const rule = (sql) => {
  const a = sql.indexOf('-- RULE START'); const b = sql.indexOf('-- RULE END');
  assert.ok(a >= 0 && b > a, 'the rule block is marked');
  return sql.slice(a, b + '-- RULE END'.length);
};

test('the preview and the clean up list by the same rule, byte for byte', () => {
  assert.equal(rule(PREVIEW), rule(REMOVE));
  assert.ok(rule(PREVIEW).length > 1500, 'and the rule is all there');
});

test('the preview cannot change anything', () => {
  for (const w of ['delete', 'update', 'insert', 'drop', 'alter', 'truncate', 'create', 'grant', 'revoke', 'into']) {
    assert.equal(has(PREVIEW, w), false, `no ${w} in the preview`);
  }
  assert.match(words(PREVIEW).trim(), /^with ranked as \(/);
});

test('the rollback note only counts', () => {
  for (const w of ['delete', 'update', 'insert', 'drop', 'alter', 'truncate', 'create', 'grant', 'revoke', 'into']) {
    assert.equal(has(NOTE, w), false, `no ${w} in the note`);
  }
  assert.match(words(NOTE).trim(), /^select /);
  assert.match(NOTE, /"undo"/, 'it says where the rollback statement is');
});

test('each file is one statement, so one transaction: all of it or none of it', () => {
  for (const [name, sql] of [['preview', PREVIEW], ['clean up', REMOVE], ['note', NOTE]]) {
    const c = words(sql).trim();
    assert.equal(c.split(';').length - 1, 1, `${name}: one statement`);
    assert.ok(c.endsWith(';'), `${name}: nothing after it`);
    assert.equal(has(sql, 'begin') || has(sql, 'commit'), false, `${name}: no transaction to type by hand`);
  }
});

test('the clean up removes only screen rows, only the listed ones, behind both locks', () => {
  const c = words(REMOVE);
  assert.equal(c.split('delete from').length - 1, 1, 'one delete');
  assert.match(c, /delete from public\.menu_board_screens s\s+using pick p, gate g\s+where s\.id = p\.id and p\.why is not null\s+and g\.listed_live = 0 and g\.listed <= 60\s+returning s\.\*, p\.why/);
  for (const w of ['update', 'drop', 'alter', 'truncate', 'create', 'unique', 'index', 'grant', 'revoke']) {
    assert.equal(has(REMOVE, w), false, `no ${w} in the clean up (no schema change)`);
  }
  // The undo statement is text the file prints, never something it runs.
  assert.equal(has(REMOVE, 'insert'), false);
  assert.match(code(REMOVE, { keepText: true }), /'insert into public\.menu_board_screens select \* from jsonb_populate_recordset\(null::public\.menu_board_screens, '/);
  assert.match(c, /quote_literal\(jsonb_agg\(to_jsonb\(x\) - ''\)::text\)/, 'every removed row, in full, minus the reason column');
});

test('A and B never list the row a TV is using or a paired row it must go back to; C only a never paired row silent for 7 days', () => {
  const r = code(rule(PREVIEW), { keepText: true });
  // The row in use is the most recently seen one of the device.
  assert.match(r, /row_number\(\) over \(partition by s\.device_uid\s+order by coalesce\(s\.last_seen_at, s\.created_at\) desc, s\.created_at desc, s\.id\) as rn/);
  const a = r.slice(r.indexOf('case'), r.indexOf("then 'A:"));
  const b = r.slice(r.indexOf("then 'A:"), r.indexOf("then 'B:"));
  const c = r.slice(r.indexOf("then 'B:"), r.indexOf("then 'C:"));
  assert.match(a, /when r\.rn > 1 and r\.is_paired and c\.cur_paired/, 'A: never the row in use, and only when the row in use is paired too');
  assert.match(a, /c\.cur_paired_at > r\.paired_at/); assert.match(a, /c\.cur_seen > r\.seen_at and r\.seen_at < now\(\) - interval '1 hour'/);
  assert.match(b, /when r\.rn > 1 and not r\.is_paired and r\.seen_at < now\(\) - interval '1 hour'/, 'B: never the row in use, never a paired row');
  assert.match(c, /when r\.location_id is null and r\.board_id is null and r\.order_display_id is null\s+and r\.status = 'unpaired' and r\.seen_at < now\(\) - interval '7 days'/, 'C: only a row that was never paired');
  assert.match(r, /\(s\.location_id is not null and \(s\.board_id is not null or s\.order_display_id is not null\)\) as is_paired/, 'paired means a venue and something to show, not the status word');
  // C has no "rn > 1": it CAN list the only row of a TV, but only one that was never paired and
  // has been silent for 7 days. The headers say so in plain words.
  const cWhen = c.indexOf('when r.location_id is null');
  assert.ok(cWhen >= 0);
  assert.equal(/rn > 1/.test(c.slice(cWhen)), false);
  for (const sql of [PREVIEW, REMOVE]) {
    assert.match(sql, /This can be the ONLY row of a TV that was never\n-- {6}paired and has been off for 7 days\./);
    assert.match(sql, /-- {3}The row of every TV that is on, and every paired row in use\./);
    assert.equal(/The row each TV uses now/.test(sql), false, 'the old words promised more than rule C keeps');
  }
});

test('a TV is only ever compared with its OWN rows, the undo holds EVERY removed row, and the live lock is a full hour', () => {
  // Three edits that would pass every other check here if made to both files at once.
  const r = code(rule(PREVIEW), { keepText: true });
  assert.match(r, /from ranked r join cur c using \(device_uid\)/, 'never a TV against another TV\'s row in use');
  assert.match(r, /count\(\*\) filter \(where why is not null and seen_at > now\(\) - interval '1 hour'\) as listed_live/, 'the lock looks back a full hour');
  assert.match(code(REMOVE, { keepText: true }), /from gone x\) as undo/, 'the undo is built from all of the removed rows');
});

test('the three files are data fixes, not migrations', () => {
  const migrations = readdirSync(new URL('../../supabase/migrations/', import.meta.url));
  assert.deepEqual(migrations.filter((f) => /menu_board_screens?_cleanup/.test(f)), [], 'nothing of the clean up is filed as a migration');
  for (const sql of [PREVIEW, REMOVE]) assert.match(sql, /It is NOT a migration: it changes no schema/);
  assert.match(REMOVE, /are in 20261012b_menu_board_screens_cleanup_UNDO_NOTE\.sql\./);
  assert.match(NOTE, /20261012b_menu_board_screens_cleanup_REMOVE\.sql/);
  for (const sql of [PREVIEW, REMOVE, NOTE]) assert.equal(/_OPS_menu_board_screen_cleanup/.test(sql), false, 'no old file name left in a header');
});

test('the headers say whose job it is, that it is optional, and how to undo it', () => {
  for (const sql of [PREVIEW, REMOVE, NOTE]) {
    assert.match(sql, /OPS DB ONLY {3}project ref {2}tbetcegmszzotrwdtqhi/);
    assert.match(sql, /Peter runs this by hand\. Not run by Claude\./);
    assert.equal(LONG_DASH.test(sql), false, 'no long dashes');
  }
  for (const sql of [PREVIEW, REMOVE]) {
    assert.match(sql, /OPTIONAL: the TV fix does not need/);
    assert.match(sql, /NO SCHEMA CHANGE\./);
    for (let n = 1; n <= 6; n += 1) assert.match(sql, new RegExp(`--   ${n}\\. `), `step ${n}`);
    assert.match(sql, /WHAT YOU SHOULD SEE\./);
  }
  assert.match(PREVIEW, /READ ONLY\. This file changes nothing\./);
  assert.match(REMOVE, /-- ROLLBACK\. The "undo" cell of row 0 is the rollback/);
  for (const sql of [PREVIEW, REMOVE]) assert.match(sql, /WHEN TO RUN IT\. The same day the TVs go on the new build, and before anyone presses Remove/);
});
