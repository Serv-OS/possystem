// src/backoffice/sections/stock/LockLine.jsx
//
// MULTI SITE STOCK (v5.11.86, Drop 1, map 4.22, mockup .lockline): the one line that tells a login
// why company fields are greyed, and who to ask. The database refuses those saves (the Drop 1
// guard and the 0b locks); this only says so before anyone tries, so no screen looks editable while
// its save would be refused.
//
//   kind 'company'     Set by head office. Ask <editors> to change it. [Suggest a change]
//   kind 'sites'       the Sites tab for a 'sites' login: what they can change at their own sites
//   kind 'sites_full'  the same for a 'sites_full' login (adds the supplier here and the price here)
//
// Suggest a change writes one activity feed row for head office (stock_suggest_change); it is a
// message, never an edit, and never read as authority.

import { useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { listWords } from '../../../lib/stock/siteScope';
import { Btn } from '../msm/msmUi';
import { ui } from '../msm/msmStyle';

const strip = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderRadius: 8, background: 'var(--bg2)', color: 'var(--t3)', fontSize: 13, lineHeight: 1.45 };

export default function LockLine({ entity = null, id = null, recordName = '', kind = 'company' }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const siteNames = listWords((sc.sites || []).map((s) => s.name)) || 'your sites';

  if (kind === 'sites') {
    return <div style={strip} data-testid="stock-lock-line">You can change par, reorder, minimum, area and counted here for {siteNames}. Prices and the supplier here come from head office.</div>;
  }
  if (kind === 'sites_full') {
    return <div style={strip} data-testid="stock-lock-line">You can change par, reorder, minimum, area, counted here, the supplier here and the price here for {siteNames}.</div>;
  }

  const canSuggest = !!entity && !!id;
  const send = async () => {
    const words = text.trim();
    if (!words || busy) return;
    setBusy(true); setError(null);
    const r = await stockApi.suggestChange(entity, id, words);
    setBusy(false);
    if (r.error) { setError(r.error.message || 'It did not send. Try again.'); return; }
    showToast?.('Sent to head office.', 'success');
    setOpen(false); setText('');
  };
  return (
    <div style={{ display: 'grid', gap: 8 }} data-testid="stock-lock-line">
      <div style={strip}>
        <span style={{ flex: '1 1 260px', minWidth: 0 }}>🔒 Set by head office. Ask {sc.editorsText || 'head office'} to change it.</span>
        {canSuggest && !open && <Btn small kind="soft" onClick={() => setOpen(true)}>Suggest a change</Btn>}
      </div>
      {canSuggest && open && (
        <div style={{ ...strip, display: 'grid', gap: 8 }}>
          <label htmlFor="stock-suggest-text" style={{ ...ui.label, marginBottom: 0 }}>What should change{recordName ? ` on ${recordName}` : ''}?</label>
          <textarea id="stock-suggest-text" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} rows={3}
            style={{ ...ui.input, resize: 'vertical', minHeight: 64 }} />
          {error && <div style={ui.err}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn small onClick={() => { setOpen(false); setText(''); setError(null); }}>Cancel</Btn>
            <Btn small kind="primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Sending…' : 'Send'}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
