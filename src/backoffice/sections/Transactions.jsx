// Transactions — Report sub-view inside BOReports (Order reports category).
// Shows all closed checks with search, expandable item details, and refund capability.
//
// v5.5.274: Initial build
// v5.5.275: Moved from standalone sidebar section into Reports catalog.
//           Now receives `checks` + `fmt` from parent BOReports (which handles
//           period selection and server/orderType/source filters). This component
//           adds its own text search, status/method filters, and refund modal.

import { useState, useMemo, Fragment } from 'react';
import { useStore } from '../../store';

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
const SOURCE_LABELS = { pos: 'POS', kiosk: 'Kiosk', online: 'Online', qr: 'QR' };

// ═════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════
export default function Transactions({ checks: parentChecks = [], fmt: parentFmt }) {
  const { refundCheck, staff } = useStore();
  const fmt = parentFmt || (n => `£${(n || 0).toFixed(2)}`);

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

  const refundAmount = useMemo(() => {
    if (!refundTarget) return 0;
    if (refundMode === 'full') {
      const alreadyRefunded = (refundTarget.refunds || []).reduce((s, r) => s + (r.amount || 0), 0);
      return Math.max(0, (refundTarget.subtotal || 0) - alreadyRefunded);
    }
    const items = refundTarget.items || [];
    return Object.entries(refundSelections).reduce((s, [uid, qty]) => {
      const item = items.find(i => i.uid === uid || i.id === uid);
      return s + (item ? (item.price || 0) * qty : 0);
    }, 0);
  }, [refundTarget, refundMode, refundSelections]);

  const executeRefund = () => {
    if (!refundTarget || !refundReason.trim()) return;
    const items = refundTarget.items || [];
    let refundItems;
    if (refundMode === 'full') {
      refundItems = items.map(i => ({ ...i, refundQty: i.qty || 1 }));
    } else {
      refundItems = Object.entries(refundSelections)
        .filter(([, qty]) => qty > 0)
        .map(([uid, qty]) => {
          const item = items.find(i => i.uid === uid || i.id === uid);
          return item ? { ...item, refundQty: qty } : null;
        })
        .filter(Boolean);
    }
    if (refundItems.length === 0) return;

    refundCheck(refundTarget.id, {
      items: refundItems,
      isFullRefund: refundMode === 'full',
      manager: { name: staff?.name || 'Back Office', id: staff?.id || 'bo' },
      reason: refundReason.trim(),
      amount: refundAmount,
    });

    setRefundTarget(null);
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
                      }}>{SOURCE_LABELS[c.source || 'pos'] || 'POS'}</span>
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
                                  </div>
                                ))}
                              </div>
                            )}

                            {/* Additional info */}
                            <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--t2)', lineHeight: 1.8 }}>
                              {c.tableLabel && <div><strong>Table:</strong> {c.tableLabel}</div>}
                              {c.orderType && <div><strong>Order type:</strong> {c.orderType}</div>}
                              {c.covers > 0 && <div><strong>Covers:</strong> {c.covers}</div>}
                              {c.staffId && <div><strong>Staff ID:</strong> {c.staffId}</div>}
                              <div><strong>Check ID:</strong> <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11 }}>{c.id}</span></div>
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
              <button onClick={() => setRefundTarget(null)} style={{ ...btnOutline, flex: 1 }}>Cancel</button>
              <button
                onClick={executeRefund}
                disabled={!refundConfirm || refundAmount <= 0 || !refundReason.trim() || (refundMode === 'items' && Object.keys(refundSelections).length === 0)}
                style={{
                  ...btnPrimary, flex: 1, background: '#dc2626',
                  opacity: (!refundConfirm || refundAmount <= 0 || !refundReason.trim()) ? 0.4 : 1,
                  cursor: (!refundConfirm || refundAmount <= 0 || !refundReason.trim()) ? 'not-allowed' : 'pointer',
                }}
              >Process refund</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
