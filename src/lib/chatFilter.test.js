// src/lib/chatFilter.test.js
//
// 5.11.102 team chat: the word filter (_shared/chatFilter.js) the team-chat edge function runs on every
// message, caption, group name and profile name before anything is stored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkText, checkMessage, checkName, buildMatcher, findBlocked, readings, luhnOk, hasCardNumber, hasBankDetails,
  BLOCKED_WORD_TEXT, CARD_TEXT, BANK_TEXT, BUILT_IN,
} from '../../supabase/functions/_shared/chatFilter.js';

const blocked = (t, o) => !checkText(t, o).ok;
const passes = (t, o) => checkText(t, o).ok;

test('ordinary kitchen and bar talk passes at every level', () => {
  for (const level of ['strict', 'standard', 'custom']) {
    for (const t of ['Morning all, delivery at 9', 'Can someone cover my shift Saturday?', 'Table 455 wants the bill',
      'Who took the class on assessing allergens', 'Scunthorpe branch is short tonight', 'grass fed beef is in',
      'shiitake mushrooms are off', 'the cocktail menu changes Friday', 'pass the peacock feathers', 'as soon as you can',
      'Call me on 07700 900123', 'pollo asado para la mesa 4', 'necesito la cuenta', 'computation of tips is done', 'reputation matters']) {
      assert.equal(checkText(t, { level }).ok, true, `${level}: ${t}`);
    }
  }
});

test('the refusal says the agreed words', () => {
  const r = checkText('what the fuck', {});
  assert.deepEqual([r.ok, r.code, r.message], [false, 'word', BLOCKED_WORD_TEXT]);
  assert.equal(BLOCKED_WORD_TEXT, 'This message has a word your team does not allow.');
});

test('levels: strict blocks mild words, standard does not, custom only slurs and the company list', () => {
  assert.ok(blocked('that is crap', { level: 'strict' }));
  assert.ok(passes('that is crap', { level: 'standard' }));
  assert.ok(blocked('shut up you bitch', { level: 'standard' }));
  assert.ok(passes('shut up you bitch', { level: 'custom' }));
  assert.ok(blocked('pineapple on pizza', { level: 'custom', block: ['pineapple'] }));
  assert.ok(blocked('pineapple on pizza', { level: 'standard', block: ['pineapple'] }));
  assert.ok(passes('pineapple on pizza', { level: 'strict' }));
  assert.ok(passes('anything', { level: 'nonsense' }));
  assert.ok(blocked('fuck', { level: 'nonsense' }), 'an unknown level is read as standard');
});

test('slurs are blocked at every level and the allow list cannot open them', () => {
  for (const level of ['strict', 'standard', 'custom']) {
    assert.ok(blocked('you faggot', { level, allow: ['faggot'] }), level);
    assert.ok(blocked('eres un maricón', { level }), level);
    assert.equal(checkText('n1gger', { level }).category, 'hate', level);
  }
});

test('the allow list switches off a built in word (a pub called The Cock)', () => {
  assert.ok(blocked('meet at The Cock at 6', { level: 'standard' }));
  assert.ok(passes('meet at The Cock at 6', { level: 'standard', allow: ['cock'] }));
  assert.ok(blocked('going for a fag', { level: 'standard' }));
  assert.ok(passes('going for a fag', { level: 'standard', allow: ['fag'] }));
});

test('tricks: capitals, leet, symbols, dots, spaces, stretched letters, look alikes, full width', () => {
  for (const t of ['FUCK', 'FuCk off', 'sh1t', 'sh!t', 'a$$hole', 'f.u.c.k', 'f u c k', 'f-u-c-k', 'fuuuuuck', 'fuckinggg', 'motherfucker']) {
    assert.ok(blocked(t), t);
  }
  assert.ok(blocked('ѕhіt'), 'Cyrillic s and i');
  assert.ok(blocked('ｆｕｃｋ'), 'full width');
  assert.ok(blocked('cμnt'), 'Greek mu for u');
  assert.ok(blocked('b1tch'), '1 as i');
  assert.ok(blocked('cock5ucker'), '5 as s');
  assert.ok(blocked('wh0re'), '0 as o');
  assert.ok(blocked('C0ÑO'), 'Spanish with ñ and a zero');
  assert.ok(passes('cono de helado'), 'cono (a cone) is not coño');
});

test('Spanish words', () => {
  for (const t of ['vete a la mierda', 'hijo de puta', 'eres un gilipollas', 'pinche pendejo', 'qué cabrón', 'concha tu madre', 'conchatumadre']) {
    assert.ok(blocked(t, { level: 'standard' }), t);
  }
  assert.ok(blocked('mueve el culo', { level: 'strict' }));
  assert.ok(passes('mueve el culo', { level: 'standard' }));
});

test('word edges: whole words only unless the list says otherwise', () => {
  assert.ok(passes('the class assessed it', { level: 'strict' }), 'ass inside a word');
  assert.ok(blocked('kiss my ass', { level: 'strict' }));
  assert.ok(blocked('what an assss', { level: 'strict' }), 'stretched');
  assert.ok(passes('Dickens night', { level: 'strict' }));
  assert.ok(blocked('he is a dick', { level: 'strict' }));
  assert.ok(passes('prick the sausages', { level: 'standard' }), 'kitchen word, mild only');
});

test('numbers on their own are never read as letters', () => {
  assert.ok(passes('table 455 and 5318008', { level: 'strict' }));
  assert.ok(blocked('a55', { level: 'strict' }));
});

test('company phrases with spaces match across separators', () => {
  const o = { level: 'custom', block: ['secret menu'] };
  assert.ok(blocked('ask about the secret menu', o));
  assert.ok(blocked('ask about the SECRET.MENU', o));
  assert.ok(passes('secret santa list', o));
});

test('card numbers: 15 or 16 digits passing Luhn, with spaces or dashes', () => {
  assert.ok(luhnOk('4111111111111111'));
  assert.ok(!luhnOk('4111111111111112'));
  assert.ok(hasCardNumber('card 4111 1111 1111 1111 exp 12/27'));
  assert.ok(hasCardNumber('4111-1111-1111-1111'));
  assert.ok(hasCardNumber('amex 378282246310005'));
  assert.ok(!hasCardNumber('4111 1111 1111 1112'), 'fails Luhn');
  assert.ok(!hasCardNumber('order 0000000000000000'), 'all zeros is not a card');
  assert.ok(!hasCardNumber('call 07700900123'));
  const r = checkText('my card is 4111111111111111', { level: 'custom' });
  assert.deepEqual([r.ok, r.code, r.message], [false, 'card', CARD_TEXT]);
});

test('UK bank details: sort code with an account number, or the words sort code', () => {
  assert.ok(hasBankDetails('20-00-00 55779911'));
  assert.ok(hasBankDetails('sort code 200000'));
  assert.ok(hasBankDetails('Account number 55779911'));
  assert.ok(!hasBankDetails('delivery ref 55779911'));
  assert.ok(!hasBankDetails('see you at 20 00'));
  const r = checkText('pay me: 20 00 00 / 55779911', {});
  assert.deepEqual([r.ok, r.code, r.message], [false, 'bank', BANK_TEXT]);
});

test('messages check the body and every caption; names use the same rules', () => {
  assert.ok(!checkMessage({ body: 'look', captions: ['nice', 'shit'] }, {}).ok);
  assert.ok(checkMessage({ body: 'look', captions: ['nice'] }, {}).ok);
  assert.ok(!checkName('Bitches of Leeds', {}).ok);
  assert.ok(checkName('Leeds bar team', {}).ok);
  assert.ok(checkText('', {}).ok && checkText(null, {}).ok && checkText('   ', {}).ok);
});

test('matchers are cached per setting and the lists are frozen', () => {
  assert.equal(buildMatcher({ level: 'standard', block: ['a', 'b'] }), buildMatcher({ level: 'standard', block: ['b', 'a'] }));
  assert.ok(Object.isFrozen(BUILT_IN) && Object.isFrozen(BUILT_IN.hate));
  assert.equal(findBlocked('', buildMatcher({})), null);
  assert.ok(readings('Sh1t').includes('shit') && readings('Sh1t').includes('shlt'));
});

test('review fix S3: symbols, emoji and invisible characters between letters, 6 for g, digits spelled out', () => {
  for (const t of ['n#igger', 'n=igger', 'n😀igger', 'fa66ot', 'n1663r', 'f 4 g g 0 t', 'f​u​c​k', 'sh­it', 'cu‍nt', 'f́ück', 'fu♥ck']) {
    assert.ok(blocked(t, { level: 'standard' }), JSON.stringify(t));
  }
  assert.equal(checkText('n#igger', { level: 'custom' }).category, 'hate');
  for (const t of ['table 4 and 6 covers', 'call 0 7 7 0 0', 'see you at 6', 'shift 1 of 3', 'tables 6 and 8, then 4']) {
    assert.ok(passes(t, { level: 'strict' }), t);
  }
});

test('review fix S3: the worst case stays fast', () => {
  const nasty = ['f.'.repeat(1990), 'a!'.repeat(1999), ('s' + '​'.repeat(3)).repeat(900), 'n#'.repeat(1990) + 'x'];
  const t0 = Date.now();
  for (const n of nasty) for (const level of ['strict', 'standard']) checkText(n, { level, block: ['secret menu', 'competitor'] });
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});
