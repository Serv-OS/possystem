// src/surfaces/website/blocks/components/EmbedBlocks.jsx
// The ServOS surfaces embedded in the site: OrderBar, OrderEmbed, LoyaltyJoin, GiftCards,
// BookTable, Waitlist. Each is a link card plus an iframe of the venue's existing customer URL
// (resolveHref venueUrl, so the same link the SSR wrote), never a copy of those surfaces.

import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { A } from '../../Link.jsx';
import { pickLocation, venueUrl } from '../../resolveHref.js';
import { channelOn } from '../../routes.js';
import { siteName } from '../../ssr/jsonld.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');
function Section({ type, id, className, children }) {
  return <section className={cls(CN.block, className)} data-block={type} data-id={id}><div className={CN.inner}>{children}</div></section>;
}
const Empty = ({ children }) => <p className={CN.empty}>{children}</p>;

export function Embed({ title, text, href, height, label = 'Open in a new tab' }) {
  if (!href) return <Empty>{title} is not set up yet.</Empty>;
  const h = Math.max(400, Math.min(3000, Number(height) || 900));
  return (
    <>
      <div className={cls(CN.card, CN.embedCard)}>
        <div><strong>{title}</strong>{text ? <p className={CN.muted}>{text}</p> : null}</div>
        <a className={cls(CN.btn, CN.btnSecondary)} href={href} target="_blank" rel="noopener">{label}</a>
      </div>
      <iframe className={CN.iframe} src={href} title={title} loading="lazy" style={{ height: h }} allow="payment *; geolocation *" />
    </>
  );
}

const venueName = (loc, ctx) => (loc && ((loc.online_branding && loc.online_branding.display_name) || loc.name)) || siteName(ctx.snapshot);

export function OrderBar({ id, collection, delivery, book, catering }) {
  const { ctx } = useSite();
  const loc = pickLocation(ctx, 'default');
  const s = ctx.settings;
  const items = [
    collection && channelOn(s, 'online') && { label: 'Order for collection', href: 'servos:order' },
    delivery && channelOn(s, 'online') && { label: 'Order delivery', href: 'servos:order' },
    book && channelOn(s, 'bookings') && { label: 'Book a table', href: 'servos:book' },
    catering && channelOn(s, 'catering') && { label: 'Catering', href: 'servos:catering' },
  ].filter(Boolean);
  if (!loc || !items.length) return null;
  return (
    <Section type="OrderBar" id={id} className={CN.orderBar}>
      {items.map((it, i) => <A key={it.label} className={cls(CN.btn, i === 0 ? CN.btnPrimary : CN.btnSecondary)} href={it.href}>{it.label}</A>)}
    </Section>
  );
}

export function OrderEmbed({ id, mode, location_id, height }) {
  const { ctx } = useSite();
  const loc = pickLocation(ctx, location_id);
  const catering = mode === 'catering';
  const href = loc ? venueUrl(loc.online_slug, catering ? '/catering' : '/', ctx.customerRoot) : '';
  return (
    <Section type="OrderEmbed" id={id} className={CN.embed}>
      <Embed title={catering ? 'Catering orders' : 'Order online'} text={loc ? venueName(loc, ctx) : ''} href={href} height={height} label={catering ? 'Open catering' : 'Open ordering'} />
    </Section>
  );
}

export function LoyaltyJoin({ id, headline, sub, show_card_preview, location_id }) {
  const { ctx } = useSite();
  const loc = pickLocation(ctx, location_id);
  const href = loc ? venueUrl(loc.online_slug, '/account', ctx.customerRoot) : '';
  return (
    <Section type="LoyaltyJoin" id={id} className={CN.loyalty}>
      <div>
        {headline ? <h2 className={CN.h2}>{headline}</h2> : null}
        {sub ? <p className={CN.muted}>{sub}</p> : null}
        {href ? <a className={cls(CN.btn, CN.btnPrimary)} href={href} rel="noopener">Join free</a> : null}
      </div>
      {show_card_preview ? <div className={CN.loyaltyCard}><span>{venueName(loc, ctx)}</span><span>Loyalty card</span></div> : null}
    </Section>
  );
}

export function GiftCards({ id, headline, sub, show_art, location_id }) {
  const { ctx } = useSite();
  const loc = pickLocation(ctx, location_id);
  const buy = loc ? venueUrl(loc.online_slug, '/gift', ctx.customerRoot) : '';
  const bal = loc ? venueUrl(loc.online_slug, '/gift/balance', ctx.customerRoot) : '';
  return (
    <Section type="GiftCards" id={id} className={CN.gift}>
      <div>
        {headline ? <h2 className={CN.h2}>{headline}</h2> : null}
        {sub ? <p className={CN.muted}>{sub}</p> : null}
        {buy ? <div><a className={cls(CN.btn, CN.btnPrimary)} href={buy} rel="noopener">Buy a gift card</a> <a className={cls(CN.btn, CN.btnSecondary)} href={bal} rel="noopener">Check a balance</a></div> : null}
      </div>
      {show_art ? <div className={CN.giftArt}><span>{venueName(loc, ctx)}</span><span>Gift card</span></div> : null}
    </Section>
  );
}

export function BookTable({ id, location_id, height }) {
  const { ctx } = useSite();
  const loc = pickLocation(ctx, location_id);
  const href = loc ? venueUrl(loc.online_slug, '/book', ctx.customerRoot) : '';
  return <Section type="BookTable" id={id} className={cls(CN.embed, CN.book)}><Embed title="Book a table" text={loc ? loc.name : ''} href={href} height={height} label="Open booking" /></Section>;
}

export function Waitlist({ id, location_id }) {
  const { ctx } = useSite();
  const loc = pickLocation(ctx, location_id);
  const href = loc ? venueUrl(loc.online_slug, '/waitlist', ctx.customerRoot) : '';
  return <Section type="Waitlist" id={id} className={cls(CN.embed, CN.waitlist)}><Embed title="Join the waitlist" text={loc ? loc.name : ''} href={href} height={640} label="Open waitlist" /></Section>;
}
