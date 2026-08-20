import { useState, useMemo, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { MENU_ITEMS, ALLERGENS } from '../data/seed';
import ProductModal, { AllergenModal } from '../components/ProductModal';
import InlineItemFlow from '../components/InlineItemFlow';
import CheckoutModal from './CheckoutModal';
import TabPreAuthTerminal from '../components/TabPreAuthTerminal';
import { getNextOrderRefLocal, fetchMenuCategoryLinks } from '../lib/db';
import { linkedCategoryIdSet, categoryVisibleInMenu, allowedCategoryIds, itemInAllowedCats } from '../lib/menuMembership';
import { getActiveLocationSync, ensureAuthToken } from '../lib/supabase';
import { getLocationProcessorInfo } from '../lib/payments/processor';
import { isTrainingMode } from '../lib/trainingMode';
import { money, currencySymbol } from '../lib/currency';
import { kitchenOverride, receiptOverride } from '../lib/itemDisplay';
import { giftRecordFrom } from '../lib/giftCommit';

const CAT_META = {
  quick:    { icon:'⚡', color:'#e8a020' },
  starters: { icon:'🥗', color:'#22c55e' },
  mains:    { icon:'🍽', color:'#3b82f6' },
  pizza:    { icon:'🍕', color:'#f07020' },
  sides:    { icon:'🍟', color:'#a855f7' },
  desserts: { icon:'🍮', color:'#e84066' },
  drinks:   { icon:'🍷', color:'#e84040' },
  cocktails:{ icon:'🍸', color:'#22d3ee' },
};

const STATUS_META = {
  open:    { color:'#22c55e', bg:'rgba(34,197,94,.1)',   label:'Open'    },
  running: { color:'#f97316', bg:'rgba(249,115,22,.1)',  label:'Running' },
  closing: { color:'#e8a020', bg:'rgba(232,160,32,.1)',  label:'Closing' },
  closed:  { color:'#5c5a64', bg:'rgba(92,90,100,.1)',   label:'Closed'  },
};

function timeOpen(date) {
  if (!date) return '0m';
  const t = date instanceof Date ? date.getTime() : typeof date === 'string' ? new Date(date).getTime() : Number(date);
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins/60)}h ${mins%60}m`;
}

// ─── Open Tab Modal ──────────────────────────────────────────────────────────
// v5.5.909: `canPreAuth` is resolved ONCE by BarSurface (below) and passed in, rather than
// looked up here — the lookup is async, so doing it in the modal would render the pre-auth
// toggle for a frame and then yank it away, which is exactly the "offered then withdrawn"
// behaviour we are removing.
function OpenTabModal({ onConfirm, onCancel, canPreAuth = true }) {
  const { tables, tabs } = useStore();
  const [name, setName]           = useState('');
  const [seatId, setSeatId]       = useState('');
  const [linked, setLinked]       = useState('');   // table id
  // v5.5.324: pre-auth now places a REAL card hold on the reader at open, so it
  // defaults OFF — staff opt in per tab. (It was on-by-default while cosmetic;
  // leaving it on would force a card tap on every tab open.)
  const [preAuth, setPreAuth]     = useState(false);
  const [preAmt, setPreAmt]       = useState('50');
  const [note, setNote]           = useState('');
  // v4.6.26: derive bar seats from floor plan. Each seat is { id, label, busy }.
  const busySeatIds = new Set((tabs||[]).filter(t=>t.status!=='closed'&&t.tableId).map(t=>t.tableId));
  const barSeats = (tables||[]).filter(t=>t.section==='bar').map(t=>({
    id: t.id, label: t.label || String(t.id).toUpperCase(), busy: busySeatIds.has(t.id),
  })).sort((a,b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  // ^ natural sort so B1, B2, ..., B10 display in expected order (not B1, B10, B2).
  const openTables = tables.filter(t=>t.section==='bar' && (t.status==='open'||t.status==='available'));

  return (
    <div className="modal-back">
      <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:400, padding:24, boxShadow:'var(--sh3)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <div style={{ fontSize:17, fontWeight:700, color:'var(--t1)' }}>Open bar tab</div>
          <button onClick={onCancel} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:22 }}>×</button>
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <div>
            <label style={labelStyle}>Tab name <span style={{color:'var(--red)'}}>*</span></label>
            <input className="input" placeholder="Guest name or party name" value={name} onChange={e=>setName(e.target.value)} autoFocus/>
          </div>

          <div>
            <label style={labelStyle}>Bar seat (optional)</label>
            {/* v5.5.742: grid that WRAPS — a flat flex row overflowed the modal once a venue had many
                bar seats (B1…B15 + Roaming spilled outside the card). auto-fill wraps into rows. */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(46px, 1fr))', gap:6 }}>
              {barSeats.length===0 && (
                <div style={{ gridColumn:'1 / -1', padding:'8px 4px', borderRadius:8, background:'var(--bg3)', color:'var(--t4)', fontSize:11, fontStyle:'italic', textAlign:'center' }}>
                  No bar seats on your floor plan. Roaming only.
                </div>
              )}
              {barSeats.map(s=>(
                <button key={s.id} disabled={s.busy} onClick={()=>setSeatId(s.id===seatId?'':s.id)} style={{
                  padding:'8px 4px', borderRadius:8, cursor:s.busy?'not-allowed':'pointer', fontFamily:'inherit',
                  border:`1.5px solid ${seatId===s.id?'var(--acc)':'var(--bdr)'}`,
                  background:seatId===s.id?'var(--acc-d)':'var(--bg3)',
                  color:seatId===s.id?'var(--acc)':(s.busy?'var(--t4)':'var(--t2)'), fontSize:13, fontWeight:700,
                  opacity:s.busy?0.5:1,
                }} title={s.busy?'Seat already has an open tab':''}>{s.label}{s.busy?' \u00B7':''}</button>
              ))}
              <button onClick={()=>setSeatId('')} style={{
                gridColumn:'span 2', padding:'8px 4px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                border:`1.5px solid ${'roaming'===seatId||seatId===''?'var(--acc)':'var(--bdr)'}`,
                background:'roaming'===seatId||seatId===''?'var(--acc-d)':'var(--bg3)',
                color:'roaming'===seatId||seatId===''?'var(--acc)':'var(--t2)', fontSize:12, fontWeight:700, whiteSpace:'nowrap',
              }}>🚶 Roaming</button>
            </div>
          </div>

          <div>
            <label style={labelStyle}>Link to table (optional)</label>
            <select value={linked} onChange={e=>setLinked(e.target.value)} style={{ width:'100%', height:40, background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:10, padding:'0 12px', color:'var(--t1)', fontFamily:'inherit', fontSize:13, outline:'none' }}>
              <option value="">No table — bar only</option>
              {openTables.map(t=><option key={t.id} value={t.id}>{t.label} (covers {t.covers})</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>Tab note (optional)</label>
            <input className="input" placeholder="Birthday, celebrating, VIP..." value={note} onChange={e=>setNote(e.target.value)}/>
          </div>

          {/* v5.5.909 — NEVER OFFER A HOLD WE CANNOT TAKE. Ryft in-person terminals have no
              card-hold capability at all (pre-auth is Stripe-Terminal-only), so on a Ryft venue
              this toggle could only ever lead to a dead end. There WAS a guard, but it fired in
              TabPreAuthTerminal AFTER staff had flipped the toggle and pressed "Open tab" — they
              were still offered something that always failed. Hidden at source now. Tabs still
              open normally on Ryft, just without a hold. */}
          {canPreAuth && (
          <div style={{ background:'var(--bg3)', borderRadius:12, padding:'12px 14px', border:'1px solid var(--bdr)' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: preAuth ? 10 : 0 }}>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Card pre-authorisation</div>
                <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>Places a hold on card — no charge until tab closes</div>
              </div>
              <button onClick={()=>setPreAuth(p=>!p)} style={{
                width:40, height:22, borderRadius:11, cursor:'pointer', border:'none', transition:'all .2s',
                background:preAuth?'var(--acc)':'var(--bg5)', position:'relative', flexShrink:0,
              }}>
                <div style={{ width:16, height:16, borderRadius:'50%', background:'#fff', position:'absolute', top:3, transition:'left .2s', left:preAuth?20:3 }}/>
              </button>
            </div>
            {preAuth && (
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:13, color:'var(--t3)' }}>Hold amount</span>
                <div style={{ display:'flex', gap:4, marginLeft:'auto' }}>
                  {['20','50','100','200'].map(a=>(
                    <button key={a} onClick={()=>setPreAmt(a)} style={{
                      padding:'4px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                      border:`1px solid ${preAmt===a?'var(--acc)':'var(--bdr)'}`,
                      background:preAmt===a?'var(--acc-d)':'transparent',
                      color:preAmt===a?'var(--acc)':'var(--t3)', fontSize:12, fontWeight:600,
                    }}>{currencySymbol()}{a}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
          )}
        </div>

        <div style={{ display:'flex', gap:8, marginTop:20 }}>
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onCancel}>Cancel</button>
          <button className="btn btn-acc" style={{ flex:2, height:46 }}
            disabled={!name.trim()}
            onClick={() => {
              // v4.6.26: seatId state holds table id. Resolve to { label, tableId }.
              const seat = barSeats.find(s=>s.id===seatId);
              const displayLabel = seat ? seat.label : (seatId || null);
              const resolvedTableId = linked || (seat ? seat.id : null);
              onConfirm({ name, seatId:displayLabel, tableId:resolvedTableId, preAuth, preAuthAmount:parseInt(preAmt)||50, note });
            }}>
            Open tab →
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle = { display:'block', fontSize:11, fontWeight:700, color:'var(--t2)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 };

// ─── Main Bar Surface ─────────────────────────────────────────────────────────
export default function BarSurface() {
  const { tabs, activeTabId, setActiveTab, openTab, addRoundToTab, updateTabNote, updateTabStatus, setTabHold, closeTab, voidTabRound, seedTabs, showToast, eightySixIds, allergens, setPendingItem, clearPendingItem, pendingItem, menuCategories, quickScreenIds, menuItems: storeMenuItems, modifierGroupDefs, menus, deviceConfig, staff, recordWalkInClosedCheck } = useStore();

  const [showOpenModal, setShowOpenModal]   = useState(false);
  // v5.5.909: can this venue take a card hold at all? Ryft in-person cannot — pre-auth is
  // Stripe-Terminal-only. Resolved once here (the helper caches per location) so the modal
  // never flashes a toggle it is about to remove. Defaults TRUE and only ever goes false on a
  // DEFINITIVE 'ryft': getLocationProcessorInfo returns { processor:'stripe', definitive:false }
  // on any lookup blip, and a blip must never hide a working Stripe venue's pre-auth.
  const [canPreAuth, setCanPreAuth] = useState(true);
  useEffect(() => {
    let alive = true;
    getLocationProcessorInfo(getActiveLocationSync())
      .then(info => { if (alive) setCanPreAuth(!(info?.definitive && info.processor === 'ryft')); })
      .catch(() => { /* leave it enabled — fail open to today's Stripe behaviour */ });
    return () => { alive = false; };
  }, []);
  const [cat, setCat]                       = useState('all');
  const [search, setSearch]                 = useState('');
  const [roundItems, setRoundItems]         = useState([]);  // items being built for next round
  const [roundNote, setRoundNote]           = useState('');
  const [modalItem, setModalItem]           = useState(null);
  const [editingNote, setEditingNote]       = useState(false);
  const [noteVal, setNoteVal]               = useState('');
  const [voidConfirm, setVoidConfirm]       = useState(null); // { tabId, roundId, rNum }
  const [showTabFilter, setShowTabFilter]   = useState('active'); // active | all
  // v5.5.791: round panel follows adds — the just-added (or qty-merged) round
  // line is scrolled into view and flashed, same pattern as the POS order panel.
  // Diffed against the previous uid→qty map so unrelated re-renders never re-trigger.
  const roundListRef = useRef(null);
  const prevRoundLinesRef = useRef(null);   // Map<uid, qty> | null
  const prevRoundTabRef = useRef(null);
  const roundFlashTimerRef = useRef(null);
  const [flashRoundUid, setFlashRoundUid] = useState(null);

  useEffect(() => { if (tabs.length===0) seedTabs(); }, []);

  const activeTab = tabs.find(t=>t.id===activeTabId);
  const filteredTabs = tabs.filter(t=>showTabFilter==='active' ? t.status!=='closed' : true);

  // Determine active menu for this device
  const deviceMenuId = deviceConfig?.menuId;
  // v5.5.741: mirror the POS — a menu owns a category via menuCategories.menuId OR the
  // menu_category_links join table ("assign categories to a menu"). The bar previously only matched
  // menuId, so linked categories showed on the POS but never on the bar for the same device menu.
  // v5.7.18 - store links win; local fetch is a backstop that re-runs when
  // the location resolves (see POSSurface, same fix).
  const _storeLinks = useStore(s => s.categoryLinks);
  const _locIdForLinks = useStore(s => s.location?.id);
  const [_localLinks, _setLocalLinks] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const { data } = await fetchMenuCategoryLinks(); if (alive) _setLocalLinks(data || []); }
      catch (e) { console.warn('[BarSurface] fetchMenuCategoryLinks failed:', e?.message || e); }
    })();
    return () => { alive = false; };
  }, [_locIdForLinks]);
  const _categoryLinks = (_storeLinks && _storeLinks.length) ? _storeLinks : _localLinks;
  // v5.6.97: membership logic extracted to lib/menuMembership.js so the POS
  // grid and bar tabs share ONE mechanism (this inline filter was the original).
  const linkedCatIds = useMemo(() => linkedCategoryIdSet(_categoryLinks, deviceMenuId), [_categoryLinks, deviceMenuId]);
  const activeMenuCatIds = useMemo(
    () => allowedCategoryIds(menuCategories, deviceMenuId, _categoryLinks),
    [menuCategories, deviceMenuId, _categoryLinks]); // null means show all

  const ITEMS = (storeMenuItems || MENU_ITEMS).filter(i => {
    if (i.archived || i.parentId || i.parent_id || (i.type==='subitem'&&!i.soldAlone)) return false;
    return itemInAllowedCats(i, activeMenuCatIds);
  });
  const catMeta = (menuCategories||[]).find(c=>c.id===cat) || {color:'var(--acc)',icon:'🍸',label:'All'};
  const rawItems = useMemo(()=>{
    if (cat==='all') return ITEMS.filter(i=>!eightySixIds.includes(i.id));
    if (cat==='quick') return (quickScreenIds||[]).map(id=>ITEMS.find(i=>i.id===id)).filter(i=>i&&!eightySixIds.includes(i.id));
    return ITEMS.filter(i=>!eightySixIds.includes(i.id)&&(i.cat===cat||(i.cats||[]).includes(cat)));
  },[cat,ITEMS,eightySixIds]);
  const displayItems = useMemo(()=>{
    if (!search.trim()) return rawItems.sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
    const q=search.toLowerCase();
    return ITEMS.filter(i=>!eightySixIds.includes(i.id)&&((i.menuName||i.name||'').toLowerCase().includes(q)||i.description?.toLowerCase().includes(q)));
  },[cat,search,rawItems,ITEMS,eightySixIds]);

  const roundTotal = roundItems.reduce((s,i)=>s+i.price*i.qty,0);
  const roundCount = roundItems.reduce((s,i)=>s+i.qty,0);

  const addToRound = (item, mods=[], opts={}) => {
    // price: linePrice override → flat price → pricing.base → 0 (never NaN)
    const price = opts.linePrice!=null
      ? opts.linePrice/(opts.qty||1)
      : (item.price ?? item.pricing?.base ?? item.pricing?.dineIn ?? 0);
    // name: ALL possible name fields resolved in order
    const name = opts.displayName
      || item.menuName
      || item.menu_name
      || item.kitchenName
      || item.kitchen_name
      || item.receiptName
      || item.receipt_name
      || item.name
      || item.label
      || 'Item';

    setRoundItems(prev=>{
      // Same item+mods → increment qty
      const idx = prev.findIndex(r=>r.itemId===item.id && JSON.stringify(r.mods)===JSON.stringify(mods) && !opts.notes);
      if (idx>=0 && !opts.notes) return prev.map((r,i)=>i===idx?{...r,qty:r.qty+1}:r);
      // Triple-naming: carry explicit kitchen/receipt names onto the round line
      // (null when not set) — addRoundToTab's KDS tickets read kitchenName ||
      // name, receipts read receiptName || name.
      return [...prev, { uid:`r${Date.now()}`, itemId:item.id, name, kitchenName:kitchenOverride(item), receiptName:receiptOverride(item), price, qty:opts.qty||1, mods, notes:opts.notes||'', allergens:item.allergens||[] }];
    });
    showToast(`${name} added to round`,'success');
  };

  const removeFromRound = (uid) => setRoundItems(p=>p.filter(r=>r.uid!==uid));
  const updateRoundQty  = (uid,d) => setRoundItems(p=>p.map(r=>r.uid===uid?{...r,qty:Math.max(1,r.qty+d)}:r));

  // v5.5.791: detect a just-added round line (new uid) OR a qty merge onto an
  // existing line (addToRound increments qty for same item+mods), then scroll
  // it into view in the rounds panel + flash it.
  useEffect(() => {
    const key = activeTabId || null;
    const prev = prevRoundLinesRef.current;
    const sameTab = prevRoundTabRef.current === key && prev !== null;
    const next = new Map(roundItems.map(i => [i.uid, i.qty || 0]));
    prevRoundTabRef.current = key;
    prevRoundLinesRef.current = next;
    if (!sameTab) return;                       // first render / switched tab — baseline only
    let target = null;
    for (const it of roundItems) {
      if (!prev.has(it.uid)) target = it.uid;                      // new line appended
      else if ((it.qty || 0) > prev.get(it.uid)) target = it.uid;  // qty merged onto an existing line
    }
    if (!target) return;
    setFlashRoundUid(target);
    clearTimeout(roundFlashTimerRef.current);
    roundFlashTimerRef.current = setTimeout(() => setFlashRoundUid(null), 1000);
    // Effects run after the DOM commit, so the new line already exists — scroll
    // it into view directly (no rAF: it never fires on hidden/background tabs,
    // where smooth scrolling also stalls — jump instantly there instead).
    try {
      roundListRef.current?.querySelector(`[data-line-uid="${CSS.escape(target)}"]`)
        ?.scrollIntoView({ behavior: document.hidden ? 'auto' : 'smooth', block: 'nearest' });
    } catch { /* noop */ }
  }, [roundItems, activeTabId]);

  const handleItemTap = (item) => {
    if (eightySixIds.includes(item.id)) { showToast(`${item.name} is 86'd`,'error'); return; }
    if (!activeTab) { showToast('Select or open a tab first','error'); return; }
    if (allergens.some(a=>(item.allergens||[]).includes(a))) { setPendingItem(item); return; }
    openItemFlow(item);
  };

  const openItemFlow = (item) => {
    // Treat null/undefined type as simple — Supabase items may not have type set
    const isSimple = !item.type || item.type==='simple';
    if (isSimple) addToRound(item,[],{displayName: item.menuName||item.menu_name||item.name||item.kitchen_name||item.kitchenName});
    else setModalItem(item);
  };

  const fireRound = () => {
    if (!activeTab||!roundItems.length) return;
    const res = addRoundToTab(activeTab.id, roundItems, roundNote);
    if (res && res.ok === false) return;   // over the card hold — keep the round so staff can trim it or cash off
    setRoundItems([]);
    setRoundNote('');
    showToast(`Round ${activeTab.rounds.length+1} sent to bar`,'success');
  };

  // v5.5.324: tab opts awaiting a card pre-auth hold (reader collection step).
  const [pendingTabOpts, setPendingTabOpts] = useState(null);

  const doOpenTab = (opts) => {
    openTab(opts);
    setShowOpenModal(false);
    setPendingTabOpts(null);
    showToast(`${opts.name} tab opened`,'success');
  };

  const handleOpenTab = (opts) => {
    // v5.5.324: when pre-auth is on, collect a real card hold on the reader
    // BEFORE opening the tab. TabPreAuthTerminal handles the reader and the
    // no-reader fallback (open without a hold). Pre-auth off → open instantly.
    if (opts.preAuth) {
      setShowOpenModal(false);
      setPendingTabOpts(opts);
    } else {
      doOpenTab(opts);
    }
  };

  const [showTabCheckout, setShowTabCheckout] = useState(false);
  // v5.5.324: closing a tab that has a real card hold uses a CAPTURE flow (not
  // the fresh-tender checkout). These drive the held-card close modal.
  const [holdClose, setHoldClose] = useState(null);          // { tab } | null
  const [holdCloseState, setHoldCloseState] = useState('idle'); // idle | capturing | error
  const [holdCloseErr, setHoldCloseErr] = useState(null);

  // Build + record a bar-tab closed check. Shared by the fresh-tender checkout
  // AND the held-card capture so the row shape is identical either way.
  const recordTabClosedCheck = (tab, payInfo) => {
    const allItems = tab.rounds.flatMap(r => r.items.filter(i => !i.voided));
    const subtotal = tab.total || 0;
    recordWalkInClosedCheck({
      // v5.5.902: adopt CheckoutModal's pre-minted check id when it sent one — it is the
      // id the gift-card debit was keyed to, so a later refund can find the ledger row.
      // (The held-card capture path at line ~461 sends none and keeps the store's chk-<ts>.)
      ...(payInfo?.closedCheckId ? { id: payInfo.closedCheckId } : {}),
      ref: 'TAB-' + getNextOrderRefLocal().slice(1),  // 'TAB-' + numeric portion of R<n>
      server: staff?.name || 'Staff',
      covers: 1,
      orderType: 'bar-tab',
      customer: { name: tab.name },
      items: allItems,
      discounts: [],
      subtotal,
      service: 0,
      tip: payInfo?.tip || 0,
      total: payInfo?.grand != null ? payInfo.grand : subtotal,
      method: payInfo?.method || 'card',
      // v5.5.902: giftRecordFrom also folds in the per-portion legs of a SPLIT bar tab,
      // which used to be dropped here entirely (nothing to reverse on a refund).
      giftCard: giftRecordFrom(payInfo || {}),
      // v5.5.808: stamp WHICH processor took the card + the card-scheme receipt
      // block. Without these a Ryft bar-tab payment recorded processor 'stripe',
      // so a later refund routed to Stripe with a ps_ id and silently failed —
      // and the UK card receipt block never printed on bar-tab receipts.
      processor: payInfo?.processor || 'stripe',
      cardReceipt: payInfo?.cardReceipt || null,
      // v5.5.323: carry the card PaymentIntent so a refund returns funds to the
      // original card automatically (bar tabs previously stored none).
      stripePaymentIntentId: payInfo?.stripePaymentIntentId || null,
      paymentIntents: payInfo?.paymentIntents
        || (payInfo?.stripePaymentIntentId
            ? [{ id: payInfo.stripePaymentIntentId, amountMinor: Math.round((payInfo?.grand || subtotal || 0) * 100) }]
            : null),
    });
    closeTab(tab.id);
    setActiveTab(null);
  };

  // v5.5.324: release a card hold (cancel the manual-capture PI) — used when a
  // held tab is voided or the customer chooses to pay another way.
  // Adyen holds ride adyen-terminal-charge's hold_* actions (device-fenced).
  const adyenHoldCall = async (action, tab, amountMinor = null) => {
    // v5.6.94 — demo reader window (cosmetic): DEMO-HOLD- references are only
    // ever minted by the server's simulated-hold branch, so this can never
    // fire for a real hold. Fire-and-forget; the server succeeds whether or
    // not a ?mode=readerdemo window is open on this machine.
    if (String(tab.preAuthPaymentIntentId || '').startsWith('DEMO-HOLD-')) {
      try {
        const ch = new BroadcastChannel('rpos-demo-reader');
        ch.postMessage({ kind: action, amountMinor });
        ch.close();
      } catch { /* unsupported browser — cosmetic only */ }
    }
    const token = await ensureAuthToken();
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/adyen-terminal-charge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action, psp_reference: tab.preAuthPaymentIntentId,
        location_id: getActiveLocationSync(),
        ...(amountMinor != null ? { amount_minor: amountMinor } : {}),
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  };

  const releaseHold = async (tab) => {
    if (!tab?.preAuthPaymentIntentId) return;
    if (tab.preAuthProcessor === 'adyen') {
      try { await adyenHoldCall('hold_release', tab); }
      catch (e) { console.warn('[bar-tab] adyen release failed:', e?.message); }
      return;
    }
    try {
      const token = await ensureAuthToken();
      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-cancel-reader-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ payment_intent_id: tab.preAuthPaymentIntentId, location_id: getActiveLocationSync() }),
      });
    } catch (e) { console.warn('[bar-tab] release hold failed:', e?.message); }
  };

  // v5.5.614: STEP UP a card hold — raise the pre-auth ceiling on the existing PI (Stripe
  // incremental authorization; no re-tap). Lets a tab keep one running bill past its original
  // hold. Falls back to the lock ("take payment / new tab") where the card doesn't support it.
  const [holdBusy, setHoldBusy] = useState(false);
  const increaseHold = async (tab) => {
    if (!tab?.preAuthPaymentIntentId || holdBusy) return;
    const cap = (tab.preAuthHeldMinor != null ? tab.preAuthHeldMinor / 100 : tab.preAuthAmount) || 0;
    const suggested = Math.max(Math.ceil((tab.total || 0) + 20), Math.ceil(cap + 10));
    const input = window.prompt(`Increase the card hold (currently ${money(cap)}).\nNew hold amount:`, String(suggested));
    if (input == null) return;
    const newAmt = parseFloat(String(input).replace(/[^0-9.]/g, ''));
    if (!(newAmt > cap)) { showToast(`New hold must be more than ${money(cap)}`, 'error'); return; }
    setHoldBusy(true);
    try {
      const token = await ensureAuthToken();
      if (tab.preAuthProcessor === 'adyen') {
        await adyenHoldCall('hold_increase', tab, Math.round(newAmt * 100));
        setTabHold(tab.id, Math.round(newAmt * 100));
        showToast(`Hold raised to ${money(newAmt)}`, 'success');
        setHoldBusy(false);
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-increment-authorization`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ payment_intent_id: tab.preAuthPaymentIntentId, location_id: getActiveLocationSync(), amount_minor: Math.round(newAmt * 100) }),
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok && j.amount_minor) {
        setTabHold(tab.id, j.amount_minor);
        showToast(`Card hold increased to ${money(j.amount_minor / 100)}`, 'success');
      } else {
        showToast(`Couldn't increase the hold on this card — take payment to close, or open a new tab.`, 'error');
      }
    } catch (e) {
      showToast('Could not reach the card processor — try again.', 'error');
    } finally { setHoldBusy(false); }
  };

  // v5.5.324: capture the held card for (up to) the running total, then close.
  const captureHeldTab = async (tab) => {
    const totalMinor = Math.round((tab.total || 0) * 100);
    const heldMinor = tab.preAuthHeldMinor != null ? tab.preAuthHeldMinor : Math.round((tab.preAuthAmount || 0) * 100);
    const captureMinor = Math.min(totalMinor, heldMinor || totalMinor);
    if (captureMinor <= 0) { setHoldCloseErr('Nothing to charge'); setHoldCloseState('error'); return; }
    setHoldCloseState('capturing'); setHoldCloseErr(null);
    try {
      let capturedMinor;
      if (isTrainingMode()) {
        // TRAINING MODE: never capture a real pre-auth. Simulate a full capture so
        // the tab closes in-memory (the closed_check itself is gated in db.js).
        capturedMinor = captureMinor;
      } else if (tab.preAuthProcessor === 'adyen') {
        await adyenHoldCall('hold_capture', tab, captureMinor);
        capturedMinor = captureMinor;
      } else {
        // /api/stripe-capture is the same Vercel endpoint the QR tab flow uses;
        // it clamps to the actual amount_capturable on the connected account.
        const res = await fetch('/api/stripe-capture', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            paymentIntentId: tab.preAuthPaymentIntentId,
            stripeAccount: tab.preAuthStripeAccount,
            amountToCapture: captureMinor,
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
        capturedMinor = Number.isFinite(j.amount) ? j.amount : captureMinor;
      }
      recordTabClosedCheck(tab, {
        method: 'card',
        grand: tab.total || 0,
        // v5.6.94: stamp WHICH processor held the card (v5.5.808's rule — the
        // refund routes by this). An Adyen-held tab recorded processor
        // 'stripe', so a refund would route to Stripe with an Adyen psp
        // reference. Demo tabs record 'adyen' with their DEMO-HOLD- reference,
        // auditable the same way demo sales carry a DEMO- transaction id.
        processor: tab.preAuthProcessor || 'stripe',
        stripePaymentIntentId: tab.preAuthPaymentIntentId,
        paymentIntents: [{ id: tab.preAuthPaymentIntentId, amountMinor: capturedMinor }],
      });
      setHoldClose(null); setHoldCloseState('idle');
      const shortfallMinor = totalMinor - capturedMinor;
      if (shortfallMinor > 0) {
        showToast(`Charged ${money((capturedMinor/100))} to held card — ${money((shortfallMinor/100))} still to collect (hold didn't cover the bill)`, 'warning');
      } else {
        showToast(`${tab.name}'s tab charged ${money((capturedMinor/100))} to held card`, 'success');
      }
    } catch (e) {
      setHoldCloseErr(e?.message || 'Capture failed'); setHoldCloseState('error');
    }
  };

  const handleCloseTab = (tab) => {
    if (tab.total === 0) {
      // Zero bill — release any hold so the customer isn't left holding it.
      if (tab.preAuthPaymentIntentId) releaseHold(tab);
      closeTab(tab.id);
      showToast(`${tab.name}'s tab closed`, 'info');
      return;
    }
    // Real card hold present → capture flow. Otherwise the fresh-tender checkout.
    if (tab.preAuthPaymentIntentId) { setHoldClose({ tab }); setHoldCloseState('idle'); setHoldCloseErr(null); return; }
    setShowTabCheckout(true);
  };

  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden', minWidth:0 }}>

      {/* ══ TABS LIST (LEFT) ═════════════════════════════════════════ */}
      <div style={{ width:260, flexShrink:0, display:'flex', flexDirection:'column', background:'var(--bg1)', borderRight:'1px solid var(--bdr2)', overflow:'hidden' }}>

        {/* Header */}
        <div style={{ padding:'14px 12px 10px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>Bar tabs</div>
            <button onClick={()=>setShowOpenModal(true)} style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0e0f14', fontSize:12, fontWeight:700 }}>+ New</button>
          </div>
          <div style={{ display:'flex', gap:4 }}>
            {[['active','Active'],['all','All']].map(([f,l])=>(
              <button key={f} onClick={()=>setShowTabFilter(f)} style={{ flex:1, padding:'4px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', border:`1px solid ${showTabFilter===f?'var(--acc-b)':'var(--bdr)'}`, background:showTabFilter===f?'var(--acc-d)':'transparent', color:showTabFilter===f?'var(--acc)':'var(--t3)', fontSize:11, fontWeight:700 }}>{l}</button>
            ))}
          </div>
        </div>

        {/* Tab cards */}
        <div style={{ flex:1, overflowY:'auto', padding:'8px 10px' }}>
          {filteredTabs.length===0&&(
            <div style={{ textAlign:'center', padding:'40px 0', color:'var(--t3)' }}>
              <div style={{ fontSize:32, marginBottom:8 }}>🍸</div>
              <div style={{ fontSize:13, fontWeight:600, color:'var(--t2)', marginBottom:4 }}>No open tabs</div>
              <div style={{ fontSize:12 }}>Tap + New to open a tab</div>
            </div>
          )}
          {filteredTabs.map(tab=>{
            const sm=STATUS_META[tab.status]||STATUS_META.open;
            const isActive=activeTabId===tab.id;
            return (
              <div key={tab.id} onClick={()=>setActiveTab(tab.id)} style={{
                padding:'12px 12px', borderRadius:12, marginBottom:8, cursor:'pointer',
                background:isActive?'var(--bg3)':'var(--bg2)',
                border:`1.5px solid ${isActive?'var(--acc-b)':'var(--bdr)'}`,
                transition:'all .12s',
              }}>
                <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
                  <div style={{ width:36,height:36, borderRadius:'50%', background:sm.bg, border:`2px solid ${sm.color}44`, display:'flex',alignItems:'center',justifyContent:'center', fontSize:12,fontWeight:800,color:sm.color, flexShrink:0 }}>
                    {tab.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}
                  </div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:13,fontWeight:700,color:'var(--t1)',marginBottom:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{tab.name}</div>
                    <div style={{ fontSize:11,color:'var(--t3)', display:'flex', gap:8 }}>
                      <span>{tab.seatId||'Roaming'}</span>
                      <span>·</span>
                      <span>{timeOpen(tab.openedAt)}</span>
                      <span>·</span>
                      <span>{tab.rounds.length} round{tab.rounds.length!==1?'s':''}</span>
                    </div>
                    {tab.note&&<div style={{ fontSize:10,color:'#f97316',marginTop:3,fontStyle:'italic',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>📝 {tab.note}</div>}
                  </div>
                </div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:8 }}>
                  <span style={{ fontSize:11,fontWeight:700,padding:'2px 7px',borderRadius:20,background:sm.bg,color:sm.color }}>{sm.label}</span>
                  <span style={{ fontSize:15,fontWeight:800,color:'var(--acc)',fontFamily:'DM Mono,monospace' }}>{money((tab.total||0))}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ══ ACTIVE TAB (CENTRE) ════════════════════════════════════════ */}
      <div style={{ width:320, flexShrink:0, display:'flex', flexDirection:'column', background:'var(--bg1)', borderRight:'1px solid var(--bdr2)', overflow:'hidden' }}>

        {!activeTab ? (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'var(--t3)', padding:24 }}>
            <div style={{ fontSize:40,marginBottom:12,opacity:.4 }}>🍺</div>
            <div style={{ fontSize:14,fontWeight:600,color:'var(--t2)',marginBottom:6 }}>Select a tab</div>
            <div style={{ fontSize:12,textAlign:'center',lineHeight:1.6 }}>Tap a tab from the list, or open a new one to start ordering</div>
            <button onClick={()=>setShowOpenModal(true)} className="btn btn-acc" style={{ marginTop:20, height:42 }}>Open new tab</button>
          </div>
        ) : (
          <>
            {/* Tab header */}
            <div style={{ padding:'14px 14px 10px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
              <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
                <div>
                  <div style={{ fontSize:15,fontWeight:700,color:'var(--t1)' }}>{activeTab.name}</div>
                  <div style={{ fontSize:11,color:'var(--t3)',marginTop:2, display:'flex',gap:8 }}>
                    <span>{activeTab.ref}</span>
                    <span>·</span>
                    <span>{activeTab.seatId||'Roaming'}</span>
                    <span>·</span>
                    <span>Opened by {activeTab.openedBy}</span>
                    <span>·</span>
                    <span>{timeOpen(activeTab.openedAt)} ago</span>
                  </div>
                  <div style={{ display:'flex',gap:6,marginTop:6,flexWrap:'wrap' }}>
                    {(() => {const sm=STATUS_META[activeTab.status]; return <span style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:20,background:sm.bg,color:sm.color}}>{sm.label}</span>;})()}
                    {/* v5.5.324: badge only when a REAL hold exists on the card,
                        not merely the "pre-auth" intent toggle (which previously
                        showed a hold that was never actually placed). */}
                    {activeTab.preAuthPaymentIntentId&&<span style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:20,background:'var(--blu-d)',color:'var(--blu)',border:'1px solid var(--blu-b)'}}>💳 Held {currencySymbol()}{(((activeTab.preAuthHeldMinor!=null?activeTab.preAuthHeldMinor/100:activeTab.preAuthAmount))||0).toFixed(0)}</span>}
                    {activeTab.preAuthPaymentIntentId&&(()=>{ const cap=(activeTab.preAuthHeldMinor!=null?activeTab.preAuthHeldMinor/100:activeTab.preAuthAmount)||0; if(cap<=0) return null; const left=cap-(activeTab.total||0); const t = left<=0 ? {bg:'var(--red-d)',c:'var(--red)',b:'var(--red-b)'} : left<=cap*0.2 ? {bg:'var(--acc-d)',c:'var(--orn)',b:'var(--bdr2)'} : {bg:'var(--grn-d)',c:'var(--grn)',b:'var(--grn-b)'}; return <span style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:20,background:t.bg,color:t.c,border:`1px solid ${t.b}`}}>{left<=0?'Hold full':`${money(left)} left`}</span>; })()}
                    {activeTab.preAuthPaymentIntentId&&<button onClick={()=>increaseHold(activeTab)} disabled={holdBusy} title="Raise the card hold (incremental authorization — keeps one running bill)" style={{fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:20,background:'var(--bg3)',color:'var(--t1)',border:'1px solid var(--bdr)',cursor:'pointer',fontFamily:'inherit',opacity:holdBusy?0.6:1}}>{holdBusy?'…':'＋ Increase hold'}</button>}
                    {activeTab.tableId&&<span style={{fontSize:10,fontWeight:700,padding:'2px 7px',borderRadius:20,background:'var(--bg3)',color:'var(--t2)'}}>Table linked</span>}
                  </div>
                </div>
                <div style={{ marginLeft:'auto',textAlign:'right',flexShrink:0 }}>
                  <div style={{ fontSize:20,fontWeight:800,color:'var(--acc)',fontFamily:'DM Mono,monospace' }}>{money((activeTab.total||0))}</div>
                  <div style={{ fontSize:11,color:'var(--t3)' }}>{activeTab.rounds.reduce((s,r)=>s+r.items.reduce((s2,i)=>s2+i.qty,0),0)} items · {activeTab.rounds.length} rounds</div>
                </div>
              </div>

              {/* Tab note */}
              {editingNote ? (
                <div style={{ marginTop:10 }}>
                  <textarea value={noteVal} onChange={e=>setNoteVal(e.target.value)} rows={2} placeholder="Tab note..." style={{ width:'100%',background:'var(--bg3)',border:'1px solid var(--acc-b)',borderRadius:8,padding:'7px 10px',color:'var(--t1)',fontSize:12,fontFamily:'inherit',resize:'none',outline:'none' }}/>
                  <div style={{ display:'flex',gap:6,marginTop:5 }}>
                    <button onClick={()=>{updateTabNote(activeTab.id,noteVal);setEditingNote(false);showToast('Note saved','success');}} style={{ flex:1,padding:'5px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',background:'var(--acc)',border:'none',color:'#0e0f14',fontSize:12,fontWeight:700 }}>Save</button>
                    <button onClick={()=>{setEditingNote(false);setNoteVal(activeTab.note);}} style={{ flex:1,padding:'5px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr)',color:'var(--t2)',fontSize:12 }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div onClick={()=>{setEditingNote(true);setNoteVal(activeTab.note);}} style={{ marginTop:8,padding:'6px 10px',borderRadius:8,cursor:'pointer',background:'var(--bg3)',border:'1px dashed var(--bdr2)',fontSize:12, display:'flex',alignItems:'center',gap:6 }}>
                  {activeTab.note ? <span style={{color:'#f97316'}}>📝 {activeTab.note}</span> : <span style={{color:'var(--t4)'}}>Add tab note...</span>}
                </div>
              )}
            </div>

            {/* Rounds history */}
            <div ref={roundListRef} style={{ flex:1, overflowY:'auto', padding:'10px 12px' }}>
              {activeTab.rounds.length===0&&roundItems.length===0&&(
                <div style={{ textAlign:'center',padding:'30px 0',color:'var(--t3)' }}>
                  <div style={{ fontSize:28,marginBottom:8,opacity:.5 }}>🍹</div>
                  <div style={{ fontSize:12 }}>No rounds yet — pick items from the menu →</div>
                </div>
              )}

              {/* Current round being built */}
              {roundItems.length>0&&(
                <div style={{ marginBottom:14, background:'rgba(232,160,32,.06)', border:'1px solid var(--acc-b)', borderRadius:12, overflow:'hidden' }}>
                  <div style={{ padding:'8px 12px', borderBottom:'1px solid var(--acc-b)', display:'flex',alignItems:'center',justifyContent:'space-between' }}>
                    <span style={{ fontSize:11,fontWeight:700,color:'var(--acc)',textTransform:'uppercase',letterSpacing:'.06em' }}>
                      🔥 Round {activeTab.rounds.length+1} — building
                    </span>
                    <span style={{ fontSize:13,fontWeight:700,color:'var(--acc)',fontFamily:'DM Mono,monospace' }}>{money(roundTotal)}</span>
                  </div>
                  <div style={{ padding:'8px 12px' }}>
                    {roundItems.map(item=>(
                      <RoundItem key={item.uid} item={item} flash={flashRoundUid===item.uid}
                        onQty={d=>updateRoundQty(item.uid,d)}
                        onRemove={()=>removeFromRound(item.uid)}/>
                    ))}
                    <div style={{ marginTop:8 }}>
                      <input value={roundNote} onChange={e=>setRoundNote(e.target.value)} placeholder="Round note (e.g. extra ice on the Negroni)..." style={{ width:'100%',background:'var(--bg3)',border:'1px solid var(--bdr2)',borderRadius:8,padding:'7px 10px',color:'var(--t1)',fontSize:12,fontFamily:'inherit',outline:'none' }}/>
                    </div>
                  </div>
                </div>
              )}

              {/* Past rounds (newest first) */}
              {[...activeTab.rounds].reverse().map((round,idx)=>{
                const rNum = activeTab.rounds.length-idx;
                return (
                  <div key={round.id} style={{ marginBottom:10, background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden' }}>
                    <div style={{ padding:'7px 12px', borderBottom:'1px solid var(--bdr)', display:'flex',alignItems:'center',justifyContent:'space-between',background:'var(--bg3)' }}>
                      <div style={{ fontSize:11,fontWeight:700,color:'var(--t2)' }}>
                        Round {rNum} · {new Date(round.sentAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}
                      </div>
                      <div style={{ display:'flex',alignItems:'center',gap:8 }}>
                        <span style={{ fontSize:13,fontWeight:700,color:'var(--t2)',fontFamily:'DM Mono,monospace' }}>{money((round.subtotal||0))}</span>
                        <button onClick={()=>setVoidConfirm({ tabId:activeTab.id, roundId:round.id, rNum })} style={{ fontSize:10,color:'var(--red)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit',padding:0 }}>Void</button>
                      </div>
                    </div>
                    <div style={{ padding:'8px 12px' }}>
                      {round.items.map((item,i)=>(
                        <div key={i} style={{ display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:3 }}>
                          <div>
                            <span style={{ color:'var(--t2)' }}>{item.qty}× {item.menuName||item.menu_name||item.name||'Item'}</span>
                            {item.mods?.length>0&&<span style={{ color:'var(--t3)',marginLeft:5 }}>({item.mods.map(m=>m.label).join(', ')})</span>}
                            {item.notes&&<span style={{ color:'#f97316',marginLeft:5,fontStyle:'italic' }}>· {item.notes}</span>}
                          </div>
                          <span style={{ color:'var(--t3)',fontFamily:'DM Mono,monospace' }}>{money(((item.price||0)*(item.qty||1)))}</span>
                        </div>
                      ))}
                      {round.note&&<div style={{ fontSize:11,color:'#f97316',marginTop:4,fontStyle:'italic' }}>📝 {round.note}</div>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer actions */}
            <div style={{ padding:'10px 12px', borderTop:'1px solid var(--bdr)', background:'var(--bg2)', flexShrink:0 }}>
              <div style={{ display:'flex',justifyContent:'space-between',fontSize:12,color:'var(--t3)',marginBottom:2 }}>
                <span>{activeTab.rounds.length} rounds · {activeTab.rounds.reduce((s,r)=>s+r.items.reduce((s2,i)=>s2+i.qty,0),0)} items</span>
                <span style={{ fontFamily:'DM Mono,monospace' }}>{activeTab.rounds.length>0?`Avg round ${money(((activeTab.total||0)/(activeTab.rounds.length||1)))}`:'No rounds yet'}</span>
              </div>
              <div style={{ display:'flex',justifyContent:'space-between',fontSize:19,fontWeight:800,marginBottom:10,paddingTop:8,borderTop:'1px solid var(--bdr3)' }}>
                <span>Total</span>
                <span style={{ color:'var(--acc)',fontFamily:'DM Mono,monospace' }}>{money(((activeTab.total||0)+roundTotal))}</span>
              </div>
              <div style={{ display:'flex',gap:6 }}>
                {roundItems.length>0 && (
                  <button onClick={fireRound} style={{ flex:2,height:38,borderRadius:10,cursor:'pointer',fontFamily:'inherit',background:'var(--acc)',border:'none',color:'#0e0f14',fontSize:13,fontWeight:700 }}>
                    🔥 Send round {activeTab.rounds.length+1} · {money(roundTotal)}
                  </button>
                )}
                {activeTab.status!=='closed' && activeTab.total > 0 && (
                  <button onClick={()=>handleCloseTab(activeTab)} style={{ flex:roundItems.length>0?1:2,height:38,borderRadius:10,cursor:'pointer',fontFamily:'inherit',background:'var(--red-d)',border:'1px solid var(--red-b)',color:'var(--red)',fontSize:13,fontWeight:700 }}>
                    {roundItems.length>0 ? 'Pay' : `Close tab · ${money((activeTab.total||0))}`}
                  </button>
                )}
                <button onClick={()=>setActiveTab(null)} style={{ width:38,height:38,borderRadius:10,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr2)',color:'var(--t3)',fontSize:18 }}>←</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ══ PRODUCT GRID (RIGHT) ══════════════════════════════════════ */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        {/* Category pills + search */}
        <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
          <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8 }}>
            <div style={{ position:'relative', flex:1 }}>
              <span style={{ position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',color:'var(--t3)',fontSize:13 }}>🔍</span>
              <input className="input" placeholder="Search drinks & food…" value={search} onChange={e=>setSearch(e.target.value)} style={{ paddingLeft:32,height:34,fontSize:12 }}/>
              {search&&<button onClick={()=>setSearch('')} style={{ position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:'var(--t3)',cursor:'pointer',fontSize:15 }}>×</button>}
            </div>
            {!activeTab&&<button onClick={()=>setShowOpenModal(true)} className="btn btn-acc btn-sm">+ New tab</button>}
          </div>
          <div style={{ display:'flex',gap:4,overflowX:'auto',paddingBottom:2 }}>
            {[{id:'all',label:'All',icon:'🍽',color:'var(--acc)'},...(menuCategories||[]).filter(c=>!c.parentId&&!c.parent_id&&!c.isSpecial&&categoryVisibleInMenu(c,deviceMenuId,linkedCatIds)).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0))].map(c=>{
              const color = c.color||'var(--acc)';
              const isActive=cat===c.id&&!search;
              return(
                <button key={c.id} onClick={()=>{setCat(c.id);setSearch('');}} style={{
                  padding:'4px 11px',borderRadius:20,fontSize:11,fontWeight:600,
                  whiteSpace:'nowrap',cursor:'pointer',border:`1px solid ${isActive?color+'88':'var(--bdr)'}`,
                  background:isActive?(color+'18'):'transparent',
                  color:isActive?color:'var(--t3)',fontFamily:'inherit',
                }}>{c.icon} {c.label}</button>
              );
            })}
          </div>
        </div>

        {/* Items */}
        <div style={{ flex:1, overflowY:'auto', padding:12 }}>
          {!activeTab&&(
            <div style={{ margin:'0 0 14px', padding:'12px 16px', background:'rgba(232,160,32,.08)', border:'1px solid var(--acc-b)', borderRadius:12, fontSize:13, color:'var(--acc)' }}>
              Select a tab or open a new one to start adding items
            </div>
          )}
          <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))',gap:8 }}>
            {displayItems.map(item=>{
              const storeCat = (menuCategories||[]).find(c=>c.id===item.cat); const m={color:storeCat?.color||'var(--acc)',icon:storeCat?.icon||'🍸'};
              const is86=eightySixIds.includes(item.id);
              const variantKids = (storeMenuItems||MENU_ITEMS).filter(i => (i.parentId || i.parent_id) === item.id && !i.archived);
              const fromPrice=item.type==='variants'&&variantKids.length?Math.min(...variantKids.map(v=>v.pricing?.base??v.price??0)):(item.pricing?.base??item.price??0);
              const inRound=roundItems.filter(r=>r.itemId===item.id).reduce((s,r)=>s+r.qty,0);
              return(
                <button key={item.id} onClick={()=>handleItemTap(item)} style={{
                  display:'flex',flexDirection:'column',padding:0,overflow:'hidden',
                  background:is86?'var(--bg3)':'var(--bg2)',
                  border:`1px solid ${is86?'var(--bdr)':inRound?m.color+'66':'var(--bdr)'}`,
                  borderRadius:11,cursor:is86?'not-allowed':'pointer',
                  opacity:is86?.4:1,fontFamily:'inherit',position:'relative',
                }}>
                  {inRound>0&&<div style={{ position:'absolute',top:6,right:6,width:18,height:18,borderRadius:'50%',background:m.color,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:800,color:'#fff',zIndex:1 }}>{inRound}</div>}
                  <div style={{ height:3,background:is86?'var(--bg5)':m.color+'66',width:'100%' }}/>
                  <div style={{ padding:'10px 10px 9px',flex:1,display:'flex',flexDirection:'column' }}>
                    <div style={{ fontSize:20,marginBottom:6 }}>{m.icon}</div>
                    <div style={{ fontSize:12,fontWeight:700,color:'var(--t1)',lineHeight:1.3,marginBottom:3,flex:1 }}>{item.menuName||item.menu_name||item.name||'Item'}</div>
                    {item.description&&<div style={{ fontSize:10,color:'var(--t3)',lineHeight:1.3,marginBottom:4,display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden' }}>{item.description}</div>}
                    <div style={{ fontSize:14,fontWeight:800,color:m.color,fontFamily:'DM Mono,monospace',marginTop:'auto' }}>
                      {item.type==='variants'?`from ${money((fromPrice||0))}`:`${money((fromPrice||0))}`}
                    </div>
                    {item.type!=='simple'&&<div style={{ fontSize:9,color:'var(--t3)',marginTop:2 }}>{item.type==='variants'?'▼ sizes':item.type==='modifiers'?'⊕ options':'🍕 build'}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showOpenModal&&<OpenTabModal onConfirm={handleOpenTab} onCancel={()=>setShowOpenModal(false)} canPreAuth={canPreAuth}/>}
      {/* v5.5.324: card pre-auth hold collected on the reader before the tab opens */}
      {pendingTabOpts&&(
        <TabPreAuthTerminal
          amountMinor={Math.round((pendingTabOpts.preAuthAmount||50)*100)}
          guestName={pendingTabOpts.name}
          onAuthorized={({ paymentIntentId, stripeAccount, heldMinor, processor })=>doOpenTab({ ...pendingTabOpts, preAuthPaymentIntentId:paymentIntentId, preAuthStripeAccount:stripeAccount, preAuthHeldMinor:heldMinor, preAuthProcessor:processor||'stripe' })}
          onSkip={()=>doOpenTab(pendingTabOpts)}
          onCancel={()=>setPendingTabOpts(null)}
        />
      )}
      {pendingItem&&<AllergenModal item={pendingItem} activeAllergens={allergens} onConfirm={()=>{const i=pendingItem;clearPendingItem();openItemFlow(i);}} onCancel={clearPendingItem}/>}
      {modalItem&&(
        <div className="modal-back">
          <div style={{ background:'var(--bg2)',border:'1px solid var(--bdr2)',borderRadius:20,width:'100%',maxWidth:460,maxHeight:'88vh',overflow:'auto',boxShadow:'var(--sh3)' }}>
            {modalItem.type==='pizza' ? (
              <ProductModal key={modalItem.id} item={modalItem} activeAllergens={allergens}
                onConfirm={(item,mods,cfg,opts)=>{ addToRound(item,mods,opts); setModalItem(null); }}
                onCancel={()=>setModalItem(null)} />
            ) : (
              <InlineItemFlow key={modalItem.id} item={modalItem} menuItems={storeMenuItems||MENU_ITEMS} activeAllergens={allergens}
                onConfirm={(item,mods,cfg,opts)=>{ addToRound(item,mods,opts); setModalItem(null); showToast(`${opts?.displayName||item.menuName||item.menu_name||item.name} added`,'success'); }}
                onCancel={()=>setModalItem(null)} />
            )}
          </div>
        </div>
      )}

      {/* Tab checkout */}
      {showTabCheckout && activeTab && (() => {
        const allItems = activeTab.rounds.flatMap(r => r.items);
        const subtotal = activeTab.total;
        return (
          <CheckoutModal
            items={allItems}
            subtotal={subtotal}
            service={0}
            total={subtotal}
            orderType="bar-tab"
            covers={1}
            tableId={activeTab.tableId}
            tabName={activeTab.name}
            onClose={() => setShowTabCheckout(false)}
            onComplete={(payInfo) => {
              setShowTabCheckout(false);
              // v5.5.324: shared builder records the row identically to the
              // held-card capture path (incl. the card PI for auto-refunds).
              recordTabClosedCheck(activeTab, payInfo);
              showToast(`${activeTab.name}'s tab paid and closed`, 'success');
            }}
          />
        );
      })()}

      {/* v5.5.324: held-card close — capture the pre-auth instead of re-tendering */}
      {holdClose?.tab && (() => {
        const tab = holdClose.tab;
        const totalMinor = Math.round((tab.total || 0) * 100);
        const heldMinor = tab.preAuthHeldMinor != null ? tab.preAuthHeldMinor : Math.round((tab.preAuthAmount || 0) * 100);
        const captureMinor = Math.min(totalMinor, heldMinor || totalMinor);
        const shortfall = totalMinor - captureMinor;
        const gbp = (m) => `${money((m / 100))}`;
        const row = (label, value, bold) => (
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'3px 0', fontSize:13, color: bold ? 'var(--t1)' : 'var(--t3)', fontWeight: bold ? 800 : 500 }}>
            <span>{label}</span><span style={{ fontFamily:'DM Mono,monospace' }}>{value}</span>
          </div>
        );
        const busy = holdCloseState === 'capturing';
        return (
          <div className="modal-back" onClick={e => !busy && e.target === e.currentTarget && (setHoldClose(null), setHoldCloseState('idle'))}>
            <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:20, width:'100%', maxWidth:380, padding:24, boxShadow:'var(--sh3)' }}>
              <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>Close {tab.name}'s tab</div>
              <div style={{ fontSize:12, color:'var(--t3)', marginBottom:16 }}>Card was held when the tab opened — capture the bill to that card.</div>
              <div style={{ background:'var(--bg3)', borderRadius:12, padding:'10px 14px', marginBottom:16 }}>
                {row('Bill total', gbp(totalMinor))}
                {row('Held on card', gbp(heldMinor))}
                {row('Will charge now', gbp(captureMinor), true)}
                {shortfall > 0 && <div style={{ fontSize:11, color:'#e8a020', marginTop:8, lineHeight:1.4 }}>⚠ Bill is {gbp(shortfall)} over the hold — Stripe can only capture the held amount. Collect the {gbp(shortfall)} difference separately after closing.</div>}
              </div>
              {holdCloseState === 'error' && <div style={{ fontSize:12, color:'var(--red)', marginBottom:12 }}>{holdCloseErr}</div>}
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <button className="btn btn-acc btn-full" disabled={busy} onClick={() => captureHeldTab(tab)}>
                  {busy ? 'Charging…' : `🔒 Charge ${gbp(captureMinor)} to held card`}
                </button>
                <button className="btn btn-ghost btn-full" disabled={busy} onClick={async () => { await releaseHold(tab); setHoldClose(null); setHoldCloseState('idle'); setShowTabCheckout(true); }}>
                  Pay another way (release hold)
                </button>
                <button className="btn btn-ghost btn-full" disabled={busy} onClick={() => { setHoldClose(null); setHoldCloseState('idle'); }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Void round confirmation */}
      {voidConfirm && (
        <div className="modal-back" onClick={e=>e.target===e.currentTarget&&setVoidConfirm(null)}>
          <div style={{ background:'var(--bg2)', border:'1px solid var(--red-b)', borderRadius:20, width:'100%', maxWidth:360, padding:24, boxShadow:'var(--sh3)' }}>
            <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)', marginBottom:8 }}>Void round {voidConfirm.rNum}?</div>
            <div style={{ fontSize:13, color:'var(--t3)', marginBottom:20, lineHeight:1.5 }}>
              This will void the entire round and remove it from the tab total. This action cannot be undone.
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button className="btn btn-ghost" style={{ flex:1 }} onClick={()=>setVoidConfirm(null)}>Cancel</button>
              <button className="btn btn-red" style={{ flex:1, height:42 }} onClick={()=>{
                voidTabRound(voidConfirm.tabId, voidConfirm.roundId);
                showToast(`Round ${voidConfirm.rNum} voided`, 'warning');
                setVoidConfirm(null);
              }}>Void round</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Round Item Row ──────────────────────────────────────────────────────────
function RoundItem({ item, onQty, onRemove, flash=false }) {
  const [editNote, setEditNote] = useState(false);
  const [note, setNote] = useState(item.notes||'');
  return (
    <div data-line-uid={item.uid} className={flash?'line-flash':undefined} style={{ marginBottom:6, paddingBottom:6, borderBottom:'1px solid rgba(232,160,32,.15)' }}>
      <div style={{ display:'flex',alignItems:'flex-start',gap:8 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:12,fontWeight:600,color:'var(--t1)' }}>{item.menuName||item.menu_name||item.name||'Item'}</div>
          {item.mods?.length>0&&<div style={{ fontSize:10,color:'var(--t3)' }}>{item.mods.map(m=>m.label).join(', ')}</div>}
          {item.notes&&!editNote&&<div style={{ fontSize:10,color:'#f97316',fontStyle:'italic' }}>📝 {item.notes}</div>}
          {editNote&&(
            <input value={note} onChange={e=>setNote(e.target.value)} onBlur={()=>{item.notes=note;setEditNote(false);}} onKeyDown={e=>e.key==='Enter'&&(item.notes=note,setEditNote(false))} placeholder="Item note..." autoFocus style={{ marginTop:3,width:'100%',background:'var(--bg4)',border:'1px solid var(--acc-b)',borderRadius:5,padding:'3px 7px',color:'var(--t1)',fontSize:11,fontFamily:'inherit',outline:'none' }}/>
          )}
        </div>
        <div style={{ fontSize:12,fontWeight:700,color:'var(--acc)',fontFamily:'DM Mono,monospace',whiteSpace:'nowrap' }}>{money(((item.price||0)*(item.qty||1)))}</div>
      </div>
      <div style={{ display:'flex',alignItems:'center',gap:8,marginTop:4 }}>
        <div style={{ display:'flex',alignItems:'center',gap:1,background:'var(--bg4)',border:'1px solid var(--bdr)',borderRadius:6,overflow:'hidden' }}>
          <button onClick={()=>onQty(-1)} style={{ width:22,height:20,background:'transparent',border:'none',color:'var(--t2)',fontSize:14,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center' }}>−</button>
          <div style={{ width:22,height:20,display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:700,color:'var(--t1)' }}>{item.qty}</div>
          <button onClick={()=>onQty(1)} style={{ width:22,height:20,background:'transparent',border:'none',color:'var(--t2)',fontSize:14,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center' }}>+</button>
        </div>
        <button onClick={()=>{setEditNote(true);setNote(item.notes||'');}} style={{ fontSize:10,color:item.notes?'#f97316':'var(--t4)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit' }}>📝 {item.notes?'Edit note':'Add note'}</button>
        <button onClick={onRemove} style={{ marginLeft:'auto',fontSize:10,color:'var(--red)',background:'none',border:'none',cursor:'pointer',fontFamily:'inherit' }}>Remove</button>
      </div>
    </div>
  );
}

// ─── Quick Item Builder (variants/modifiers inline) ───────────────────────────
function QuickItemBuilder({ item, menuItems=[], modifierGroupDefs=[], onConfirm, onCancel }) {
  const [selections, setSelections] = useState({});
  const [selectedVariant, setSelectedVariant] = useState(null);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');

  // Resolve variant children from menuItems (they have parentId === item.id)
  const variantChildren = (menuItems||[]).filter(i => ((i.parentId || i.parent_id) === item.id) && !i.archived);

  // Resolve assigned modifier groups from modifierGroupDefs
  const resolvedGroups = (item.assignedModifierGroups||[]).map(ag => {
    const def = modifierGroupDefs.find(d => d.id === ag.groupId);
    if (!def) return null;
    return { ...def, required: ag.min > 0, min: ag.min, max: ag.max };
  }).filter(Boolean);

  const allRequired = resolvedGroups.filter(g=>g.required).every(g=>!!selections[g.id]);
  const extraCost = Object.values(selections).flat().filter(Boolean).reduce((s,m)=>s+(m?.price||0),0);
  const varPrice = item.type==='variants' ? (selectedVariant?.pricing?.base ?? selectedVariant?.price ?? 0) : (item.pricing?.base ?? item.price ?? 0);
  const total = (varPrice+extraCost)*qty;

  const canConfirm = item.type==='variants' ? !!selectedVariant : (resolvedGroups.some(g=>g.required) ? allRequired : true);

  const buildMods = () => {
    const mods = [];
    if (item.type==='variants' && selectedVariant) {
      mods.push({ label: `${item.variantLabel||'Size'}: ${selectedVariant.menuName||selectedVariant.name}`, price: selectedVariant.pricing?.base??selectedVariant.price??0 });
    }
    Object.entries(selections).forEach(([gid,val]) => {
      if (!val) return;
      const group = resolvedGroups.find(g=>g.id===gid);
      const arr = Array.isArray(val)?val:[val];
      arr.filter(Boolean).forEach(m=>mods.push({ groupLabel:group?.name, label:m.name||m.label, price:m.price||0 }));
    });
    return mods;
  };

  const selVariantName = selectedVariant ? (selectedVariant.menuName||selectedVariant.name) : null;
  const displayName = item.type==='variants' && selVariantName ? `${item.menuName||item.menu_name||item.name} — ${selVariantName}` : (item.menuName||item.menu_name||item.name||'Item');

  return (
    <div style={{ padding:20 }}>
      <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16 }}>
        <div style={{ fontSize:16,fontWeight:700,color:'var(--t1)' }}>{item.menuName||item.menu_name||item.name||'Item'}</div>
        <button onClick={onCancel} style={{ background:'none',border:'none',color:'var(--t3)',cursor:'pointer',fontSize:20 }}>×</button>
      </div>

      {item.type==='variants'&&(
        <div style={{ marginBottom:16 }}>
          <div style={{ fontSize:11,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8 }}>{item.variantLabel||'Size'}</div>
          {variantChildren.map(v=>(
            <button key={v.id} onClick={()=>setSelectedVariant(v)} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',padding:'10px 14px',borderRadius:10,cursor:'pointer',fontFamily:'inherit',marginBottom:6,border:`1.5px solid ${selectedVariant?.id===v.id?'var(--acc)':'var(--bdr)'}`,background:selectedVariant?.id===v.id?'var(--acc-d)':'var(--bg3)',color:selectedVariant?.id===v.id?'var(--acc)':'var(--t1)',textAlign:'left' }}>
              <span style={{ fontSize:13,fontWeight:500,flex:1,minWidth:0,overflowWrap:'anywhere' }}>{v.menuName||v.name}</span>
              <span style={{ fontSize:14,fontWeight:700,flexShrink:0,marginLeft:10,fontFamily:'DM Mono,monospace' }}>{money((v.pricing?.base??v.price??0))}</span>
            </button>
          ))}
        </div>
      )}

      {resolvedGroups.map(group=>(
        <div key={group.id} style={{ marginBottom:14 }}>
          <div style={{ display:'flex',alignItems:'center',gap:8,marginBottom:8 }}>
            <span style={{ fontSize:11,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:'.06em' }}>{group.name}</span>
            {group.required&&<span style={{ fontSize:10,color:'var(--red)',fontWeight:600 }}>Required</span>}
          </div>
          {(group.options||[]).map(opt=>{
            const cur=selections[group.id];
            const isSel=group.max>1?!!(cur||[]).find(o=>o.id===opt.id):cur?.id===opt.id;
            const toggle=()=>setSelections(s=>group.max>1?{...s,[group.id]:isSel?(cur||[]).filter(o=>o.id!==opt.id):[...(cur||[]),opt]}:{...s,[group.id]:isSel?null:opt});
            return(
              <button key={opt.id} onClick={toggle} style={{ display:'flex',alignItems:'center',justifyContent:'space-between',width:'100%',padding:'9px 12px',borderRadius:9,cursor:'pointer',fontFamily:'inherit',marginBottom:5,border:`1.5px solid ${isSel?'var(--acc)':'var(--bdr)'}`,background:isSel?'var(--acc-d)':'var(--bg3)' }}>
                <span style={{ fontSize:13,fontWeight:500,flex:1,minWidth:0,overflowWrap:'anywhere',color:isSel?'var(--acc)':'var(--t1)' }}>{opt.name||opt.label}</span>
                {(opt.price||0)>0&&<span style={{ fontSize:12,fontWeight:600,flexShrink:0,marginLeft:10,color:isSel?'var(--acc)':'var(--t3)' }}>+{money(opt.price)}</span>}
              </button>
            );
          })}
        </div>
      ))}

      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:11,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:6 }}>Item note</div>
        <input value={note} onChange={e=>setNote(e.target.value)} placeholder="No ice, extra lime, well done..." className="input"/>
      </div>

      <div style={{ display:'flex',alignItems:'center',gap:12,marginBottom:14 }}>
        <span style={{ fontSize:12,color:'var(--t2)' }}>Qty</span>
        <div style={{ display:'flex',alignItems:'center',gap:8,marginLeft:'auto' }}>
          <button onClick={()=>setQty(q=>Math.max(1,q-1))} style={{ width:28,height:28,borderRadius:'50%',border:'1px solid var(--bdr2)',background:'transparent',color:'var(--t2)',fontSize:16,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center' }}>−</button>
          <span style={{ fontSize:16,fontWeight:700,minWidth:24,textAlign:'center',color:'var(--t1)' }}>{qty}</span>
          <button onClick={()=>setQty(q=>q+1)} style={{ width:28,height:28,borderRadius:'50%',border:'1px solid var(--bdr2)',background:'transparent',color:'var(--t2)',fontSize:16,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center' }}>+</button>
        </div>
      </div>

      <button onClick={()=>onConfirm(buildMods(),{displayName,qty,linePrice:total,notes:note})} disabled={!canConfirm} className="btn btn-acc btn-full btn-lg" style={{ opacity:canConfirm?1:.4 }}>
        Add to round · {money(total)}
      </button>
    </div>
  );
}
