// src/surfaces/website/blocks/components/HeroBlock.jsx
// The Hero block in React. Same classes and order as the SSR renderer so the first paint holds.
// 5.12.10: with props.slides the hero is a slideshow (blocks/heroSlides.js decides the slides);
// this component advances them, pauses while hovered or hidden, and respects reduced motion.

import { useEffect, useState } from 'react';
import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { A } from '../../Link.jsx';
import { pickLocation } from '../../resolveHref.js';
import { openStatus } from '../../hours.js';
import { siteName } from '../../ssr/jsonld.js';
import { heroSlides, slideSeconds, nextSlide } from '../heroSlides.js';
import { isDarkHex } from '../../theme.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');
const bg = (url, hex) => (url ? { backgroundImage: `url(${JSON.stringify(url)})` } : (hex ? { backgroundColor: hex } : undefined));
const tone = (url, hex) => (!url && hex ? (isDarkHex(hex) ? 'light' : 'dark') : undefined);

function reducedMotion() {
  try { return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function Body({ slide, tag, status }) {
  const Tag = tag === 'h1' ? 'h1' : 'h2';
  return (
    <div className={CN.heroBody}>
      {status}
      <Tag>{slide.headline}</Tag>
      {slide.sub ? <p>{slide.sub}</p> : null}
      <div>
        {slide.primary && slide.primary.label ? <A className={cls(CN.btn, CN.btnPrimary)} href={slide.primary.href}>{slide.primary.label}</A> : null}
        {slide.secondary && slide.secondary.label ? <A className={cls(CN.btn, CN.btnSecondary)} href={slide.secondary.href}>{slide.secondary.label}</A> : null}
      </div>
    </div>
  );
}

export function Hero(props) {
  const { headline, sub, photo_url, show_status, primary, secondary, height, id, isFirst = true } = props;
  const { ctx } = useSite();
  const loc = pickLocation(ctx, 'default');
  const branding = (loc && loc.online_branding) || {};
  const usePhoto = props.use_photo !== false;
  const hex = /^#[0-9a-f]{6}$/i.test(String(props.bg_color || '')) ? String(props.bg_color) : '';
  const photo = usePhoto ? (photo_url || branding.hero_url || '') : '';
  const title = headline || branding.display_name || (loc && loc.name) || siteName(ctx.snapshot);
  const st = show_status && loc ? openStatus(loc.opening_hours, loc.timezone, ctx.now) : { text: '' };
  const H = isFirst ? 'h1' : 'h2';
  const status = st.text ? <div className={cls(CN.heroStatus, st.open ? CN.open : CN.closed)}>{st.text}</div> : null;
  const slides = heroSlides({ headline, sub, photo_url: usePhoto ? photo_url : '', primary, secondary, slides: props.slides }, { fallbackPhoto: usePhoto ? branding.hero_url || '' : '', fallbackHeadline: title });
  const seconds = slideSeconds(props);
  const sizeCls = height === 'short' ? CN.heroShort : CN.heroTall;

  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = slides.length;
  useEffect(() => {
    if (count < 2 || !seconds || paused || reducedMotion()) return undefined;
    const tick = () => { if (typeof document === 'undefined' || !document.hidden) setActive((i) => nextSlide(i, count)); };
    const t = setInterval(tick, seconds * 1000);
    return () => clearInterval(t);
  }, [count, seconds, paused]);
  const shown = active < count ? active : 0;

  if (count < 2) {
    return (
      <section className={cls(CN.block, CN.hero, sizeCls)} data-block="Hero" data-id={id} data-photo={photo ? 'true' : 'false'} data-tone={tone(photo, hex)} style={bg(photo, hex)}>
        <Body slide={slides[0]} tag={H} status={status} />
      </section>
    );
  }
  return (
    <section
      className={cls(CN.block, CN.hero, CN.heroSlides, sizeCls)} data-block="Hero" data-id={id}
      data-photo={slides[0].photo ? 'true' : 'false'} data-slides={count} data-seconds={seconds}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    >
      {slides.map((sl, i) => (
        <div key={i} className={CN.heroSlide} data-slide={i} data-active={i === shown ? 'true' : 'false'} data-photo={sl.photo ? 'true' : 'false'} data-tone={tone(sl.photo, hex)} style={bg(sl.photo, hex)} aria-hidden={i === shown ? undefined : 'true'}>
          <Body slide={sl} tag={i === 0 ? H : 'h2'} status={i === 0 ? status : null} />
        </div>
      ))}
      <div className={CN.heroDots} role="tablist" aria-label="Slides">
        {slides.map((_, i) => (
          <button key={i} type="button" className={CN.heroDot} role="tab" aria-selected={i === shown ? 'true' : 'false'} aria-label={`Slide ${i + 1}`} data-go={i} onClick={() => setActive(i)} />
        ))}
      </div>
    </section>
  );
}
