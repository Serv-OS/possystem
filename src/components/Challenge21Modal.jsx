// v5.5.163 — Challenge ID modal for the POS surface.
//
// Surfaces when the alcohol-sale counter on platform.locations hits the
// configured threshold. Captures:
//   • Customer first name
//   • Customer last-name initial (A-Z dropdown)
//   • ID type (Passport / Driving License / PASS card / Other)
//   • ID document number
//
// Submission writes to ops.challenge_21_checks and resets the counter.
// Cancellation is permitted but logged (cancelled=true + reason) — staff
// may need to refuse a sale rather than collect ID, and the report needs
// to show that for licensing compliance.

import { useState } from 'react';
import { supabase, platformSupabase } from '../lib/supabase';
import { useStore } from '../store';

const ID_TYPES = [
  { id: 'passport',         label: 'Passport' },
  { id: 'driving_license',  label: 'Driving License' },
  { id: 'pass_card',        label: 'PASS Card' },
  { id: 'national_id',      label: 'National ID' },
  { id: 'military_id',      label: 'Military ID' },
  { id: 'other',            label: 'Other' },
];

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export default function Challenge21Modal({ open, onClose, locationId, opsLocationId, triggerCount }) {
  const { staff } = useStore();
  const [firstName, setFirstName] = useState('');
  const [lastInitial, setLastInitial] = useState('');
  const [idType, setIdType] = useState('driving_license');
  const [idNumber, setIdNumber] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [cancelMode, setCancelMode] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  if (!open) return null;

  const resetCounter = async () => {
    if (!locationId) return;
    try {
      await platformSupabase.from('locations')
        .update({ challenge_21_counter: 0 })
        .eq('id', locationId);
    } catch (e) { console.warn('[Challenge21] reset counter failed:', e?.message); }
  };

  const submit = async () => {
    if (!firstName.trim()) { setError('First name is required'); return; }
    if (!lastInitial)       { setError('Last initial is required'); return; }
    if (!idNumber.trim())   { setError('ID number is required'); return; }
    if (!opsLocationId)     { setError('Cannot save — location not resolved'); return; }
    setWorking(true); setError('');
    try {
      const { error: iErr } = await supabase.from('challenge_21_checks').insert({
        location_id: opsLocationId,
        staff_id: staff?.id || null,
        staff_name: staff?.name || null,
        customer_first_name: firstName.trim(),
        customer_last_name_initial: lastInitial,
        id_type: idType,
        id_document_number: idNumber.trim(),
        trigger_count: triggerCount || null,
        cancelled: false,
      });
      if (iErr) {
        if (/relation .* does not exist/i.test(iErr.message)) {
          setError('DB missing — run the Challenge ID migration SQL.');
        } else {
          setError(iErr.message);
        }
        return;
      }
      await resetCounter();
      onClose?.({ saved: true });
    } catch (e) {
      setError(e?.message || 'Save failed');
    } finally {
      setWorking(false);
    }
  };

  const cancel = async () => {
    if (!cancelReason.trim()) { setError('Cancellation reason is required'); return; }
    setWorking(true); setError('');
    try {
      const { error: iErr } = await supabase.from('challenge_21_checks').insert({
        location_id: opsLocationId,
        staff_id: staff?.id || null,
        staff_name: staff?.name || null,
        customer_first_name: null,
        customer_last_name_initial: null,
        id_type: null,
        id_document_number: null,
        trigger_count: triggerCount || null,
        cancelled: true,
        cancel_reason: cancelReason.trim(),
      });
      if (iErr && !/relation .* does not exist/i.test(iErr.message)) {
        setError(iErr.message); return;
      }
      await resetCounter();
      onClose?.({ cancelled: true });
    } catch (e) {
      setError(e?.message || 'Save failed');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{
        background: 'var(--bg0)', borderRadius: 16, width: '100%', maxWidth: 520,
        border: '2px solid #f59e0b', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: '#0b0c10' }}>
          <div style={{ display:'flex', alignItems:'center', gap: 12 }}>
            <div style={{ fontSize: 32 }}>🪪</div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing:'0.1em', textTransform:'uppercase' }}>
                UK Licensing · Challenge ID
              </div>
              <div style={{ fontSize: 20, fontWeight: 900 }}>ID check required</div>
            </div>
          </div>
          <div style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
            Please check the next customer's ID and record their details below. This is logged for licensing compliance.
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: 24 }}>
          {!cancelMode ? (
            <>
              {/* First name */}
              <Field label="Customer first name">
                <input type="text" autoFocus value={firstName} onChange={e => setFirstName(e.target.value)}
                  placeholder="e.g. Alex"
                  style={inputStyle}/>
              </Field>

              {/* Last initial */}
              <Field label="Last name initial">
                <select value={lastInitial} onChange={e => setLastInitial(e.target.value)} style={{ ...inputStyle, paddingRight: 32 }}>
                  <option value="">— select —</option>
                  {LETTERS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </Field>

              {/* ID type */}
              <Field label="ID type">
                <select value={idType} onChange={e => setIdType(e.target.value)} style={{ ...inputStyle, paddingRight: 32 }}>
                  {ID_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </Field>

              {/* ID number */}
              <Field label="ID document number">
                <input type="text" value={idNumber} onChange={e => setIdNumber(e.target.value)}
                  placeholder="Number / reference on the ID"
                  style={{ ...inputStyle, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}/>
              </Field>

              {error && <div style={errorStyle}>{error}</div>}

              <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                <button onClick={() => setCancelMode(true)} disabled={working} style={cancelBtn}>
                  Refuse sale
                </button>
                <button onClick={submit} disabled={working} style={submitBtn}>
                  {working ? 'Saving…' : '✓ Save & continue'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 14, color:'var(--t1)', marginBottom: 6, fontWeight: 700 }}>
                Refusing this sale?
              </div>
              <div style={{ fontSize: 12, color:'var(--t3)', marginBottom: 14, lineHeight: 1.5 }}>
                We'll log this as a cancellation against the Challenge ID prompt. Briefly note why so it's clear in the audit log.
              </div>
              <Field label="Reason">
                <textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Customer could not produce valid ID; alcohol items removed from order"
                  style={{ ...inputStyle, minHeight: 70, fontFamily: 'inherit', resize: 'vertical' }}/>
              </Field>

              {error && <div style={errorStyle}>{error}</div>}

              <div style={{ display:'flex', gap: 10, marginTop: 14 }}>
                <button onClick={() => setCancelMode(false)} disabled={working} style={cancelBtn}>
                  ← Back
                </button>
                <button onClick={cancel} disabled={working} style={{ ...submitBtn, background: '#ef4444', color: 'white' }}>
                  {working ? 'Logging…' : 'Log cancellation'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom: 6 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '12px 14px', borderRadius: 10,
  border: '1px solid var(--bdr2)', background: 'var(--bg2)',
  color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit',
  outline: 'none', boxSizing: 'border-box',
};

const errorStyle = {
  padding: '10px 14px', borderRadius: 8, marginTop: 12,
  background: '#fef2f2', border: '1px solid #fca5a5',
  color: '#991b1b', fontSize: 13,
};

const submitBtn = {
  flex: 1, padding: '14px 18px', borderRadius: 10,
  background: 'var(--acc)', color: '#0b0c10', border: 'none',
  fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
};

const cancelBtn = {
  padding: '14px 18px', borderRadius: 10,
  background: 'transparent', color: 'var(--t2)',
  border: '1px solid var(--bdr2)',
  fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
};
