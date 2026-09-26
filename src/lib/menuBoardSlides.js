// src/lib/menuBoardSlides.js
//
// Slideshows on a menu board (v5.9.71, Peter 26 Sep 2026: "make the menu boards show a slide
// show of images"). Two places, one model:
//   MARKETING MODE  board.marketing.slides = [{ id, url, type, seconds }], full screen, one after
//                   another. A board saved before v5.9.71 holds one media (mediaUrl / mediaType);
//                   marketingSlides() plays that as a single slide until slides are saved.
//   IMAGE PANEL     a layout block { type:'image', id, slides, fit, ratio, seconds, span } drawn
//                   among the categories (lib/menuBoardSections.js boardSections), a rotating
//                   picture beside the menu like the promo screen on Coffee Boy's wall.
// The player is surfaces/menuboard/BoardParts.jsx Slideshow, for the TV and the preview.
// Pure, no React, so node:test can load it (menuBoardSlides.test.js).

export const DEFAULT_SLIDE_SECONDS = 8;
export const MAX_SLIDES = 20;
export const MAX_SLIDE_SECONDS = 600;
/** How long a video with no seconds of its own may run before the player moves on anyway. */
export const VIDEO_SAFETY_MS = 120_000;
export const IMAGE_RATIOS = Object.freeze([['16:9', '16 : 9'], ['4:3', '4 : 3'], ['1:1', 'Square'], ['3:4', 'Portrait']]);

const str = (v) => (v == null ? '' : String(v)).trim();

/** 'video' or 'image': a saved type wins, else the file name decides. */
export function slideType(type, url) {
  const t = str(type).toLowerCase();
  if (t === 'video' || t === 'image') return t;
  return /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(str(url)) ? 'video' : 'image';
}

/** The type of a file the operator picked (its MIME type, else its name). */
export function slideTypeOfFile(file) {
  const t = str(file?.type).toLowerCase();
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('image/')) return 'image';
  return slideType(null, file?.name);
}

/**
 * Clean slides: [{ id, url, type, seconds }]. seconds 0 on a video means "play it through" (the
 * player advances on ended, VIDEO_SAFETY_MS as the net). Strings are accepted as urls.
 */
export function normaliseSlides(list, { seconds = DEFAULT_SLIDE_SECONDS } = {}) {
  const dflt = Number(seconds) > 0 ? Math.min(MAX_SLIDE_SECONDS, Number(seconds)) : DEFAULT_SLIDE_SECONDS;
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const url = str(typeof s === 'string' ? s : s?.url);
    if (!url) continue;
    const type = slideType(typeof s === 'string' ? null : s?.type, url);
    const own = Number(typeof s === 'string' ? NaN : s?.seconds);
    const secs = Number.isFinite(own) && own > 0 ? Math.min(MAX_SLIDE_SECONDS, own) : (type === 'video' ? 0 : dflt);
    out.push({ id: str(typeof s === 'string' ? '' : s?.id) || `s-${out.length}`, url, type, seconds: secs });
    if (out.length >= MAX_SLIDES) break;
  }
  return out;
}

/** The slides Marketing mode plays: marketing.slides, else the single media saved before v5.9.71. */
export function marketingSlides(marketing) {
  const m = marketing && typeof marketing === 'object' ? marketing : {};
  const seconds = Number(m.seconds) > 0 ? Number(m.seconds) : DEFAULT_SLIDE_SECONDS;
  const list = normaliseSlides(m.slides, { seconds });
  if (list.length) return list;
  return str(m.mediaUrl) ? normaliseSlides([{ id: 'legacy', url: m.mediaUrl, type: m.mediaType }], { seconds }) : [];
}

/** ms a slide stays before the player moves on (a video with 0 seconds: the safety net). */
export function slideHoldMs(slide, fallbackSeconds = DEFAULT_SLIDE_SECONDS) {
  const s = Number(slide?.seconds);
  if (Number.isFinite(s) && s > 0) return Math.round(Math.min(MAX_SLIDE_SECONDS, s) * 1000);
  if (slide?.type === 'video') return VIDEO_SAFETY_MS;
  const f = Number(fallbackSeconds) > 0 ? Number(fallbackSeconds) : DEFAULT_SLIDE_SECONDS;
  return Math.round(f * 1000);
}

export const nextSlideIndex = (i, n) => (n > 0 ? ((Number(i) || 0) + 1) % n : 0);

/** CSS aspect-ratio for a panel shape ('16:9' → '16 / 9'); 16:9 when unknown. */
export function ratioCss(ratio) {
  const m = /^(\d+):(\d+)$/.exec(str(ratio));
  return m && Number(m[2]) > 0 ? `${m[1]} / ${m[2]}` : '16 / 9';
}

export const isImageBlock = (b) => !!b && b.type === 'image';

export function newImageBlock() {
  return { type: 'image', id: `image-${Math.random().toString(36).slice(2, 8)}`, slides: [], fit: 'cover', ratio: '16:9', seconds: DEFAULT_SLIDE_SECONDS, span: 1 };
}

// ── slide list edits, all pure ──────────────────────────────────────────────
export function addSlides(list, added) {
  const cur = normaliseSlides(list);
  const out = [...cur];
  for (const a of Array.isArray(added) ? added : []) {
    const url = str(typeof a === 'string' ? a : a?.url);
    if (!url || out.length >= MAX_SLIDES) continue;
    const type = slideType(typeof a === 'string' ? null : a?.type, url);
    out.push({ id: `s-${Date.now().toString(36)}-${out.length}`, url, type, seconds: type === 'video' ? 0 : (cur[0]?.seconds || DEFAULT_SLIDE_SECONDS) });
  }
  return out;
}
export function moveSlide(list, index, dir) {
  const out = normaliseSlides(list);
  const j = index + (dir < 0 ? -1 : 1);
  if (index < 0 || index >= out.length || j < 0 || j >= out.length) return out;
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}
export function removeSlide(list, id) {
  return normaliseSlides(list).filter(s => s.id !== id);
}
export function setSlideSeconds(list, id, seconds) {
  const n = Number(seconds);
  return normaliseSlides(list).map(s => (s.id === id ? { ...s, seconds: Number.isFinite(n) && n > 0 ? Math.min(MAX_SLIDE_SECONDS, n) : (s.type === 'video' ? 0 : DEFAULT_SLIDE_SECONDS) } : s));
}
