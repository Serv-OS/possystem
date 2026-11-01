// src/surfaces/website/ssr/renderBlocks.js
//
// The server side renderer (ARCHITECTURE.md section 4 steps 3 to 5). Plain string templates, every
// value escaped with esc(), the same class names as the React components (blocks/classNames.js) and
// the same block order, so React can replace this markup on mount without a visual jump.
// Real <h1> once per page, <nav>, <main>, <footer>, real text for menu items, prices, hours and
// addresses: crawlers read the venue, not a JS shell. Embedded ServOS surfaces render as a link
// card plus the iframe so Google sees a link and humans get the frame.
// Never throws: a block with bad props renders its empty state; a renderer that fails renders ''.

import { esc, renderMarkdown, markdownToText } from '../markdown.js';
import { CN } from '../blocks/classNames.js';
import { layoutBlocks, normaliseProps, walkBlocks } from '../blocks/schema.js';
import { rowPlan, styleText } from '../blocks/rowPlan.js';
import { siteVars, cssText, fontLinks, themeColor } from '../theme.js';
import { SITE_CSS } from '../siteStyles.js';
import { hoursRows, openStatus } from '../hours.js';
import { addressText, directionsUrl } from '../geo.js';
import { resolveHref, pickLocation, venueUrl, explicitLocation, multiVenue, menuLocation, menuVenues, menuOrderHref, onVenuePage } from '../resolveHref.js';
import { formatPrice } from '../data/loadMenu.js';
import { blockVisible, visibleNav, breadcrumbsFor, siteLocations, publishedPosts, publishedPages, pathForPage, sitemapPaths, channelOn, locationChannelOn, PAGE_KIND_CHANNEL, headerOptions, HEADER_CTA_LABELS } from '../routes.js';
import { restaurantLd, menuLd, organizationLd, webSiteLd, breadcrumbLd, blogPostingLd, faqLd, siteName } from './jsonld.js';
import { canonicalHost } from '../hostParse.js';

const DIET_WORDS = { V: 'Vegetarian', VG: 'Vegan', GF: 'Gluten free', DF: 'Dairy free' };

const attr = (v) => esc(v);
const cls = (...xs) => xs.filter(Boolean).join(' ');
// 5.12.9: `nested` (default: the block's own flag, set by renderBlock for blocks inside a Row column)
// paints data-nested="true", the same attribute the React Section wrappers add, so a nested block
// fills its column instead of wrapping itself in another page width container (siteStyles.js).
const section = (block, cn, inner, extraAttrs = '', nested = !!(block && block.nested)) =>
  `<section class="${cls(CN.block, cn)}" data-block="${attr(block.type)}" data-id="${attr(block.props && block.props.id)}"${nested ? ' data-nested="true"' : ''}${extraAttrs}><div class="${CN.inner}">${inner}</div></section>`;
const heading = (text) => (text ? `<h2 class="${CN.h2}">${esc(text)}</h2>` : '');
const button = (ctx, link, style = 'primary') => {
  const href = resolveHref(ctx, link && link.href);
  if (!href || !(link && link.label)) return '';
  const styleCn = style === 'secondary' ? CN.btnSecondary : style === 'link' ? CN.btnLink : CN.btnPrimary;
  const ext = /^https?:\/\//i.test(href) && !href.startsWith(`https://${ctx.host}`) ? ' rel="noopener"' : '';
  return `<a class="${cls(CN.btn, styleCn)}" href="${attr(href)}"${ext}>${esc(link.label)}</a>`;
};
const empty = (text) => `<p class="${CN.empty}">${esc(text)}</p>`;

/** The venue a block means (its location_id prop, else the site default). */
function blockLocation(ctx, props) { return pickLocation(ctx, props && props.location_id); }

/**
 * 5.12.8 (Peter, 1 Nov): "show menu A on the home page, then a drop down or buttons to say
 * location 1 or location 2 menu". On a site with several venues a menu block that is not pinned to
 * one venue gets a switch: buttons (links to ?venue=<slug> on this page) or a dropdown (a plain GET
 * form, so it works before the script runs). The React LiveMenu paints the same markup.
 */
export function venueSwitchHtml(ctx, p, current) {
  // 5.12.9: the block's venue is only the starting venue, so a pinned block still gets the switch;
  // a venue's own page never does.
  if (!p || p.venue_switch === 'none' || onVenuePage(ctx) || !multiVenue(ctx)) return '';
  const venues = menuVenues(ctx);
  if (venues.length < 2) return '';
  const path = ctx.path || '/';
  const isCurrent = (l) => !!(current && l.id === current.id);
  if (p.venue_switch === 'dropdown') {
    const opts = venues.map((l) => `<option value="${attr(l.online_slug)}"${isCurrent(l) ? ' selected' : ''}>${esc(l.name || l.online_slug)} menu</option>`).join('');
    return `<form class="${CN.venueForm}" method="get" action="${attr(path)}"><label>Menu for <select name="venue" aria-label="Choose a venue">${opts}</select></label>` +
      `<button type="submit" class="${cls(CN.btn, CN.btnSecondary)}">Show</button></form>`;
  }
  const links = venues.map((l) => `<a class="${CN.venueBtn}" href="${attr(`${path}?venue=${encodeURIComponent(l.online_slug)}`)}"${isCurrent(l) ? ' aria-current="true"' : ''}>${esc(l.name || l.online_slug)} menu</a>`).join('');
  return `<nav class="${CN.venueSwitch}" aria-label="Choose a venue">${links}</nav>`;
}

/**
 * 5.12.7 (Peter, 1 Nov): never an iframe of a ServOS surface ("leaves it open to bugs, especially
 * on mobile"). A card with the venue's name and one button that opens the venue's own page in
 * the same tab. `height` is kept on the blocks for old layouts and ignored.
 */
function embed(ctx, { title, text, href, label = 'Open' }) {
  if (!href) return empty(`${title} is not set up yet.`);
  return `<div class="${cls(CN.card, CN.embedCard)}"><div><strong>${esc(title)}</strong>${text ? `<p class="${CN.muted}">${esc(text)}</p>` : ''}</div>` +
    `<a class="${cls(CN.btn, CN.btnPrimary)}" href="${attr(href)}">${esc(label)}</a></div>`;
}

/** The FindUs props for a "which venue?" chooser standing in for a per venue embed. */
function chooserProps(p, cta) {
  return { id: p.id, title: 'Choose your venue', location_id: 'all', show_nearest: true, show_hours: false, show_map: true, show_order_buttons: true, cta };
}

/** The first button on a venue card: label, venue path and the channel it needs. */
const CTA = Object.freeze({
  order: { label: 'Order here', path: '/', channel: 'online' },
  catering: { label: 'Catering orders', path: '/catering', channel: 'catering' },
  book: { label: 'Book here', path: '/book', channel: 'bookings' },
});

// ── block renderers ──────────────────────────────────────────────────────────
const R = {
  Hero(ctx, b) {
    const p = b.props;
    const loc = blockLocation(ctx, p);
    const branding = (loc && loc.online_branding) || {};
    const photo = p.photo_url || branding.hero_url || '';
    const headline = p.headline || branding.display_name || (loc && loc.name) || siteName(ctx.snapshot);
    const tag = ctx.h1Used ? 'h2' : 'h1';
    ctx.h1Used = true;
    const st = p.show_status && loc ? openStatus(loc.opening_hours, loc.timezone, ctx.now) : { text: '' };
    const status = st.text ? `<div class="${cls(CN.heroStatus, st.open ? CN.open : CN.closed)}">${esc(st.text)}</div>` : '';
    // attr() turns the quotes into &quot;, which the browser decodes back to url("...") in the style.
    const style = photo ? ` style="background-image:url(${attr(JSON.stringify(photo))})"` : '';
    return `<section class="${cls(CN.block, CN.hero, p.height === 'short' ? CN.heroShort : CN.heroTall)}" data-block="Hero" data-id="${attr(p.id)}" data-photo="${photo ? 'true' : 'false'}"${style}>` +
      `<div class="${CN.heroBody}">${status}<${tag}>${esc(headline)}</${tag}>${p.sub ? `<p>${esc(p.sub)}</p>` : ''}` +
      `<div>${button(ctx, p.primary, 'primary')}${button(ctx, p.secondary, 'secondary')}</div></div></section>`;
  },
  OrderBar(ctx, b) {
    const p = b.props;
    const loc = blockLocation(ctx, p);
    const s = ctx.settings;
    const items = [
      p.collection && channelOn(s, 'online') && { label: 'Order for collection', href: 'servos:order' },
      p.delivery && channelOn(s, 'online') && { label: 'Order delivery', href: 'servos:order' },
      p.book && channelOn(s, 'bookings') && { label: 'Book a table', href: 'servos:book' },
      p.catering && channelOn(s, 'catering') && { label: 'Catering', href: 'servos:catering' },
    ].filter(Boolean);
    if (!loc || !items.length) return '';
    return section(b, CN.orderBar, items.map((it, i) => button(ctx, it, i === 0 ? 'primary' : 'secondary')).join(''));
  },
  LiveMenu(ctx, b) {
    const p = b.props;
    const menu = ctx.menu;
    const show = p.show || {};
    const layoutCn = p.layout === 'list' ? CN.menuList : p.layout === 'board' ? CN.menuBoard : CN.menuCards;
    // 5.12.8: the venue this menu is for (the visitor's pick on a default block), and the switch.
    const loc = menuLocation(ctx, p.location_id);
    const switcher = venueSwitchHtml(ctx, p, loc);
    if (!menu || !Array.isArray(menu.categories) || !menu.categories.length) {
      return section(b, cls(CN.menu, layoutCn), heading(p.title) + switcher + empty('The menu is being updated. Please check back soon.'));
    }
    let cats = menu.categories;
    const only = Array.isArray(p.categories) ? p.categories.map((c) => c && c.id).filter(Boolean) : [];
    if (only.length) cats = cats.filter((c) => only.includes(c.id));
    let left = Number(p.max_items) > 0 ? Number(p.max_items) : Infinity;
    // 5.12.9: ask which venue first unless the visitor picked one (or this is the venue's own page).
    const orderHref = show.add_button ? menuOrderHref(ctx, loc) : '';
    const sections = cats.map((c) => {
      const items = (c.items || []).filter((it) => !(show.hide_sold_out && it.sold_out)).slice(0, Math.max(0, left));
      left -= items.length;
      if (!items.length) return '';
      return `<div class="${CN.menuSection}"><h3>${esc(c.label)}</h3><div class="${CN.menuGrid}">${items.map((it) => menuItemHtml(it, show, orderHref)).join('')}</div></div>`;
    }).join('');
    return section(b, cls(CN.menu, layoutCn), heading(p.title) + switcher + (sections || empty('Nothing on the menu right now.')));
  },
  Specials(ctx, b) {
    const p = b.props;
    const menu = ctx.menu;
    if (!menu) return '';
    let items = [];
    if (p.source === 'manual') {
      const ids = (p.ids || []).map((x) => x && x.id).filter(Boolean);
      const all = (menu.categories || []).flatMap((c) => c.items || []);
      items = ids.map((id) => all.find((it) => it.id === id)).filter(Boolean);
    } else items = menu.specials || [];
    if (!items.length) return '';
    return section(b, cls(CN.menu, CN.specials, CN.menuCards), heading(p.title) + `<div class="${CN.menuGrid}">${items.map((it) => menuItemHtml(it, { prices: true, photos: true, descriptions: true, dietary: true }, '')).join('')}</div>`);
  },
  OrderEmbed(ctx, b) {
    const p = b.props;
    const catering = p.mode === 'catering';
    // Several venues and no venue named: the visitor picks first (never straight to one venue).
    if (!explicitLocation(p.location_id) && multiVenue(ctx)) return R.FindUs(ctx, { ...b, props: chooserProps(p, catering ? 'catering' : 'order') });
    const loc = blockLocation(ctx, p);
    const href = loc ? venueUrl(loc.online_slug, catering ? '/catering' : '/', ctx.customerRoot) : '';
    return section(b, CN.embed, embed(ctx, { title: catering ? 'Catering orders' : 'Order online', text: loc ? `${(loc.online_branding && loc.online_branding.display_name) || loc.name}` : '', href, label: catering ? 'Order catering' : 'Order now' }));
  },
  LoyaltyJoin(ctx, b) {
    const p = b.props;
    const loc = blockLocation(ctx, p);
    const href = loc ? venueUrl(loc.online_slug, '/account', ctx.customerRoot) : '';
    const name = (loc && ((loc.online_branding && loc.online_branding.display_name) || loc.name)) || siteName(ctx.snapshot);
    const card = p.show_card_preview ? `<div class="${CN.loyaltyCard}"><span>${esc(name)}</span><span>Loyalty card</span></div>` : '';
    return section(b, CN.loyalty, `<div>${heading(p.headline)}${p.sub ? `<p class="${CN.muted}">${esc(p.sub)}</p>` : ''}${href ? `<a class="${cls(CN.btn, CN.btnPrimary)}" href="${attr(href)}">Join free</a>` : ''}</div>${card}`);
  },
  GiftCards(ctx, b) {
    const p = b.props;
    const loc = blockLocation(ctx, p);
    const buy = loc ? venueUrl(loc.online_slug, '/gift', ctx.customerRoot) : '';
    const bal = loc ? venueUrl(loc.online_slug, '/gift/balance', ctx.customerRoot) : '';
    const name = (loc && ((loc.online_branding && loc.online_branding.display_name) || loc.name)) || siteName(ctx.snapshot);
    const art = p.show_art ? `<div class="${CN.giftArt}"><span>${esc(name)}</span><span>Gift card</span></div>` : '';
    const btns = buy ? `<div><a class="${cls(CN.btn, CN.btnPrimary)}" href="${attr(buy)}">Buy a gift card</a> <a class="${cls(CN.btn, CN.btnSecondary)}" href="${attr(bal)}">Check a balance</a></div>` : '';
    return section(b, CN.gift, `<div>${heading(p.headline)}${p.sub ? `<p class="${CN.muted}">${esc(p.sub)}</p>` : ''}${btns}</div>${art}`);
  },
  BookTable(ctx, b) {
    const p = b.props;
    if (!explicitLocation(p.location_id) && multiVenue(ctx)) return R.FindUs(ctx, { ...b, props: chooserProps(p, 'book') });
    const loc = blockLocation(ctx, p);
    const href = loc ? venueUrl(loc.online_slug, '/book', ctx.customerRoot) : '';
    return section(b, cls(CN.embed, CN.book), embed(ctx, { title: 'Book a table', text: loc ? loc.name : '', href, label: 'Book a table' }));
  },
  Waitlist(ctx, b) {
    const loc = blockLocation(ctx, b.props);
    const href = loc ? venueUrl(loc.online_slug, '/waitlist', ctx.customerRoot) : '';
    return section(b, cls(CN.embed, CN.waitlist), embed(ctx, { title: 'Join the waitlist', text: loc ? loc.name : '', href, label: 'Join the waitlist' }));
  },
  Hours(ctx, b) {
    const p = b.props;
    const locs = p.location_id === 'all' ? ctx.locations : [blockLocation(ctx, p)].filter(Boolean);
    if (!locs.length) return section(b, CN.hours, heading(p.title) + empty('Opening hours are not set yet.'));
    const body = locs.map((loc) => {
      const st = openStatus(loc.opening_hours, loc.timezone, ctx.now);
      const rows = hoursRows(loc.opening_hours, loc.timezone, { todayFirst: p.show_today_first !== false, now: ctx.now });
      return `${locs.length > 1 ? `<h3>${esc(loc.name)}</h3>` : ''}${st.text ? `<p class="${cls(CN.muted, st.open ? CN.open : CN.closed)}">${esc(st.text)}</p>` : ''}` +
        `<table class="${CN.hoursTable}"><tbody>${rows.map((r) => `<tr class="${r.today ? CN.hoursToday : ''}"><td>${esc(r.label)}</td><td>${esc(r.text)}</td></tr>`).join('')}</tbody></table>`;
    }).join('');
    return section(b, CN.hours, heading(p.title) + body);
  },
  FindUs(ctx, b) {
    const p = b.props;
    const locs = p.location_id === 'all' ? ctx.locations : [blockLocation(ctx, p)].filter(Boolean);
    if (!locs.length) return section(b, CN.findus, heading(p.title) + empty('No locations yet.'));
    const nearest = p.show_nearest && locs.length > 1 ? `<button type="button" class="${cls(CN.btn, CN.btnSecondary, CN.nearestBtn)}" data-nearest>Find my nearest</button>` : '';
    const cards = locs.map((loc) => {
      const st = openStatus(loc.opening_hours, loc.timezone, ctx.now);
      const addr = addressText(loc);
      const rows = p.show_hours ? hoursRows(loc.opening_hours, loc.timezone, { todayFirst: true, now: ctx.now }).slice(0, 7) : [];
      const dir = p.show_map ? directionsUrl(loc, ctx.settings) : '';
      const cta = CTA[p.cta] || CTA.order;
      const canMain = p.show_order_buttons && locationChannelOn(loc, ctx.settings, cta.channel);
      const actions = [
        canMain ? `<a class="${cls(CN.btn, CN.btnPrimary)}" href="${attr(venueUrl(loc.online_slug, cta.path, ctx.customerRoot))}">${esc(cta.label)}</a>` : '',
        dir ? `<a class="${cls(CN.btn, CN.btnSecondary)}" href="${attr(dir)}" target="_blank" rel="noopener">Directions</a>` : '',
        cta !== CTA.book && locationChannelOn(loc, ctx.settings, 'bookings') ? `<a class="${cls(CN.btn, CN.btnSecondary)}" href="${attr(venueUrl(loc.online_slug, '/book', ctx.customerRoot))}">Book</a>` : '',
      ].join(' ');
      return `<article class="${cls(CN.card, CN.locCard)}" data-location="${attr(loc.id)}"><h3 class="${CN.locName}"><a href="/locations/${attr(loc.online_slug)}">${esc(loc.name)}</a></h3>` +
        (addr ? `<p class="${CN.locAddr}">${esc(addr)}</p>` : '') +
        (loc.phone ? `<p><a href="tel:${attr(String(loc.phone).replace(/\s+/g, ''))}">${esc(loc.phone)}</a></p>` : '') +
        (st.text ? `<p class="${cls(CN.muted, st.open ? CN.open : CN.closed)}">${esc(st.text)}</p>` : '') +
        (rows.length ? `<table class="${CN.hoursTable}"><tbody>${rows.map((r) => `<tr class="${r.today ? CN.hoursToday : ''}"><td>${esc(r.label.slice(0, 3))}</td><td>${esc(r.text)}</td></tr>`).join('')}</tbody></table>` : '') +
        `<div class="${CN.locActions}">${actions}</div></article>`;
    }).join('');
    return section(b, CN.findus, heading(p.title) + nearest + `<div class="${CN.findusGrid}">${cards}</div>`);
  },
  Reviews(ctx, b) {
    // Reviews come from the public reviews read when one exists; the snapshot may carry a few.
    const p = b.props;
    const list = (Array.isArray(ctx.reviews) ? ctx.reviews : []).filter((r) => r && Number(r.rating) >= Number(p.min_stars || 0)).slice(0, Number(p.count) || 6);
    if (!list.length) return '';
    return section(b, CN.reviews, heading(p.title) + `<div>${list.map((r) => `<blockquote class="${cls(CN.card, CN.review)}"><div class="${CN.stars}" aria-label="${attr(r.rating)} stars">${'★'.repeat(Math.max(0, Math.min(5, Math.round(Number(r.rating) || 0))))}</div><p>${esc(r.text || r.comment || '')}</p><footer class="${CN.muted}">${esc(r.author || r.name || 'Guest')}</footer></blockquote>`).join('')}</div>`);
  },
  BlogList(ctx, b) {
    const p = b.props;
    const posts = publishedPosts(ctx.snapshot).slice(0, Number(p.count) || 3);
    if (!posts.length) return section(b, CN.blogList, heading(p.title) + empty('No posts yet.'));
    return section(b, CN.blogList, heading(p.title) + `<div>${posts.map((post) => `<a class="${cls(CN.card, CN.post)}" href="/blog/${attr(post.slug)}">` +
      (post.cover_url ? `<img class="${CN.postCover}" src="${attr(post.cover_url)}" alt="" loading="lazy">` : '') +
      `<h3>${esc(post.title)}</h3>${post.published_at ? `<div class="${CN.postMeta}">${esc(dateText(post.published_at))}</div>` : ''}` +
      (p.show_excerpt && (post.excerpt || post.body_md) ? `<p class="${CN.muted}">${esc(post.excerpt || markdownToText(post.body_md, 160))}</p>` : '') + '</a>').join('')}</div>`);
  },
  Text(ctx, b) {
    const html = renderMarkdown(b.props.md);
    return html ? section(b, CN.text, `<div class="${CN.prose}">${html}</div>`) : '';
  },
  Columns(ctx, b) {
    const p = b.props;
    const items = (p.items || []).map((i) => renderMarkdown(i && i.md)).filter(Boolean);
    if (!items.length) return '';
    return section(b, cls(CN.columns, String(p.cols) === '3' ? CN.cols3 : CN.cols2), items.map((h) => `<div class="${CN.prose}">${h}</div>`).join(''));
  },
  Row(ctx, b) {
    // 5.12.9: columns the owner drops blocks into, with row and column backgrounds (rowPlan.js is the
    // one source of the attributes and style variables, shared with the React Row). One level deep:
    // a Row inside a Row paints nothing. A junk column (not a list) paints an empty column.
    if (b.nested) return '';
    const p = b.props;
    const plan = rowPlan(p);
    const cols = [];
    for (let i = 1; i <= plan.cols; i++) {
      const items = Array.isArray(p[`col${i}`]) ? p[`col${i}`] : [];
      const bg = plan.colBg[i - 1];
      const inner = items.map((c) => renderBlock(ctx, c, { nested: true })).join('');
      cols.push(`<div class="${CN.rowCol}" data-col="${i}" data-bg="${bg ? 'true' : 'false'}"${bg ? ` style="--w-col-bg:${attr(bg)}"` : ''}>${inner}</div>`);
    }
    // attr() turns the quotes in url("...") into &quot;, which the browser decodes back in the style.
    return `<section class="${cls(CN.block, CN.row)}" data-block="Row" data-id="${attr(p.id)}" data-cols="${plan.cols}" data-full="${plan.full ? 'true' : 'false'}"` +
      `${plan.tone ? ` data-tone="${plan.tone}"` : ''} data-gap="${plan.gap}" data-pad="${plan.pad}" data-align="${plan.align}" data-bg="${plan.hasBg ? 'true' : 'false'}" data-darken="${plan.darken ? 'true' : 'false'}"` +
      ` style="${attr(styleText(plan.style))}"><div class="${cls(CN.inner, CN.rowGrid)}">${cols.join('')}</div></section>`;
  },
  Gallery(ctx, b) {
    const p = b.props;
    const photos = (p.photos || []).filter((ph) => ph && /^https?:\/\//i.test(String(ph.url || '')));
    if (!photos.length) return '';
    const cols = Math.max(1, Math.min(4, Number(p.cols) || 3));
    return section(b, CN.gallery, heading(p.title) + `<div style="--w-gallery-cols:${cols}">${photos.map((ph) => `<img src="${attr(ph.url)}" alt="${attr(ph.alt || '')}" loading="lazy">`).join('')}</div>`);
  },
  Button(ctx, b) {
    const html = button(ctx, { label: b.props.label, href: b.props.href }, b.props.style);
    return html ? section(b, '', html) : '';
  },
  FAQ(ctx, b) {
    const p = b.props;
    const items = (p.items || []).filter((i) => i && i.q && i.a);
    if (!items.length) return '';
    ctx.faqItems = (ctx.faqItems || []).concat(items);
    return section(b, CN.faq, heading(p.title) + items.map((i) => `<details class="${CN.faqItem}"><summary>${esc(i.q)}</summary><div>${renderMarkdown(i.a)}</div></details>`).join(''));
  },
  Instagram(ctx, b) {
    const handle = String(b.props.handle || '').replace(/^@/, '').trim();
    if (!/^[a-z0-9._]{1,30}$/i.test(handle)) return '';
    return section(b, CN.instagram, `<a class="${cls(CN.btn, CN.btnSecondary)}" href="https://www.instagram.com/${attr(handle)}" target="_blank" rel="noopener">Follow @${esc(handle)} on Instagram</a>`);
  },
  Divider(ctx, b) { return `<div class="${cls(CN.block, CN.divider)}" data-block="Divider" data-id="${attr(b.props.id)}"><div class="${CN.inner}"><hr></div></div>`; },
  Spacer(ctx, b) {
    const s = b.props.size === 's' ? CN.spacerS : b.props.size === 'l' ? CN.spacerL : CN.spacerM;
    return `<div class="${cls(CN.spacer, s)}" data-block="Spacer" data-id="${attr(b.props.id)}"></div>`;
  },
  CustomHtml(ctx, b) {
    // Owner only switch (settings.allow_custom_code); routes.blockVisible already hid it otherwise.
    return `<div class="${cls(CN.block, CN.customHtml)}" data-block="CustomHtml" data-id="${attr(b.props.id)}"><div class="${CN.inner}">${String(b.props.html || '')}</div></div>`;
  },
};

function menuItemHtml(it, show, orderHref) {
  const badges = show.dietary !== false && it.dietary && it.dietary.length ? `<div class="${CN.menuBadges}">${it.dietary.map((d) => `<span class="${CN.badge}" title="${attr(DIET_WORDS[d] || d)}">${esc(d)}</span>`).join('')}</div>` : '';
  const allergens = show.allergens && it.allergens && it.allergens.length ? `<p class="${CN.menuAllergens}">Contains: ${esc(it.allergens.join(', '))}</p>` : '';
  const price = show.prices !== false && it.price > 0 ? `<div class="${CN.menuPrice}">${it.from ? 'from ' : ''}${esc(formatPrice(it.price, it.currency))}</div>` : '';
  const photo = show.photos !== false && it.image ? `<img class="${CN.menuPhoto}" src="${attr(it.image)}" alt="${attr(it.name)}" loading="lazy">` : '';
  const desc = show.descriptions !== false && it.description ? `<p class="${CN.menuDesc}">${esc(it.description)}</p>` : '';
  const sold = it.sold_out ? `<span class="${CN.soldOut}">Sold out today</span>` : '';
  const add = orderHref && !it.sold_out ? `<a class="${cls(CN.btn, CN.btnSecondary)}" href="${attr(orderHref)}">Order</a>` : '';
  // 5.12.9: the card is a button that opens the item sheet once React mounts (same attributes there).
  return `<article class="${cls(CN.menuItem, it.sold_out && CN.menuItemSoldOut)}" data-item="${attr(it.id)}" role="button" tabindex="0" aria-haspopup="dialog">${photo}<div><h4 class="${CN.menuName}">${esc(it.name)}</h4>${desc}${badges}${allergens}${sold}</div><div>${price}${add}</div></article>`;
}

function dateText(iso) {
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; }
}

/**
 * One block → HTML. Unknown or hidden blocks give ''. A renderer that throws gives '' (never a crash).
 * 5.12.9: `nested` marks a block inside a Row column (section() paints data-nested, a Row paints nothing).
 */
export function renderBlock(ctx, block, { nested = false } = {}) {
  if (!block || typeof block !== 'object' || !R[block.type]) return '';
  const b = { type: block.type, props: normaliseProps(block.type, block.props), nested: nested === true };
  if (!blockVisible(b, ctx.settings)) return '';
  try { return R[block.type](ctx, b) || ''; } catch { return ''; }
}

// ── page chrome ──────────────────────────────────────────────────────────────
/** 5.12.8: the header button the owner chose (settings.header.cta): label + href, or null. */
export function headerCta(ctx) {
  const { cta } = headerOptions(ctx.settings);
  if (cta === 'none') return null;
  const href = resolveHref(ctx, `servos:${cta}`);
  return href ? { label: HEADER_CTA_LABELS[cta], href } : null;
}

export function renderHeader(ctx) {
  const loc = pickLocation(ctx, 'default');
  const branding = (loc && loc.online_branding) || {};
  const name = siteName(ctx.snapshot);
  const opts = headerOptions(ctx.settings);
  // 5.12.8: the owner chooses the brand mark: the logo (name when there is none), the name, or both.
  const img = branding.logo_url && opts.brand !== 'name' ? `<img src="${attr(branding.logo_url)}" alt="${attr(name)}">` : '';
  const text = !img || opts.brand === 'both' ? `<span>${esc(name)}</span>` : '';
  const logo = img + text;
  const nav = visibleNav(ctx.snapshot);
  const cta = headerCta(ctx);
  const links = nav.map((n) => `<a class="${CN.navLink}" href="${attr(resolveHref(ctx, n.href))}"${n.href === ctx.path ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('') +
    (cta ? `<a class="${cls(CN.navLink, CN.headerCta)}" href="${attr(cta.href)}">${esc(cta.label)}</a>` : '');
  return `<header class="${CN.header}"${opts.sticky ? '' : ' data-sticky="false"'}><div class="${CN.inner}"><a class="${CN.logo}" href="/" aria-label="${attr(name)} home">${logo}</a>` +
    `<button type="button" class="${CN.navToggle}" aria-expanded="false" aria-controls="w-nav">Menu</button>` +
    `<nav id="w-nav" class="${CN.nav}" aria-label="Site">${links}</nav></div></header>`;
}

export function renderFooter(ctx) {
  const f = ctx.site.footer || {};
  const links = (Array.isArray(f.links) ? f.links : []).filter((l) => l && l.label && l.href)
    .map((l) => `<li><a href="${attr(resolveHref(ctx, l.href))}">${esc(l.label)}</a></li>`).join('');
  const social = [
    f.instagram && `<li><a href="https://www.instagram.com/${attr(String(f.instagram).replace(/^@/, ''))}" rel="noopener">Instagram</a></li>`,
    f.facebook && `<li><a href="${attr(f.facebook)}" rel="noopener">Facebook</a></li>`,
    f.email && `<li><a href="mailto:${attr(f.email)}">${esc(f.email)}</a></li>`,
    f.phone && `<li><a href="tel:${attr(String(f.phone).replace(/\s+/g, ''))}">${esc(f.phone)}</a></li>`,
  ].filter(Boolean).join('');
  const powered = f.show_powered_by !== false ? `<div class="${CN.powered}">Powered by <a href="https://serv-os.app" rel="noopener">ServOS</a></div>` : '';
  const text = f.text ? `<div>${esc(f.text)}</div>` : `<div>© ${new Date(ctx.now || Date.now()).getFullYear()} ${esc(siteName(ctx.snapshot))}</div>`;
  return `<footer class="${CN.footer}"><div class="${CN.inner}">${text}${links || social ? `<ul class="${CN.footerLinks}">${links}${social}</ul>` : ''}${powered}</div></footer>`;
}

function breadcrumbHtml(crumbs) {
  if (!crumbs || crumbs.length < 2) return '';
  return `<nav class="${cls(CN.inner, CN.breadcrumb)}" aria-label="Breadcrumb">${crumbs.map((c, i) => i < crumbs.length - 1 ? `<a href="${attr(c.path)}">${esc(c.name)}</a> › ` : `<span>${esc(c.name)}</span>`).join('')}</nav>`;
}

/** Build the render context every renderer reads. */
export function buildCtx({ snapshot, host, path, menu, reviews, customerRoot, now, menuVenue, pageKind }) {
  const site = (snapshot && snapshot.site) || {};
  const locations = siteLocations(snapshot);
  return {
    snapshot: snapshot || { site: {}, pages: [], posts: [], locations: [] },
    site, settings: site.settings || {}, pages: publishedPages(snapshot), locations,
    // 5.12.8: the venue the visitor picked for menus (?venue=<slug>), honoured by unpinned menu blocks.
    menuVenue: menuVenue ? String(menuVenue).toLowerCase() : null,
    // 5.12.9: the kind of page being painted ('location' = a venue's own page: no switch, no pick).
    pageKind: pageKind || null,
    host: String(host || ''), path: path || '/', menu: menu || null, reviews: reviews || [],
    customerRoot: customerRoot || 'serv-os.app', now: now instanceof Date ? now : new Date(), h1Used: false, faqItems: [],
  };
}

function metaTag(name, content) { return content ? `<meta name="${attr(name)}" content="${attr(content)}">` : ''; }

/**
 * A meta description for a page that has none (a page added by hand in the editor, or a site built
 * before the designer ran): the Hero's sub line, else the first Text block, else a plain sentence.
 * Every page carries one, so Google never writes its own snippet and shared links always show text.
 */
export function fallbackDescription(page, name) {
  const blocks = walkBlocks(page && page.layout);
  const hero = blocks.find((b) => b.type === 'Hero' && b.props && typeof b.props.sub === 'string' && b.props.sub.trim());
  if (hero) return hero.props.sub.trim().slice(0, 155);
  const text = blocks.find((b) => b.type === 'Text' && b.props && typeof b.props.md === 'string' && b.props.md.trim());
  if (text) { const t = markdownToText(text.props.md, 155); if (t) return t; }
  return `${name}: menu, opening hours and online ordering.`;
}
function ogTag(prop, content) { return content ? `<meta property="${attr(prop)}" content="${attr(content)}">` : ''; }

/**
 * renderPage({snapshot, page, menu, locations, posts, path, host, route, customerRoot, now, status, preview})
 *   → { head, body, jsonld, title, description, noindex, canonical }
 * `route` (from routes.resolveRoute) picks post or location rendering; without it the page renders.
 * `preview` (or status 'draft', or a snapshot marked preview) renders noindex: a shared /preview
 * link must never be indexed in place of the live page.
 */
export function renderPage(args) {
  const { snapshot, path = '/', host = '', route, menu, reviews, customerRoot, now, status, menuVenue } = args || {};
  const preview = !!(args && (args.preview === true || status === 'draft' || (snapshot && snapshot.preview === true)));
  const page = (route && route.page) || args.page || null;
  const ctx = buildCtx({ snapshot, host, path, menu, reviews, customerRoot, now, menuVenue, pageKind: page ? page.kind : null });
  const post = route && route.kind === 'post' ? route.post : null;
  const kind = route ? route.kind : (page ? 'page' : 'notfound');
  const crumbs = breadcrumbsFor(route || { kind: page ? 'page' : 'notfound', page, path }, snapshot);
  const name = siteName(snapshot);
  const seoSite = ctx.site.seo || {};
  const seoPage = (page && page.seo) || {};

  // ── body ──
  let main = '';
  const jsonld = [];
  if (kind === 'notfound' || !page) {
    main = `<div class="${cls(CN.inner, CN.notFound)}"><h1>Page not found</h1><p class="${CN.muted}">That page is not here. <a href="/">Go to the home page</a>.</p></div>`;
    ctx.h1Used = true;
  } else if (kind === 'post' && post) {
    const body = renderMarkdown(post.body_md);
    main = breadcrumbHtml(crumbs) + `<article class="${cls(CN.block, CN.post)}"><div class="${CN.inner}">` +
      (post.cover_url ? `<img class="${CN.postCover}" src="${attr(post.cover_url)}" alt="">` : '') +
      `<h1>${esc(post.title)}</h1><div class="${CN.postMeta}">${esc([post.author, post.published_at && dateText(post.published_at)].filter(Boolean).join(' · '))}</div>` +
      `<div class="${cls(CN.prose, CN.postBody)}">${body || empty('This post has no text yet.')}</div></div></article>`;
    ctx.h1Used = true;
    jsonld.push(blogPostingLd(post, snapshot, host));
  } else {
    const blocks = layoutBlocks(page.layout);
    const heroFirst = blocks.length && blocks[0].type === 'Hero';
    const parts = blocks.map((b) => renderBlock(ctx, b));
    // Every page has exactly one h1: the first Hero's headline, else the page title above the blocks.
    const titleH1 = ctx.h1Used ? '' : `<div class="${CN.inner}"><h1>${esc(page.title || name)}</h1></div>`;
    if (titleH1) ctx.h1Used = true;
    const crumbHtml = path !== '/' ? breadcrumbHtml(crumbs) : '';
    main = heroFirst ? parts[0] + crumbHtml + titleH1 + parts.slice(1).join('') : crumbHtml + titleH1 + parts.join('');
    if (!blocks.length) main += empty('This page is being written.');
  }
  const body = `<div class="${CN.site}" data-layout="${attr((ctx.site.theme && ctx.site.theme.layout) || 'ember')}">${renderHeader(ctx)}<main class="${CN.main}" id="w-main">${main}</main>${renderFooter(ctx)}</div>`;

  // ── JSON-LD ──
  if (path === '/') { jsonld.push(organizationLd(snapshot, host), webSiteLd(snapshot, host)); }
  const isHome = path === '/';
  const wantsRestaurant = isHome || kind === 'location' || (page && page.kind === 'findus');
  if (wantsRestaurant) {
    const locs = kind === 'location' && route.location ? [route.location] : ctx.locations;
    for (const l of locs) jsonld.push(restaurantLd(l, { snapshot, host, customerRoot: ctx.customerRoot }));
  }
  if (page && menu && walkBlocks(page.layout).some((b) => b.type === 'LiveMenu')) jsonld.push(menuLd(menu, { host, name: `${name} menu` }));
  if (crumbs.length > 1) jsonld.push(breadcrumbLd(crumbs, host));
  if (ctx.faqItems.length) jsonld.push(faqLd(ctx.faqItems));
  const ld = jsonld.filter(Boolean);

  // ── head ──
  const pageTitle = post ? `${post.title} | ${name}` : (seoPage.title || (page && path !== '/' ? `${page.title} | ${name}` : (seoSite.title || name)));
  const description = post ? (post.excerpt || markdownToText(post.body_md, 155) || fallbackDescription(null, name)) : (seoPage.description || seoSite.description || fallbackDescription(page, name));
  const ogImage = (post && post.cover_url) || seoPage.og_image_url || seoSite.og_image_url || (ctx.locations[0] && ctx.locations[0].online_branding && ctx.locations[0].online_branding.hero_url) || '';
  // The custom domain is the canonical only once its DNS is live (site.domain_live from the public
  // row) or when the request already came on it; a domain typed but not pointed yet would send
  // Google to a host that does not answer (hostParse.canonicalHost).
  const canonicalHostName = canonicalHost(ctx.site, host);
  const canonical = canonicalHostName ? `https://${canonicalHostName}${path === '/' ? '/' : path}` : '';
  const offline = status === 'offline' || ctx.site.status === 'offline';
  // A page for a channel the venue switched off stays reachable but is kept out of Google.
  const channelOff = !!(page && PAGE_KIND_CHANNEL[page.kind] && !channelOn(ctx.settings, PAGE_KIND_CHANNEL[page.kind]));
  const noindex = offline || preview || kind === 'notfound' || channelOff || !!seoPage.noindex || !!(post && post.noindex);
  const vars = siteVars(ctx.site.theme, (pickLocation(ctx, 'default') || {}).online_branding);
  const loc0 = pickLocation(ctx, 'default');
  const favicon = ctx.settings.favicon_url || (loc0 && loc0.online_branding && loc0.online_branding.logo_url) || '';
  const customHead = ctx.settings.allow_custom_code === true && typeof ctx.settings.custom_head_html === 'string' ? ctx.settings.custom_head_html : '';
  const head = [
    `<title>${esc(pageTitle)}</title>`,
    metaTag('description', description),
    noindex ? metaTag('robots', 'noindex, nofollow') : metaTag('robots', 'index, follow, max-image-preview:large'),
    canonical ? `<link rel="canonical" href="${attr(canonical)}">` : '',
    ogTag('og:type', post ? 'article' : 'website'), ogTag('og:site_name', name), ogTag('og:title', pageTitle), ogTag('og:description', description), ogTag('og:url', canonical), ogTag('og:image', ogImage),
    ogTag('og:locale', (seoSite.locale || 'en_GB')),
    metaTag('twitter:card', ogImage ? 'summary_large_image' : 'summary'), metaTag('twitter:title', pageTitle), metaTag('twitter:description', description), metaTag('twitter:image', ogImage),
    metaTag('theme-color', themeColor(vars)),
    metaTag('google-site-verification', seoSite.google_site_verification),
    favicon ? `<link rel="icon" href="${attr(favicon)}">` : '',
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    ...fontLinks(ctx.site.theme).map((h) => `<link rel="stylesheet" href="${attr(h)}">`),
    `<style id="w-theme">${cssText(vars)}</style>`,
    `<style id="w-css">${SITE_CSS}</style>`,
    ...ld.map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`),
    customHead,
  ].filter(Boolean).join('\n');

  return { head, body, jsonld: ld, title: pageTitle, description, noindex, preview, canonical, vars };
}

/** A whole minimal HTML document (the fallback when the SPA shell cannot be fetched). */
export function renderDocument({ head, body, snapshot, path, lang = 'en' }) {
  const boot = snapshot ? `<script>window.__SERVOS_SITE__=${JSON.stringify({ snapshot, path }).replace(/</g, '\\u003c')}</script>` : '';
  return `<!doctype html><html lang="${attr(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body><div id="root">${body}</div>${boot}</body></html>`;
}

export function renderSitemap(snapshot, host) {
  const origin = `https://${String(host || '').replace(/\/$/, '')}`;
  const urls = sitemapPaths(snapshot).map((u) => `<url><loc>${esc(origin + u.path)}</loc>${u.lastmod ? `<lastmod>${esc(String(u.lastmod).slice(0, 10))}</lastmod>` : ''}</url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

export function renderRobots(host, { offline = false } = {}) {
  const origin = `https://${String(host || '').replace(/\/$/, '')}`;
  if (offline) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\nDisallow: /preview\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`;
}

/** The "no site here" page for an unknown host. */
export function renderNoSite(host) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No site here</title><meta name="robots" content="noindex"></head><body style="font-family:system-ui,sans-serif;padding:48px 16px;text-align:center"><h1>No site here</h1><p>There is no website set up for ${esc(host || 'this address')} yet.</p></body></html>`;
}

export { pathForPage, siteName };
