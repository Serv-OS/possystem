// optionAnswers.test.js: the option flow's answers go out as a small record and come back as the
// flow's own state, so "Change" on a Combo pick opens with what was already chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { answersFromFlow, flowFromAnswers, optionKey } from './optionAnswers.js';

const GROUPS = [
  { id: 'g-crust', name: 'Crust', selectionType: 'single', options: [{ id: 'o-thin', name: 'Thin', price: 0 }, { id: 'o-deep', name: 'Deep pan', price: 2 }] },
  { id: 'g-extra', name: 'Extras', selectionType: 'multiple', options: [{ id: 'o-cheese', name: 'Extra cheese', price: 1.5, itemId: 'x-cheese' }, { id: 'o-ham', name: 'Ham', price: 2 }] },
  { id: 'g-box', name: 'Dips', selectionType: 'quantity', options: [{ id: 'o-ranch', name: 'Ranch', price: 1 }, { name: 'Garlic', price: 1 }] },
  { id: 'g-nested', name: 'Sauce base', selectionType: 'single', options: [{ id: 'o-bbq', name: 'BBQ' }] },
];
const INST = [{ id: 'ig-cook', name: 'Cooking', options: ['Rare', 'Medium', 'Well done'] }];
const shaped = (g, id) => { const o = GROUPS.find((x) => x.id === g).options.find((x) => optionKey(x) === id); return { ...o, id: optionKey(o), label: o.name }; };

// The flow's own state, exactly as InlineItemFlow holds it.
const STATE = {
  variantId: 'size-large',
  selections: {
    'g-crust': shaped('g-crust', 'o-deep'),
    'g-extra': [{ ...shaped('g-extra', 'o-cheese'), _uid: 1 }, { ...shaped('g-extra', 'o-cheese'), _uid: 2 }, { ...shaped('g-extra', 'o-ham'), _uid: 3 }],
    'g-box': { 'o-ranch': 2, Garlic: 1 },
    'g-nested': shaped('g-nested', 'o-bbq'),
    'g-empty': null, 'g-none': [], 'g-zero': {},
  },
  instSelections: { 'ig-cook': 'Medium', 'ig-skip': null },
  notes: '  no basil ',
};

test('the answers are recorded by id, with nothing for what was not answered', () => {
  assert.deepEqual(answersFromFlow(STATE), {
    v: 'size-large',
    s: { 'g-crust': { one: 'o-deep' }, 'g-extra': { many: ['o-cheese', 'o-cheese', 'o-ham'] }, 'g-box': { qty: { 'o-ranch': 2, Garlic: 1 } }, 'g-nested': { one: 'o-bbq' } },
    i: { 'ig-cook': 'Medium' },
    n: 'no basil',
  });
  assert.equal(answersFromFlow({}), null);
  assert.equal(answersFromFlow(), null);
  assert.equal(answersFromFlow({ selections: { g: null }, instSelections: {}, notes: '   ' }), null);
  assert.deepEqual(answersFromFlow({ variantId: 's1' }), { v: 's1' });
  assert.deepEqual(answersFromFlow({ selections: { g: { a: 0, b: 2 } } }), { s: { g: { qty: { b: 2 } } } });
});

test('a record opens the flow as it was left: the same choices, the same counts, the same note', () => {
  let n = 0;
  const back = flowFromAnswers(answersFromFlow(STATE), GROUPS, INST, () => `u${++n}`);
  assert.equal(back.variantId, 'size-large');
  assert.equal(back.notes, 'no basil');
  assert.deepEqual(back.instSelections, { 'ig-cook': 'Medium' });
  assert.deepEqual(back.selections['g-crust'], shaped('g-crust', 'o-deep'));
  assert.deepEqual(back.selections['g-extra'].map((o) => [o.id, o.label, o.price, o._uid]), [['o-cheese', 'Extra cheese', 1.5, 'u1'], ['o-cheese', 'Extra cheese', 1.5, 'u2'], ['o-ham', 'Ham', 2, 'u3']]);
  assert.equal(back.selections['g-extra'][0].itemId, 'x-cheese');          // the link to the product (stock, 86) rides along
  assert.deepEqual(back.selections['g-box'], { 'o-ranch': 2, Garlic: 1 });
  assert.deepEqual(back.selections['g-nested'], shaped('g-nested', 'o-bbq'));
  // And the record of that state is the record we started from (a fixed point).
  assert.deepEqual(answersFromFlow(back), answersFromFlow(STATE));
});

test('prices and names come from the groups as they are today; what has gone is not ticked', () => {
  const today = GROUPS.map((g) => (g.id === 'g-crust' ? { ...g, options: [{ id: 'o-deep', name: 'Deep dish', price: 3 }] } : g)).filter((g) => g.id !== 'g-box');
  const back = flowFromAnswers(answersFromFlow(STATE), today, []);
  assert.equal(back.selections['g-crust'].label, 'Deep dish');
  assert.equal(back.selections['g-crust'].price, 3);
  assert.equal('g-box' in back.selections, false);                         // the group has gone
  assert.deepEqual(back.instSelections, {});                               // so has the instruction group
  const noHam = GROUPS.map((g) => (g.id === 'g-extra' ? { ...g, options: g.options.filter((o) => o.id !== 'o-ham') } : g));
  assert.deepEqual(flowFromAnswers(answersFromFlow(STATE), noHam, INST).selections['g-extra'].map((o) => o.id), ['o-cheese', 'o-cheese']);
  // An instruction answer that is no longer one of the choices is not kept.
  assert.deepEqual(flowFromAnswers({ i: { 'ig-cook': 'Blue' } }, GROUPS, INST).instSelections, {});
});

test('nothing recorded, or rubbish, opens a blank flow', () => {
  const blank = { variantId: null, selections: {}, instSelections: {}, notes: '' };
  assert.deepEqual(flowFromAnswers(null, GROUPS, INST), blank);
  assert.deepEqual(flowFromAnswers('x', GROUPS, INST), blank);
  assert.deepEqual(flowFromAnswers({ s: 'x', i: [] }, GROUPS, INST), blank);
  assert.deepEqual(flowFromAnswers({ s: { 'g-crust': 'x', 'g-extra': { many: 'x' }, 'g-box': { qty: [] } } }, GROUPS, INST), blank);
});

test('the option flow hands the record back and starts from one, and is unchanged when given none', () => {
  const flow = fs.readFileSync(new URL('../components/InlineItemFlow.jsx', import.meta.url), 'utf8');
  assert.match(flow, /import \{ answersFromFlow, flowFromAnswers \} from '\.\.\/lib\/optionAnswers';/);
  assert.match(flow, /initialAnswers = null/);
  assert.match(flow, /const \[seed\] = useState\(\(\) => \(initialAnswers \? flowFromAnswers\(/);
  assert.match(flow, /useState\(seed\?\.selections \|\| \{\}\)/);
  assert.match(flow, /useState\(seed\?\.instSelections \|\| \{\}\)/);
  // Both ways out of the flow carry the record.
  assert.equal((flow.match(/answers: answersFromFlow\(/g) || []).length, 2);
});
