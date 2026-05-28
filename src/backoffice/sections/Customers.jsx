// v5.5.223: Back-office Customers section.
//
// Tier-1 features:
//   - List of every customer at this org (across locations)
//   - Search by name, phone, email
//   - Filters: location, last visit window, marketing opt-in
//   - Sortable columns
//   - Click row → detail panel: profile + per-location stats grid + order history + gift cards
//   - CSV export of current filter

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { supabase, platformSupabase, isMock, getLocationId, getActiveLocationSync } from '../../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

async function callGift(endpoint, body) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${FUNCTIONS_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

const fmtMoney = (n) => '£' + (Number(n) || 0).toFixed(2);

const fmtRel = (iso) => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 7)   return days + 'd ago';
  if (days < 30)  return Math.floor(days / 7) + 'w ago';
  if (days < 365) return Math.floor(days / 30) + 'mo ago';
  return Math.floor(days / 365) + 'y ago';
};

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—';

const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [allLocations, setAllLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterLoc, setFilterLoc] = useState('all');
  const [filterRange, setFilterRange] = useState('all');     // all | 7d | 30d | 90d | dormant (90d+)
  const [filterMarketing, setFilterMarketing] = useState('all'); // all | optIn | optOut
  const [filterLoyalty, setFilterLoyalty] = useState('all');     // all | member | notMember
  const [sortBy, setSortBy] = useState('lastVisit');         // lastVisit | spend | visits | name
  const [sortDir, setSortDir] = useState('desc');
  const [selectedId, setSelectedId] = useState(null);
  const [view, setView] = useState('list');           // v4.6.64: 'list' | 'insights'
  const [insightsTab, setInsightsTab] = useState('vips'); // vips | multi | crossSell | dormant
  const [loyaltyMap, setLoyaltyMap] = useState({});    // v5.5.223: customer_id → loyalty record
  const [tierMap, setTierMap] = useState({});           // v5.5.223: tier_id → tier record
  const [stampDataMap, setStampDataMap] = useState({}); // v5.5.257: customer_id → { programs, cards }
  const [stampPrograms, setStampPrograms] = useState([]); // v5.5.257: all active stamp programs

  // Load all customers + their per-location stats (for the org)
  useEffect(() => {
    (async () => {
      if (isMock || !supabase) { setLoading(false); return; }
      try {
        setLoading(true);
        const locId = await getLocationId();
        if (!locId) return;
        // Fetch org_id once
        const { data: thisLoc } = await supabase.from('locations').select('org_id').eq('id', locId).single();
        const orgId = thisLoc?.org_id;
        if (!orgId) return;

        // All locations under the org (so we can show location names + populate filter dropdown)
        const { data: locs } = await supabase
          .from('locations').select('id, name')
          .eq('org_id', orgId).eq('status', 'active').order('name');
        setAllLocations(locs || []);
        const locMap = Object.fromEntries((locs || []).map(l => [l.id, l.name]));

        // All customers in the org
        const { data: customerRows } = await supabase
          .from('customers')
          .select('id, name, phone, phone_raw, email, marketing_opt_in, marketing_opt_in_at, notes, allergens, created_at, updated_at')
          .eq('org_id', orgId).is('deleted_at', null)
          .order('updated_at', { ascending: false })
          .limit(1000);

        // All customer_locations rows for those customers
        const ids = (customerRows || []).map(c => c.id);
        let clRows = [];
        if (ids.length) {
          const { data } = await supabase
            .from('customer_locations')
            .select('*')
            .in('customer_id', ids);
          clRows = data || [];
        }
        // Group customer_locations by customer_id
        const byCust = {};
        clRows.forEach(cl => {
          if (!byCust[cl.customer_id]) byCust[cl.customer_id] = [];
          byCust[cl.customer_id].push({ ...cl, locationName: locMap[cl.location_id] || '—' });
        });

        // Roll up
        const enriched = (customerRows || []).map(c => {
          const stats = byCust[c.id] || [];
          const totalSpend = stats.reduce((s, x) => s + (Number(x.lifetime_revenue) || 0), 0);
          const totalVisits = stats.reduce((s, x) => s + (x.visit_count || 0), 0);
          const lastVisit = stats.reduce((latest, x) => {
            if (!x.last_visit_at) return latest;
            return !latest || new Date(x.last_visit_at) > new Date(latest) ? x.last_visit_at : latest;
          }, null);
          const siteCount = stats.filter(s => (s.visit_count || 0) > 0).length;
          return { ...c, stats, totalSpend, totalVisits, lastVisit, siteCount };
        });
        setCustomers(enriched);

        // v5.5.223: Fetch loyalty data from platform DB
        if (platformSupabase && ids.length) {
          try {
            // Resolve company_id via platform locations
            const activeLocId = getActiveLocationSync() || locId;
            const { data: platLoc } = await platformSupabase.from('locations')
              .select('company_id')
              .or(`ops_location_id.eq.${activeLocId},id.eq.${activeLocId}`)
              .limit(1).maybeSingle();

            if (platLoc?.company_id) {
              // Fetch all loyalty memberships for this company
              const { data: loyaltyRows } = await platformSupabase
                .from('customer_loyalty')
                .select('customer_id, points_balance, points_earned_total, points_redeemed_total, visit_count, lifetime_spend_minor, member_code, tier_id, enrolled_at, last_earn_at')
                .eq('company_id', platLoc.company_id);

              const lMap = {};
              (loyaltyRows || []).forEach(r => { lMap[r.customer_id] = r; });
              setLoyaltyMap(lMap);

              // Fetch tier names
              const loyaltyTierIds = [...new Set((loyaltyRows || []).filter(r => r.tier_id).map(r => r.tier_id))];
              if (loyaltyTierIds.length) {
                const { data: tRows } = await platformSupabase
                  .from('loyalty_tiers')
                  .select('id, name, color, icon')
                  .in('id', loyaltyTierIds);
                const tMap = {};
                (tRows || []).forEach(t => { tMap[t.id] = t; });
                setTierMap(tMap);
              }

              // v5.5.257: Fetch stamp card programs + per-customer cards
              try {
                const { data: progs } = await platformSupabase
                  .from('stamp_card_programs')
                  .select('id, name, icon, stamps_required, reward_description, active')
                  .eq('company_id', platLoc.company_id)
                  .eq('active', true);
                setStampPrograms(progs || []);

                if (progs?.length && ids.length) {
                  const { data: stampCards } = await platformSupabase
                    .from('customer_stamp_cards')
                    .select('id, customer_id, program_id, stamps_collected, completed_count, last_stamp_at')
                    .eq('company_id', platLoc.company_id)
                    .in('customer_id', ids);
                  const scMap = {};
                  (stampCards || []).forEach(sc => {
                    if (!scMap[sc.customer_id]) scMap[sc.customer_id] = [];
                    scMap[sc.customer_id].push(sc);
                  });
                  setStampDataMap(scMap);
                }
              } catch (e) { console.warn('[Customers] stamp cards fetch:', e?.message); }
            }
          } catch (loyaltyErr) {
            console.warn('[Customers] loyalty fetch failed:', loyaltyErr?.message);
          }
        }
      } catch (err) {
        console.warn('[Customers] load failed:', err?.message || err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    const sd = search.replace(/\s/g, '');
    const now = Date.now();
    const dayMs = 86400000;

    let rows = customers;
    if (s) {
      rows = rows.filter(c =>
        (c.name || '').toLowerCase().includes(s) ||
        (c.phone || '').replace(/\s/g, '').includes(sd) ||
        (c.phone_raw || '').replace(/\s/g, '').includes(sd) ||
        (c.email || '').toLowerCase().includes(s)
      );
    }
    if (filterLoc !== 'all') {
      rows = rows.filter(c => c.stats.some(x => x.location_id === filterLoc));
    }
    if (filterRange !== 'all') {
      rows = rows.filter(c => {
        if (!c.lastVisit) return filterRange === 'dormant';
        const ageDays = (now - new Date(c.lastVisit).getTime()) / dayMs;
        if (filterRange === '7d')  return ageDays <= 7;
        if (filterRange === '30d') return ageDays <= 30;
        if (filterRange === '90d') return ageDays <= 90;
        if (filterRange === 'dormant') return ageDays > 90;
        return true;
      });
    }
    if (filterMarketing === 'optIn')  rows = rows.filter(c => c.marketing_opt_in);
    if (filterMarketing === 'optOut') rows = rows.filter(c => !c.marketing_opt_in);
    if (filterLoyalty === 'member')    rows = rows.filter(c => !!loyaltyMap[c.id]);
    if (filterLoyalty === 'notMember') rows = rows.filter(c => !loyaltyMap[c.id]);

    // Sort
    rows = [...rows].sort((a, b) => {
      let av, bv;
      if (sortBy === 'lastVisit') { av = a.lastVisit ? new Date(a.lastVisit).getTime() : 0; bv = b.lastVisit ? new Date(b.lastVisit).getTime() : 0; }
      else if (sortBy === 'spend') { av = a.totalSpend; bv = b.totalSpend; }
      else if (sortBy === 'visits') { av = a.totalVisits; bv = b.totalVisits; }
      else if (sortBy === 'sites') { av = a.siteCount || 0; bv = b.siteCount || 0; }
      else if (sortBy === 'points') { av = loyaltyMap[a.id]?.points_balance || 0; bv = loyaltyMap[b.id]?.points_balance || 0; }
      else { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [customers, search, filterLoc, filterRange, filterMarketing, filterLoyalty, loyaltyMap, sortBy, sortDir]);

  const selected = useMemo(() => filtered.find(c => c.id === selectedId) || customers.find(c => c.id === selectedId) || null, [filtered, customers, selectedId]);

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const exportCSV = () => {
    const cols = [
      ['Name',         c => c.name],
      ['Phone',        c => c.phone_raw || c.phone || ''],
      ['Email',        c => c.email || ''],
      ['Loyalty member', c => loyaltyMap[c.id] ? 'yes' : 'no'],
      ['Points',       c => loyaltyMap[c.id]?.points_balance || 0],
      ['Total visits', c => c.totalVisits || 0],
      ['Lifetime spend', c => (c.totalSpend || 0).toFixed(2)],
      ['Last visit',   c => c.lastVisit ? new Date(c.lastVisit).toISOString() : ''],
      ['Locations',    c => c.stats.map(s => s.locationName).join('; ')],
      ['Marketing opt-in', c => c.marketing_opt_in ? 'yes' : 'no'],
      ['Notes',        c => (c.notes || '').replace(/[\r\n]+/g, ' ')],
    ];
    const esc = v => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = cols.map(c => esc(c[0])).join(',');
    const rows = filtered.map(c => cols.map(col => esc(col[1](c))).join(','));
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'customers-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // v4.6.64: insights view shown via the tab bar at the top.
  if (view === 'insights') {
    return (
      <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
        <ViewTabs view={view} setView={setView} />
        <Insights customers={customers} locations={allLocations} insightsTab={insightsTab} setInsightsTab={setInsightsTab}/>
      </div>
    );
  }
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
      <ViewTabs view={view} setView={setView} />
      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
      {/* Left: list + filters */}
      <div style={{ width: selected ? 540 : '100%', borderRight: selected ? '1px solid var(--bdr)' : 'none', display:'flex', flexDirection:'column', flexShrink:0, overflow:'hidden' }}>
        {/* Header */}
        <div style={{ padding: '20px 24px 12px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between' }}>
            <div>
              <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)' }}>Customers</div>
              <div style={{ fontSize:13, color:'var(--t3)', marginTop:4 }}>{customers.length} total · {filtered.length} matching filter</div>
            </div>
            <button onClick={exportCSV} disabled={!filtered.length}
              style={{ padding:'8px 14px', borderRadius:8, border:'1px solid var(--bdr2)', background: filtered.length ? 'var(--bg3)' : 'var(--bg2)', color: filtered.length ? 'var(--t1)' : 'var(--t4)', fontFamily:'inherit', fontWeight:700, fontSize:12, cursor: filtered.length ? 'pointer' : 'not-allowed' }}>
              Export CSV
            </button>
          </div>
          {/* Search */}
          <input type="text" placeholder="Search by name, phone, email…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ width:'100%', marginTop:14, padding:'10px 14px', fontSize:14, borderRadius:8, border:'1.5px solid var(--bdr)', background:'var(--bg2)', color:'var(--t1)', fontFamily:'inherit' }}/>
          {/* Filters */}
          <div style={{ display:'flex', gap:12, flexWrap:'wrap', marginTop:12 }}>
            <Filter label="Location" value={filterLoc} onChange={setFilterLoc} options={[['all','All locations'], ...allLocations.map(l => [l.id, l.name])]} />
            <Filter label="Last visit" value={filterRange} onChange={setFilterRange} options={[['all','All time'],['7d','Last 7 days'],['30d','Last 30 days'],['90d','Last 90 days'],['dormant','Dormant (90+)']]}/>
            <Filter label="Marketing" value={filterMarketing} onChange={setFilterMarketing} options={[['all','All'],['optIn','Opt-in only'],['optOut','Opt-out only']]}/>
            <Filter label="Loyalty" value={filterLoyalty} onChange={setFilterLoyalty} options={[['all','All'],['member','Members only'],['notMember','Not enrolled']]}/>
          </div>
        </div>

        {/* List */}
        <div style={{ flex:1, overflowY:'auto' }}>
          {loading ? (
            <div style={{ padding:'60px 20px', textAlign:'center', color:'var(--t4)' }}>Loading customers…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding:'60px 20px', textAlign:'center', color:'var(--t4)' }}>
              <div style={{ fontSize:36, marginBottom:8, opacity:.35 }}>👥</div>
              <div style={{ fontSize:14, fontWeight:700, color:'var(--t3)' }}>{customers.length === 0 ? 'No customers yet' : 'No matches'}</div>
              <div style={{ fontSize:12, marginTop:4 }}>{customers.length === 0 ? 'Take a takeaway order with a phone number to start the database.' : 'Try a different search or clear the filters.'}</div>
            </div>
          ) : (
            <div>
              {/* Header row */}
              <div style={{ display:'grid', gridTemplateColumns:'2.2fr 1.4fr 0.9fr 0.8fr 1fr 1fr', gap:4, padding:'10px 24px', fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', background:'var(--bg2)', borderBottom:'1px solid var(--bdr)', position:'sticky', top:0, zIndex:1 }}>
                <SortHeader col="name" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort}>Customer</SortHeader>
                <span>Phone</span>
                <span style={{ textAlign:'center' }}>Loyalty</span>
                <SortHeader col="points" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right">Points</SortHeader>
                <SortHeader col="spend" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right">Spend</SortHeader>
                <SortHeader col="lastVisit" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right">Last visit</SortHeader>
              </div>
              {filtered.map(c => {
                const isSel = selectedId === c.id;
                const loyalty = loyaltyMap[c.id];
                const tier = loyalty?.tier_id ? tierMap[loyalty.tier_id] : null;
                return (
                  <div key={c.id} onClick={() => setSelectedId(isSel ? null : c.id)}
                    style={{ display:'grid', gridTemplateColumns:'2.2fr 1.4fr 0.9fr 0.8fr 1fr 1fr', gap:4, padding:'10px 24px', fontSize:13, alignItems:'center', borderBottom:'1px solid var(--bdr)', cursor:'pointer', background: isSel ? 'var(--acc-d)' : 'transparent' }}>
                    <div style={{ minWidth:0 }}>
                      <div style={{ fontWeight:700, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.name}</div>
                      {c.email && <div style={{ fontSize:11, color:'var(--t4)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.email}</div>}
                    </div>
                    <div style={{ color:'var(--t2)', fontFamily:'var(--font-mono)', fontSize:12 }}>{c.phone_raw || c.phone || '—'}</div>
                    <div style={{ textAlign:'center' }}>
                      {loyalty ? (
                        <span style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:10, background:'rgba(76,175,80,0.12)', color:'var(--grn,#4caf50)', border:'1px solid rgba(76,175,80,0.25)' }}>
                          {tier ? tier.name : 'Member'}
                        </span>
                      ) : (
                        <span style={{ fontSize:10, fontWeight:600, color:'var(--t4)' }}>—</span>
                      )}
                    </div>
                    <div style={{ textAlign:'right', color: loyalty ? 'var(--t1)' : 'var(--t4)', fontWeight:700, fontFamily:'var(--font-mono)', fontSize:12 }}>
                      {loyalty ? (loyalty.points_balance || 0) : '—'}
                    </div>
                    <div style={{ textAlign:'right', color:'var(--acc)', fontWeight:700, fontFamily:'var(--font-mono)' }}>{fmtMoney(c.totalSpend)}</div>
                    <div style={{ textAlign:'right', color:'var(--t3)', fontSize:12 }}>{fmtRel(c.lastVisit)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: detail panel */}
      {selected && <DetailPanel customer={selected} loyalty={loyaltyMap[selected.id]} tier={loyaltyMap[selected.id]?.tier_id ? tierMap[loyaltyMap[selected.id].tier_id] : null} stampCards={stampDataMap[selected.id] || []} stampPrograms={stampPrograms} onClose={() => setSelectedId(null)} onChanged={(updated) => {
        setCustomers(cs => cs.map(c => c.id === updated.id ? { ...c, ...updated } : c));
      }} onDeleted={() => {
        setCustomers(cs => cs.filter(c => c.id !== selected.id));
        setSelectedId(null);
      }}/>}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function Filter({ label, value, onChange, options }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <span style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ padding:'5px 8px', fontSize:12, borderRadius:6, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t2)', fontFamily:'inherit', cursor:'pointer' }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

function SortHeader({ col, sortBy, sortDir, onClick, align = 'left', children }) {
  const active = sortBy === col;
  return (
    <span onClick={() => onClick(col)} style={{ cursor:'pointer', textAlign: align, color: active ? 'var(--acc)' : 'inherit', userSelect:'none' }}>
      {children}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </span>
  );
}

function DetailPanel({ customer, loyalty, tier, stampCards = [], stampPrograms = [], onClose, onChanged, onDeleted }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [giftCards, setGiftCards] = useState([]);
  const [giftLoading, setGiftLoading] = useState(false);
  const [form, setForm] = useState({
    name: customer.name || '',
    phone_raw: customer.phone_raw || customer.phone || '',
    email: customer.email || '',
    notes: customer.notes || '',
    marketing_opt_in: !!customer.marketing_opt_in,
    allergens: Array.isArray(customer.allergens) ? customer.allergens : [],  // v4.6.67
  });

  useEffect(() => {
    (async () => {
      if (isMock || !supabase) { setLoading(false); return; }
      try {
        setLoading(true);
        const { data } = await supabase
          .from('customer_orders')
          .select('id, ordered_at, total, channel, item_summary, location_id, closed_check_id')
          .eq('customer_id', customer.id)
          .order('ordered_at', { ascending: false })
          .limit(50);
        setOrders(data || []);
      } catch (err) {
        console.warn('[DetailPanel orders] failed:', err?.message || err);
      } finally {
        setLoading(false);
      }
    })();

    // v5.5.203: Fetch gift cards linked to this customer by email or phone
    (async () => {
      if (isMock || !supabase) return;
      const email = customer.email?.trim();
      const phone = customer.phone_raw?.trim() || customer.phone?.trim();
      if (!email && !phone) { setGiftCards([]); return; }
      setGiftLoading(true);
      try {
        const seen = new Set();
        const cards = [];
        // Search by email first
        if (email) {
          const res = await callGift('gift-list', { search: email, limit: 100 });
          (res.cards || []).forEach(c => {
            if ((c.recipient_email || '').toLowerCase() === email.toLowerCase()) {
              seen.add(c.id);
              cards.push(c);
            }
          });
        }
        // Search by phone (dedup)
        if (phone) {
          const res = await callGift('gift-list', { search: phone, limit: 100 });
          (res.cards || []).forEach(c => {
            if (!seen.has(c.id) && (c.recipient_phone || '') === phone) {
              seen.add(c.id);
              cards.push(c);
            }
          });
        }
        setGiftCards(cards);
      } catch (err) {
        console.warn('[DetailPanel giftCards] failed:', err?.message || err);
        setGiftCards([]);
      } finally {
        setGiftLoading(false);
      }
    })();

    setForm({
      name: customer.name || '',
      phone_raw: customer.phone_raw || customer.phone || '',
      email: customer.email || '',
      notes: customer.notes || '',
      marketing_opt_in: !!customer.marketing_opt_in,
      allergens: Array.isArray(customer.allergens) ? customer.allergens : [],
    });
    setEditing(false);
  }, [customer.id]);

  const handleSave = async () => {
    if (isMock || !supabase) return;
    try {
      const patch = {
        name: form.name.trim() || customer.name,
        phone_raw: form.phone_raw.trim() || null,
        email: form.email.trim() || null,
        notes: form.notes.trim() || null,
        marketing_opt_in: !!form.marketing_opt_in,
        allergens: Array.isArray(form.allergens) ? form.allergens : [],  // v4.6.67
        updated_at: new Date().toISOString(),
      };
      if (form.marketing_opt_in && !customer.marketing_opt_in) {
        patch.marketing_opt_in_at = new Date().toISOString();
      }
      const { data, error } = await supabase.from('customers').update(patch).eq('id', customer.id).select().single();
      if (error) throw error;
      onChanged?.(data);
      setEditing(false);
    } catch (err) {
      alert('Save failed: ' + (err?.message || err));
    }
  };

  const handleDelete = async () => {
    if (!confirm('Soft-delete this customer? Their order history stays for audit, but they\'ll disappear from search and reports. (GDPR right-to-be-forgotten.)')) return;
    try {
      await supabase.from('customers').update({ deleted_at: new Date().toISOString() }).eq('id', customer.id);
      onDeleted?.();
    } catch (err) {
      alert('Delete failed: ' + (err?.message || err));
    }
  };

  return (
    <div style={{ flex:1, overflowY:'auto' }}>
      {/* Header */}
      <div style={{ padding:'18px 22px 14px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12, position:'sticky', top:0, background:'var(--bg1)', zIndex:2 }}>
        <div style={{ minWidth:0, flex:1 }}>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis' }}>{customer.name}</div>
          <div style={{ fontSize:12, color:'var(--t3)', marginTop:4 }}>
            <span style={{ fontFamily:'var(--font-mono)' }}>{customer.phone_raw || customer.phone || ''}</span>
            {customer.email && <span> · {customer.email}</span>}
          </div>
        </div>
        <button onClick={onClose} style={{ width:28, height:28, padding:0, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t3)', borderRadius:6, cursor:'pointer', fontSize:16, fontFamily:'inherit', flexShrink:0 }}>×</button>
      </div>

      {/* Stats overview */}
      <div style={{ padding:'14px 22px', borderBottom:'1px solid var(--bdr)', display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:10 }}>
        <Stat label="Lifetime spend" value={fmtMoney(customer.totalSpend)} color="var(--acc)"/>
        <Stat label="Total visits" value={customer.totalVisits || 0}/>
        <Stat label="Last visit" value={fmtRel(customer.lastVisit)}/>
      </div>

      {/* v5.5.223: Loyalty & gift card stats */}
      <div style={{ padding:'14px 22px', borderBottom:'1px solid var(--bdr)', display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:10 }}>
        <div style={{ background:'var(--bg2)', borderRadius:8, padding:'8px 10px' }}>
          <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>Loyalty</div>
          <div style={{ marginTop:4 }}>
            {loyalty ? (
              <span style={{ fontSize:12, fontWeight:800, padding:'3px 10px', borderRadius:10, background:'rgba(76,175,80,0.12)', color:'var(--grn,#4caf50)', border:'1px solid rgba(76,175,80,0.25)' }}>
                {tier ? tier.name : 'Member'}
              </span>
            ) : (
              <span style={{ fontSize:12, fontWeight:600, color:'var(--t4)' }}>Not enrolled</span>
            )}
          </div>
        </div>
        <Stat label="Points" value={loyalty ? (loyalty.points_balance || 0) : '—'} color={loyalty ? 'var(--acc)' : 'var(--t4)'}/>
        <Stat label="Gift cards" value={giftCards.length} color={giftCards.length > 0 ? 'var(--grn,#4caf50)' : 'var(--t4)'}/>
      </div>

      {/* v5.5.223: Loyalty details (when enrolled) */}
      {loyalty && (
        <div style={{ padding:'14px 22px', borderBottom:'1px solid var(--bdr)' }}>
          <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Loyalty details</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
            <Row label="Member code" value={loyalty.member_code || '—'}/>
            <Row label="Points balance" value={loyalty.points_balance || 0}/>
            <Row label="Total earned" value={loyalty.points_earned_total || 0}/>
            <Row label="Total redeemed" value={loyalty.points_redeemed_total || 0}/>
            <Row label="Loyalty visits" value={loyalty.visit_count || 0}/>
            {loyalty.lifetime_spend_minor > 0 && <Row label="Loyalty spend" value={fmtMoney((loyalty.lifetime_spend_minor || 0) / 100)}/>}
            <Row label="Enrolled" value={fmtDate(loyalty.enrolled_at)}/>
            {loyalty.last_earn_at && <Row label="Last earned" value={fmtRel(loyalty.last_earn_at)}/>}
            {tier && <Row label="Tier" value={tier.name}/>}
          </div>
        </div>
      )}

      {/* v5.5.257: Stamp cards */}
      {stampPrograms.length > 0 && (
        <div style={{ padding:'14px 22px', borderBottom:'1px solid var(--bdr)' }}>
          <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Stamp cards</div>
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {stampPrograms.map(prog => {
              const card = stampCards.find(sc => sc.program_id === prog.id);
              const collected = card?.stamps_collected || 0;
              const completed = card?.completed_count || 0;
              const pct = Math.min(100, Math.round((collected / prog.stamps_required) * 100));
              return (
                <div key={prog.id} style={{ padding:'10px 12px', background:'var(--bg2)', borderRadius:8, border:'1px solid var(--bdr)' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <span style={{ fontSize:18 }}>{prog.icon || '☕'}</span>
                    <span style={{ fontSize:12, fontWeight:700, color:'var(--t1)', flex:1 }}>{prog.name}</span>
                    {completed > 0 && (
                      <span style={{ fontSize:10, fontWeight:700, color:'var(--grn,#4caf50)', padding:'1px 6px', borderRadius:4, background:'rgba(76,175,80,0.12)' }}>
                        {completed}× completed
                      </span>
                    )}
                  </div>
                  <div style={{ height:6, borderRadius:3, background:'var(--bg3)', overflow:'hidden', marginBottom:4 }}>
                    <div style={{ width:`${pct}%`, height:'100%', borderRadius:3, background:'var(--acc)' }}/>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t3)' }}>
                    <span style={{ fontWeight:600 }}>{collected}/{prog.stamps_required} stamps</span>
                    {card?.last_stamp_at && <span>Last: {new Date(card.last_stamp_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short' })}</span>}
                  </div>
                  {prog.reward_description && <div style={{ fontSize:10, color:'var(--t4)', marginTop:2 }}>Reward: {prog.reward_description}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Per-location breakdown */}
      {customer.stats?.length > 0 && (
        <div style={{ padding:'14px 22px', borderBottom:'1px solid var(--bdr)' }}>
          <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Per location</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {customer.stats.map(s => (
              <div key={s.location_id} style={{ display:'grid', gridTemplateColumns:'1.4fr 0.8fr 1fr 1fr', gap:10, padding:'8px 10px', fontSize:12, background:'var(--bg2)', borderRadius:6, alignItems:'center' }}>
                <div style={{ color:'var(--t1)', fontWeight:700 }}>{s.locationName}</div>
                <div style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{s.visit_count} visits</div>
                <div style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmtMoney(s.lifetime_revenue)}</div>
                <div style={{ textAlign:'right', color:'var(--t3)', fontSize:11 }}>{fmtRel(s.last_visit_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Profile (edit / view) */}
      <div style={{ padding:'14px 22px', borderBottom:'1px solid var(--bdr)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
          <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>Profile</div>
          {!editing ? (
            <button onClick={() => setEditing(true)} style={btnSmall}>Edit</button>
          ) : (
            <div style={{ display:'flex', gap:6 }}>
              <button onClick={() => setEditing(false)} style={btnSmall}>Cancel</button>
              <button onClick={handleSave} style={{ ...btnSmall, background:'var(--acc)', color:'#fff', borderColor:'var(--acc)' }}>Save</button>
            </div>
          )}
        </div>
        {editing ? (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <Field label="Name"><input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle}/></Field>
            <Field label="Phone"><input type="text" value={form.phone_raw} onChange={e => setForm(f => ({ ...f, phone_raw: e.target.value }))} style={inputStyle}/></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inputStyle}/></Field>
            <Field label="Notes"><textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} style={{ ...inputStyle, resize:'vertical' }}/></Field>
            <Field label="Allergens">
              <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                {["gluten","dairy","milk","eggs","nuts","peanuts","soy","fish","shellfish","sesame","sulphites","celery","mustard","lupin","molluscs"].map(a => {
                  const on = form.allergens.includes(a);
                  return (
                    <button key={a} type="button" onClick={() => setForm(f => ({ ...f, allergens: on ? f.allergens.filter(x => x !== a) : [...f.allergens, a] }))} style={{
                      padding:'4px 10px', fontSize:11, borderRadius:6,
                      border: on ? '1px solid var(--red,#cc5959)' : '1px solid var(--bdr)',
                      background: on ? 'rgba(235,97,97,.12)' : 'var(--bg2)',
                      color: on ? 'var(--red,#cc5959)' : 'var(--t3)',
                      fontFamily:'inherit', fontWeight:600, cursor:'pointer',
                    }}>{a}</button>
                  );
                })}
              </div>
            </Field>
            <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'var(--t2)', cursor:'pointer' }}>
              <input type="checkbox" checked={form.marketing_opt_in} onChange={e => setForm(f => ({ ...f, marketing_opt_in: e.target.checked }))}/>
              Marketing opt-in
            </label>
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:6, fontSize:13 }}>
            {customer.notes && <Row label="Notes" value={customer.notes}/>}
            {Array.isArray(customer.allergens) && customer.allergens.length > 0 && (
              <Row label="Allergens" value={customer.allergens.join(', ')}/>
            )}
            <Row label="Marketing" value={customer.marketing_opt_in ? '✓ Opted in' : '✗ Not opted in'}/>
            <Row label="Customer since" value={fmtDate(customer.created_at)}/>
          </div>
        )}
      </div>

      {/* Gift cards — v5.5.203 */}
      {(giftLoading || giftCards.length > 0) && (
        <div style={{ padding:'14px 22px', borderBottom:'1px solid var(--bdr)' }}>
          <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:10 }}>Gift cards</div>
          {giftLoading ? (
            <div style={{ fontSize:12, color:'var(--t4)' }}>Loading…</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {giftCards.map(c => {
                const statusColors = { active:'var(--grn,#4caf50)', redeemed:'var(--t4)', voided:'var(--red,#cc5959)', expired:'var(--red,#cc5959)' };
                const sColor = statusColors[c.status] || 'var(--t4)';
                return (
                  <div key={c.id} style={{ display:'grid', gridTemplateColumns:'auto 1fr auto auto', gap:10, padding:'8px 10px', fontSize:12, background:'var(--bg2)', borderRadius:6, alignItems:'center' }}>
                    <div style={{ fontFamily:'var(--font-mono)', color:'var(--t2)', fontWeight:700 }}>····{c.code_last4}</div>
                    <div style={{ color:'var(--t3)' }}>
                      {fmtMoney((c.balance_minor || 0) / 100)} / {fmtMoney((c.initial_amount_minor || 0) / 100)}
                    </div>
                    <div style={{ fontSize:11, color:sColor, fontWeight:700, textTransform:'capitalize' }}>{c.status}</div>
                    <div style={{ fontSize:11, color:'var(--t4)' }}>{fmtDate(c.issued_at || c.created_at)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Order history */}
      <div>
        <div style={{ padding:'14px 22px 8px' }}>
          <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>Order history</div>
        </div>
        {loading ? (
          <div style={{ padding:'30px 22px', textAlign:'center', color:'var(--t4)', fontSize:12 }}>Loading…</div>
        ) : orders.length === 0 ? (
          <div style={{ padding:'30px 22px', textAlign:'center', color:'var(--t4)', fontSize:12 }}>No orders recorded yet.</div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column' }}>
            {orders.map(o => (
              <div key={o.id} style={{ padding:'10px 22px', borderBottom:'1px solid var(--bdr)' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:4 }}>
                  <div style={{ fontSize:12, color:'var(--t3)' }}>
                    {fmtTime(o.ordered_at)} <span style={{ color:'var(--t4)' }}>· {o.channel || 'order'}</span>
                  </div>
                  <div style={{ fontSize:14, fontWeight:700, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{fmtMoney(o.total)}</div>
                </div>
                {Array.isArray(o.item_summary) && o.item_summary.length > 0 && (
                  <div style={{ fontSize:11, color:'var(--t3)', lineHeight:1.5 }}>
                    {o.item_summary.map((i, k) => (
                      <span key={k}>
                        {k > 0 ? ', ' : ''}{i.qty || 1} × {i.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer — soft-delete */}
      <div style={{ padding:'12px 22px', borderTop:'1px solid var(--bdr)', display:'flex', justifyContent:'flex-end' }}>
        <button onClick={handleDelete} style={{ ...btnSmall, color:'var(--red, #cc5959)', borderColor:'var(--red-b, #cc5959)' }}>Delete customer</button>
      </div>
    </div>
  );
}



// ── v4.6.64: View tabs ───────────────────────────────────────────

function ViewTabs({ view, setView }) {
  const tabs = [
    ['list',     'Customer list'],
    ['insights', 'Insights & cross-location'],
  ];
  return (
    <div style={{ display:'flex', gap:0, borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
      {tabs.map(([id, label]) => (
        <button key={id} onClick={() => setView(id)}
          style={{
            padding:'12px 22px', border:'none', background:'transparent',
            color: view === id ? 'var(--t1)' : 'var(--t4)',
            borderBottom: view === id ? '2px solid var(--acc)' : '2px solid transparent',
            fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:'inherit',
          }}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ── v4.6.64: Insights panel ──────────────────────────────────────

function Insights({ customers, locations, insightsTab, setInsightsTab }) {
  const tabs = [
    ['vips',      'Brand VIPs'],
    ['perLoc',    'Top per location'],
    ['multi',     'Multi-location'],
    ['crossSell', 'Cross-sell'],
    ['dormant',   'Dormant'],
  ];

  return (
    <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
      <div style={{ padding:'14px 24px 10px', borderBottom:'1px solid var(--bdr)', display:'flex', gap:8, flexWrap:'wrap', background:'var(--bg2)' }}>
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setInsightsTab(id)}
            style={{
              padding:'7px 14px', borderRadius:6, fontFamily:'inherit', cursor:'pointer', fontWeight:700,
              background: insightsTab === id ? 'var(--acc-d)' : 'var(--bg3)',
              border: `1px solid ${insightsTab === id ? 'var(--acc)' : 'var(--bdr)'}`,
              color: insightsTab === id ? 'var(--acc)' : 'var(--t3)',
              fontSize:12,
            }}>
            {label}
          </button>
        ))}
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:'18px 24px' }}>
        {insightsTab === 'vips'      && <BrandVIPs customers={customers}/>}
        {insightsTab === 'perLoc'    && <TopPerLocation customers={customers} locations={locations}/>}
        {insightsTab === 'multi'     && <MultiLocation customers={customers} locations={locations}/>}
        {insightsTab === 'crossSell' && <CrossSell customers={customers} locations={locations}/>}
        {insightsTab === 'dormant'   && <Dormant customers={customers}/>}
      </div>
    </div>
  );
}

function BrandVIPs({ customers }) {
  const top = useMemo(() => {
    return [...customers].filter(c => c.totalSpend > 0).sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 50);
  }, [customers]);

  if (top.length === 0) return <EmptyMsg label="No spending customers yet"/>;

  return (
    <div>
      <H label="Top 50 customers by lifetime spend" sub="Across every location in your brand. The leaderboard for VIP rewards, personal touches, and email campaigns."/>
      <Leaderboard rows={top} showLocations/>
    </div>
  );
}

function TopPerLocation({ customers, locations }) {
  if (locations.length === 0) return <EmptyMsg label="No locations configured"/>;

  return (
    <div>
      <H label="Top 10 customers per location" sub="Each location's biggest spenders. Useful for location-specific loyalty and reactivation."/>
      <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
        {locations.map(loc => {
          const top = customers
            .map(c => {
              const stat = c.stats.find(s => s.location_id === loc.id);
              if (!stat || (stat.lifetime_revenue || 0) === 0) return null;
              return { ...c, locSpend: Number(stat.lifetime_revenue) || 0, locVisits: stat.visit_count || 0, locLastVisit: stat.last_visit_at };
            })
            .filter(Boolean)
            .sort((a, b) => b.locSpend - a.locSpend)
            .slice(0, 10);
          return (
            <div key={loc.id} style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden' }}>
              <div style={{ padding:'10px 14px', background:'var(--bg2)', borderBottom:'1px solid var(--bdr)', fontSize:13, fontWeight:800, color:'var(--t1)' }}>
                {loc.name} <span style={{ color:'var(--t4)', fontWeight:500, marginLeft:6 }}>· {top.length} customers</span>
              </div>
              {top.length === 0 ? (
                <div style={{ padding:'14px', fontSize:12, color:'var(--t4)' }}>No customers at this location yet.</div>
              ) : (
                <Leaderboard rows={top.map(r => ({ ...r, totalSpend: r.locSpend, totalVisits: r.locVisits, lastVisit: r.locLastVisit }))} compact/>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MultiLocation({ customers, locations }) {
  const buckets = useMemo(() => {
    const counts = {};
    customers.forEach(c => {
      const n = c.stats.filter(s => (s.visit_count || 0) > 0).length;
      counts[n] = (counts[n] || 0) + 1;
    });
    return counts;
  }, [customers]);

  const multiOnly = useMemo(() =>
    customers.filter(c => c.stats.filter(s => (s.visit_count || 0) > 0).length >= 2)
             .sort((a, b) => b.totalSpend - a.totalSpend)
             .slice(0, 50),
    [customers]
  );

  return (
    <div>
      <H label="Multi-location customers" sub="Customers who've shopped at more than one location. These are your most loyal — extend that relationship."/>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:10, marginBottom:18 }}>
        <Tile label="Single location" value={buckets[1] || 0} color="var(--t3)"/>
        <Tile label="2 locations" value={buckets[2] || 0} color="var(--acc)"/>
        <Tile label="3 locations" value={buckets[3] || 0} color="var(--grn)"/>
        {Object.keys(buckets).filter(n => Number(n) >= 4).reduce((a, n) => a + buckets[n], 0) > 0 && (
          <Tile label="4+ locations" value={Object.keys(buckets).filter(n => Number(n) >= 4).reduce((a, n) => a + buckets[n], 0)} color="#a855f7"/>
        )}
      </div>
      {multiOnly.length === 0 ? (
        <EmptyMsg label="No multi-location customers yet"/>
      ) : (
        <>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--t2)', marginBottom:10 }}>Top multi-location VIPs</div>
          <Leaderboard rows={multiOnly} showLocations/>
        </>
      )}
    </div>
  );
}

function CrossSell({ customers, locations }) {
  const [primaryLocId, setPrimaryLocId] = useState(locations[0]?.id || '');
  const [targetLocId, setTargetLocId] = useState(locations[1]?.id || '');

  const candidates = useMemo(() => {
    if (!primaryLocId || !targetLocId || primaryLocId === targetLocId) return [];
    return customers.filter(c => {
      const visitsAtPrimary = c.stats.find(s => s.location_id === primaryLocId)?.visit_count || 0;
      const visitsAtTarget  = c.stats.find(s => s.location_id === targetLocId)?.visit_count || 0;
      return visitsAtPrimary >= 2 && visitsAtTarget === 0;
    }).sort((a, b) => b.totalSpend - a.totalSpend).slice(0, 50);
  }, [customers, primaryLocId, targetLocId]);

  if (locations.length < 2) {
    return <EmptyMsg label="Cross-sell needs 2+ locations" sub="Add another location to your brand and customers will start showing up here."/>;
  }

  return (
    <div>
      <H label="Cross-sell candidates" sub={`Regulars at one location who haven't visited another yet. Perfect for "we'd love to see you at ${locations.find(l => l.id === targetLocId)?.name || 'our other site'}" outreach.`}/>
      <div style={{ display:'flex', gap:14, alignItems:'center', marginBottom:14, padding:'12px 14px', background:'var(--bg2)', borderRadius:8 }}>
        <span style={{ fontSize:12, color:'var(--t3)' }}>Show regulars at</span>
        <select value={primaryLocId} onChange={e => setPrimaryLocId(e.target.value)} style={selectStyle}>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <span style={{ fontSize:12, color:'var(--t3)' }}>who've never visited</span>
        <select value={targetLocId} onChange={e => setTargetLocId(e.target.value)} style={selectStyle}>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      {candidates.length === 0 ? (
        <EmptyMsg label="No candidates match" sub="Either there aren't enough regulars at the primary location yet, or they've all already visited the target."/>
      ) : (
        <Leaderboard rows={candidates} showLocations/>
      )}
    </div>
  );
}

function Dormant({ customers }) {
  const dormant = useMemo(() => {
    const cutoff = Date.now() - 90 * 86400000;
    return customers
      .filter(c => c.lastVisit && new Date(c.lastVisit).getTime() < cutoff && c.totalSpend > 0)
      .sort((a, b) => b.totalSpend - a.totalSpend)
      .slice(0, 100);
  }, [customers]);

  if (dormant.length === 0) return <EmptyMsg label="No dormant high-spenders" sub="No customers with lifetime spend who haven't visited in 90+ days. Healthy retention!"/>;

  return (
    <div>
      <H label="Dormant VIPs (90+ days)" sub={`${dormant.length} customers who used to spend with you but haven't been back in 3 months. Top win-back candidates.`}/>
      <Leaderboard rows={dormant} showLocations/>
    </div>
  );
}

// ── Insights helpers ─────────────────────────────────────────────

function Leaderboard({ rows, showLocations, compact }) {
  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden' }}>
      <div style={{ display:'grid', gridTemplateColumns: compact ? '32px 2fr 0.8fr 1fr 1fr' : '32px 2fr 1fr 0.8fr 1fr 1fr', gap:10, padding:'10px 14px', fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', background:'var(--bg2)', borderBottom:'1px solid var(--bdr)' }}>
        <span>#</span>
        <span>Customer</span>
        {!compact && <span>Phone</span>}
        <span style={{ textAlign:'right' }}>Visits</span>
        <span style={{ textAlign:'right' }}>Spend</span>
        <span style={{ textAlign:'right' }}>Last visit</span>
      </div>
      {rows.map((c, i) => (
        <div key={c.id} style={{ display:'grid', gridTemplateColumns: compact ? '32px 2fr 0.8fr 1fr 1fr' : '32px 2fr 1fr 0.8fr 1fr 1fr', gap:10, padding:'9px 14px', fontSize:12, alignItems:'center', borderBottom:'1px solid var(--bdr)' }}>
          <span style={{ color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{i + 1}</span>
          <div style={{ minWidth:0 }}>
            <div style={{ fontWeight:700, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis' }}>{c.name}</div>
            {showLocations && c.stats?.length > 0 && (
              <div style={{ display:'flex', gap:3, marginTop:3, flexWrap:'wrap' }}>
                {c.stats.filter(s => (s.visit_count || 0) > 0).slice(0, 4).map(s => (
                  <span key={s.location_id} style={{ fontSize:9, fontWeight:600, padding:'1px 6px', borderRadius:4, background:'var(--bg3)', color:'var(--t3)' }}>{s.locationName}</span>
                ))}
              </div>
            )}
          </div>
          {!compact && <div style={{ color:'var(--t3)', fontFamily:'var(--font-mono)', fontSize:11 }}>{c.phone_raw || c.phone || '—'}</div>}
          <div style={{ textAlign:'right', color:'var(--t1)', fontWeight:700, fontFamily:'var(--font-mono)' }}>{c.totalVisits || 0}</div>
          <div style={{ textAlign:'right', color:'var(--acc)', fontWeight:800, fontFamily:'var(--font-mono)' }}>£{(Number(c.totalSpend) || 0).toFixed(2)}</div>
          <div style={{ textAlign:'right', color:'var(--t3)', fontSize:11 }}>{c.lastVisit ? fmtRel(c.lastVisit) : '—'}</div>
        </div>
      ))}
    </div>
  );
}

function H({ label, sub }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)' }}>{label}</div>
      {sub && <div style={{ fontSize:12, color:'var(--t3)', marginTop:4, lineHeight:1.5 }}>{sub}</div>}
    </div>
  );
}

function Tile({ label, value, color = 'var(--t1)' }) {
  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:8, padding:'10px 14px' }}>
      <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</div>
      <div style={{ fontSize:24, fontWeight:800, color, marginTop:4, fontFamily:'var(--font-mono)' }}>{value}</div>
    </div>
  );
}

function EmptyMsg({ label, sub }) {
  return (
    <div style={{ padding:'40px 20px', textAlign:'center', color:'var(--t4)', background:'var(--bg1)', border:'1px dashed var(--bdr2)', borderRadius:10 }}>
      <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>📊</div>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--t3)' }}>{label}</div>
      {sub && <div style={{ fontSize:12, marginTop:4, lineHeight:1.5 }}>{sub}</div>}
    </div>
  );
}

const selectStyle = {
  padding:'6px 10px', fontSize:13, borderRadius:6,
  border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)',
  fontFamily:'inherit', fontWeight:700, cursor:'pointer',
};

// ── Tiny helpers ────────────────────────────────────────────────

const inputStyle = {
  width:'100%', padding:'7px 10px', fontSize:13, borderRadius:6,
  border:'1px solid var(--bdr)', background:'var(--bg2)', color:'var(--t1)', fontFamily:'inherit',
};

const btnSmall = {
  padding:'5px 10px', fontSize:11, fontWeight:700,
  borderRadius:6, border:'1px solid var(--bdr)',
  background:'var(--bg3)', color:'var(--t2)', cursor:'pointer', fontFamily:'inherit',
};

function Stat({ label, value, color = 'var(--t1)' }) {
  return (
    <div style={{ background:'var(--bg2)', borderRadius:8, padding:'8px 10px' }}>
      <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</div>
      <div style={{ fontSize:16, fontWeight:800, color, marginTop:3, fontFamily:'var(--font-mono)' }}>{value}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:4 }}>{label}</div>
      {children}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'120px 1fr', gap:10, fontSize:12 }}>
      <span style={{ color:'var(--t4)' }}>{label}</span>
      <span style={{ color:'var(--t2)' }}>{value}</span>
    </div>
  );
}
