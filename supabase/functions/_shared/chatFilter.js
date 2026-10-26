// supabase/functions/_shared/chatFilter.js
// MARKER 5.11.102 team chat word filter
//
// The team chat word filter (5.11.102). Pure JavaScript, no imports: the team-chat edge function
// runs it on every message, photo caption, group name, group description and profile name before
// anything is stored, and src/lib/chatFilter.test.js proves it.
//
// THE RULE (Peter, 26 Oct 2026): a blocked word refuses the message. The sender is told
// BLOCKED_WORD_TEXT and their text stays in the box. Nothing is sent, nothing is stored.
//
// LEVELS (chat_settings.filter_level):
//   strict    hate + strong + mild built in words
//   standard  hate + strong (the default)
//   custom    hate only, plus the company's own block list
// Slurs and hate words are ALWAYS blocked, at every level, and the company allow list cannot let
// them through. The company block list applies at every level; the allow list switches off a
// built in strong or mild word (a pub called The Cock, a dish called spotted dick).
//
// TRICKS it sees through: capitals, accents, look alike letters from other alphabets (Cyrillic,
// Greek, full width), numbers and symbols for letters inside a word (sh1t, a$$, f@g), dots, dashes
// and spaces between letters (f.u.c.k, f u c k), and stretched letters (fuuuuck). A number on its
// own is never read as letters (table 455 is not a swear word).
//
// MONEY GUARDS: a card number (15 or 16 digits passing the Luhn check, spaces or dashes allowed)
// and UK bank details (a sort code with an 8 digit account number, or the words sort code with
// either) are refused too, whatever the level: chat is not a safe place for them.

export const BLOCKED_WORD_TEXT = 'This message has a word your team does not allow.';
export const CARD_TEXT = 'Card numbers cannot be sent in chat.';
export const BANK_TEXT = 'Bank details cannot be sent in chat.';

// Built in lists, English and Spanish. A trailing * matches the word and anything after it
// (fuck*: fucking, fucker); a leading * anything before it too (*fuck*: motherfucker). Without a
// star the whole word must match, so class, assess and Scunthorpe pass.
export const BUILT_IN = Object.freeze({
  hate: Object.freeze([
    // English
    'nigger*', 'nigga*', 'niggah', 'faggot*', 'faggy', 'retard', 'retards', 'retarded', 'spic', 'spics', 'kike', 'kikes',
    'chink', 'chinks', 'gook', 'gooks', 'paki', 'pakis', 'wetback*', 'tranny', 'trannies', 'dyke', 'dykes', 'coon', 'coons',
    'raghead*', 'towelhead*', 'gyppo*', 'gypo', 'pikey*', 'sambo', 'jigaboo*', 'beaner*', 'spastic', 'spaz', 'mong', 'mongs',
    'golliwog*', 'shemale*', 'heeb', 'zipperhead*',
    // Spanish
    'maricon*', 'maricón*', 'marica', 'maricas', 'sudaca*', 'negrata*', 'mongolo', 'mongola', 'subnormal*', 'bollera*', 'machorra*', 'travelo*',
  ]),
  strong: Object.freeze([
    // English
    '*fuck*', 'fck', 'fcking', 'fuk', 'fuking', 'cunt*', 'twat*', 'wanker*', 'wank', 'wanking', 'motherf*', 'shit', 'shits', 'shitty',
    'shite', 'bullshit', 'shithead*', 'shitbag*', 'bitch*', 'whore*', 'slut*', 'cock', 'cocks', 'cocksucker*', 'pussy', 'pussies',
    'asshole*', 'arsehole*', 'dickhead*', 'bellend*', 'nonce', 'nonces', 'knobhead*', 'skank*', 'jizz*', 'tosser*',
    // Spanish
    'puta', 'putas', 'putita', 'puto', 'putos', 'mierda*', 'coño', 'joder', 'jodete', 'jódete', 'gilipollas', 'cabron*', 'cabrón*', 'pendej*', 'chinga*',
    'verga*', 'culero*', 'zorra*', 'polla', 'pollas', 'hostia*', 'malparid*', 'hijueputa*', 'mamaguevo*', 'concha tu madre',
    // UK slang that is also a slur in the US: a company can allow it (a fag break)
    'fag', 'fags',
  ]),
  mild: Object.freeze([
    // English
    'ass', 'arse', 'arses', 'damn', 'dammit', 'crap', 'crappy', 'piss', 'pissed', 'pissing', 'bastard*', 'bollocks', 'bugger*',
    'bloody', 'dick', 'dicks', 'prick', 'pricks', 'knob', 'tits', 'titties', 'boobs', 'sod', 'git', 'minger', 'slag', 'slags', 'douche*',
    // Spanish
    'culo', 'culos', 'carajo', 'cojones', 'mamón', 'mamon', 'pinche', 'tonto', 'tonta', 'idiota', 'imbecil', 'imbécil',
    'capullo', 'pringado', 'cabrona',
  ]),
});

// Look alike letters from other alphabets, to their Latin twin.
const LOOKALIKE = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
  'і': 'i', 'ї': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ɡ': 'g', 'ӏ': 'l', 'ц': 'u', 'п': 'n', 'г': 'r', 'ь': 'b',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'μ': 'u', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
  'ς': 's', 'σ': 's', 'ω': 'w',
  // Others that slip through NFKD
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe',
};

// Numbers and symbols that stand for letters inside a word. Two readings of 1 and | (i and l).
const LEET_I = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'i', '€': 'e', '£': 'l', '+': 't' };
const LEET_L = { ...LEET_I, '1': 'l', '|': 'l', '!': 'i' };

const LETTER = 'a-z\\u00f1';
const SEP = '[\\s._\\-*,\'"`~^:;/\\\\]*';

/** Lower case, accents off (ñ kept: coño is not cono), look alikes mapped. */
function fold(text) {
  let s = String(text || '').normalize('NFKC').toLowerCase();
  // Keep ñ through the accent strip.
  s = s.replace(/ñ/g, '\uE000');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/\uE000/g, 'ñ');
  let out = '';
  for (const ch of s) out += LOOKALIKE[ch] ?? ch;
  return out;
}

/** Numbers and symbols read as letters, only inside a token that also has a letter in it. */
function deLeet(text, map) {
  return text.replace(/\S+/g, (tok) => {
    if (!/[a-zñ]/.test(tok)) return tok;
    let out = '';
    for (const ch of tok) out += map[ch] ?? ch;
    return out;
  });
}

/** The readings of a text that the word patterns run over (folded; with 1 as i; with 1 as l). */
export function readings(text) {
  const f = fold(text);
  const a = deLeet(f, LEET_I);
  const b = deLeet(f, LEET_L);
  return [...new Set([f, a, b])];
}

/** A list word (or phrase) to a pattern: each letter may repeat, separators may sit between letters. */
function termPattern(term) {
  let t = fold(String(term || '').trim());
  if (!t) return null;
  const lead = t.startsWith('*');
  const trail = t.endsWith('*');
  t = t.replace(/^\*+|\*+$/g, '');
  if (!t) return null;
  const parts = [];
  for (const ch of t) {
    if (ch === '*') { parts.push(`[${LETTER}]*`); continue; }
    if (/\s/.test(ch)) { parts.push(SEP); continue; }
    const esc = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    parts.push(`${esc}+`);
  }
  // Collapse runs of separators produced by spaces in a phrase.
  let body = '';
  for (let i = 0; i < parts.length; i++) {
    body += parts[i];
    const next = parts[i + 1];
    if (next && parts[i] !== SEP && next !== SEP && !parts[i].startsWith('[') && !next.startsWith('[')) body += SEP;
  }
  const before = lead ? '' : `(?<![${LETTER}])`;
  const after = trail ? '' : `(?![${LETTER}])`;
  return `${before}${body}${after}`;
}

const matcherCache = new Map();

/**
 * The matcher for one company's setting: { level, block, allow }.
 * Returns { hate: RegExp|null, other: RegExp|null, terms: { hate:[], other:[] } }.
 */
export function buildMatcher({ level = 'standard', block = [], allow = [] } = {}) {
  const lvl = ['strict', 'standard', 'custom'].includes(level) ? level : 'standard';
  const key = JSON.stringify([lvl, [...block].sort(), [...allow].sort()]);
  const cached = matcherCache.get(key);
  if (cached) return cached;
  const allowSet = new Set((allow || []).map((w) => fold(String(w).trim()).replace(/\*/g, '')).filter(Boolean));
  const hateTerms = [...BUILT_IN.hate];
  let otherTerms = [];
  if (lvl === 'strict') otherTerms = [...BUILT_IN.strong, ...BUILT_IN.mild];
  else if (lvl === 'standard') otherTerms = [...BUILT_IN.strong];
  otherTerms = otherTerms.filter((t) => !allowSet.has(fold(t).replace(/\*/g, '')));
  for (const w of block || []) {
    const s = String(w || '').trim();
    if (s && s.length <= 80) otherTerms.push(s.replace(/\*/g, ''));
  }
  const compile = (terms) => {
    const pats = terms.map(termPattern).filter(Boolean);
    return pats.length ? new RegExp(pats.map((p) => `(?:${p})`).join('|'), 'u') : null;
  };
  const m = { hate: compile(hateTerms), other: compile(otherTerms) };
  if (matcherCache.size > 200) matcherCache.clear();
  matcherCache.set(key, m);
  return m;
}

/** The first blocked word in a text, or null. { category: 'hate'|'word', match }. */
export function findBlocked(text, matcher) {
  if (!text) return null;
  for (const r of readings(text)) {
    const h = matcher.hate && matcher.hate.exec(r);
    if (h) return { category: 'hate', match: h[0] };
    const o = matcher.other && matcher.other.exec(r);
    if (o) return { category: 'word', match: o[0] };
  }
  return null;
}

/** The Luhn check on a string of digits. */
export function luhnOk(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length < 12) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** A card number in the text? 15 or 16 digits (spaces or dashes allowed) passing Luhn. */
export function hasCardNumber(text) {
  const s = String(text || '');
  const re = /(?<![\d])(?:\d[ -]?){14,15}\d(?![\d])/g;
  let m;
  while ((m = re.exec(s))) {
    const d = m[0].replace(/\D/g, '');
    if ((d.length === 15 || d.length === 16) && luhnOk(d) && !/^(\d)\1+$/.test(d)) return true;
  }
  return false;
}

/** UK bank details in the text? A sort code with an 8 digit account, or the words sort code with either. */
export function hasBankDetails(text) {
  const s = String(text || '');
  const sort = /(?<![\d])\d{2}[- ]\d{2}[- ]\d{2}(?![\d])|(?<![\d])\d{6}(?![\d])/.test(s);
  const account = /(?<![\d])\d{8}(?![\d])/.test(s.replace(/(?<![\d])\d{2}[- ]\d{2}[- ]\d{2}(?![\d])/g, ' '));
  const words = /sort\s*-?\s*code|account\s*(no|number|num)\b/i.test(s);
  return (sort && account) || (words && (sort || account));
}

/**
 * Check one text. opts: { level, block, allow } (the company's setting and lists).
 * Returns { ok: true } or { ok: false, code: 'word'|'card'|'bank', message, category?, match? }.
 */
export function checkText(text, opts = {}) {
  const s = String(text ?? '');
  if (!s.trim()) return { ok: true };
  if (hasCardNumber(s)) return { ok: false, code: 'card', message: CARD_TEXT };
  if (hasBankDetails(s)) return { ok: false, code: 'bank', message: BANK_TEXT };
  const hit = findBlocked(s, buildMatcher(opts));
  if (hit) return { ok: false, code: 'word', message: BLOCKED_WORD_TEXT, category: hit.category, match: hit.match };
  return { ok: true };
}

/** A message: its body and every photo caption. */
export function checkMessage({ body = '', captions = [] } = {}, opts = {}) {
  for (const t of [body, ...(captions || [])]) {
    const r = checkText(t, opts);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** A name (group name, group description, profile name). Same rules. */
export function checkName(name, opts = {}) {
  return checkText(name, opts);
}
