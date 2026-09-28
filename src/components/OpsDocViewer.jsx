// OpsDocViewer: an in-app viewer for one Operations document (28 Sep 2026, v5.11.4).
// Used where a file link would replace the app (the iOS shells and the Sunmi till app keep
// every *.supabase.co link inside the WebView with no back gesture; lib/ops/formRules.js
// docOpenMode). The file shows over the screen with a Close button, so the app is never
// stranded on a PDF. `url` is a short lived signed link (lib/ops/documents.js openDocument).

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { fileKind } from '../lib/ops/formRules';

export default function OpsDocViewer({ doc, url, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!url) return null;
  const kind = fileKind(doc?.fileName, doc?.mimeType);
  const previewable = kind === 'image' || kind === 'pdf' || kind === 'text';
  // A portal to <body>: a glass panel above (backdrop-filter) would otherwise trap a fixed
  // overlay inside itself.
  return createPortal((
    <div role="dialog" aria-modal="true" aria-label={doc?.title || 'Document'}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'var(--bg, #0F1211)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 'calc(10px + env(safe-area-inset-top, 0px)) 14px 10px', borderBottom: '1px solid var(--bdr)', background: 'var(--bg1)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc?.title || 'Document'}</div>
          {doc?.fileName && <div style={{ fontSize: 11, color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.fileName}</div>}
        </div>
        <button type="button" onClick={onClose} className="btn btn-acc"
          style={{ padding: '10px 18px', borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>Close</button>
      </div>
      {!previewable && (
        <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--t3)', background: 'var(--bg1)', borderBottom: '1px solid var(--bdr)' }}>
          This kind of file may not show here. If it stays blank, open it in Back Office on a computer.
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, background: kind === 'image' ? 'var(--bg, #0F1211)' : '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {kind === 'image'
          ? <img src={url} alt={doc?.title || ''} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          : <iframe src={url} title={doc?.title || 'Document'} style={{ width: '100%', height: '100%', border: 0, background: '#ffffff' }} />}
      </div>
    </div>
  ), document.body);
}
