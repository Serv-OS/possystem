// api/_lib/website/designerPrompt.js: the AI designer's system prompt (ARCHITECTURE.md section 11).
// The model fills page RECIPES rather than inventing structure: each layout says which blocks go on
// which kind of page, in order. Everything the model may say about the venue comes from the facts
// block appended to the prompt. Pure, no network, tested in src/lib/website/designer.prompt.test.js.

export const LAYOUT_IDS = ['ember', 'ledger', 'marquee'];
export const PHOTO_COVERAGE_FOR_EMBER = 60;

/** Build mode picks the layout by photo coverage: photo led when most items have a picture. */
export function pickLayout(photoCoveragePct) {
  const pct = Number(photoCoveragePct);
  return Number.isFinite(pct) && pct >= PHOTO_COVERAGE_FOR_EMBER ? 'ember' : 'ledger';
}

export function layoutReason(layout, photoCoveragePct) {
  const pct = Number(photoCoveragePct) || 0;
  if (layout === 'ember') return `Ember, because ${pct}% of your menu items have photos, so a photo led site shows them off.`;
  if (layout === 'marquee') return 'Marquee, a bold type led look for a venue that wants to stand out.';
  return `Ledger, because ${pct}% of your menu items have photos, so a clean text led menu reads best until more photos are added.`;
}

// Page recipes: block types in order, per page kind. ServOS blocks appear only when the channel is
// on; the prompt tells the model to drop a block whose channel is off.
export const LAYOUT_RECIPES = {
  ember: {
    name: 'Ember',
    feel: 'Photo led and warm. Big hero photo, menu as photo cards, generous spacing. Type warm-serif, buttons pill, mood light.',
    theme: { type: 'warm-serif', buttons: 'pill', mood: 'light' },
    pages: {
      home: ['Hero (tall, branding hero photo, show_status true, primary Order, secondary Menu)', 'OrderBar', 'Specials (tagged)', 'LiveMenu (cards, photos on, max_items 8, add_button false)', 'Text (one short paragraph about the venue, from facts)', 'LoyaltyJoin', 'Reviews', 'Hours (all)', 'FindUs (show_map, show_order_buttons)'],
      menu: ['Hero (short, headline Menu)', 'LiveMenu (cards, all categories, photos, descriptions, allergens, dietary, add_button true)'],
      order: ['Hero (short, headline Order online)', 'OrderBar', 'OrderEmbed (online)'],
      catering: ['Hero (short)', 'Text (what you cater, lead time in plain words only if the facts give one)', 'OrderEmbed (catering)', 'FAQ (3 to 5 real questions about ordering catering)'],
      loyalty: ['Hero (short)', 'LoyaltyJoin (show_card_preview true)', 'FAQ (how it works)'],
      gift: ['Hero (short)', 'GiftCards (show_art true)'],
      findus: ['Hero (short, headline Find us)', 'FindUs (show_map, show_nearest, show_hours, show_order_buttons)'],
      location: ['Hero (tall, headline the location name)', 'Hours (this location, show_today_first)', 'FindUs (this location only)', 'LiveMenu (this location, cards, max_items 12)', 'OrderEmbed (online, this location)'],
      blog: ['Hero (short, headline News)', 'BlogList (count 12, show_excerpt)'],
      custom: ['Hero (short)', 'Text', 'Gallery (only when photos exist)'],
    },
  },
  ledger: {
    name: 'Ledger',
    feel: 'Clean and text led. Short hero, menu as a list with prices, tight grid. Type clean-sans, buttons rounded, mood light.',
    theme: { type: 'clean-sans', buttons: 'rounded', mood: 'light' },
    pages: {
      home: ['Hero (short, show_status true, primary Order, secondary Menu)', 'OrderBar', 'LiveMenu (list, photos off, descriptions on, max_items 12)', 'Columns (2: about the venue, how to order)', 'LoyaltyJoin', 'Hours (all)', 'FindUs (show_order_buttons)'],
      menu: ['Hero (short, headline Menu)', 'LiveMenu (list, all categories, prices, descriptions, allergens, dietary)'],
      order: ['Hero (short, headline Order online)', 'OrderBar', 'OrderEmbed (online)'],
      catering: ['Hero (short)', 'Text', 'OrderEmbed (catering)', 'FAQ'],
      loyalty: ['Hero (short)', 'LoyaltyJoin', 'FAQ'],
      gift: ['Hero (short)', 'GiftCards'],
      findus: ['Hero (short, headline Find us)', 'FindUs (show_nearest, show_hours, show_order_buttons)'],
      location: ['Hero (short, headline the location name)', 'Hours (this location)', 'FindUs (this location only)', 'LiveMenu (this location, list)', 'OrderEmbed (online, this location)'],
      blog: ['Hero (short, headline News)', 'BlogList (count 12, show_excerpt)'],
      custom: ['Hero (short)', 'Text'],
    },
  },
  marquee: {
    name: 'Marquee',
    feel: 'Bold and type led. Tall hero with a big headline, menu as a board, dark mood with the brand colour as accent. Type classic, buttons square, mood dark.',
    theme: { type: 'classic', buttons: 'square', mood: 'dark' },
    pages: {
      home: ['Hero (tall, headline the venue name, show_status true, primary Order)', 'OrderBar', 'LiveMenu (board, max_items 10)', 'Text (one line statement about the venue)', 'Gallery (only when photos exist)', 'LoyaltyJoin', 'Hours (all)', 'FindUs (show_map)'],
      menu: ['Hero (short, headline Menu)', 'LiveMenu (board, all categories, prices, dietary)'],
      order: ['Hero (short, headline Order)', 'OrderBar', 'OrderEmbed (online)'],
      catering: ['Hero (tall)', 'Text', 'OrderEmbed (catering)', 'FAQ'],
      loyalty: ['Hero (short)', 'LoyaltyJoin (show_card_preview true)'],
      gift: ['Hero (short)', 'GiftCards (show_art true)'],
      findus: ['Hero (short, headline Find us)', 'FindUs (show_map, show_nearest, show_hours, show_order_buttons)'],
      location: ['Hero (tall, headline the location name)', 'Hours (this location)', 'FindUs (this location only)', 'LiveMenu (this location, board)', 'OrderEmbed (online, this location)'],
      blog: ['Hero (short, headline News)', 'BlogList (count 12)'],
      custom: ['Hero (tall)', 'Text'],
    },
  },
};

/** The pages build mode must produce for this venue, from the channel flags. */
export function buildPageSet(facts) {
  const ch = facts?.channels || {};
  const pages = [{ slug: '', kind: 'home', title: 'Home' }, { slug: 'menu', kind: 'menu', title: 'Menu' }];
  if (ch.online) pages.push({ slug: 'order', kind: 'order', title: 'Order online' });
  if (ch.catering) pages.push({ slug: 'catering', kind: 'catering', title: 'Catering' });
  if (ch.loyalty?.on) pages.push({ slug: 'loyalty', kind: 'loyalty', title: ch.loyalty.type === 'stamps' ? 'Stamp card' : 'Rewards' });
  if (ch.gift) pages.push({ slug: 'gift-cards', kind: 'gift', title: 'Gift cards' });
  pages.push({ slug: 'find-us', kind: 'findus', title: 'Find us' });
  for (const l of facts?.locations || []) {
    const slug = l.online_slug || slugify(l.name);
    if (slug) pages.push({ slug, kind: 'location', title: l.name, location_id: l.id });
  }
  // No blog page: the site serves the post list at /blog itself; nav gets a link to it.
  pages.push({ slug: 'our-story', kind: 'custom', title: 'Our story', status: 'draft' });
  return pages;
}

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function recipeText(layout) {
  const r = LAYOUT_RECIPES[layout] || LAYOUT_RECIPES.ledger;
  const lines = [`${r.name}: ${r.feel}`, `Theme: layout ${layout}, type ${r.theme.type}, buttons ${r.theme.buttons}, mood ${r.theme.mood}, brand_color null (inherit branding).`];
  for (const [kind, blocks] of Object.entries(r.pages)) lines.push(`  ${kind}: ${blocks.join(' > ')}`);
  return lines.join('\n');
}

function allRecipesText() {
  return LAYOUT_IDS.map((id) => recipeText(id)).join('\n\n');
}

/** The rules that never change, in plain English, for the model. */
export function coreRules({ spelling = 'uk', blocksDescription = '' } = {}) {
  const uk = spelling !== 'us';
  return `You are the ServOS website designer. You build and edit a restaurant's public website by calling the
apply_site_patch tool. The site is rendered by ServOS from blocks; you never write HTML or CSS.
ALWAYS answer by calling apply_site_patch, exactly once, even when you only have words for the owner:
put them in its reply field. Never answer in plain text and never call the tool more than once.

BLOCKS (the only block types that exist, with their props):
${blocksDescription}

HARD RULES
- Use only block types listed above and only their props. Anything else is refused by the validator.
- Every ServOS block for a channel that is ON in the facts must be present somewhere sensible (menu,
  order, loyalty, gift, catering, bookings, waitlist), unless the owner said no. Never place a block for
  a channel that is OFF.
- Never write prices, opening hours, addresses, phone numbers or menu item names as text. They are live:
  use LiveMenu, Hours, FindUs. Text that goes stale is a bug.
- Write real copy from the facts only. No lorem ipsum. No invented awards, years, founders, reviews,
  "best in town", "award winning", "famous" or any claim the facts do not back. If the facts do not say
  it, do not say it.
- One Hero per page, always first. One h1 per page comes from that Hero.
- Short sentences. Plain ${uk ? 'British' : 'American'} English (${uk ? 'colour, favourite, centre' : 'color, favorite, center'}). No em dashes, use commas or full stops. No exclamation marks.
- Never set settings.allow_custom_code or custom_head_html, and never use a CustomHtml block.
- Keep what the owner already edited. In chat mode patch only the pages the message names; send
  only the fields that change. A page you include replaces the whole page of that slug.
- Links: 'page:<slug>' for site pages (home is 'page:'), 'servos:order', 'servos:catering',
  'servos:loyalty', 'servos:gift', 'servos:book', 'servos:waitlist' for ServOS surfaces, '/blog' for
  the blog list (the site serves /blog and /locations itself, so no page may use those slugs).
- Nav items: {label, kind:'page', page_id:<page slug, or its id from the facts>} or
  {label, kind:'link', href}. Theme has exactly layout, type, buttons, mood, brand_color.
- Every block's props carry only the props listed for that block (plus id). No extra keys anywhere:
  a page has slug, title, kind, seo, layout, status, location_id and nothing else.
- Location pages: kind 'location', slug = that location's online slug, location_id = its id from the
  facts, and every ServOS block on it points at that location_id.

SEO RULES (the venue must come up in Google and compete)
- Site seo.title <= 60 characters and includes the town. seo.description <= 155 characters with the
  cuisine, the town and the words "order online".
- Every page gets its own seo.title (<= 60, venue + page + town) and seo.description (<= 155).
- Location page seo: "<venue> <town>" style title, description with the street or area and "order online".
- Headline copy says what the venue is and where it is in the first sentence (cuisine + town).
- seo.locale 'en-GB' for UK venues, 'en-US' for US venues. Keywords: 5 to 10 real phrases a customer
  would search (cuisine + town, "takeaway near", dish names from the menu facts), no stuffing.
- Blog posts: titles a customer would search, 300 to 600 words, headings, tags, excerpt <= 155.
- Draft pages and posts use status 'draft'; everything else 'published'.

REPLY
- The tool's reply field: 2 to 5 short sentences, what you did and why, the one next step if any.
- When you cannot do what was asked with the blocks available, say so plainly in the reply and do
  the nearest thing that is possible.`;
}

/** Mode specific instructions. */
export function modeRules(mode, { layout, facts } = {}) {
  if (mode === 'build') {
    const chosen = layout && LAYOUT_IDS.includes(layout) ? layout : pickLayout(facts?.menu?.photo_coverage_pct);
    const pages = buildPageSet(facts);
    return `BUILD MODE
Build the whole site in one apply_site_patch call. Layout: ${chosen} (${layout ? 'the owner chose it' : layoutReason(chosen, facts?.menu?.photo_coverage_pct)}).
Say which layout you used and why in the reply.
Set theme, nav (one entry per published page in this order, home first, then a link item to '/blog'
labelled News), footer (text with the venue name, show_powered_by true, email/phone/instagram only
if the facts give them) and site seo.
Pages to create, in this order (slug, kind, title${pages.some((p) => p.location_id) ? ', location_id' : ''}):
${pages.map((p) => `  "${p.slug}" ${p.kind} "${p.title}"${p.location_id ? ` location_id ${p.location_id}` : ''}${p.status === 'draft' ? ' (status draft)' : ''}`).join('\n')}
Follow the ${chosen} recipe for each page kind. Drop any block whose channel is off.
Blog: write exactly two starter posts as status 'draft' (for example a welcome post about the venue and
a post about a menu category from the facts), real facts only.
Our story: status 'draft', a Hero and one Text block that the owner can finish; say in the reply that it
needs their words.`;
  }
  if (mode === 'post') {
    return `POST MODE
Write or rewrite the blog post named in the message as one entry in posts (status 'draft' unless the
owner asked to publish). Do not touch pages, theme, nav or footer.`;
  }
  return `CHAT MODE
Answer the owner's message. Change only what they asked for and only the pages they named. If they
ask a question that needs no change, call the tool with just a reply and no other fields.`;
}

/** Facts block, as JSON the model can quote from. Nothing outside this object is known about the venue. */
export function factsBlock(facts) {
  const f = facts || {};
  const slim = {
    company: f.company,
    branding: f.branding,
    locations: f.locations,
    channels: f.channels,
    menu: f.menu,
    site: f.site ? { ...f.site } : null,
  };
  return `VENUE FACTS (the only truth about this venue; ids here are the ones to use)\n${JSON.stringify(slim, null, 1)}`;
}

/**
 * The full system prompt.
 *   facts: assembleVenueFacts output; mode: 'build'|'chat'|'post'; layout: owner's pick or null;
 *   blocksDescription: describeBlocks(schemas)
 */
export function buildSystemPrompt({ facts, mode = 'chat', layout = null, blocksDescription = '' } = {}) {
  const spelling = facts?.company?.spelling || 'uk';
  return [
    coreRules({ spelling, blocksDescription }),
    `LAYOUT RECIPES (fill these, do not invent structure)\n${allRecipesText()}`,
    modeRules(mode, { layout, facts }),
    factsBlock(facts),
  ].join('\n\n');
}

/** The user turn for this request: the message, with the page in context when the UI gave one. */
export function buildUserMessage({ message, mode = 'chat', layout = null, page = null, post = null } = {}) {
  const parts = [];
  if (mode === 'build') parts.push(`Build my website${layout ? ` with the ${layout} layout` : ''}.`);
  if (page) parts.push(`Page in context: slug "${page.slug}" (${page.kind}, "${page.title}"). Current blocks: ${(page.blocks || []).join(', ') || 'none'}.`);
  if (post) parts.push(`Post in context: slug "${post.slug}" ("${post.title}").`);
  const m = String(message || '').trim();
  if (m) parts.push(m);
  if (!parts.length) parts.push('Review the site and suggest the one change that would help most. Make no changes yet.');
  return parts.join('\n');
}

/** Conversation history for the API call: the last stored messages, oldest first, as text turns. */
export function historyTurns(recent = []) {
  return (recent || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));
}
