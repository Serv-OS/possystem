// 28 Sep 2026: the kiosk check (kioskNoUndef.test.js, PR 186) over the customer checkouts (QR
// and online). eslint no-undef found two names that did not exist on payment paths. Neither the
// tests nor `vite build` fail on one: it only throws when its line runs.
//   - QrCheckout, v5.9.16: `tabPi` in the customer record call after the order was placed. A
//     guest who left a phone number, on a payment with no id, was told "could not save the
//     order" about a saved order.
//   - OnlineCheckout, v5.9.16: `paymentIntent` in the same call on the gift card only path. Every
//     gift card only order threw there, after it was saved and the gift card debited.
//
// The probe proves the rule is really running: a linter that matched no files or never loaded
// the rule would otherwise pass as "clean".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import globals from 'globals';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const CHECKOUT_FILES = [
  'src/surfaces/qr/**/*.{js,jsx}',
  'src/surfaces/online/**/*.{js,jsx}',
];

// Only no-undef, so the repo's other rules (unused bindings, hooks) cannot fail this test.
function noUndefLinter() {
  return new ESLint({
    cwd: ROOT,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.{js,jsx}'],
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        globals: globals.browser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      rules: { 'no-undef': 'error' },
    },
  });
}

const problems = (results) => results.flatMap(r => r.messages
  .filter(m => m.ruleId === 'no-undef' || m.fatal)
  .map(m => `${r.filePath.slice(ROOT.length)}:${m.line} ${m.message}`));

test('the no-undef check catches the v5.9.16 QR fault (probe)', async () => {
  const probe = [
    'export function onPaymentSuccess({ payId, placed, phone }) {',
    '  return chooseTrackKey({ trackToken: placed?.trackToken, paymentIntentId: payId || tabPi || null, phone });',
    '}',
    'function chooseTrackKey(k) { return k; }',
  ].join('\n');
  const results = await noUndefLinter().lintText(probe, { filePath: `${ROOT}src/surfaces/qr/probe.jsx` });
  assert.deepEqual(problems(results), ["src/surfaces/qr/probe.jsx:2 'tabPi' is not defined."]);
});

test('no QR or online checkout file uses a name that is not defined', async () => {
  const results = await noUndefLinter().lintFiles(CHECKOUT_FILES);
  const linted = results.map(r => r.filePath.slice(ROOT.length));
  for (const f of ['src/surfaces/qr/QrCheckout.jsx', 'src/surfaces/online/OnlineCheckout.jsx']) {
    assert.ok(linted.includes(f), `${f} was linted`);
  }
  assert.deepEqual(problems(results), []);
});

test('the customer record call after a placed order cannot throw into the checkout', () => {
  // afterPlaced (lib/publicOrder.js) catches a throw while the arguments are built, which the
  // old .catch() on the returned promise could not.
  for (const [file, count] of [['../surfaces/qr/QrCheckout.jsx', 1], ['../surfaces/online/OnlineCheckout.jsx', 2]]) {
    const src = read(file);
    const calls = src.split('attributeOnlineOrder({').slice(1);
    assert.equal(calls.length, count, `${file}: every attribution call is counted`);
    const guarded = src.match(/afterPlaced\('[A-Za-z ]+', \(\) => attributeOnlineOrder\(\{/g) || [];
    assert.equal(guarded.length, count, `${file}: every attribution call runs inside afterPlaced`);
    assert.match(src, /import \{[^}]*\bafterPlaced\b[^}]*\} from '\.\.\/\.\.\/lib\/publicOrder'/);
  }
});

test('the QR key is this order\'s own payment id, and the gift card path sends none', () => {
  const qr = read('../surfaces/qr/QrCheckout.jsx');
  assert.match(qr, /trackKey: chooseTrackKey\(\{ trackToken: placed\?\.trackToken, paymentIntentId: payId \|\| null, phone: customer\.phone \}\)/);
  const online = read('../surfaces/online/OnlineCheckout.jsx');
  const giftOnly = online.slice(online.indexOf('const onGiftOnlyPayment = async'), online.indexOf('const onPaymentSuccess = async'));
  assert.ok(giftOnly.length > 0, 'the gift card only path was found');
  assert.match(giftOnly, /trackKey: chooseTrackKey\(\{ trackToken: placed\?\.trackToken, phone: customer\.phone \}\)/);
  assert.doesNotMatch(giftOnly, /\bpaymentIntent\?\.id\b/);
});
