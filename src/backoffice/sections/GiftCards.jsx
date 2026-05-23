// src/backoffice/sections/GiftCards.jsx
// v5.5.199 — Back office gift card management.
// Full management surface: enable toggle, branding editor, customer URLs,
// issue, lookup, void, bulk create, import, purchase history, settings.

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, platformSupabase, getLocationId } from '../../lib/supabase';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const DEV_HOST = 'https://dev.pos-up.com';
const PROD_ROOT = 'pos-up.com';
const ASSET_BUCKET = 'receipt-assets';

const BLANK_BRANDING = {
  logo_url: '',
  hero_url: '',
  accent_color: '#e8a020',
  background:   '#0e0e10',
  foreground:   '#ffffff',
};

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
  link:    { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--acc)', fontWeight: 700, fontSize: 13, padding: 0, textDecoration: 'underline' },
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

// ── Asset upload ────────────────────────────────────────────────────────
async function uploadGiftAsset(file, locationId, kind) {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const path = `locations/${locationId}/gift/${kind}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (upErr) throw upErr;
  const { data: urlData } = supabase.storage.from(ASSET_BUCKET).getPublicUrl(path);
  return `${urlData.publicUrl}?t=${Date.now()}`;
}

// ── Currency formatter ──────────────────────────────────────────────────
function fmtMoney(minor, currency = 'gbp') {
  const amt = (minor || 0) / 100;
  const sym = currency === 'usd' ? '$' : String.fromCodePoint(0x00A3);
  return `${sym}${amt.toFixed(2)}`;
}

export default function GiftCards() {
  const [tab, setTab] = useState('overview'); // overview | issue | bulk | import | lookup | history | purchases | settings
  const [loading, setLoading] = useState(true);
  const [locationRow, setLocationRow] = useState(null);
  const [opsLocId, setOpsLocId] = useState(null);
  const [brandConfig, setBrandConfig] = useState(null);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState('');

  // Load location + gift_brand_config on mount
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!platformSupabase) { setLoading(false); return; }
        const locId = await getLocationId().catch(() => null);
        if (alive) setOpsLocId(locId);
        let loc = null;
        if (locId) {
          const { data } = await platformSupabase.from('locations')
            .select('id, name, online_slug, online_enabled, company_id, online_branding')
            .eq('ops_location_id', locId).maybeSingle();
          loc = data;
          if (!loc) {
            const { data: r2 } = await platformSupabase.from('locations')
              .select('id, name, online_slug, online_enabled, company_id, online_branding')
              .eq('id', locId).maybeSingle();
            loc = r2;
          }
        }
        if (alive) setLocationRow(loc);

        // Load gift brand config for this company
        if (loc?.company_id) {
          const { data: cfg } = await platformSupabase.from('gift_brand_config')
            .select('*').eq('company_id', loc.company_id).maybeSingle();
          if (alive) setBrandConfig(cfg);
        }
      } catch (e) {
        console.error('[GiftCards] load:', e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Toggle enabled
  const toggleEnabled = async () => {
    if (!locationRow?.company_id || !platformSupabase) return;
    setEnabling(true);
    setEnableError('');
    try {
      const newVal = !brandConfig?.enabled;
      if (brandConfig) {
        const { error } = await platformSupabase.from('gift_brand_config')
          .update({ enabled: newVal }).eq('company_id', locationRow.company_id);
        if (error) throw error;
        setBrandConfig(c => ({ ...c, enabled: newVal }));
      } else {
        // Create config via gift-issue pattern (edge function creates it with hmac_secret)
        // But now we have INSERT RLS, so we can do it directly
        const hmacSecret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        const { data, error } = await platformSupabase.from('gift_brand_config')
          .insert({
            company_id: locationRow.company_id,
            enabled: true,
            hmac_secret: hmacSecret,
          })
          .select('*')
          .single();
        if (error) throw error;
        setBrandConfig(data);
      }
    } catch (e) {
      setEnableError(e?.message || 'Failed to toggle');
    } finally {
      setEnabling(false);
    }
  };

  const slug = locationRow?.online_slug;
  const giftEnabled = !!brandConfig?.enabled;

  // Customer-facing URLs
  const previewPurchase = slug ? `${DEV_HOST}/?loc=${slug}&surface=gift` : null;
  const previewBalance  = slug ? `${DEV_HOST}/?loc=${slug}&surface=gift_balance` : null;
  const prodPurchase    = slug ? `https://${slug}.${PROD_ROOT}/gift` : null;
  const prodBalance     = slug ? `https://${slug}.${PROD_ROOT}/gift/balance` : null;

  if (loading) return <div style={{ padding: 40, color: 'var(--t4)', fontSize: 13 }}>Loading...</div>;

  return (
    <div style={S.page}>
      <h1 style={S.h1}>{String.fromCodePoint(0x1F381)} Gift Cards</h1>
      <div style={S.sub}>
        Issue, look up, and manage gift cards. Customers can purchase gift cards online through the customer-facing page.
      </div>

      {/* ── Status + Customer URLs card ──────────────────────────────── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 2 }}>
              Gift card purchasing
            </div>
            <div style={{ fontSize: 12, color: 'var(--t4)' }}>
              {giftEnabled
                ? 'Customers can buy gift cards online'
                : 'Disabled — toggle on to let customers purchase gift cards online'}
            </div>
          </div>
          <button
            onClick={toggleEnabled}
            disabled={enabling || !locationRow}
            style={{
              width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer',
              background: giftEnabled ? 'var(--grn)' : 'var(--bdr2)',
              position: 'relative', transition: 'background .2s', flexShrink: 0,
            }}
          >
            <div style={{
              width: 20, height: 20, borderRadius: 10, background: '#fff',
              position: 'absolute', top: 3,
              left: giftEnabled ? 25 : 3,
              transition: 'left .2s',
            }}/>
          </button>
        </div>

        {enableError && <div style={{ ...S.errorBox, marginBottom: 10 }}>{enableError}</div>}

        {/* Customer-facing URLs */}
        {slug ? (
          <div style={{ padding: '14px 16px', background: 'var(--bg2)', borderRadius: 10, border: '1px solid var(--bdr)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>
              Customer links
            </div>
            <UrlRow label="Purchase page" liveUrl={prodPurchase} previewUrl={previewPurchase} enabled={giftEnabled}/>
            <UrlRow label="Balance check" liveUrl={prodBalance} previewUrl={previewBalance} enabled={true}/>
          </div>
        ) : (
          <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--acc-d)', border: '1px solid var(--acc-b)', color: 'var(--acc)', fontSize: 12, lineHeight: 1.6 }}>
            {String.fromCodePoint(0x2139)} No slug set yet. Set one in Location Settings to enable customer-facing gift card URLs.
          </div>
        )}

        {/* Config summary */}
        {brandConfig && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 14, fontSize: 12 }}>
            <ConfigStat label="Min value" value={fmtMoney(brandConfig.min_card_value_minor)} />
            <ConfigStat label="Max value" value={fmtMoney(brandConfig.max_card_value_minor)} />
            <ConfigStat label="Expiry" value={brandConfig.default_expiry_months ? `${brandConfig.default_expiry_months} months` : 'Never'} />
            <ConfigStat label="Currency" value={(brandConfig.currency || 'gbp').toUpperCase()} />
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid var(--bdr)', paddingBottom: 0, flexWrap: 'wrap' }}>
        {[
          { id: 'issue', label: 'Issue card' },
          { id: 'bulk', label: 'Bulk create' },
          { id: 'import', label: 'Import' },
          { id: 'lookup', label: 'Look up' },
          { id: 'history', label: 'Recent cards' },
          { id: 'purchases', label: 'Online purchases' },
          { id: 'branding', label: 'Branding' },
          { id: 'settings', label: 'Settings' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              ...S.btn,
              background: tab === t.id ? 'var(--acc)' : 'transparent',
              color: tab === t.id ? '#0b0c10' : 'var(--t3)',
              borderRadius: '8px 8px 0 0',
              padding: '8px 14px',
              borderBottom: tab === t.id ? '2px solid var(--acc)' : '2px solid transparent',
              marginBottom: -2, fontSize: 12,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'issue' && <IssuePanel />}
      {tab === 'bulk' && <BulkCreatePanel config={brandConfig} />}
      {tab === 'import' && <ImportPanel />}
      {tab === 'lookup' && <LookupPanel />}
      {tab === 'history' && <RecentCardsPanel />}
      {tab === 'purchases' && <PurchasesPanel companyId={locationRow?.company_id} />}
      {tab === 'branding' && <BrandingPanel locationRow={locationRow} opsLocId={opsLocId} brandConfig={brandConfig} onConfigUpdate={setBrandConfig} />}
      {tab === 'settings' && <SettingsPanel brandConfig={brandConfig} companyId={locationRow?.company_id} onConfigUpdate={setBrandConfig} />}
    </div>
  );
}

// ── Config stat cell ──────────────────────────────────────────────────
function ConfigStat({ label, value }) {
  return (
    <div style={{ padding: '8px 10px', background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 700, color: 'var(--t1)', fontSize: 12 }}>{value}</div>
    </div>
  );
}

// ── URL row component ──────────────────────────────────────────────────
function UrlRow({ label, liveUrl, previewUrl, enabled }) {
  const [copied, setCopied] = useState(false);
  const copy = (url) => {
    navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <div style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: enabled ? 'var(--grn)' : 'var(--t4)' }}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--t4)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{liveUrl}</div>
      </div>
      {previewUrl && (
        <a href={previewUrl} target="_blank" rel="noopener" style={{
          padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
          background: 'var(--acc-d)', border: '1px solid var(--acc-b)', color: 'var(--acc)',
          textDecoration: 'none', whiteSpace: 'nowrap',
        }}>
          Preview {String.fromCodePoint(0x2197)}
        </a>
      )}
      {liveUrl && (
        <button onClick={() => copy(liveUrl)} style={{ ...S.btn, padding: '4px 10px', fontSize: 11, ...S.btnGhost, whiteSpace: 'nowrap' }}>
          {copied ? String.fromCodePoint(0x2713) + ' Copied' : 'Copy'}
        </button>
      )}
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
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Enter a valid amount');
      const res = await callGift('gift-issue', {
        amount: amountMinor,
        recipient_name: recipientName || undefined,
        recipient_email: recipientEmail || undefined,
        note: note || undefined,
      });
      setResult(res);
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
          <label style={S.label}>Amount (e.g. 25.00)</label>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="25.00" step="0.01" min="0" style={S.input}/>
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

// ─── Bulk Create Panel ─────────────────────────────────────────────────
function BulkCreatePanel({ config }) {
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('10');
  const [batchName, setBatchName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const handleCreate = async () => {
    setError(null); setResult(null); setCreating(true);
    try {
      const amountMinor = Math.round(parseFloat(amount) * 100);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error('Enter a valid amount');
      const qty = parseInt(quantity, 10);
      if (!qty || qty < 1 || qty > 500) throw new Error('Quantity must be 1-500');
      if (!batchName.trim()) throw new Error('Enter a batch name');

      const res = await callGift('gift-bulk-create', {
        amount: amountMinor,
        quantity: qty,
        batch_name: batchName.trim(),
      });
      setResult(res);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setCreating(false);
    }
  };

  const downloadCSV = () => {
    if (!result?.cards) return;
    const rows = [['Code', 'Last 4', 'Amount', 'Currency', 'Batch', 'Expires']];
    result.cards.forEach(c => {
      rows.push([c.code, c.code_last4, fmtMoney(result.amount, result.currency), result.currency, result.batch_name, result.expires_at || 'Never']);
    });
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `gift-cards-${result.batch_name.replace(/\s+/g, '-')}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div style={S.card}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Bulk create gift cards</div>
      <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 14 }}>
        Create multiple cards at once with the same value. No recipient details needed — cards are anonymous until used.
      </div>

      {!result ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
            <div>
              <label style={S.label}>Amount per card</label>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="25.00" step="0.01" min="0" style={S.input}/>
            </div>
            <div>
              <label style={S.label}>Quantity (1-500)</label>
              <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="10" min="1" max="500" style={S.input}/>
            </div>
            <div>
              <label style={S.label}>Batch name</label>
              <input type="text" value={batchName} onChange={e => setBatchName(e.target.value)} placeholder="e.g. Christmas 2026 promo" style={S.input}/>
            </div>
          </div>

          {error && <div style={{ ...S.errorBox, marginTop: 14 }}>{error}</div>}

          <div style={{ marginTop: 16 }}>
            <button onClick={handleCreate} disabled={creating || !amount || !batchName.trim()} style={{ ...S.btn, ...S.btnPrim }}>
              {creating ? 'Creating...' : `Create ${quantity || '?'} cards`}
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ ...S.successBox }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
              {result.quantity} cards created — batch "{result.batch_name}"
            </div>
            <div style={{ fontSize: 12 }}>
              Each card: {fmtMoney(result.amount, result.currency)} | Expires: {result.expires_at ? new Date(result.expires_at).toLocaleDateString() : 'Never'}
            </div>
            {result.errors && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>
                {result.errors.length} error(s): {result.errors.slice(0, 3).join('; ')}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <button onClick={downloadCSV} style={{ ...S.btn, ...S.btnPrim }}>
              {String.fromCodePoint(0x2B07)} Download CSV
            </button>
            <button onClick={() => { setResult(null); setAmount(''); setBatchName(''); }} style={{ ...S.btn, ...S.btnGhost }}>
              Create another batch
            </button>
          </div>

          <div style={{ marginTop: 10, padding: 10, background: 'rgba(0,0,0,0.1)', borderRadius: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--t1)' }}>
            {String.fromCodePoint(0x26A0)} Download the CSV now. These codes cannot be recovered after leaving this screen.
          </div>

          {/* Codes table */}
          <div style={{ maxHeight: 400, overflowY: 'auto', marginTop: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--bdr)' }}>
                  {['#', 'Code', 'Last 4'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.cards.map((c, i) => (
                  <tr key={c.card_id} style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '6px 8px', color: 'var(--t4)' }}>{i + 1}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.08em' }}>{c.code}</td>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', color: 'var(--t3)' }}>{c.code_last4}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Import Panel ──────────────────────────────────────────────────────
function ImportPanel() {
  const [batchName, setBatchName] = useState('');
  const [rows, setRows] = useState([{ balance: '', recipient_name: '', recipient_email: '', note: '', original_code: '' }]);
  const [csvText, setCsvText] = useState('');
  const [mode, setMode] = useState('manual'); // manual | csv
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const addRow = () => setRows(r => [...r, { balance: '', recipient_name: '', recipient_email: '', note: '', original_code: '' }]);
  const removeRow = (i) => setRows(r => r.filter((_, idx) => idx !== i));
  const updateRow = (i, field, val) => setRows(r => r.map((row, idx) => idx === i ? { ...row, [field]: val } : row));

  const parseCSV = () => {
    try {
      const lines = csvText.trim().split('\n').filter(l => l.trim());
      if (lines.length === 0) throw new Error('No data');
      // Auto-detect header
      const first = lines[0].toLowerCase();
      const hasHeader = first.includes('balance') || first.includes('amount') || first.includes('value');
      const dataLines = hasHeader ? lines.slice(1) : lines;

      const parsed = dataLines.map(line => {
        const cols = line.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
        return {
          balance: cols[0] || '',
          recipient_name: cols[1] || '',
          recipient_email: cols[2] || '',
          note: cols[3] || '',
          original_code: cols[4] || '',
        };
      }).filter(r => r.balance);
      if (parsed.length === 0) throw new Error('No valid rows found');
      setRows(parsed);
      setMode('manual'); // switch to manual view with parsed data
      setError(null);
    } catch (e) {
      setError(`CSV parse error: ${e.message}`);
    }
  };

  const handleImport = async () => {
    setError(null); setResult(null); setImporting(true);
    try {
      if (!batchName.trim()) throw new Error('Enter a batch name');
      const cards = rows.filter(r => r.balance).map(r => ({
        balance: Math.round(parseFloat(r.balance) * 100),
        recipient_name: r.recipient_name || undefined,
        recipient_email: r.recipient_email || undefined,
        note: r.note || undefined,
        original_code: r.original_code || undefined,
      }));
      if (cards.length === 0) throw new Error('Add at least one card with a balance');
      if (cards.some(c => !Number.isFinite(c.balance) || c.balance <= 0)) throw new Error('All balances must be positive numbers');

      const res = await callGift('gift-import', { batch_name: batchName.trim(), cards });
      setResult(res);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setImporting(false);
    }
  };

  const downloadCSV = () => {
    if (!result?.cards) return;
    const csvRows = [['New Code', 'Last 4', 'Balance', 'Currency']];
    result.cards.forEach(c => {
      csvRows.push([c.code, c.code_last4, fmtMoney(c.balance, result.currency), result.currency]);
    });
    const csv = csvRows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `imported-gift-cards-${result.batch_name.replace(/\s+/g, '-')}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  if (result) {
    return (
      <div style={S.card}>
        <div style={{ ...S.successBox }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
            {result.imported} of {result.total} cards imported — "{result.batch_name}"
          </div>
          {result.errors && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--red)' }}>
              {result.errors.length} error(s): {result.errors.slice(0, 5).join('; ')}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button onClick={downloadCSV} style={{ ...S.btn, ...S.btnPrim }}>
            {String.fromCodePoint(0x2B07)} Download new codes CSV
          </button>
          <button onClick={() => { setResult(null); setRows([{ balance: '', recipient_name: '', recipient_email: '', note: '', original_code: '' }]); setBatchName(''); }} style={{ ...S.btn, ...S.btnGhost }}>
            Import more
          </button>
        </div>

        <div style={{ marginTop: 6, padding: 10, background: 'rgba(0,0,0,0.1)', borderRadius: 6, fontSize: 12, lineHeight: 1.5, color: 'var(--t1)' }}>
          {String.fromCodePoint(0x26A0)} Each imported card gets a NEW code. Download the CSV to see them. Old codes from the previous system will not work.
        </div>

        <div style={{ maxHeight: 300, overflowY: 'auto', marginTop: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--bdr)' }}>
                {['New Code', 'Last 4', 'Balance'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.cards.map((c) => (
                <tr key={c.card_id} style={{ borderBottom: '1px solid var(--bdr)' }}>
                  <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--t1)', letterSpacing: '0.08em' }}>{c.code}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', color: 'var(--t3)' }}>{c.code_last4}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 700, color: 'var(--t1)' }}>{fmtMoney(c.balance, result.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div style={S.card}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Import gift cards</div>
      <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 14 }}>
        Import cards from another system. Each card gets a new code — the old code is stored in the notes for reference.
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={S.label}>Batch name</label>
        <input type="text" value={batchName} onChange={e => setBatchName(e.target.value)} placeholder="e.g. Migration from Square, Dec 2026" style={{ ...S.input, maxWidth: 400 }}/>
      </div>

      {/* Mode tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button onClick={() => setMode('manual')} style={{ ...S.btn, ...(mode === 'manual' ? S.btnPrim : S.btnGhost), fontSize: 12 }}>Manual entry</button>
        <button onClick={() => setMode('csv')} style={{ ...S.btn, ...(mode === 'csv' ? S.btnPrim : S.btnGhost), fontSize: 12 }}>Paste CSV</button>
      </div>

      {mode === 'csv' && (
        <div style={{ marginBottom: 14 }}>
          <label style={S.label}>Paste CSV (balance, name, email, note, old code)</label>
          <textarea
            value={csvText}
            onChange={e => setCsvText(e.target.value)}
            placeholder={"25.00, Jane Smith, jane@email.com, VIP customer, OLD-CODE-123\n50.00, Bob Jones, , , OLD-456"}
            rows={6}
            style={{ ...S.input, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11 }}
          />
          <button onClick={parseCSV} style={{ ...S.btn, ...S.btnPrim, marginTop: 8 }}>Parse CSV</button>
        </div>
      )}

      {mode === 'manual' && (
        <>
          <div style={{ maxHeight: 350, overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: 8, marginBottom: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--bdr)', position: 'sticky', top: 0, background: 'var(--bg1)', zIndex: 1 }}>
                  {['Balance', 'Name', 'Email', 'Note', 'Old code', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '4px 6px' }}>
                      <input type="number" value={r.balance} onChange={e => updateRow(i, 'balance', e.target.value)} placeholder="25.00" step="0.01" style={{ ...S.input, width: 80, padding: '4px 6px', fontSize: 12 }}/>
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <input type="text" value={r.recipient_name} onChange={e => updateRow(i, 'recipient_name', e.target.value)} placeholder="Optional" style={{ ...S.input, width: 110, padding: '4px 6px', fontSize: 12 }}/>
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <input type="text" value={r.recipient_email} onChange={e => updateRow(i, 'recipient_email', e.target.value)} placeholder="Optional" style={{ ...S.input, width: 140, padding: '4px 6px', fontSize: 12 }}/>
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <input type="text" value={r.note} onChange={e => updateRow(i, 'note', e.target.value)} placeholder="Optional" style={{ ...S.input, width: 110, padding: '4px 6px', fontSize: 12 }}/>
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      <input type="text" value={r.original_code} onChange={e => updateRow(i, 'original_code', e.target.value)} placeholder="Old system code" style={{ ...S.input, width: 120, padding: '4px 6px', fontSize: 12 }}/>
                    </td>
                    <td style={{ padding: '4px 6px' }}>
                      {rows.length > 1 && (
                        <button onClick={() => removeRow(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: 16, padding: 2 }}>{String.fromCodePoint(0x2715)}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={addRow} style={{ ...S.btn, ...S.btnGhost, fontSize: 12, marginBottom: 12 }}>+ Add row</button>
        </>
      )}

      {error && <div style={S.errorBox}>{error}</div>}

      <div>
        <button onClick={handleImport} disabled={importing || !batchName.trim() || rows.filter(r => r.balance).length === 0} style={{ ...S.btn, ...S.btnPrim }}>
          {importing ? 'Importing...' : `Import ${rows.filter(r => r.balance).length} card(s)`}
        </button>
      </div>
    </div>
  );
}

// ─── Lookup Panel ───────────────────────────────────────────────────────
function LookupPanel() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [card, setCard] = useState(null);
  const [multiCards, setMultiCards] = useState(null);
  const [voidConfirm, setVoidConfirm] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendOk, setResendOk] = useState(false);

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) { setError('Enter a code, email, or name'); return; }
    setError(null); setCard(null); setMultiCards(null); setLoading(true); setVoidConfirm(false); setResendOk(false);
    try {
      const cleaned = q.replace(/[\s-]/g, '').toUpperCase();
      let body;
      if (/^[A-Z2-9]{16}$/.test(cleaned)) {
        body = { code: cleaned };
      } else {
        body = { search: q };
      }
      const res = await callGift('gift-lookup', body);
      if (res.multiple) {
        setMultiCards(res.cards);
      } else {
        setCard(res);
      }
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const selectCard = async (c) => {
    setError(null); setMultiCards(null); setLoading(true);
    try {
      const body = c.recipient_email
        ? { code_last4: c.code_last4, email: c.recipient_email }
        : { search: c.code_last4 };
      const res = await callGift('gift-lookup', body);
      if (res.multiple) {
        setCard(res.cards?.[0] || null);
      } else {
        setCard(res);
      }
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
      await callGift('gift-void', { card_id: card.card_id, reason: voidReason.trim() });
      setCard({ ...card, status: 'voided', balance: 0 });
      setVoidConfirm(false); setVoidReason('');
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setVoiding(false);
    }
  };

  const handleResend = async () => {
    if (!card?.recipient_email || !card?.card_id) return;
    setResending(true); setError(null); setResendOk(false);
    try {
      await callGift('gift-resend', { card_id: card.card_id });
      setResendOk(true);
      setTimeout(() => setResendOk(false), 5000);
    } catch (e) {
      setError(`Resend failed: ${e?.message ?? e}`);
    } finally {
      setResending(false);
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
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Look up a gift card</div>
      <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 14 }}>
        Search by full code, last 4 digits, recipient email, or recipient name.
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Code, last 4, email, or name..."
          style={{ ...S.input, flex: 1, fontSize: 14 }}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          autoFocus
        />
        <button onClick={handleSearch} disabled={loading} style={{ ...S.btn, ...S.btnPrim, whiteSpace: 'nowrap' }}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {error && <div style={{ ...S.errorBox, marginTop: 14 }}>{error}</div>}

      {/* Multiple matches */}
      {multiCards && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)', marginBottom: 8 }}>{multiCards.length} cards found — select one:</div>
          {multiCards.map(c => (
            <button key={c.card_id} onClick={() => selectCard(c)} style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '10px 12px', background: 'var(--bg2)', border: '1px solid var(--bdr)',
              borderRadius: 8, marginBottom: 6, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
            }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--t1)' }}>...{c.code_last4}</span>
              <span style={{ ...S.pill, ...statusColor(c.status), fontSize: 10 }}>{c.status}</span>
              <span style={{ fontWeight: 700, color: 'var(--t1)' }}>{fmtMoney(c.balance, c.currency)}</span>
              <span style={{ color: 'var(--t3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                {c.recipient_name || c.recipient_email || ''}
              </span>
              <span style={{ fontSize: 11, color: 'var(--t4)' }}>{c.issued_at ? new Date(c.issued_at).toLocaleDateString() : ''}</span>
            </button>
          ))}
        </div>
      )}

      {/* Single card result */}
      {card && (
        <div style={{ marginTop: 18, padding: 16, background: 'var(--bg2)', borderRadius: 10, border: '1px solid var(--bdr)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--t1)' }}>{fmtMoney(card.balance, card.currency)}</span>
            <span style={{ ...S.pill, ...statusColor(card.status) }}>{card.status}</span>
            <span style={{ fontSize: 12, color: 'var(--t4)', fontFamily: 'var(--font-mono)', marginLeft: 'auto' }}>...{card.code_last4}</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, fontSize: 12, color: 'var(--t2)', marginBottom: 14 }}>
            <div><strong style={{ color: 'var(--t3)' }}>Initial value:</strong><br/>{fmtMoney(card.initial_amount, card.currency)}</div>
            <div><strong style={{ color: 'var(--t3)' }}>Issued:</strong><br/>{card.issued_at ? new Date(card.issued_at).toLocaleDateString() : 'N/A'}</div>
            <div><strong style={{ color: 'var(--t3)' }}>Expires:</strong><br/>{card.expires_at ? new Date(card.expires_at).toLocaleDateString() : 'Never'}</div>
            {card.recipient_name && <div><strong style={{ color: 'var(--t3)' }}>Recipient:</strong><br/>{card.recipient_name}</div>}
            {card.recipient_email && <div><strong style={{ color: 'var(--t3)' }}>Email:</strong><br/>{card.recipient_email}</div>}
            {card.note && <div><strong style={{ color: 'var(--t3)' }}>Note:</strong><br/>{card.note}</div>}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {card.recipient_email && (
              <button onClick={handleResend} disabled={resending} style={{ ...S.btn, ...S.btnGhost, fontSize: 12 }}>
                {resending ? 'Sending...' : resendOk ? String.fromCodePoint(0x2713) + ' Sent!' : String.fromCodePoint(0x2709) + ' Resend email to recipient'}
              </button>
            )}
          </div>

          {/* Transaction history */}
          {card.recent_transactions?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Transaction history</div>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {card.recent_transactions.map(tx => (
                  <div key={tx.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderBottom: '1px solid var(--bdr)', fontSize: 12 }}>
                    <span style={{
                      ...S.pill, fontSize: 10, padding: '1px 6px',
                      background: tx.type === 'issue' || tx.type === 'refund' ? 'var(--grn-d)' : 'var(--red-d)',
                      color: tx.type === 'issue' || tx.type === 'refund' ? 'var(--grn)' : 'var(--red)',
                    }}>{tx.type}</span>
                    <span style={{ fontWeight: 700, color: tx.amount_minor >= 0 ? 'var(--grn)' : 'var(--red)', fontFamily: 'var(--font-mono)', minWidth: 70 }}>
                      {tx.amount_minor >= 0 ? '+' : ''}{fmtMoney(Math.abs(tx.amount_minor), card.currency)}
                    </span>
                    <span style={{ color: 'var(--t3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>bal {fmtMoney(tx.balance_after_minor, card.currency)}</span>
                    {tx.channel && <span style={{ color: 'var(--t4)' }}>{tx.channel}</span>}
                    <span style={{ color: 'var(--t4)', marginLeft: 'auto', fontSize: 11 }}>{new Date(tx.created_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Void button */}
          {card.status === 'active' && (
            <div style={{ marginTop: 14 }}>
              {!voidConfirm ? (
                <button onClick={() => setVoidConfirm(true)} style={{ ...S.btn, ...S.btnDan, fontSize: 12 }}>Void this card</button>
              ) : (
                <div style={{ padding: 12, background: 'var(--red-d)', borderRadius: 8, border: '1px solid var(--red-b)' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--red)', marginBottom: 8 }}>
                    Are you sure? This will zero the balance and permanently deactivate the card.
                  </div>
                  <label style={S.label}>Reason for voiding</label>
                  <input type="text" value={voidReason} onChange={e => setVoidReason(e.target.value)}
                    placeholder="e.g. Fraud, customer request, duplicate issue" style={S.input} autoFocus/>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button onClick={handleVoid} disabled={voiding || !voidReason.trim()} style={{ ...S.btn, background: 'var(--red)', color: '#fff' }}>
                      {voiding ? 'Voiding...' : 'Confirm void'}
                    </button>
                    <button onClick={() => { setVoidConfirm(false); setVoidReason(''); }} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
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
          No gift cards issued yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--bdr)' }}>
                {['Code', 'Status', 'Initial', 'Balance', 'Recipient', 'Source', 'Issued', 'Expires'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cards.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--bdr)' }}>
                  <td style={{ padding: '8px', fontFamily: 'var(--font-mono)', color: 'var(--t1)', fontWeight: 600 }}>...{c.code_last4}</td>
                  <td style={{ padding: '8px' }}><span style={{ ...S.pill, ...statusColor(c.status), fontSize: 10, padding: '1px 6px' }}>{c.status}</span></td>
                  <td style={{ padding: '8px', color: 'var(--t2)' }}>{fmtMoney(c.initial_amount_minor)}</td>
                  <td style={{ padding: '8px', fontWeight: 700, color: c.balance_minor > 0 ? 'var(--t1)' : 'var(--t4)' }}>{fmtMoney(c.balance_minor)}</td>
                  <td style={{ padding: '8px', color: 'var(--t2)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.recipient_name || c.recipient_email || String.fromCodePoint(0x2014)}
                  </td>
                  <td style={{ padding: '8px', color: 'var(--t3)', fontSize: 11 }}>{c.source || 'manual'}</td>
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

// ─── Code Cell (shows full code with copy) ─────────────────────────────
function CodeCell({ code }) {
  const [copied, setCopied] = useState(false);
  const formatted = code.replace(/\s/g, '').toUpperCase().match(/.{1,4}/g)?.join(' ') || code;
  const copy = () => {
    navigator.clipboard?.writeText(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <span onClick={copy} title="Click to copy code"
      style={{ cursor: 'pointer', fontSize: 11, letterSpacing: '0.06em', fontWeight: 600, color: copied ? 'var(--grn)' : 'var(--t1)' }}>
      {copied ? String.fromCodePoint(0x2713) + ' Copied' : formatted}
    </span>
  );
}

// ─── Online Purchases Panel ─────────────────────────────────────────────
function PurchasesPanel({ companyId }) {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!companyId || !platformSupabase) { setLoading(false); return; }
    (async () => {
      try {
        const { data, error: qErr } = await platformSupabase
          .from('gift_card_purchases')
          .select('id, amount_minor, currency, sender_name, sender_email, recipient_name, recipient_email, delivery_type, status, code_last4, fulfilled_code, created_at, fulfilled_at')
          .eq('company_id', companyId)
          .order('created_at', { ascending: false })
          .limit(50);
        if (qErr) throw qErr;
        setPurchases(data || []);
      } catch (e) {
        setError(String(e?.message ?? e));
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  const statusColor = (s) => {
    if (s === 'fulfilled') return { background: 'var(--grn-d)', color: 'var(--grn)', borderColor: 'var(--grn)' };
    if (s === 'paid') return { background: 'var(--acc-d)', color: 'var(--acc)', borderColor: 'var(--acc)' };
    if (s === 'pending') return { background: 'var(--bg3)', color: 'var(--t3)', borderColor: 'var(--bdr)' };
    return {};
  };

  return (
    <div style={S.card}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Online purchases</div>
      <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 14 }}>Gift cards bought by customers via Stripe Checkout.</div>
      {error && <div style={S.errorBox}>{error}</div>}
      {loading ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>Loading...</div>
      ) : purchases.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)', fontSize: 13, background: 'var(--bg2)', borderRadius: 8, border: '1px dashed var(--bdr)' }}>
          No online purchases yet. Share the purchase link with customers to get started.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--bdr)' }}>
                {['Amount', 'Status', 'Code', 'From', 'To', 'Type', 'Date'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {purchases.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--bdr)' }}>
                  <td style={{ padding: '8px', fontWeight: 700, color: 'var(--t1)' }}>{fmtMoney(p.amount_minor, p.currency)}</td>
                  <td style={{ padding: '8px' }}><span style={{ ...S.pill, ...statusColor(p.status), fontSize: 10, padding: '1px 6px' }}>{p.status}</span></td>
                  <td style={{ padding: '8px', fontFamily: 'var(--font-mono)', color: 'var(--t2)' }}>
                    {p.fulfilled_code ? <CodeCell code={p.fulfilled_code} /> : p.code_last4 ? `...${p.code_last4}` : String.fromCodePoint(0x2014)}
                  </td>
                  <td style={{ padding: '8px', color: 'var(--t2)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.sender_name || p.sender_email}</td>
                  <td style={{ padding: '8px', color: 'var(--t2)', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.recipient_name || p.recipient_email}</td>
                  <td style={{ padding: '8px', color: 'var(--t3)' }}>{p.delivery_type === 'self' ? 'Self' : 'Email'}</td>
                  <td style={{ padding: '8px', color: 'var(--t3)', fontSize: 11 }}>{new Date(p.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Branding Panel ─────────────────────────────────────────────────────
// Per-feature branding editor, same pattern as Online Ordering.
function BrandingPanel({ locationRow, opsLocId, brandConfig, onConfigUpdate }) {
  const [branding, setBranding] = useState({ ...BLANK_BRANDING });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState({});
  const logoRef = useRef(null);
  const heroRef = useRef(null);

  // Load branding from gift_brand_config.branding, fall back to location.online_branding
  useEffect(() => {
    const giftBranding = brandConfig?.branding;
    const onlineBranding = locationRow?.online_branding;
    const source = giftBranding || onlineBranding || {};
    setBranding({ ...BLANK_BRANDING, ...source });
  }, [brandConfig, locationRow]);

  const handleUpload = async (file, kind) => {
    if (!opsLocId) return;
    setUploading(u => ({ ...u, [kind]: true }));
    try {
      const url = await uploadGiftAsset(file, opsLocId, kind);
      setBranding(b => ({ ...b, [kind === 'logo' ? 'logo_url' : 'hero_url']: url }));
    } catch (e) {
      setError(`Upload failed: ${e.message}`);
    } finally {
      setUploading(u => ({ ...u, [kind]: false }));
    }
  };

  const handleSave = async () => {
    if (!platformSupabase || !locationRow?.company_id) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const cleanBranding = {
        logo_url:     branding.logo_url?.trim() || null,
        hero_url:     branding.hero_url?.trim() || null,
        accent_color: branding.accent_color || BLANK_BRANDING.accent_color,
        background:   branding.background || BLANK_BRANDING.background,
        foreground:   branding.foreground || BLANK_BRANDING.foreground,
      };
      const { error: upErr } = await platformSupabase
        .from('gift_brand_config')
        .update({ branding: cleanBranding })
        .eq('company_id', locationRow.company_id);
      if (upErr) throw upErr;
      onConfigUpdate(c => ({ ...c, branding: cleanBranding }));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={S.card}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Gift card page branding</div>
      <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 16 }}>
        Customise the look of your customer-facing gift card pages. If not set, falls back to your Online Ordering branding.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Left: upload + colors */}
        <div>
          {/* Logo */}
          <div style={{ marginBottom: 16 }}>
            <div style={S.label}>Logo</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 10, background: 'var(--bg2)', borderRadius: 8, border: '1px dashed var(--bdr)' }}>
              {branding.logo_url ? (
                <img src={branding.logo_url} alt="Logo" style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}/>
              ) : (
                <div style={{ width: 56, height: 56, borderRadius: 8, background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t4)', fontSize: 11, flexShrink: 0 }}>No logo</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <input ref={logoRef} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f, 'logo'); if (logoRef.current) logoRef.current.value = ''; }}/>
                <button onClick={() => logoRef.current?.click()} disabled={uploading.logo}
                  style={{ ...S.btn, ...S.btnGhost, fontSize: 11, padding: '5px 10px' }}>
                  {uploading.logo ? 'Uploading...' : branding.logo_url ? 'Replace logo' : 'Upload logo'}
                </button>
                {branding.logo_url && (
                  <button onClick={() => setBranding(b => ({ ...b, logo_url: '' }))}
                    style={{ background: 'transparent', border: 'none', color: 'var(--t4)', cursor: 'pointer', fontSize: 11, padding: 0, textAlign: 'left', fontFamily: 'inherit' }}>Remove</button>
                )}
              </div>
            </div>
          </div>

          {/* Colors */}
          <ColorField label="Accent colour" value={branding.accent_color} onChange={v => setBranding(b => ({ ...b, accent_color: v }))} />
          <ColorField label="Background" value={branding.background} onChange={v => setBranding(b => ({ ...b, background: v }))} />
          <ColorField label="Foreground" value={branding.foreground} onChange={v => setBranding(b => ({ ...b, foreground: v }))} />
        </div>

        {/* Right: preview */}
        <div>
          <div style={S.label}>Preview</div>
          <div style={{
            borderRadius: 12, overflow: 'hidden', border: '1px solid var(--bdr)',
            background: branding.background, color: branding.foreground,
            padding: 20, textAlign: 'center', minHeight: 200,
          }}>
            {branding.logo_url
              ? <img src={branding.logo_url} alt="logo" style={{ width: 50, height: 50, borderRadius: 10, objectFit: 'cover', marginBottom: 10 }}/>
              : <div style={{ width: 50, height: 50, borderRadius: 10, background: branding.accent_color, color: '#0b0c10', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 800, margin: '0 auto 10px' }}>{String.fromCodePoint(0x1F381)}</div>
            }
            <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 4 }}>Gift Card</div>
            <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 12 }}>Your venue name</div>
            <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 12 }}>{String.fromCodePoint(0x00A3)}25.00</div>
            <div style={{
              display: 'inline-block', padding: '10px 24px', borderRadius: 99,
              background: branding.accent_color, color: '#0b0c10',
              fontWeight: 800, fontSize: 13,
            }}>
              Purchase
            </div>
          </div>
        </div>
      </div>

      {error && <div style={{ ...S.errorBox, marginTop: 14 }}>{error}</div>}
      {saved && <div style={{ ...S.successBox, marginTop: 14 }}>Branding saved!</div>}

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button onClick={handleSave} disabled={saving} style={{ ...S.btn, ...S.btnPrim }}>
          {saving ? 'Saving...' : 'Save branding'}
        </button>
        <button onClick={() => setBranding({ ...BLANK_BRANDING })} style={{ ...S.btn, ...S.btnGhost }}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

// ─── Settings Panel ─────────────────────────────────────────────────────
// Edit gift_brand_config: min/max values, expiry, currency
function SettingsPanel({ brandConfig, companyId, onConfigUpdate }) {
  const [minValue, setMinValue] = useState('');
  const [maxValue, setMaxValue] = useState('');
  const [expiryMode, setExpiryMode] = useState('never'); // never | months | date
  const [expiryMonths, setExpiryMonths] = useState('');
  const [currency, setCurrency] = useState('gbp');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!brandConfig) return;
    setMinValue(((brandConfig.min_card_value_minor || 500) / 100).toFixed(2));
    setMaxValue(((brandConfig.max_card_value_minor || 50000) / 100).toFixed(2));
    setCurrency(brandConfig.currency || 'gbp');
    if (brandConfig.default_expiry_months) {
      setExpiryMode('months');
      setExpiryMonths(String(brandConfig.default_expiry_months));
    } else {
      setExpiryMode('never');
    }
  }, [brandConfig]);

  const handleSave = async () => {
    if (!platformSupabase || !companyId) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const minMinor = Math.round(parseFloat(minValue) * 100);
      const maxMinor = Math.round(parseFloat(maxValue) * 100);
      if (!Number.isFinite(minMinor) || minMinor <= 0) throw new Error('Min value must be positive');
      if (!Number.isFinite(maxMinor) || maxMinor <= 0) throw new Error('Max value must be positive');
      if (minMinor > maxMinor) throw new Error('Min value cannot exceed max value');

      let defaultExpiryMonths = null;
      if (expiryMode === 'months') {
        const m = parseInt(expiryMonths, 10);
        if (!Number.isFinite(m) || m < 1 || m > 120) throw new Error('Expiry months must be 1-120');
        defaultExpiryMonths = m;
      }

      const { error: upErr } = await platformSupabase
        .from('gift_brand_config')
        .update({
          min_card_value_minor: minMinor,
          max_card_value_minor: maxMinor,
          default_expiry_months: defaultExpiryMonths,
          currency: currency.toLowerCase(),
        })
        .eq('company_id', companyId);
      if (upErr) throw upErr;
      onConfigUpdate(c => ({
        ...c,
        min_card_value_minor: minMinor,
        max_card_value_minor: maxMinor,
        default_expiry_months: defaultExpiryMonths,
        currency: currency.toLowerCase(),
      }));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!brandConfig) {
    return (
      <div style={S.card}>
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--t3)', fontSize: 13, background: 'var(--bg2)', borderRadius: 8, border: '1px dashed var(--bdr)' }}>
          Enable gift cards first using the toggle above.
        </div>
      </div>
    );
  }

  return (
    <div style={S.card}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Gift card settings</div>
      <div style={{ fontSize: 12, color: 'var(--t4)', marginBottom: 16 }}>
        Configure card values, expiry rules, and currency for online purchases and manual issuance.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 20 }}>
        <div>
          <label style={S.label}>Minimum card value</label>
          <input type="number" value={minValue} onChange={e => setMinValue(e.target.value)} placeholder="5.00" step="0.01" min="0" style={S.input}/>
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>Lowest amount a customer can purchase</div>
        </div>
        <div>
          <label style={S.label}>Maximum card value</label>
          <input type="number" value={maxValue} onChange={e => setMaxValue(e.target.value)} placeholder="500.00" step="0.01" min="0" style={S.input}/>
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>Highest amount a customer can purchase</div>
        </div>
        <div>
          <label style={S.label}>Currency</label>
          <select value={currency} onChange={e => setCurrency(e.target.value)} style={S.input}>
            <option value="gbp">GBP ({String.fromCodePoint(0x00A3)})</option>
            <option value="usd">USD ($)</option>
            <option value="eur">EUR ({String.fromCodePoint(0x20AC)})</option>
          </select>
        </div>
      </div>

      {/* Expiry settings */}
      <div style={{ marginBottom: 20 }}>
        <label style={S.label}>Card expiry</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {[
            { id: 'never', label: 'Never expires' },
            { id: 'months', label: 'Expires after X months' },
          ].map(opt => (
            <button key={opt.id} onClick={() => setExpiryMode(opt.id)}
              style={{
                ...S.btn, fontSize: 12,
                ...(expiryMode === opt.id ? S.btnPrim : S.btnGhost),
              }}>
              {opt.label}
            </button>
          ))}
        </div>
        {expiryMode === 'months' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" value={expiryMonths} onChange={e => setExpiryMonths(e.target.value)}
              placeholder="12" min="1" max="120" style={{ ...S.input, width: 80 }}/>
            <span style={{ fontSize: 13, color: 'var(--t2)' }}>months from date of issue</span>
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>
          Applies to newly issued and purchased cards. Existing cards keep their current expiry.
        </div>
      </div>

      {error && <div style={S.errorBox}>{error}</div>}
      {saved && <div style={S.successBox}>Settings saved!</div>}

      <button onClick={handleSave} disabled={saving} style={{ ...S.btn, ...S.btnPrim }}>
        {saving ? 'Saving...' : 'Save settings'}
      </button>
    </div>
  );
}

// ─── Color Field ────────────────────────────────────────────────────────
function ColorField({ label, value, onChange }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={S.label}>{label}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="color" value={value || '#000000'} onChange={e => onChange(e.target.value)}
          style={{ width: 42, height: 32, padding: 0, borderRadius: 6, border: '1px solid var(--bdr)', background: 'transparent', cursor: 'pointer' }}/>
        <input type="text" value={value || ''} onChange={e => onChange(e.target.value)}
          style={{ ...S.input, flex: 1, fontFamily: 'var(--font-mono, monospace)' }}/>
      </div>
    </div>
  );
}
