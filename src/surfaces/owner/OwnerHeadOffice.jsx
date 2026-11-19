// src/surfaces/owner/OwnerHeadOffice.jsx: the Head office card on the Owner app (18 Nov 2026, slice 5).
//
// One card between the company card and the venue cards, read only: four tiles (the portfolio's
// prime cost, the cash in the safes, the internal projects, and the week's check ins for an owner
// or the open hires for everyone else), then the sites ranked by prime cost and the projects that
// need attention. The figures are the Back Office Scorecard's own, through src/lib/hq/data.js
// fetchOwnerHq (one set of reads, raced against a timer like the snapshot) and the pure rules in
// src/lib/ownerHeadOffice.js. A database without the hub draws nothing at all; a read that fails
// keeps the last good card and says so in grey; nothing here writes.

import { useEffect, useRef, useState } from 'react';
import { fetchOwnerHq } from '../../lib/hq/data.js';
import { withTimeout } from '../../lib/withTimeout';
import { weekStartIso } from '../../lib/hq/checkinWeek.js';
import { buildOwnerHq, pickOrg, hqSites, pctWords, unbankedWords } from '../../lib/ownerHeadOffice';
import { money, smallCaps } from './style';
import { getActiveCurrencyCode } from '../../lib/currency';

/** The hub's reads that have not answered by now are never going to (a woken phone). */
const HQ_TIMEOUT_MS = 15000;
export const HQ_COULD_NOT = 'Head office figures could not be read. Tap the arrow to try again.';
const PERIOD_WORD = { today: 'Today', week: 'This week', month: 'This month' };

/** The phone's own date, 'YYYY-MM-DD' (the safe and the check ins use each site's clock where they have one). */
const localYmd = (d = new Date()) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');

/** The colour of a band word: the Back Office's green, amber, red; grey when there is none. */
export function hqTone(tone) {
  if (tone === 'grn') return 'var(--grn)';
  if (tone === 'orn') return 'var(--orn, var(--amber, #F5A623))';
  if (tone === 'red') return 'var(--red)';
  return 'var(--t3)';
}

/**
 * @param {object} p
 * @param {object} p.snapshot  the owner-snapshot answer on screen (its locations are the sites)
 * @param {string} p.period    the period the numbers on screen are for (the function's own word)
 * @param {number} p.reload    goes up with every snapshot that lands, so the card re reads with it
 */
export default function OwnerHeadOffice({ snapshot, period = 'today', reload = 0 }) {
  const ids = hqSites(snapshot).map((s) => s.id).sort().join(',');
  const [got, setGot] = useState(null);      // { ids, reads, today }
  const [absent, setAbsent] = useState(false);
  const [fail, setFail] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!ids) return undefined;
    let live = true;
    const mine = ++seq.current;
    const today = localYmd();
    withTimeout(fetchOwnerHq(ids.split(','), { today, pickOrg }), HQ_TIMEOUT_MS, 'Head office')
      .then((res) => {
        if (!live || mine !== seq.current) return;
        if (res?.absent) { setAbsent(true); return; }
        setAbsent(false);
        // A read that partly failed never replaces a good card with blanks: the last figures stay and
        // the words say so in grey. Its figures are drawn only when there is no card yet.
        if (res?.data) setGot((prev) => (res.message && prev && prev.ids === ids ? prev : { ids, reads: res.data, today }));
        setFail(res?.message || null);
      })
      .catch(() => { if (live && mine === seq.current) setFail(HQ_COULD_NOT); });
    return () => { live = false; };
  }, [ids, reload]);

  if (absent || !ids) return null;
  // The business day is the first site's own (its clock, read with the safe), else the phone's date, so
  // an overdue task and the check in week follow the venue, as they do in Back Office.
  const today = got?.reads?.cash?.clocks?.[ids.split(',')[0]]?.today || got?.today || null;
  const view = got && got.ids === ids
    ? buildOwnerHq({ snapshot, ...got.reads, period, today, weekStart: weekStartIso(today) })
    : null;
  if (!view) return fail && !got ? <Card period={period}><Grey>{fail}</Grey></Card> : null;

  const { prime, cash, projects, hires, checkins, mixed, groups } = view;
  // A site with no currency of its own reads in the company's, never a bare pound sign.
  const cur = (c) => c || snapshot?.rollup?.currency || snapshot?.locations?.[0]?.currency || getActiveCurrencyCode();
  return (
    <Card period={period}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
        <Tile label="Prime cost" note={prime.green}>
          {prime.entries.map((e) => (
            <Big key={e.currency || 'one'} tone={hqTone(e.tone)} tail={mixed ? e.currency : null} sub={e.sites}>{pctWords(e.pct) || 'n/a'}</Big>
          ))}
        </Tile>
        <Tile label="Cash in safes" note={cash.entries.length === 1 ? cash.entries[0].sites : null}>
          {cash.entries.map((e) => (
            <Big key={e.currency || 'one'} tone={hqTone(e.tone)} tail={mixed ? e.currency : null}
              sub={e.transit > 0 ? `${money(e.transit, cur(e.currency))} ${unbankedWords(e) || 'waiting to bank'}` : (unbankedWords(e) || null)}>
              {e.amount === null ? 'n/a' : money(e.amount, cur(e.currency))}
            </Big>
          ))}
        </Tile>
        <Tile label="Internal projects" note={projects.note}>
          <Big tone={hqTone(projects.tone)}>{projects.open}</Big>
        </Tile>
        {checkins
          ? <Tile label="Check ins this week" note={checkins.note}><Big tone={checkins.received ? 'var(--t1)' : 'var(--t3)'}>{checkins.received}</Big></Tile>
          : <Tile label="Open hires" note={hires.note}><Big tone={hires.hires === null ? 'var(--t3)' : 'var(--t1)'}>{hires.hires === null ? 'n/a' : hires.hires}</Big></Tile>}
      </div>

      <div style={{ ...smallCaps, marginTop: 14, marginBottom: 6 }}>Sites by prime cost</div>
      {groups.map((g) => (
        <div key={g.currency || 'one'}>
          {mixed && <div style={{ fontSize: 11, color: 'var(--t3)', fontWeight: 700, margin: '6px 0 2px' }}>{g.currency}</div>}
          {g.rows.map((r) => <SiteRow key={r.id} r={r} currency={cur(r.currency)} />)}
        </div>
      ))}

      {projects.attention.length > 0 && (
        <>
          <div style={{ ...smallCaps, marginTop: 14, marginBottom: 6 }}>Needs attention</div>
          {projects.attention.map((a) => (
            <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '4px 0', color: 'var(--t2)' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ fontWeight: 700, color: 'var(--t1)' }}>{a.name}</span>
                <span style={{ color: 'var(--t4)' }}> · {a.department}</span>
              </span>
              <span style={{ flexShrink: 0, color: hqTone(a.status === 'blocked' ? 'red' : 'orn'), fontWeight: 700 }}>{a.status === 'blocked' ? 'Blocked' : 'At risk'} · {a.reason}</span>
            </div>
          ))}
          {projects.more > 0 && <Grey>{`${projects.more} more in Back Office`}</Grey>}
        </>
      )}
      {fail && <Grey>{fail}</Grey>}
    </Card>
  );
}

function Card({ period, children }) {
  return (
    <section aria-label="Head office" style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em' }}>Head office · {PERIOD_WORD[period] || 'Today'}</div>
        <span style={{ fontSize: 11.5, color: 'var(--t4)', fontWeight: 700, flexShrink: 0 }}>Read only</span>
      </div>
      {children}
    </section>
  );
}

function Tile({ label, note, children }) {
  return (
    <div style={{ background: 'var(--bg2)', borderRadius: 10, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 9.5, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      {children}
      {note && <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4, lineHeight: 1.4 }}>{note}</div>}
    </div>
  );
}

/** One figure: big, in its colour, with the currency after it when the company spans two, and a small line under it. */
function Big({ tone, tail, sub, children }) {
  return (
    <div style={{ marginTop: 4 }}>
      <span style={{ fontSize: 20, fontWeight: 800, color: tone || 'var(--t1)', lineHeight: 1.15 }}>{children}</span>
      {tail && <span style={{ fontSize: 11, color: 'var(--t3)', fontWeight: 700, marginLeft: 6 }}>{tail}</span>}
      {sub && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function SiteRow({ r, currency }) {
  const tone = hqTone(r.tone);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderTop: '1px solid var(--bdr)', fontSize: 13 }}>
      <span style={{ width: 18, color: 'var(--t4)', fontWeight: 700, flexShrink: 0 }}>{r.rank === null ? '' : r.rank}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 700 }}>{r.name}</span>
      <span style={{ textAlign: 'right', flexShrink: 0 }}>
        <span style={{ fontWeight: 800, color: r.prime === null ? 'var(--t4)' : tone }}>{pctWords(r.prime) || 'no figure'}</span>
        {r.typed && <span style={{ fontSize: 9, color: 'var(--t4)', border: '1px solid var(--bdr)', borderRadius: 4, padding: '0 4px', marginLeft: 6, fontWeight: 700 }}>TYPED</span>}
        <div style={{ fontSize: 10.5, color: 'var(--t4)' }}>
          {r.prime === null
            ? (r.net === null ? 'No sales figure' : `${money(r.net, currency)} · ${r.cogsPct === null ? 'no COGS' : 'no labour'}`)
            : `COGS ${pctWords(r.cogsPct)} · Labour ${pctWords(r.labourPct)} · ${money(r.net, currency)}`}
        </div>
      </span>
    </div>
  );
}

const Grey = ({ children }) => <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 8 }}>{children}</div>;
