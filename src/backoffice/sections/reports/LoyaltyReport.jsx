// v5.5.257: Advanced loyalty reports — member stats, stamp card tracking,
// points distribution, rewards redeemed, and enrollment trends.
//
// Unlike other reports that use closed_checks, this pulls from platform DB
// (customer_loyalty, customer_stamp_cards, stamp_card_programs, loyalty_tiers)
// and ops DB (loyalty_transactions, stamp_transactions).

import { useState, useEffect, useMemo } from 'react';
import { supabase, platformSupabase, getLocationId, getActiveLocationSync } from '../../../lib/supabase';

const S = {
  tile: { padding: '14px 16px', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12 },
  lbl: { fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 },
  val: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--font-mono)', letterSpacing: '-.02em' },
  sub: { fontSize: 11, color: 'var(--t4)', marginTop: 2 },
  card: { padding: 16, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, marginBottom: 14 },
  hdr: { fontSize: 14, fontWeight: 800, color: 'var(--t1)', marginBottom: 10, letterSpacing: '-.01em' },
};

const fmt = n => `£${(n || 0).toFixed(2)}`;

export default function LoyaltyReport({ rangeFrom, rangeTo, initialTab }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(initialTab || 'overview'); // overview | members | stamps | transactions

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const locId = getActiveLocationSync() || await getLocationId();
        if (!locId || !platformSupabase || !supabase) { setLoading(false); return; }

        // Resolve company
        const { data: loc } = await platformSupabase.from('locations')
          .select('company_id')
          .or(`ops_location_id.eq.${locId},id.eq.${locId}`)
          .limit(1).maybeSingle();
        if (!loc?.company_id) { setLoading(false); return; }
        const companyId = loc.company_id;

        // Fetch all data in parallel
        const [membersRes, tiersRes, stampProgsRes, stampCardsRes, txRes, stampTxRes] = await Promise.all([
          platformSupabase.from('customer_loyalty')
            .select('customer_id, points_balance, points_earned_total, points_redeemed_total, visit_count, lifetime_spend_minor, tier_id, enrolled_at, last_earn_at')
            .eq('company_id', companyId),
          platformSupabase.from('loyalty_tiers')
            .select('id, name, color, icon')
            .eq('company_id', companyId),
          platformSupabase.from('stamp_card_programs')
            .select('id, name, icon, stamps_required, reward_description, active')
            .eq('company_id', companyId),
          platformSupabase.from('customer_stamp_cards')
            .select('id, customer_id, program_id, stamps_collected, completed_count, last_stamp_at')
            .eq('company_id', companyId),
          // Loyalty transactions in date range
          supabase.from('loyalty_transactions')
            .select('id, customer_id, type, points, created_at, source')
            .eq('company_id', companyId)
            .gte('created_at', new Date(rangeFrom).toISOString())
            .lte('created_at', new Date(rangeTo).toISOString())
            .order('created_at', { ascending: false })
            .limit(500),
          // Stamp transactions in date range
          supabase.from('stamp_transactions')
            .select('id, customer_id, program_id, stamps, order_ref, trigger_item_name, created_at')
            .gte('created_at', new Date(rangeFrom).toISOString())
            .lte('created_at', new Date(rangeTo).toISOString())
            .order('created_at', { ascending: false })
            .limit(500),
        ]);

        // Fetch customer names for display
        const members = membersRes.data || [];
        const allCustIds = [...new Set(members.map(m => m.customer_id))];
        let custNames = {};
        if (allCustIds.length && supabase) {
          const { data: custs } = await supabase.from('customers')
            .select('id, name, phone, phone_raw, email')
            .in('id', allCustIds.slice(0, 500))
            .is('deleted_at', null);
          (custs || []).forEach(c => { custNames[c.id] = c; });
        }

        setData({
          members,
          tiers: tiersRes.data || [],
          stampPrograms: stampProgsRes.data || [],
          stampCards: stampCardsRes.data || [],
          transactions: txRes.data || [],
          stampTransactions: stampTxRes.data || [],
          custNames,
          companyId,
        });
      } catch (e) {
        console.error('[LoyaltyReport] load:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [rangeFrom, rangeTo]);

  if (loading) return <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--t4)', fontSize: 13 }}>Loading loyalty data…</div>;
  if (!data) return <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--t4)', fontSize: 13 }}>No loyalty data found.</div>;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'members', label: 'Top Members' },
    { id: 'stamps', label: 'Stamp Cards' },
    { id: 'transactions', label: 'Transactions' },
  ];

  return (
    <div>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 18, borderBottom: '2px solid var(--bdr)' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: 'none', background: tab === t.id ? 'var(--acc)' : 'transparent',
            color: tab === t.id ? '#0b0c10' : 'var(--t3)',
            borderRadius: '8px 8px 0 0', fontFamily: 'inherit',
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab data={data} />}
      {tab === 'members' && <MembersTab data={data} />}
      {tab === 'stamps' && <StampsTab data={data} />}
      {tab === 'transactions' && <TransactionsTab data={data} />}
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────
function OverviewTab({ data }) {
  const { members, tiers, stampPrograms, stampCards, transactions } = data;

  const totalMembers = members.length;
  const totalPoints = members.reduce((s, m) => s + (m.points_balance || 0), 0);
  const totalEarned = members.reduce((s, m) => s + (m.points_earned_total || 0), 0);
  const totalRedeemed = members.reduce((s, m) => s + (m.points_redeemed_total || 0), 0);
  const totalVisits = members.reduce((s, m) => s + (m.visit_count || 0), 0);
  const totalSpend = members.reduce((s, m) => s + (m.lifetime_spend_minor || 0), 0) / 100;
  const avgSpend = totalMembers > 0 ? totalSpend / totalMembers : 0;
  const avgVisits = totalMembers > 0 ? totalVisits / totalMembers : 0;

  // Period activity
  const periodEarns = transactions.filter(t => t.type === 'earn');
  const periodRedeems = transactions.filter(t => t.type === 'redeem');
  const periodPointsEarned = periodEarns.reduce((s, t) => s + (t.points || 0), 0);
  const periodPointsRedeemed = periodRedeems.reduce((s, t) => s + Math.abs(t.points || 0), 0);

  // Tier distribution
  const tierDist = {};
  tiers.forEach(t => { tierDist[t.id] = { ...t, count: 0 }; });
  tierDist['none'] = { name: 'No tier', color: 'var(--t4)', count: 0 };
  members.forEach(m => {
    if (m.tier_id && tierDist[m.tier_id]) tierDist[m.tier_id].count++;
    else tierDist['none'].count++;
  });

  // Enrollment over time (last 30 days)
  const enrollByDay = {};
  members.forEach(m => {
    if (!m.enrolled_at) return;
    const d = new Date(m.enrolled_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    enrollByDay[d] = (enrollByDay[d] || 0) + 1;
  });

  // Stamp card completions
  const totalCompletions = stampCards.reduce((s, c) => s + (c.completed_count || 0), 0);

  return (
    <div>
      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
        <KPI label="Total members" value={totalMembers.toLocaleString()} />
        <KPI label="Points in circulation" value={totalPoints.toLocaleString()} />
        <KPI label="Avg visits / member" value={avgVisits.toFixed(1)} />
        <KPI label="Avg spend / member" value={fmt(avgSpend)} />
      </div>

      {/* Period activity */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 18 }}>
        <KPI label="Points earned (period)" value={periodPointsEarned.toLocaleString()} sub={`${periodEarns.length} transactions`} />
        <KPI label="Points redeemed (period)" value={periodPointsRedeemed.toLocaleString()} sub={`${periodRedeems.length} redemptions`} />
        <KPI label="All-time earned" value={totalEarned.toLocaleString()} />
        <KPI label="All-time redeemed" value={totalRedeemed.toLocaleString()} />
      </div>

      {/* Tier distribution + stamp completions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
        <div style={S.card}>
          <div style={S.hdr}>Tier distribution</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.values(tierDist).filter(t => t.count > 0).sort((a, b) => b.count - a.count).map(t => {
              const pct = totalMembers > 0 ? (t.count / totalMembers * 100) : 0;
              return (
                <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 80, fontSize: 12, fontWeight: 700, color: t.color || 'var(--t2)' }}>{t.icon || ''} {t.name}</div>
                  <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--bg3)', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', borderRadius: 4, background: t.color || 'var(--acc)' }} />
                  </div>
                  <div style={{ width: 50, textAlign: 'right', fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--t1)' }}>{t.count}</div>
                  <div style={{ width: 40, textAlign: 'right', fontSize: 11, color: 'var(--t4)' }}>{pct.toFixed(0)}%</div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={S.card}>
          <div style={S.hdr}>Stamp card programs</div>
          {stampPrograms.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--t4)' }}>No stamp card programs.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stampPrograms.map(prog => {
                const cards = stampCards.filter(c => c.program_id === prog.id);
                const totalStamps = cards.reduce((s, c) => s + (c.stamps_collected || 0), 0);
                const completions = cards.reduce((s, c) => s + (c.completed_count || 0), 0);
                return (
                  <div key={prog.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg2)', borderRadius: 8 }}>
                    <span style={{ fontSize: 18 }}>{prog.icon || '☕'}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t1)' }}>{prog.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--t4)' }}>{cards.length} members · {totalStamps} stamps · {completions} completions</div>
                    </div>
                    {!prog.active && <span style={{ fontSize: 10, color: 'var(--t4)', fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'var(--bg3)' }}>Paused</span>}
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ marginTop: 10, fontSize: 13, fontWeight: 800, color: 'var(--acc)' }}>
            {totalCompletions} total card{totalCompletions !== 1 ? 's' : ''} completed
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Top Members tab ──────────────────────────────────────────────────
function MembersTab({ data }) {
  const { members, custNames, tiers } = data;
  const [sortBy, setSortBy] = useState('spend'); // spend | points | visits
  const tierMap = {};
  tiers.forEach(t => { tierMap[t.id] = t; });

  const sorted = useMemo(() => {
    return [...members].sort((a, b) => {
      if (sortBy === 'spend') return (b.lifetime_spend_minor || 0) - (a.lifetime_spend_minor || 0);
      if (sortBy === 'points') return (b.points_balance || 0) - (a.points_balance || 0);
      return (b.visit_count || 0) - (a.visit_count || 0);
    }).slice(0, 50);
  }, [members, sortBy]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {[{ id: 'spend', label: 'By spend' }, { id: 'points', label: 'By points' }, { id: 'visits', label: 'By visits' }].map(s => (
          <button key={s.id} onClick={() => setSortBy(s.id)} style={{
            padding: '5px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer',
            border: `1px solid ${sortBy === s.id ? 'var(--acc)' : 'var(--bdr)'}`,
            background: sortBy === s.id ? 'var(--acc-d)' : 'var(--bg2)',
            color: sortBy === s.id ? 'var(--acc)' : 'var(--t3)', fontFamily: 'inherit',
          }}>{s.label}</button>
        ))}
      </div>

      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '30px 2fr 1fr 1fr 1fr 1fr',
          gap: 6, padding: '10px 14px', fontSize: 10, fontWeight: 800, color: 'var(--t4)',
          textTransform: 'uppercase', letterSpacing: '.07em', background: 'var(--bg2)', borderBottom: '1px solid var(--bdr)',
        }}>
          <span>#</span><span>Member</span><span style={{ textAlign: 'right' }}>Spend</span>
          <span style={{ textAlign: 'right' }}>Points</span><span style={{ textAlign: 'right' }}>Visits</span>
          <span style={{ textAlign: 'right' }}>Tier</span>
        </div>
        {sorted.map((m, i) => {
          const c = custNames[m.customer_id] || {};
          const tier = m.tier_id ? tierMap[m.tier_id] : null;
          return (
            <div key={m.customer_id} style={{
              display: 'grid', gridTemplateColumns: '30px 2fr 1fr 1fr 1fr 1fr',
              gap: 6, padding: '8px 14px', fontSize: 12, alignItems: 'center',
              borderBottom: '1px solid var(--bdr)',
              background: i < 3 ? 'rgba(232,116,60,0.04)' : 'transparent',
            }}>
              <span style={{ fontWeight: 800, color: i < 3 ? 'var(--acc)' : 'var(--t4)', fontSize: 11 }}>{i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || 'Unnamed'}</div>
                <div style={{ fontSize: 10, color: 'var(--t4)' }}>{c.phone_raw || c.phone || c.email || ''}</div>
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--acc)' }}>{fmt((m.lifetime_spend_minor || 0) / 100)}</div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--t1)' }}>{(m.points_balance || 0).toLocaleString()}</div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--t2)' }}>{m.visit_count || 0}</div>
              <div style={{ textAlign: 'right' }}>
                {tier ? (
                  <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: `${tier.color || 'var(--acc)'}20`, color: tier.color || 'var(--acc)' }}>
                    {tier.icon || ''} {tier.name}
                  </span>
                ) : <span style={{ fontSize: 10, color: 'var(--t4)' }}>—</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Stamp Cards tab ──────────────────────────────────────────────────
function StampsTab({ data }) {
  const { stampPrograms, stampCards, stampTransactions, custNames } = data;

  if (stampPrograms.length === 0) {
    return <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--t4)', fontSize: 13 }}>No stamp card programs configured.</div>;
  }

  return (
    <div>
      {stampPrograms.map(prog => {
        const cards = stampCards.filter(c => c.program_id === prog.id);
        const txs = stampTransactions.filter(t => t.program_id === prog.id);
        const totalStamps = cards.reduce((s, c) => s + (c.stamps_collected || 0), 0);
        const completions = cards.reduce((s, c) => s + (c.completed_count || 0), 0);
        const periodStamps = txs.reduce((s, t) => s + (t.stamps || 0), 0);

        // Top stampers
        const topCards = [...cards].sort((a, b) => (b.stamps_collected + b.completed_count * prog.stamps_required) - (a.stamps_collected + a.completed_count * prog.stamps_required)).slice(0, 10);

        return (
          <div key={prog.id} style={S.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 28 }}>{prog.icon || '☕'}</span>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)' }}>{prog.name}</div>
                <div style={{ fontSize: 12, color: 'var(--t4)' }}>{prog.stamps_required} stamps to complete · {prog.reward_description || 'Free item'}</div>
              </div>
              {!prog.active && <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, background: 'var(--bg3)', color: 'var(--t4)' }}>Paused</span>}
            </div>

            {/* Stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
              <KPI label="Active cards" value={cards.length} small />
              <KPI label="Total stamps" value={totalStamps} small />
              <KPI label="Completions" value={completions} small />
              <KPI label="Stamps (period)" value={periodStamps} small />
            </div>

            {/* Top stampers */}
            {topCards.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Top members</div>
                <div style={{ background: 'var(--bg2)', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--bdr)' }}>
                  {topCards.map(card => {
                    const c = custNames[card.customer_id] || {};
                    const pct = Math.round((card.stamps_collected / prog.stamps_required) * 100);
                    return (
                      <div key={card.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', borderBottom: '1px solid var(--bdr)', fontSize: 12 }}>
                        <div style={{ flex: 1, fontWeight: 600, color: 'var(--t1)' }}>{c.name || 'Unnamed'}</div>
                        <div style={{ width: 80, height: 6, borderRadius: 3, background: 'var(--bg3)', overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: 'var(--acc)' }} />
                        </div>
                        <div style={{ width: 60, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--t2)' }}>
                          {card.stamps_collected}/{prog.stamps_required}
                        </div>
                        {card.completed_count > 0 && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--grn,#4caf50)' }}>{card.completed_count}×</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Transactions tab ─────────────────────────────────────────────────
function TransactionsTab({ data }) {
  const { transactions, stampTransactions, custNames } = data;
  const [filter, setFilter] = useState('all'); // all | earn | redeem | stamps

  const filtered = useMemo(() => {
    if (filter === 'stamps') {
      return stampTransactions.map(t => ({
        ...t, _type: 'stamp',
        display: `+${t.stamps} stamp${t.stamps > 1 ? 's' : ''}`,
        items: t.trigger_item_name,
      }));
    }
    let txs = transactions;
    if (filter === 'earn') txs = txs.filter(t => t.type === 'earn');
    if (filter === 'redeem') txs = txs.filter(t => t.type === 'redeem');
    return txs.map(t => ({
      ...t, _type: 'points',
      display: `${t.points > 0 ? '+' : ''}${t.points} pts`,
    }));
  }, [transactions, stampTransactions, filter]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[{ id: 'all', label: 'All points' }, { id: 'earn', label: 'Earned' }, { id: 'redeem', label: 'Redeemed' }, { id: 'stamps', label: 'Stamp activity' }].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            padding: '5px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer',
            border: `1px solid ${filter === f.id ? 'var(--acc)' : 'var(--bdr)'}`,
            background: filter === f.id ? 'var(--acc-d)' : 'var(--bg2)',
            color: filter === f.id ? 'var(--acc)' : 'var(--t3)', fontFamily: 'inherit',
          }}>{f.label}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--t4)', fontSize: 13 }}>No transactions in this period.</div>
      ) : (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, overflow: 'hidden', maxHeight: 500, overflowY: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '140px 1.5fr 1fr auto',
            gap: 6, padding: '10px 14px', fontSize: 10, fontWeight: 800, color: 'var(--t4)',
            textTransform: 'uppercase', letterSpacing: '.07em', background: 'var(--bg2)', borderBottom: '1px solid var(--bdr)',
            position: 'sticky', top: 0,
          }}>
            <span>Time</span><span>Member</span><span>Detail</span><span style={{ textAlign: 'right' }}>Amount</span>
          </div>
          {filtered.map((t, i) => {
            const c = custNames[t.customer_id] || {};
            return (
              <div key={t.id || i} style={{
                display: 'grid', gridTemplateColumns: '140px 1.5fr 1fr auto',
                gap: 6, padding: '8px 14px', fontSize: 12, borderBottom: '1px solid var(--bdr)', alignItems: 'center',
              }}>
                <span style={{ color: 'var(--t3)', fontSize: 11 }}>{new Date(t.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <span style={{ color: 'var(--t1)', fontWeight: 600 }}>{c.name || 'Unnamed'}</span>
                <span style={{ color: 'var(--t4)', fontSize: 11 }}>{t.source || t.items || t.type || ''}</span>
                <span style={{
                  textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700,
                  color: t._type === 'stamp' ? 'var(--acc)' : (t.points > 0 ? 'var(--grn,#4caf50)' : 'var(--red,#cc5959)'),
                }}>{t.display}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Shared KPI tile ──────────────────────────────────────────────────
function KPI({ label, value, sub, small }) {
  return (
    <div style={S.tile}>
      <div style={S.lbl}>{label}</div>
      <div style={{ ...S.val, fontSize: small ? 18 : 22 }}>{value}</div>
      {sub && <div style={S.sub}>{sub}</div>}
    </div>
  );
}
