// MVariantPicker — bottom-sheet variant chooser shown when a parent item with
// type === 'variants' is tapped. Lists all child items (those with
// parentId === parent.id), each with its own price. Tapping a variant
// proceeds to MItemDetail for modifier selection (or directly adds it to the
// cart if the variant has no modifiers).

import { useMemo } from 'react';
import { useStore } from '../../store';
import { Sx, money } from './MShellStyles';
import MBottomSheet from './MBottomSheet';

export default function MVariantPicker({ parent, onPick, onClose }) {
  const { menuItems = [], eightySixIds = [] } = useStore();

  const variants = useMemo(() =>
    (menuItems || []).filter(i =>
      !i.hidden && !eightySixIds.includes(i.id) && i.parentId === parent.id
    )
  , [menuItems, eightySixIds, parent?.id]);

  return (
    <MBottomSheet onClose={onClose} maxHeight="80vh">
      <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:2 }}>{parent.name}</div>
      <div style={{ fontSize:12, color:'var(--t3)', marginBottom:14 }}>Pick a size or variant</div>

      <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
        {variants.length === 0 && (
          <div style={{ fontSize:12, color:'var(--t4)', padding:'12px 0', textAlign:'center' }}>
            No variants available.
          </div>
        )}
        {variants.map(v => {
          const price = v?.pricing?.base ?? v?.price ?? 0;
          return (
            <button key={v.id} onClick={() => onPick?.(v)} style={{
              width:'100%', padding:'14px 14px', borderRadius:12, border:'1px solid var(--bdr)',
              background:'var(--bg2)', cursor:'pointer', fontFamily:'inherit', textAlign:'left',
              display:'flex', alignItems:'center', gap:10, minHeight:60,
            }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{v.menuName || v.name?.split(' — ').slice(-1)[0] || v.name}</div>
                {v.description && <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{v.description}</div>}
              </div>
              <div style={{ fontSize:14, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(price)}</div>
              <span style={{ fontSize:18, color:'var(--t4)' }}>›</span>
            </button>
          );
        })}
      </div>

      <button onClick={onClose} style={{ ...Sx.btnGhost, marginTop:12 }}>Cancel</button>
    </MBottomSheet>
  );
}
