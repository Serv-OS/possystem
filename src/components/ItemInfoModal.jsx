import { useState, useRef } from 'react';
import { useStore } from '../store';
import { ALLERGENS, CAT_META } from '../data/seed';
import { ITEM_RECIPES } from '../data/seed';
import { money } from '../lib/currency';

// ── Set daily count numpad ────────────────────────────────────────────────────
function CountSetter({ itemId, current, onClose }) {
  const { setDailyCount, clearDailyCount } = useStore();
  const [val, setVal] = useState(current?.par ? String(current.par) : '');

  const press = d => {
    if (d === '⌫') { setVal(p => p.slice(0,-1)); return; }
    if (val.length >= 3) return;
    setVal(p => p + d);
  };

  return (
    <div>
      <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>
        Set portions available today
      </div>

      {/* Display */}
      <div style={{ height:56, borderRadius:12, border:'2px solid var(--acc-b)', background:'var(--acc-d)', display:'flex', alignItems:'center', justifyContent:'center', marginBottom:12 }}>
        <span style={{ fontSize:32, fontWeight:800, color:val?'var(--acc)':'var(--t4)', fontFamily:'var(--font-mono)' }}>{val || '—'}</span>
      </div>

      {/* Numpad */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:5, marginBottom:10 }}>
        {[7,8,9,4,5,6,1,2,3,'',0,'⌫'].map((d,i) => (
          <button key={i} onClick={()=>d!==''&&press(String(d))} style={{
            height:46, borderRadius:9, cursor:d===''?'default':'pointer', fontFamily:'inherit',
            background:d==='⌫'?'var(--red-d)':d===''?'transparent':'var(--bg3)',
            border:d===''?'none':`1px solid ${d==='⌫'?'var(--red-b)':'var(--bdr)'}`,
            color:d==='⌫'?'var(--red)':'var(--t1)',
            fontSize:d==='⌫'?17:18, fontWeight:700, opacity:d===''?0:1,
          }}>{d}</button>
        ))}
      </div>

      {/* Quick set */}
      <div style={{ display:'flex', gap:5, marginBottom:12 }}>
        {[4,6,8,10,12,16].map(n => (
          <button key={n} onClick={()=>setVal(String(n))} style={{
            flex:1, height:30, borderRadius:7, cursor:'pointer', fontFamily:'inherit',
            background:val===String(n)?'var(--acc-d)':'var(--bg3)',
            border:`1px solid ${val===String(n)?'var(--acc)':'var(--bdr)'}`,
            color:val===String(n)?'var(--acc)':'var(--t3)',
            fontSize:11, fontWeight:700,
          }}>{n}</button>
        ))}
      </div>

      <div style={{ display:'flex', gap:6 }}>
        {current && (
          <button onClick={()=>{ clearDailyCount(itemId); onClose(); }} style={{
            flex:1, height:38, borderRadius:9, cursor:'pointer', fontFamily:'inherit',
            background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, fontWeight:700,
          }}>Clear count</button>
        )}
        <button onClick={()=>{ if(val) { setDailyCount(itemId, parseInt(val)); } onClose(); }} style={{
          flex:2, height:38, borderRadius:9, cursor:'pointer', fontFamily:'inherit',
          background:val?'var(--acc)':'var(--bg3)', border:'none',
          color:val?'#0b0c10':'var(--t4)', fontSize:13, fontWeight:800,
        }} disabled={!val}>
          {val ? `Set ${val} portions` : 'Enter a number'}
        </button>
      </div>
    </div>
  );
}

// ── Main item info modal ──────────────────────────────────────────────────────
export default function ItemInfoModal({ item, is86, onToggle86, onClose, onAddToOrder }) {
  const { dailyCounts } = useStore();
  const [tab, setTab] = useState('info');   // info | recipe | count
  const m = CAT_META[item.cat] || {};
  const recipe = ITEM_RECIPES[item.id];
  const count  = dailyCounts[item.id];

  // v4.6.5 follow-up: long-press passes the bare menu item (no .variants array —
  // that decoration only happens inside openFlow for normal taps), so for a variant-parent
  // item with type='variants' the old code crashed with "Cannot read properties of undefined (reading 'map')"
  // before the component could even render. Guard the min() and fall back to item.price.
  const fromPrice = (item.type==='variants' && item.variants?.length)
    ? Math.min(...item.variants.map(v=>v.price))
    : item.price;

  const allergenList = ALLERGENS.filter(a => item.allergens?.includes(a.id));

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{
        background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:24,
        width:'100%', maxWidth:480, maxHeight:'92vh',
        display:'flex', flexDirection:'column',
        boxShadow:'var(--sh3)', overflow:'hidden',
        animation:'slideUp .2s cubic-bezier(.2,.8,.3,1)',
      }}>

        {/* ── Hero image ── */}
        <div style={{
          height:160, flexShrink:0, position:'relative',
          background: item.image
            ? 'transparent'
            : `linear-gradient(135deg, ${m.color}33, ${m.color}11)`,
          display:'flex', alignItems:'center', justifyContent:'center',
          borderBottom:'1px solid var(--bdr)',
          overflow:'hidden',
        }}>
          {item.image ? (
            <>
              <img src={item.image} alt={item.name} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} />
              <div style={{ position:'absolute', inset:0, background:'linear-gradient(to top, rgba(0,0,0,.5) 0%, transparent 60%)' }}/>
            </>
          ) : (
            <span style={{ fontSize:72, filter:'drop-shadow(0 4px 12px rgba(0,0,0,.3))' }}>{m.icon||'🍽'}</span>
          )}
          {/* Category pill */}
          <div style={{ position:'absolute', top:14, left:16, padding:'4px 10px', borderRadius:20, background:'rgba(0,0,0,.4)', backdropFilter:'blur(8px)', fontSize:11, fontWeight:700, color:'#fff', letterSpacing:.04 }}>
            {item.cat?.charAt(0).toUpperCase()+(item.cat?.slice(1)||'')}
          </div>
          {/* Close */}
          <button onClick={onClose} style={{ position:'absolute', top:14, right:14, width:32, height:32, borderRadius:'50%', background:'rgba(0,0,0,.4)', backdropFilter:'blur(8px)', border:'none', color:'#fff', cursor:'pointer', fontFamily:'inherit', fontSize:18, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
          {/* Count badge */}
          {count && (
            <div style={{ position:'absolute', top:14, left:'50%', transform:'translateX(-50%)', padding:'4px 12px', borderRadius:20, background:count.remaining<=3?'var(--acc)':'var(--grn)', fontSize:12, fontWeight:800, color:count.remaining<=3?'#0b0c10':'#fff' }}>
              {count.remaining} left today
            </div>
          )}
        </div>

        {/* ── Name + price ── */}
        <div style={{ padding:'16px 20px 0', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)', letterSpacing:'-.01em', lineHeight:1.2 }}>{item.name}</div>
              {item.description && <div style={{ fontSize:13, color:'var(--t3)', marginTop:5, lineHeight:1.5 }}>{item.description}</div>}
            </div>
            <div style={{ textAlign:'right', flexShrink:0 }}>
              <div style={{ fontSize:22, fontWeight:800, color:m.color||'var(--acc)', fontFamily:'var(--font-mono)' }}>
                {item.type==='variants'?`from ${money(fromPrice)}`:`${money(fromPrice)}`}
              </div>
            </div>
          </div>

          {/* Prep time if recipe exists */}
          {recipe && (
            <div style={{ display:'flex', gap:12, marginTop:10 }}>
              {recipe.prepTime && <div style={{ fontSize:11, color:'var(--t4)', display:'flex', alignItems:'center', gap:4 }}><span>⏱</span>Prep {recipe.prepTime}m</div>}
              {recipe.cookTime>0 && <div style={{ fontSize:11, color:'var(--t4)', display:'flex', alignItems:'center', gap:4 }}><span>🔥</span>Cook {recipe.cookTime}m</div>}
              {recipe.calories && <div style={{ fontSize:11, color:'var(--t4)', display:'flex', alignItems:'center', gap:4 }}><span>⚡</span>{recipe.calories} kcal</div>}
            </div>
          )}
        </div>

        {/* ── Tabs ── */}
        <div style={{ display:'flex', gap:0, padding:'10px 20px 0', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          {[
            ['info', 'Info'],
            ...(recipe ? [['recipe','Recipe & method']] : []),
            ['count', count ? `Count (${count.remaining}/${count.par})` : 'Daily count'],
          ].map(([t,l]) => (
            <button key={t} onClick={()=>setTab(t)} style={{
              padding:'8px 14px', cursor:'pointer', fontFamily:'inherit', border:'none',
              borderBottom:`2.5px solid ${tab===t?'var(--acc)':'transparent'}`,
              background:'transparent',
              color:tab===t?'var(--acc)':'var(--t3)',
              fontSize:12, fontWeight:tab===t?800:500, transition:'all .12s', whiteSpace:'nowrap',
            }}>{l}</button>
          ))}
        </div>

        {/* ── Tab content ── */}
        <div style={{ flex:1, overflowY:'auto', padding:'16px 20px' }}>

          {/* ── Info tab ── */}
          {tab==='info' && (
            <>
              {/* Story / extra description */}
              {recipe?.story && (
                <div style={{ padding:'12px 14px', background:'var(--bg3)', borderRadius:12, border:'1px solid var(--bdr)', marginBottom:16, fontSize:13, color:'var(--t2)', lineHeight:1.6, fontStyle:'italic' }}>
                  "{recipe.story}"
                </div>
              )}

              {/* Allergens */}
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Allergens</div>
                {allergenList.length === 0 ? (
                  <div style={{ fontSize:12, color:'var(--grn)', fontWeight:600 }}>✓ No declared allergens</div>
                ) : (
                  <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                    {ALLERGENS.map(a => {
                      const active = item.allergens?.includes(a.id);
                      return (
                        <div key={a.id} style={{
                          padding:'4px 10px', borderRadius:20, fontSize:11, fontWeight:700,
                          background:active?'var(--red-d)':'var(--bg3)',
                          border:`1px solid ${active?'var(--red-b)':'var(--bdr)'}`,
                          color:active?'var(--red)':'var(--t4)',
                        }}>
                          {a.icon} {a.label}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Variants */}
              {item.type==='variants' && item.variants && (
                <div style={{ marginBottom:16 }}>
                  <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Sizes & pricing</div>
                  {item.variants.map(v => (
                    <div key={v.id} style={{ display:'flex', justifyContent:'space-between', padding:'8px 12px', background:'var(--bg3)', borderRadius:8, marginBottom:4, border:'1px solid var(--bdr)' }}>
                      <span style={{ fontSize:13, color:'var(--t2)', fontWeight:500 }}>{v.label}</span>
                      <span style={{ fontSize:13, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(v.price)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Modifier groups */}
              {item.modifierGroups?.length > 0 && (
                <div style={{ marginBottom:16 }}>
                  <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Options</div>
                  {item.modifierGroups.map(grp => (
                    <div key={grp.id} style={{ marginBottom:8, padding:'10px 12px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
                      <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', marginBottom:6 }}>
                        {grp.label} {grp.required&&<span style={{ color:'var(--red)', fontSize:9 }}>required</span>}
                      </div>
                      <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                        {grp.options.map(opt => (
                          <span key={opt.id} style={{ fontSize:11, padding:'3px 8px', borderRadius:6, background:'var(--bg4)', color:'var(--t3)', border:'1px solid var(--bdr)' }}>
                            {opt.label}{opt.price>0?` +${money(opt.price)}`:''}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Recipe tab ── */}
          {tab==='recipe' && recipe && (
            <>
              {/* Ingredients */}
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:10 }}>Ingredients (1 portion)</div>
                {recipe.recipe.map((r,i) => (
                  <div key={i} style={{ display:'flex', alignItems:'baseline', gap:10, padding:'7px 0', borderBottom:'1px solid var(--bdr)' }}>
                    <div style={{ width:64, flexShrink:0, textAlign:'right' }}>
                      <span style={{ fontSize:13, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>
                        {r.qty!=null?r.qty:''}
                      </span>
                      {r.unit && <span style={{ fontSize:11, color:'var(--t4)', marginLeft:3 }}>{r.unit}</span>}
                    </div>
                    <div style={{ fontSize:13, color:'var(--t2)', flex:1 }}>{r.ingredient}</div>
                  </div>
                ))}
              </div>

              {/* Method */}
              <div>
                <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:10 }}>Method</div>
                {recipe.method.map((step, i) => (
                  <div key={i} style={{ display:'flex', gap:12, marginBottom:12 }}>
                    <div style={{ width:24, height:24, borderRadius:'50%', background:m.color?`${m.color}22`:'var(--bg3)', border:`1.5px solid ${m.color||'var(--bdr)'}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:800, color:m.color||'var(--t3)', flexShrink:0, marginTop:1 }}>
                      {i+1}
                    </div>
                    <div style={{ fontSize:13, color:'var(--t2)', lineHeight:1.6, flex:1, paddingTop:2 }}>{step}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── Count tab ── */}
          {tab==='count' && (
            <>
              {/* Current status */}
              {count && (
                <div style={{ padding:'12px 16px', borderRadius:12, marginBottom:16, background:count.remaining<=3?'var(--acc-d)':'var(--grn-d)', border:`1px solid ${count.remaining<=3?'var(--acc-b)':'var(--grn-b)'}` }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div>
                      <div style={{ fontSize:12, fontWeight:700, color:count.remaining<=3?'var(--acc)':'var(--grn)', marginBottom:2 }}>
                        {count.remaining<=0?'SOLD OUT':count.remaining<=3?'Running low':'In stock today'}
                      </div>
                      <div style={{ fontSize:11, color:'var(--t3)' }}>Started with {count.par} portions</div>
                    </div>
                    <div style={{ fontSize:34, fontWeight:800, fontFamily:'var(--font-mono)', color:count.remaining<=3?'var(--acc)':'var(--grn)' }}>
                      {count.remaining}
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div style={{ height:4, background:'var(--bg4)', borderRadius:2, marginTop:10, overflow:'hidden' }}>
                    <div style={{ height:'100%', borderRadius:2, transition:'width .3s', width:`${(count.remaining/count.par)*100}%`, background:count.remaining<=3?'var(--acc)':'var(--grn)' }}/>
                  </div>
                </div>
              )}

              <CountSetter itemId={item.id} current={count} onClose={()=>setTab('info')}/>
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{ padding:'12px 20px', borderTop:'1px solid var(--bdr)', flexShrink:0, display:'flex', gap:8 }}>
          {onToggle86 && (
            <button
              onClick={onToggle86}
              style={{ height:46, padding:'0 16px', borderRadius:12, cursor:'pointer', fontFamily:'inherit',
                border:`1.5px solid ${is86?'var(--red-b)':'var(--bdr2)'}`,
                background:is86?'var(--red-d)':'var(--bg3)',
                color:is86?'var(--red)':'var(--t3)',
                fontSize:12, fontWeight:800, flexShrink:0,
              }}>
              {is86 ? '✕ Un-86' : '86 Item'}
            </button>
          )}
          <button className="btn btn-ghost" style={{ flex:1, height:46 }} onClick={onClose}>Close</button>
          <button className="btn btn-acc" style={{ flex:2, height:46, fontSize:14, fontWeight:800 }}
            onClick={onAddToOrder}>
            + Add to order
          </button>
        </div>
      </div>
    </div>
  );
}
