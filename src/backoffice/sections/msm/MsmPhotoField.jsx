// src/backoffice/sections/msm/MsmPhotoField.jsx
//
// MULTI SITE MENU, ROUND 2 (v5.11.75): the product photo, uploaded (Peter, 17 Oct 2026, UI issue 3:
// "we need an image uploader on the multi site too, not just a url").
//
// Reuses what Menu Manager uses, never a fork: lib/db.js uploadProductImage (the product-images
// bucket, path <site>/<id>.<ext>, replaced on a new upload, public link with a cache buster) and
// lib/categoryPhoto.js checkPhotoFile (jpg, png or webp, 5 MB at most). The file goes under the
// site this Back Office tab is on (the person's own site, which the storage rules let them write);
// the link is the group menu's photo and publish writes that same link to every site's product, so
// the till, kiosk, online, QR and boards show it. Choose or drop a photo, see it, replace it,
// remove it; "or paste a link" stays as a small option. Nothing is saved to any site here: the link
// goes into the draft with the rest of the sheet.

import { useRef, useState } from 'react';
import { uploadProductImage } from '../../../lib/db';
import { getLocationId, isMock } from '../../../lib/supabase';
import { checkPhotoFile } from '../../../lib/categoryPhoto';
import { hex12 } from '../../../../supabase/functions/_shared/msmModel.js';
import { Btn } from './msmUi';
import { ui } from './msmStyle';

export default function MsmPhotoField({ value, productId, onChange, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState('');
  const [link, setLink] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef(null);

  const upload = async (file) => {
    setWords('');
    const bad = checkPhotoFile(file);
    if (bad) { setWords(bad === 'type' ? 'Pick a JPG, PNG or WebP photo.' : 'That photo is over 5 MB. Pick a smaller one.'); return; }
    if (isMock) { setWords('Photo upload needs the live system. Paste a link instead.'); setLink(true); return; }
    setBusy(true);
    try {
      const loc = await getLocationId().catch(() => null);
      if (!loc || loc === 'loc-demo') { setWords('Could not tell which site this tab is on. Reload the Back Office and try again.'); return; }
      const { url, error } = await uploadProductImage(`msm-${hex12(productId)}`, loc, file);
      if (error || !url) { setWords('The photo did not upload. Check your connection and try again; nothing else changed.'); return; }
      onChange(url);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <span style={ui.label}>Photo</span>
      <div
        onDragOver={(e) => { if (!disabled) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer?.files?.[0]; if (f && !disabled) upload(f); }}
        style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 10, borderRadius: 12, border: `1.5px dashed ${over ? 'var(--acc)' : 'var(--bdr2)'}`, background: over ? 'var(--acc-d)' : 'var(--bg2)', flexWrap: 'wrap' }}>
        <div style={{ width: 84, height: 64, borderRadius: 9, overflow: 'hidden', background: 'var(--bg3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: '1px solid var(--bdr)' }}>
          {value
            ? <img src={value} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
            : <span style={{ ...ui.sub, fontSize: 11 }}>No photo</span>}
        </div>
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Btn small kind="soft" disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : value ? 'Replace photo' : 'Choose a photo'}</Btn>
            {value && <Btn small kind="ghost" disabled={disabled || busy} onClick={() => onChange('')}>Remove</Btn>}
            <Btn small kind="link" disabled={disabled} onClick={() => setLink((x) => !x)}>{link ? 'Hide the link' : 'or paste a link'}</Btn>
          </div>
          <div style={{ ...ui.sub, fontSize: 11.5, marginTop: 4 }}>Or drop a photo here. JPG, PNG or WebP, up to 5 MB. Every site shows it once published.</div>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
        </div>
      </div>
      {link && <input aria-label="Photo link" style={{ ...ui.input, marginTop: 8 }} value={value || ''} placeholder="https://" disabled={disabled} onChange={(e) => onChange(e.target.value)} />}
      {words && <div style={{ ...ui.err, marginTop: 6 }}>{words}</div>}
    </div>
  );
}
