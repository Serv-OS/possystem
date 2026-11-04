// src/lib/ops/sopRules.js (5.12.62, 4 Nov 2026)
//
// SOPs: the pure rules. Peter: "be able to upload documents like we have, mark as SOPs, then anywhere
// there is an AI chat it can read those SOPs so a staff can ask on the POS what is our SOP for this
// and it tells them exactly."
//
// A document marked as an SOP keeps its words as plain text (ops_documents.sop_text). The assistant's
// search_sops tool reads the venue's SOP texts and hands the best matches to the model, which answers
// in the SOP's own words. Nothing here touches the network; documents.js and sopText.js do that.
//
//   sopReadable(file)        can the words be read out of this file, and how ('text' | 'model')
//   cleanSopText(text)       the stored form: trimmed, blank runs collapsed, capped
//   searchSops(sops, query)  rank the venue's SOPs for a question; the tool result shape

import { fileKind } from './formRules.js';

/** The stored text cap (the column check is 200,000). */
export const SOP_TEXT_MAX = 100000;
/** A PDF or photo is sent to the model as base64; keep it well under the route's limit. */
export const SOP_FILE_MAX_BYTES = 6 * 1024 * 1024;
/** What one matched SOP hands the model, so three matches fit a reply. */
export const SOP_RESULT_CHARS = 8000;
export const SOP_RESULT_LIMIT = 3;

export const SOP_WORDS = {
  box: 'This is an SOP (the AI assistant reads it and answers staff from it)',
  notSetUp: 'SOPs are not set up yet (run 20261122a in the Ops database).',
  noneYet: 'No SOPs are set up at this venue yet. A manager marks a document as an SOP in Back Office, Operations, Documents.',
  reading: 'Reading the words out of the file...',
};

/**
 * Can the assistant read this file? { ok, how, error }.
 *   how 'text'  : a plain text file, read in the browser
 *   how 'model' : a PDF or a photo, the model reads the words out of it (up to 6 MB)
 * Word, spreadsheet and slide files are refused: save them as a PDF first.
 */
export function sopReadable(file) {
  if (!file) return { ok: false, how: null, error: 'Choose a file first.' };
  const kind = fileKind(file.name, file.type);
  if (kind === 'text') return { ok: true, how: 'text', error: null };
  if (kind === 'pdf' || kind === 'image') {
    if ((Number(file.size) || 0) > SOP_FILE_MAX_BYTES) return { ok: false, how: null, error: 'For an SOP keep the file under 6 MB so the assistant can read it. Any file up to 20 MB can still be uploaded as a plain document.' };
    return { ok: true, how: 'model', error: null };
  }
  const word = { word: 'a Word file', sheet: 'a spreadsheet', slides: 'a slide deck' }[kind] || 'this kind of file';
  return { ok: false, how: null, error: `The assistant cannot read ${word}. Save it as a PDF first, or upload it as a plain document (not an SOP).` };
}

/** Trimmed, Windows line ends and runs of blank lines collapsed, capped at SOP_TEXT_MAX. */
export function cleanSopText(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > SOP_TEXT_MAX ? s.slice(0, SOP_TEXT_MAX) : s;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'what', 'whats', 'our', 'we', 'do', 'does', 'how', 'i', 'it', 'this', 'that', 'sop', 'sops', 'procedure', 'policy', 'with', 'at', 'if', 'when', 'my', 'me', 'you', 'be', 'can', 'should']);
const terms = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
const stem = (w) => w.replace(/(ing|ers|er|es|s|ed)$/, '');
const count = (hay, needle) => { if (!needle) return 0; let n = 0, i = 0; for (;;) { i = hay.indexOf(needle, i); if (i < 0) return n; n++; i += needle.length; } };

/**
 * Rank the venue's SOPs for a question. sops = [{ id, title, category, text }]. Returns the tool
 * result: { count, sops: [{ title, category, text, chars, truncated }], titles } where titles lists
 * every live SOP so the model can offer what exists when nothing matches. An empty query lists them all.
 */
export function searchSops(sops, query, { limit = SOP_RESULT_LIMIT, maxChars = SOP_RESULT_CHARS } = {}) {
  const live = (sops || []).filter((s) => s && String(s.text || '').trim());
  const titles = live.map((s) => s.title);
  const q = terms(query).map(stem);
  const scored = live.map((s) => {
    const title = String(s.title || '').toLowerCase();
    const body = String(s.text || '').toLowerCase();
    let score = 0;
    for (const t of q) { score += count(title, t) * 10 + Math.min(count(body, t), 20); }
    return { s, score };
  });
  const picked = (q.length ? scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score) : scored).slice(0, limit);
  const out = picked.map(({ s }) => {
    const text = String(s.text || '');
    const truncated = text.length > maxChars;
    return { title: s.title, category: s.category || null, text: truncated ? text.slice(0, maxChars) : text, chars: text.length, truncated };
  });
  return {
    count: out.length, sops: out, titles,
    note: !live.length ? SOP_WORDS.noneYet : (q.length && !out.length ? `No SOP matches "${String(query || '').trim()}". The SOPs that exist are listed in titles.` : null),
  };
}
