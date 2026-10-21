// src/backoffice/sections/stock/items/UntickChoiceModal.jsx
//
// MULTI SITE STOCK Drop 1 (mockup renderModal 'untick'): taking an item off one site gives two
// choices. Used by the Sites tab (ItemSitesTab), the Sites grid (SitesGrid) and the Sites pop up
// (SitesPopover).
//   Stop ordering, run out: never ordered there again; it stays on the counts until zero.
//   Remove now: only when the site holds none and no live recipe there uses it. When it is blocked
//   the button stays greyed with the plain reason, in the server's words for the parts that apply.
// The database decides (stock_set_item_sites): a pair it will not remove comes back in `refused`
// and the caller shows those words. Nothing is ever deleted: unticked rows are archived.

import { Modal, Btn } from '../stockUi';
import { untickWords, holdsText } from '../../../../lib/stock/itemPageRules';

const choiceStyle = (disabled) => ({
  display: 'block', width: '100%', textAlign: 'left', fontFamily: 'inherit', color: 'var(--t1)',
  background: 'var(--bg2)', border: '1px solid var(--bdr2, var(--bdr))', borderRadius: 10, padding: '11px 13px',
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
});

function Choice({ title, words, onClick, disabled, testId }) {
  return (
    <button type="button" onClick={disabled ? undefined : onClick} disabled={disabled} aria-disabled={disabled} data-testid={testId} style={choiceStyle(disabled)}>
      <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, marginBottom: 3 }}>{title}</span>
      <span style={{ display: 'block', fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.45 }}>{words}</span>
    </button>
  );
}

export default function UntickChoiceModal({ itemName, siteName, holds, usedBy = [], busy = false, onRunOut, onRemoveNow, onClose }) {
  const held = holdsText(holds);
  const used = (usedBy || []).map((u) => (typeof u === 'string' ? u : u?.name || '')).filter(Boolean);
  const blocked = !!held || used.length > 0;
  const removeWords = untickWords({ siteName, holds: held, usedBy: used });
  const close = () => { if (!busy) onClose?.(); };
  return (
    <Modal title={`Take ${itemName} off ${siteName}?`} onClose={close} width={520}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={close} disabled={busy}>Go back</Btn></>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <Choice testId="untick-runout" title="Stop ordering, run out" disabled={busy} onClick={() => onRunOut?.()}
          words={`It can no longer be ordered at ${siteName}. It stays on the counts until it reaches zero, then archives itself. Recipes there keep working until then.`} />
        <Choice testId="untick-remove" title="Remove now" disabled={busy || blocked} onClick={() => onRemoveNow?.()} words={removeWords} />
        <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>{busy ? 'Saving…' : 'Unticked rows are archived, never deleted.'}</div>
      </div>
    </Modal>
  );
}
