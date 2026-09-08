import { useState } from 'react';
import { ALLERGENS, MENU_ITEMS, STEAK_MODS } from '../data/seed';
import { money, currencySymbol } from '../lib/currency';

// ── Allergen warning modal ────────────────────────────────────────────────────
export function AllergenModal({ item, activeAllergens, onConfirm, onCancel }) {
  const flagged = (item.allergens || []).filter(a => activeAllergens.includes(a));
  const safeAlts = MENU_ITEMS.filter(i =>
    i.cat === item.cat &&
    i.id !== item.id &&
    i.allergens.every(a => !activeAllergens.includes(a))
  ).slice(0, 3);

  return (
    <div className="modal-back">
      <div className="modal-box" style={{ maxWidth:380 }}>
        <div style={{
          width:52, height:52, borderRadius:'50%',
          background:'var(--c-red-dim)', border:'2px solid var(--c-red-bdr)',
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:22, margin:'0 auto 16px',
        }}>⚠</div>

        <div style={{ fontSize:18, fontWeight:600, textAlign:'center', marginBottom:4 }}>Allergen warning</div>
        <div style={{ fontSize:13, color:'var(--c-text2)', textAlign:'center', marginBottom:20 }}>
          This item contains an active guest allergen
        </div>

        <div style={{ fontSize:15, fontWeight:500, marginBottom:10 }}>{item.name}</div>

        <div style={{ fontSize:12, color:'var(--c-text3)', marginBottom:8 }}>Contains</div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:16 }}>
          {flagged.map(a => (
            <span key={a} style={{
              padding:'3px 10px', borderRadius:20, fontSize:12, fontWeight:600,
              background:'var(--c-red-dim)', border:'1px solid var(--c-red-bdr)', color:'var(--c-red)',
            }}>
              {ALLERGENS.find(x => x.id === a)?.label}
            </span>
          ))}
        </div>

        {safeAlts.length > 0 && (
          <div style={{ background:'var(--c-raised)', borderRadius:10, padding:'10px 14px', marginBottom:16 }}>
            <div style={{ fontSize:11, color:'var(--c-text3)', marginBottom:6 }}>Safe alternatives</div>
            {safeAlts.map(i => (
              <div key={i.id} style={{ fontSize:13, color:'var(--c-text2)', marginBottom:3 }}>• {i.name} — {money(i.price)}</div>
            ))}
          </div>
        )}

        <div style={{ background:'var(--c-red-dim)', borderRadius:10, padding:'10px 14px', marginBottom:20, fontSize:12, color:'var(--c-red)', lineHeight:1.6 }}>
          By confirming, you acknowledge this item has been flagged and the guest has been informed of the allergen content.
        </div>

        <div style={{ display:'flex', gap:8 }}>
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onCancel}>Remove item</button>
          <button className="btn btn-red" style={{ flex:1 }} onClick={onConfirm}>Confirm — add anyway</button>
        </div>
      </div>
    </div>
  );
}

// ── Modifier modal (steak, drinks, etc) ───────────────────────────────────────
export function ModifierModal({ item, onConfirm, onCancel }) {
  const groups = item.mods === 'steak' ? STEAK_MODS : [];
  const [selected, setSelected] = useState({});

  const toggle = (groupId, opt) => setSelected(s => ({ ...s, [groupId]: opt }));
  const allRequired = groups.filter(g => g.required).every(g => selected[g.id]);
  const extraCost = Object.values(selected).reduce((s, m) => s + (m.price || 0), 0);

  return (
    <div className="modal-back">
      <div className="modal-box" style={{ maxWidth:380 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
          <div style={{ fontSize:17, fontWeight:600 }}>{item.name}</div>
          <div style={{ fontSize:16, fontWeight:700, color:'var(--c-acc)' }}>
            {money((item.price + extraCost))}
          </div>
        </div>

        {groups.map(group => (
          <div key={group.id} style={{ marginBottom:18 }}>
            <div className="label-xs" style={{ marginBottom:8 }}>
              {group.label}
              {group.required && <span style={{ color:'var(--c-red)', marginLeft:4 }}>Required</span>}
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
              {group.opts.map(opt => {
                const isSelected = selected[group.id]?.id === opt.id;
                return (
                  <button key={opt.id} onClick={() => toggle(group.id, opt)} style={{
                    padding:'7px 14px', borderRadius:8, cursor:'pointer',
                    border:`1.5px solid ${isSelected?'var(--c-acc)':'var(--bdr)'}`,
                    background: isSelected?'var(--c-acc-dim)':'var(--c-raised)',
                    color: isSelected?'var(--c-acc)':'var(--c-text2)',
                    fontSize:13, fontWeight:500, transition:'all .12s', fontFamily:'inherit',
                  }}>
                    {opt.label}
                    {opt.price > 0 && <span style={{ fontSize:11, opacity:.7 }}> +{currencySymbol()}{opt.price}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div style={{ display:'flex', gap:8, marginTop:8 }}>
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-acc"
            style={{ flex:2, opacity: allRequired ? 1 : .45 }}
            disabled={!allRequired}
            onClick={() => allRequired && onConfirm(Object.values(selected))}
          >
            Add to order
          </button>
        </div>
      </div>
    </div>
  );
}
