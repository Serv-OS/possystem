// src/admin/sections/AdminStripeTest.jsx
// Test mode only — fires a real PaymentIntent on a connected account end-to-end,
// with a channel selector so you can test card-present vs online markup paths.

import { useEffect, useState } from 'react';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { supabase, platformSupabase } from '../../lib/supabase';
import { getStripeForAccount, createPaymentIntent } from '../../lib/stripeClient';

const S = {
  page:    { padding: 0 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 24, maxWidth: 720, lineHeight: 1.5 },
  card:    { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 14, maxWidth: 600, boxShadow: 'var(--sh)' },
  label:   { fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '.06em' },
  input:   { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btn:     { padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrim: { background: 'var(--acc)', color: '#0b0c10' },
  errorBox:{ padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
  okBox:   { padding: 14, background: 'var(--grn-d)', color: 'var(--grn)', borderRadius: 8, marginBottom: 14, border: '1px solid var(--grn-b)' },
  warn:    { padding: 10, background: 'rgba(232,160,32,.10)', color: 'var(--acc)', borderRadius: 8, fontSize: 12, border: '1px solid var(--acc-b)' },
  segBtn:  { flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t2)', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  segBtnActive: { background: 'var(--acc-d)', color: 'var(--acc)', border: '1px solid var(--acc-b)' },
};

export default function AdminStripeTest() {
  const [locations, setLocations] = useState([]);
  const [msaByLoc, setMsaByLoc] = useState({});
  const [companyById, setCompanyById] = useState({});
  const [chosenLocId, setChosenLocId] = useState('');
  const [amountStr, setAmountStr] = useState('12.34');
  const [currency, setCurrency] = useState('gbp');
  const [channel, setChannel] = useState('online');
  const [pi, setPi] = useState(null);
  const [stripePromise, setStripePromise] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      if (!platformSupabase) { setError('Platform Supabase not configured'); return; }
      const [{ data: cos }, { data: locs }] = await Promise.all([
        platformSupabase.from('companies').select('id, name'),
        platformSupabase.from('locations').select('id, name, company_id'),
      ]);
      const c = {}; (cos ?? []).forEach(co => { c[co.id] = co.name; });
      setCompanyById(c);
      setLocations(locs ?? []);
      const ids = (locs ?? []).map(l => l.id);
      if (ids.length) {
        const { data: msas } = await platformSupabase.from('merchant_stripe_accounts')
          .select('location_id, stripe_account_id, charges_enabled, default_currency, cardpresent_markup_percent, online_markup_percent').in('location_id', ids);
        const m = {}; (msas ?? []).forEach(r => { m[r.location_id] = r; });
        setMsaByLoc(m);
      }
    })();
  }, []);

  const msa = msaByLoc[chosenLocId];
  const canCreate = msa?.charges_enabled && Number(amountStr) >= 0.5;

  const handleCreate = async () => {
    setError(null); setResult(null); setPi(null); setBusy(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('not authenticated');
      const piRes = await createPaymentIntent({
        authToken: token,
        locationId: chosenLocId,
        amountMinor: Math.round(Number(amountStr) * 100),
        currency,
        channel,
        description: `Admin test harness payment ${amountStr}`,
        paymentMethodTypes: ['card'],
        metadata: { source: 'admin_stripe_test' },
      });
      setPi(piRes);
      setStripePromise(getStripeForAccount(piRes.stripe_account));
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally { setBusy(false); }
  };

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Stripe test harness</h1>
      <div style={S.sub}>
        Test-mode only. Creates a real PaymentIntent on the selected location's connected account, then confirms it with Stripe Elements.
        Use card <code style={{ color: 'var(--acc)', fontFamily: 'var(--font-mono, monospace)' }}>4242 4242 4242 4242</code> · any future expiry · any CVC.
      </div>

      <div style={S.card}>
        <label style={S.label}>1. Location</label>
        <select value={chosenLocId} onChange={e => { setChosenLocId(e.target.value); setPi(null); setResult(null); setError(null); }} style={S.input}>
          <option value="">— pick a location —</option>
          {locations.map(l => {
            const m = msaByLoc[l.id];
            const tag = !m ? '· no Stripe acct'
                       : !m.charges_enabled ? '· charges not enabled'
                       : `· ${m.stripe_account_id}`;
            return <option key={l.id} value={l.id}>{companyById[l.company_id] ? `${companyById[l.company_id]} — ` : ''}{l.name} {tag}</option>;
          })}
        </select>
      </div>

      <div style={S.card}>
        <label style={S.label}>2. Channel (which markup % applies)</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setChannel('online')} style={{ ...S.segBtn, ...(channel==='online' ? S.segBtnActive : {}) }}>
            🌐 Online
          </button>
          <button onClick={() => setChannel('card_present')} style={{ ...S.segBtn, ...(channel==='card_present' ? S.segBtnActive : {}) }}>
            💳 In-person
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6 }}>
          The function will use the <code>{channel === 'online' ? 'online_markup_percent' : 'cardpresent_markup_percent'}</code> field for this location, falling back to platform default if null.
        </div>
      </div>

      <div style={S.card}>
        <label style={S.label}>3. Amount</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="number" min="0.50" step="0.01" value={amountStr} onChange={e => setAmountStr(e.target.value)} style={{ ...S.input, flex: 1 }} />
          <select value={currency} onChange={e => setCurrency(e.target.value)} style={{ ...S.input, width: 100 }}>
            <option value="gbp">GBP</option>
            <option value="usd">USD</option>
          </select>
        </div>
      </div>

      <div style={S.card}>
        <button onClick={handleCreate} disabled={busy || !chosenLocId || !canCreate} style={{ ...S.btn, ...S.btnPrim, opacity: (busy || !chosenLocId || !canCreate) ? 0.4 : 1 }}>
          {busy ? 'Creating…' : '4. Create PaymentIntent'}
        </button>
        {chosenLocId && !canCreate && (
          <div style={{ ...S.warn, marginTop: 10 }}>
            {!msa ? 'No Stripe account linked. Use Billing & Stripe accounts first.'
             : !msa.charges_enabled ? 'Connected account is not yet charges-enabled — finish onboarding in Stripe.'
             : 'Amount must be at least 0.50.'}
          </div>
        )}
      </div>

      {error && <div style={S.errorBox}>{error}</div>}

      {pi && stripePromise && (
        <Elements stripe={stripePromise} options={{ clientSecret: pi.client_secret }}>
          <ConfirmStep clientSecret={pi.client_secret} pi={pi} onResult={setResult} />
        </Elements>
      )}

      {result && (
        <div style={result.error ? S.errorBox : S.okBox}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>
            {result.error ? '✗ Failed' : `✓ Status: ${result.paymentIntent?.status}`}
          </div>
          <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono, monospace)' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ConfirmStep({ clientSecret, pi, onResult }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    const card = elements.getElement(CardElement);
    const { error, paymentIntent } = await stripe.confirmCardPayment(clientSecret, { payment_method: { card } });
    setBusy(false);
    onResult(error ? { error: error.message } : { paymentIntent });
  };

  // Show the markup that will be applied
  const markupPct = Number(pi?.markup_percent ?? 0);
  const feeMinor = Number(pi?.application_fee_minor ?? 0);
  const feeMajor = (feeMinor / 100).toFixed(2);

  return (
    <div style={S.card}>
      <label style={S.label}>5. Card details</label>
      <div style={{ padding: 12, background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--bdr2)' }}>
        <CardElement options={{ style: { base: { color: 'var(--t1)', fontSize: '16px', '::placeholder': { color: 'var(--t4)' } } } }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8 }}>
        Markup applied: <strong style={{ color: 'var(--acc)' }}>{markupPct.toFixed(2)}%</strong> = <strong style={{ color: 'var(--acc)' }}>{feeMajor}</strong> {(pi?.client_secret || '').includes('gbp') ? 'GBP' : ''} → routed to platform balance.
      </div>
      <button onClick={submit} disabled={busy || !stripe} style={{ ...S.btn, ...S.btnPrim, marginTop: 14, opacity: busy ? 0.4 : 1 }}>
        {busy ? 'Confirming…' : '6. Confirm payment'}
      </button>
    </div>
  );
}
