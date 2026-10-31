// src/lib/website/validatePatch.js
//
// WEBSITE BUILDER (v5.12.0): validate a designer patch or a page layout against the block
// registry schema. Plain JS, no JSX, so api/website-designer.js (Node) and the Back Office both
// import it. The rules themselves live in supabase/functions/_shared/websiteRules.js so the
// website-admin edge function refuses exactly the same things (contract section 10 limits:
// layout <= 400 KB, <= 60 pages, <= 500 posts, strings <= 20 KB, slugs [a-z0-9-]{1,60}).
//
// IMPORT CONTRACT with the block registry (owned by agent B, src/surfaces/website/blocks/schema.js):
//
//   export const BLOCK_SCHEMAS = {
//     [type]: { props: { [name]: { type: 'string'|'text'|'href'|'number'|'boolean'|'enum'|'array'|'object',
//                                  enum?: [...] (schema.js spells it options), required?: boolean,
//                                  max?: number, min?: number, item?: rule, fields?: {...}, default? } } },
//   };
//   export const BLOCK_TYPES = Object.keys(BLOCK_SCHEMAS);
//
// This file does NOT import schema.js itself: the browser bundle targets Chrome 80 (no top level
// await) and the module may not exist on a branch yet. Pass it in, or register it once:
//
//   import { BLOCK_SCHEMAS } from '../../surfaces/website/blocks/schema.js';
//   import { setDefaultSchemas, validatePatch } from '../../lib/website/validatePatch.js';
//   setDefaultSchemas(BLOCK_SCHEMAS);           // once, at module load
//   const { ok, errors, clean } = validatePatch(patch, { allowCustomCode: false });
//
// Without a schema the block TYPES are still checked against the contract list (section 6) and
// props are checked for shape and size only. With a schema every prop is checked and unknown
// props are refused.

import {
  validateAiPatch, validateLayout as validateLayoutRules, validatePagePatch, validatePostPatch, validateSitePatch,
  siteSlugProblem, pageSlugProblem, postSlugProblem, slugify,
  LIMITS, RESERVED_SITE_SLUGS, RESERVED_PAGE_SLUGS, CONTRACT_BLOCK_TYPES, PAGE_KINDS, SITE_PATCH_KEYS,
} from '../../../supabase/functions/_shared/websiteRules.js';
import { buildSnapshot, snapshotPaths, publicLocation } from '../../../supabase/functions/_shared/websiteSnapshot.js';

let DEFAULT_SCHEMAS = null;

/** Register BLOCK_SCHEMAS once so later calls need not pass it. null clears it. */
export function setDefaultSchemas(schemas) {
  DEFAULT_SCHEMAS = schemas && typeof schemas === 'object' && !Array.isArray(schemas) ? schemas : null;
}

/** The schemas in force: the argument, else the registered default, else null (contract list only). */
export function activeSchemas(schemas) {
  return schemas === undefined ? DEFAULT_SCHEMAS : schemas;
}

/** The block types a patch may use, from the schemas in force. */
export function knownBlockTypes(schemas) {
  const s = activeSchemas(schemas);
  return s ? Object.keys(s) : [...CONTRACT_BLOCK_TYPES];
}

/**
 * Validate a designer patch (contract section 11 shape). Returns { ok, errors, clean }.
 *   schemas          BLOCK_SCHEMAS (optional when registered)
 *   allowCustomCode  the site's settings.allow_custom_code (CustomHtml is refused otherwise)
 *   existingPageCount / existingPostCount   so the 60 page and 500 post caps count what is there
 */
export function validatePatch(patch, { schemas, allowCustomCode = false, existingPageCount = 0, existingPostCount = 0 } = {}) {
  return validateAiPatch(patch, { schemas: activeSchemas(schemas), allowCustomCode, existingPageCount, existingPostCount });
}

/** Validate one page layout (Puck data). Returns { ok, errors }. */
export function validateLayout(layout, { schemas, allowCustomCode = false } = {}) {
  return validateLayoutRules(layout, { schemas: activeSchemas(schemas), allowCustomCode });
}

/** The save_page patch, as the edge function checks it. */
export function validatePage(patch, { schemas, allowCustomCode = false, existingKind = 'custom', isNew = false } = {}) {
  return validatePagePatch(patch, { schemas: activeSchemas(schemas), allowCustomCode, existingKind, isNew });
}

export {
  validateSitePatch, validatePostPatch, siteSlugProblem, pageSlugProblem, postSlugProblem, slugify,
  LIMITS, RESERVED_SITE_SLUGS, RESERVED_PAGE_SLUGS, CONTRACT_BLOCK_TYPES, PAGE_KINDS, SITE_PATCH_KEYS,
  buildSnapshot, snapshotPaths, publicLocation,
};
