// MMe — staff profile, end shift, BO link, what's new, sign out.
// Phase 1A: minimal static info + actions. Future: shift summary, my sales today,
// my tip total, productivity stats.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { VERSION } from '../../lib/version';
import { Sx } from './MShellStyles';
import { currencySymbol } from '../../lib/currency';
import { adyenLocalBridgeAvailable } from '../../lib/payments/adyenLocalTerminal';
import { resolveSelfHostedAdyenTerminal } from '../../lib/payments/localTerminalIdentity';

export default function MMe({ onOpenHistory }) {
  const { staff, logout, deviceConfig, closedChecks = [] } = useStore();

  // Today's sales attributed to this server (rough — by name match)
  const myName = staff?.name?.toLowerCase();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const myToday = closedChecks.filter(c =>
    c.closedAt && c.closedAt >= dayStart.getTime() &&
    (c.server || '').toLowerCase() === myName
  );
  const myCount = myToday.length;
  const myTotal = myToday.reduce((s, c) => s + (Number(c.total) || 0), 0);
  const myTips = myToday.reduce((s, c) => s + (Number(c.tip) || 0), 0);

  return (
    <div style={Sx.scroller}>
      {/* Profile card */}
      <div style={{ padding:'24px 16px 14px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:18 }}>
          <div style={{
            width:64, height:64, borderRadius:'50%',
            background: staff?.color || 'var(--acc)', color:'#0b0c10',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:22, fontWeight:800, flexShrink:0,
          }}>{staff?.initials || '?'}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)' }}>{staff?.name || 'Unknown'}</div>
            <div style={{ fontSize:12, color:'var(--t3)', textTransform:'capitalize' }}>{staff?.role || 'Staff'}</div>
            {deviceConfig?.profileName && (
              <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>📱 {deviceConfig.profileName}{deviceConfig?.runnerMode ? ' · Runner' : ''}</div>
            )}
          </div>
        </div>

        {/* Today's stats */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8 }}>
          <Stat label="Orders" value={myCount}/>
          <Stat label="Sales" value={`${currencySymbol()}${myTotal.toFixed(0)}`}/>
          <Stat label="Tips" value={`${currencySymbol()}${myTips.toFixed(0)}`}/>
        </div>
      </div>

      {/* Actions */}
      <div style={{ padding:'8px 14px' }}>
        <Action
          icon="🧾" title="Closed orders"
          desc="Reprint receipts, email a copy, refund items"
          onClick={() => onOpenHistory?.()}
        />
        <Action
          icon="🏢" title="Back office"
          desc="Reports, menu, staff (opens in browser)"
          onClick={() => { window.location.href = '?mode=office'; }}
        />
        <Action
          icon="🔄" title="Switch device mode"
          desc="Use this device as a regular POS instead"
          onClick={() => {
            if (confirm('Switch this device out of MPOS mode? You\'ll need to pick a new mode.')) {
              localStorage.removeItem('rpos-device-mode');
              window.location.href = '/';
            }
          }}
        />
        <Action
          icon="⏻" title="End shift / sign out"
          desc="Hands the device back to the next server"
          dangerous
          onClick={() => { if (confirm('End your shift and sign out?')) logout(); }}
        />
      </div>

      {/* Built-in card reader (Adyen payment terminals only) */}
      <LocalReaderCard />

      {/* Footer */}
      <div style={{ padding:'24px 16px 32px', textAlign:'center', color:'var(--t4)', fontSize:11, fontFamily:'var(--font-mono)' }}>
        Serv OS · MPOS v{VERSION}
      </div>
    </div>
  );
}

/**
 * "This device's own card reader" — only rendered on an Adyen Android payment
 * terminal (the wrapper injects window.RposAdyenNexo; everywhere else this renders
 * nothing at all).
 *
 * Its real job is the PAIRING CODE. A terminal self-registers an unpaired
 * terminal_devices row on first look, and the manager types the code shown here
 * into Back Office → Card readers — exactly the paxpay flow. Re-resolving on mount
 * also refreshes last_seen_at, which is what keeps the 30-minute claim TTL alive
 * while somebody walks to the office.
 */
function LocalReaderCard() {
  const [state, setState] = useState(null);   // null = still looking
  const [busy, setBusy] = useState(false);
  const available = adyenLocalBridgeAvailable();

  const look = async () => {
    setBusy(true);
    const res = await resolveSelfHostedAdyenTerminal();
    setState(res);
    setBusy(false);
  };

  useEffect(() => {
    if (!available) return undefined;
    let alive = true;
    // Not `look()` — that would setState synchronously inside the effect body.
    resolveSelfHostedAdyenTerminal().then((res) => { if (alive) setState(res); });
    return () => { alive = false; };
  }, [available]);

  if (!available) return null;

  const ok = state?.ok === true;
  return (
    <div style={{ padding:'8px 14px 0' }}>
      <div style={{
        background:'var(--bg2)', border:`1px solid ${ok ? 'var(--bdr)' : 'var(--red-b)'}`,
        borderRadius:12, padding:'14px 12px',
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom: state ? 10 : 0 }}>
          <div style={{ fontSize:22 }}>💳</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>Card reader on this terminal</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
              {!state ? 'Checking…' : ok ? `Ready · ${state.terminal.label}` : 'Not ready'}
            </div>
          </div>
          <button
            onClick={look}
            disabled={busy}
            style={{ ...Sx.btnGhost, width:'auto', padding:'8px 12px', fontSize:12, opacity: busy ? .5 : 1 }}
          >↻</button>
        </div>

        {state && !ok && (
          <div style={{ fontSize:12, color:'var(--t3)', lineHeight:1.55 }}>{state.reason}</div>
        )}
        {state?.claimCode && (
          <div style={{ marginTop:12, textAlign:'center' }}>
            <div style={{ fontSize:10, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', fontWeight:700 }}>
              Pairing code
            </div>
            <div style={{ fontSize:28, fontWeight:800, letterSpacing:3, fontFamily:'var(--font-mono)', color:'var(--t1)', marginTop:4 }}>
              {state.claimCode}
            </div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:6, lineHeight:1.5 }}>
              Back Office → Card readers → pair by code. Expires 30 minutes after this screen was last opened.
            </div>
          </div>
        )}
        {ok && (
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:8, fontFamily:'var(--font-mono)', wordBreak:'break-all' }}>
            POIID {state.terminal.adyenTerminalId}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:12, padding:'12px 8px', textAlign:'center' }}>
      <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{value}</div>
      <div style={{ fontSize:10, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', fontWeight:700, marginTop:2 }}>{label}</div>
    </div>
  );
}

function Action({ icon, title, desc, onClick, dangerous }) {
  return (
    <button onClick={onClick} style={{
      width:'100%', padding:'14px 12px', borderRadius:12,
      background:'var(--bg2)', border:`1px solid ${dangerous ? 'var(--red-b)' : 'var(--bdr)'}`,
      cursor:'pointer', fontFamily:'inherit', textAlign:'left',
      display:'flex', alignItems:'center', gap:12, marginBottom:8, minHeight:64,
    }}>
      <div style={{ fontSize:22, flexShrink:0 }}>{icon}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:700, color: dangerous ? 'var(--red)' : 'var(--t1)' }}>{title}</div>
        <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{desc}</div>
      </div>
      <div style={{ fontSize:18, color:'var(--t4)', flexShrink:0 }}>›</div>
    </button>
  );
}
