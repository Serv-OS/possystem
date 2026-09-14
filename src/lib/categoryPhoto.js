/**
 * categoryPhoto.js: category tile photos (Back Office upload, kiosk rail tile).
 *
 * Pure: NO imports, so node:test can load it (categoryPhoto.test.js).
 *
 * Column: menu_categories.image text (migration 20260914_OPS_category_photos.sql,
 * run by hand on Ops). The app must work before that runs, so:
 *   - categoryImageField(cat) is THE "write only when present" rule. Every
 *     category writer spreads it, and it gives {} for a missing key, null, '' or
 *     a bad URL. A stale tab can therefore never clear a photo through a normal
 *     category save or a Push. Only saveCategoryImage (db.js) clears one.
 *   - railTileMode keeps today's text tiles unless the profile switch is on AND at
 *     least one category really has a photo, so a venue with no photos (every venue
 *     before the migration) sees exactly today's kiosk.
 *
 * The URL rule here (CATEGORY_PHOTO_URL_PATTERN) is the same as the
 * menu_categories_image_shape check in the migration, so a valid category save can
 * never be rejected by the database.
 */

export const CATEGORY_PHOTO_MAX_URL = 2048;
export const CATEGORY_PHOTO_MIN = Object.freeze({ w: 572, h: 208 });
// Below this width to height ratio only a thin middle strip shows in the kiosk tile.
export const CATEGORY_PHOTO_MIN_RATIO = 1.5;
export const PHOTO_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;   // the product-images bucket limit
export const DEFAULT_BRAND_HEX = '#f97316';        // KioskApp brandColor fallback

// The ONLY URL shape a category photo may have: a public product-images object in a venue's
// categories folder, named by categoryPhotoPath. The SAME pattern is the menu_categories_image_shape
// check in 20260914_OPS_category_photos.sql (categoryPhotoSql.test.js compares them). It stops a
// pointer to another host, or to an unfenced item photo path, from ever showing on a kiosk.
export const CATEGORY_PHOTO_URL_PATTERN =
  '^https://[^/?#]+/storage/v1/object/public/product-images/[^/?#]+/categories/[A-Za-z0-9_-]+-[0-9]+\\.(jpg|png|webp)$';
const CATEGORY_PHOTO_URL_RE = new RegExp(CATEGORY_PHOTO_URL_PATTERN);

export const CATEGORY_PHOTO_COPY = Object.freeze({
  title: 'Kiosk photo',
  help: "Shows on this category's tile on the kiosk. Best size is 572 by 208 pixels or larger.",
  crop: 'Keep the main subject in the middle because the kiosk trims the sides.',
  savesNow: 'Photos save as soon as they upload, so Cancel does not undo them.',
  upload: 'Upload photo',
  types: 'JPG, PNG or WebP, up to 5MB.',
  uploading: 'Uploading photo…',
  replace: 'Replace photo',
  remove: 'Remove photo',
  confirmRemove: 'Remove this photo from the category?',
  confirmRemoveShared: 'Remove this photo here and at your other venues that use it?',
  sizeWarning: (w, h) => `This photo is ${w} by ${h} pixels, so it may look blurry. Use 572 by 208 or larger.`,
  tallWarning: 'This photo is tall, so only the middle strip shows on the kiosk.',
  shared: 'This category is shared. Venues without their own photo will show this one too.',
  notReady: 'Category photos need a database update before you can add them.',
  saved: 'Photo saved. Refresh the kiosk to see it.',
  removed: 'Photo removed. Refresh the kiosk to see the change.',
  peersFailedSaved: 'Photo saved here, but not at your other venues. Try again.',
  peersFailedRemoved: 'Photo removed here, but not at your other venues. Try again.',
  badType: 'Please choose a JPG, PNG or WebP photo.',
  tooBig: 'This photo is over 5MB. Please choose a smaller one.',
  noVenue: 'We could not find your venue. Please refresh and try again.',
  uploadFailed: 'The photo did not upload. Check your connection and try again.',
  saveFailed: 'The photo was not saved. Check you are signed in and try again.',
  removeFailed: 'The photo was not removed. Check you are signed in and try again.',
  editCategory: 'Edit category and photo',
  addPhoto: 'Add photo',
  editPhoto: 'Edit photo',
  switchTitle: 'Show category photos',
  switchDesc: 'Add photos in Back Office, Menu, by editing each category. Tiles without a photo show your brand colour.',
  switchOffNote: 'Turn this off for plain text tiles. If no category has a photo, tiles stay as text.',
  switchShared: 'This applies to every kiosk that uses this profile.',
  switchNotReady: 'Category photos need a database update before this switch appears.',
});

/**
 * The category's photo URL when it has the category photo shape, otherwise null.
 * origin (optional, e.g. the app's Supabase URL): the URL must also be on that origin.
 * The kiosk passes it, so a pointer to any other host is never shown to customers.
 */
export function categoryPhotoUrl(cat, origin = null) {
  const raw = cat?.image;
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (url.length > CATEGORY_PHOTO_MAX_URL || !CATEGORY_PHOTO_URL_RE.test(url)) return null;
  if (origin) {
    const o = String(origin).trim().replace(/\/+$/, '');
    if (!o || !url.startsWith(`${o}/`)) return null;
  }
  return url;
}

/** Spread into a menu_categories write: { image } only when a real photo is present. */
export function categoryImageField(cat) {
  const url = categoryPhotoUrl(cat);
  return url ? { image: url } : {};
}

/**
 * True when a Supabase error means menu_categories.image does not exist (the migration has
 * not run, or was rolled back): PGRST204 from PostgREST or 42703 from Postgres, naming image.
 */
export function isMissingImageColumn(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  if (!/\bimage\b/i.test(msg)) return false;
  return code === 'PGRST204' || code === '42703' || /column/i.test(msg);
}

function hexOrNull(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase();
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return `#${m[1]}`.toLowerCase();
  return null;
}

/** A safe #rrggbb from free text brand colour input, or the (normalised) fallback. */
export function safeBrandHex(input, fallback = DEFAULT_BRAND_HEX) {
  return hexOrNull(input) || hexOrNull(fallback) || DEFAULT_BRAND_HEX;
}

/**
 * A brand colour that is safe to put in a style: a hex (normalised), a named colour, or an
 * rgb()/hsl() value. Anything else (url(), expressions, junk) gives null. The kiosk colour
 * box is free text, so 'red' or 'rgb(21,194,106)' must colour photo tiles like text tiles.
 */
export function safeCssColor(input) {
  const hex = hexOrNull(input);
  if (hex) return hex;
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^[a-z]{3,20}$/i.test(s)) return s.toLowerCase();
  if (/^(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/+-]+\)$/i.test(s)) return s;
  return null;
}

/** The active tile border colour. */
export function tileAccentColor(brandColor) {
  return safeCssColor(brandColor) || DEFAULT_BRAND_HEX;
}

/** The brand colour block that sits in the photo slot (decision 2). */
export function photoBlockBackground(brandColor) {
  const hex = hexOrNull(brandColor);
  if (hex) return `linear-gradient(135deg, ${hex}, ${hex}99)`;
  const raw = safeCssColor(brandColor);
  if (raw) return raw;   // named or rgb() colour: a solid block, the same colour as text tiles
  return `linear-gradient(135deg, ${DEFAULT_BRAND_HEX}, ${DEFAULT_BRAND_HEX}99)`;
}

/**
 * 'photo' or 'text' for the whole rail. switchValue is the profile's
 * kiosk_category_photos (undefined before the migration, read as on).
 * Pass EVERY venue category (not just the current menu's), so the rail does not flip
 * between text and photo tiles when a timed menu changes during the day.
 */
export function railTileMode(switchValue, categories, origin = null) {
  if (switchValue === false) return 'text';
  const list = Array.isArray(categories) ? categories : [];
  return list.some(c => categoryPhotoUrl(c, origin)) ? 'photo' : 'text';
}

/** What goes in one tile's photo slot, or null for a text tile. */
export function tileSlot(cat, mode, brandColor, origin = null) {
  if (mode !== 'photo') return null;
  return { url: categoryPhotoUrl(cat, origin), background: photoBlockBackground(brandColor) };
}

/** 'type' | 'size' | null for a chosen file. */
export function checkPhotoFile(file) {
  if (!file || !Object.prototype.hasOwnProperty.call(PHOTO_TYPES, file.type)) return 'type';
  if (!(Number(file.size) <= PHOTO_MAX_BYTES)) return 'size';
  return null;
}

/**
 * A warning (never a block) when the photo is smaller than 572 by 208, or so tall that the
 * kiosk tile only shows a thin middle strip of it. null when the size is unknown.
 */
export function photoSizeWarning(w, h) {
  const okNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!okNum(w) || !okNum(h)) return null;
  const notes = [];
  if (w < CATEGORY_PHOTO_MIN.w || h < CATEGORY_PHOTO_MIN.h) notes.push(CATEGORY_PHOTO_COPY.sizeWarning(w, h));
  if (w / h < CATEGORY_PHOTO_MIN_RATIO) notes.push(CATEGORY_PHOTO_COPY.tallWarning);
  return notes.length ? notes.join(' ') : null;
}

/**
 * Storage path <loc>/categories/<catId>-<now>.<ext> in product-images.
 * The first two segments are what the cat_photo storage fence checks. Every upload
 * gets a new name, so an older URL still held by another venue or tab keeps working.
 */
export function categoryPhotoPath(locId, catId, mime, now) {
  const ext = PHOTO_TYPES[mime];
  if (!ext) return null;
  if (typeof locId !== 'string' || !locId || locId === 'loc-demo' || locId.includes('/')) return null;
  const safeId = String(catId ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'category';
  const stamp = Number.isFinite(Number(now)) ? Math.trunc(Number(now)) : 0;
  return `${locId}/categories/${safeId}-${stamp}.${ext}`;
}

/**
 * Ids of peer rows (same master_id at other venues) to move with this change.
 * Upload: peers with no photo, or still on the previous photo.
 * Remove: only peers still on the previous photo.
 * A peer's own different photo is never touched.
 */
export function peerPhotoTargets(peers, prevUrl, nextUrl) {
  const list = Array.isArray(peers) ? peers : [];
  const prev = prevUrl || null;
  const next = nextUrl || null;
  const cur = (p) => (typeof p?.image === 'string' && p.image.trim() ? p.image.trim() : null);
  if (next) {
    return list.filter(p => p?.id && cur(p) !== next && (cur(p) === null || (prev && cur(p) === prev))).map(p => p.id);
  }
  if (!prev) return [];
  return list.filter(p => p?.id && cur(p) === prev).map(p => p.id);
}
