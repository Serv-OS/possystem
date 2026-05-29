import { useState } from 'react';
import { PIZZA_TOPPINGS, PIZZA_BASES, PIZZA_CRUSTS, PIZZA_SIZES } from '../data/seed';
import { money, currencySymbol } from '../lib/currency';

export default function PizzaBuilder({ item, onConfirm, onCancel }) {
  const [size,   setSize]   = useState(PIZZA_SIZES[1]);       // Large
  const [base,   setBase]   = useState(PIZZA_BASES[0]);       // Tomato
  const [crust,  setCrust]  = useState(PIZZA_CRUSTS[0]);      // Thin
  const [split,  setSplit]  = useState('whole');               // whole | half
  const [side,   setSide]   = useState('whole');               // whole | left | right
  const [left,   setLeft]   = useState(item.defaultToppings ? PIZZA_TOPPINGS.filter(t => item.defaultToppings.includes(t.id)) : []);
  const [right,  setRight]  = useState([]);

  // Derived price
  const toppingCost =
    left.filter(t => !right.find(r => r.id === t.id)).reduce((s,t) => s + t.price * .5, 0) +
    right.filter(t => !left.find(l => l.id === t.id)).reduce((s,t) => s + t.price * .5, 0) +
    left.filter(t =>  right.find(r => r.id === t.id)).reduce((s,t) => s + t.price, 0);
  const total = size.basePrice + (crust.extra || 0) + toppingCost;

  // Toggle a topping on the active side
  const toggleTopping = (top) => {
    const active = side === 'whole' ? null : side;
    if (split === 'whole' || side === 'whole') {
      // whole — toggle both sides simultaneously
      const inL = left.find(t => t.id === top.id);
      if (inL) { setLeft(l => l.filter(t => t.id !== top.id)); setRight(r => r.filter(t => t.id !== top.id)); }
      else      { setLeft(l => [...l, top]); setRight(r => [...r, top]); }
    } else if (side === 'left') {
      setLeft(l => l.find(t => t.id === top.id) ? l.filter(t => t.id !== top.id) : [...l, top]);
    } else {
      setRight(r => r.find(t => t.id === top.id) ? r.filter(t => t.id !== top.id) : [...r, top]);
    }
  };

  const toppingState = (top) => {
    const inL = !!left.find(t => t.id === top.id);
    const inR = !!right.find(t => t.id === top.id);
    if (inL && inR) return 'both';
    if (inL) return 'left';
    if (inR) return 'right';
    return 'off';
  };

  const handleAdd = () => {
    const allergens = [
      ...base.allergens,
      ...crust.allergens || [],
      ...(split === 'whole'
        ? left.flatMap(t => t.allergens)
        : [...left.flatMap(t => t.allergens), ...right.flatMap(t => t.allergens)]),
    ];
    const unique = [...new Set([...item.allergens, ...allergens])];
    onConfirm({
      ...item,
      allergens: unique,
      price: total,
    }, [], {
      size, base, crust, split,
      toppings: { left, right, whole: split === 'whole' ? left : [] },
    });
  };

  const sideColor = { left: '#3b82f6', right: '#22c55e', both: '#a855f7', whole: '#f0a500' };

  // SVG pizza visual
  const PizzaSVG = ({ w = 160 }) => {
    const cx = w/2, cy = w/2, r = w/2 - 8, ir = r - 12;
    const activeTops = split === 'whole' ? left : side === 'left' ? left : right;
    const lPos = [[.3,.3],[.25,.55],[.35,.7],[.2,.42],[.4,.8]].map(([px,py])=>[ cx - r*px*1.4, cy - r*(py-.5)*1.6]);
    const rPos = [[.7,.3],[.75,.55],[.65,.7],[.8,.42],[.6,.8]].map(([px,py])=>[ cx + r*(px-.5)*2.2, cy - r*(py-.5)*1.6]);

    return (
      <svg width={w} height={w} viewBox={`0 0 ${w} ${w}`} style={{ display:'block' }}>
        {split === 'whole' ? (
          <>
            <circle cx={cx} cy={cy} r={r} fill={side==='whole'?'#2a2006':'#1a1506'} stroke={`${sideColor.whole}66`} strokeWidth="2"/>
            <circle cx={cx} cy={cy} r={ir} fill="none" stroke={`${sideColor.whole}22`} strokeWidth="1" strokeDasharray="3 3"/>
          </>
        ) : (
          <>
            <path d={`M${cx},${cy-r} A${r},${r} 0 0,0 ${cx},${cy+r} L${cx},${cy} Z`}
              fill={side==='left'?'#0e1e3a':'#0a1220'}
              stroke={`${sideColor.left}${side==='left'?'aa':'44'}`} strokeWidth="2"
              onClick={() => setSide('left')} style={{ cursor:'pointer' }}/>
            <path d={`M${cx},${cy-r} A${r},${r} 0 0,1 ${cx},${cy+r} L${cx},${cy} Z`}
              fill={side==='right'?'#0a2818':'#071a0f'}
              stroke={`${sideColor.right}${side==='right'?'aa':'44'}`} strokeWidth="2"
              onClick={() => setSide('right')} style={{ cursor:'pointer' }}/>
            <line x1={cx} y1={cy-r+4} x2={cx} y2={cy+r-4} stroke="rgba(255,255,255,.2)" strokeWidth="1.5" strokeDasharray="5 4"/>
            <text x={cx*.5} y={cy+4} textAnchor="middle" fontSize="10" fill={side==='left'?sideColor.left:'rgba(255,255,255,.25)'} fontFamily="Inter">Left</text>
            <text x={cx*1.5} y={cy+4} textAnchor="middle" fontSize="10" fill={side==='right'?sideColor.right:'rgba(255,255,255,.25)'} fontFamily="Inter">Right</text>
          </>
        )}
        {/* Left toppings */}
        {(split==='whole'?left:left).map((t,i) => {
          const [tx,ty] = lPos[i % lPos.length];
          return <circle key={t.id+'l'} cx={tx} cy={ty} r={7} fill={t.color} opacity=".9"/>;
        })}
        {/* Right toppings (only in half mode) */}
        {split==='half' && right.map((t,i) => {
          const [tx,ty] = rPos[i % rPos.length];
          return <circle key={t.id+'r'} cx={tx} cy={ty} r={7} fill={t.color} opacity=".9"/>;
        })}
      </svg>
    );
  };

  return (
    <div className="modal-back" style={{ alignItems:'flex-start', paddingTop: 20 }}>
      <div style={{
        background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:24,
        width:'100%', maxWidth:640, maxHeight:'92vh', overflow:'auto',
        boxShadow:'var(--sh3)',
      }}>
        {/* Header */}
        <div style={{ padding:'20px 24px 0', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontSize:18, fontWeight:600 }}>{item.name}</div>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 200px', gap:0 }}>
          {/* Left column — builder */}
          <div style={{ padding:'20px 24px', borderRight:'1px solid var(--bdr)' }}>

            {/* Size */}
            <div style={{ marginBottom:18 }}>
              <div className="label-xs" style={{ marginBottom:8 }}>Size</div>
              <div style={{ display:'flex', gap:6 }}>
                {PIZZA_SIZES.map(s => (
                  <button key={s.id} onClick={() => setSize(s)} style={{
                    flex:1, padding:'10px 6px', borderRadius:10, cursor:'pointer',
                    border:`1.5px solid ${size.id===s.id?'var(--acc)':'var(--bdr)'}`,
                    background: size.id===s.id?'var(--acc-d)':'var(--bg3)',
                    transition:'all .12s',
                  }}>
                    <div style={{ fontSize:12, fontWeight:500, color: size.id===s.id?'var(--acc)':'var(--t1)' }}>{s.name}</div>
                    <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{money(s.basePrice)}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Base */}
            <div style={{ marginBottom:18 }}>
              <div className="label-xs" style={{ marginBottom:8 }}>Base</div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {PIZZA_BASES.map(b => (
                  <button key={b.id} onClick={() => setBase(b)} style={{
                    padding:'6px 12px', borderRadius:8, cursor:'pointer', fontSize:12, fontWeight:500,
                    border:`1.5px solid ${base.id===b.id?'var(--acc)':'var(--bdr)'}`,
                    background: base.id===b.id?'var(--acc-d)':'var(--bg3)',
                    color: base.id===b.id?'var(--acc)':'var(--t2)',
                    transition:'all .12s',
                  }}>{b.name}</button>
                ))}
              </div>
            </div>

            {/* Crust */}
            <div style={{ marginBottom:18 }}>
              <div className="label-xs" style={{ marginBottom:8 }}>Crust</div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {PIZZA_CRUSTS.map(c => (
                  <button key={c.id} onClick={() => setCrust(c)} style={{
                    padding:'6px 12px', borderRadius:8, cursor:'pointer', fontSize:12, fontWeight:500,
                    border:`1.5px solid ${crust.id===c.id?'var(--acc)':'var(--bdr)'}`,
                    background: crust.id===c.id?'var(--acc-d)':'var(--bg3)',
                    color: crust.id===c.id?'var(--acc)':'var(--t2)',
                    transition:'all .12s',
                  }}>
                    {c.name}{c.extra?<span style={{fontSize:10,opacity:.7}}> +{money(c.extra)}</span>:null}
                  </button>
                ))}
              </div>
            </div>

            {/* Split */}
            <div style={{ marginBottom:18 }}>
              <div className="label-xs" style={{ marginBottom:8 }}>Split style</div>
              <div style={{ display:'flex', border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden' }}>
                {[['whole','Whole pizza'],['half','Half & half']].map(([v,l]) => (
                  <button key={v} onClick={() => { setSplit(v); setSide(v==='whole'?'whole':'left'); }} style={{
                    flex:1, padding:'9px 6px', cursor:'pointer', fontSize:12, fontWeight:500,
                    background: split===v?'var(--acc)':'transparent',
                    color: split===v?'#0e0f14':'var(--t2)',
                    border:'none', transition:'all .15s', fontFamily:'inherit',
                  }}>{l}</button>
                ))}
              </div>
            </div>

            {/* Pizza visual + side selector (half mode) */}
            {split === 'half' && (
              <div style={{ marginBottom:16 }}>
                <div style={{ display:'flex', justifyContent:'center', marginBottom:10 }}>
                  <PizzaSVG w={160}/>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  {['left','right'].map(s => {
                    const count = (s==='left'?left:right).length;
                    return (
                      <button key={s} onClick={() => setSide(s)} style={{
                        flex:1, padding:'9px 8px', borderRadius:10, cursor:'pointer',
                        border:`1.5px solid ${side===s?sideColor[s]:'var(--bdr)'}`,
                        background: side===s?(s==='left'?'rgba(59,130,246,.08)':'rgba(34,197,94,.08)'):'var(--bg3)',
                        transition:'all .12s',
                      }}>
                        <div style={{ fontSize:12, fontWeight:600, color: side===s?sideColor[s]:'var(--t2)' }}>
                          {s.charAt(0).toUpperCase()+s.slice(1)} half
                        </div>
                        <div style={{ fontSize:10, color:'var(--t3)', marginTop:2 }}>
                          {count} topping{count!==1?'s':''}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {split==='half' && (
                  <div style={{ marginTop:8, padding:'7px 10px', borderRadius:8, fontSize:12,
                    background: side==='left'?'rgba(59,130,246,.08)':'rgba(34,197,94,.08)',
                    color: side==='left'?sideColor.left:sideColor.right,
                    border:`1px solid ${side==='left'?sideColor.left+'44':sideColor.right+'44'}`,
                  }}>
                    Tapping toppings below adds to the <strong>{side}</strong> half
                  </div>
                )}
              </div>
            )}
            {split === 'whole' && (
              <div style={{ display:'flex', justifyContent:'center', marginBottom:12 }}>
                <PizzaSVG w={140}/>
              </div>
            )}

            {/* Toppings */}
            <div>
              <div className="label-xs" style={{ marginBottom:8 }}>Toppings</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6 }}>
                {PIZZA_TOPPINGS.map(top => {
                  const st = toppingState(top);
                  const active = st !== 'off';
                  const stColor = st==='both'?sideColor.both:st==='left'?sideColor.left:st==='right'?sideColor.right:sideColor.whole;
                  return (
                    <button key={top.id} onClick={() => toggleTopping(top)} style={{
                      padding:'8px 6px', borderRadius:9, cursor:'pointer', textAlign:'center',
                      border:`1.5px solid ${active?stColor+'88':'var(--bdr)'}`,
                      background: active?stColor+'18':'var(--bg3)',
                      transition:'all .12s',
                    }}>
                      <div style={{ width:10,height:10,borderRadius:'50%',background:top.color,margin:'0 auto 4px' }}/>
                      <div style={{ fontSize:10, fontWeight:500, color: active?stColor:'var(--t2)', lineHeight:1.2 }}>{top.name}</div>
                      {top.price>0&&<div style={{ fontSize:9, color:'var(--t3)', marginTop:2 }}>+{currencySymbol()}{top.price}</div>}
                      {st!=='off'&&st!=='whole'&&<div style={{ fontSize:9, fontWeight:600, color:stColor, marginTop:2 }}>{st}</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right column — summary */}
          <div style={{ padding:'20px 16px', display:'flex', flexDirection:'column' }}>
            <div className="label-xs" style={{ marginBottom:12 }}>Your pizza</div>

            <div style={{ fontSize:12, color:'var(--t2)', marginBottom:8 }}>
              {size.name} · {crust.name}
            </div>
            <div style={{ fontSize:12, color:'var(--t2)', marginBottom:12 }}>
              {base.name}
            </div>

            {split==='half' ? (
              <>
                <div style={{ background:'rgba(59,130,246,.08)', borderRadius:8, padding:'8px 10px', marginBottom:6 }}>
                  <div style={{ fontSize:10, fontWeight:600, color:sideColor.left, marginBottom:4 }}>LEFT HALF</div>
                  {left.length ? left.map(t=><div key={t.id} style={{display:'flex',alignItems:'center',gap:6,fontSize:11,color:'var(--t2)',marginBottom:2}}><div style={{width:8,height:8,borderRadius:'50%',background:t.color}}/>{t.name}</div>) : <div style={{fontSize:11,color:'var(--t3)',fontStyle:'italic'}}>No toppings</div>}
                </div>
                <div style={{ background:'rgba(34,197,94,.08)', borderRadius:8, padding:'8px 10px', marginBottom:12 }}>
                  <div style={{ fontSize:10, fontWeight:600, color:sideColor.right, marginBottom:4 }}>RIGHT HALF</div>
                  {right.length ? right.map(t=><div key={t.id} style={{display:'flex',alignItems:'center',gap:6,fontSize:11,color:'var(--t2)',marginBottom:2}}><div style={{width:8,height:8,borderRadius:'50%',background:t.color}}/>{t.name}</div>) : <div style={{fontSize:11,color:'var(--t3)',fontStyle:'italic'}}>No toppings</div>}
                </div>
              </>
            ) : (
              <div style={{ background:'rgba(240,165,0,.08)', borderRadius:8, padding:'8px 10px', marginBottom:12 }}>
                <div style={{ fontSize:10, fontWeight:600, color:'var(--acc)', marginBottom:4 }}>WHOLE PIZZA</div>
                {left.length ? left.map(t=><div key={t.id} style={{display:'flex',alignItems:'center',gap:6,fontSize:11,color:'var(--t2)',marginBottom:2}}><div style={{width:8,height:8,borderRadius:'50%',background:t.color}}/>{t.name}</div>) : <div style={{fontSize:11,color:'var(--t3)',fontStyle:'italic'}}>Cheese only</div>}
              </div>
            )}

            <div style={{ marginTop:'auto' }}>
              <div style={{ borderTop:'1px solid var(--bdr)', paddingTop:12, marginBottom:12 }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t3)', marginBottom:3 }}>
                  <span>Base</span><span>{money(size.basePrice)}</span>
                </div>
                {crust.extra>0&&<div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t3)', marginBottom:3 }}>
                  <span>{crust.name}</span><span>+{money(crust.extra)}</span>
                </div>}
                {toppingCost>0&&<div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t3)', marginBottom:3 }}>
                  <span>Toppings</span><span>+{money(toppingCost)}</span>
                </div>}
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:16, fontWeight:600, marginTop:8, color:'var(--acc)' }}>
                  <span>Total</span><span>{money(total)}</span>
                </div>
              </div>
              <button className="btn btn-acc btn-full" onClick={handleAdd}>
                Add to order →
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
