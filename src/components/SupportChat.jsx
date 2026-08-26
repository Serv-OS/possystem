// src/components/SupportChat.jsx — "Support" chat drawer off the POS rail (v5.7.61).
// Hosts the ServOS support chat widget (CRM chat.js) in its inline mode inside a
// slide-over panel, same chrome as StatusDrawer. chat.js has no open/close API —
// inline mode simply fills the mount node and auto-opens — so the drawer stays
// MOUNTED (hidden) after close: the script is injected once on first open, the
// conversation survives reopening, and a second injection (which would duplicate
// the widget) can never happen.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './ServOSIcons';
import { useStore } from '../store';
import { VERSION } from '../lib/version';
import { getActiveLocationSync, supabase } from '../lib/supabase';

const CHAT_SRC = 'https://posupject.vercel.app/chat.js';
const CHAT_SITE_KEY = 'chat_4a8301c6412705dac3ce';
// The site key lives in the posupject CRM, so aim the widget at that project's
// chat function explicitly — the API constant baked into chat.js pointed at a
// sibling CRM's Supabase, which rejected this key ("Unknown or inactive site key").
const CHAT_API = 'https://yuevuqvldtmjwwzjrddo.supabase.co/functions/v1/chat';
const MOUNT_ID = 'rpos-support-chat-mount';

// `left` is where the panel starts: it sits just clear of whatever navigation
// opened it. 58 is the POS rail; the Back Office sidebar is 236.
export default function SupportChat({ open, onClose, left = 58, context: extraContext }) {
  const injectedRef = useRef(false);
  const [loadState, setLoadState] = useState('idle'); // idle | loading | ready | failed
  // The till already knows all of this, so support should never have to open with
  // "which site are you?". Sent as a claim, not an identity: the CRM stores it
  // under "reported by the device" and authorises nothing from it. Deliberately
  // no customer data, no order data, and only the staff member's display name.
  // Same fields the rest of the app uses to name these things: locationConfig
  // falls back to `label` (see MReceiptPrompt), and a terminal is identified by
  // its device PROFILE, which is what the ShiftBar shows the operator.
  const venueName = useStore((s) => s.locationConfig?.name || s.locationConfig?.label);
  const deviceName = useStore((s) => s.deviceConfig?.profileName);
  const staffName = useStore((s) => s.staff?.name);

  // The venue's permanent public ID, the thing the CRM actually matches on. It is
  // NOT in locationConfig, which is loaded from the platform DB, so read it from
  // the ops locations row on first open. undefined = not looked up yet, and the
  // script injection below waits for that so the code is in the context from the
  // very first message. null = no code, which just means the CRM will not resolve
  // a venue and the bot asks, exactly as it does today.
  const [venueCode, setVenueCode] = useState(undefined);
  useEffect(() => {
    if (!open || venueCode !== undefined) return;
    let alive = true;
    const id = (() => { try { return getActiveLocationSync(); } catch { return null; } })();
    if (!id || id === 'loc-demo' || !supabase) { setVenueCode(null); return undefined; }
    supabase.from('locations').select('venue_code').eq('id', id).maybeSingle()
      .then(({ data }) => { if (alive) setVenueCode(data?.venue_code || null); })
      .catch(() => { if (alive) setVenueCode(null); });
    return () => { alive = false; };
  }, [open, venueCode]);

  useEffect(() => {
    if (!open || venueCode === undefined || injectedRef.current || loadState === 'failed') return;
    injectedRef.current = true;
    setLoadState('loading');
    const s = document.createElement('script');
    s.src = CHAT_SRC;
    s.defer = true;
    s.setAttribute('data-site-key', CHAT_SITE_KEY);
    s.setAttribute('data-mode', 'inline');
    s.setAttribute('data-target', `#${MOUNT_ID}`);
    s.setAttribute('data-title', 'ServOS Support');
    s.setAttribute('data-api', CHAT_API);
    // Only send keys we actually have, so a half-booted till does not post empties.
    // A caller can override or add: the Back Office knows its signed-in user and
    // its selected venue, but has no terminal and no PIN'd staff member.
    const ctx = {};
    if (venueName) ctx.Venue = venueName;
    // The venue NAME cannot identify the customer on its own: the POS calls a site
    // "Leeds" while the CRM holds three Leeds venues under different brands. The id
    // is the only unambiguous handle, so send it and let the CRM map it.
    const locId = (() => { try { return getActiveLocationSync(); } catch { return null; } })();
    if (locId && locId !== 'loc-demo') ctx.VenueId = locId;
    // The code is what the CRM matches on: short, permanent, and copied into the
    // CRM record by hand when the venue is set up.
    if (venueCode) ctx.VenueCode = venueCode;
    if (deviceName) ctx.Terminal = deviceName;
    if (staffName) ctx['Signed in'] = staffName;
    ctx.App = `ServOS v${VERSION}`;
    Object.assign(ctx, extraContext || {});
    s.setAttribute('data-context', JSON.stringify(ctx));
    s.onload = () => setLoadState('ready');
    // Allow a retry on a dead connection — clearing the latch lets the next
    // open inject a fresh script tag (the failed one never ran, so no dupe).
    s.onerror = () => { setLoadState('failed'); injectedRef.current = false; s.remove(); };
    document.body.appendChild(s);
  }, [open, loadState, venueCode, extraContext]);

  return (
    <div style={{ display: open ? 'contents' : 'none' }}>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', zIndex:200, backdropFilter:'blur(2px)' }}/>
      <div style={{ position:'fixed', left, top:0, bottom:0, width:390, maxWidth:`calc(100vw - ${left + 8}px)`, background:'var(--bg1)', borderRight:'1px solid var(--bdr)', zIndex:201, display:'flex', flexDirection:'column', boxShadow:'4px 0 24px rgba(0,0,0,.25)', animation:'slideRight .2s cubic-bezier(.2,.8,.3,1)', overflow:'hidden' }}>

        {/* Header */}
        <div style={{ padding:'16px 18px 14px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
          <Icon name="support" size={18} style={{ color:'var(--acc)' }} />
          <div>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>Support</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Chat with the ServOS team</div>
          </div>
          <button onClick={onClose} style={{ marginLeft:'auto', width:30, height:30, borderRadius:9, cursor:'pointer', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:14, lineHeight:1, fontFamily:'inherit' }}>✕</button>
        </div>

        {/* Widget mount — chat.js appends its inline panel here */}
        <div style={{ flex:1, minHeight:0, display:'flex', flexDirection:'column', position:'relative' }}>
          <div id={MOUNT_ID} style={{ flex:1, minHeight:0 }}/>
          {loadState !== 'ready' && (
            <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', padding:24, textAlign:'center', color:'var(--t3)', fontSize:13, pointerEvents: loadState==='failed' ? 'auto' : 'none' }}>
              {loadState === 'failed'
                ? <button onClick={() => setLoadState('idle')} style={{ padding:'10px 16px', borderRadius:10, cursor:'pointer', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit' }}>Couldn&rsquo;t load support chat — tap to retry</button>
                : 'Loading support chat…'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
