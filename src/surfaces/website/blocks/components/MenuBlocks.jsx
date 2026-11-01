// src/surfaces/website/blocks/components/MenuBlocks.jsx
// LiveMenu and Specials in React. The menu itself comes from SiteContext (WebsiteSurface loads it
// with data/loadMenu.js and refreshes it on the 86 channel); these components only lay it out.

import { useCallback, useRef, useState } from 'react';
import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { resolveHref, explicitLocation, multiVenue, menuLocation, menuVenues } from '../../resolveHref.js';
import { formatPrice, capCategories } from '../../data/loadMenu.js';
import { isActivationKey } from '../itemSheet.js';
import { ItemSheet } from './ItemSheet.jsx';

const cls = (...xs) => xs.filter(Boolean).join(' ');
const DIET_WORDS = { V: 'Vegetarian', VG: 'Vegan', GF: 'Gluten free', DF: 'Dairy free' };

function Section({ type, id, className, children }) {
  return <section className={cls(CN.block, className)} data-block={type} data-id={id}><div className={CN.inner}>{children}</div></section>;
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
  if (mode === 'none' || explicitLocation(location_id) || !multiVenue(ctx)) return null;
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

export function LiveMenu({ id, title, categories, layout, show = {}, max_items, location_id, venue_switch = 'buttons' }) {
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
  // The order button goes to the venue whose menu this is, never to another venue.
  const orderHref = show.add_button && loc ? resolveHref(ctx, `servos:order:${loc.id}`) : '';
  const sections = capCategories(cats, show.hide_sold_out, max_items).map((c) => (
    <div key={c.id} className={CN.menuSection}>
      <h3>{c.label}</h3>
      <div className={CN.menuGrid}>{c.items.map((it) => <MenuItem key={it.id} it={it} show={show} orderHref={orderHref} onOpen={openSheet} />)}</div>
    </div>
  ));
  return <Section type="LiveMenu" id={id} className={cls(CN.menu, layoutCn)}>{head}{switcher}{sections.length ? sections : <Empty>Nothing on the menu right now.</Empty>}{sheet}</Section>;
}

export function Specials({ id, title, source, ids }) {
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
      {sheet}
    </Section>
  );
}
