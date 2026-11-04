// SOPs (5.12.62): the pure rules. Run: npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sopReadable, cleanSopText, searchSops, SOP_TEXT_MAX, SOP_WORDS } from './sopRules.js';

const f = (name, type, size = 1000) => ({ name, type, size });

test('sopReadable: text files read in the browser, PDFs and photos go to the model, office files are refused', () => {
  assert.deepEqual(sopReadable(f('spill.txt', 'text/plain')), { ok: true, how: 'text', error: null });
  assert.deepEqual(sopReadable(f('spill.pdf', 'application/pdf')), { ok: true, how: 'model', error: null });
  assert.deepEqual(sopReadable(f('spill.jpg', 'image/jpeg')), { ok: true, how: 'model', error: null });
  assert.equal(sopReadable(f('spill.pdf', 'application/pdf', 7 * 1024 * 1024)).ok, false);
  assert.match(sopReadable(f('spill.pdf', 'application/pdf', 7 * 1024 * 1024)).error, /under 6 MB/);
  const docx = sopReadable(f('spill.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  assert.equal(docx.ok, false);
  assert.match(docx.error, /Word file.*Save it as a PDF first/);
  assert.match(sopReadable(f('rota.xlsx', '')).error, /spreadsheet/);
  assert.equal(sopReadable(null).ok, false);
});

test('cleanSopText: trims, collapses blank runs, Windows line ends, caps', () => {
  assert.equal(cleanSopText('  Step 1\r\n\r\n\r\n\r\nStep 2   \n'), 'Step 1\n\nStep 2');
  assert.equal(cleanSopText('x'.repeat(SOP_TEXT_MAX + 50)).length, SOP_TEXT_MAX);
  assert.equal(cleanSopText(null), '');
});

const SOPS = [
  { id: '1', title: 'Spillage SOP', category: 'health_safety', text: '1. Put the wet floor sign out.\n2. Mop with the yellow mop.\n3. Tell the manager.' },
  { id: '2', title: 'Cash up', category: 'policies', text: 'Count the float. Print the Z read. Put the takings in the safe.' },
  { id: '3', title: 'Allergy complaint', category: 'food_safety', text: 'Stop service to the table. Call the manager. Keep the plate. Write it in the accident book.' },
  { id: '4', title: 'Empty one', category: 'other', text: '   ' },
];

test('searchSops: ranks by the words asked, hands back the SOP text to quote, lists every title', () => {
  const r = searchSops(SOPS, 'what is our sop for a spill');
  assert.equal(r.count, 1);
  assert.equal(r.sops[0].title, 'Spillage SOP');
  assert.equal(r.sops[0].text, SOPS[0].text);
  assert.equal(r.sops[0].truncated, false);
  assert.deepEqual(r.titles, ['Spillage SOP', 'Cash up', 'Allergy complaint']);   // the empty one is never offered
  assert.equal(r.note, null);
});

test('searchSops: the title beats a body mention; a manager word matches two SOPs in order', () => {
  const r = searchSops(SOPS, 'manager');
  assert.deepEqual(r.sops.map((s) => s.title), ['Spillage SOP', 'Allergy complaint']);
  const c = searchSops(SOPS, 'cash');
  assert.equal(c.sops[0].title, 'Cash up');
});

test('searchSops: no match says so and names what exists; an empty query lists them; no SOPs at all says how to set them up', () => {
  const r = searchSops(SOPS, 'fire alarm');
  assert.equal(r.count, 0);
  assert.match(r.note, /No SOP matches "fire alarm"/);
  assert.equal(r.titles.length, 3);
  const all = searchSops(SOPS, '');
  assert.equal(all.count, 3);
  const none = searchSops([], 'spill');
  assert.equal(none.note, SOP_WORDS.noneYet);
});

test('searchSops: a long SOP is cut at the result cap and says so', () => {
  const long = [{ id: 'L', title: 'Opening checks', text: 'open '.repeat(3000) }];
  const r = searchSops(long, 'opening', { maxChars: 100 });
  assert.equal(r.sops[0].text.length, 100);
  assert.equal(r.sops[0].truncated, true);
  assert.equal(r.sops[0].chars, 15000);
});
