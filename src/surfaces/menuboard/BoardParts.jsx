// src/surfaces/menuboard/BoardParts.jsx
//
// The menu board's header, sections and footer, drawn ONCE for the TV (MenuBoardSurface.jsx)
// and the Back Office preview (backoffice/sections/MenuBoards.jsx). Everything is in em against
// the fitted base font, so the fit loop scales the whole board and the preview is the TV in
// miniature. v5.9.68: the preview used to keep its own copy of every size and colour, so what the
// operator saw was not what the screen showed. Design choices (theme.*) resolve through
// lib/menuBoardSections.js boardSizes / boardColors; the rules for what is listed live there too.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { money } from '../../lib/currency';
import { dietaryBadges } from '../../lib/dietary';
import { productImage } from '../../lib/productImage';
import { resolveBoardPrice } from '../../lib/menuPricing';
import { boardSizes, boardColors, sizeRuns, sizeName, packBoard, fitFont, scaledFont } from '../../lib/menuBoardSections';
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

// ── Sold out (v5.9.76; Peter, 26 Sep: "when you 86 an item it greys the item name out, not the
// price, and it's not obvious, it used to say sold out"). A red pill that reads from across the
// room, in place of EVERY price of the item, and the name struck through. One 86'd size gets the
// pill in its own price cell. The row keeps its place, so the board does not reflow with stock.
const SOLD_OUT_RED = '#D62828';
function SoldOut({ em = 0.42 }) {
  return (
    <span style={{ display: 'inline-block', fontSize: `${em}em`, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', background: SOLD_OUT_RED, color: '#fff', borderRadius: '.45em', padding: '.2em .6em', lineHeight: 1.15, whiteSpace: 'nowrap' }}>Sold out</span>
  );
}
const struck = (s) => (s ? { textDecoration: 'line-through', textDecorationThickness: '.08em', opacity: 0.55 } : {});

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

function TextPanel({ sec, wrap, theme, sz, c, tag = {} }) {
  const lines = String(sec.body || '').split('\n').map(l => l.trim()).filter(Boolean);
  return (
    <div {...tag} style={{ ...wrap, ...(sec.boxed ? { border: `0.08em solid ${c.text}`, padding: '0.7em 0.9em', textAlign: 'center' } : {}) }}>
      {sec.title && <div style={{ fontSize: `${sz.heading}em`, fontWeight: 800, letterSpacing: '.1em', textTransform: upper(theme.headingCase), color: c.heading, marginBottom: '0.45em' }}>{sec.title}</div>}
      {lines.map((l, i) => <div key={i} style={{ fontSize: `${sz.item * 0.85}em`, fontWeight: 600, lineHeight: 1.35 }}>{l}</div>)}
      {sec.footer && <div style={{ fontSize: `${sz.item}em`, fontWeight: 800, marginTop: '0.5em' }}>{sec.footer}</div>}
    </div>
  );
}

// The gaps the packer reads back (v5.9.76): below a section, a size run, a heading; between rows.
export const SECTION_GAP_EM = 1.4;
const RUN_GAP_EM = 0.7, ROW_GAP_EM = 0.35, HEAD_GAP_EM = 0.55;
const tagIf = (on, ...names) => (on ? Object.fromEntries(names.map((n) => [n, ''])) : {});

// One product (or add-on) as a line, sizes indented beneath it (Price grid by size OFF).
function Line({ it, ctx, measure = false }) {
  const { theme, disp, sz, c, sold, price, defaultImage } = ctx;
  const isAddOn = !!it._addOn;
  const variants = it._variants || [];
  const hasVar = variants.length > 0;
  const s = sold(it.id);
  const p = price(it);
  const img = disp.showImages && !isAddOn ? productImage(it, defaultImage) : null;
  const nameSize = isAddOn ? sz.item * 0.82 : sz.item;
  return (
    <div {...tagIf(measure, 'data-mb-row')} style={{ marginBottom: isAddOn ? '0.3em' : '0.65em' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.55em' }}>
        {img && <img src={img} alt="" style={{ width: '2.4em', height: '2.4em', objectFit: 'cover', borderRadius: '.3em', flexShrink: 0, opacity: s ? 0.5 : 1 }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: `${nameSize}em`, fontWeight: isAddOn ? 500 : 600, lineHeight: 1.15, color: isAddOn ? c.muted : c.text, ...struck(s) }}>
            {isAddOn ? '- ' : ''}{it.menu_name || it.name}
            {!isAddOn && <Badges it={it} />}
          </div>
          {!isAddOn && <Under it={it} disp={disp} sz={sz} c={c} />}
        </div>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-start', lineHeight: 1 }}>
          {s ? <SoldOut em={nameSize * 0.72} /> : (!hasVar && disp.showPrices && p > 0 && <Price value={p} size={nameSize * 0.9} theme={theme} c={c} />)}
        </div>
      </div>
      {hasVar && !s && (
        <div style={{ marginTop: '.18em', marginLeft: '.2em', paddingLeft: img ? '3em' : '0.9em', borderLeft: `0.14em solid ${c.accent}55` }}>
          {variants.map((v) => {
            const vs = sold(v.id);
            const vp = price(v);
            return (
              <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5em', marginBottom: '.4em' }}>
                <span style={{ fontSize: `${sz.item * 0.82}em`, color: c.muted, ...struck(vs) }}>{sizeName(v)}</span>
                {vs ? <SoldOut em={sz.item * 0.6} /> : (disp.showPrices && vp > 0 && <Price value={vp} size={sz.item * 0.75} theme={theme} c={c} />)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// One size run, or a slice of it (rows from..to), as the price grid: a header row of size names
// then a price per size. A slice that continues a run in the next column carries the header too.
// v5.9.76: the size labels are half the item size and may wrap ("SMALL / BOY"), so a price column
// is as wide as its prices, not its label, and the name column stops wrapping every second name.
function RunGrid({ run, from = 0, to, ctx, measure = false }) {
  const { theme, disp, sz, c, sold, price } = ctx;
  const lines = run.lines.slice(from, to === undefined ? run.lines.length : to);
  if (disp.sizeGrid === false) {
    return <div {...tagIf(measure, 'data-mb-run', 'data-mb-list')}>{lines.map((it) => <Line key={it.id} it={it} ctx={ctx} measure={measure} />)}</div>;
  }
  const n = run.sizes.length;
  const cols = n ? `minmax(0, 1fr) repeat(${n}, auto)` : 'minmax(0, 1fr) auto';
  const cell = (k, child, extra) => <div key={k} style={{ textAlign: 'right', ...extra }}>{child}</div>;
  const priceOf = (v, size) => (disp.showPrices && price(v) > 0 ? <Price value={price(v)} size={size} theme={theme} c={c} /> : null);
  return (
    <div {...tagIf(measure, 'data-mb-run')} style={{ display: 'grid', gridTemplateColumns: cols, columnGap: `${sz.item * 0.9}em`, rowGap: `${ROW_GAP_EM}em`, alignItems: 'baseline', marginBottom: `${RUN_GAP_EM}em` }}>
      {n > 0 && (
        <Fragment>
          <div />
          {run.sizes.map((sname, k) => (
            <div key={sname} {...tagIf(measure && k === 0, 'data-mb-sizes')} style={{ fontSize: `${sz.item * 0.5}em`, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: c.muted, textAlign: 'right', lineHeight: 1.1, maxWidth: '7.5em', minWidth: 0, justifySelf: 'end', whiteSpace: 'normal', borderBottom: `0.1em solid ${c.muted}55`, paddingBottom: '.25em' }}>{sname}</div>
          ))}
        </Fragment>
      )}
      {lines.map((it) => {
        const variants = it._variants || [];
        const isAddOn = !!it._addOn;
        const s = sold(it.id);
        const nameSize = isAddOn ? sz.item * 0.82 : sz.item;
        let cells;
        if (s) cells = [cell('so', <SoldOut em={nameSize * 0.72} />, { gridColumn: '2 / -1' })];   // the whole item: one pill across every price
        else if (n === 0 || !variants.length) cells = [cell('p', priceOf(it, nameSize * 0.9)), ...run.sizes.slice(1).map((sname) => <div key={sname} />)];
        else cells = run.sizes.map((sname) => {
          const v = variants.find((x) => sizeName(x) === sname) || null;
          if (!v) return <div key={sname} />;
          return cell(sname, sold(v.id) ? <SoldOut em={sz.item * 0.6} /> : priceOf(v, sz.item * 0.9));
        });
        return (
          <Fragment key={it.id}>
            <div {...tagIf(measure, 'data-mb-row')} style={{ fontSize: `${nameSize}em`, fontWeight: isAddOn ? 500 : 600, color: isAddOn ? c.muted : c.text, lineHeight: 1.15, minWidth: 0, ...struck(s) }}>
              {isAddOn ? '- ' : ''}{it.menu_name || it.name}
              {!isAddOn && <Badges it={it} />}
              {!isAddOn && <Under it={it} disp={disp} sz={sz} c={c} />}
            </div>
            {cells}
          </Fragment>
        );
      })}
    </div>
  );
}

// What a section draws with: sizes, colours, the 86 list, the price tier, and its size runs
// (null for a category with nothing to show). Text and image panels have no runs.
function sectionCtx(sec, { theme = {}, disp = {}, six, activeMenuId = null, defaultImage = null }) {
  const sz = boardSizes(theme), c = boardColors(theme);
  const sold = (id) => !!(six && typeof six.has === 'function' && six.has(id));
  const price = (it) => resolveBoardPrice(it, activeMenuId);
  const base = { theme, disp, sz, c, sold, price, defaultImage, runs: [] };
  if (sec.type === 'text' || sec.type === 'image') return base;
  let lines = (sec.items || []).filter((it) => !(disp.hidePriceless && price(it) <= 0 && !(it._variants || []).length));
  if (disp.soldOut === 'hide') lines = lines.filter((it) => !sold(it.id));
  if (!lines.length) return null;
  base.runs = disp.sizeGrid !== false ? sizeRuns(lines) : [{ sizes: [], lines }];
  return base;
}

function SectionHeading({ sec, ctx, measure = false }) {
  const { theme, sz, c } = ctx;
  return (
    <div {...tagIf(measure, 'data-mb-head')} style={{
      fontSize: `${sz.heading}em`, fontWeight: 700, letterSpacing: '.12em', color: c.heading, marginBottom: `${HEAD_GAP_EM}em`,
      textTransform: upper(theme.headingCase),
      ...(theme.headingRule !== false ? { borderBottom: `0.06em solid ${c.heading}`, paddingBottom: '0.25em' } : {}),   // on unless switched off (the photo's rule under each heading)
    }}>{sec.title}</div>
  );
}

// A text panel or an image panel (one picture or a slideshow): moves whole. The image panel's
// shape sets its height from the width, so the measure copy needs no media in it.
function AtomicPanel({ sec, ctx, measure = false }) {
  const { theme, sz, c } = ctx;
  const wrap = { marginBottom: `${SECTION_GAP_EM}em` };
  if (sec.type === 'image') {
    return (
      <div {...tagIf(measure, 'data-mb-atomic')} style={{ ...wrap, position: 'relative', aspectRatio: ratioCss(sec.ratio), borderRadius: '0.4em', overflow: 'hidden', background: '#000' }}>
        {!measure && <Slideshow slides={sec.slides} fit={sec.fit} />}
      </div>
    );
  }
  return <TextPanel sec={sec} wrap={wrap} theme={theme} sz={sz} c={c} tag={tagIf(measure, 'data-mb-atomic')} />;
}

/**
 * One whole section of the board: a category (heading + its size runs), a text panel or an
 * image panel. Drawn whole for a Full width block, and in the hidden measure copy (measure =
 * true tags the heading, runs and rows so BoardBody can read their heights).
 *   sec   from lib/menuBoardSections.js boardSections
 *   six   Set of 86'd item ids
 */
export function BoardSection({ sec, theme = {}, disp = {}, six, activeMenuId = null, defaultImage = null, measure = false }) {
  const ctx = sectionCtx(sec, { theme, disp, six, activeMenuId, defaultImage });
  if (!ctx) return null;
  if (sec.type === 'text' || sec.type === 'image') return <AtomicPanel sec={sec} ctx={ctx} measure={measure} />;
  return (
    <div {...tagIf(measure, 'data-mb-cat')} style={{ marginBottom: `${SECTION_GAP_EM}em` }}>
      <SectionHeading sec={sec} ctx={ctx} measure={measure} />
      {ctx.runs.map((run, ri) => <RunGrid key={ri} run={run} ctx={ctx} measure={measure} />)}
    </div>
  );
}

/** One piece of a packed column (lib/menuBoardSections.js packBoard): a heading, a panel, or rows from..to of a size run. */
export function BoardPiece({ sec, piece, ...props }) {
  if (!sec || !piece) return null;
  if (piece.kind === 'atomic' && sec.type === 'category') return <BoardSection sec={sec} {...props} />;
  const ctx = sectionCtx(sec, props);
  if (!ctx) return null;
  let inner = null;
  if (piece.kind === 'atomic') inner = <AtomicPanel sec={sec} ctx={ctx} />;
  else if (piece.kind === 'head') inner = <SectionHeading sec={sec} ctx={ctx} />;
  else {
    const run = ctx.runs[piece.run];
    if (!run) return null;
    inner = <RunGrid run={run} from={piece.from} to={piece.to} ctx={ctx} />;
  }
  return <div style={{ marginBottom: piece.last && piece.kind !== 'atomic' ? `${SECTION_GAP_EM}em` : 0 }}>{inner}</div>;
}

// The heights of every row in the hidden measure copy, at the font size the board has right now.
// A grid's row tracks come from its computed grid-template-rows (Chromium reports the used sizes);
// the cells are the fallback. A wide (Full width) section is measured whole.
const rectH = (el) => (el ? el.getBoundingClientRect().height : 0);
const marginBelow = (el) => (el ? parseFloat(getComputedStyle(el).marginBottom) || 0 : 0);
function runMeasure(r) {
  const rows = Array.from(r.querySelectorAll('[data-mb-row]'));
  if (r.hasAttribute('data-mb-list')) return { sizes: 0, items: rows.map((x) => rectH(x) + marginBelow(x)) };
  const cs = getComputedStyle(r);
  const rowGap = parseFloat(cs.rowGap) || 0, after = parseFloat(cs.marginBottom) || 0;
  const sizesEl = r.querySelector('[data-mb-sizes]');
  const want = rows.length + (sizesEl ? 1 : 0);
  const tracks = String(cs.gridTemplateRows || '').split(' ').map(parseFloat).filter((x) => Number.isFinite(x));
  const heights = tracks.length === want ? tracks : [...(sizesEl ? [rectH(sizesEl)] : []), ...rows.map(rectH)];
  const items = heights.slice(sizesEl ? 1 : 0).map((h, j, arr) => h + (j < arr.length - 1 ? rowGap : after));
  return { sizes: sizesEl ? heights[0] + rowGap : 0, items };
}
function readMeasures(meas, sections, colW, fullW) {
  Array.from(meas.querySelectorAll('[data-mb-sec]')).forEach((el) => { el.style.width = (el.getAttribute('data-mb-wide') === '1' ? fullW : colW) + 'px'; });
  return sections.map((sec, i) => {
    const el = meas.querySelector(`[data-mb-sec="${i}"]`);
    if (!el) return null;
    const wide = el.getAttribute('data-mb-wide') === '1';
    const atomic = el.querySelector('[data-mb-atomic]');
    if (atomic) return { atomic: true, span: wide ? 'all' : undefined, h: rectH(atomic) + marginBelow(atomic) };
    const cat = el.querySelector('[data-mb-cat]');
    if (!cat) return null;   // nothing to show
    if (wide) return { atomic: true, span: 'all', h: rectH(cat) + marginBelow(cat) };
    const head = cat.querySelector('[data-mb-head]');
    return { head: rectH(head) + marginBelow(head), runs: Array.from(cat.querySelectorAll('[data-mb-run]')).map(runMeasure), after: marginBelow(cat) };
  });
}

/**
 * The sections of one page, fitted and packed into columns (v5.9.76). A hidden copy of every
 * section is drawn at the column width; at each font size the binary search tries, its row
 * heights are read and packed (lib/menuBoardSections.js packBoard); the largest size whose
 * packing fits wins, and the packed columns are drawn from it. The TV (MenuBoardSurface) and
 * the Back Office preview (MenuBoards) both use this, so the preview is the TV in miniature.
 *   rootRef    the element whose font-size is the board's base (everything is in em)
 *   cols       how many columns (lib/menuBoardSections.js boardColumns)
 *   fontRange  { min, max } px for the fit
 *   fitKey     anything that must re-run the fit (screen size, page, a refit tick)
 */
export function BoardBody({ rootRef, sections = [], cols = 1, textScale = 1, fontRange = { min: 4, max: 44 }, gapEm = 1.7, whole = false, fitKey = '', theme = {}, disp = {}, six, activeMenuId = null, defaultImage = null }) {
  const flowRef = useRef(null), measureRef = useRef(null);
  const [layout, setLayout] = useState(null);
  const [tick, setTick] = useState(0);
  const sigRef = useRef('');
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !flowRef.current) return undefined;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(flowRef.current);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const root = rootRef && rootRef.current, flow = flowRef.current, meas = measureRef.current;
    if (!root || !flow || !meas || !sections.length) return;
    const n = Math.max(1, Math.floor(cols) || 1);
    const layoutAt = (px) => {
      root.style.setProperty('font-size', px + 'px');
      // The header and footer are in em too, so the room left for the columns depends on px:
      // read it AFTER the font is set, at every size tried (the old scrollHeight loop did the same).
      const H = flow.clientHeight, W = flow.clientWidth;
      const colW = Math.max(1, Math.floor((W - gapEm * px * (n - 1)) / n));
      const measured = readMeasures(meas, sections, colW, W);
      const packed = packBoard(measured, { cols: n, height: H, whole });
      return { px, colW, ...packed, fits: packed.fits && H > 0 && W > 0 };
    };
    const best = fitFont((px) => layoutAt(px).fits, fontRange);
    const px = scaledFont(best, textScale, fontRange.min);
    const final = layoutAt(px);
    root.style.setProperty('font-size', px + 'px');
    const sig = JSON.stringify([px, final.colW, final.bands]);
    if (sig !== sigRef.current) { sigRef.current = sig; setLayout(final); }
  }, [sections, cols, textScale, whole, gapEm, fitKey, tick, fontRange.min, fontRange.max, theme, disp, six, activeMenuId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const part = { theme, disp, six, activeMenuId, defaultImage };
  return (
    <div ref={flowRef} style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      <div ref={measureRef} aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, right: 0, visibility: 'hidden', pointerEvents: 'none' }}>
        {sections.map((sec, i) => (
          <div key={sec.id} data-mb-sec={i} data-mb-wide={sec.span === 'all' ? '1' : '0'}>
            <BoardSection sec={sec} {...part} measure />
          </div>
        ))}
      </div>
      {layout && layout.bands.map((band, bi) => (band.wide
        ? <div key={bi}><BoardPiece sec={sections[band.sec]} piece={{ kind: 'atomic', last: true }} {...part} /></div>
        : (
          <div key={bi} style={{ display: 'flex', gap: `${gapEm}em`, alignItems: 'flex-start' }}>
            {band.cols.map((pieces, ci) => (
              <div key={ci} style={{ flex: `0 0 ${layout.colW}px`, width: layout.colW, minWidth: 0 }}>
                {pieces.map((p, pi) => <BoardPiece key={`${p.sec}-${p.kind}-${p.run ?? ''}-${p.from ?? ''}-${pi}`} sec={sections[p.sec]} piece={p} {...part} />)}
              </div>
            ))}
          </div>
        )))}
    </div>
  );
}
