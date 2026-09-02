import { useState, useEffect } from 'react';
import { useStore, getCollectionSlots } from '../store';
import { kitchenLoadFromStore, prepMinutes } from '../lib/prepTime';
import AddressAutocomplete from './AddressAutocomplete';

export default function CustomerModal({ orderType, existing, onConfirm, onCancel }) {
  const { searchCustomers, searchCustomersLive, addToHistory, showToast, takeawayCustomerDetails } = useStore();
  // v5.8.6: quote the same wait the kitchen is actually carrying. The slot grid
  // was hard-coded to now+15 regardless of the venue's lead time, so a caller
  // was promised a time the website would have refused for the same order.
  // The count comes from the store the Orders Hub renders, so the number staff
  // quote and the number they can see cannot drift apart.
  const tz          = useStore(st => st.locationConfig?.timezone);
  // The wait we QUOTE, not collectionLeadMinutes (that is when the kitchen
  // STARTS a pre-order — a different setting answering a different question).
  // Falling back to the kitchen-start lead is still far better than the old
  // hard-coded 15, which promised a caller a time the website would refuse.
  const quoteBase   = useStore(st => st.locationConfig?.quoteLeadMinutes);
  const kitchenBase = useStore(st => st.locationConfig?.collectionLeadMinutes);
  const leadBase    = typeof quoteBase === 'number' ? quoteBase : kitchenBase;
  const busyRule    = useStore(st => st.locationConfig?.busyRule) || {};
  const liveTables  = useStore(st => st.tables);
  const liveTabs    = useStore(st => st.tabs);
  const liveQueue   = useStore(st => st.orderQueue);
  const quotedLead  = prepMinutes(
    typeof leadBase === 'number' ? leadBase : 30,
    kitchenLoadFromStore({ tables: liveTables, tabs: liveTabs, orderQueue: liveQueue }).load,
    busyRule,
  ).minutes;
  const [name, setName]       = useState(existing?.name || '');
  const [phone, setPhone]     = useState(existing?.phone || '');
  const [email, setEmail]     = useState(existing?.email || '');
  const [notes, setNotes]     = useState(existing?.notes || '');
  // v5.5.657: delivery address (POS phone-order delivery). Without these the delivery
  // quote never fires and the order goes out with no address.
  const [addr1, setAddr1]       = useState(existing?.address?.line1 || '');
  const [postcode, setPostcode] = useState(existing?.address?.postcode || '');
  const [addrGeo, setAddrGeo]   = useState(existing?.address?.lat != null ? { lat: existing.address.lat, lng: existing.address.lng } : null);
  // v4.6.61: when editing, default to non-ASAP if a collectionTime is already set,
  // so the user sees their existing time pre-selected on the slot grid.
  const [isASAP, setIsASAP]   = useState(existing ? !!existing.isASAP : true);
  // v4.6.61: preselect the slot matching existing.collectionTime when editing
  const [slotIdx, setSlotIdx] = useState(() => {
    if (!existing?.collectionTime) return 0;
    try {
      const all = getCollectionSlots(quotedLead, tz);
      const futureSlots = all.slice(1);
      const matchIdx = futureSlots.findIndex(s => s.label === existing.collectionTime);
      return matchIdx >= 0 ? matchIdx : 0;
    } catch { return 0; }
  });
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);

  const slots = getCollectionSlots(quotedLead, tz);
  const isCollection = orderType === 'collection';
  const isDelivery = orderType === 'delivery';
  // v5.5.799: quick-service venues can relax takeaway/collection to a single name field
  // ('name' mode — and 'none' mode when this modal is opened explicitly via Add customer).
  // Dine-in loyalty attach and delivery always keep the full form.
  const nameOnly = (orderType === 'takeaway' || isCollection) && takeawayCustomerDetails !== 'full' && !!takeawayCustomerDetails;

  // Live phone/name search
  // v5.5.280: phone search starts at 6 digits (was 3) to reduce DB load at scale.
  // Name/email search stays at 3 chars since those are ilike prefix matches.
  useEffect(() => {
    const phoneDigits = phone.replace(/[^\d+]/g, '');
    const q = phoneDigits.length >= 6 ? phone : name.length >= 3 ? name : '';
    if (!q) { setResults([]); setSearched(false); return; }
    // Show local cache immediately for snappy UI
    setResults(searchCustomers(q));
    setSearched(true);
    // Then hit Supabase for the full list (debounced)
    const t = setTimeout(async () => {
      try {
        const live = typeof searchCustomersLive === 'function' ? await searchCustomersLive(q) : [];
        if (live && live.length) {
          // Merge live with whatever local cache had, dedupe by phone
          const seen = new Set();
          const merged = [...live, ...searchCustomers(q)].filter(c => {
            const k = c.phone || c.email || c.id;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          }).slice(0, 8);
          setResults(merged);
        }
      } catch {}
    }, 250);
    return () => clearTimeout(t);
  }, [phone, name]);

  const selectCustomer = (c) => {
    setName(c.name); setPhone(c.phone); setEmail(c.email || '');
    if (c.address) { setAddr1(c.address.line1 || ''); setPostcode(c.address.postcode || ''); setAddrGeo(c.address.lat != null ? { lat: c.address.lat, lng: c.address.lng } : null); }
    setResults([]); setSearched(false);
  };

  const handleConfirm = async () => {
    if (!name.trim() || (!nameOnly && !phone.trim())) {
      showToast(nameOnly ? 'Customer name is required' : 'Name and phone number are required', 'error'); return;
    }
    if (isDelivery && (!addr1.trim() || !postcode.trim())) {
      showToast('Delivery address and postcode are required', 'error'); return;
    }
    // v5.5.248: before creating, check if this phone already exists in the DB.
    // If it does, auto-populate from the existing profile to prevent duplicates.
    // v5.5.799: skipped in name-only mode — there's no phone to dedupe on.
    let finalName = name.trim();
    let finalEmail = email.trim();
    let finalNotes = notes.trim();
    // v5.5.894: allergens must SURVIVE the rebuild — this modal used to construct a fresh
    // customer object and silently drop them, so a pulled-up profile lost its allergy record.
    let finalAllergens = Array.isArray(existing?.allergens) ? existing.allergens : [];
    if (phone.trim()) try {
      const live = typeof searchCustomersLive === 'function' ? await searchCustomersLive(phone.trim()) : [];
      const phoneDigits = phone.trim().replace(/[^\d+]/g, '');
      const match = (live || []).find(c => {
        const cp = (c.phone || '').replace(/[^\d+]/g, '');
        const cr = (c.phone_raw || '').replace(/[^\d+]/g, '');
        return cp === phoneDigits || cr === phoneDigits
          || (phoneDigits.startsWith('07') && (cp === '+44' + phoneDigits.slice(1) || cr === phoneDigits))
          || (phoneDigits.startsWith('+44') && (cr === '0' + phoneDigits.slice(3)));
      });
      if (match) {
        // Use existing profile — operator keeps their typed name/email if they entered something new
        finalName = name.trim() || match.name || 'Customer';
        finalEmail = email.trim() || match.email || '';
        finalNotes = notes.trim() || match.notes || '';
        if (Array.isArray(match.allergens) && match.allergens.length) finalAllergens = match.allergens;
        showToast(`Matched existing customer: ${match.name}`, 'success');
      }
    } catch {}
    const customer = {
      name: finalName, phone: phone.trim(), email: finalEmail, notes: finalNotes,
      ...(finalAllergens.length ? { allergens: finalAllergens } : {}),
      isASAP,
      collectionTime: isASAP ? slots[0]?.label : slots[slotIdx]?.label,
      collectionISO:  isASAP ? slots[0]?.value  : slots[slotIdx]?.value,
      ...(isDelivery ? { address: { line1: addr1.trim(), postcode: postcode.trim().toUpperCase(), ...(addrGeo ? { lat: addrGeo.lat, lng: addrGeo.lng } : {}) } } : {}),
    };
    addToHistory(customer);
    onConfirm(customer);
  };

  const inputStyle = {
    width: '100%', background: 'var(--bg3)', border: '1px solid var(--bdr2)',
    borderRadius: 10, padding: '0 14px', height: 42,
    fontSize: 14, color: 'var(--t1)', fontFamily: 'inherit', outline: 'none',
  };

  return (
    <div className="modal-back">
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--bdr2)',
        borderRadius: 20, width: '100%', maxWidth: 420,
        maxHeight: '90vh', overflow: 'auto', padding: 24,
        boxShadow: 'var(--sh3)',
      }}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t1)' }}>
              {orderType === 'collection' ? '📦 Collection order' : orderType === 'dine-in' ? '👤 Add customer to table' : isDelivery ? '🚗 Delivery order' : '🥡 Takeaway order'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>
              {existing ? 'Editing customer details — update only what you need' : (orderType === 'collection' ? 'Customer collects from the counter' : orderType === 'dine-in' ? 'Attach a customer so this visit counts toward their loyalty' : isDelivery ? 'Delivery to the customer’s address' : 'Order to be taken away now')}
            </div>
          </div>
          <button onClick={onCancel} style={{ background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:22, lineHeight:1 }}>×</button>
        </div>

        {/* Customer search results */}
        {results.length > 0 && (
          <div style={{ marginBottom: 14, background: 'var(--bg3)', borderRadius: 10, border: '1px solid var(--bdr2)', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', borderBottom: '1px solid var(--bdr)' }}>
              Returning customers
            </div>
            {results.map(c => (
              <div key={c.id} onClick={() => selectCustomer(c)} style={{
                padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
                borderBottom: '1px solid var(--bdr)', transition: 'background .1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg4)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--acc-d)', border: '1px solid var(--acc-b)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--acc)', flexShrink: 0 }}>
                  {c.name.split(' ').map(n => n[0]).join('').slice(0,2)}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 1 }}>{c.phone} · {c.visits} visit{c.visits!==1?'s':''} · {c.lastOrder}</div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--acc)', fontWeight: 600 }}>Select →</div>
              </div>
            ))}
          </div>
        )}
        {searched && results.length === 0 && (
          <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--t3)', padding: '6px 0' }}>
            No existing customer found — creating new profile
          </div>
        )}

        {/* Form fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 18 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              Name <span style={{ color: 'var(--red)' }}>*</span>
            </label>
            <input style={inputStyle} placeholder="Customer name" value={name} onChange={e => setName(e.target.value)}/>
          </div>
          {/* v5.5.799: name-only mode — quick service takes just the name */}
          {!nameOnly && (<>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              Phone <span style={{ color: 'var(--red)' }}>*</span>
            </label>
            <input style={inputStyle} type="tel" placeholder="07700 000000" value={phone} onChange={e => setPhone(e.target.value)}/>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              Email <span style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'none', letterSpacing: 0 }}>(optional — for receipt)</span>
            </label>
            <input style={inputStyle} type="email" placeholder="email@example.com" value={email} onChange={e => setEmail(e.target.value)}/>
          </div>
          </>)}
          {isDelivery && (<>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              Delivery address <span style={{ color: 'var(--red)' }}>*</span>
            </label>
            <AddressAutocomplete value={addr1} inputStyle={inputStyle} placeholder="Start typing the delivery address…"
              onChangeText={(t) => { setAddr1(t); setAddrGeo(null); }}
              onSelect={(a) => { setAddr1(a.line1 || a.label); if (a.postcode) setPostcode(a.postcode); setAddrGeo(a.lat != null ? { lat: a.lat, lng: a.lng } : null); }}/>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              Postcode <span style={{ color: 'var(--red)' }}>*</span>
            </label>
            <input style={inputStyle} placeholder="e.g. HD4 7PT" value={postcode} onChange={e => setPostcode(e.target.value)}/>
          </div>
          </>)}
        </div>

        {/* Collection time — only for collection orders */}
        {isCollection && (
          <div style={{ marginBottom: 18 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>
              Collection time
            </label>

            {/* ASAP toggle */}
            <div style={{ display: 'flex', border: '1px solid var(--bdr2)', borderRadius: 10, overflow: 'hidden', marginBottom: 10 }}>
              <button onClick={() => setIsASAP(true)} style={{
                flex: 1, padding: '10px', cursor: 'pointer', fontFamily: 'inherit',
                background: isASAP ? 'var(--acc)' : 'transparent',
                color: isASAP ? '#0e0f14' : 'var(--t2)',
                border: 'none', fontSize: 13, fontWeight: 700, transition: 'all .15s',
              }}>
                ⚡ ASAP ({slots[0]?.label})
              </button>
              <button onClick={() => setIsASAP(false)} style={{
                flex: 1, padding: '10px', cursor: 'pointer', fontFamily: 'inherit',
                background: !isASAP ? 'var(--acc)' : 'transparent',
                color: !isASAP ? '#0e0f14' : 'var(--t2)',
                border: 'none', fontSize: 13, fontWeight: 700, transition: 'all .15s',
              }}>
                🕐 Scheduled time
              </button>
            </div>

            {/* Time slot grid */}
            {!isASAP && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                {slots.slice(1).map((slot, i) => {
                  const idx = i + 1;
                  const active = slotIdx === idx;
                  return (
                    <button key={slot.value} onClick={() => setSlotIdx(idx)} style={{
                      padding: '10px 4px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                      border: `1.5px solid ${active ? 'var(--acc)' : 'var(--bdr)'}`,
                      background: active ? 'var(--acc-d)' : 'var(--bg3)',
                      color: active ? 'var(--acc)' : 'var(--t2)',
                      fontSize: 13, fontWeight: 600, fontFamily: 'inherit', transition: 'all .12s',
                    }}>
                      {slot.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Order notes */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t2)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
            Order notes <span style={{ fontSize: 10, color: 'var(--t3)', textTransform: 'none', letterSpacing: 0 }}>(optional)</span>
          </label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Allergies, special requests, parking space..."
            rows={2}
            style={{ width:'100%', background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:10, padding:'10px 14px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', resize:'none', outline:'none' }}/>
        </div>

        {/* Confirm / cancel */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
          <button className="btn btn-acc" style={{ flex: 2, height: 46, fontSize: 15 }} onClick={handleConfirm}>
            {orderType === 'dine-in' ? 'Attach to table' : isDelivery ? 'Confirm delivery →' : ('Confirm ' + (orderType === 'collection' ? 'collection' : 'takeaway') + ' →')}
          </button>
        </div>
      </div>
    </div>
  );
}
