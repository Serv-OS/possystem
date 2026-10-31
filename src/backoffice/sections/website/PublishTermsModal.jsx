// src/backoffice/sections/website/PublishTermsModal.jsx
//
// 5.12.1: the publishing terms, shown in full before the first publish (and again when the
// terms version changes). The owner must scroll, tick the box and press Accept and publish.
// The server records the acceptance (website-admin publish, settings.publish_terms); this
// screen only carries the version it showed. Back Office skin tokens only.

import { useState } from 'react';
import { W } from './ui.js';
import { PUBLISH_TERMS } from '../../../lib/website/publishTerms.js';

export default function PublishTermsModal({ terms = PUBLISH_TERMS, busy = false, onAccept, onCancel }) {
  const [ticked, setTicked] = useState(false);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="wb-terms-title" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={busy ? undefined : onCancel}>
      <div style={{ ...W.card, width: 680, maxWidth: '96vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', marginBottom: 0 }} onClick={(e) => e.stopPropagation()}>
        <h2 id="wb-terms-title" style={{ ...W.h2, marginBottom: 4 }}>{terms.title}</h2>
        <div style={{ ...W.hint, marginTop: 0, marginBottom: 12 }}>Version {terms.version}. Please read to the end.</div>
        <div style={{ overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: 10, padding: '14px 16px', background: 'var(--bg2)', fontSize: 13.5, lineHeight: 1.6, color: 'var(--t1)', flex: 1, minHeight: 200 }}>
          <p style={{ marginTop: 0 }}>{terms.intro}</p>
          {terms.sections.map((s) => (
            <section key={s.heading}>
              <h3 style={{ fontSize: 13.5, fontWeight: 800, margin: '14px 0 4px', color: 'var(--t1)' }}>{s.heading}</h3>
              <p style={{ margin: 0, color: 'var(--t2)' }}>{s.body}</p>
            </section>
          ))}
          <p style={{ marginTop: 14, marginBottom: 0, color: 'var(--t2)' }}>{terms.closing}</p>
        </div>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14, fontSize: 13, color: 'var(--t1)', cursor: 'pointer' }}>
          <input type="checkbox" checked={ticked} disabled={busy} onChange={(e) => setTicked(e.target.checked)} style={{ marginTop: 3 }} />
          <span>I have read and understood the Website Builder publishing terms and I accept them on behalf of my business. I understand that ServOS does not guarantee that this website meets any accessibility or disability standard and that I am responsible for the website and its compliance.</span>
        </label>
        <div style={{ ...W.row, justifyContent: 'flex-end', marginTop: 14 }}>
          <button type="button" style={W.ghost} disabled={busy} onClick={onCancel}>Not now</button>
          <button type="button" style={{ ...W.btn, opacity: ticked && !busy ? 1 : 0.5 }} disabled={!ticked || busy} onClick={onAccept}>{busy ? 'Publishing…' : 'Accept and publish'}</button>
        </div>
      </div>
    </div>
  );
}
