// MAllergenPicker — bottom-sheet allergen filter. Tap allergens the customer
// must avoid; the menu greys-out and crosses-out matching items so the
// server can quickly tell what's safe. Same store state as the desktop POS
// (state.allergens) so the filter persists across surfaces and applies to
// the kitchen ticket if items still get added by mistake.

import { useStore } from '../../store';
import { ALLERGENS } from '../../data/seed';
import { Sx } from './MShellStyles';
import MBottomSheet from './MBottomSheet';

export default function MAllergenPicker({ onClose }) {
  const { allergens = [] } = useStore();

  const toggle = (id) => {
    const next = allergens.includes(id)
      ? allergens.filter(a => a !== id)
      : [...allergens, id];
    useStore.setState({ allergens: next });
  };

  const clearAll = () => useStore.setState({ allergens: [] });

  return (
    <MBottomSheet onClose={onClose}>
      <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:6 }}>
          <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)', flex:1 }}>Allergy filter</div>
          {allergens.length > 0 && (
            <button onClick={clearAll} style={{
              padding:'6px 10px', borderRadius:8, border:'1px solid var(--bdr2)',
              background:'var(--bg2)', color:'var(--t2)', fontSize:11, fontWeight:700,
              fontFamily:'inherit', cursor:'pointer',
            }}>Clear</button>
          )}
        </div>
        <div style={{ fontSize:12, color:'var(--t3)', marginBottom:14, lineHeight:1.5 }}>
          Tap any allergens the customer avoids. Items containing them will be greyed out in the menu and on items already in the cart so the kitchen sees the warning.
        </div>

        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {ALLERGENS.map(a => {
            const on = allergens.includes(a.id);
            return (
              <button key={a.id} onClick={() => toggle(a.id)} style={{
                padding:'10px 14px', borderRadius:99,
                border:`1.5px solid ${on ? 'var(--red)' : 'var(--bdr2)'}`,
                background: on ? 'var(--red-d)' : 'var(--bg2)',
                color: on ? 'var(--red)' : 'var(--t2)',
                fontSize:13, fontWeight:700, fontFamily:'inherit', cursor:'pointer',
                display:'flex', alignItems:'center', gap:8,
              }}>
                <span style={{
                  width:22, height:22, borderRadius:'50%', flexShrink:0,
                  background: on ? 'var(--red)' : 'var(--bg3)',
                  color: on ? '#fff' : 'var(--t3)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:10, fontWeight:800,
                }}>{a.icon}</span>
                <span>{a.label}</span>
              </button>
            );
          })}
        </div>

      <button onClick={onClose} style={{ ...Sx.btnPrim, marginTop:18 }}>
        Done {allergens.length > 0 ? `· filtering ${allergens.length}` : ''}
      </button>
    </MBottomSheet>
  );
}
