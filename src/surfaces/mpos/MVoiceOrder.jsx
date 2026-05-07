// MVoiceOrder — voice-to-order. Server holds the phone, taps the mic, says
// "two cheeseburgers, one with no pickle, large fries, two cokes". On stop
// the transcript is sent to /api/voice-order which uses Claude with a
// menu-aware tool to return structured items. Server reviews + confirms,
// then items are added via the existing addItem store action.
//
// v5.5.71 reliability rewrite. Earlier version had two bugs:
//   1. iOS Safari's SpeechRecognition auto-stops after ~6s of silence (or any
//      lull) regardless of continuous:true. We now restart the recogniser
//      automatically while the user is still in "listening" phase, and
//      preserve the transcript across restarts using refs so closures don't
//      see stale state.
//   2. The only Stop control was the central mic toggle. If a user couldn't
//      tap it (or recognition had already auto-stopped silently), the screen
//      was stuck. We now always render a separate, prominent Stop & Use Text
//      button below the live transcript, plus an explicit "I'm finished"
//      action when iOS forces an early end.

import { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store';
import { Sx, money } from './MShellStyles';
import MBottomSheet from './MBottomSheet';

const SpeechRecognitionImpl =
  typeof window !== 'undefined'
    ? (window.SpeechRecognition || window.webkitSpeechRecognition)
    : null;
const supported = !!SpeechRecognitionImpl;

export default function MVoiceOrder({ onClose }) {
  const { menuItems = [], addItem, setOrderNote } = useStore();
  const [phase, setPhase] = useState('ready'); // ready | listening | parsing | confirm | error
  const [transcriptUI, setTranscriptUI] = useState('');
  const [interimUI, setInterimUI] = useState('');
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);

  // Refs hold the LATEST values so SpeechRecognition handlers (which capture
  // stale closures from when start() ran) can read what's actually current.
  const phaseRef = useRef('ready');
  const transcriptRef = useRef('');
  const recogRef = useRef(null);
  const userStoppedRef = useRef(false);

  const setPhaseSafe = (p) => { phaseRef.current = p; setPhase(p); };

  // ── Recognition lifecycle ────────────────────────────────────────────────
  const buildRecognition = () => {
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
      if (finalText) {
        transcriptRef.current = (transcriptRef.current + ' ' + finalText).trim() + ' ';
        setTranscriptUI(transcriptRef.current);
      }
      setInterimUI(interimText.trim());
    };
    r.onerror = (e) => {
      // 'no-speech' fires when iOS hears silence. We just restart in that
      // case — don't surface it as an error to the user.
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.warn('[voice] recognition error', e.error);
      setError(`Mic error: ${e.error}. Tap the mic to retry.`);
      setPhaseSafe('error');
    };
    r.onend = () => {
      // iOS Safari aggressively ends recognition; while the user is still in
      // listening phase AND hasn't explicitly stopped, restart it. The
      // transcriptRef survives across restarts so we don't lose anything.
      if (phaseRef.current === 'listening' && !userStoppedRef.current) {
        try { r.start(); } catch (e) { /* sometimes "already started" — fine */ }
      }
    };
    return r;
  };

  const start = () => {
    if (!supported) {
      setError('Voice ordering isn\'t supported in this browser. Use Chrome on Android or Safari on iOS, or wait for the native shell.');
      setPhaseSafe('error');
      return;
    }
    setError(null);
    transcriptRef.current = '';
    userStoppedRef.current = false;
    setTranscriptUI('');
    setInterimUI('');
    const r = buildRecognition();
    recogRef.current = r;
    setPhaseSafe('listening');
    try { r.start(); }
    catch (e) {
      setError(e?.message || 'Could not start mic — check browser permissions');
      setPhaseSafe('error');
    }
  };

  // User-initiated stop. Sets a flag so onend doesn't restart, then triggers parse.
  const stopAndParse = async () => {
    userStoppedRef.current = true;
    if (recogRef.current) {
      try { recogRef.current.stop(); } catch {}
    }
    const fullText = (transcriptRef.current + ' ' + interimUI).trim();
    if (!fullText) {
      setError('Did not hear anything. Tap the mic and speak a bit louder, or check your phone\'s mic permission.');
      setPhaseSafe('error');
      return;
    }
    setPhaseSafe('parsing');
    try {
      const res = await fetch('/api/voice-order', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({ transcript: fullText, menu: menuItems }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setParsed(j);
      setPhaseSafe('confirm');
    } catch (e) {
      setError(e?.message || 'Could not parse order');
      setPhaseSafe('error');
    }
  };

  // Cancel mid-recording (back out without parsing)
  const cancelRecording = () => {
    userStoppedRef.current = true;
    if (recogRef.current) { try { recogRef.current.stop(); } catch {} }
    transcriptRef.current = '';
    setTranscriptUI(''); setInterimUI('');
    setPhaseSafe('ready');
  };

  const confirm = () => {
    if (!parsed?.items?.length) { onClose?.(); return; }
    parsed.items.forEach(p => {
      const item = menuItems.find(m => m.id === p.item_id);
      if (!item) return;
      // Defensive: never add a parent-variant container item directly. The
      // server-side filter already drops these from the prompt, but if the
      // model returns one anyway (e.g. due to fuzzy id reasoning) we skip it
      // rather than adding a £0 placeholder line. The clarification banner
      // covers the user-visible side.
      if ((item.type || 'simple') === 'variants') {
        console.warn('[voice] refusing to add parent-variant item', item.id);
        return;
      }
      const mods = (p.mod_labels || []).map(label => ({
        id: `voice-${label}`, name: label, label, price: 0, _instruction: true,
      }));
      addItem(item, mods, null, { qty: Math.max(1, Math.round(p.qty || 1)), notes: (p.notes || '').trim() || undefined });
    });
    if (parsed.order_note?.trim()) setOrderNote(parsed.order_note.trim());
    onClose?.();
  };

  // Cleanup on unmount — guarantee mic releases even if the user navigates
  // away mid-listen.
  useEffect(() => () => {
    userStoppedRef.current = true;
    if (recogRef.current) { try { recogRef.current.stop(); } catch {} }
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  const liveText = (transcriptUI + (interimUI ? ` ${interimUI}` : '')).trim();
  return (
    <MBottomSheet onClose={onClose} backdropOpacity=".7">
        <div style={{ textAlign:'center', marginBottom:14 }}>
          <div style={{ fontSize:11, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.07em', fontWeight:800 }}>Voice order</div>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginTop:4 }}>
            {phase === 'ready'     && 'Speak the order'}
            {phase === 'listening' && 'Listening…'}
            {phase === 'parsing'   && 'Parsing your order'}
            {phase === 'confirm'   && 'Confirm items'}
            {phase === 'error'     && 'Something went wrong'}
          </div>
          {phase === 'ready' && (
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:6, lineHeight:1.4 }}>
              Tap the mic and say the order naturally. When you're done, tap "Stop & use text".
            </div>
          )}
          {phase === 'listening' && (
            <div style={{ fontSize:12, color:'var(--acc)', marginTop:6, lineHeight:1.4, fontWeight:700 }}>
              {liveText ? '✓ Picking up your voice…' : 'Speak now — I\'m listening.'}
            </div>
          )}
        </div>

        {/* Mic button — central, dominant */}
        {(phase === 'ready' || phase === 'listening' || phase === 'error') && (
          <div style={{ display:'flex', justifyContent:'center', padding:'14px 0 6px' }}>
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

        {/* Live transcript — shown during listening (and afterwards as a
            preview before parse) */}
        {(phase === 'listening' || (phase === 'ready' && transcriptUI)) && (
          <div style={{
            margin:'10px 0', padding:'14px 16px', borderRadius:14,
            background:'var(--bg2)', border:'1px solid var(--bdr)',
            minHeight:80, fontSize:14, color:'var(--t1)', lineHeight:1.5,
          }}>
            {liveText
              ? (
                <>
                  <span>{transcriptUI}</span>
                  <span style={{ color:'var(--t4)', fontStyle:'italic' }}>{interimUI ? ` ${interimUI}` : ''}</span>
                </>
              )
              : <span style={{ color:'var(--t4)', fontStyle:'italic' }}>Listening… speak now.</span>
            }
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

            {/* Suggestions from the parser when nothing matched (or there's a
                partial match). Tap to add directly — bypasses the "Try again"
                cycle when the server just wants to pick a close alternative. */}
            {parsed.items.length === 0 && (parsed.suggestions || []).length > 0 && (
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:11, fontWeight:800, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>
                  Did you mean one of these?
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  {parsed.suggestions.slice(0, 5).map((s, i) => {
                    const item = menuItems.find(m => m.id === s.item_id);
                    if (!item || (item.type || 'simple') === 'variants') return null;
                    const price = item?.pricing?.base ?? item?.price ?? 0;
                    return (
                      <button
                        key={i}
                        onClick={() => {
                          addItem(item, [], null, { qty: 1 });
                          // Stay on the screen so the server can keep adding
                          // suggestions; clear the parsed state so the
                          // confirmation list flips to "added" implicitly.
                          // Simpler: close and let them tap mic again.
                          onClose?.();
                        }}
                        style={{
                          padding:'12px 14px', borderRadius:11, fontFamily:'inherit', cursor:'pointer',
                          border:'1.5px solid var(--bdr)', background:'var(--bg2)',
                          display:'flex', alignItems:'center', gap:10, textAlign:'left', minHeight:54,
                        }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{item.name}</div>
                          {s.reason && (
                            <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>{s.reason}</div>
                          )}
                        </div>
                        <div style={{ fontSize:13, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>
                          {money(price)}
                        </div>
                        <span style={{ fontSize:18, color:'var(--acc)' }}>+</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {parsed.items.length === 0 && (parsed.suggestions || []).length === 0 ? (
              <div style={{ padding:'18px 12px', textAlign:'center', color:'var(--t3)', fontSize:13 }}>
                No items mapped from "{transcriptUI}". Try again with clearer item names.
              </div>
            ) : parsed.items.length === 0 ? null : (
              <>
                <div style={{ fontSize:11, color:'var(--t3)', textTransform:'uppercase', fontWeight:700, letterSpacing:'.06em', marginBottom:8 }}>
                  Adding {parsed.items.reduce((s, i) => s + (i.qty || 0), 0)} items
                </div>
                {parsed.items.map((p, i) => {
                  const item = menuItems.find(m => m.id === p.item_id);
                  if (!item) {
                    return (
                      <div key={i} style={{ padding:'10px 12px', background:'var(--red-d)', borderRadius:11, border:'1px solid var(--red-b)', marginBottom:6, fontSize:12, color:'var(--red)' }}>
                        ⚠ Couldn't find item id "{p.item_id}" — skipped
                      </div>
                    );
                  }
                  const isParentVariant = (item.type || 'simple') === 'variants';
                  const price = item?.pricing?.base ?? item?.price ?? 0;
                  return (
                    <div key={i} style={{
                      padding:'10px 12px',
                      background: isParentVariant ? 'var(--red-d)' : 'var(--bg2)',
                      borderRadius:11,
                      border:`1px solid ${isParentVariant ? 'var(--red-b)' : 'var(--bdr)'}`,
                      marginBottom:6, display:'flex', gap:10,
                    }}>
                      <div style={{ fontSize:12, fontWeight:800, color:'var(--t4)', fontFamily:'var(--font-mono)', minWidth:24, paddingTop:1 }}>
                        {p.qty}×
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:700, color: isParentVariant ? 'var(--red)' : 'var(--t1)' }}>
                          {item.name}
                          {isParentVariant && <span style={{ marginLeft:6, fontSize:10, fontWeight:700, padding:'1px 6px', borderRadius:6, background:'var(--red)', color:'#fff' }}>SKIPPED · pick a size</span>}
                        </div>
                        {isParentVariant && (
                          <div style={{ fontSize:11, color:'var(--red)', marginTop:2 }}>
                            "{item.name}" needs a specific size. Tap "Try again" and say e.g. "Latte large" or "Latte regular".
                          </div>
                        )}
                        {!isParentVariant && (p.mod_labels || []).length > 0 && (
                          <div style={{ fontSize:11, color:'var(--acc)', marginTop:1 }}>{p.mod_labels.join(' · ')}</div>
                        )}
                        {!isParentVariant && p.notes && <div style={{ fontSize:11, color:'var(--acc)', marginTop:1 }}>📝 {p.notes}</div>}
                      </div>
                      {!isParentVariant && (
                        <div style={{ fontSize:13, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)' }}>
                          {money(price * (p.qty || 1))}
                        </div>
                      )}
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

        {/* Error */}
        {error && (
          <div style={{ margin:'10px 0', padding:10, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:12, border:'1px solid var(--red-b)' }}>
            {error}
          </div>
        )}

        {/* Bottom actions — context-aware */}
        <div style={{ marginTop:'auto', paddingTop:14 }}>
          {phase === 'listening' && (
            <>
              <button onClick={stopAndParse} disabled={!liveText} style={{ ...Sx.btnPrim, opacity: liveText ? 1 : .5 }}>
                ⏹ Stop & use text
              </button>
              <button onClick={cancelRecording} style={{ ...Sx.btnGhost, marginTop:8 }}>
                Cancel — start again
              </button>
            </>
          )}
          {phase === 'confirm' && parsed?.items?.length > 0 && (
            <button onClick={confirm} style={Sx.btnPrim}>
              ✓ Add {parsed.items.length} item{parsed.items.length === 1 ? '' : 's'} to order
            </button>
          )}
          {phase === 'confirm' && (!parsed?.items?.length) && (
            <button onClick={() => { setParsed(null); setTranscriptUI(''); transcriptRef.current=''; setPhaseSafe('ready'); }} style={Sx.btnPrim}>
              🎤 Try again
            </button>
          )}
          {phase === 'error' && (
            <button onClick={() => { setError(null); setPhaseSafe('ready'); transcriptRef.current=''; setTranscriptUI(''); }} style={Sx.btnPrim}>
              🎤 Try again
            </button>
          )}
          {phase !== 'listening' && (
            <button onClick={onClose} style={{ ...Sx.btnGhost, marginTop:8 }}>
              {phase === 'confirm' ? 'Cancel' : 'Close'}
            </button>
          )}
        </div>

      <style>{`
        @keyframes mpos-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,.3), 0 0 0 0 rgba(239,68,68,.15); } 50% { box-shadow: 0 0 0 14px rgba(239,68,68,.25), 0 0 0 30px rgba(239,68,68,.10); } }
        @keyframes mpos-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </MBottomSheet>
  );
}
