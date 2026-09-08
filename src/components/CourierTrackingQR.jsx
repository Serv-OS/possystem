// src/components/CourierTrackingQR.jsx
//
// Native-safe courier tracking for the POS. The Sunmi WebView swallows external links (and tel:),
// so instead of a dead "Track ↗" anchor we render a scannable QR of the Stuart live-map URL —
// staff or the customer at the counter scan it with a phone to open the map in a real browser.
// The courier phone is shown as plain text (the WebView can't dial). The `qrcode` lib produces a
// data-URL image, which renders fine inside the WebView.

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function CourierTrackingQR({ trackingUrl, courierName, courierPhone, size = 88, muted = 'var(--t3)', fg = 'var(--t1)' }) {
  const [qr, setQr] = useState(null);
  useEffect(() => {
    if (!trackingUrl) { setQr(null); return; }
    let live = true;
    QRCode.toDataURL(trackingUrl, { width: 480, margin: 1, errorCorrectionLevel: 'M' })
      .then((u) => { if (live) setQr(u); })
      .catch(() => { if (live) setQr(null); });
    return () => { live = false; };
  }, [trackingUrl]);

  if (!trackingUrl) return null;
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10, padding: '10px 0 2px', borderTop: '1px solid var(--glass-border, var(--bdr))' }}>
      {qr
        ? <img src={qr} alt="Live tracking QR" width={size} height={size} style={{ borderRadius: 8, background: '#fff', padding: 4, flexShrink: 0 }} />
        : <div style={{ width: size, height: size, borderRadius: 8, background: 'var(--bg3)', flexShrink: 0 }} />}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: fg }}>Scan for the live map</div>
        <div style={{ fontSize: 11, color: muted, marginTop: 2, lineHeight: 1.4 }}>Point a phone camera at the code to track the courier.</div>
        {courierName && <div style={{ fontSize: 11.5, color: fg, marginTop: 6 }}>👤 {courierName}</div>}
        {courierPhone && <div style={{ fontSize: 11.5, color: muted, marginTop: 1 }}>📞 {courierPhone}</div>}
      </div>
    </div>
  );
}
