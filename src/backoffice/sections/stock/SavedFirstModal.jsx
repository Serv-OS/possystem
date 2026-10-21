// src/backoffice/sections/stock/SavedFirstModal.jsx
//
// MULTI SITE STOCK (v5.11.89, Drop 1, mockup modal "conflict"): someone saved the same record
// first. Nothing was overwritten: the screen keeps what was typed, shows what changed, and the login
// chooses Keep <First>'s (reload their version) or Save mine on top (save again with the new
// version). Both changes stay in the log.
//
// rows: [{ label, theirs, mine }]. onSaveMine may return a promise: the toast is said only when it
// does not answer false or { error } (never a toast for a save that failed).

import { useStore } from '../../../store';
import { Btn, Modal } from '../msm/msmUi';
import { ui } from '../msm/msmStyle';
import { savedFirstWords } from '../../../lib/stock/siteScope';

const th = { textAlign: 'left', padding: '7px 10px', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', borderBottom: '1px solid var(--bdr)' };
const td = { padding: '8px 10px', fontSize: 13, color: 'var(--t1)', borderBottom: '1px solid var(--bdr)' };

export default function SavedFirstModal({ byName, at, rows, busy = false, onKeepTheirs, onSaveMine, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const list = Array.isArray(rows) ? rows : [];
  const w = savedFirstWords({ byName, at, rows: list });
  const saveMine = async () => {
    const r = await onSaveMine?.();
    if (r === false || (r && typeof r === 'object' && r.error)) return;
    showToast?.(`Saved on top of ${w.first}'s version. Both changes are in the log.`, 'success');
  };
  return (
    <Modal title={w.title} onClose={onClose} width={560}
      footer={(
        <>
          <div style={{ flex: 1 }} />
          <Btn disabled={busy} onClick={onKeepTheirs}>{`Keep ${w.first}'s`}</Btn>
          <Btn kind="primary" disabled={busy} onClick={saveMine}>{busy ? 'Saving…' : 'Save mine on top'}</Btn>
        </>
      )}>
      <div style={{ fontSize: 13.5, color: 'var(--t1)', lineHeight: 1.5 }}>{w.words}</div>
      <div style={{ ...ui.sub, fontSize: 13, marginTop: 4, marginBottom: 12 }}>Your changes are kept here and nothing was overwritten.</div>
      {list.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Field</th><th style={th}>{`${w.first}'s version`}</th><th style={th}>Yours</th></tr></thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={`${r.label}-${i}`}>
                  <td style={{ ...td, fontWeight: 600 }}>{r.label}</td>
                  <td style={td}>{r.theirs == null || r.theirs === '' ? '(none)' : String(r.theirs)}</td>
                  <td style={td}>{r.mine == null || r.mine === '' ? '(none)' : String(r.mine)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
