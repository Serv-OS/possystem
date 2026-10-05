// src/surfaces/owner/OwnerDetail.jsx: the screen behind a venue card (and behind the group card).
//
// 5 Oct 2026: a venue card did nothing when tapped. Now it opens that venue's seven reports
// for the period on the chips; the group card opens the same seven across all sites of one
// currency. One call to owner-snapshot ({ period, detail }) answers all seven.
//
// THE RULES THIS SCREEN KEEPS
//   * Nothing is drawn from the wrong period or venue. An answer is kept under the key it was
//     asked with (venue, currency, period) and only drawn while that key is the one on screen;
//     change the chip and the reports go to "Loading" until the new answer lands. A slow
//     answer to an earlier chip is dropped (seq), and an answer whose own words say another
//     venue or period is treated as a failure (readDetail).
//   * AN OLD FUNCTION. The app ships before the function is deployed. A function from before
//     the detail call says so (no 'detail' in `features`) or answers the plain snapshot with
//     no `detail` in it. Either way the screen says "More reports need a ServOS update".
//     Never a blank, never a wrong label.
//   * A call that hangs says so (a woken phone), as the main screen does.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { withTimeout, TimeoutError } from '../../lib/withTimeout';
import { PERIOD_COPY, rangeLabel } from '../../lib/ownerPeriod';
import { compareLine, groupLine } from '../../lib/ownerCompare';
import { DETAIL_NEEDS_UPDATE, detailRequest, detailKey, readDetail, detailRange } from '../../lib/ownerDetail';
import OwnerReports from './OwnerReports';
import { money, toneColor, smallCaps, linkBtn } from './style';

const DETAIL_TIMEOUT_MS = 20000;
/** This month reads a month of items and a 400 day refund lookback: it is given longer. */
const MONTH_DETAIL_TIMEOUT_MS = 40000;
const REFRESH_MS = 120000;
const MONTH_REFRESH_MS = 600000;

/**
 * @param {object} p
 * @param {{ kind: 'venue'|'group', id: string, currency: string|null, name: string, venues: number }} p.target
 * @param {string} p.period     the chip
 * @param {boolean} p.supported the snapshot's own function has the detail call
 * @param {number} p.tick       goes up when the refresh arrow is tapped
 * @param {() => void} p.onBack
 * @param {string} p.backLabel
 */
export default function OwnerDetail({ target, period, supported, tick, onBack, backLabel }) {
  const key = detailKey(target, period);
  const [got, setGot] = useState(null);   // { key, state, detail }
  const [fail, setFail] = useState(null); // { key, message }
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const k = detailKey(target, period);
    try {
      const { data: d, error } = await withTimeout(
        supabase.functions.invoke('owner-snapshot', { body: detailRequest(target, period) }),
        period === 'month' ? MONTH_DETAIL_TIMEOUT_MS : DETAIL_TIMEOUT_MS, 'Owner reports');
      if (error) { let b = null; try { b = await error.context?.json?.(); } catch { /* no body to read */ } throw new Error(b?.error || error.message); }
      if (d?.error) throw new Error(d.error);
      if (mine !== seq.current) return;
      const r = readDetail(d, target, period);
      if (r.state === 'mismatch') throw new Error('The answer was for another venue or period. Tap the arrow to try again.');
      setGot({ key: k, ...r });
      setFail(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setFail({
        key: k,
        message: e instanceof TimeoutError
          ? 'Could not reach ServOS. Tap the arrow to try again, or close and reopen the app.'
          : (e.message || 'Could not load the reports'),
      });
    }
  }, [target, period]);

  useEffect(() => {
    // An old function is not asked at all: its answer would be the whole snapshot, read for nothing.
    if (!supported) return undefined;
    load();
    const t = setInterval(load, period === 'month' ? MONTH_REFRESH_MS : REFRESH_MS);
    // An answer still on its way when the venue or the chip changes is dropped.
    return () => { clearInterval(t); seq.current += 1; };
  }, [load, supported, period, tick]);

  // Only an answer asked for with THIS venue and period is ever drawn.
  const mine = got?.key === key ? got : null;
  const failed = fail?.key === key ? fail.message : '';
  const needsUpdate = !supported || mine?.state === 'needs_update';
  const detail = mine?.state === 'ok' ? mine.detail : null;
  const copy = PERIOD_COPY[period];

  return (
    <>
      <button onClick={onBack} style={backBtn} aria-label={backLabel}>‹ {backLabel}</button>
      <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-.01em', margin: '10px 0 2px' }}>{target.name}</div>
      <div style={{ ...smallCaps, marginBottom: 12 }}>
        {[copy.heading, target.kind === 'group' && target.venues > 1 ? `${target.venues} venues` : '', detail ? rangeLabel(detailRange(detail)) : ''].filter(Boolean).join(' · ')}
      </div>

      {needsUpdate && (
        <div role="status" style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: '28px 16px', textAlign: 'center', color: 'var(--t2)', fontSize: 14, fontWeight: 700 }}>
          {DETAIL_NEEDS_UPDATE}
        </div>
      )}

      {!needsUpdate && !detail && !failed && (
        <div role="status" style={{ color: 'var(--t3)', textAlign: 'center', padding: '60px 0' }}>Loading {copy.heading.toLowerCase()}’s reports…</div>
      )}

      {!needsUpdate && failed && (
        <div role="alert" style={{ textAlign: 'center', padding: detail ? '0 0 12px' : '40px 0' }}>
          <div style={{ color: 'var(--red)', fontSize: 13 }}>{detail ? `Could not refresh. ${failed}` : failed}</div>
          {!detail && <button style={linkBtn} onClick={load}>Try again</button>}
        </div>
      )}

      {detail && <Summary detail={detail} target={target} period={period} />}
      {detail && <OwnerReports detail={detail} period={period} range={detailRange(detail)} currency={detail.scope.currency || target.currency || 'GBP'} />}
    </>
  );
}

// The headline for the screen: the period's net sales and the comparison line, from the SAME
// answer as the reports under it (never from the card that was tapped, which may be older).
function Summary({ detail, target, period }) {
  const cur = detail.scope.currency || target.currency || 'GBP';
  const t = detail.totals || {};
  const range = detailRange(detail);
  const others = detail.scope.other_currencies || [];
  const g = target.kind === 'group' ? groupLine(detail.compare, range, period) : null;
  const v = target.kind === 'group' ? null : compareLine(detail.compare, range, period);
  return (
    <div style={{ background: 'linear-gradient(160deg, var(--acc-d), var(--bg1))', border: '1px solid var(--acc-b)', borderRadius: 18, padding: '16px 18px', marginBottom: 12 }}>
      <div style={smallCaps}>{PERIOD_COPY[period].sales}</div>
      <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: '-.02em', lineHeight: 1.1, margin: '2px 0' }}>{money(t.net_sales, cur)}</div>
      <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>
        {t.orders || 0} order{t.orders === 1 ? '' : 's'} · {money(t.avg_check, cur, 2)} average{t.tips > 0 ? ` · ${money(t.tips, cur)} tips` : ''}
      </div>
      {v && <div style={{ fontSize: 12.5, fontWeight: 700, color: toneColor(v.tone), marginTop: 10 }}>{v.text}</div>}
      {g && (
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 10 }}>
          {g.grey ? <span style={{ fontWeight: 700 }}>{g.grey}</span> : (
            <>{g.label} {money(g.amount, cur)} · <span style={{ color: toneColor(g.tone), fontWeight: 700 }}>{g.pct}</span>{g.note}</>
          )}
        </div>
      )}
      {others.length > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 8 }}>{cur} venues only. {others.join(', ')} venues have their own card.</div>
      )}
    </div>
  );
}

const backBtn = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 99, padding: '8px 14px', color: 'var(--t1)', fontSize: 13.5, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' };
