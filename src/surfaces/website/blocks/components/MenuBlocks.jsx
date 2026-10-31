// src/surfaces/website/blocks/components/MenuBlocks.jsx
// LiveMenu and Specials in React. The menu itself comes from SiteContext (WebsiteSurface loads it
// with data/loadMenu.js and refreshes it on the 86 channel); these components only lay it out.

import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { pickLocation, venueUrl } from '../../resolveHref.js';
import { formatPrice, capCategories } from '../../data/loadMenu.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');
const DIET_WORDS = { V: 'Vegetarian', VG: 'Vegan', GF: 'Gluten free', DF: 'Dairy free' };

function Section({ type, id, className, children }) {
  return <section className={cls(CN.block, className)} data-block={type} data-id={id}><div className={CN.inner}>{children}</div></section>;
}
export function Empty({ children }) { return <p className={CN.empty}>{children}</p>; }

export function MenuItem({ it, show = {}, orderHref = '' }) {
  return (
    <article className={cls(CN.menuItem, it.sold_out && CN.menuItemSoldOut)} data-item={it.id}>
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
        {orderHref && !it.sold_out ? <a className={cls(CN.btn, CN.btnSecondary)} href={orderHref} rel="noopener">Order</a> : null}
      </div>
    </article>
  );
}

export function LiveMenu({ id, title, categories, layout, show = {}, max_items, location_id }) {
  const { ctx, menu, menuLoading } = useSite();
  const layoutCn = layout === 'list' ? CN.menuList : layout === 'board' ? CN.menuBoard : CN.menuCards;
  const head = title ? <h2 className={CN.h2}>{title}</h2> : null;
  if (!menu || !menu.categories || !menu.categories.length) {
    return <Section type="LiveMenu" id={id} className={cls(CN.menu, layoutCn)}>{head}<Empty>{menuLoading ? 'Loading the menu…' : 'The menu is being updated. Please check back soon.'}</Empty></Section>;
  }
  const only = Array.isArray(categories) ? categories.map((c) => c && c.id).filter(Boolean) : [];
  const cats = only.length ? menu.categories.filter((c) => only.includes(c.id)) : menu.categories;
  const loc = pickLocation(ctx, location_id);
  const orderHref = show.add_button && loc ? venueUrl(loc.online_slug, '/', ctx.customerRoot) : '';
  const sections = capCategories(cats, show.hide_sold_out, max_items).map((c) => (
    <div key={c.id} className={CN.menuSection}>
      <h3>{c.label}</h3>
      <div className={CN.menuGrid}>{c.items.map((it) => <MenuItem key={it.id} it={it} show={show} orderHref={orderHref} />)}</div>
    </div>
  ));
  return <Section type="LiveMenu" id={id} className={cls(CN.menu, layoutCn)}>{head}{sections.length ? sections : <Empty>Nothing on the menu right now.</Empty>}</Section>;
}

export function Specials({ id, title, source, ids }) {
  const { menu } = useSite();
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
      <div className={CN.menuGrid}>{items.map((it) => <MenuItem key={it.id} it={it} show={{ prices: true, photos: true, descriptions: true, dietary: true }} />)}</div>
    </Section>
  );
}
