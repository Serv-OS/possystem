// Transactions — Report sub-view inside BOReports (Order reports category).
// Shows all closed checks with search, expandable item details, and refund capability.
//
// v5.5.274: Initial build
// v5.5.275: Moved from standalone sidebar section into Reports catalog.
//           Now receives `checks` + `fmt` from parent BOReports (which handles
//           period selection and server/orderType/source filters). This component
//           adds its own text search, status/method filters, and refund modal.
// v5.5.276: Email receipt — send receipt from expanded row, pre-fills customer
//           email when available.

import { useState, useMemo, useEffect, Fragment } from 'react';
import { useStore } from '../../store';
import { sendEmailReceipt } from '../../lib/sendReceipt';
import { getLocationId } from '../../lib/supabase';
import { loadLocationBranding } from '../../lib/receiptBranding';
import { money } from '../../lib/currency';
import { refundBreakdown, cardLegsOf, legRefundedMinor, toMinor } from '../../lib/payments/refundMath';

// ── Formatting helpers ──────────────────────────────────────────────
const fmtDate = ts => {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtTime = ts => {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};
const fmtDateTime = ts => `${fmtDate(ts)} ${fmtTime(ts)}`.trim();

// ── Status badge ────────────────────────────────────────────────────
const STATUS_STYLES = {
  paid:           { bg: '#22c55e18', color: '#16a34a', border: '#22c55e40', label: 'Paid' },
  partial_refund: { bg: '#f59e0b18', color: '#d97706', border: '#f59e0b40', label: 'Partial refund' },
  refunded:       { bg: '#ef444418', color: '#dc2626', border: '#ef444440', label: 'Refunded' },
  voided:         { bg: '#6b728018', color: '#4b5563', border: '#6b728040', label: 'Voided' },
};
function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.paid;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 6,
      fontSize: 12, fontWeight: 700, background: s.bg, color: s.color,
      border: `1px solid ${s.border}`, whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}

// ── Source label ─────────────────────────────────────────────────────
const SOURCE_LABELS = { pos: 'POS', kiosk: 'Kiosk', online: 'Online', qr: 'QR', catering: 'Catering', hubrise: 'Delivery channels' };
// v5.5.855: the ORDER SOURCE for a delivery-channel sale is the platform that took the
// order (Deliveroo / Uber Eats / Just Eat) — 'hubrise' is just the pipe. Unmapped
// sources show their raw value, never a silent 'POS'.
const sourceLabel = (c) =>
  c.source === 'hubrise' ? (c.customer?.channel || 'Delivery channel')
    : (SOURCE_LABELS[c.source || 'pos'] || c.source || 'POS');

// ═════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════
export default function Transactions({ checks: parentChecks = [], fmt: parentFmt }) {
  const { refundCheck, retryRefundReversal, staff } = useStore();
  const fmt = parentFmt || (n => `${money((n || 0))}`);

  // ── State ──
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [methodFilter, setMethodFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);

  // Refund modal state
  const [refundTarget, setRefundTarget] = useState(null);
  const [refundMode, setRefundMode] = useState('full');
  const [refundSelections, setRefundSelections] = useState({});
  const [refundReason, setRefundReason] = useState('');
  const [refundConfirm, setRefundConfirm] = useState(false);
  // v5.6.79 — null = use the pro-rata default; a number is a deliberate override.
  const [refundTip, setRefundTip] = useState(null);
  const [refundService, setRefundService] = useState(null);
  const [legPicks, setLegPicks] = useState(null);
  const [refundBusy, setRefundBusy] = useState(false);
  const [retrying, setRetrying] = useState(null);

  // Email receipt state
  const [emailCheckId, setEmailCheckId] = useState(null);   // which check's email form is open
  const [emailAddr, setEmailAddr] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailResult, setEmailResult] = useState(null);      // { ok, error? }
  const [locationLabel, setLocationLabel] = useState('');
  const [locId, setLocId] = useState(null);

  // Resolve location context once for email receipts
  useEffect(() => {
    (async () => {
      try {
        const id = await getLocationId();
        setLocId(id);
        const branding = await loadLocationBranding(id);
        setLocationLabel(branding?.header?.business_name || '');
      } catch {}
    })();
  }, []);

  // When opening email form for a check, pre-fill customer email
  const openEmailForm = (check) => {
    const custEmail = typeof check.customer === 'object' ? check.customer?.email || '' : '';
    setEmailCheckId(check.id);
    setEmailAddr(custEmail);
    setEmailResult(null);
  };

  const sendReceipt = async (check) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddr.trim())) {
      setEmailResult({ ok: false, error: 'Please enter a valid email address' });
      return;
    }
    setEmailBusy(true);
    setEmailResult(null);
    const result = await sendEmailReceipt({
      to: emailAddr.trim(),
      locationId: locId,
      check,
      locationLabel: locationLabel || 'Restaurant',
    });
    setEmailBusy(false);
    setEmailResult(result);
    if (result.ok) {
      // Auto-close after 2s on success
      setTimeout(() => { setEmailCheckId(null); setEmailResult(null); }, 2000);
    }
  };

  // ── Filtering + search ──
  const filtered = useMemo(() => {
    let list = parentChecks;
    if (statusFilter !== 'all') list = list.filter(c => c.status === statusFilter);
    if (methodFilter !== 'all') list = list.filter(c => c.method === methodFilter);
    if (sourceFilter !== 'all') list = list.filter(c => (c.source || 'pos') === sourceFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(c =>
        (c.ref || '').toLowerCase().includes(q) ||
        (c.server || '').toLowerCase().includes(q) ||
        (typeof c.customer === 'string' ? c.customer : c.customer?.name || '').toLowerCase().includes(q) ||
        (c.id || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [parentChecks, statusFilter, methodFilter, sourceFilter, search]);

  // Unique values for filter dropdowns
  const methods = useMemo(() => [...new Set(parentChecks.map(c => c.method).filter(Boolean))].sort(), [parentChecks]);
  const sources = useMemo(() => [...new Set(parentChecks.map(c => c.source || 'pos'))].sort(), [parentChecks]);

  // ── Summary stats ──
  const stats = useMemo(() => {
    const total = filtered.reduce((s, c) => s + (c.total || 0), 0);
    const tips = filtered.reduce((s, c) => s + (c.tip || 0), 0);
    const service = filtered.reduce((s, c) => s + (c.service || 0), 0);
    const refunds = filtered.reduce((s, c) => s + (c.refunds || []).reduce((rs, r) => rs + (r.amount || 0), 0), 0);
    return { count: filtered.length, total, tips, service, refunds };
  }, [filtered]);

  // ── Refund handlers ──
  const openRefund = (check) => {
    setRefundTarget(check);
    setRefundMode('full');
    setRefundSelections({});
    setRefundReason('');
    setRefundConfirm(false);
    setRefundTip(null);
    setRefundService(null);
    setLegPicks(null);
  };

  const toggleRefundItem = (uid, maxQty) => {
    setRefundSelections(prev => {
      const cur = prev[uid] || 0;
      if (cur >= maxQty) {
        const next = { ...prev };
        delete next[uid];
        return next;
      }
      return { ...prev, [uid]: cur + 1 };
    });
  };

  // The items the operator picked, in the shape refundCheck expects.
  const refundItems = useMemo(() => {
    if (!refundTarget) return [];
    const items = refundTarget.items || [];
    if (refundMode === 'full') return items.map(i => ({ ...i, refundQty: i.qty || 1 }));
    return Object.entries(refundSelections)
      .filter(([, qty]) => qty > 0)
      .map(([uid, qty]) => {
        const item = items.find(i => i.uid === uid || i.id === uid);
        return item ? { ...item, refundQty: qty } : null;
      })
      .filter(Boolean);
  }, [refundTarget, refundMode, refundSelections]);

  // v5.6.79 (#108) — one shared breakdown, so this screen, the POS and MPOS
  // cannot disagree about what a refund is worth. The old full-refund figure was
  // `subtotal − alreadyRefunded`, which (a) never returned the tip or the service
  // charge and (b) clamped to £0 once a tip-inclusive refund had been recorded,
  // silently offering a nil "full refund" and blocking the remainder.
  const bd = useMemo(
    () => (refundTarget
      ? refundBreakdown(refundTarget, {
          items: refundItems, isFullRefund: refundMode === 'full',
          tipOverride: refundTip, serviceOverride: refundService,
        })
      : null),
    [refundTarget, refundItems, refundMode, refundTip, refundService],
  );
  const refundAmount = bd?.amount || 0;

  const legs = useMemo(() => (refundTarget ? cardLegsOf(refundTarget) : []), [refundTarget]);
  const legDone = useMemo(() => (refundTarget ? legRefundedMinor(refundTarget) : {}), [refundTarget]);
  const legRoom = (l) => (l.amountMinor == null ? null : Math.max(0, l.amountMinor - (legDone[l.id] || 0)));
  const defaultPicks = useMemo(() => {
    let remain = toMinor(refundAmount); const out = {};
    for (const l of legs) {
      if (remain <= 0) break;
      const room = legRoom(l);
      const take = room == null ? remain : Math.min(remain, room);
      if (take <= 0) continue;
      out[l.id] = take; remain -= take;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, refundAmount, legDone]);
  const picks = legPicks || defaultPicks;
  const pickedMinor = legs.reduce((s, l) => s + (Number(picks[l.id]) || 0), 0);

  // v5.6.79 — AWAIT the refund. This used to fire and close the modal instantly,
  // so a reversal that never reached a processor looked exactly like one that did.
  const executeRefund = async () => {
    if (!refundTarget || !refundReason.trim() || refundBusy) return;
    if (refundItems.length === 0 && refundAmount <= 0) return;
    setRefundBusy(true);
    const res = await refundCheck(refundTarget.id, {
      items: refundItems,
      isFullRefund: refundMode === 'full',
      manager: { name: staff?.name || 'Back Office', id: staff?.id || 'bo' },
      reason: refundReason.trim(),
      tenderMethod: 'card',
      tipAmount: bd?.tip ?? null,
      serviceAmount: bd?.service ?? null,
      legRefunds: legs.length > 1 ? picks : null,
    });
    setRefundBusy(false);
    // Keep the modal open on a failed reversal so the error is unmissable.
    if (res?.ok !== false) setRefundTarget(null);
  };

  const retryReversal = async (checkId, refundId) => {
    if (retrying) return;
    setRetrying(refundId);
    await retryRefundReversal(checkId, refundId);
    setRetrying(null);
  };

  // ── Styles ──
  const card = { background: 'var(--bg1, #fff)', borderRadius: 12, border: '1px solid var(--bdr, #e5e7eb)', overflow: 'hidden' };
  const statCard = { ...card, padding: '16px 20px', flex: 1, minWidth: 140 };
  const thStyle = { padding: '10px 12px', textAlign: 'left', fontSize: 12, fontWeight: 700, color: 'var(--t3, #6b7280)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--bdr, #e5e7eb)', whiteSpace: 'nowrap' };
  const tdStyle = { padding: '12px 12px', fontSize: 14, borderBottom: '1px solid var(--bdr, #e5e7eb)', verticalAlign: 'middle' };
  const inputStyle = { padding: '8px 12px', border: '1px solid var(--bdr, #e5e7eb)', borderRadius: 8, fontSize: 13, background: 'var(--bg, #fff)', color: 'var(--t1, #111)', fontFamily: 'inherit', outline: 'none' };
  const selectStyle = { ...inputStyle, cursor: 'pointer' };
  const btnPrimary = { padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--acc, #E8743C)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
  const btnOutline = { padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr, #e5e7eb)', background: 'transparent', color: 'var(--t1, #111)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' };

  return (
    <div>
      {/* Summary stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={statCard}>
          <div style={{ fontSize: 11, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Transactions</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{stats.count}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 11, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Revenue</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{fmt(stats.total)}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 11, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Tips</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{fmt(stats.tips)}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 11, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Service</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{fmt(stats.service)}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 11, color: 'var(--t4)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Refunded</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: stats.refunds > 0 ? '#dc2626' : undefined }}>{fmt(stats.refunds)}</div>
        </div>
      </div>

      {/* Search + filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search order #, customer, server..."
            style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
          />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="all">All statuses</option>
          <option value="paid">Paid</option>
          <option value="partial_refund">Partial refund</option>
          <option value="refunded">Refunded</option>
          <option value="voided">Voided</option>
        </select>
        {methods.length > 1 && (
          <select value={methodFilter} onChange={e => setMethodFilter(e.target.value)} style={selectStyle}>
            <option value="all">All methods</option>
            {methods.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
          </select>
        )}
        {sources.length > 1 && (
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} style={selectStyle}>
            <option value="all">All sources</option>
            {sources.map(s => <option key={s} value={s}>{SOURCE_LABELS[s] || s}</option>)}
          </select>
        )}
      </div>

      {/* Transactions table */}
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr style={{ background: 'var(--bg3, #f9fafb)' }}>
              <th style={thStyle}>Order #</th>
              <th style={thStyle}>Date / Time</th>
              <th style={thStyle}>Server</th>
              <th style={thStyle}>Customer</th>
              <th style={thStyle}>Source</th>
              <th style={thStyle}>Method</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Subtotal</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Service</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Tip</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={12} style={{ ...tdStyle, textAlign: 'center', padding: 40, color: 'var(--t4, #9ca3af)' }}>
                  No transactions found for this period
                </td>
              </tr>
            )}
            {filtered.map(c => {
              const custName = typeof c.customer === 'string' ? c.customer : c.customer?.name || '';
              const isExpanded = expandedId === c.id;
              const canRefund = c.status !== 'refunded' && c.status !== 'voided';
              const totalRefunded = (c.refunds || []).reduce((s, r) => s + (r.amount || 0), 0);
              return (
                <Fragment key={c.id}>
                  <tr
                    onClick={() => setExpandedId(isExpanded ? null : c.id)}
                    style={{ cursor: 'pointer', background: isExpanded ? 'var(--bg3, #f9fafb)' : 'transparent' }}
                  >
                    <td style={{ ...tdStyle, fontWeight: 700, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{c.ref || c.id?.slice(0, 8)}</td>
                    <td style={tdStyle}>{fmtDateTime(c.closedAt)}</td>
                    <td style={tdStyle}>{c.server || '—'}</td>
                    <td style={tdStyle}>{custName || '—'}</td>
                    <td style={tdStyle}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                        background: 'var(--bg3, #f3f4f6)', color: 'var(--t2, #374151)',
                      }}>{sourceLabel(c)}</span>
                    </td>
                    <td style={tdStyle}>{(c.method || '').charAt(0).toUpperCase() + (c.method || '').slice(1)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{fmt(c.subtotal)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: c.service ? 'var(--t1)' : 'var(--t4, #ccc)' }}>{fmt(c.service)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: c.tip ? 'var(--t1)' : 'var(--t4, #ccc)' }}>{fmt(c.tip)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{fmt(c.total)}</td>
                    <td style={tdStyle}><StatusBadge status={c.status} /></td>
                    <td style={{ ...tdStyle, textAlign: 'center', fontSize: 16 }}>{isExpanded ? '▲' : '▼'}</td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={12} style={{ padding: 0, background: 'var(--bg3, #f9fafb)', borderBottom: '1px solid var(--bdr, #e5e7eb)' }}>
                        <div style={{ padding: '16px 20px', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                          {/* Left: Line items */}
                          <div style={{ flex: 2, minWidth: 300 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--t2, #374151)' }}>Line items</div>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                              <thead>
                                <tr>
                                  <th style={{ ...thStyle, padding: '6px 8px' }}>Item</th>
                                  <th style={{ ...thStyle, padding: '6px 8px', textAlign: 'center' }}>Qty</th>
                                  <th style={{ ...thStyle, padding: '6px 8px', textAlign: 'right' }}>Price</th>
                                  <th style={{ ...thStyle, padding: '6px 8px', textAlign: 'right' }}>Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(c.items || []).map((item, idx) => (
                                  <tr key={item.uid || item.id || idx}>
                                    <td style={{ padding: '6px 8px', fontSize: 13 }}>
                                      {item.name}
                                      {item.mods && <span style={{ color: 'var(--t4)', fontSize: 11, display: 'block' }}>{typeof item.mods === 'string' ? item.mods : Array.isArray(item.mods) ? item.mods.join(', ') : ''}</span>}
                                    </td>
                                    <td style={{ padding: '6px 8px', fontSize: 13, textAlign: 'center' }}>{item.qty || 1}</td>
                                    <td style={{ padding: '6px 8px', fontSize: 13, textAlign: 'right', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{fmt(item.price)}</td>
                                    <td style={{ padding: '6px 8px', fontSize: 13, textAlign: 'right', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{fmt((item.price || 0) * (item.qty || 1))}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>

                            {/* Discounts */}
                            {(c.discounts || []).length > 0 && (
                              <div style={{ marginTop: 12 }}>
                                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t4)', marginBottom: 4 }}>Discounts</div>
                                {c.discounts.map((d, i) => (
                                  <div key={i} style={{ fontSize: 13, color: '#16a34a', padding: '2px 0' }}>
                                    {d.name || d.label || 'Discount'}: -{fmt(d.amount || d.value || 0)}
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Totals breakdown */}
                            <div style={{ marginTop: 12, borderTop: '1px solid var(--bdr, #e5e7eb)', paddingTop: 10 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3 }}>
                                <span>Subtotal</span><span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{fmt(c.subtotal)}</span>
                              </div>
                              {c.service > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3, color: 'var(--t2)' }}>
                                  <span>Service charge</span><span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{fmt(c.service)}</span>
                                </div>
                              )}
                              {c.tip > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3, color: 'var(--t2)' }}>
                                  <span>Tip</span><span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{fmt(c.tip)}</span>
                                </div>
                              )}
                              {(c.taxAmount || 0) > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 3, color: 'var(--t2)' }}>
                                  <span>Tax</span><span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{fmt(c.taxAmount)}</span>
                                </div>
                              )}
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 800, marginTop: 4 }}>
                                <span>Total</span><span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>{fmt(c.total)}</span>
                              </div>
                              {totalRefunded > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#dc2626', fontWeight: 700, marginTop: 4 }}>
                                  <span>Refunded</span><span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>-{fmt(totalRefunded)}</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Right: Refund history + Refund action */}
                          <div style={{ flex: 1, minWidth: 260 }}>
                            {/* Refund history */}
                            {(c.refunds || []).length > 0 && (
                              <div style={{ marginBottom: 16 }}>
                                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--t2, #374151)' }}>Refund history</div>
                                {c.refunds.map((r, i) => (
                                  <div key={r.id || i} style={{
                                    padding: '10px 12px', borderRadius: 8, marginBottom: 6,
                                    background: '#fef2f2', border: '1px solid #fecaca', fontSize: 13,
                                  }}>
                                    <div style={{ fontWeight: 700, color: '#dc2626' }}>-{fmt(r.amount)} {r.isFullRefund ? '(Full refund)' : '(Partial)'}</div>
                                    <div style={{ color: '#7f1d1d', marginTop: 2 }}>Reason: {r.reason || '—'}</div>
                                    <div style={{ color: '#991b1b', fontSize: 11, marginTop: 2 }}>
                                      By: {r.manager || '—'} | {r.timestamp ? fmtDateTime(r.timestamp) : '—'}
                                    </div>
                                    {r.items && r.items.length > 0 && (
                                      <div style={{ marginTop: 4, fontSize: 11, color: '#7f1d1d' }}>
                                        Items: {r.items.map(ri => `${ri.name} x${ri.refundQty || 1}`).join(', ')}
                                      </div>
                                    )}
                                    {((r.serviceAmount || 0) > 0 || (r.tipAmount || 0) > 0) && (
                                      <div style={{ marginTop: 2, fontSize: 11, color: '#7f1d1d' }}>
                                        {(r.serviceAmount || 0) > 0 ? `Service ${fmt(r.serviceAmount)}` : ''}
                                        {(r.serviceAmount || 0) > 0 && (r.tipAmount || 0) > 0 ? ' · ' : ''}
                                        {(r.tipAmount || 0) > 0 ? `Tip ${fmt(r.tipAmount)}` : ''}
                                      </div>
                                    )}
                                    {/* v5.6.79 (#107) — did the card actually get reversed?
                                        A failed reversal must never read as a completed refund. */}
                                    {r.cardStatus && (() => {
                                      const meta = CARD_STATUS_META[r.cardStatus] || CARD_STATUS_META.pending;
                                      const canRetry = (r.legs || []).some(l => l?.status === 'failed');
                                      return (
                                        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed #fecaca' }}>
                                          <div style={{ fontSize: 11, fontWeight: 700, color: meta.color }}>{meta.icon} {meta.label}</div>
                                          {(r.legs || []).map((l, li) => (
                                            <div key={li} style={{ fontSize: 11, color: '#7f1d1d', marginTop: 2 }}>
                                              {l.brand || 'card'}{l.last4 ? ` ····${l.last4}` : ''} {fmt((l.amountMinor || 0) / 100)} · {l.processor} · {l.status}
                                              {l.ref ? ` · ${l.ref}` : ''}{l.error ? ` · ${l.error}` : ''}
                                            </div>
                                          ))}
                                          {canRetry && (
                                            <button onClick={() => retryReversal(c.id, r.id)} disabled={retrying === r.id}
                                              style={{ marginTop: 6, padding: '5px 10px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 700, cursor: retrying === r.id ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                                              {retrying === r.id ? 'Retrying…' : '↻ Retry card reversal'}
                                            </button>
                                          )}
                                        </div>
                                      );
                                    })()}
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Additional info */}
                            <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--t2)', lineHeight: 1.8 }}>
                              {c.tableLabel && <div><strong>Table:</strong> {c.tableLabel}</div>}
                              {c.orderType && <div><strong>Order type:</strong> {c.orderType}</div>}
                              {c.covers > 0 && <div><strong>Covers:</strong> {c.covers}</div>}
                              {/* Delivery / collection customer info — fee, address, fulfilment. */}
                              {(() => {
                                const cust = typeof c.customer === 'object' ? (c.customer || {}) : {};
                                const addr = cust.address;
                                const addrStr = !addr ? '' : (typeof addr === 'string' ? addr : [addr.line1, addr.line2, addr.city, addr.postcode].filter(Boolean).join(', '));
                                const isDeliveryish = /deliver/i.test(c.orderType || '') || cust.delivery_fee != null || cust.delivery_mode || addrStr;
                                if (!isDeliveryish) return null;
                                return (
                                  <>
                                    {cust.phone && <div><strong>Phone:</strong> {cust.phone}</div>}
                                    {addrStr && <div><strong>Address:</strong> {addrStr}</div>}
                                    {cust.delivery_mode && <div><strong>Fulfilment:</strong> {cust.delivery_mode === 'uber' ? 'Courier' : 'Self-delivery'}</div>}
                                    {cust.delivery_fee != null && <div><strong>Delivery fee:</strong> {fmt(Number(cust.delivery_fee))}</div>}
                                  </>
                                );
                              })()}
                              {c.staffId && <div><strong>Staff ID:</strong> {c.staffId}</div>}
                              <div><strong>Check ID:</strong> <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11 }}>{c.id}</span></div>
                            </div>

                            {/* Email receipt */}
                            <div style={{ marginBottom: 12 }}>
                              {emailCheckId === c.id ? (
                                <div style={{
                                  padding: '12px 14px', borderRadius: 10,
                                  background: 'var(--bg1, #fff)', border: '1px solid var(--bdr, #e5e7eb)',
                                }}>
                                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--t2)' }}>Email receipt</div>
                                  <input
                                    value={emailAddr}
                                    onChange={e => { setEmailAddr(e.target.value); setEmailResult(null); }}
                                    placeholder="customer@email.com"
                                    type="email"
                                    onClick={e => e.stopPropagation()}
                                    style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
                                  />
                                  {emailResult && (
                                    <div style={{
                                      fontSize: 12, marginBottom: 8, fontWeight: 600,
                                      color: emailResult.ok ? '#16a34a' : '#dc2626',
                                    }}>
                                      {emailResult.ok ? 'Receipt sent!' : emailResult.error || 'Failed to send'}
                                    </div>
                                  )}
                                  <div style={{ display: 'flex', gap: 8 }}>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setEmailCheckId(null); setEmailResult(null); }}
                                      style={{ ...btnOutline, flex: 1, fontSize: 12, padding: '6px 12px' }}
                                    >Cancel</button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); sendReceipt(c); }}
                                      disabled={emailBusy || !emailAddr.trim()}
                                      style={{
                                        ...btnPrimary, flex: 1, fontSize: 12, padding: '6px 12px',
                                        opacity: (emailBusy || !emailAddr.trim()) ? 0.5 : 1,
                                        cursor: (emailBusy || !emailAddr.trim()) ? 'not-allowed' : 'pointer',
                                      }}
                                    >{emailBusy ? 'Sending...' : 'Send'}</button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); openEmailForm(c); }}
                                  style={{ ...btnOutline, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                >
                                  {'✉'} Email receipt
                                </button>
                              )}
                            </div>

                            {/* Refund button */}
                            {canRefund && (
                              <button
                                onClick={(e) => { e.stopPropagation(); openRefund(c); }}
                                style={{ ...btnPrimary, background: '#dc2626', width: '100%' }}
                              >
                                Refund this order
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Results count */}
      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--t4, #9ca3af)' }}>
        Showing {filtered.length} of {parentChecks.length} transactions
      </div>

      {/* ═══ Refund Modal ═══ */}
      {refundTarget && (
        <div
          onClick={() => setRefundTarget(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'grid', placeItems: 'center', zIndex: 1000, padding: 20,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--bg, #fff)', borderRadius: 16, padding: 28,
              width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
              boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
            }}
          >
            <h2 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 800 }}>
              Refund order #{refundTarget.ref || refundTarget.id?.slice(0, 8)}
            </h2>
            <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--t3, #6b7280)' }}>
              Original total: {fmt(refundTarget.total)} | Subtotal: {fmt(refundTarget.subtotal)}
              {(refundTarget.refunds || []).length > 0 && ` | Already refunded: ${fmt((refundTarget.refunds || []).reduce((s, r) => s + (r.amount || 0), 0))}`}
            </p>

            {/* Refund mode toggle */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button
                onClick={() => { setRefundMode('full'); setRefundSelections({}); }}
                style={{
                  ...btnOutline, flex: 1,
                  background: refundMode === 'full' ? 'var(--acc, #E8743C)' : 'transparent',
                  color: refundMode === 'full' ? '#fff' : 'var(--t1)',
                  borderColor: refundMode === 'full' ? 'var(--acc)' : undefined,
                }}
              >Full refund</button>
              <button
                onClick={() => setRefundMode('items')}
                style={{
                  ...btnOutline, flex: 1,
                  background: refundMode === 'items' ? 'var(--acc, #E8743C)' : 'transparent',
                  color: refundMode === 'items' ? '#fff' : 'var(--t1)',
                  borderColor: refundMode === 'items' ? 'var(--acc)' : undefined,
                }}
              >Select items</button>
            </div>

            {/* Item selection (for item-level refund) */}
            {refundMode === 'items' && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--t2)' }}>
                  Tap items to add to refund
                </div>
                {(refundTarget.items || []).map((item, idx) => {
                  const uid = item.uid || item.id || `item-${idx}`;
                  const selectedQty = refundSelections[uid] || 0;
                  const maxQty = item.qty || 1;
                  return (
                    <div
                      key={uid}
                      onClick={() => toggleRefundItem(uid, maxQty)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 12px', borderRadius: 8, marginBottom: 4,
                        background: selectedQty > 0 ? '#fef2f2' : 'var(--bg3, #f9fafb)',
                        border: `1px solid ${selectedQty > 0 ? '#fca5a5' : 'var(--bdr, #e5e7eb)'}`,
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{
                        width: 24, height: 24, borderRadius: 6,
                        background: selectedQty > 0 ? '#dc2626' : 'var(--bg, #fff)',
                        border: `2px solid ${selectedQty > 0 ? '#dc2626' : '#d1d5db'}`,
                        display: 'grid', placeItems: 'center',
                        color: '#fff', fontSize: 12, fontWeight: 800, flexShrink: 0,
                      }}>{selectedQty > 0 ? selectedQty : ''}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{item.name}</div>
                        {item.mods && <div style={{ fontSize: 11, color: 'var(--t4)' }}>{typeof item.mods === 'string' ? item.mods : Array.isArray(item.mods) ? item.mods.join(', ') : ''}</div>}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--t4)', flexShrink: 0 }}>x{maxQty}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono, ui-monospace, monospace)', flexShrink: 0 }}>{fmt(item.price)}</div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Refund reason */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 700, color: 'var(--t2)', display: 'block', marginBottom: 6 }}>Reason for refund *</label>
              <input
                value={refundReason}
                onChange={e => setRefundReason(e.target.value)}
                placeholder="e.g. Customer complaint, wrong order, quality issue..."
                style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
              />
            </div>

            {/* ── Tip + service charge (v5.6.79, #108) ────────────────────────
                Never refundable before this: the amount came off the items alone,
                so the customer kept paying a gratuity on a meal they did not have
                and the tip stayed in the tronc pool. Pro-rata by default on a
                part refund; the operator can override either figure. */}
            {bd && (bd.tipRemaining > 0 || bd.serviceRemaining > 0) && (
              <div style={{ marginBottom: 16, padding: '12px 14px', borderRadius: 10, background: 'var(--bg3, #f9fafb)', border: '1px solid var(--bdr, #e5e7eb)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--t2)' }}>Tip &amp; service to return</div>
                {bd.serviceRemaining > 0 && (
                  <MoneyField label="Service charge" hint={refundMode === 'full' ? 'all of it' : `pro-rata ${fmt(bd.proRataService)}`}
                    value={bd.service} max={bd.serviceRemaining} disabled={refundMode === 'full'}
                    onChange={setRefundService} onReset={() => setRefundService(null)} overridden={refundService != null}
                    inputStyle={inputStyle} fmt={fmt} />
                )}
                {bd.tipRemaining > 0 && (
                  <MoneyField label="Tip" hint={refundMode === 'full' ? 'all of it' : `pro-rata ${fmt(bd.proRataTip)}`}
                    value={bd.tip} max={bd.tipRemaining} disabled={refundMode === 'full'}
                    onChange={setRefundTip} onReset={() => setRefundTip(null)} overridden={refundTip != null}
                    inputStyle={inputStyle} fmt={fmt} />
                )}
              </div>
            )}

            {/* ── Per-card allocation on a split check (v5.6.79, #107) ────────
                A split check was paid by several cards and the refund UI had no
                concept of that. Each row is clamped to what THAT card paid, less
                anything already refunded to it. */}
            {legs.length > 1 && (
              <div style={{ marginBottom: 16, padding: '12px 14px', borderRadius: 10, background: 'var(--bg3, #f9fafb)', border: '1px solid var(--bdr, #e5e7eb)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--t2)' }}>
                  Paid on {legs.length} cards — how much goes back to each?
                </div>
                {legs.map((l, i) => {
                  const room = legRoom(l);
                  const val = (Number(picks[l.id]) || 0) / 100;
                  return (
                    <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '5px 0' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{l.brand || 'Card'}{l.last4 ? ` ····${l.last4}` : ''}{i === 0 ? ' · till' : ''}</div>
                        <div style={{ fontSize: 11, color: 'var(--t4)' }}>
                          {l.amountMinor != null ? `paid ${fmt(l.amountMinor / 100)}` : 'amount unknown'} · {l.processor}
                        </div>
                      </div>
                      <input type="number" step="0.01" min="0" max={room != null ? room / 100 : undefined}
                        value={val === 0 ? '' : val.toFixed(2)}
                        onChange={e => {
                          const minor = Math.max(0, Math.round((Number(e.target.value) || 0) * 100));
                          setLegPicks({ ...picks, [l.id]: room == null ? minor : Math.min(minor, room) });
                        }}
                        style={{ ...inputStyle, width: 100, textAlign: 'right' }} />
                    </div>
                  );
                })}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--bdr, #e5e7eb)' }}>
                  <span>Allocated to cards</span>
                  <span style={{ color: pickedMinor === toMinor(refundAmount) ? '#16a34a' : '#d97706' }}>
                    {fmt(pickedMinor / 100)} of {fmt(refundAmount)}
                  </span>
                </div>
              </div>
            )}

            {/* Refund amount + confirm */}
            <div style={{
              padding: '16px', borderRadius: 10, marginBottom: 16,
              background: refundAmount > 0 ? '#fef2f2' : 'var(--bg3, #f9fafb)',
              border: `1px solid ${refundAmount > 0 ? '#fca5a5' : 'var(--bdr, #e5e7eb)'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>Refund amount</span>
                <span style={{ fontSize: 22, fontWeight: 800, color: refundAmount > 0 ? '#dc2626' : 'var(--t4)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
                  {fmt(refundAmount)}
                </span>
              </div>
              {bd && (bd.tip > 0 || bd.service > 0) && (
                <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>
                  Items {fmt(bd.itemsAmount)}{bd.service > 0 ? ` · service ${fmt(bd.service)}` : ''}{bd.tip > 0 ? ` · tip ${fmt(bd.tip)}` : ''}
                </div>
              )}
              {legs.length === 0 && (
                <div style={{ fontSize: 12, color: '#dc2626', marginTop: 8, lineHeight: 1.5 }}>
                  No card payment is linked to this check — nothing can be reversed automatically. Return the money in the processor dashboard.
                </div>
              )}
            </div>

            {/* Confirm checkbox + buttons */}
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, cursor: 'pointer', fontSize: 14 }}
              onClick={() => setRefundConfirm(v => !v)}
            >
              <span style={{
                width: 22, height: 22, borderRadius: 6,
                border: `2px solid ${refundConfirm ? '#dc2626' : '#d1d5db'}`,
                background: refundConfirm ? '#dc2626' : '#fff',
                display: 'grid', placeItems: 'center', color: '#fff', fontSize: 13, fontWeight: 800, flexShrink: 0,
              }}>{refundConfirm ? '✓' : ''}</span>
              <span style={{ fontWeight: 600 }}>I confirm this refund of {fmt(refundAmount)}</span>
            </label>

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setRefundTarget(null)} disabled={refundBusy} style={{ ...btnOutline, flex: 1 }}>Cancel</button>
              <button
                onClick={executeRefund}
                disabled={refundBusy || !refundConfirm || refundAmount <= 0 || !refundReason.trim() || (refundMode === 'items' && Object.keys(refundSelections).length === 0)}
                style={{
                  ...btnPrimary, flex: 1, background: '#dc2626',
                  opacity: (refundBusy || !refundConfirm || refundAmount <= 0 || !refundReason.trim()) ? 0.4 : 1,
                  cursor: refundBusy ? 'wait' : (!refundConfirm || refundAmount <= 0 || !refundReason.trim()) ? 'not-allowed' : 'pointer',
                }}
              >{refundBusy ? 'Reversing on the card…' : 'Process refund'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// One editable money line for the refund modal (tip / service).
function MoneyField({ label, hint, value, max, disabled, onChange, onReset, overridden, inputStyle, fmt }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '5px 0' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--t4)' }}>
          {hint} · max {fmt(max)}
          {overridden && !disabled && (
            <button onClick={onReset} style={{ marginLeft: 6, background: 'none', border: 'none', padding: 0, color: 'var(--acc, #E8743C)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', textDecoration: 'underline' }}>reset</button>
          )}
        </div>
      </div>
      <input type="number" step="0.01" min="0" max={max} disabled={disabled}
        value={Number(value || 0).toFixed(2)}
        onChange={e => onChange(Math.min(max, Math.max(0, Number(e.target.value) || 0)))}
        style={{ ...inputStyle, width: 100, textAlign: 'right', opacity: disabled ? 0.55 : 1 }} />
    </div>
  );
}

// How a recorded refund's card reversal actually went. Only 'succeeded' may look
// like a finished job.
const CARD_STATUS_META = {
  succeeded: { label: 'Returned to card', color: '#16a34a', icon: '✓' },
  accepted:  { label: 'Accepted by processor, settling', color: '#d97706', icon: '⏳' },
  partial:   { label: 'SOME CARDS NOT REVERSED', color: '#dc2626', icon: '⚠' },
  failed:    { label: 'CARD REVERSAL FAILED — no money returned', color: '#dc2626', icon: '⚠' },
  pending:   { label: 'Reversal not confirmed', color: '#d97706', icon: '⏳' },
  none:      { label: 'No card reversal — handle manually', color: '#6b7280', icon: '·' },
};
