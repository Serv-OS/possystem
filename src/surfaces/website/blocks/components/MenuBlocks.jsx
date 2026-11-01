// src/surfaces/website/blocks/components/MenuBlocks.jsx
// LiveMenu and Specials in React. The menu itself comes from SiteContext (WebsiteSurface loads it
// with data/loadMenu.js and refreshes it on the 86 channel); these components only lay it out.

import { useCallback, useRef, useState } from 'react';
import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { multiVenue, menuLocation, menuVenues, menuOrderHref, onVenuePage } from '../../resolveHref.js';
import { formatPrice, capCategories } from '../../data/loadMenu.js';
import { findUsPath } from '../../routes.js';
import { A } from '../../Link.jsx';
import { isActivationKey } from '../itemSheet.js';
import { useNested } from '../nested.js';
import { ItemSheet } from './ItemSheet.jsx';

const cls = (...xs) => xs.filter(Boolean).join(' ');
const DIET_WORDS = { V: 'Vegetarian', VG: 'Vegan', GF: 'Gluten free', DF: 'Dairy free' };

function Section({ type, id, className, children }) {
  // 5.12.9: inside a Row column the block is marked nested (same attribute as the SSR section()).
  const nested = useNested();
  return <section className={cls(CN.block, className)} data-block={type} data-id={id} data-nested={nested ? 'true' : undefined}><div className={CN.inner}>{children}</div></section>;
}
export function Empty({ children }) { return <p className={CN.empty}>{children}</p>; }

/**
 * 5.12.9: one menu card. A tap (or Enter / Space) opens the item sheet through onOpen(item, cardEl);
 * the markup, attribute order included, matches the server's menuItemHtml so nothing moves on
 * mount. The card's own Order link still goes straight to ordering and never opens the sheet.
 */
export function MenuItem({ it, show = {}, orderHref = '', onOpen }) {
  const open = (e) => { if (typeof onOpen === 'function') onOpen(it, e.currentTarget); };
  const onKeyDown = (e) => { if (isActivationKey(e)) { e.preventDefault(); open(e); } };
  const stop = (e) => e.stopPropagation();
  return (
    <article className={cls(CN.menuItem, it.sold_out && CN.menuItemSoldOut)} data-item={it.id} role="button" tabIndex={0} aria-haspopup="dialog" onClick={open} onKeyDown={onKeyDown}>
      {show.photos !== false && it.image ? <img className={CN.menuPhoto} src={it.image} alt={it.name} loading="lazy" /> : null}
      <div>
        <h4 className={CN.menuName}>{it.name}</h4>
        {show.descriptions !== false && it.description ? <p className={CN.menuDesc}>{it.description}</p> : null}
        {show.dietary !== false && it.dietary && it.dietary.length ? (
          <div className={CN.menuBadges}>{it.dietary.map((d) => <span key={d} className={CN.badge} title={DIET_WORDS[d] || d}>{d}</span>)}</div>
        ) : null}
        {show.allergens && it.allergens && it.allergens.length ? <p className={CN.menuAllergens}>Contains: {it.allergens.join(', ')}</p> : null}
        {it.sold_out ? <span className={CN.soldOut}>Sold out today</span> : null}
      </div>
      <div>
        {show.prices !== false && it.price > 0 ? <div className={CN.menuPrice}>{it.from ? 'from ' : ''}{formatPrice(it.price, it.currency)}</div> : null}
        {orderHref && !it.sold_out ? <a className={cls(CN.btn, CN.btnSecondary)} href={orderHref} rel="noopener" onClick={stop} onKeyDown={stop}>Order</a> : null}
      </div>
    </article>
  );
}

/**
 * 5.12.8 (Peter, 1 Nov): the venue switch above a menu on a site with several venues. Same markup
 * as the server's venueSwitchHtml; a pick sets the venue in the site context (and ?venue= in the
 * address bar) and the page's menu reloads for that venue.
 */
export function VenueSwitch({ mode, location_id, current }) {
  const { ctx, setMenuVenue } = useSite();
  void location_id; // the block's venue is only the starting venue (5.12.9); the switch shows regardless
  if (mode === 'none' || onVenuePage(ctx) || !multiVenue(ctx)) return null;
  const venues = menuVenues(ctx);
  if (venues.length < 2) return null;
  const path = ctx.path || '/';
  const isCurrent = (l) => !!(current && l.id === current.id);
  if (mode === 'dropdown') {
    const value = (venues.find(isCurrent) || venues[0]).online_slug;
    return (
      <form className={CN.venueForm} method="get" action={path} onSubmit={(e) => e.preventDefault()}>
        <label>Menu for <select name="venue" aria-label="Choose a venue" value={value} onChange={(e) => setMenuVenue(e.target.value)}>
          {venues.map((l) => <option key={l.id} value={l.online_slug}>{l.name || l.online_slug} menu</option>)}
        </select></label>
      </form>
    );
  }
  return (
    <nav className={CN.venueSwitch} aria-label="Choose a venue">
      {venues.map((l) => (
        <a key={l.id} className={CN.venueBtn} href={`${path}?venue=${encodeURIComponent(l.online_slug)}`} aria-current={isCurrent(l) ? 'true' : undefined}
          onClick={(e) => { e.preventDefault(); setMenuVenue(l.online_slug); }}>{l.name || l.online_slug} menu</a>
      ))}
    </nav>
  );
}

/**
 * 5.12.9: which item's sheet is open for one menu block, and focus back to the card on close.
 * Returns [sheetProps or null, openSheet]. Plain hook (no component) so fast refresh stays happy.
 */
function useItemSheet(locationId) {
  const [item, setItem] = useState(null);
  const openerRef = useRef(null);
  const openSheet = useCallback((it, el) => { openerRef.current = el || null; setItem(it || null); }, []);
  const closeSheet = useCallback(() => {
    setItem(null);
    const el = openerRef.current;
    openerRef.current = null;
    if (el && typeof el.focus === 'function' && el.isConnected !== false) { try { el.focus(); } catch { /* the card went away */ } }
  }, []);
  const sheet = item ? <ItemSheet item={item} locationId={locationId} onClose={closeSheet} /> : null;
  return [sheet, openSheet];
}

export function LiveMenu({ id, title, categories, layout, show = {}, max_items, location_id, venue_switch = 'buttons', button = null }) {
  const { ctx, menu, menuLoading } = useSite();
  const [sheet, openSheet] = useItemSheet(location_id);
  const layoutCn = layout === 'list' ? CN.menuList : layout === 'board' ? CN.menuBoard : CN.menuCards;
  const head = title ? <h2 className={CN.h2}>{title}</h2> : null;
  // 5.12.8: the venue this menu is for (the visitor's pick on an unpinned block) and its switch.
  const loc = menuLocation(ctx, location_id);
  const switcher = <VenueSwitch mode={venue_switch} location_id={location_id} current={loc} />;
  if (!menu || !menu.categories || !menu.categories.length) {
    return <Section type="LiveMenu" id={id} className={cls(CN.menu, layoutCn)}>{head}{switcher}<Empty>{menuLoading ? 'Loading the menu…' : 'The menu is being updated. Please check back soon.'}</Empty></Section>;
  }
  const only = Array.isArray(categories) ? categories.map((c) => c && c.id).filter(Boolean) : [];
  const cats = only.length ? menu.categories.filter((c) => only.includes(c.id)) : menu.categories;
  // 5.12.9: ask which venue first unless the visitor picked one (or this is the venue's own page).
  const orderHref = show.add_button ? menuOrderHref(ctx, loc) : '';
  const sections = capCategories(cats, show.hide_sold_out, max_items).map((c) => (
    <div key={c.id} className={CN.menuSection}>
      <h3>{c.label}</h3>
      <div className={CN.menuGrid}>{c.items.map((it) => <MenuItem key={it.id} it={it} show={show} orderHref={orderHref} onOpen={openSheet} />)}</div>
    </div>
  ));
  // 5.12.12: a button under the menu (owner's words) and "Find my local store" to the Find us page.
  const under = (button && button.label) || show.store_finder ? (
    <div className={CN.menuMore}>
      {button && button.label ? <A className={cls(CN.btn, CN.btnSecondary)} href={button.href}>{button.label}</A> : null}
      {show.store_finder ? <A className={cls(CN.btn, CN.btnSecondary)} href={findUsPath(ctx.snapshot)}>Find my local store</A> : null}
    </div>
  ) : null;
  return <Section type="LiveMenu" id={id} className={cls(CN.menu, layoutCn)}>{head}{switcher}{sections.length ? sections : <Empty>Nothing on the menu right now.</Empty>}{under}{sheet}</Section>;
}

export function Specials({ id, title, source, ids, button = null }) {
  const { menu } = useSite();
  const [sheet, openSheet] = useItemSheet(undefined);
  if (!menu) return null;
  let items = [];
  if (source === 'manual') {
    const want = (ids || []).map((x) => x && x.id).filter(Boolean);
    const all = (menu.categories || []).flatMap((c) => c.items || []);
    items = want.map((w) => all.find((it) => it.id === w)).filter(Boolean);
  } else items = menu.specials || [];
  if (!items.length) return null;
  return (
    <Section type="Specials" id={id} className={cls(CN.menu, CN.specials, CN.menuCards)}>
      {title ? <h2 className={CN.h2}>{title}</h2> : null}
      <div className={CN.menuGrid}>{items.map((it) => <MenuItem key={it.id} it={it} show={{ prices: true, photos: true, descriptions: true, dietary: true }} onOpen={openSheet} />)}</div>
      {button && button.label ? <div className={CN.menuMore}><A className={cls(CN.btn, CN.btnSecondary)} href={button.href}>{button.label}</A></div> : null}
      {sheet}
    </Section>
  );
}
