// src/backoffice/sections/CounterCollectCard.jsx
//
// v5.11.95 COUNTER COLLECT (lib/counterOrder.js). Back Office, Channels, Online ordering.
// The venue's extra order option, collected at the counter: a tile on the kiosk and the counter
// QR link (<slug>.serv-os.app/counter), each switched on here, with the venue's own name for it.
// The ready text says "ready to collect at the counter". Online ordering is not changed.
//
// Saved on its own button through location-admin patch_branding (online_branding.collection,
// whitelisted there), so it never rides on the page's main Save. The page mounts it keyed on the
// venue, so another venue starts from that venue's saved setting.

import { useEffect, useState } from 'react';
import { patchBranding } from '../../lib/locationAdmin';
import { CUSTOMER_ROOT, customerUrl } from '../../lib/env';
import { renderTableQrJpeg, qrFileName, saveHref } from '../../lib/tableQr';
import {
  COUNTER_PATH, COUNTER_DEFAULT_LABEL, COUNTER_LABEL_MAX, counterCollect, counterCollectPatch,
} from '../../lib/counterOrder';

export default function CounterCollectCard({ row, opsLocId, onSaved, S }) {
  const saved = counterCollect(row);
  const savedLabel = row?.online_branding?.collection?.label || '';
  const [kiosk, setKiosk] = useState(saved.kiosk);
  const [qr, setQr] = useState(saved.qr);
  const [label, setLabel] = useState(savedLabel);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ ok: true, text: '' });
  // The drawn QR, kept with the link it was drawn for, so a stale one is never offered.
  const [drawn, setDrawn] = useState({ key: '', img: null });

  const slug = row?.online_slug || '';
  const url = slug ? customerUrl(slug, COUNTER_PATH) : '';
  const name = label.replace(/\s+/g, ' ').trim() || COUNTER_DEFAULT_LABEL;

  // The QR is drawn as the box opens, so a click only saves a finished file (Safari drops a
  // download started after an await, lib/tableQr.js).
  const qrKey = url ? `${url}|${name}` : '';
  useEffect(() => {
    let cancelled = false;
    if (!qrKey) return undefined;
    renderTableQrJpeg({ url, label: name, footer: `${slug}.${CUSTOMER_ROOT}` })
      .then((d) => { if (!cancelled) setDrawn({ key: qrKey, img: d }); })
      .catch(() => { if (!cancelled) setDrawn({ key: qrKey, img: null }); });
    return () => { cancelled = true; };
  }, [qrKey, url, name, slug]);
  const qrImg = drawn.key === qrKey ? drawn.img : null;

  const save = async () => {
    if (!opsLocId) { setMsg({ ok: false, text: 'No location found. Set up Location settings first.' }); return; }
    setBusy(true); setMsg({ ok: true, text: '' });
    const { data, error } = await patchBranding(opsLocId, counterCollectPatch({ kiosk, qr, label }));
    setBusy(false);
    if (error || !data) {
      const why = error?.message || String(error || '');
      setMsg({ ok: false, text: /unknown_field/.test(why)
        ? 'Could not save: the server is not updated yet. Ask support to deploy location-admin.'
        : 'Could not save. Try again.' });
      return;
    }
    setMsg({ ok: true, text: 'Saved. Restart the kiosk to see the new tile.' });
    onSaved?.(data);
  };

  return (
    <div style={S.card}>
      <div style={S.h2}>🛎 Counter collect</div>
      <div style={S.desc}>
        An extra way to order that the customer collects at the counter. When the order is ready the
        customer gets a text: "your order is ready to collect at the counter". Online ordering is not
        changed.
      </div>

      <label style={S.label} htmlFor="counter-collect-name">Name customers see</label>
      <input id="counter-collect-name" style={{ ...S.input, maxWidth: 360 }} value={label}
        maxLength={COUNTER_LABEL_MAX} placeholder={COUNTER_DEFAULT_LABEL}
        onChange={(e) => setLabel(e.target.value)} />
      <div style={{ ...S.desc, marginTop: 6 }}>For example "Collect at counter". Blank shows "{COUNTER_DEFAULT_LABEL}".</div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t1)', cursor: 'pointer', marginBottom: 8 }}>
        <input type="checkbox" checked={kiosk} onChange={(e) => setKiosk(e.target.checked)} />
        Show on the kiosk, next to Eat in and Take away
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t1)', cursor: 'pointer', marginBottom: 4 }}>
        <input type="checkbox" checked={qr} onChange={(e) => setQr(e.target.checked)} />
        Turn on the counter QR code
      </label>
      <div style={{ ...S.desc, marginLeft: 24 }}>
        Customers scan it, order, pay and collect at the counter. No table needed. Needs QR ordering on.
        It uses the QR tipping rule above and only takes orders while you are open.
      </div>

      {qr && url && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', padding: 12, background: 'var(--bg2)', border: '1px solid var(--bdr2)', borderRadius: 10, marginBottom: 14 }}>
          {qrImg ? <img src={qrImg} alt={`QR code for ${name}`} style={{ width: 96, height: 120, objectFit: 'contain', borderRadius: 6, background: '#fff' }} /> : null}
          <div style={{ minWidth: 0, flex: '1 1 220px' }}>
            <div style={{ fontSize: 12, color: 'var(--t3)', wordBreak: 'break-all', marginBottom: 8 }}>{url}</div>
            <button type="button" disabled={!qrImg} onClick={() => qrImg && saveHref(qrImg, qrFileName(name))}
              style={{ ...S.btn, background: 'var(--bg3)', color: 'var(--t1)', fontSize: 12, padding: '8px 14px', opacity: qrImg ? 1 : 0.4 }}>
              {qrImg ? '⬇ Download counter QR' : 'Preparing…'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6 }}>Save first, then print it for the counter, the wall or the tables.</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" onClick={save} disabled={busy}
          style={{ ...S.btn, background: 'var(--acc)', color: '#0b0c10', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save Counter collect'}
        </button>
        {msg.text && <span role="status" style={{ fontSize: 12, color: msg.ok ? 'var(--grn)' : 'var(--red)' }}>{msg.text}</span>}
      </div>
    </div>
  );
}
