// productImage.js — what picture a product shows when it has none of its own.
//
// Peter, 23 Sep 2026: "if an image is not uploaded to the product can we
// globally set the logo from appearance to be the default product image".
//
// The Appearance page owns the logo (online_branding.logo_url on the Platform
// venue row). Every customer-facing surface reads the OPS venue row, not that
// one, so the choice is mirrored into ops locations.pos_settings.default_product_image
// as a plain URL when Appearance is saved. Each surface then asks this one
// function instead of reaching for item.image on its own.
//
// The Back Office item editor keeps showing the product's OWN image (or "no
// image"), never the fallback: an operator must be able to see which products
// still need a photo.
//
// Pure, so node:test can load it.

/** The image to draw for a product: its own, else the venue default, else nothing. */
export function productImage(item, defaultUrl) {
  const own = item && item.image;
  if (own) return own;
  return defaultUrl || null;
}

/** True when the picture on screen is the venue default, not the product's own. */
export function isDefaultImage(item, defaultUrl) {
  return !!defaultUrl && !(item && item.image);
}

/**
 * The venue default from ops locations.pos_settings, or null. Only an https
 * URL is honoured: this value ends up in <img src> on customer devices.
 */
export function resolveDefaultProductImage(posSettings) {
  const v = posSettings && posSettings.default_product_image;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^https:\/\/\S+$/i.test(s) ? s : null;
}
