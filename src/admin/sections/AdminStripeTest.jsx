// src/admin/sections/AdminStripeTest.jsx
// Test mode only — fires a real PaymentIntent on a connected account end-to-end.

import { useEffect, useState } from 'react';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { supabase, platformSupabase } from '../../lib/supabase';
import { getStripeForAccount, createPaymentIntent } from '../../lib/stripeClient';

const S = {
  page: { padding: 0 },
  h1: { fontSize: 22, fontWeight: 800, color: '#f1f5f9', marginBottom: 4 },
  sub: { fontSize: 13, color: '#64748b', marginBottom: 28, maxWidth: 700 },
  card: { background: '#1a1d27', border: '1px solid #2d3148', borderRadius: 12, padding: 20, marginBottom: 16, maxWidth: 560 },
  label: { fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '.06em' },
  input: { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #2d3148', background: '#0f1117', color: '#f1f5f9', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btn: { padding: '10px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit' },
  btnPrimary: { background: '#6366f1', color: '#fff' },
  errorBox: { padding: 12, background: '#3f1d1d', color: '#fca5a5', borderRadius: 8, marginBottom: 16, fontSize: 13, border: '1px solid #7f1d1d' },
  successBox: { padding: 16, background: '#14532d', color: '#86efac', borderRadius: 8, marginBottom: 16, border: '1px solid #166534' },
  infoBox: { padding: 12, background: '#1e293b', color: '#cbd5e1', borderRadius: 8, marginBottom: 16, fontSize: 13, border: '1px solid #334155' },
};

export default function AdminStripeTest() {
  const [locations, setLocations] = useState([]);
  const [msaByLoc, setMsaByLoc] = useState({});
  const [companyById, setCompanyById] = useState({});
  const [chosenLocId, setChosenLocId] = useState('');
  const [amountStr, setAmountStr] = useState('12.34');
  const [currency, setCurrency] = useState('gbp');
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
          .select('location_id, stripe_account_id, charges_enabled, default_currency').in('location_id', ids);
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
        Card <code style={{ color: '#a5b4fc' }}>4242 4242 4242 4242</code> · any future expiry · any CVC.
      </div>

      <div style={S.card}>
        <label style={S.label}>1. Location</label>
        <select value={chosenLocId} onChange={e => { setChosenLocId(e.target.value); setPi(null); setResult(null); setError(null); }} style={S.input}>
          <option value="">— pick a location —</option>
          {locations.map(l => {
            const m = msaByLoc[l.id];
            const tag = !m ? '(no Stripe acct)' : !m.charges_enabled ? '(charges not enabled)' : `(${m.stripe_account_id})`;
            return <option key={l.id} value={l.id}>{companyById[l.company_id] ? `${companyById[l.company_id]} · ` : ''}{l.name} {tag}</option>;
          })}
        </select>
      </div>

      <div style={S.card}>
        <label style={S.label}>2. Amount</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="number" min="0.50" step="0.01" value={amountStr} onChange={e => setAmountStr(e.target.value)} style={{ ...S.input, flex: 1 }} />
          <select value={currency} onChange={e => setCurrency(e.target.value)} style={{ ...S.input, width: 100 }}>
            <option value="gbp">GBP</option>
            <option value="usd">USD</option>
          </select>
        </div>
      </div>

      <div style={S.card}>
        <button onClick={handleCreate} disabled={busy || !chosenLocId || !canCreate} style={{ ...S.btn, ...S.btnPrimary, opacity: (busy || !chosenLocId || !canCreate) ? 0.4 : 1 }}>
          {busy ? 'Creating…' : '3. Create PaymentIntent'}
        </button>
        {chosenLocId && !canCreate && (
          <div style={{ fontSize: 12, color: '#fbbf24', marginTop: 10 }}>
            {!msa ? '⚠ No Stripe account linked. Use Billing & Stripe accounts first.'
             : !msa.charges_enabled ? '⚠ Connected account is not yet charges-enabled — finish onboarding in Stripe.'
             : '⚠ Amount must be at least 0.50.'}
          </div>
        )}
      </div>

      {error && <div style={S.errorBox}>{error}</div>}

      {pi && stripePromise && (
        <Elements stripe={stripePromise} options={{ clientSecret: pi.client_secret }}>
          <ConfirmStep clientSecret={pi.client_secret} onResult={setResult} />
        </Elements>
      )}

      {result && (
        <div style={result.error ? S.errorBox : S.successBox}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            {result.error ? '✗ Failed' : `✓ Status: ${result.paymentIntent?.status}`}
          </div>
          <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: result.error ? '#fca5a5' : '#86efac' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ConfirmStep({ clientSecret, onResult }) {
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
  return (
    <div style={S.card}>
      <label style={S.label}>4. Card details</label>
      <div style={{ padding: 14, background: '#0f1117', borderRadius: 8, border: '1px solid #2d3148' }}>
        <CardElement options={{ style: { base: { color: '#fff', fontSize: '16px', '::placeholder': { color: '#475569' } } } }} />
      </div>
      <button onClick={submit} disabled={busy || !stripe} style={{ ...S.btn, ...S.btnPrimary, marginTop: 14, opacity: busy ? 0.4 : 1 }}>
        {busy ? 'Confirming…' : '5. Confirm payment'}
      </button>
    </div>
  );
}
