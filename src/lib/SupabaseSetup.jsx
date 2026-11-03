import { useState } from 'react';
import { isMock } from './supabase';
import { Icon } from '../components/ServOSIcons';

/**
 * Shown in the Back Office when Supabase is not yet configured.
 * Guides the user through getting their project URL and anon key.
 */
export default function SupabaseSetup() {
  const [step, setStep] = useState(1);

  if (!isMock) return null; // Only show when in mock mode

  return (
    <div style={{
      padding:'24px 28px', background:'var(--acc-d)',
      border:'1.5px solid var(--acc-b)', borderRadius:14, marginBottom:20,
    }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:14 }}>
        <div style={{ fontSize:24, flexShrink:0, marginTop:2, color:'var(--acc)' }}><Icon name="plug" size={24} /></div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:800, color:'var(--acc)', marginBottom:4 }}>
            Running in demo mode — Supabase not connected
          </div>
          <div style={{ fontSize:12, color:'var(--t2)', marginBottom:12, lineHeight:1.6 }}>
            Data is stored in your browser only. To persist data across devices and enable real multi-terminal sync, connect a Supabase project.
          </div>

          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {[
              { n:1, label:'Create a free Supabase project', url:'https://supabase.com/dashboard', action:'Open Supabase →' },
              { n:2, label:'Run the schema SQL in your project', url:null, action:'Copy schema SQL' },
              { n:3, label:'Add your project URL + anon key to .env.local', url:null, action:'View .env.example' },
            ].map(s => (
              <div key={s.n} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', background:'var(--bg1)', borderRadius:9, border:'1px solid var(--bdr)' }}>
                <div style={{ width:22, height:22, borderRadius:'50%', background:'var(--acc)', color:'#0b0c10', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:800, flexShrink:0 }}>{s.n}</div>
                <span style={{ flex:1, fontSize:12, color:'var(--t1)' }}>{s.label}</span>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noopener" style={{ fontSize:11, fontWeight:700, color:'var(--acc)', textDecoration:'none' }}>{s.action}</a>
                ) : (
                  <button onClick={() => {
                    if (s.n === 2) {
                      fetch('/supabase-schema.sql').then(r => r.text()).then(sql => {
                        navigator.clipboard?.writeText(sql);
                        alert('Schema SQL copied to clipboard');
                      }).catch(() => alert('Open supabase-schema.sql in the project root'));
                    }
                    if (s.n === 3) {
                      alert('Copy .env.example to .env.local and fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from your Supabase project settings.');
                    }
                  }} style={{ fontSize:11, fontWeight:700, color:'var(--acc)', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit' }}>{s.action}</button>
                )}
              </div>
            ))}
          </div>
          <div style={{ marginTop:10, fontSize:11, color:'var(--t4)' }}>
            Demo mode syncs across browser tabs only. All data resets when localStorage is cleared.
          </div>
        </div>
      </div>
    </div>
  );
}
