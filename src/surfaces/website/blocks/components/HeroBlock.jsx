// src/surfaces/website/blocks/components/HeroBlock.jsx
// The Hero block in React. Same classes and order as the SSR renderer so the first paint holds.

import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { A } from '../../Link.jsx';
import { pickLocation } from '../../resolveHref.js';
import { openStatus } from '../../hours.js';
import { siteName } from '../../ssr/jsonld.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');

export function Hero({ headline, sub, photo_url, show_status, primary, secondary, height, id, isFirst = true }) {
  const { ctx } = useSite();
  const loc = pickLocation(ctx, 'default');
  const branding = (loc && loc.online_branding) || {};
  const photo = photo_url || branding.hero_url || '';
  const title = headline || branding.display_name || (loc && loc.name) || siteName(ctx.snapshot);
  const st = show_status && loc ? openStatus(loc.opening_hours, loc.timezone, ctx.now) : { text: '' };
  const H = isFirst ? 'h1' : 'h2';
  return (
    <section className={cls(CN.block, CN.hero, height === 'short' ? CN.heroShort : CN.heroTall)} data-block="Hero" data-id={id} data-photo={photo ? 'true' : 'false'}
      style={photo ? { backgroundImage: `url(${JSON.stringify(photo)})` } : undefined}>
      <div className={CN.heroBody}>
        {st.text ? <div className={cls(CN.heroStatus, st.open ? CN.open : CN.closed)}>{st.text}</div> : null}
        <H>{title}</H>
        {sub ? <p>{sub}</p> : null}
        <div>
          {primary && primary.label ? <A className={cls(CN.btn, CN.btnPrimary)} href={primary.href}>{primary.label}</A> : null}
          {secondary && secondary.label ? <A className={cls(CN.btn, CN.btnSecondary)} href={secondary.href}>{secondary.label}</A> : null}
        </div>
      </div>
    </section>
  );
}
