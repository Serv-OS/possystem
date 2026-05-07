// MVoiceOrder — voice-to-order. Server holds the phone, taps the mic, says
// "two cheeseburgers, one with no pickle, large fries, two cokes". On stop
// the transcript is sent to /api/voice-order which uses Claude with a
// menu-aware tool to return structured items. Server reviews + confirms,
// then items are added via the existing addItem store action — same path
// the manual menu flow uses.
//
// Web Speech API:
//   • iOS Safari 14.5+ supports webkitSpeechRecognition with hard mic perms
//   • Chrome on Android supports SpeechRecognition natively
//   • Falls back to "not supported" message on Firefox + older Safari — phase
//     1E native shells will provide a Whisper bridge for those
//
// Permission: triggered the first time the user taps the mic. After grant,
// remains permitted for the life of the page.

import { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store';
import { Sx, money } from './MShellStyles';

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;
const supported = !!SpeechRecognitionImpl;

export default function MVoiceOrder({ onClose }) {
  const { menuItems = [], addItem, setOrderNote } = useStore();
  const [phase, setPhase] = useState('ready'); // ready | listening | parsing | confirm | error
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [parsed, setParsed] = useState(null); // { items: [...], order_note, clarification }
  const [error, setError] = useState(null);
  const recogRef = useRef(null);
  const silenceTimerRef = useRef(null);

  // ── Mic / recognition lifecycle ──────────────────────────────────────────
  const start = () => {
    if (!supported) { setError('Voice ordering not supported in this browser. Use Chrome on Android or Safari on iOS, or wait for the native shell.'); setPhase('error'); return; }
    setError(null); setTranscript(''); setInterim('');
    const r = new SpeechRecognitionImpl();
    r.lang = 'en-GB';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let finalText = '';
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript + ' ';
        else interimText += res[0].transcript;
      }
      if (finalText) setTranscript(t => (t + finalText).trim() + ' ');
      setInterim(interimText.trim());
      // Auto-stop on 1.5s of silence after at least one final result
      if (finalText) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => stopAndParse(), 1500);
      }
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech') return; // benign — keep listening
      if (e.error === 'aborted') return;   // we stopped it ourselves
      setError(`Mic error: ${e.error}`); setPhase('error');
    };
    r.onend = () => {
      // If we got here without explicit stopAndParse (e.g. 60s timeout), trigger parse if there's content
      const t = (transcript + ' ' + interim).trim();
      if (phase === 'listening' && t) {
        // small delay so ref state reads through
        setTimeout(() => stopAndParse(), 50);
      }
    };
    recogRef.current = r;
    setPhase('listening');
    try { r.start(); } catch (e) { setError(e?.message || 'Could not start mic'); setPhase('error'); }
  };

  const stopRecording = () => {
    clearTimeout(silenceTimerRef.current);
    if (recogRef.current) {
      try { recogRef.current.stop(); } catch {}
    }
  };

  const stopAndParse = async () => {
    stopRecording();
    const fullText = (transcript + ' ' + interim).trim();
    setInterim('');
    if (!fullText) {
      setError('Did not hear anything — tap the mic and try again.');
      setPhase('error'); return;
    }
    setPhase('parsing');
    try {
      const res = await fetch('/api/voice-order', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({ transcript: fullText, menu: menuItems }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setParsed(j);
      setPhase('confirm');
    } catch (e) {
      setError(e?.message || 'Could not parse order'); setPhase('error');
    }
  };

  const confirm = () => {
    if (!parsed?.items?.length) { onClose?.(); return; }
    parsed.items.forEach(p => {
      const item = menuItems.find(m => m.id === p.item_id);
      if (!item) return;
      const mods = (p.mod_labels || []).map(label => ({
        id: `voice-${label}`, name: label, label, price: 0, _instruction: true,
      }));
      addItem(item, mods, null, { qty: Math.max(1, Math.round(p.qty || 1)), notes: (p.notes || '').trim() || undefined });
    });
    if (parsed.order_note?.trim()) setOrderNote(parsed.order_note.trim());
    onClose?.();
  };

  // Cleanup on unmount
  useEffect(() => () => { stopRecording(); }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.7)', zIndex:60, display:'flex', alignItems:'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width:'100%', maxWidth:540, margin:'0 auto', background:'var(--bg1)', borderRadius:'18px 18px 0 0',
        padding:'14px 14px calc(18px + env(safe-area-inset-bottom)) 14px',
        boxShadow:'0 -10px 32px rgba(0,0,0,.5)', maxHeight:'92svh', overflowY:'auto',
        display:'flex', flexDirection:'column',
      }}>
        <div style={{ width:36, height:4, borderRadius:2, background:'var(--bdr2)', margin:'0 auto 14px' }}/>

        <div style={{ textAlign:'center', marginBottom:14 }}>
          <div style={{ fontSize:11, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:800 }}>Voice order</div>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginTop:4 }}>
            {phase === 'ready' && 'Speak the order'}
            {phase === 'listening' && 'Listening…'}
            {phase === 'parsing' && 'Parsing your order'}
            {phase === 'confirm' && 'Confirm items'}
            {phase === 'error' && 'Voice order failed'}
          </div>
          {phase === 'ready' && (
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:6, lineHeight:1.4 }}>
              Tap the mic and say the order naturally. Pause for a moment to finish.
            </div>
          )}
        </div>

        {/* Mic button — big, central */}
        {(phase === 'ready' || phase === 'listening' || phase === 'error') && (
          <div style={{ display:'flex', justifyContent:'center', padding:'18px 0 8px' }}>
            <button
              onClick={phase === 'listening' ? stopAndParse : start}
              aria-label={phase === 'listening' ? 'Stop and parse' : 'Start recording'}
              style={{
                width:120, height:120, borderRadius:'50%', border:'none', cursor:'pointer', fontFamily:'inherit',
                background: phase === 'listening' ? 'var(--red)' : 'var(--acc)',
                color:'#0b0c10', fontSize:48, fontWeight:800,
                boxShadow: phase === 'listening' ? '0 0 0 8px rgba(239,68,68,0.2), 0 0 0 24px rgba(239,68,68,0.1)' : '0 6px 22px rgba(0,0,0,.35)',
                animation: phase === 'listening' ? 'mpos-pulse 1.6s infinite' : 'none',
                transition:'background .18s',
              }}>
              {phase === 'listening' ? '■' : '🎤'}
            </button>
          </div>
        )}

        {/* Live transcript */}
        {(phase === 'listening' || transcript) && phase !== 'confirm' && (
          <div style={{
            margin:'10px 0', padding:'14px 16px', borderRadius:14,
            background:'var(--bg2)', border:'1px solid var(--bdr)',
            minHeight:80, fontSize:14, color:'var(--t1)', lineHeight:1.5,
          }}>
            <span>{transcript}</span>
            <span style={{ color:'var(--t4)', fontStyle:'italic' }}>{interim ? ` ${interim}` : ''}</span>
            {!transcript && !interim && phase === 'listening' && (
              <span style={{ color:'var(--t4)', fontStyle:'italic' }}>Listening…</span>
            )}
          </div>
        )}

        {/* Parsing spinner */}
        {phase === 'parsing' && (
          <div style={{ textAlign:'center', padding:'24px 0', color:'var(--t3)' }}>
            <div style={{ display:'inline-block', width:32, height:32, borderRadius:'50%', border:'3px solid var(--bdr)', borderTopColor:'var(--acc)', animation:'mpos-spin .8s linear infinite' }}/>
            <div style={{ marginTop:10, fontSize:13 }}>Mapping to menu items…</div>
          </div>
        )}

        {/* Confirm parsed items */}
        {phase === 'confirm' && parsed && (
          <div>
            {parsed.clarification && (
              <div style={{ padding:'10px 12px', borderRadius:10, background:'var(--acc-d)', border:'1px solid var(--acc-b)', color:'var(--acc)', fontSize:12, marginBottom:10, fontWeight:700, display:'flex', gap:8, alignItems:'flex-start' }}>
                <span>❓</span><span>{parsed.clarification}</span>
              </div>
            )}
            {parsed.items.length === 0 ? (
              <div style={{ padding:'18px 12px', textAlign:'center', color:'var(--t3)', fontSize:13 }}>
                No items mapped from "{transcript}". Try again with clearer item names.
              </div>
            ) : (
              <>
                <div style={{ fontSize:11, color:'var(--t3)', textTransform:'uppercase', fontWeight:700, letterSpacing:'.06em', marginBottom:8 }}>
                  Adding {parsed.items.reduce((s, i) => s + (i.qty || 0), 0)} items
                </div>
                {parsed.items.map((p, i) => {
                  const item = menuItems.find(m => m.id === p.item_id);
                  if (!item) return null;
                  const price = item?.pricing?.base ?? item?.price ?? 0;
                  return (
                    <div key={i} style={{ padding:'10px 12px', background:'var(--bg2)', borderRadius:11, border:'1px solid var(--bdr)', marginBottom:6, display:'flex', gap:10 }}>
                      <div style={{ fontSize:12, fontWeight:800, color:'var(--t4)', fontFamily:'var(--font-mono)', minWidth:24, paddingTop:1 }}>
                        {p.qty}×
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{item.name}</div>
                        {(p.mod_labels || []).length > 0 && (
                          <div style={{ fontSize:11, color:'var(--acc)', marginTop:1 }}>{p.mod_labels.join(' · ')}</div>
                        )}
                        {p.notes && <div style={{ fontSize:11, color:'var(--acc)', marginTop:1 }}>📝 {p.notes}</div>}
                      </div>
                      <div style={{ fontSize:13, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)' }}>
                        {money(price * (p.qty || 1))}
                      </div>
                    </div>
                  );
                })}
                {parsed.order_note && (
                  <div style={{ padding:'8px 12px', borderRadius:10, background:'var(--acc-d)', border:'1px solid var(--acc-b)', marginTop:8, fontSize:12, color:'var(--acc)' }}>
                    📝 Order note: {parsed.order_note}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Error state */}
        {error && (
          <div style={{ margin:'10px 0', padding:10, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>
            {error}
          </div>
        )}

        {/* Bottom buttons */}
        <div style={{ marginTop:'auto', paddingTop:14 }}>
          {phase === 'confirm' && parsed?.items?.length > 0 && (
            <button onClick={confirm} style={Sx.btnPrim}>
              ✓ Add {parsed.items.length} item{parsed.items.length === 1 ? '' : 's'} to order
            </button>
          )}
          {phase === 'confirm' && (!parsed?.items?.length) && (
            <button onClick={() => { setParsed(null); setTranscript(''); setPhase('ready'); }} style={Sx.btnPrim}>
              🎤 Try again
            </button>
          )}
          {(phase === 'error') && (
            <button onClick={() => { setError(null); setPhase('ready'); setTranscript(''); }} style={Sx.btnPrim}>
              🎤 Try again
            </button>
          )}
          <button onClick={onClose} style={{ ...Sx.btnGhost, marginTop:8 }}>
            {phase === 'confirm' ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>

      {/* Inline animations — kept here so MVoiceOrder is self-contained */}
      <style>{`
        @keyframes mpos-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,.3), 0 0 0 0 rgba(239,68,68,.15); } 50% { box-shadow: 0 0 0 14px rgba(239,68,68,.25), 0 0 0 30px rgba(239,68,68,.10); } }
        @keyframes mpos-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
