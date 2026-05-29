// v4.6.45: Close day — replaces the old End-of-day page.
//
// Three states:
//   A — drawers still open          → cash up each drawer first
//   B — all drawers idle, ready to close → per-drawer breakdown + close button
//   C — no open shift                → already closed / not started
//
// Per-drawer card shows: opening float, cash sales, pay-ins, drops, pay-outs,
// expected, declared, variance, denomination breakdown, who counted + when.
//
// Location totals: revenue by payment method, tax summary, totals across
// every drawer, net variance.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';
import { money } from '../../lib/currency';  // v5.5.326: multi-currency

const DENOMS_ORDER = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];
const DENOM_LABEL = {
  50: '£50', 20: '£20', 10: '£10', 5: '£5',
  2: '£2', 1: '£1',
  0.5: '50p', 0.2: '20p', 0.1: '10p', 0.05: '5p', 0.02: '2p', 0.01: '1p',
};

const fmt  = (n) => money(n);
const fmtS = (n) => (n >= 0 ? '+' : '−') + money(Math.abs(Number(n) || 0));
const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';
const fmtDur = (a, b) => {
  if (!a) return '—';
  const end = b ? new Date(b).getTime() : Date.now();
  const ms = end - new Date(a).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export default function EODClose() {
  const currentShift = useStore(s => s.currentShift);
  const cashDrawers  = useStore(s => s.cashDrawers) || [];
  const closedChecks = useStore(s => s.closedChecks) || [];
  const loadCashDrawers  = useStore(s => s.loadCashDrawers);
  const loadCurrentShift = useStore(s => s.loadCurrentShift);
  const finaliseShift    = useStore(s => s.finaliseShift);
  const showToast        = useStore(s => s.showToast);

  const [sessions, setSessions] = useState([]);
  const [movements, setMovements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expandedDrawer, setExpandedDrawer] = useState(null);

  // Hydrate on mount so the page is never stale
  useEffect(() => {
    (async () => {
      await loadCashDrawers?.();
      await loadCurrentShift?.();
    })();
  }, [loadCashDrawers, loadCurrentShift]);

  // Load sessions + movements scoped to the current shift
  useEffect(() => {
    (async () => {
      if (!currentShift?.id) { setLoading(false); return; }
      if (isMock || !supabase) { setLoading(false); return; }
      try {
        setLoading(true);
        const { data: ss } = await supabase.from('drawer_sessions').select('*').eq('shift_id', currentShift.id).order('cash_in_at', { ascending: true });
        setSessions(ss || []);
        const { data: mm } = await supabase.from('cash_movements').select('*').eq('shift_id', currentShift.id).order('timestamp', { ascending: true });
        setMovements(mm || []);
      } catch (err) {
        console.warn('[CloseDay] fetch failed:', err?.message || err);
      } finally {
        setLoading(false);
      }
    })();
  }, [currentShift?.id]);

  // Drawers that still need cashing up (blocking)
  const openDrawers = useMemo(() => cashDrawers.filter(d => d.status && d.status !== 'idle'), [cashDrawers]);

  // Checks attributed to this shift
  const shiftChecks = useMemo(() => {
    if (!currentShift?.id) return [];
    return closedChecks.filter(c => c.shiftId === currentShift.id && c.status !== 'voided');
  }, [closedChecks, currentShift?.id]);

  // Totals
  const totals = useMemo(() => {
    const t = { revenue: 0, cash: 0, card: 0, other: 0, tips: 0, refunds: 0, covers: 0, checks: 0, taxes: 0 };
    shiftChecks.forEach(c => {
      const total = Number(c.total) || 0;
      t.revenue += total;
      t.tips += Number(c.tip) || 0;
      t.taxes += Number(c.taxAmount) || 0;
      t.covers += Number(c.covers) || 0;
      t.checks++;
      if (c.method === 'cash') t.cash += total;
      else if (c.method === 'card' || c.method === 'stripe') t.card += total;
      else t.other += total;
      if (Array.isArray(c.refunds)) t.refunds += c.refunds.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    });
    return t;
  }, [shiftChecks]);

  // Per-drawer rollup
  const drawerRows = useMemo(() => {
    return cashDrawers.map(drawer => {
      const drawerSessions = sessions.filter(s => s.drawer_id === drawer.id);
      const openingFloat = drawerSessions.reduce((s, ses) => s + (Number(ses.opening_float) || 0), 0);
      const declaredCash = drawerSessions.reduce((s, ses) => s + (Number(ses.declared_cash) || 0), 0);
      const expectedCash = drawerSessions.reduce((s, ses) => s + (Number(ses.expected_cash) || 0), 0);
      const variance = drawerSessions.reduce((s, ses) => s + (Number(ses.variance) || 0), 0);

      // Movements for this drawer's sessions
      const dmov = movements.filter(m => drawerSessions.some(ses => ses.id === m.session_id));
      const cashSales = dmov.filter(m => m.type === 'cash_sale').reduce((s, m) => s + (Number(m.amount) || 0), 0);
      const drops     = dmov.filter(m => m.type === 'drop' || m.type === 'cash_drop').reduce((s, m) => s + (Number(m.amount) || 0), 0);
      const expenses  = dmov.filter(m => m.type === 'expense').reduce((s, m) => s + (Number(m.amount) || 0), 0);
      const payIns    = dmov.filter(m => m.type === 'float_in' && dmov.indexOf(m) !== dmov.findIndex(x => x.session_id === m.session_id && x.type === 'float_in')).reduce((s, m) => s + (Number(m.amount) || 0), 0);
      // Last session's close info for "counted by" display
      const lastClosed = drawerSessions.filter(s => s.status === 'closed').sort((a, b) => new Date(b.cash_out_at || 0) - new Date(a.cash_out_at || 0))[0];

      // Aggregate denominations across sessions if multiple
      const denomTotals = {};
      drawerSessions.forEach(s => {
        if (s.denominations && typeof s.denominations === 'object') {
          for (const [v, count] of Object.entries(s.denominations)) {
            const val = parseFloat(v);
            if (!Number.isNaN(val) && Number(count) > 0) {
              denomTotals[val] = (denomTotals[val] || 0) + Number(count);
            }
          }
        }
      });

      return {
        drawer,
        sessions: drawerSessions,
        sessionCount: drawerSessions.length,
        allClosed: drawerSessions.length > 0 && drawerSessions.every(s => s.status === 'closed'),
        currentStatus: drawer.status || 'idle',
        openingFloat, cashSales, drops, expenses, payIns,
        expectedCash, declaredCash, variance,
        denomTotals,
        closedAt: lastClosed?.cash_out_at || null,
        closedByStaffId: lastClosed?.cash_out_by_staff_id || null,
        notes: drawerSessions.map(s => s.notes).filter(Boolean).join(' · '),
      };
    });
  }, [cashDrawers, sessions, movements]);

  // Payment method breakdown
  const paymentMethods = useMemo(() => {
    const byM = {};
    shiftChecks.forEach(c => {
      const m = c.method || 'other';
      if (!byM[m]) byM[m] = { method: m, count: 0, revenue: 0, tips: 0 };
      byM[m].count++;
      byM[m].revenue += Number(c.total) || 0;
      byM[m].tips    += Number(c.tip)   || 0;
    });
    return Object.values(byM).sort((a, b) => b.revenue - a.revenue);
  }, [shiftChecks]);

  // Net variance across all drawers
  const netVariance = useMemo(() => drawerRows.reduce((s, r) => s + (r.allClosed ? r.variance : 0), 0), [drawerRows]);
  const totalExpected = useMemo(() => drawerRows.reduce((s, r) => s + r.expectedCash, 0), [drawerRows]);
  const totalDeclared = useMemo(() => drawerRows.reduce((s, r) => s + r.declaredCash, 0), [drawerRows]);

  // Can we close? Only when every drawer is idle and a shift is open
  const readyToClose = currentShift && openDrawers.length === 0 && cashDrawers.length > 0;

  const handleClose = async () => {
    if (!readyToClose || busy) return;
    if (!confirm(`Close the day? This finalises ${totals.checks} checks, ${fmt(totals.revenue)} revenue, and closes the shift. Any open orders will carry over.`)) return;
    setBusy(true);
    try {
      const report = {
        shiftId: currentShift.id,
        openedAt: currentShift.openedAt,
        closedAt: new Date().toISOString(),
        totals,
        drawers: drawerRows.map(r => ({
          drawerId: r.drawer.id, name: r.drawer.name,
          sessionCount: r.sessionCount,
          openingFloat: r.openingFloat,
          cashSales: r.cashSales, drops: r.drops, expenses: r.expenses,
          expectedCash: r.expectedCash, declaredCash: r.declaredCash, variance: r.variance,
          denomTotals: r.denomTotals, notes: r.notes,
        })),
        paymentMethods,
        totalExpected, totalDeclared, netVariance,
        generatedAt: new Date().toISOString(),
      };
      const res = await finaliseShift?.({ zReport: report });
      if (res) showToast?.('Day closed — shift finalised', 'success');
    } catch (err) {
      showToast?.('Close day failed: ' + (err?.message || err), 'error');
    } finally {
      setBusy(false);
    }
  };

  // ─── STATE C — no open shift ────────────────────────────────────
  if (!currentShift) {
    return (
      <Page>
        <Title title="Close day" sub="Finalise the current shift and archive the day's numbers." />
        <EmptyCard icon="✓" title="No open shift" body="There's nothing to close right now. A shift will open automatically when a POS terminal starts trading." />
      </Page>
    );
  }

  if (loading) {
    return (
      <Page>
        <Title title="Close day" />
        <div style={{ padding:'40px 20px', textAlign:'center', color:'var(--t4)' }}>Loading shift data…</div>
      </Page>
    );
  }

  // ─── STATE A — drawers still open ───────────────────────────────
  if (openDrawers.length > 0) {
    return (
      <Page>
        <Title title="Close day" sub="Cash up every drawer before the day can be closed." />

        <ShiftHeader shift={currentShift} totals={totals} cashDrawers={cashDrawers} />

        <Alert tone="warn" title={`${openDrawers.length} drawer${openDrawers.length === 1 ? '' : 's'} still open`}
               body="Every drawer must be cashed up before the day closes. Go to Cash drawers in the sidebar, or cash up from the assigned POS.">
        </Alert>

        <SectionTitle title="Drawers needing cash up" />
        <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:20 }}>
          {openDrawers.map(d => (
            <div key={d.id} style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:12, alignItems:'center', padding:'14px 16px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10 }}>
              <div>
                <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{d.name}</div>
                <div style={{ fontSize:12, color:'var(--t3)', marginTop:2, fontFamily:'var(--font-mono)' }}>Current float: {fmt(d.currentFloat)}</div>
              </div>
              <span style={{ fontSize:10, fontWeight:800, padding:'4px 10px', borderRadius:6, background:'var(--grn-d)', color:'var(--grn)', textTransform:'uppercase', letterSpacing:'.07em' }}>
                {d.status || 'open'}
              </span>
            </div>
          ))}
        </div>

        {cashDrawers.length > openDrawers.length && (
          <>
            <SectionTitle title="Already cashed up" />
            <DrawerSummaryList rows={drawerRows.filter(r => r.allClosed)} expandedDrawer={expandedDrawer} setExpandedDrawer={setExpandedDrawer} />
          </>
        )}
      </Page>
    );
  }

  // ─── STATE B — all drawers idle, ready to close ─────────────────
  return (
    <Page>
      <Title title="Close day" sub="Review each drawer's count plus the day's totals, then close." />

      <ShiftHeader shift={currentShift} totals={totals} cashDrawers={cashDrawers} />

      {/* Location totals */}
      <SectionTitle title="Day totals" />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:10, marginBottom:20 }}>
        <Card label="Revenue"  value={fmt(totals.revenue)} highlight="var(--acc)" />
        <Card label="Cash"     value={fmt(totals.cash)}    highlight="var(--grn)" />
        <Card label="Card"     value={fmt(totals.card)}    highlight="#3b82f6" />
        {totals.other > 0 && <Card label="Other" value={fmt(totals.other)} />}
        <Card label="Tax"      value={fmt(totals.taxes)} />
        <Card label="Tips"     value={fmt(totals.tips)} />
        <Card label="Checks"   value={String(totals.checks)} />
        <Card label="Covers"   value={String(totals.covers || 0)} />
      </div>

      {/* Per-drawer breakdown */}
      <SectionTitle title="Cash drawers" />
      <DrawerSummaryList rows={drawerRows} expandedDrawer={expandedDrawer} setExpandedDrawer={setExpandedDrawer} />

      {/* Cash summary across drawers */}
      <SectionTitle title="Cash summary" />
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, padding:'14px 16px', marginBottom:20 }}>
        <TotalRow label="Total expected in drawers" value={fmt(totalExpected)} />
        <TotalRow label="Total declared"            value={fmt(totalDeclared)} />
        <TotalRow label="Net variance" value={Math.abs(netVariance) < 0.01 ? '✓ Balanced' : fmtS(netVariance)}
                  color={Math.abs(netVariance) < 0.01 ? 'var(--grn)' : netVariance > 0 ? 'var(--acc)' : 'var(--red)'} strong />
      </div>

      {/* Payment methods */}
      {paymentMethods.length > 0 && (
        <>
          <SectionTitle title="Payment methods" />
          <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden', marginBottom:20 }}>
            {paymentMethods.map((pm, i) => (
              <div key={pm.method} style={{ display:'grid', gridTemplateColumns:'1fr 80px 120px 120px', gap:10, padding:'10px 14px', fontSize:13, borderBottom: i < paymentMethods.length - 1 ? '1px solid var(--bdr)' : 'none' }}>
                <div style={{ color:'var(--t1)', fontWeight:600, textTransform:'capitalize' }}>{pm.method}</div>
                <div style={{ textAlign:'right', color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{pm.count}</div>
                <div style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(pm.revenue)}</div>
                <div style={{ textAlign:'right', color:'var(--t4)', fontFamily:'var(--font-mono)' }}>tip {fmt(pm.tips)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Close button */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 16px', background:'var(--bg1)', border:'1.5px solid var(--bdr2)', borderRadius:12, marginTop:20 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>Ready to close</div>
          <div style={{ fontSize:11, color:'var(--t3)', marginTop:3 }}>
            Every drawer has been cashed up. Closing now will finalise {totals.checks} checks at {fmt(totals.revenue)}. Any open orders carry over to tomorrow.
          </div>
        </div>
        <button
          onClick={handleClose}
          disabled={busy}
          style={{
            padding:'12px 24px', borderRadius:10, border:'none',
            background: busy ? 'var(--bg3)' : 'var(--red, #cc5959)',
            color: busy ? 'var(--t4)' : '#fff',
            fontWeight:800, fontSize:14, fontFamily:'inherit',
            cursor: busy ? 'not-allowed' : 'pointer',
            whiteSpace:'nowrap',
          }}>
          {busy ? 'Closing…' : 'Close day'}
        </button>
      </div>
    </Page>
  );
}

// ─── Drawer card list (used in state A + B) ──────────────────────
function DrawerSummaryList({ rows, expandedDrawer, setExpandedDrawer }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:20 }}>
      {rows.map(r => {
        const open = expandedDrawer === r.drawer.id;
        return (
          <div key={r.drawer.id} style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
            <div style={{ display:'grid', gridTemplateColumns:'1.3fr 0.9fr 0.9fr 0.9fr 1.2fr auto', gap:12, padding:'12px 16px', alignItems:'center', cursor:'pointer' }}
                 onClick={() => setExpandedDrawer(open ? null : r.drawer.id)}>
              <div>
                <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{r.drawer.name}</div>
                <div style={{ fontSize:10, color:'var(--t4)', marginTop:2 }}>
                  {r.sessionCount} session{r.sessionCount === 1 ? '' : 's'}{' · '}
                  {r.allClosed ? `closed ${fmtTime(r.closedAt)}` : `status: ${r.currentStatus}`}
                </div>
              </div>
              <MiniStat label="Opening" value={fmt(r.openingFloat)} />
              <MiniStat label="Cash sales" value={fmt(r.cashSales)} color="var(--grn)" />
              <MiniStat label="Expected" value={fmt(r.expectedCash)} />
              <MiniStat label="Counted" value={r.allClosed ? fmt(r.declaredCash) : '—'} color="var(--t1)" strong />
              {r.allClosed ? (
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontSize:13, fontWeight:800, fontFamily:'var(--font-mono)',
                                color: Math.abs(r.variance) < 0.01 ? 'var(--grn)' : r.variance > 0 ? 'var(--acc)' : 'var(--red)' }}>
                    {Math.abs(r.variance) < 0.01 ? '✓ 0.00' : fmtS(r.variance)}
                  </div>
                  <div style={{ fontSize:10, color:'var(--t4)' }}>variance</div>
                </div>
              ) : (
                <div style={{ fontSize:11, color:'var(--amb,#e8a020)', textAlign:'right', fontWeight:700 }}>needs cash up</div>
              )}
            </div>

            {open && r.allClosed && (
              <div style={{ borderTop:'1px solid var(--bdr)', padding:'14px 16px', background:'var(--bg2)' }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
                  {/* Left: movement totals */}
                  <div>
                    <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Cash flow</div>
                    <Row label="Opening float"  value={fmt(r.openingFloat)} />
                    <Row label="Cash sales"     value={fmt(r.cashSales)} color="var(--grn)" />
                    {r.drops > 0    && <Row label="Cash drops"    value={`− ${fmt(r.drops)}`} color="var(--amb,#e8a020)" />}
                    {r.expenses > 0 && <Row label="Expenses paid" value={`− ${fmt(r.expenses)}`} color="var(--red)" />}
                    <div style={{ borderTop:'1px dashed var(--bdr)', paddingTop:7, marginTop:7 }}>
                      <Row label="Expected"  value={fmt(r.expectedCash)} strong />
                      <Row label="Declared"  value={fmt(r.declaredCash)} strong />
                      <Row label="Variance"
                           value={Math.abs(r.variance) < 0.01 ? '✓ Balanced' : fmtS(r.variance)}
                           color={Math.abs(r.variance) < 0.01 ? 'var(--grn)' : r.variance > 0 ? 'var(--acc)' : 'var(--red)'}
                           strong />
                    </div>
                  </div>

                  {/* Right: denomination breakdown */}
                  <div>
                    <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Denomination count</div>
                    {Object.keys(r.denomTotals).length === 0 ? (
                      <div style={{ fontSize:12, color:'var(--t4)', fontStyle:'italic' }}>No denomination breakdown recorded (quick count).</div>
                    ) : (
                      DENOMS_ORDER.filter(v => r.denomTotals[v] > 0).map(v => {
                        const qty = r.denomTotals[v];
                        const sub = qty * v;
                        return (
                          <div key={v} style={{ display:'grid', gridTemplateColumns:'50px 60px 1fr', gap:10, fontSize:12, padding:'3px 0', alignItems:'baseline' }}>
                            <span style={{ color:'var(--t3)' }}>{DENOM_LABEL[v]}</span>
                            <span style={{ color:'var(--t1)', fontFamily:'var(--font-mono)', fontWeight:700, textAlign:'right' }}>× {qty}</span>
                            <span style={{ color:'var(--t2)', fontFamily:'var(--font-mono)', textAlign:'right' }}>{fmt(sub)}</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {r.notes && (
                  <div style={{ marginTop:14, padding:'8px 10px', background:'var(--bg3)', borderRadius:6, fontSize:12, color:'var(--t3)' }}>
                    <span style={{ color:'var(--t4)', fontWeight:700 }}>Notes: </span>{r.notes}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────

function Page({ children }) {
  return <div style={{ padding:'22px 28px', maxWidth:1100 }}>{children}</div>;
}

function Title({ title, sub }) {
  return (
    <div style={{ marginBottom:16 }}>
      <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)' }}>{title}</div>
      {sub && <div style={{ fontSize:13, color:'var(--t3)', marginTop:4 }}>{sub}</div>}
    </div>
  );
}

function SectionTitle({ title }) {
  return <div style={{ fontSize:11, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:10, marginTop:6 }}>{title}</div>;
}

function ShiftHeader({ shift, totals, cashDrawers }) {
  const openCount  = cashDrawers.filter(d => d.status && d.status !== 'idle').length;
  const totalCount = cashDrawers.length;
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(170px, 1fr))', gap:10, marginBottom:20 }}>
      <Card label="Shift opened"   value={fmtTime(shift.openedAt)} />
      <Card label="Running for"    value={fmtDur(shift.openedAt)} />
      <Card label="Closed checks"  value={String(totals.checks)} />
      <Card label="Drawers"        value={`${totalCount - openCount}/${totalCount} idle`}
            highlight={openCount === 0 ? 'var(--grn)' : 'var(--amb,#e8a020)'} />
    </div>
  );
}

function Card({ label, value, highlight }) {
  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, padding:'10px 14px' }}>
      <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</div>
      <div style={{ fontSize:18, fontWeight:800, color: highlight || 'var(--t1)', marginTop:4, fontFamily:'var(--font-mono)' }}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, color = 'var(--t2)', strong = false }) {
  return (
    <div>
      <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</div>
      <div style={{ fontSize:13, fontWeight: strong ? 800 : 700, color, fontFamily:'var(--font-mono)', marginTop:2 }}>{value}</div>
    </div>
  );
}

function Row({ label, value, color = 'var(--t2)', strong = false }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13 }}>
      <span style={{ color:'var(--t3)' }}>{label}</span>
      <span style={{ color, fontFamily:'var(--font-mono)', fontWeight: strong ? 800 : 600 }}>{value}</span>
    </div>
  );
}

function TotalRow({ label, value, color = 'var(--t1)', strong = false }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', fontSize:14, borderBottom:'1px solid var(--bdr)' }}>
      <span style={{ color:'var(--t2)', fontWeight: strong ? 700 : 500 }}>{label}</span>
      <span style={{ color, fontFamily:'var(--font-mono)', fontWeight: strong ? 900 : 700, fontSize: strong ? 16 : 14 }}>{value}</span>
    </div>
  );
}

function EmptyCard({ icon, title, body }) {
  return (
    <div style={{ background:'var(--bg1)', border:'1px dashed var(--bdr2)', borderRadius:14, padding:'28px 20px', textAlign:'center' }}>
      <div style={{ fontSize:36, marginBottom:8, opacity:.35 }}>{icon}</div>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--t2)' }}>{title}</div>
      <div style={{ fontSize:12, color:'var(--t4)', marginTop:4 }}>{body}</div>
    </div>
  );
}

function Alert({ tone = 'info', title, body, children }) {
  const palette = {
    info:   { bg:'var(--acc-d)', border:'var(--acc)', text:'var(--acc)' },
    warn:   { bg:'rgba(232,160,32,.1)', border:'var(--amb,#e8a020)', text:'var(--amb,#e8a020)' },
    danger: { bg:'rgba(235, 97, 97, 0.08)', border:'var(--red-b, #cc5959)', text:'var(--red, #cc5959)' },
  }[tone];
  return (
    <div style={{ background: palette.bg, border: `1.5px solid ${palette.border}`, borderRadius:14, padding:'16px 18px', marginBottom:20 }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
        <span style={{ fontSize:20 }}>{tone === 'warn' ? '⚠' : tone === 'danger' ? '⛔' : 'ⓘ'}</span>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:800, color: palette.text }}>{title}</div>
          {body && <div style={{ fontSize:12, color:'var(--t3)', marginTop:4, lineHeight:1.5 }}>{body}</div>}
          {children}
        </div>
      </div>
    </div>
  );
}
