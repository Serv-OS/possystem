// Shared phone-native styles for MPOS. Imported by every screen so the look stays
// consistent and we centralise the safe-area-inset handling, touch targets, etc.

export const Sx = {
  shell: {
    display:'flex', flexDirection:'column', height:'100vh', width:'100vw',
    maxWidth:540, margin:'0 auto', background:'var(--bg)', color:'var(--t1)',
    overflow:'hidden', fontFamily:'inherit', WebkitTapHighlightColor:'transparent',
    paddingTop:'env(safe-area-inset-top)',
  },
  header: {
    padding:'10px 14px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)',
    display:'flex', alignItems:'center', gap:10, flexShrink:0,
  },
  hTitle: { flex:1, fontSize:15, fontWeight:800, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' },
  hSub:   { fontSize:10, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:700, marginTop:2 },
  iconBtn: {
    width:38, height:38, borderRadius:10, border:'1px solid var(--bdr2)', background:'var(--bg2)',
    color:'var(--t2)', fontSize:18, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
    flexShrink:0, fontFamily:'inherit',
  },
  body:     { flex:1, overflow:'hidden', display:'flex', flexDirection:'column', minHeight:0, position:'relative' },
  scroller: { flex:1, overflowY:'auto', WebkitOverflowScrolling:'touch' },
  bottom:   {
    padding:'10px 12px calc(10px + env(safe-area-inset-bottom)) 12px',
    borderTop:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0,
  },
  btnPrim:  { width:'100%', padding:'14px 16px', borderRadius:12, border:'none', background:'var(--acc)', color:'#0b0c10', fontSize:15, fontWeight:800, fontFamily:'inherit', cursor:'pointer', minHeight:52 },
  btnGhost: { width:'100%', padding:'12px 16px', borderRadius:12, border:'1px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t2)', fontSize:14, fontWeight:700, fontFamily:'inherit', cursor:'pointer', minHeight:48 },
  card:     { padding:'12px 14px', background:'var(--bg2)', borderRadius:12, border:'1px solid var(--bdr)', marginBottom:8 },
  cardRow:  { padding:'12px 14px', background:'var(--bg2)', borderRadius:12, border:'1px solid var(--bdr)', marginBottom:8, display:'flex', alignItems:'center', gap:10, cursor:'pointer', minHeight:64 },
  pill:     { fontSize:10, padding:'2px 8px', borderRadius:99, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em' },
  sectionH: { fontSize:11, fontWeight:800, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', padding:'18px 14px 8px', display:'flex', alignItems:'center', justifyContent:'space-between' },
  emptyBlock: { textAlign:'center', padding:'48px 16px', color:'var(--t4)' },
};

export const money = (n) => `£${(Number(n) || 0).toFixed(2)}`;

export function elapsed(date) {
  if (!date) return '';
  const t = typeof date === 'number' ? date : new Date(date).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

export const STATUS_PILL = {
  available:  { bg:'var(--bg3)',   fg:'var(--t3)',  border:'var(--bdr)',   label:'Available' },
  open:       { bg:'var(--acc-d)', fg:'var(--acc)', border:'var(--acc-b)', label:'Open' },
  occupied:   { bg:'var(--acc-d)', fg:'var(--acc)', border:'var(--acc-b)', label:'Occupied' },
  bill:       { bg:'var(--red-d)', fg:'var(--red)', border:'var(--red-b)', label:'Bill req' },
  bill_req:   { bg:'var(--red-d)', fg:'var(--red)', border:'var(--red-b)', label:'Bill req' },
  received:   { bg:'#3b82f618',    fg:'#3b82f6',    border:'#3b82f644',    label:'Received' },
  prep:       { bg:'#e8a02018',    fg:'#e8a020',    border:'#e8a02044',    label:'In prep' },
  ready:      { bg:'var(--grn-d)', fg:'var(--grn)', border:'var(--grn-b)', label:'Ready' },
  collected:  { bg:'var(--bg3)',   fg:'var(--t4)',  border:'var(--bdr)',   label:'Collected' },
  paid:       { bg:'var(--bg3)',   fg:'var(--t4)',  border:'var(--bdr)',   label:'Paid' },
  pending_cash: { bg:'#f9731618', fg:'#f97316', border:'#f9731644', label:'Cash at counter' },
};
