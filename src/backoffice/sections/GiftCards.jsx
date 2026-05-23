// src/backoffice/sections/GiftCards.jsx
// Back office gift card management: Issue, Lookup, Void.
// Phase 1: manual operations only. No batch, no design, no online purchase.

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

const S = {
  page:    { padding: '32px 40px', maxWidth: 1080 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 28, maxWidth: 720, lineHeight: 1.5 },
  card:    { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14, boxShadow: 'var(--sh)' },
  label:   { fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '.06em' },
  input:   { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  inputMono: { fontFamily: 'var(--font-mono, monospace)', letterSpacing: '0.12em' },
  btn:     { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', color: '#0b0c10' },
  btnGhost:{ background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  btnDan:  { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
  errorBox:{ padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
  successBox:{ padding: 12, background: 'var(--grn-d)', color: 'var(--grn)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--grn-b, var(--grn))' },
  pill:    { fontSize: 11, padding: '2px 8px', borderRadius: 99, fontWeight: 700, border: '1px solid var(--bdr)', textTransform: 'uppercase', letterSpacing: '.05em' },
};

// ── Helper: call edge function ──────────────────────────────────────────
async function callGift(endpoint, body) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(`${FUNCTIONS_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

// ── Currency formatter ──────────────────────────────────────────────────
function fmtMoney(minor, currency = 'gbp') {
  const amt = (minor || 0) / 100;
  const sym = currency === 'usd' ? '$' : String.fromCodePoint(0x00A3);
  return `${sym}${amt.toFixed(2)}`;
}

export default function GiftCards() {
  const [tab, setTab] = useState('issue'); // issue | lookup | history

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Gift Cards</h1>
      <div style={S.sub}>
        Issue, look up, and manage gift cards for this organization. Cards are valid at any location in the org.
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid var(--bdr)', paddingBottom: 0 }}>
        {[
          { id: 'issue', label: 'Issue new card' },
          { id: 'lookup', label: 'Look up card' },
          { id: 'history', label: 'Recent cards' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              ...S.btn,
              background: tab === t.id ? 'var(--acc)' : 'transparent',
              color: tab === t.id ? '#0b0c10' : 'var(--t3)',
              borderRadius: '8px 8px 0 0',
              padding: '8px 16px',
              borderBottom: tab === t.id ? '2px solid var(--acc)' : '2px solid transparent',
              marginBottom: -2,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'issue' && <IssuePanel />}
      {tab === 'lookup' && <LookupPanel />}
      {tab === 'history' && <RecentCardsPanel />}
    </div>
  );
}

// ─── Issue Panel ────────────────────────────────────────────────────────
function IssuePanel() {
  const [amount, setAmount] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [note, setNote] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const handleIssue = async () => {
    setError(null); setResult(null); setIssuing(true);
    try {
      const amountMinor = Math.round(parseFloat(amount) * 100);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
        throw new Error('Enter a valid amount');
      }
      const res = await callGift('gift-issue', {
        amount: amountMinor,
        recipient_name: recipientName || undefined,
        recipient_email: recipientEmail || undefined,
        note: note || undefined,
      });
      setResult(res);
      // Clear form
      setAmount(''); setRecipientName(''); setRecipientEmail(''); setNote('');
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setIssuing(false);
    }
  };

  return (
    <div style={S.card}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 14 }}>Issue a new gift card</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <label style={S.label}>Amount (major units, e.g. 25.00)</label>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="25.00"
            step="0.01"
            min="0"
            style={S.input}
          />
        </div>
        <div>
          <label style={S.label}>Recipient name (optional)</label>
          <input type="text" value={recipientName} onChange={e => setRecipientName(e.target.value)} placeholder="Jane Smith" style={S.input}/>
        </div>
        <div>
          <label style={S.label}>Recipient email (optional)</label>
          <input type="email" value={recipientEmail} onChange={e => setRecipientEmail(e.target.value)} placeholder="jane@example.com" style={S.input}/>
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label style={S.label}>Note (optional)</label>
          <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Happy birthday, etc." style={S.input}/>
        </div>
      </div>

      {error && <div style={{ ...S.errorBox, marginTop: 14 }}>{error}</div>}

      {result && (
        <div style={{ ...S.successBox, marginTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Card issued successfully</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
            <div><strong>Code:</strong> <span style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', fontSize: 15, fontWeight: 800 }}>{result.code}</span></div>
            <div><strong>Balance:</strong> {fmtMoney(result.balance, result.currency)}</div>
            <div><strong>Last 4:</strong> {result.code_last4}</div>
            <div><strong>Expires:</strong> {result.expires_at ? new Date(result.expires_at).toLocaleDateString() : 'Never'}</div>
          </div>
          <div style={{ marginTop: 10, padding: 10, background: 'rgba(0,0,0,0.1)', borderRadius: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--t1)' }}>
            {String.fromCodePoint(0x26A0)} Write down or copy this code now. It cannot be displayed again after leaving this screen.
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <button onClick={handleIssue} disabled={issuing || !amount} style={{ ...S.btn, ...S.btnPrim }}>
          {issuing ? 'Issuing...' : 'Issue gift card'}
        </button>
      </div>
    </div>
  );
}

// ─── Lookup Panel ───────────────────────────────────────────────────────
function LookupPanel() {
  const [code, setCode] = useState('');
  const [last4, setLast4] = useState('');
  const [email, setEmail] = useState('');
  const [lookupMode, setLookupMode] = useState('code'); // code | last4
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [card, setCard] = useState(null);
  const [voidConfirm, setVoidConfirm] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  const handleLookup = async () => {
    setError(null); setCard(null); setLoading(true); setVoidConfirm(false);
    try {
      let body;
      if (lookupMode === 'code') {
        if (!code.trim()) throw new Error('Enter a gift card code');
        body = { code: code.trim() };
      } else {
        if (!last4.trim() || !email.trim()) throw new Error('Enter both last 4 and email');
        body = { code_last4: last4.trim(), email: email.trim() };
      }
      const res = await callGift('gift-lookup', body);
      setCard(res);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const handleVoid = async () => {
    if (!voidReason.trim()) { setError('Enter a reason for voiding'); return; }
    setError(null); setVoiding(true);
    try {
      await callGift('gift-void', {
        card_id: card.card_id,
        reason: voidReason.trim(),
      });
      // Re-lookup to refresh state
      setCard({ ...card, status: 'voided', balance: 0 });
      setVoidConfirm(false);
      setVoidReason('');
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setVoiding(false);
    }
  };

  const statusColor = (s) => {
    if (s === 'active') return { background: 'var(--grn-d)', color: 'var(--grn)', borderColor: 'var(--grn)' };
    if (s === 'redeemed') return { background: 'var(--bg3)', color: 'var(--t3)', borderColor: 'var(--bdr)' };
    if (s === 'voided') return { background: 'var(--red-d)', color: 'var(--red)', borderColor: 'var(--red)' };
    if (s === 'expired') return { background: 'var(--red-d)', color: 'var(--red)', borderColor: 'var(--red)' };
    return {};
  };

  return (
    <div style={S.card}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 14 }}>Look up a gift card</div>

      {/* Lookup mode toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button
          onClick={() => setLookupMode('code')}
          style={{ ...S.btn, ...(lookupMode === 'code' ? S.btnPrim : S.btnGhost), padding: '6px 12px', fontSize: 12 }}
        >By full code</button>
        <button
          onClick={() => setLookupMode('last4')}
          style={{ ...S.btn, ...(lookupMode === 'last4' ? S.btnPrim : S.btnGhost), padding: '6px 12px', fontSize: 12 }}
        >By last 4 + email</button>
      </div>

      {lookupMode === 'code' ? (
        <div>
          <label style={S.label}>Gift card code (16 characters)</label>
          <input
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ''))}
            placeholder="ABCD EFGH JKLM NPQR"
            maxLength={19}
            style={{ ...S.input, ...S.inputMono, fontSize: 16 }}
            onKeyDown={e => e.key === 'Enter' && handleLookup()}
          />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
          <div>
            <label style={S.label}>Last 4 of code</label>
            <input
              type="text"
              value={last4}
              onChange={e => setLast4(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4))}
              placeholder="NPQR"
              maxLength={4}
              style={{ ...S.input, ...S.inputMono }}
            />
          </div>
          <div>
            <label style={S.label}>Recipient email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="jane@example.com"
              style={S.input}
              onKeyDown={e => e.key === 'Enter' && handleLookup()}
            />
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button onClick={handleLookup} disabled={loading} style={{ ...S.btn, ...S.btnPrim }}>
          {loading ? 'Looking up...' : 'Look up'}
        </button>
      </div>

      {error && <div style={{ ...S.errorBox, marginTop: 14 }}>{error}</div>}

      {/* Card result */}
      {card && (
        <div style={{ marginTop: 18, padding: 16, background: 'var(--bg2)', borderRadius: 10, border: '1px solid var(--bdr)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--t1)' }}>
              {fmtMoney(card.balance, card.currency)}
            </span>
            <span style={{ ...S.pill, ...statusColor(card.status) }}>{card.status}</span>
            <span style={{ fontSize: 12, color: 'var(--t4)', fontFamily: 'var(--font-mono)', marginLeft: 'auto' }}>
              ...{card.code_last4}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, fontSize: 12, color: 'var(--t2)', marginBottom: 14 }}>
            <div><strong style={{ color: 'var(--t3)' }}>Initial value:</strong><br/>{fmtMoney(card.initial_amount, card.currency)}</div>
            <div><strong style={{ color: 'var(--t3)' }}>Issued:</strong><br/>{card.issued_at ? new Date(card.issued_at).toLocaleDateString() : 'N/A'}</div>
            <div><strong style={{ color: 'var(--t3)' }}>Expires:</strong><br/>{card.expires_at ? new Date(card.expires_at).toLocaleDateString() : 'Never'}</div>
            {card.recipient_name && <div><strong style={{ color: 'var(--t3)' }}>Recipient:</strong><br/>{card.recipient_name}</div>}
            {card.recipient_email && <div><strong style={{ color: 'var(--t3)' }}>Email:</strong><br/>{card.recipient_email}</div>}
            {card.note && <div><strong style={{ color: 'var(--t3)' }}>Note:</strong><br/>{card.note}</div>}
          </div>

          {/* Transaction history */}
          {card.recent_transactions?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
                Transaction history
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {card.recent_transactions.map(tx => (
                  <div key={tx.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
                    borderBottom: '1px solid var(--bdr)', fontSize: 12,
                  }}>
                    <span style={{
                      ...S.pill, fontSize: 10, padding: '1px 6px',
                      background: tx.type === 'issue' ? 'var(--grn-d)' : tx.type === 'refund' ? 'var(--grn-d)' : 'var(--red-d)',
                      color: tx.type === 'issue' ? 'var(--grn)' : tx.type === 'refund' ? 'var(--grn)' : 'var(--red)',
                    }}>
                      {tx.type}
                    </span>
                    <span style={{ fontWeight: 700, color: tx.amount_minor >= 0 ? 'var(--grn)' : 'var(--red)', fontFamily: 'var(--font-mono)', minWidth: 70 }}>
                      {tx.amount_minor >= 0 ? '+' : ''}{fmtMoney(Math.abs(tx.amount_minor), card.currency)}
                    </span>
                    <span style={{ color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                      bal {fmtMoney(tx.balance_after_minor, card.currency)}
                    </span>
                    {tx.channel && <span style={{ color: 'var(--t4)' }}>{tx.channel}</span>}
                    <span style={{ color: 'var(--t4)', marginLeft: 'auto', fontSize: 11 }}>
                      {new Date(tx.created_at).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Void button */}
          {card.status === 'active' && (
            <div style={{ marginTop: 14 }}>
              {!voidConfirm ? (
                <button onClick={() => setVoidConfirm(true)} style={{ ...S.btn, ...S.btnDan, fontSize: 12 }}>
                  Void this card
                </button>
              ) : (
                <div style={{ padding: 12, background: 'var(--red-d)', borderRadius: 8, border: '1px solid var(--red-b)' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)', marginBottom: 8 }}>
                    Are you sure? This will zero the balance and permanently deactivate the card.
                  </div>
                  <label style={S.label}>Reason for voiding</label>
                  <input
                    type="text"
                    value={voidReason}
                    onChange={e => setVoidReason(e.target.value)}
                    placeholder="e.g. Fraud, customer request, duplicate issue"
                    style={S.input}
                    autoFocus
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button onClick={handleVoid} disabled={voiding || !voidReason.trim()} style={{ ...S.btn, background: 'var(--red)', color: '#fff' }}>
                      {voiding ? 'Voiding...' : 'Confirm void'}
                    </button>
                    <button onClick={() => { setVoidConfirm(false); setVoidReason(''); }} style={{ ...S.btn, ...S.btnGhost }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Recent Cards Panel ─────────────────────────────────────────────────
function RecentCardsPanel() {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await callGift('gift-list', {});
        setCards(res.cards ?? []);
      } catch (e) {
        setError(String(e?.message ?? e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const statusColor = (s) => {
    if (s === 'active') return { background: 'var(--grn-d)', color: 'var(--grn)', borderColor: 'var(--grn)' };
    if (s === 'redeemed') return { background: 'var(--bg3)', color: 'var(--t3)', borderColor: 'var(--bdr)' };
    if (s === 'voided') return { background: 'var(--red-d)', color: 'var(--red)', borderColor: 'var(--red)' };
    if (s === 'expired') return { background: 'var(--red-d)', color: 'var(--red)', borderColor: 'var(--red)' };
    return {};
  };

  return (
    <div style={S.card}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 14 }}>Recent gift cards</div>

      {error && <div style={S.errorBox}>{error}</div>}

      {loading ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>Loading...</div>
      ) : cards.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)', fontSize: 13, background: 'var(--bg2)', borderRadius: 8, border: '1px dashed var(--bdr)' }}>
          No gift cards issued yet. Use the "Issue new card" tab to create one.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--bdr)' }}>
                {['Code', 'Status', 'Initial', 'Balance', 'Recipient', 'Issued', 'Expires'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cards.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--bdr)' }}>
                  <td style={{ padding: '8px', fontFamily: 'var(--font-mono)', color: 'var(--t1)', fontWeight: 600 }}>...{c.code_last4}</td>
                  <td style={{ padding: '8px' }}>
                    <span style={{ ...S.pill, ...statusColor(c.status), fontSize: 10, padding: '1px 6px' }}>{c.status}</span>
                  </td>
                  <td style={{ padding: '8px', color: 'var(--t2)' }}>{fmtMoney(c.initial_amount_minor)}</td>
                  <td style={{ padding: '8px', fontWeight: 700, color: c.balance_minor > 0 ? 'var(--t1)' : 'var(--t4)' }}>{fmtMoney(c.balance_minor)}</td>
                  <td style={{ padding: '8px', color: 'var(--t2)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.recipient_name || c.recipient_email || String.fromCodePoint(0x2014)}
                  </td>
                  <td style={{ padding: '8px', color: 'var(--t3)', fontSize: 11 }}>{c.issued_at ? new Date(c.issued_at).toLocaleDateString() : ''}</td>
                  <td style={{ padding: '8px', color: 'var(--t3)', fontSize: 11 }}>{c.expires_at ? new Date(c.expires_at).toLocaleDateString() : 'Never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
