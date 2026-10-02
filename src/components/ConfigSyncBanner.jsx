import { useState } from 'react';
import { useStore } from '../store';

/**
 * Shows a sticky banner on the POS when the Back Office has pushed a config update.
 * The operator can review the changes and tap "Sync" to apply them.
 * Sits at the top of the main content area so it's visible but not blocking.
 */
export default function ConfigSyncBanner() {
  const { configUpdateAvailable, configUpdateSnapshot, applyConfigUpdate } = useStore();
  const [applying, setApplying] = useState(false);
  // 30 Sep 2026: "Later" hides THIS push only. It used to be a plain true that stayed set, so
  // every later push was hidden too until someone signed out.
  const [dismissedSnap, setDismissedSnap] = useState(null);

  if (!configUpdateAvailable || (dismissedSnap && dismissedSnap === configUpdateSnapshot)) return null;

  const snap = configUpdateSnapshot;
  const time = snap?.pushedAt
    ? new Date(snap.pushedAt).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })
    : 'just now';

  const handleApply = () => {
    setApplying(true);
    setTimeout(() => {
      applyConfigUpdate();
      setApplying(false);
    }, 400);
  };

  return (
    <div style={{
      background:'var(--acc-d)',
      borderBottom:'2px solid var(--acc)',
      padding:'8px 18px',
      display:'flex', alignItems:'center', gap:14,
      flexShrink:0, animation:'slideDown .25s cubic-bezier(.2,.8,.3,1)',
    }}>
      {/* Pulsing dot */}
      <div style={{ width:8, height:8, borderRadius:'50%', background:'var(--acc)', boxShadow:'0 0 10px var(--acc)', flexShrink:0, animation:'pulse 1.5s ease-in-out infinite' }}/>

      {/* Info */}
      <div style={{ flex:1, minWidth:0 }}>
        <span style={{ fontSize:13, fontWeight:700, color:'var(--acc)' }}>
          Back Office update ready
        </span>
        <span style={{ fontSize:12, color:'var(--t3)', marginLeft:10 }}>
          Pushed by {snap?.pushedBy || 'Manager'} at {time}
          {snap?.changeCount > 0 && <span style={{ marginLeft:8 }}>· {snap.changeCount} change{snap.changeCount !== 1 ? 's' : ''}</span>}
        </span>
        {snap && (
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>
            {[
              snap.tables?.length && `${snap.tables.length} tables`,
              snap.locationSections?.length && `${snap.locationSections.length} sections`,
              snap.menuItems?.length && `${snap.menuItems.length} menu items`,
            ].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display:'flex', gap:8, flexShrink:0 }}>
        <button
          onClick={() => setDismissedSnap(configUpdateSnapshot)}
          style={{ padding:'5px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'transparent', border:'1px solid var(--acc-b)', color:'var(--t3)', fontSize:12, fontWeight:600 }}
        >Later</button>
        <button
          onClick={handleApply}
          disabled={applying}
          style={{
            padding:'6px 18px', borderRadius:8, cursor:'pointer',
            fontFamily:'inherit', fontSize:13, fontWeight:800, border:'none',
            background: applying ? 'var(--bg3)' : 'var(--acc)',
            color: applying ? 'var(--t3)' : '#0b0c10',
            transition:'all .15s',
            display:'flex', alignItems:'center', gap:6,
          }}
        >
          {applying ? (
            <><span style={{ animation:'spin .6s linear infinite', display:'inline-block' }}>↻</span> Syncing…</>
          ) : (
            <>Sync now</>
          )}
        </button>
      </div>
    </div>
  );
}
