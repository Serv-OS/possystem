// src/surfaces/website/blocks/components/PlaceBlocks.jsx
// Hours and FindUs in React. FindUs adds the one thing the server cannot do: "Find my nearest"
// asks for the visitor's position ON TAP (never on load), sorts the cards by Haversine distance
// and marks the nearest shop (ARCHITECTURE.md section 8).

import { useState } from 'react';
import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { A } from '../../Link.jsx';
import { pickLocation, venueUrl } from '../../resolveHref.js';
import { hoursRows, openStatus } from '../../hours.js';
import { addressText, directionsUrl, sortByDistance, distanceText } from '../../geo.js';
import { locationChannelOn } from '../../routes.js';
import { useNested } from '../nested.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');
function Section({ type, id, className, children, width }) {
  // 5.12.9: inside a Row column the block is marked nested (same attribute as the SSR section()).
  const nested = useNested();
  return <section className={cls(CN.block, className)} data-block={type} data-id={id} data-nested={nested ? 'true' : undefined} data-width={!nested && (width === 'wide' || width === 'full') ? width : undefined}><div className={CN.inner}>{children}</div></section>;
}
const Empty = ({ children }) => <p className={CN.empty}>{children}</p>;

function HoursTable({ loc, now, todayFirst = true, short = false, rows: given }) {
  const rows = given || hoursRows(loc.opening_hours, loc.timezone, { todayFirst, now });
  return (
    <table className={CN.hoursTable}><tbody>
      {rows.map((r) => <tr key={r.key} className={r.today ? CN.hoursToday : ''}><td>{short ? r.label.slice(0, 3) : r.label}</td><td>{r.text}</td></tr>)}
    </tbody></table>
  );
}

export function Hours({ id, title, location_id, show_today_first, width }) {
  const { ctx } = useSite();
  const locs = location_id === 'all' ? ctx.locations : [pickLocation(ctx, location_id)].filter(Boolean);
  const head = title ? <h2 className={CN.h2}>{title}</h2> : null;
  if (!locs.length) return <Section width={width} type="Hours" id={id} className={CN.hours}>{head}<Empty>Opening hours are not set yet.</Empty></Section>;
  return (
    <Section width={width} type="Hours" id={id} className={CN.hours}>
      {head}
      {locs.map((loc) => {
        const st = openStatus(loc.opening_hours, loc.timezone, ctx.now);
        return (
          <div key={loc.id}>
            {locs.length > 1 ? <h3>{loc.name}</h3> : null}
            {st.text ? <p className={cls(CN.muted, st.open ? CN.open : CN.closed)}>{st.text}</p> : null}
            <HoursTable loc={loc} now={ctx.now} todayFirst={show_today_first !== false} />
          </div>
        );
      })}
    </Section>
  );
}

// The first button on each venue card (5.12.7: the block also stands in as the "which venue?"
// chooser for OrderEmbed and BookTable, so the button can open catering or booking too).
const CTA = Object.freeze({
  order: { label: 'Order here', path: '/', channel: 'online' },
  catering: { label: 'Catering orders', path: '/catering', channel: 'catering' },
  book: { label: 'Book here', path: '/book', channel: 'bookings' },
});

export function FindUs({ id, title, show_map, show_nearest, show_hours, show_order_buttons, show_book = true, location_id, cta = 'order', blockType = 'FindUs', width }) {
  const { ctx, here, requestNearest, locateByText, nearestState } = useSite();
  const [typed, setTyped] = useState('');
  const main = CTA[cta] || CTA.order;
  const base = location_id === 'all' ? ctx.locations : [pickLocation(ctx, location_id)].filter(Boolean);
  const head = title ? <h2 className={CN.h2}>{title}</h2> : null;
  if (!base.length) return <Section width={width} type={blockType} id={id} className={CN.findus}>{head}<Empty>No locations yet.</Empty></Section>;
  const locs = sortByDistance(base, here, ctx.settings);
  const nearestId = here && locs[0] && locs[0].distance_km != null ? locs[0].id : null;
  return (
    <Section width={width} type={blockType} id={id} className={CN.findus}>
      {head}
      {show_nearest && base.length > 1 ? (
        <div className={CN.nearestRow}>
          <button type="button" className={cls(CN.btn, CN.btnSecondary, CN.nearestBtn)} data-nearest onClick={requestNearest} disabled={nearestState === 'asking' || nearestState === 'searching'}>
            {nearestState === 'asking' ? 'Finding you…' : nearestState === 'denied' ? 'Location not shared. Try again' : here ? 'Nearest first' : 'Find my nearest'}
          </button>
          {/* 5.12.18: when the browser will not share a location (or it was never asked), a postcode
              or town does the same job. Shown after a refusal, a miss, or once a location is known. */}
          {nearestState === 'denied' || nearestState === 'notfound' || nearestState === 'searching' || here ? (
            <form className={CN.nearestForm} onSubmit={(e) => { e.preventDefault(); locateByText(typed); }}>
              <input className={CN.nearestInput} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Postcode or town" aria-label="Postcode or town" autoComplete="postal-code" />
              <button type="submit" className={cls(CN.btn, CN.btnSecondary)} disabled={nearestState === 'searching' || !typed.trim()}>{nearestState === 'searching' ? 'Looking…' : 'Find'}</button>
              {nearestState === 'notfound' ? <span className={CN.muted}>Not found, try a postcode</span> : null}
            </form>
          ) : null}
        </div>
      ) : null}
      <div className={CN.findusGrid}>
        {locs.map((loc) => {
          const st = openStatus(loc.opening_hours, loc.timezone, ctx.now);
          const addr = addressText(loc);
          const dir = show_map ? directionsUrl(loc, ctx.settings) : '';
          const canMain = show_order_buttons && locationChannelOn(loc, ctx.settings, main.channel);
          const canBook = show_book !== false && main !== CTA.book && locationChannelOn(loc, ctx.settings, 'bookings');
          return (
            <article key={loc.id} className={cls(CN.card, CN.locCard, loc.id === nearestId && CN.nearest)} data-location={loc.id}>
              <h3 className={CN.locName}><A href={`/locations/${loc.online_slug}`}>{loc.name}</A>{loc.id === nearestId ? <span className={CN.muted}> · nearest</span> : null}</h3>
              {addr ? <p className={CN.locAddr}>{addr}</p> : null}
              {loc.distance_km != null ? <p className={CN.muted}>{distanceText(loc.distance_km)} away</p> : null}
              {loc.phone ? <p><a href={`tel:${String(loc.phone).replace(/\s+/g, '')}`}>{loc.phone}</a></p> : null}
              {st.text ? <p className={cls(CN.muted, st.open ? CN.open : CN.closed)}>{st.text}</p> : null}
              {show_hours ? <HoursTable loc={loc} now={ctx.now} short /> : null}
              <div className={CN.locActions}>
                {canMain ? <a className={cls(CN.btn, CN.btnPrimary)} href={venueUrl(loc.online_slug, main.path, ctx.customerRoot)} rel="noopener">{main.label}</a> : null}
                {dir ? <a className={cls(CN.btn, CN.btnSecondary)} href={dir} target="_blank" rel="noopener">Directions</a> : null}
                {canBook ? <a className={cls(CN.btn, CN.btnSecondary)} href={venueUrl(loc.online_slug, '/book', ctx.customerRoot)} rel="noopener">Book</a> : null}
              </div>
            </article>
          );
        })}
      </div>
    </Section>
  );
}
