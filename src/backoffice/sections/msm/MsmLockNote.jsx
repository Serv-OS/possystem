// src/backoffice/sections/msm/MsmLockNote.jsx
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75, design 3.2): what Menu Manager shows on a product
// or option group head office manages. A banner that says who sets it and what stays the site's,
// and a wrapper that shows a field read only with a small lock (tap it for the reason). The store
// refuses the same fields whatever screen sends them (lib/msm/msmLock.js); this is the screen side.
// Nothing shows for a company that is not switched on (the managed lists are empty).

import { useState } from 'react';
import { LOCK_WORDS, lockWord } from '../../../lib/msm/msmLock.js';

const box = {
  padding: '9px 11px', borderRadius: 9, fontSize: 11.5, lineHeight: 1.5, color: 'var(--t2)',
  background: 'var(--blu-d, var(--bg3))', border: '1px solid color-mix(in srgb, var(--blu, #4A8CFF) 35%, transparent)',
};

/**
 * The banner on a managed product or group.
 *   kind     'product' | 'group'
 *   kept     Set of the columns the site keeps as its own
 *   onOpen   opens the Multi site menu (only for people who may open it), or null
 *   action   { label, onClick } an extra way out (a copy for the site's own products), or null
 */
export function MsmLockBanner({ kind = 'product', kept = new Set(), onOpen = null, action = null }) {
  const keptWords = [...new Set([...kept].map(lockWord))];
  return (
    <div role="note" data-testid="msm-lock-banner" style={{ ...box, marginBottom: 12 }}>
      <div style={{ fontWeight: 800, color: 'var(--t1)', marginBottom: 2 }}>🔒 {kind === 'group' ? 'Managed by head office' : 'Set by head office'}</div>
      <div>{kind === 'group' ? LOCK_WORDS.group : LOCK_WORDS.product}</div>
      {kind === 'product' && <div style={{ marginTop: 3, color: 'var(--t3)' }}>{LOCK_WORDS.stillYours}</div>}
      {kind === 'group' && <div style={{ marginTop: 3, color: 'var(--t3)' }}>86 still works here, and you can put it on this site's own products.</div>}
      {keptWords.length > 0 && <div style={{ marginTop: 3 }}>This site keeps its own {keptWords.join(', ')}: {keptWords.length === 1 ? 'that stays' : 'those stay'} editable here.</div>}
      {(onOpen || action) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 7 }}>
          {onOpen && <button type="button" onClick={onOpen} style={linkBtn}>Open the Multi site menu</button>}
          {action && <button type="button" onClick={action.onClick} style={linkBtn}>{action.label}</button>}
        </div>
      )}
    </div>
  );
}
const linkBtn = { padding: '4px 10px', borderRadius: 7, border: '1px solid var(--bdr2)', background: 'var(--bg1)', color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 };

/**
 * A field head office owns, read only, with a lock that says why when tapped.
 *   on     true when the field is locked here (false renders the children as they are)
 */
export function MsmLocked({ on, children, label = null }) {
  const [why, setWhy] = useState(false);
  if (!on) return children;
  return (
    <div style={{ position: 'relative' }}>
      <fieldset disabled aria-disabled="true" style={{ border: 'none', padding: 0, margin: 0, minWidth: 0, opacity: 0.62 }}>{children}</fieldset>
      <button type="button" onClick={() => setWhy((v) => !v)} title={LOCK_WORDS.product} aria-label={`${label || 'This field'} is set by head office`}
        style={{ position: 'absolute', top: -2, right: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: '0 2px', color: 'var(--t3)' }}>🔒</button>
      {why && <div style={{ ...box, marginTop: 6 }}>{label ? `${label}: ` : ''}{LOCK_WORDS.product}</div>}
    </div>
  );
}
