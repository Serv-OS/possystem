// src/surfaces/website/blocks/heroSlides.js
// 5.12.10 (Peter, 1 Nov: "build the header as a slider so we can have moving content there"):
// the Hero's own fields are slide 1; props.slides adds more. Pure, shared by the SSR renderer and
// the React Hero so the first paint and the hydrated page agree on which slides exist.

const SECONDS = ['0', '4', '6', '8', '10'];
const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));

/** Slides to paint: [{ photo, headline, sub, label, href }]. Extra slides with no photo and no headline are dropped. */
export function heroSlides(p, { fallbackPhoto = '', fallbackHeadline = '' } = {}) {
  const props = p || {};
  const first = {
    photo: isHttp(props.photo_url) ? String(props.photo_url) : (isHttp(fallbackPhoto) ? String(fallbackPhoto) : ''),
    headline: String(props.headline || fallbackHeadline || ''),
    sub: String(props.sub || ''),
    primary: props.primary && props.primary.label ? props.primary : null,
    secondary: props.secondary && props.secondary.label ? props.secondary : null,
  };
  const more = (Array.isArray(props.slides) ? props.slides : [])
    .filter((s) => s && typeof s === 'object' && (isHttp(s.photo_url) || String(s.headline || '').trim()))
    .slice(0, 9)
    .map((s) => ({
      photo: isHttp(s.photo_url) ? String(s.photo_url) : '',
      headline: String(s.headline || '').trim(),
      sub: String(s.sub || ''),
      primary: s.button_label ? { label: String(s.button_label), href: String(s.button_href || '') } : null,
      secondary: null,
    }));
  return [first, ...more];
}

/** Seconds between slides; 0 = no auto play. Default 6. */
export function slideSeconds(p) {
  const v = String((p && p.slide_seconds) ?? '6');
  return SECONDS.includes(v) ? Number(v) : 6;
}

/** The next slide index, wrapping. */
export const nextSlide = (i, count) => (count > 0 ? (i + 1) % count : 0);
