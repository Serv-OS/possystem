import { ALLERGENS } from '../data/seed';

/**
 * Shown before checkout when any items on the order have allergens.
 * Server must actively confirm they've communicated allergens to the guest.
 */
export default function AllergenCheckoutModal({ items, onConfirm, onCancel }) {
  // Collect all unique allergens across all items, with which items have them
  const allergenMap = {};
  items.filter(i => !i.voided && i.allergens?.length).forEach(item => {
    item.allergens.forEach(aId => {
      if (!allergenMap[aId]) allergenMap[aId] = [];
      allergenMap[aId].push(item.name);
    });
  });

  const allergenEntries = Object.entries(allergenMap);
  if (allergenEntries.length === 0) { onConfirm(); return null; }

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onCancel()}>
      <div style={{
        background:'var(--bg2)', border:'1px solid var(--red-b)', borderRadius:22,
        width:'100%', maxWidth:440, maxHeight:'90vh',
        display:'flex', flexDirection:'column',
        boxShadow:'var(--sh3)', overflow:'hidden',
        animation:'slideUp .18s cubic-bezier(.2,.8,.3,1)',
      }}>
        {/* Red header (fixed) */}
        <div style={{ background:'var(--red-d)', borderBottom:'1px solid var(--red-b)', padding:'16px 20px', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:36, height:36, borderRadius:10, background:'var(--red)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, flexShrink:0 }}>⚠</div>
            <div>
              <div style={{ fontSize:16, fontWeight:800, color:'var(--red)' }}>Allergen check required</div>
              <div style={{ fontSize:11, color:'var(--red)', opacity:.8, marginTop:2 }}>
                This order contains {allergenEntries.length} declared allergen{allergenEntries.length>1?'s':''}
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable body — long orders with many allergens stay reachable (the footer buttons
            are pinned below, outside this scroll area, so "proceed" is always tappable). */}
        <div style={{ padding:'16px 20px', overflowY:'auto', flex:1, minHeight:0, WebkitOverflowScrolling:'touch' }}>
          <div style={{ fontSize:13, color:'var(--t2)', marginBottom:16, lineHeight:1.5 }}>
            Confirm you have informed the guest of the following allergens before proceeding to payment.
          </div>

          {/* Allergen list */}
          <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:20 }}>
            {allergenEntries.map(([aId, itemNames]) => {
              const a = ALLERGENS.find(x => x.id === aId);
              if (!a) return null;
              return (
                <div key={aId} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', background:'var(--red-d)', border:'1px solid var(--red-b)', borderRadius:10 }}>
                  <div style={{ width:28, height:28, borderRadius:7, background:'var(--red)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, flexShrink:0 }}>
                    {a.icon}
                  </div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:'var(--red)' }}>{a.label}</div>
                    <div style={{ fontSize:11, color:'var(--red)', opacity:.8, marginTop:1 }}>
                      in: {itemNames.join(', ')}
                    </div>
                  </div>
                  <div style={{ width:18, height:18, borderRadius:'50%', border:'2px solid var(--red)', flexShrink:0 }}/>
                </div>
              );
            })}
          </div>

          {/* Legal note */}
          <div style={{ fontSize:11, color:'var(--t4)', lineHeight:1.5, padding:'8px 12px', background:'var(--bg3)', borderRadius:8 }}>
            EU/UK Food Information for Consumers Regulation requires all 14 allergens to be declared. This confirmation is recorded on the order audit trail.
          </div>
        </div>

        {/* Fixed footer — always visible, never scrolled off on big orders */}
        <div style={{ display:'flex', gap:8, padding:'12px 20px', borderTop:'1px solid var(--bdr)', flexShrink:0, background:'var(--bg2)' }}>
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onCancel}>Back to order</button>
          <button style={{
            flex:2, height:46, borderRadius:11, cursor:'pointer', fontFamily:'inherit',
            background:'var(--red)', border:'none', color:'#fff', fontSize:14, fontWeight:800,
          }} onClick={onConfirm}>
            ✓ Allergens confirmed — proceed
          </button>
        </div>
      </div>
    </div>
  );
}
