// v5.5.120 — Live order tracker for online ordering customers.
// Subscribes to order_queue realtime + polls every 20s as a fallback (in
// case Realtime drops). Shows a step indicator: Received → Preparing →
// Ready → Collected. Status flow mirrors the operator-side
// CollectionQueue (`received` / `prep` / `ready` / `collected`).

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { trackDelivery } from '../../lib/delivery/dispatch';
import { courierPhase, courierLegs, courierLateness } from '../../lib/delivery/courierTimes';

const STEPS = [
  { key: 'received', label: 'Received',  icon: '📥', desc: 'We\'ve got your order.' },
  { key: 'prep',     label: 'Preparing', icon: '👨‍🍳', desc: 'The kitchen is on it.' },
  { key: 'ready',    label: 'Ready',     icon: '🎁', desc: 'Ready when you are.' },
  { key: 'collected',label: 'Collected', icon: '✅', desc: 'Enjoy!' },
];

export default function OrderTracker({ orderRef, locationId, theme, onClose }) {
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [courier, setCourier] = useState(null); // live Stuart courier status for delivery orders

  // v5.5.128: realtime channel + 5s polling fallback (was 20s — too slow if
  // the realtime channel fails RLS auth or the customer's network drops the
  // websocket). Polling is the workhorse; realtime is a snappy nice-to-have.
  // Polling interval 5s gives a perceptually-live feel without slamming the DB.
  useEffect(() => {
    let alive = true;
    let chan = null;

    const fetchOnce = async () => {
      try {
        const { data, error } = await supabase
          .from('order_queue').select('*')
          .eq('ref', orderRef).maybeSingle();
        if (!alive) return;
        if (error) {
          console.warn('[OrderTracker] poll error:', error.message);
          setErr(error.message); return;
        }
        if (data) {
          // Only update state if status / total / items actually changed —
          // avoids re-rendering the whole tree every 5s.
          setOrder(prev => {
            if (!prev) return data;
            if (prev.status === data.status && prev.total === data.total
                && JSON.stringify(prev.items) === JSON.stringify(data.items)) return prev;
            console.log('[OrderTracker]', orderRef, 'status:', prev?.status, '→', data.status);
            return data;
          });
        }
        setLoading(false);
      } catch (e) {
        if (alive) { setErr(e?.message || 'Could not load order.'); setLoading(false); }
      }
    };
    fetchOnce();

    if (supabase) {
      chan = supabase.channel(`order-tracker-${orderRef}`)
        .on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'order_queue', filter: `ref=eq.${orderRef}`,
        }, (payload) => {
          if (!alive) return;
          console.log('[OrderTracker] realtime UPDATE for', orderRef, '→', payload.new?.status);
          setOrder(payload.new);
        }).subscribe((status) => {
          if (status === 'SUBSCRIBED') console.log('[OrderTracker] subscribed to', orderRef);
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[OrderTracker] realtime channel issue:', status, '(polling will continue)');
          }
        });
    }
    const poll = setInterval(fetchOnce, 5_000);

    return () => {
      alive = false;
      clearInterval(poll);
      if (chan && supabase) supabase.removeChannel(chan);
    };
  }, [orderRef]);

  // Live courier tracking for COURIER delivery orders (Stuart). Polls the anon-safe track_order
  // edge action for status + ETA + the live tracking-map URL.
  const orderType = order?.type || null;
  const deliveryMode = order?.customer?.delivery_mode || null;
  const isCourier = orderType === 'delivery' && deliveryMode === 'uber';
  useEffect(() => {
    if (!isCourier || !orderRef || !locationId) return;
    let live = true;
    const load = async () => {
      const r = await trackDelivery({ opsLocationId: locationId, orderRef });
      if (live && r?.ok) setCourier(r);
    };
    load();
    const id = setInterval(load, 15_000);
    return () => { live = false; clearInterval(id); };
  }, [isCourier, orderRef, locationId]);

  const status = order?.status || 'received';
  const currentIdx = Math.max(0, STEPS.findIndex(s => s.key === status));
  const isDelivery = orderType === 'delivery' || deliveryMode != null;
  const fmtEta = (iso) => { if (!iso) return null; const d = new Date(iso); return isNaN(d.getTime()) ? null : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); };
  const COURIER_LABEL = {
    scheduled: ['Scheduled delivery', '🗓'],
    dispatching: ['Finding a courier…', '🔍'], pending: ['Finding a courier…', '🔍'],
    pickup: ['Courier heading to the kitchen', '🛵'], dropoff: ['On its way to you', '🛵'],
    delivered: ['Delivered', '✅'], canceled: ['Delivery canceled', '⚠️'],
    returned: ['Returned to venue', '↩️'], failed: ['Arranging your courier', '⏳'],
  };
  const cardBdr = theme.isLight ? '#ececef' : '#2a2a30';
  const muted   = theme.isLight ? '#6b6b70' : '#a0a0a8';
  const inputBg = theme.isLight ? '#f5f5f7' : '#1f1f24';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50, background: theme.bg, color: theme.fg,
      overflowY: 'auto',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif',
    }}>
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '24px 22px 60px' }}>
        {/* Branded hero header — mirrors the storefront's Menu Appearance theme: hero photo (or a
            brand-colour gradient) with the logo on a plate shaped per logo_shape + the venue name. */}
        <div style={{
          position: 'relative', borderRadius: 18, overflow: 'hidden', marginBottom: 20, minHeight: 140,
          background: theme.hero ? `center/cover no-repeat url(${theme.hero})` : `linear-gradient(135deg, ${theme.accent}, ${theme.accent}bb)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {theme.hero && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.34)' }} />}
          <div style={{ position: 'relative', textAlign: 'center', padding: '24px 16px' }}>
            {theme.logo
              ? <img src={theme.logo} alt={theme.name} style={{ height: 60, width: theme.logoShape === 'circle' ? 60 : 'auto', maxWidth: 200, objectFit: theme.logoShape === 'circle' ? 'cover' : 'contain', background: '#fff', padding: theme.logoShape === 'circle' ? 0 : 7, borderRadius: theme.logoShape === 'circle' ? '50%' : 12, boxShadow: '0 2px 12px rgba(0,0,0,.2)' }} />
              : <div style={{ fontSize: 26, fontWeight: 900, color: '#fff', textShadow: '0 1px 4px rgba(0,0,0,.4)' }}>{theme.name}</div>}
            {theme.logo && <div style={{ fontSize: 15, fontWeight: 800, color: '#fff', marginTop: 8, textShadow: '0 1px 4px rgba(0,0,0,.5)' }}>{theme.name}</div>}
          </div>
        </div>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 6 }}>✅</div>
          <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: '-0.025em', color: theme.fg }}>Order confirmed</div>
          <div style={{ fontSize: 13, color: muted, marginTop: 6 }}>
            ref <span style={{ fontFamily: 'monospace', fontWeight: 700, color: theme.fg }}>{orderRef}</span>
          </div>
        </div>

        {loading && <div style={{ padding: 40, textAlign: 'center', color: muted }}>Loading order…</div>}
        {err && <div style={{ padding: 16, background: '#ef444415', border: '1px solid #ef444455', borderRadius: 10, color: '#b91c1c', fontSize: 13 }}>{err}</div>}

        {/* Step indicator */}
        <div style={{
          background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 16,
          padding: 20, marginBottom: 16,
        }}>
          {STEPS.map((step, i) => {
            const reached = i <= currentIdx;
            const isCurrent = i === currentIdx && status !== 'collected';
            return (
              <div key={step.key} style={{
                display: 'flex', alignItems: 'flex-start', gap: 14,
                paddingBottom: i === STEPS.length - 1 ? 0 : 16,
                position: 'relative',
              }}>
                {/* Connector line */}
                {i < STEPS.length - 1 && (
                  <div style={{
                    position: 'absolute', left: 21, top: 44, width: 2, height: 'calc(100% - 36px)',
                    background: i < currentIdx ? theme.accent : cardBdr,
                  }}/>
                )}
                {/* Icon bubble */}
                <div style={{
                  width: 44, height: 44, borderRadius: '50%',
                  background: reached ? theme.accent : 'transparent',
                  border: `2px solid ${reached ? theme.accent : cardBdr}`,
                  color: reached ? contrastFg(theme.accent) : muted,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, flexShrink: 0, position: 'relative',
                  animation: isCurrent ? 'pulse 1.6s ease-in-out infinite' : undefined,
                }}>
                  {step.icon}
                </div>
                <div style={{ flex: 1, paddingTop: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: reached ? theme.fg : muted }}>
                    {step.label}
                  </div>
                  <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
                    {isCurrent ? step.desc : (reached ? '✓ Done' : '')}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Live courier card (Stuart) — status + ETA + live tracking map. Only for courier
            delivery orders, once the order exists. */}
        {isCourier && (() => {
          const phase = courierPhase(courier);
          const badStateEarly = phase === 'terminal_bad';
          // Title must match the hero — a 'failed'/canceled state reads as a problem, not "arranging".
          const [clabel, cicon] = badStateEarly ? ['Delivery problem', '⚠️'] : (COURIER_LABEL[courier?.status] || ['Preparing your delivery', '🛵']);
          const late = courierLateness(courier);
          const dropTxt = fmtEta(courier?.eta);
          const pickedTxt = fmtEta(courier?.pickedAt);
          const deliveredTxt = fmtEta(courier?.deliveredAt);
          const badState = phase === 'terminal_bad';
          // One honest "arrival promise" hero: window/assigning → firm ETA → running-behind → delivered.
          let hero;
          if (phase === 'done') hero = <>Delivered{deliveredTxt ? <> at <b style={{ color: theme.fg }}>{deliveredTxt}</b></> : ''} — enjoy! 🎉</>;
          else if (badState) hero = <>There’s a problem with this delivery — please contact us and we’ll sort it.</>;
          else if (phase === 'scheduled') hero = <>Scheduled for later{dropTxt ? <> — arriving around <b style={{ color: theme.fg }}>{dropTxt}</b></> : ''}. Your courier is booked; we’ll confirm closer to the time.</>;
          else if (late.known && !late.onTime) hero = <span style={{ color: '#b45309', fontWeight: 700 }}>Running a little behind — your driver is on the way.</span>;
          else if (dropTxt) hero = <>Arriving by <b style={{ color: theme.fg }}>{dropTxt}</b>{courier?.courierFirstName ? ` · ${courier.courierFirstName} is your driver` : ''}</>;
          else hero = <>A courier is being assigned — we’ll text you a tracking link.</>;
          return (
            <div style={{ background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 16, padding: 18, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 22 }}>{cicon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: theme.fg }}>{clabel}</div>
                  <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>{hero}</div>
                </div>
              </div>
              {/* Mini timeline — collected / estimated / delivered, only what's known. */}
              {!badState && (pickedTxt || dropTxt || deliveredTxt) && (
                <div style={{ marginTop: 10, fontSize: 12, color: muted, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {pickedTxt && <div style={{ color: '#16a34a', fontWeight: 700 }}>✓ Collected from the kitchen · {pickedTxt}</div>}
                  {phase === 'done'
                    ? <div style={{ color: '#16a34a', fontWeight: 700 }}>✓ Delivered · {deliveredTxt}</div>
                    : (dropTxt && !(late.known && !late.onTime)) ? <div>~ Estimated to you · {dropTxt}</div> : null}
                </div>
              )}
              {/* Call the driver (real browser → tel: works). */}
              {courier?.courierPhone && !badState && phase !== 'done' && (
                <a href={`tel:${courier.courierPhone}`} style={{ display: 'inline-block', marginTop: 10, fontSize: 13, fontWeight: 800, color: theme.accent, textDecoration: 'none' }}>📞 Call your driver</a>
              )}
              {/* Live tracking map — Stuart's shareable tracking page embedded (browser only). */}
              {courier?.trackingUrl && !badState && (
                <div style={{ marginTop: 14, borderRadius: 12, overflow: 'hidden', border: `1px solid ${cardBdr}` }}>
                  <iframe title="Live delivery tracking" src={courier.trackingUrl} style={{ width: '100%', height: 280, border: 0, display: 'block' }} loading="lazy" />
                </div>
              )}
              {courier?.trackingUrl && !badState && (
                <a href={courier.trackingUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 10, fontSize: 13, fontWeight: 800, color: theme.accent, textDecoration: 'none' }}>Open full tracking map ↗</a>
              )}
            </div>
          );
        })()}

        {/* Order summary */}
        {/* Shareable link — customers can bookmark this and come back any time. */}
        {order && <ShareLink order={order} theme={theme} cardBdr={cardBdr} muted={muted} inputBg={inputBg}/>}

        {order && (
          <div style={{
            background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 16,
            padding: '14px 18px', marginBottom: 16,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: muted, marginBottom: 10 }}>
              Order summary
            </div>
            {(order.items || []).map((line, i) => {
              const qty = line.qty || 1;
              const unit = (Number(line.price) || 0) + (line.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>{qty} × {line.name}</span>
                  <span style={{ fontWeight: 700 }}>{money((unit * qty))}</span>
                </div>
              );
            })}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', borderTop: `1px solid ${cardBdr}`, marginTop: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 800 }}>Total paid</span>
              <span style={{ fontSize: 16, fontWeight: 900 }}>{money(Number(order.total || 0))}</span>
            </div>
            {order.collection_time && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: `${theme.accent}15`, border: `1px solid ${cardBdr}`, fontSize: 12 }}>
                {order.is_asap
                  ? <>⚡ <b>ASAP</b> — we'll start preparing right away.{isDelivery ? ' Your courier is arranged once it’s ready.' : ''}</>
                  : (isDelivery
                      ? <>🗓 {orderType === 'delivery' ? 'Delivery' : 'Collection'} for <b>{order.collection_time}</b></>
                      : <>🗓 Collection at <b>{order.collection_time}</b></>)}
              </div>
            )}
          </div>
        )}

        <button onClick={onClose} className="op-btn" style={{
          width: '100%', padding: '14px 18px', borderRadius: 12,
          background: 'transparent', color: theme.fg, border: `1.5px solid ${cardBdr}`,
          fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
        }}>Place another order</button>
      </div>
    </div>
  );
}

// Shareable link — combines the order ref with the last-4 digits of the
// phone used to place the order, so the URL is bookmarkable but mildly
// gated against random ref-guessing.
function ShareLink({ order, theme, cardBdr, muted, inputBg }) {
  const [copied, setCopied] = useState(false);
  const phone = String(order?.customer?.phone || '').replace(/\D/g, '');
  const p4 = phone.slice(-4);
  const url = useMemo(() => {
    if (!order?.ref || !p4) return null;
    const u = new URL(window.location.origin + window.location.pathname);
    // Preserve the slug-resolution query (?loc=…) if present.
    const loc = new URL(window.location.href).searchParams.get('loc');
    if (loc) u.searchParams.set('loc', loc);
    u.searchParams.set('track', order.ref);
    u.searchParams.set('p', p4);
    return u.toString();
  }, [order?.ref, p4]);
  if (!url) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: `Order ${order.ref}`, url }); }
      catch {}
    } else {
      copy();
    }
  };

  return (
    <div style={{
      background: inputBg, border: `1px solid ${cardBdr}`, borderRadius: 16,
      padding: '14px 18px', marginBottom: 16,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: muted, marginBottom: 8 }}>
        Track this order anytime
      </div>
      <div style={{ fontSize: 12, color: muted, lineHeight: 1.5, marginBottom: 10 }}>
        Bookmark or share this link — it'll always show the live status of your order.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <div style={{
          flex: 1, minWidth: 0,
          padding: '10px 12px', borderRadius: 10,
          background: theme.isLight ? '#fff' : '#0e0e10',
          border: `1px solid ${cardBdr}`,
          fontSize: 11, fontFamily: 'monospace',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          display: 'flex', alignItems: 'center',
        }}>{url}</div>
        <button onClick={copy} className="op-btn" style={{
          padding: '0 14px', borderRadius: 10,
          background: copied ? '#22c55e' : theme.accent, color: '#fff',
          border: 'none', fontSize: 12, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
          flexShrink: 0,
        }}>{copied ? '✓ Copied' : 'Copy'}</button>
        {typeof navigator !== 'undefined' && navigator.share && (
          <button onClick={share} className="op-btn" style={{
            padding: '0 14px', borderRadius: 10,
            background: 'transparent', color: theme.fg,
            border: `1px solid ${cardBdr}`, fontSize: 12, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
            flexShrink: 0,
          }}>Share</button>
        )}
      </div>
    </div>
  );
}

function contrastFg(hex) {
  if (!hex) return '#fff';
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  if (n.length !== 6) return '#fff';
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? '#0b0c10' : '#ffffff';
}
