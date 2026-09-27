// LinkMemberModal: "Link to existing member" from the POS order chip (27 Sep 2026).
//
// Peter: "if a customer adds their number and then a staff member can link that to a profile that
// currently has no number". Coffee Boy Leeds takes takeaway and collection with the customer
// details setting reduced ("we have details disabled so only the phone number is there for
// takeaway and collection so nowhere to type those details in"), so the email join never runs
// there. Staff search the members by name or email; only members with NO phone are listed, each
// marked "no phone"; one tap links (Peter: automatic, no extra question). Any refusal is shown
// here in plain words (lib/customerLink.js linkMessage), never an error screen.

import { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { linkSearchTerm, phonelessResults, memberCard, linkMessage } from '../lib/customerLink';
import { customerInitials, customerLabel } from '../lib/customerInitials';

export default function LinkMemberModal({ customer, onLinked, onClose }) {
  const searchCustomersLive = useStore((s) => s.searchCustomersLive);
  const linkOrderCustomerToMember = useStore((s) => s.linkOrderCustomerToMember);
  const [q, setQ] = useState('');
  // The last answer and the text it answered: a list is shown only for the text on screen now.
  const [found, setFound] = useState({ term: '', rows: [] });
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState('');
  // One tap links; a second tap while it links does nothing.
  const busyRef = useRef(false);
  const closedRef = useRef(false);
  const close = () => { closedRef.current = true; onClose?.(); };

  const term = linkSearchTerm(q);
  useEffect(() => {
    if (!term) return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      let live = [];
      try {
        live = typeof searchCustomersLive === 'function' ? await searchCustomersLive(term, { phoneless: true }) : [];
      } catch { live = []; }
      if (alive) setFound({ term, rows: phonelessResults(live) });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [term, searchCustomersLive]);
  const rows = term && found.term === term ? found.rows : [];
  const searching = !!term && found.term !== term;

  const pick = async (row) => {
    if (busyRef.current || !row?.id) return;
    busyRef.current = true; setBusyId(row.id); setMessage('');
    let res = null;
    try {
      res = typeof linkOrderCustomerToMember === 'function' ? await linkOrderCustomerToMember(customer, row) : null;
    } catch { res = null; }
    busyRef.current = false; setBusyId(null);
    // A link that landed is handed on even when the sheet was closed meanwhile: the phone is on the
    // member now, so the order must say so (the caller checks the order is still this customer's).
    if (res?.ok) { onLinked?.(res, customer); return; }
    if (closedRef.current) return;
    setMessage(res?.message || linkMessage('failed'));
  };

  const phone = String(customer?.phone ?? '');
  const inputStyle = {
    width: '100%', background: 'var(--bg3)', border: '1px solid var(--bdr2)',
    borderRadius: 10, padding: '0 14px', height: 42,
    fontSize: 14, color: 'var(--t1)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
  };

  return (
    <div className="modal-back">
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 20, width: '100%', maxWidth: 420,
        maxHeight: '90vh', overflow: 'auto', padding: 24, boxShadow: 'var(--sh3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t1)' }}>Link to existing member</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>
              {customerLabel(customer?.name)}{phone ? ` · ${phone}` : ''}: find their loyalty profile by name or email
            </div>
          </div>
          <button onClick={close} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        <input style={inputStyle} autoFocus placeholder="Name or email" value={q}
          onChange={(e) => { setQ(e.target.value); setMessage(''); }}
          autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}/>
        <div style={{ fontSize: 11, color: 'var(--t3)', margin: '8px 2px 12px' }}>
          Only members with no phone number are shown. Tapping one links this number to them.
        </div>

        {message && (
          <div role="alert" data-link-message style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--red-d)', border: '1px solid var(--red-b)', color: 'var(--red)', fontSize: 12, fontWeight: 700 }}>
            {message}
          </div>
        )}

        {rows.length > 0 && (
          <div style={{ background: 'var(--bg3)', borderRadius: 10, border: '1px solid var(--bdr2)', overflow: 'hidden' }}>
            {rows.map((r) => {
              const card = memberCard(r);
              const busy = busyId === card.id;
              return (
                <button key={card.id} onClick={() => pick(r)} disabled={!!busyId} style={{
                  width: '100%', padding: '10px 14px', cursor: busyId ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 12,
                  background: 'transparent', border: 'none', borderBottom: '1px solid var(--bdr)', textAlign: 'left', fontFamily: 'inherit',
                  opacity: busyId && !busy ? 0.5 : 1,
                }}>
                  <span style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--acc-d)', border: '1px solid var(--acc-b)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--acc)', flexShrink: 0 }}>
                    {customerInitials(card.name === 'No name' ? '' : card.name, '')}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.name}</span>
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--t3)', marginTop: 1 }}>{card.email || 'No email'}</span>
                  </span>
                  {card.noPhone && (
                    <span data-no-phone style={{ fontSize: 10, fontWeight: 800, color: 'var(--t3)', border: '1px solid var(--bdr2)', borderRadius: 6, padding: '2px 6px', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '.04em' }}>no phone</span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--acc)', fontWeight: 700, flexShrink: 0 }}>{busy ? 'Linking…' : 'Link →'}</span>
                </button>
              );
            })}
          </div>
        )}
        {term && !searching && rows.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--t3)', padding: '6px 2px' }}>No member without a phone matches that.</div>
        )}
        {searching && rows.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--t3)', padding: '6px 2px' }}>Searching…</div>
        )}

        <div style={{ display: 'flex', marginTop: 18 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
