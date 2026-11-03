import AIChat from '../../components/AIChat';
import { Icon } from '../../components/ServOSIcons';

export default function AIAssistantSection() {
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
      {/* Header */}
      <div style={{ padding:'16px 24px 14px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:'var(--acc-d)', border:'1px solid var(--acc-b)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>✦</div>
          <div>
            <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>AI Assistant</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>Sales · Menu · Servers · Floor · Reporting</div>
          </div>
          <div style={{ marginLeft:'auto', padding:'4px 10px', borderRadius:20, background:'var(--acc-d)', border:'1px solid var(--acc-b)', fontSize:11, fontWeight:700, color:'var(--acc)' }}>
            Claude Sonnet
          </div>
        </div>

        {/* Capabilities */}
        <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:12 }}>
          {[['chart', 'Sales & revenue'], ['beer', 'Item sales lookup'], ['clock', 'Hourly breakdown'], ['user', 'Server performance'], ['seat', 'Open tables'], ['card', 'Payment breakdown'], ['clipboard', 'Menu & allergens'], ['sparkles', 'Add/update items']].map(([ic, c]) => (
            <span key={c} style={{ fontSize:11, padding:'3px 8px', borderRadius:20, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t3)', fontWeight:600, display:'inline-flex', alignItems:'center', gap:5 }}><Icon name={ic} size={12} />{c}</span>
          ))}
        </div>

        <div style={{ marginTop:10, padding:'8px 12px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', fontSize:11, color:'var(--t4)', lineHeight:1.6 }}>
          <strong style={{ color:'var(--t3)' }}>Safe by design:</strong> The AI can only read data and propose changes. Writes require your explicit confirmation and cannot delete anything.
        </div>
      </div>

      {/* Chat */}
      <div style={{ flex:1, overflow:'hidden' }}>
        <AIChat
          mode="boh"
          placeholder="Try: 'How many lattes today?' · 'Who's sold the most?' · 'What's been my busiest hour?'"
        />
      </div>
    </div>
  );
}
