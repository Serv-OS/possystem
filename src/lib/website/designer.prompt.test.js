// node --test: the AI designer's pure parts (ARCHITECTURE.md section 13 D). Tool schema from the
// block registry, the prompt recipes, the menu summary and the layout rule. No network, no JSX.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPatchTool, describeBlocks, fieldToJsonSchema, blockPropsSchema, schemasFromModule, FALLBACK_BLOCK_SCHEMAS, TOOL_NAME } from '../../../api/_lib/website/schemaToTool.js';
import { pickLayout, buildPageSet, buildSystemPrompt, buildUserMessage, historyTurns, LAYOUT_RECIPES, slugify } from '../../../api/_lib/website/designerPrompt.js';
import { summariseMenu, loyaltyType, hoursSummary, spellingFor, factsSummaryLines, emptyFacts } from '../../../api/_lib/website/venueFacts.js';
import { basicValidatePatch } from '../../../api/website-designer.js';

// A registry fixture in the Puck field style agent B's schema.js is expected to use.
const FIXTURE = {
  BLOCK_TYPES: ['Hero', 'Text', 'LiveMenu'],
  BLOCK_SCHEMAS: {
    Hero: { label: 'Hero', group: 'servos', fields: { headline: { type: 'text', label: 'Headline' }, height: { type: 'select', options: [{ label: 'Tall', value: 'tall' }, { label: 'Short', value: 'short' }] }, primary: { type: 'object', objectFields: { label: { type: 'text' }, href: { type: 'text' } } } } },
    Text: { label: 'Text', group: 'content', fields: { markdown: { type: 'textarea' } } },
    LiveMenu: { label: 'Live menu', group: 'servos', fields: { max_items: { type: 'number' }, categories: { type: 'array', arrayFields: { id: { type: 'text' } } }, show: { type: 'object', objectFields: { prices: { type: 'boolean' } } } } },
  },
  GROUPS: ['servos', 'content'],
  defaultPropsFor: () => ({}),
};

test('tool schema is generated from the registry: only its block types, props mapped to JSON Schema', () => {
  const schemas = schemasFromModule(FIXTURE);
  const tool = buildPatchTool(schemas);
  assert.equal(tool.name, TOOL_NAME);
  assert.deepEqual(tool.input_schema.required, ['reply']);
  const items = tool.input_schema.properties.pages.items.properties.layout.properties.content.items.anyOf;
  assert.deepEqual(items.map((i) => i.properties.type.enum[0]), ['Hero', 'Text', 'LiveMenu']);
  const hero = items[0].properties.props.properties;
  assert.equal(hero.id.type, 'string', 'every block carries Puck\'s id');
  assert.equal(items[0].properties.props.additionalProperties, false, 'the model cannot invent props');
  assert.deepEqual(hero.height, { type: 'string', enum: ['tall', 'short'] });
  assert.equal(hero.headline.type, 'string');
  assert.equal(hero.primary.properties.href.type, 'string');
  const menu = items[2].properties.props.properties;
  assert.equal(menu.max_items.type, 'number');
  assert.equal(menu.categories.items.properties.id.type, 'string');
  assert.equal(menu.show.properties.prices.type, 'boolean');
  // The schema must be plain JSON (what the API accepts).
  assert.equal(typeof JSON.stringify(tool), 'string');
});

test('fallback schemas cover every block in the contract table and serialise', () => {
  const tool = buildPatchTool(FALLBACK_BLOCK_SCHEMAS);
  const types = tool.input_schema.properties.pages.items.properties.layout.properties.content.items.anyOf.map((i) => i.properties.type.enum[0]);
  for (const t of ['Hero', 'OrderBar', 'LiveMenu', 'Specials', 'OrderEmbed', 'LoyaltyJoin', 'GiftCards', 'BookTable', 'Waitlist', 'Hours', 'FindUs', 'Reviews', 'BlogList', 'Text', 'Columns', 'Gallery', 'Button', 'FAQ', 'Instagram', 'Divider', 'Spacer']) {
    assert.ok(types.includes(t), `${t} missing`);
  }
  assert.ok(!types.includes('CustomHtml'), 'the designer may never place custom code');
  const withCustom = buildPatchTool({ ...FALLBACK_BLOCK_SCHEMAS, CustomHtml: { label: 'Custom', properties: { html: { type: 'string' } } } });
  assert.ok(!JSON.stringify(withCustom).includes('CustomHtml'), 'a registry that has CustomHtml still never offers it to the model');
  assert.ok(describeBlocks().includes('- Hero [servos]: headline'));
  assert.equal(buildPatchTool(null).name, TOOL_NAME, 'a missing registry still gives a tool');
});

test('field normaliser handles JSON Schema, select and unknown types without throwing', () => {
  assert.deepEqual(fieldToJsonSchema({ type: 'string', enum: ['a'] }), { type: 'string', enum: ['a'] });
  assert.deepEqual(fieldToJsonSchema({ type: 'select', options: [1, 2] }), { type: 'number', enum: [1, 2] });
  assert.equal(fieldToJsonSchema({ type: 'wobble' }).type, 'object');
  assert.deepEqual(blockPropsSchema(null), {});
  assert.deepEqual(blockPropsSchema({ properties: { a: { type: 'string' } } }), { a: { type: 'string' } });
});

test('build mode picks the layout by photo coverage: ember at 60% and above, else ledger', () => {
  assert.equal(pickLayout(60), 'ember');
  assert.equal(pickLayout(95), 'ember');
  assert.equal(pickLayout(59), 'ledger');
  assert.equal(pickLayout(0), 'ledger');
  assert.equal(pickLayout(undefined), 'ledger');
});

test('every layout has a recipe for every page kind and one Hero first', () => {
  for (const [id, r] of Object.entries(LAYOUT_RECIPES)) {
    for (const kind of ['home', 'menu', 'order', 'catering', 'loyalty', 'gift', 'findus', 'location', 'blog', 'custom']) {
      assert.ok(Array.isArray(r.pages[kind]) && r.pages[kind].length, `${id}.${kind} recipe`);
      assert.ok(r.pages[kind][0].startsWith('Hero'), `${id}.${kind} starts with Hero`);
      assert.equal(r.pages[kind].filter((b) => b.startsWith('Hero')).length, 1, `${id}.${kind} one Hero`);
    }
  }
});

test('build page set follows the channel flags and adds a page per location', () => {
  const facts = { ...emptyFacts(), channels: { ...emptyFacts().channels, online: true, catering: true, gift: true, loyalty: { on: true, type: 'stamps', programs: [] } }, locations: [{ id: 'l1', name: 'Leeds', online_slug: 'mozz-leeds' }, { id: 'l2', name: 'Hudds Town', online_slug: '' }] };
  const set = buildPageSet(facts);
  const slugs = set.map((p) => p.slug);
  assert.deepEqual(slugs, ['', 'menu', 'order', 'catering', 'loyalty', 'gift-cards', 'find-us', 'mozz-leeds', 'hudds-town', 'our-story'], 'no blog page: the site serves /blog itself');
  assert.equal(set.find((p) => p.slug === 'loyalty').title, 'Stamp card');
  assert.equal(set.find((p) => p.slug === 'mozz-leeds').location_id, 'l1');
  assert.equal(set.find((p) => p.slug === 'our-story').status, 'draft');
  const off = buildPageSet(emptyFacts()).map((p) => p.slug);
  assert.deepEqual(off, ['', 'menu', 'find-us', 'our-story']);
  assert.equal(slugify('Café  Roma!'), 'cafe-roma');
});

test('system prompt carries the rules, the recipes, the mode and the facts, with the right spelling', () => {
  const facts = { ...emptyFacts(), company: { id: 'c', name: 'Mozz', slug: 'mozz', currency: 'USD', country: 'US', spelling: 'us' }, menu: { ...emptyFacts().menu, photo_coverage_pct: 80 } };
  const p = buildSystemPrompt({ facts, mode: 'build', blocksDescription: describeBlocks() });
  for (const must of ['BUILD MODE', 'Layout: ember', 'American English', 'Never write prices, opening hours', 'SEO RULES', '<= 60 characters', '<= 155 characters', 'order online', 'exactly two starter posts', 'VENUE FACTS', '"Mozz"', 'LAYOUT RECIPES', 'Ledger:', 'Marquee:']) {
    assert.ok(p.includes(must), `prompt should include: ${must}`);
  }
  assert.ok(!p.includes('\u2014'), 'no em dashes anywhere in the prompt');
  const uk = buildSystemPrompt({ facts: emptyFacts(), mode: 'chat' });
  assert.ok(uk.includes('British English') && uk.includes('CHAT MODE'));
  const chosen = buildSystemPrompt({ facts, mode: 'build', layout: 'marquee' });
  assert.ok(chosen.includes('Layout: marquee (the owner chose it)'));
  assert.equal(buildUserMessage({ message: 'Make the hero shorter', page: { slug: 'menu', kind: 'menu', title: 'Menu', blocks: ['Hero', 'LiveMenu'] } }), 'Page in context: slug "menu" (menu, "Menu"). Current blocks: Hero, LiveMenu.\nMake the hero shorter');
  assert.deepEqual(historyTurns([{ role: 'user', content: 'a' }, { role: 'system', content: 'x' }, { role: 'assistant', content: '' }]), [{ role: 'user', content: 'a' }]);
});

test('menu summary: top level online items only, 5 names per category, photo coverage, pinned menu narrows', () => {
  const categories = [{ id: 'c1', label: 'Pizza', sort_order: 1 }, { id: 'c2', label: 'Sides', sort_order: 2 }, { id: 'c3', label: 'Hidden', sort_order: 3 }, { id: 'c4', label: 'Sub', parent_id: 'c1' }];
  const items = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `Pizza ${i}`, cat: 'c1', image: i < 5 ? 'x.jpg' : '' })),
    { id: 's1', name: 'Fries', cats: ['c2'], image: '' },
    { id: 's2', name: 'Variant', cats: ['c2'], parent_id: 's1', image: '' },
    { id: 's3', name: 'Till only', cats: ['c2'], visibility: { online: false } },
    { id: 'a1', name: 'Old', cat: 'c1', archived: true },
  ];
  const m = summariseMenu({ categories, items });
  assert.equal(m.item_count, 8);
  assert.equal(m.photo_coverage_pct, 63);
  assert.deepEqual(m.categories.map((c) => [c.label, c.count, c.sample.length]), [['Pizza', 7, 5], ['Sides', 1, 1]]);
  const pinned = summariseMenu({ categories, items, menus: [{ id: 'm1', name: 'Online', is_active: true }], links: [{ menu_id: 'm1', category_id: 'c2' }], pinnedMenuId: 'm1' });
  assert.deepEqual(pinned.categories.map((c) => c.label), ['Sides']);
  assert.deepEqual(summariseMenu({}), { categories: [], item_count: 0, photo_count: 0, photo_coverage_pct: 0, menus: [] });
});

test('loyalty type, hours lines, spelling and facts summary never throw on empty input', () => {
  assert.deepEqual(loyaltyType(null), { on: false, type: 'none', programs: [] });
  assert.equal(loyaltyType({ enabled: true, points_enabled: true, stamps_enabled: true }, []).type, 'points');
  assert.equal(loyaltyType({ enabled: true, points_enabled: false, stamps_enabled: true }, [{ name: 'Coffee', stamps_required: 10 }]).type, 'stamps');
  assert.equal(loyaltyType({ enabled: true, points_enabled: true }, [{ name: 'Coffee' }]).type, 'both');
  assert.deepEqual(hoursSummary(null), []);
  assert.equal(hoursSummary({ weekly: { mon: [{ open: '11:30', close: '22:00' }], tue: [] } })[0], 'mon: 11:30 to 22:00');
  assert.equal(hoursSummary({ weekly: { mon: [] } })[1], 'tue: closed');
  assert.equal(spellingFor('usd'), 'us');
  assert.equal(spellingFor('GBP'), 'uk');
  assert.equal(factsSummaryLines(null)[0], 'Locations: 0');
});

test('fallback validator: refuses unknown blocks, bad slugs, two heroes; accepts the sample patch', () => {
  const good = { reply: 'Done', pages: [{ slug: '', title: 'Home', kind: 'home', layout: { content: [{ type: 'Hero', props: { headline: 'Mozz Pizza, Leeds' } }, { type: 'LiveMenu', props: {} }] } }], posts: [{ slug: 'hello', title: 'Hello', body_md: 'Welcome.' }] };
  const ok = basicValidatePatch(good, { schemas: FALLBACK_BLOCK_SCHEMAS });
  assert.equal(ok.ok, true);
  assert.equal(ok.patch.pages[0].status, 'published');
  assert.equal(ok.patch.posts[0].status, 'draft');
  const bad = basicValidatePatch({ reply: 'x', pages: [{ slug: 'Bad Slug', title: 'T', kind: 'home', layout: { content: [{ type: 'Hero', props: {} }, { type: 'Hero', props: {} }, { type: 'Marquee', props: {} }] } }] }, { schemas: FALLBACK_BLOCK_SCHEMAS });
  assert.equal(bad.ok, false);
  assert.equal(bad.patch, null);
  assert.ok(bad.errors.some((e) => e.includes('slug')));
  assert.ok(bad.errors.some((e) => e.includes('"Marquee" does not exist')));
  assert.ok(bad.errors.some((e) => e.includes('2 Hero blocks')));
});

// 5.12.2: Opus 5.5 refuses a forced tool choice; the request must say auto and the prompt must
// tell the model to always answer through the tool.
import fsForToolChoice from 'node:fs';
test('the designer never forces the tool (Opus 5.5 answers 400 to type tool / any) and the prompt asks for it instead', () => {
  const src = fsForToolChoice.readFileSync(new URL('../../../api/website-designer.js', import.meta.url), 'utf8');
  assert.ok(src.includes("tool_choice: { type: 'auto' }") && !src.includes('disable_parallel_tool_use'));
  assert.ok(!/tool_choice:\s*\{\s*type:\s*'(tool|any)'/.test(src));
  const prompt = fsForToolChoice.readFileSync(new URL('../../../api/_lib/website/designerPrompt.js', import.meta.url), 'utf8');
  assert.ok(prompt.includes('ALWAYS finish by calling apply_site_patch') && prompt.includes('REFERENCE SITES') && prompt.includes('read it\nFIRST with web_fetch'));
});

// 5.12.2: reference sites. The web fetch tool is offered only when the owner linked something, and
// a pause_turn answer is resumed by resending the turn with the assistant content appended.
import { callClaude, linksIn, webFetchTool, historyText, classifyFetches, fetchNotes, BLOCKED_NOTE, sanitiseImages, userTurnContent, MAX_IMAGES } from '../../../api/website-designer.js';
test('linksIn finds the owner\'s links, trims trailing punctuation and deduplicates', () => {
  assert.deepEqual(linksIn('like https://www.mozzartisanpizza.com. and https://www.mozzartisanpizza.com and http://a.b/c?x=1,'), ['https://www.mozzartisanpizza.com', 'http://a.b/c?x=1']);
  assert.deepEqual(linksIn('no links here'), []);
  assert.equal(historyText([{ role: 'user', content: 'see https://x.y' }, { role: 'assistant', content: 'ok' }]), 'see https://x.y');
});

test('callClaude offers web_fetch only with allowFetch, never forces the tool, and resumes pause_turn', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const req = JSON.parse(init.body);
    calls.push(req);
    const first = calls.length === 1;
    const body = first
      ? { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url: 'https://www.mozzartisanpizza.com' } }] }
      : { stop_reason: 'tool_use', content: [
        { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_fetch_result', url: 'https://www.mozzartisanpizza.com', content: { type: 'document', title: 'Mozz Artisan Pizza', source: { type: 'text', media_type: 'text/plain', data: 'Mozz Artisan Pizza. Sourdough pizza in Provo. '.repeat(20) } } } },
        { type: 'text', text: 'Read it.' }, { type: 'tool_use', id: 'toolu_1', name: 'apply_site_patch', input: { reply: 'Built in that spirit.' } }] };
    return { ok: true, status: 200, json: async () => body };
  };
  const tool = { name: 'apply_site_patch', description: 'x', input_schema: { type: 'object' } };
  const out = await callClaude({ apiKey: 'k', model: 'm', system: 's', messages: [{ role: 'user', content: 'like https://www.mozzartisanpizza.com' }], tool, fetchImpl, allowFetch: true });
  assert.equal(calls.length, 2, 'pause_turn was resumed once');
  assert.deepEqual(calls[0].tools.map((t) => t.name), ['apply_site_patch', 'web_fetch']);
  assert.equal(calls[0].tools[1].type, 'web_fetch_20260209');
  assert.deepEqual(calls[0].tool_choice, { type: 'auto' });
  assert.equal(calls[1].messages.length, 2, 'the assistant content was appended, no extra user turn');
  assert.equal(calls[1].messages[1].role, 'assistant');
  assert.deepEqual(out.patch, { reply: 'Built in that spirit.' });
  assert.deepEqual(out.fetched, [{ url: 'https://www.mozzartisanpizza.com', ok: true, note: '' }], 'a read in the first turn is reported after the resume');
  const plain = [];
  await callClaude({ apiKey: 'k', model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], tool, fetchImpl: async (u, init) => { plain.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] }) }; } });
  assert.deepEqual(plain[0].tools.map((t) => t.name), ['apply_site_patch']);
  assert.ok(webFetchTool().max_uses > 0);
});

// 5.12.5 (1 Nov 2026): mozzartisanpizza.com sits behind a Cloudflare challenge. The reader got a
// "Just a moment" page, the model built from the brief and never said so. The owner is now told
// from the tool results which pages were read and which were not, and asked for screenshots.
test('classifyFetches: a challenge page, an error, an empty page and a real page are told apart, and fetchNotes says what to do', () => {
  const content = [
    { type: 'server_tool_use', id: 'a', name: 'web_fetch', input: { url: 'https://blocked.example' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'a', content: { type: 'web_fetch_result', url: 'https://blocked.example', content: { type: 'document', title: 'Just a moment...', source: { type: 'text', media_type: 'text/html', data: 'Enable JavaScript and cookies to continue. Verifying you are human.' } } } },
    { type: 'server_tool_use', id: 'b', name: 'web_fetch', input: { url: 'https://down.example' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'b', content: { type: 'web_fetch_tool_error', error_code: 'url_not_accessible' } },
    { type: 'server_tool_use', id: 'c', name: 'web_fetch', input: { url: 'https://thin.example' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'c', content: { type: 'web_fetch_result', url: 'https://thin.example', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Menu' } } } },
    { type: 'server_tool_use', id: 'd', name: 'web_fetch', input: { url: 'https://good.example/menu' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'd', content: { type: 'web_fetch_result', url: 'https://good.example/menu', content: { type: 'document', title: 'Our menu', source: { type: 'text', media_type: 'text/plain', data: 'Margherita 12. Marinara 10. Diavola 14. Salads, desserts, drinks. '.repeat(6) } } } },
    { type: 'server_tool_use', id: 'e', name: 'web_fetch', input: { url: 'https://lost.example' } },
  ];
  const f = classifyFetches(content);
  assert.deepEqual(f.map((x) => [x.url, x.ok]), [['https://blocked.example', false], ['https://down.example', false], ['https://thin.example', false], ['https://good.example/menu', true], ['https://lost.example', false]]);
  assert.equal(f[0].note, BLOCKED_NOTE);
  assert.equal(f[1].note, 'the page could not be reached');
  assert.equal(f[2].note, 'the page came back almost empty');
  assert.equal(f[4].note, 'no answer came back from the reader');
  const notes = fetchNotes(f);
  assert.equal(notes[3], 'Read: https://good.example/menu');
  assert.match(notes[0], /^Could not read https:\/\/blocked\.example: the site blocks automated readers\. Drop screenshots/);
  assert.deepEqual(classifyFetches([]), []);
  assert.deepEqual(fetchNotes([]), []);
});

test('screenshots: only real image types within the caps go through, and the user turn carries them before the words', () => {
  const ok = { media_type: 'image/jpeg', data: 'data:image/jpeg;base64,' + 'QUJD'.repeat(50) };
  const png = { media_type: 'image/png', data: 'QUJD'.repeat(50) };
  const big = { media_type: 'image/jpeg', data: 'A'.repeat(1.7 * 1024 * 1024) };
  const odd = { media_type: 'application/pdf', data: 'QUJD' };
  const junk = { media_type: 'image/jpeg', data: '<script>' };
  const list = sanitiseImages([ok, png, big, odd, junk, ...Array.from({ length: 8 }, () => png)]);
  assert.equal(list.length, MAX_IMAGES);
  assert.equal(list[0].data, 'QUJD'.repeat(50), 'the data: prefix is stripped');
  assert.ok(list.every((im) => ['image/jpeg', 'image/png'].includes(im.media_type)));
  assert.deepEqual(sanitiseImages(null), []);
  assert.deepEqual(sanitiseImages('nope'), []);
  assert.equal(userTurnContent('hello', []), 'hello');
  const turn = userTurnContent('Build it like these', list.slice(0, 2));
  assert.equal(turn.length, 3);
  assert.deepEqual(turn[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD'.repeat(50) } });
  assert.equal(turn[2].type, 'text');
  assert.match(turn[2].text, /^Build it like these\n\nThe owner attached 2 screenshots/);
});
