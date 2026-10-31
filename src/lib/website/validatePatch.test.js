// node --test: the website builder validator (contract section 13 A). The designer sample patch
// is accepted; unknown block types, bad slugs, reserved slugs and oversized layouts are refused
// with a plain reason. The block schema module (agent B) may not exist here, so a fixture schema
// is injected where prop checks are tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validatePatch, validateLayout, validatePage, validateSitePatch, validatePostPatch, setDefaultSchemas, knownBlockTypes,
  siteSlugProblem, pageSlugProblem, slugify, LIMITS, RESERVED_SITE_SLUGS, CONTRACT_BLOCK_TYPES,
} from './validatePatch.js';

const SAMPLE = JSON.parse(fs.readFileSync(new URL('./fixtures/snapshot.sample.json', import.meta.url), 'utf8'));
const sample = SAMPLE;

/** The designer's patch, built from the sample snapshot (contract section 11 shape). */
function samplePatch() {
  const sample = structuredClone(SAMPLE);   // tests mutate their patch, the fixture stays clean
  return {
    reply: 'I built eight pages from your venue facts and picked Ember because most items have photos.',
    theme: sample.site.theme,
    nav: sample.site.nav,
    footer: sample.site.footer,
    seo: sample.site.seo,
    pages: sample.pages.map((p) => ({ slug: p.slug, title: p.title, kind: p.kind, seo: p.seo, layout: p.layout, location_id: p.location_id })),
    posts: sample.posts.map((p) => ({ slug: p.slug, title: p.title, excerpt: p.excerpt, body_md: p.body_md, tags: p.tags })),
  };
}

// A fixture schema in the import contract shape (BLOCK_SCHEMAS).
const FIXTURE_SCHEMAS = {
  Hero: { props: { headline: { type: 'string', required: true, max: 120 }, sub: { type: 'string', max: 300 }, photo_url: { type: 'string' }, show_status: { type: 'boolean' }, primary: { type: 'object' }, secondary: { type: 'object' }, height: { type: 'enum', enum: ['tall', 'short'] } } },
  Text: { props: { md: { type: 'string', required: true } } },
  Gallery: { props: { photos: { type: 'array', max: 3 }, cols: { type: 'number', max: 4 } } },
};

test('accepts the designer sample patch (contract list only, no schema)', () => {
  const r = validatePatch(samplePatch());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.clean.pages.length, sample.pages.length);
});

test('every block type in the sample is on the contract list', () => {
  for (const p of sample.pages) for (const b of p.layout.content) assert.ok(CONTRACT_BLOCK_TYPES.includes(b.type), b.type);
  assert.deepEqual(knownBlockTypes(), [...CONTRACT_BLOCK_TYPES]);
});

test('refuses an unknown block type, by name', () => {
  const patch = samplePatch();
  patch.pages[0].layout.content.push({ type: 'Carousel', props: { id: 'x' } });
  const r = validatePatch(patch);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('unknown block type "Carousel"')), r.errors.join('\n'));
});

test('refuses a patch key the contract does not name', () => {
  const r = validatePatch({ reply: 'hi', custom_head_html: '<script>' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /no key called "custom_head_html"/);
});

test('refuses bad page slugs and keeps the home page as the empty slug', () => {
  assert.equal(pageSlugProblem('', 'home'), '');
  assert.notEqual(pageSlugProblem('', 'custom'), '');
  assert.notEqual(pageSlugProblem('Menu', 'menu'), '');
  assert.notEqual(pageSlugProblem('a'.repeat(61), 'custom'), '');
  assert.notEqual(pageSlugProblem('blog', 'custom'), '');   // the server owns /blog
  assert.equal(pageSlugProblem('blog', 'blog'), '');         // except for the blog kind page itself
  assert.notEqual(pageSlugProblem('locations', 'custom'), '');
  const patch = samplePatch();
  patch.pages[1].slug = 'Our Menu';
  const r = validatePatch(patch);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /Page address must be/.test(e)));
});

test('refuses reserved and malformed site slugs', () => {
  for (const s of RESERVED_SITE_SLUGS) assert.match(siteSlugProblem(s), /reserved/, s);
  assert.notEqual(siteSlugProblem('ab'), '');
  assert.notEqual(siteSlugProblem('-mozz'), '');
  assert.notEqual(siteSlugProblem('Mozz'), '');
  assert.notEqual(siteSlugProblem('a'.repeat(41)), '');
  assert.equal(siteSlugProblem('mozz'), '');
  assert.equal(siteSlugProblem('mozz-pizza-2'), '');
  const r = validateSitePatch({ slug: 'admin' });
  assert.equal(r.ok, false);
});

test('refuses an oversized layout (over 400 KB)', () => {
  const big = { root: { props: {} }, content: [{ type: 'Text', props: { id: 't', md: 'x'.repeat(LIMITS.LAYOUT_MAX_BYTES + 10) } }] };
  const r = validateLayout(big);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /limit is 400 KB/.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /longer than 20 KB/.test(e)));
});

test('refuses more than 60 pages and more than 500 posts', () => {
  const pages = Array.from({ length: 61 }, (_, i) => ({ slug: `p-${i}`, title: `P ${i}`, kind: 'custom', layout: { root: { props: {} }, content: [] } }));
  assert.ok(validatePatch({ pages }).errors.some((e) => /at most 60 pages/.test(e)));
  assert.ok(validatePatch({ pages: pages.slice(0, 10) }, { existingPageCount: 55 }).errors.some((e) => /at most 60 pages/.test(e)));
  const posts = Array.from({ length: 3 }, (_, i) => ({ slug: `post-${i}`, title: `Post ${i}`, body_md: 'hello' }));
  assert.ok(validatePatch({ posts }, { existingPostCount: 499 }).errors.some((e) => /at most 500 posts/.test(e)));
});

test('refuses CustomHtml unless the site allows custom code', () => {
  const layout = { root: { props: {} }, content: [{ type: 'CustomHtml', props: { id: 'c', html: '<b>hi</b>' } }] };
  assert.equal(validateLayout(layout).ok, false);
  assert.equal(validateLayout(layout, { allowCustomCode: true }).ok, true);
});

test('one Hero per page, unique block ids, props.id required', () => {
  const two = { root: { props: {} }, content: [{ type: 'Hero', props: { id: 'a' } }, { type: 'Hero', props: { id: 'b' } }] };
  assert.ok(validateLayout(two).errors.some((e) => /one Hero/.test(e)));
  const dup = { root: { props: {} }, content: [{ type: 'Text', props: { id: 'a' } }, { type: 'Text', props: { id: 'a' } }] };
  assert.ok(validateLayout(dup).errors.some((e) => /used twice/.test(e)));
  const noId = { root: { props: {} }, content: [{ type: 'Text', props: {} }] };
  assert.ok(validateLayout(noId).errors.some((e) => /props.id is required/.test(e)));
});

test('layout shape: not an object, missing content, bad root', () => {
  assert.equal(validateLayout(null).ok, false);
  assert.equal(validateLayout({ root: { props: {} } }).ok, false);
  assert.equal(validateLayout({ root: 'x', content: [] }).ok, false);
  assert.equal(validateLayout({ root: { props: {} }, content: [] }).ok, true);
});

test('with an injected schema: required props, enums, maxes and unknown props are checked', () => {
  const ok = { root: { props: {} }, content: [{ type: 'Hero', props: { id: 'h', headline: 'Hi', height: 'tall' } }] };
  assert.deepEqual(validateLayout(ok, { schemas: FIXTURE_SCHEMAS }).errors, []);
  const missing = { root: { props: {} }, content: [{ type: 'Hero', props: { id: 'h', height: 'tall' } }] };
  assert.ok(validateLayout(missing, { schemas: FIXTURE_SCHEMAS }).errors.some((e) => /Hero.headline is required/.test(e)));
  const badEnum = { root: { props: {} }, content: [{ type: 'Hero', props: { id: 'h', headline: 'Hi', height: 'huge' } }] };
  assert.ok(validateLayout(badEnum, { schemas: FIXTURE_SCHEMAS }).errors.some((e) => /height must be one of: tall, short/.test(e)));
  const unknownProp = { root: { props: {} }, content: [{ type: 'Hero', props: { id: 'h', headline: 'Hi', colour: '#fff' } }] };
  assert.ok(validateLayout(unknownProp, { schemas: FIXTURE_SCHEMAS }).errors.some((e) => /no setting called "colour"/.test(e)));
  const tooMany = { root: { props: {} }, content: [{ type: 'Gallery', props: { id: 'g', photos: [1, 2, 3, 4], cols: 9 } }] };
  const errs = validateLayout(tooMany, { schemas: FIXTURE_SCHEMAS }).errors;
  assert.ok(errs.some((e) => /more than 3 entries/.test(e)) && errs.some((e) => /above 4/.test(e)), errs.join('\n'));
  // A type the schema does not know is refused even though the contract list knows it.
  const notInSchema = { root: { props: {} }, content: [{ type: 'FindUs', props: { id: 'f' } }] };
  assert.ok(validateLayout(notInSchema, { schemas: FIXTURE_SCHEMAS }).errors.some((e) => /unknown block type "FindUs"/.test(e)));
});

test('setDefaultSchemas registers the schema for later calls, and null clears it', () => {
  setDefaultSchemas(FIXTURE_SCHEMAS);
  try {
    assert.deepEqual(knownBlockTypes(), ['Hero', 'Text', 'Gallery']);
    const r = validateLayout({ root: { props: {} }, content: [{ type: 'Hero', props: { id: 'h' } }] });
    assert.ok(r.errors.some((e) => /headline is required/.test(e)));
    // An explicit null argument means "contract list only" even when a default is registered.
    assert.equal(validateLayout({ root: { props: {} }, content: [{ type: 'FindUs', props: { id: 'f' } }] }, { schemas: null }).ok, true);
  } finally {
    setDefaultSchemas(null);
  }
  assert.deepEqual(knownBlockTypes(), [...CONTRACT_BLOCK_TYPES]);
});

test('theme values are the contract enums, brand_color hex or null', () => {
  assert.equal(validatePatch({ theme: { layout: 'ember', type: 'clean-sans', buttons: 'square', mood: 'dark', brand_color: null } }).ok, true);
  assert.ok(validatePatch({ theme: { layout: 'neon' } }).errors.some((e) => /layout must be one of/.test(e)));
  assert.ok(validatePatch({ theme: { brand_color: 'red' } }).errors.some((e) => /brand_color/.test(e)));
  assert.ok(validatePatch({ theme: { font: 'x' } }).errors.some((e) => /no setting called "font"/.test(e)));
});

test('nav items need a label and a kind; links need an href', () => {
  assert.ok(validatePatch({ nav: [{ label: '', kind: 'page', page_id: 'x' }] }).errors.some((e) => /needs a label/.test(e)));
  assert.ok(validatePatch({ nav: [{ label: 'Go', kind: 'link' }] }).errors.some((e) => /href/.test(e)));
  assert.ok(validatePatch({ nav: [{ label: 'Go', kind: 'tab' }] }).errors.some((e) => /kind must be page or link/.test(e)));
});

test('site patch whitelist: only theme, nav, footer, seo, settings, slug', () => {
  const r = validateSitePatch({ status: 'live', published_version_id: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.deepEqual(r.clean, {});
  const ok = validateSitePatch({ settings: { allow_custom_code: true, custom_head_html: '<meta name="x">', channels: { order: false } } });
  assert.equal(ok.ok, true);
  assert.ok(validateSitePatch({ settings: { allow_custom_code: 'yes' } }).errors.some((e) => /true or false/.test(e)));
});

test('page patch: new pages need a slug and a title; location pages need a location', () => {
  assert.ok(validatePage({ title: 'X' }, { isNew: true }).errors.some((e) => /needs an address/.test(e)));
  assert.ok(validatePage({ slug: 'x' }, { isNew: true }).errors.some((e) => /needs a title/.test(e)));
  assert.ok(validatePage({ slug: 'leeds', title: 'Leeds', kind: 'location', location_id: null }, { isNew: true }).errors.some((e) => /needs a location_id/.test(e)));
  assert.equal(validatePage({ slug: 'leeds', title: 'Leeds', kind: 'location', location_id: sample.locations[0].id }, { isNew: true }).ok, true);
  assert.ok(validatePage({ kind: 'shop' }).errors.some((e) => /kind must be one of/.test(e)));
  assert.ok(validatePage({ sort_order: -1 }).errors.some((e) => /sort_order/.test(e)));
});

test('post patch: slug comes from the title when missing; tags capped; unknown keys refused', () => {
  const r = validatePostPatch({ title: 'Why our dough takes 72 hours!', body_md: 'x' }, { isNew: true });
  assert.equal(r.ok, true);
  assert.equal(r.clean.slug, 'why-our-dough-takes-72-hours');
  assert.ok(validatePostPatch({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).errors.some((e) => /tags/.test(e)));
  assert.ok(validatePostPatch({ views: 3 }).errors.some((e) => /no setting called "views"/.test(e)));
  assert.ok(validatePostPatch({ status: 'live' }).errors.some((e) => /draft or published/.test(e)));
});

test('slugify handles accents, punctuation and length', () => {
  assert.equal(slugify('Mozz Pizza, Leeds!'), 'mozz-pizza-leeds');
  assert.equal(slugify('Café Rouge'), 'cafe-rouge');
  assert.equal(slugify('   '), '');
  assert.ok(slugify('a'.repeat(100)).length <= 40);
});

// Agent B's real registry, when it is on the branch. The sample snapshot must pass it with no
// errors, an unknown prop must be refused, and every contract block type must be in it.
test('with the real block registry (when present): the sample passes, unknown props are refused', async () => {
  let mod = null;
  try { mod = await import('../../surfaces/website/blocks/schema.js'); } catch { /* not on this branch yet */ }
  if (!mod?.BLOCK_SCHEMAS) return;
  const schemas = mod.BLOCK_SCHEMAS;
  for (const t of CONTRACT_BLOCK_TYPES) assert.ok(schemas[t], `registry has ${t}`);
  const r = validatePatch(samplePatch(), { schemas });
  assert.deepEqual(r.errors, []);
  const bad = { pages: [{ slug: 'menu', title: 'Menu', kind: 'menu', layout: { root: { props: {} }, content: [{ type: 'Hero', props: { id: 'h', headline: 'Menu', wobble: 1 } }] } }] };
  assert.ok(validatePatch(bad, { schemas }).errors.some((e) => /no setting called "wobble"/.test(e)));
  const badEnum = { pages: [{ slug: 'menu', title: 'Menu', kind: 'menu', layout: { root: { props: {} }, content: [{ type: 'Hero', props: { id: 'h', headline: 'Menu', height: 'huge' } }] } }] };
  assert.ok(validatePatch(badEnum, { schemas }).errors.some((e) => /height must be one of: tall, short/.test(e)));
});

test('delete_pages never deletes the home page', () => {
  const r = validatePatch({ delete_pages: [''] });
  assert.ok(r.errors.some((e) => /home page cannot be deleted/.test(e)));
  assert.equal(validatePatch({ delete_pages: ['our-story'] }).ok, true);
});
