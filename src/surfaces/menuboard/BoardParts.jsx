// src/surfaces/menuboard/BoardParts.jsx
//
// The menu board's header, sections and footer, drawn ONCE for the TV (MenuBoardSurface.jsx)
// and the Back Office preview (backoffice/sections/MenuBoards.jsx). Everything is in em against
// the fitted base font, so the fit loop scales the whole board and the preview is the TV in
// miniature. v5.9.68: the preview used to keep its own copy of every size and colour, so what the
// operator saw was not what the screen showed. Design choices (theme.*) resolve through
// lib/menuBoardSections.js boardSizes / boardColors; the rules for what is listed live there too.

import { Fragment, useEffect, useState } from 'react';
import { money } from '../../lib/currency';
import { dietaryBadges } from '../../lib/dietary';
import { productImage } from '../../lib/productImage';
import { resolveBoardPrice } from '../../lib/menuPricing';
import { boardSizes, boardColors, sizeRuns, sizeName } from '../../lib/menuBoardSections';
import { slideHoldMs, nextSlideIndex, ratioCss } from '../../lib/menuBoardSlides';

const upper = (mode) => (mode === 'as-typed' ? 'none' : 'uppercase');

// ── Slideshow (v5.9.71): images and videos one after another, for Marketing mode (full screen)
// and the image panel inside a menu. An image stays slide.seconds; a video plays through
// (advances on ended, lib/menuBoardSlides.js VIDEO_SAFETY_MS as the net). The slide before
// fades out over the new one; the next image is fetched ahead. One slide, or a single video,
// just sits (a lone video loops). Fills its parent: give the parent position and a size.
const FADE_MS = 800;
const layerStyle = (fit) => ({ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: fit === 'contain' ? 'contain' : 'cover', display: 'block' });

export function Slideshow({ slides = [], fit = 'cover', transition = 'fade' }) {
  const list = (Array.isArray(slides) ? slides : []).filter((s) => s && s.url);
  const key = list.map((s) => s.url).join('|');
  const [i, setI] = useState(0);
  const [prev, setPrev] = useState(null);
  useEffect(() => { setI(0); setPrev(null); }, [key]);
  const n = list.length;
  const cur = n ? list[i % n] : null;
  const advance = () => {
    if (n < 2) return;
    setPrev(transition === 'none' ? null : i % n);
    setI((x) => nextSlideIndex(x, n));
  };
  useEffect(() => {
    if (!cur || n < 2) return undefined;
    const t = setTimeout(advance, slideHoldMs(cur));
    return () => clearTimeout(t);
  }, [i, key, n]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (n < 2) return;
    const next = list[nextSlideIndex(i, n)];
    if (next && next.type !== 'video') { const img = new Image(); img.src = next.url; }
  }, [i, key, n]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (prev == null) return undefined;
    const t = setTimeout(() => setPrev(null), FADE_MS);
    return () => clearTimeout(t);
  }, [prev]);
  if (!cur) return null;
  const layer = (s, k, fading) => (s.type === 'video'
    ? <video key={k} src={s.url} autoPlay muted playsInline loop={n < 2} onEnded={() => { if (n > 1) advance(); }}
        style={{ ...layerStyle(fit), ...(fading ? { animation: `mbFadeOut ${FADE_MS}ms ease forwards`, pointerEvents: 'none' } : {}) }} />
    : <img key={k} src={s.url} alt="" style={{ ...layerStyle(fit), ...(fading ? { animation: `mbFadeOut ${FADE_MS}ms ease forwards`, pointerEvents: 'none' } : {}) }} />);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}>
      <style>{'@keyframes mbFadeOut { from { opacity: 1 } to { opacity: 0 } }'}</style>
      {layer(cur, `c-${i % n}`, false)}
      {prev != null && prev !== i % n && list[prev] && layer(list[prev], `p-${prev}`, true)}
    </div>
  );
}

export function BoardHeader({ theme = {}, name = '' }) {
  const sz = boardSizes(theme), c = boardColors(theme);
  const title = (theme.title || '').trim();
  const note = (theme.subtitle || '').trim();
  const showName = !theme.logoUrl && !title;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1em', flex: '0 0 auto',
      borderBottom: theme.headerRule === false ? 'none' : `0.09em solid ${c.heading}`, paddingBottom: '0.35em', marginBottom: '0.6em',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8em', minWidth: 0 }}>
        {theme.logoUrl && <img src={theme.logoUrl} alt="" style={{ height: `${sz.logo}em`, objectFit: 'contain', flexShrink: 0 }} />}
        {showName && <div style={{ fontSize: '1em', fontWeight: 600, letterSpacing: '.06em' }}>{name || 'Menu'}</div>}
      </div>
      {(title || note) && (
        <div style={{ textAlign: 'right', minWidth: 0 }}>
          {title && <div style={{ fontSize: `${sz.title}em`, fontWeight: 800, letterSpacing: '.06em', textTransform: upper(theme.titleCase), color: c.title, lineHeight: 1.05 }}>{title}</div>}
          {note && <div style={{ fontSize: `${sz.note}em`, color: c.muted, marginTop: '.4em', whiteSpace: 'pre-line', lineHeight: 1.3 }}>{note}</div>}
        </div>
      )}
    </div>
  );
}

export function BoardFooter({ theme = {}, live = false, pages = 1, page = 0 }) {
  const c = boardColors(theme);
  return (
    <div style={{ flex: '0 0 auto', borderTop: `0.04em solid ${c.muted}33`, marginTop: '0.5em', paddingTop: '0.4em', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.32em', color: c.muted }}>
      <span>{theme.footerNote || 'Please ask staff about the 14 allergens.'}</span>
      {pages > 1 && (
        <span style={{ display: 'flex', gap: '.5em', alignItems: 'center' }} aria-label={`Page ${page + 1} of ${pages}`}>
          {Array.from({ length: pages }, (_, k) => <span key={k} style={{ width: '.6em', height: '.6em', borderRadius: '50%', background: k === page ? c.heading : `${c.muted}66`, display: 'inline-block' }} />)}
        </span>
      )}
      {live && (
        <span style={{ display: 'flex', alignItems: 'center', gap: '.5em', opacity: .8 }}>
          <span style={{ width: '.55em', height: '.55em', borderRadius: '50%', background: '#3BD16F', display: 'inline-block' }} />Live
        </span>
      )}
    </div>
  );
}

function SoldOut({ small }) {
  return <span style={{ fontSize: small ? '0.34em' : '0.38em', fontWeight: 600, letterSpacing: '.05em', background: '#5a1e1e', color: '#f3b0b0', borderRadius: '1.4em', padding: '.2em .8em', whiteSpace: 'nowrap' }}>SOLD OUT</span>;
}

function Price({ value, size, theme, c }) {
  const plain = theme.priceStyle === 'plain';
  return (
    <span style={{
      fontSize: `${size}em`, fontWeight: 700, whiteSpace: 'nowrap',
      ...(plain ? { color: c.price } : { background: c.price, color: c.priceText, borderRadius: '1.4em', padding: '.16em .7em' }),
    }}>{money(value)}</span>
  );
}

function Badges({ it }) {
  const diet = dietaryBadges(it);
  return diet.map((d) => (
    <span key={d} style={{ fontSize: '0.6em', background: '#1f3a26', color: '#7fd99a', borderRadius: '1em', padding: '0 .55em', marginLeft: '.3em', whiteSpace: 'nowrap', fontWeight: 700 }}>{d}</span>
  ));
}

function Under({ it, disp, sz, c }) {
  return (
    <>
      {disp.showDescription && it.description && (
        <div style={{ fontSize: `${sz.item * 0.75}em`, color: c.muted, lineHeight: 1.3, marginTop: '.15em' }}>{it.description}</div>
      )}
      {disp.showAllergens && Array.isArray(it.allergens) && it.allergens.length > 0 && (
        <div style={{ fontSize: `${sz.item * 0.6}em`, color: c.muted, lineHeight: 1.3, marginTop: '.25em', textTransform: 'capitalize', opacity: 0.9 }}>
          Allergens: {it.allergens.join(', ')}
        </div>
      )}
    </>
  );
}

function TextPanel({ sec, wrap, theme, sz, c }) {
  const lines = String(sec.body || '').split('\n').map(l => l.trim()).filter(Boolean);
  return (
    <div style={{ ...wrap, ...(sec.boxed ? { border: `0.08em solid ${c.text}`, padding: '0.7em 0.9em', textAlign: 'center' } : {}) }}>
      {sec.title && <div style={{ fontSize: `${sz.heading}em`, fontWeight: 800, letterSpacing: '.1em', textTransform: upper(theme.headingCase), color: c.heading, marginBottom: '0.45em' }}>{sec.title}</div>}
      {lines.map((l, i) => <div key={i} style={{ fontSize: `${sz.item * 0.85}em`, fontWeight: 600, lineHeight: 1.35 }}>{l}</div>)}
      {sec.footer && <div style={{ fontSize: `${sz.item}em`, fontWeight: 800, marginTop: '0.5em' }}>{sec.footer}</div>}
    </div>
  );
}

// One product (or add-on) as a line, sizes indented beneath it.
function Line({ it, ctx }) {
  const { theme, disp, sz, c, sold, price, defaultImage } = ctx;
  const isAddOn = !!it._addOn;
  const variants = it._variants || [];
  const hasVar = variants.length > 0;
  const s = sold(it.id);
  const p = price(it);
  const img = disp.showImages && !isAddOn ? productImage(it, defaultImage) : null;
  const nameSize = isAddOn ? sz.item * 0.82 : sz.item;
  return (
    <div style={{ marginBottom: isAddOn ? '0.3em' : '0.65em', opacity: s ? 0.42 : 1, breakInside: 'avoid', WebkitColumnBreakInside: 'avoid' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.55em' }}>
        {img && <img src={img} alt="" style={{ width: '2.4em', height: '2.4em', objectFit: 'cover', borderRadius: '.3em', flexShrink: 0 }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: `${nameSize}em`, fontWeight: isAddOn ? 500 : 600, lineHeight: 1.15, color: isAddOn ? c.muted : c.text }}>
            {isAddOn ? '- ' : ''}{it.menu_name || it.name}
            {!isAddOn && <Badges it={it} />}
          </div>
          {!isAddOn && <Under it={it} disp={disp} sz={sz} c={c} />}
        </div>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-start', lineHeight: 1 }}>
          {s ? <SoldOut small={isAddOn} /> : (!hasVar && disp.showPrices && p > 0 && <Price value={p} size={nameSize * 0.9} theme={theme} c={c} />)}
        </div>
      </div>
      {hasVar && (
        <div style={{ marginTop: '.18em', marginLeft: '.2em', paddingLeft: img ? '3em' : '0.9em', borderLeft: `0.14em solid ${c.accent}55` }}>
          {variants.map((v) => {
            const vs = sold(v.id);
            const vp = price(v);
            return (
              <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5em', marginBottom: '.4em', opacity: vs ? 0.42 : 1 }}>
                <span style={{ fontSize: `${sz.item * 0.82}em`, color: c.muted }}>{sizeName(v)}</span>
                {vs ? <SoldOut small /> : (disp.showPrices && vp > 0 && <Price value={vp} size={sz.item * 0.75} theme={theme} c={c} />)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The price grid: a header row of size names, then one row per line with a price per size.
function SizeGrid({ lines, ctx }) {
  const { theme, disp, sz, c, sold, price } = ctx;
  return sizeRuns(lines).map((run, ri) => {
    const n = run.sizes.length;
    const cols = n ? `minmax(0, 1fr) repeat(${n}, auto)` : 'minmax(0, 1fr) auto';
    return (
      <div key={ri} style={{ display: 'grid', gridTemplateColumns: cols, columnGap: '0.9em', rowGap: '0.35em', alignItems: 'baseline', marginBottom: '0.7em', breakInside: 'avoid', WebkitColumnBreakInside: 'avoid' }}>
        {n > 0 && (
          <Fragment>
            <div />
            {run.sizes.map((sname) => (
              <div key={sname} style={{ fontSize: `${sz.item * 0.62}em`, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: c.muted, textAlign: 'right', borderBottom: `0.08em solid ${c.muted}55`, paddingBottom: '.2em', whiteSpace: 'nowrap' }}>{sname}</div>
            ))}
          </Fragment>
        )}
        {run.lines.map((it) => {
          const variants = it._variants || [];
          const isAddOn = !!it._addOn;
          const s = sold(it.id);
          const nameSize = isAddOn ? sz.item * 0.82 : sz.item;
          const single = (
            <div style={{ textAlign: 'right' }}>
              {s ? <SoldOut small={isAddOn} /> : (disp.showPrices && price(it) > 0 && <Price value={price(it)} size={nameSize * 0.9} theme={theme} c={c} />)}
            </div>
          );
          return (
            <Fragment key={it.id}>
              <div style={{ fontSize: `${nameSize}em`, fontWeight: isAddOn ? 500 : 600, color: isAddOn ? c.muted : c.text, opacity: s ? 0.42 : 1, lineHeight: 1.15, minWidth: 0 }}>
                {isAddOn ? '- ' : ''}{it.menu_name || it.name}
                {!isAddOn && <Badges it={it} />}
                {!isAddOn && <Under it={it} disp={disp} sz={sz} c={c} />}
              </div>
              {n === 0 || !variants.length
                ? run.sizes.map((sname, ci) => <Fragment key={sname}>{ci === 0 ? single : <div />}</Fragment>).concat(n === 0 ? [<Fragment key="one">{single}</Fragment>] : [])
                : run.sizes.map((sname) => {
                  const v = variants.find(x => sizeName(x) === sname) || null;
                  if (!v) return <div key={sname} />;
                  const vs = sold(v.id);
                  const vp = price(v);
                  return (
                    <div key={sname} style={{ textAlign: 'right', opacity: vs ? 0.42 : 1 }}>
                      {vs ? <SoldOut small /> : (disp.showPrices && vp > 0 && <Price value={vp} size={sz.item * 0.9} theme={theme} c={c} />)}
                    </div>
                  );
                })}
            </Fragment>
          );
        })}
      </div>
    );
  });
}

/**
 * One section of the board: a category (list or price grid) or a text panel.
 *   sec   from lib/menuBoardSections.js boardSections
 *   six   Set of 86'd item ids
 */
export function BoardSection({ sec, theme = {}, disp = {}, six, activeMenuId = null, defaultImage = null }) {
  const sz = boardSizes(theme), c = boardColors(theme);
  const spanAll = sec.span === 'all';
  const wrap = { marginBottom: '1.4em', breakInside: 'avoid', WebkitColumnBreakInside: 'avoid', ...(spanAll ? { columnSpan: 'all', WebkitColumnSpan: 'all', breakInside: 'auto' } : {}) };
  if (sec.type === 'text') return <TextPanel sec={sec} wrap={wrap} theme={theme} sz={sz} c={c} />;
  if (sec.type === 'image') {
    // v5.9.71: a picture, or a slideshow, among the categories. The shape sets the height from
    // the column width, so the fit loop measures it like any other block.
    return (
      <div style={{ ...wrap, position: 'relative', aspectRatio: ratioCss(sec.ratio), borderRadius: '0.4em', overflow: 'hidden', background: '#000' }}>
        <Slideshow slides={sec.slides} fit={sec.fit} />
      </div>
    );
  }
  const sold = (id) => !!(six && typeof six.has === 'function' && six.has(id));
  const price = (it) => resolveBoardPrice(it, activeMenuId);
  const ctx = { theme, disp, sz, c, sold, price, defaultImage };
  let lines = (sec.items || []).filter((it) => !(disp.hidePriceless && price(it) <= 0 && !(it._variants || []).length));
  if (disp.soldOut === 'hide') lines = lines.filter((it) => !sold(it.id));
  if (!lines.length) return null;
  return (
    <div style={wrap}>
      <div style={{
        fontSize: `${sz.heading}em`, fontWeight: 700, letterSpacing: '.12em', color: c.heading, marginBottom: '0.55em',
        textTransform: upper(theme.headingCase), breakAfter: 'avoid', WebkitColumnBreakAfter: 'avoid',
        ...(theme.headingRule !== false ? { borderBottom: `0.06em solid ${c.heading}`, paddingBottom: '0.25em' } : {}),   // on unless switched off (the photo's rule under each heading)
      }}>{sec.title}</div>
      {disp.sizeGrid !== false ? <SizeGrid lines={lines} ctx={ctx} /> : lines.map((it) => <Line key={it.id} it={it} ctx={ctx} />)}
    </div>
  );
}
