// MVariantPicker — bottom-sheet variant chooser shown when a parent item with
// type === 'variants' is tapped. Lists all child items (those with
// parentId === parent.id), each with its own price. Tapping a variant
// proceeds to MItemDetail for modifier selection (or directly adds it to the
// cart if the variant has no modifiers).

import { useMemo } from 'react';
import { useStore } from '../../store';
import { Sx, money } from './MShellStyles';

export default function MVariantPicker({ parent, onPick, onClose }) {
  const { menuItems = [], eightySixIds = [] } = useStore();

  const variants = useMemo(() =>
    (menuItems || []).filter(i =>
      !i.hidden && !eightySixIds.includes(i.id) && i.parentId === parent.id
    )
  , [menuItems, eightySixIds, parent?.id]);

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.55)', zIndex:60, display:'flex', alignItems:'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width:'100%', maxWidth:540, margin:'0 auto', background:'var(--bg1)', borderRadius:'18px 18px 0 0',
        padding:'14px 14px calc(18px + env(safe-area-inset-bottom)) 14px',
        boxShadow:'0 -10px 32px rgba(0,0,0,.45)', maxHeight:'80svh', overflowY:'auto',
      }}>
        <div style={{ width:36, height:4, borderRadius:2, background:'var(--bdr2)', margin:'0 auto 14px' }}/>
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
      </div>
    </div>
  );
}
