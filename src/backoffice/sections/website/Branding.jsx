// src/backoffice/sections/website/Branding.jsx
//
// Contract 9.4: synced branding (read only, from online_branding of the default location),
// type / buttons / mood pickers (save_site theme), domain card (website-domain check_domain,
// records with copy, SSL, steps, mailto), Search and sharing (seo, og image, Google code,
// Instagram), Publish card (live / offline, draft changes, History with Restore).

import { useRef, useState } from 'react';
import { W } from './ui.js';
import { checkDomain, removeDomain } from './adminClient.js';
import { BUTTON_SHAPES, LAYOUTS, MOODS, TYPE_PAIRINGS, draftChanges, expectedRecords, formatWhen, freeHost, isValidDomain, normaliseDomain, recordsMailto, siteUrl } from './helpers.js';

async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text)); return true; } catch { return false; }
}

function Picker({ label, options, value, onPick, hint }) {
  return (
    <div style={W.field}>
      <label style={W.label}>{label}</label>
      <div style={{ ...W.row, gap: 6 }}>
        {options.map(([v, l, sub]) => (
          <button key={v} style={W.seg(value === v)} onClick={() => onPick(v)} title={sub || ''}>{l}</button>
        ))}
      </div>
      {hint && <div style={W.hint}>{hint}</div>}
    </div>
  );
}

function SyncedBrandingCard({ branding, location, onBrandBasics }) {
  return (
    <div style={W.card}>
      <div style={W.cardHead}>
        <h2 style={W.h2}>Branding, synced</h2>
        <button style={W.ghost} onClick={onBrandBasics}>Change in Brand basics</button>
      </div>
      <div style={W.hint}>The site uses the same colour, logo, name and header photo as your online ordering{location?.name ? ` (from ${location.name})` : ''}. Change them once, every customer screen follows.</div>
      <div style={{ ...W.row, marginTop: 12, gap: 14 }}>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: branding?.brand_color || 'var(--bg3)', border: '1px solid var(--bdr2)' }} title={branding?.brand_color || 'No brand colour yet'} />
        {branding?.logo_url ? <div style={{ height: 38, padding: 4, background: '#fff', borderRadius: 8, border: '1px solid var(--bdr2)' }}><img src={branding.logo_url} alt="logo" style={{ height: '100%', objectFit: 'contain' }} /></div> : <span style={W.chip}>No logo yet</span>}
        <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 700 }}>{branding?.display_name || location?.name || 'Your venue'}</div>
        {branding?.hero_url ? <div style={{ width: 64, height: 38, borderRadius: 8, backgroundImage: `url(${branding.hero_url})`, backgroundSize: 'cover', backgroundPosition: 'center', border: '1px solid var(--bdr2)' }} /> : <span style={W.chip}>No header photo</span>}
      </div>
    </div>
  );
}

function ThemeCard({ site, saveSite, toast }) {
  const theme = site?.theme || {};
  const set = async (patch) => {
    const { error } = await saveSite({ theme: { ...theme, ...patch } });
    if (error) toast(error.message || 'Could not save the look', 'error');
  };
  return (
    <div style={W.card}>
      <h2 style={{ ...W.h2, marginBottom: 12 }}>Look</h2>
      <Picker label="Layout" options={LAYOUTS} value={theme.layout || 'ember'} onPick={(v) => set({ layout: v })} hint={LAYOUTS.find(([v]) => v === (theme.layout || 'ember'))?.[2]} />
      <Picker label="Type pairing" options={TYPE_PAIRINGS} value={theme.type || 'warm-serif'} onPick={(v) => set({ type: v })} hint={TYPE_PAIRINGS.find(([v]) => v === (theme.type || 'warm-serif'))?.[2]} />
      <Picker label="Buttons" options={BUTTON_SHAPES} value={theme.buttons || 'pill'} onPick={(v) => set({ buttons: v })} />
      <Picker label="Mood" options={MOODS} value={theme.mood || 'light'} onPick={(v) => set({ mood: v })} hint="Dark is ink with paper text and your brand colour as the accent. Brand paints the page in your colour." />
    </div>
  );
}

function DomainCard({ site, ws, toast }) {
  const [input, setInput] = useState(site?.custom_domain || '');
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState('');
  const st = site?.domain_status || {};
  const domain = normaliseDomain(input);
  const records = (Array.isArray(st.records) && st.records.length) ? st.records : expectedRecords(domain || site?.custom_domain);

  const check = async () => {
    if (!isValidDomain(domain)) { toast('Type a full domain, like www.yourvenue.com', 'error'); return; }
    setChecking(true);
    const { data, error } = await checkDomain(domain);
    // The function answers 200 with the reason inside domain_status.error, so the table keeps
    // rendering; a transport failure is the only thing that reaches the catch all toast.
    const status = data?.domain_status;
    if (status && typeof status === 'object') ws.applySiteData({ site: data.site || { ...site, custom_domain: data.custom_domain || domain, apex_domain: data.apex_domain ?? site?.apex_domain, domain_status: status } });
    setChecking(false);
    if (error && !status) { toast(error.message || 'Domain check failed', 'error'); return; }
    if (status?.error) toast(String(status.error), 'error');
    else toast(status?.state === 'live' ? 'Your domain is live.' : 'Checked. Records still pending, see the table.', status?.state === 'live' ? 'success' : 'info');
  };

  const remove = async () => {
    if (!window.confirm(`Stop using ${site?.custom_domain}? The site stays live on the free address.`)) return;
    setChecking(true);
    const { error } = await removeDomain();
    setChecking(false);
    if (error) { toast(error.message || 'Could not remove the domain', 'error'); return; }
    setInput('');
    await ws.reload();
    toast('Domain removed');
  };

  const copy = async (value, key) => { if (await copyText(value)) { setCopied(key); setTimeout(() => setCopied(''), 1500); } else toast('Could not copy', 'error'); };
  const tone = { live: 'good', verified: 'good', pending: 'warn', error: 'bad' }[st.state] || 'neutral';

  return (
    <div style={W.card}>
      <div style={W.cardHead}>
        <h2 style={W.h2}>Domain</h2>
        {site?.custom_domain && <span style={W.pill(tone)}>{st.state || 'pending'}</span>}
      </div>
      <div style={W.field}><label style={W.label}>Free address</label>
        <div style={{ ...W.row, gap: 8 }}><span style={{ ...W.mono, color: 'var(--t1)' }}>{freeHost(site?.slug).replace(/^https:\/\//, '') || 'not set yet'}</span>
          {site?.slug && <button style={W.ghost} onClick={() => copy(freeHost(site.slug), 'free')}>{copied === 'free' ? 'Copied' : 'Copy'}</button>}
        </div>
        <div style={W.hint}>Always works, always https. Your own domain points at it.</div>
      </div>
      <div style={W.field}><label style={W.label}>Your domain</label>
        <div style={{ ...W.row, gap: 8 }}>
          <input style={{ ...W.input, flex: 1, minWidth: 200 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="www.yourvenue.com" />
          <button style={W.btn} disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check'}</button>
          {site?.custom_domain && <button style={W.ghost} disabled={checking} onClick={remove}>Remove</button>}
        </div>
        <div style={W.hint}>Buy the domain from any registrar (we never sell domains). Use the www address, the bare one redirects to it.</div>
      </div>
      {domain && records.length > 0 && (
        <>
          <table style={W.table}>
            <thead><tr><th style={W.th}>Type</th><th style={W.th}>Name</th><th style={W.th}>Value</th><th style={W.th}></th></tr></thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={`${r.type}-${r.name}-${i}`}>
                  <td style={{ ...W.td, ...W.mono }}>{r.type}</td>
                  <td style={{ ...W.td, ...W.mono }}>{r.name}</td>
                  <td style={{ ...W.td, ...W.mono, wordBreak: 'break-all' }}>{r.value}</td>
                  <td style={{ ...W.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.ok === true && <span style={{ ...W.pill('good'), marginRight: 6 }}>✓</span>}
                    {r.ok === false && <span style={{ ...W.pill('warn'), marginRight: 6 }}>waiting</span>}
                    <button style={W.ghost} onClick={() => copy(r.value, `r${i}`)}>{copied === `r${i}` ? 'Copied' : 'Copy'}</button>
                  </td>
                </tr>
              ))}
              <tr>
                <td style={{ ...W.td, fontWeight: 700 }} colSpan={3}>SSL certificate</td>
                <td style={{ ...W.td, textAlign: 'right' }}><span style={W.pill(st.ssl === 'active' ? 'good' : 'neutral')}>{st.ssl === 'active' ? 'active' : st.ssl === 'pending' ? 'pending' : 'issued once records are live'}</span></td>
              </tr>
            </tbody>
          </table>
          <ol style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.7, paddingLeft: 18, margin: '12px 0' }}>
            <li>Sign in where you bought the domain and open its DNS settings.</li>
            <li>Add each record above exactly as written. Copy buttons help.</li>
            <li>Come back and press Check. Records can take up to an hour to show.</li>
            <li>The certificate is issued on its own once the records are live.</li>
          </ol>
          <div style={W.row}>
            <a style={{ ...W.ghost, textDecoration: 'none', display: 'inline-block' }} href={recordsMailto(domain, records)}>Email these steps</a>
            {st.checked_at && <span style={W.hint}>Last checked {formatWhen(st.checked_at)}</span>}
            {st.error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{String(st.error)}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function SeoCard({ site, saveSite, uploadAsset, toast }) {
  const [seo, setSeo] = useState({ ...(site?.seo || {}) });
  const [instagram, setInstagram] = useState(site?.footer?.instagram || '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const ogRef = useRef(null);
  const set = (patch) => setSeo((s) => ({ ...s, ...patch }));
  const save = async () => {
    setSaving(true);
    const keywords = Array.isArray(seo.keywords) ? seo.keywords : String(seo.keywords_text || '').split(',').map((k) => k.trim()).filter(Boolean);
    const { keywords_text: _ignore, ...rest } = seo;
    const { error } = await saveSite({ seo: { ...rest, keywords }, footer: { ...(site?.footer || {}), instagram: instagram.replace(/^@/, '').trim() } });
    setSaving(false);
    if (error) toast(error.message || 'Could not save', 'error'); else toast('Search and sharing saved');
  };
  const pickOg = async () => {
    const file = ogRef.current?.files?.[0]; if (!file) return;
    setUploading(true);
    const { url, error } = await uploadAsset(file, 'og');
    setUploading(false);
    if (error) toast(error.message || 'Upload failed', 'error'); else set({ og_image_url: url });
  };
  const titleLen = String(seo.title || '').length; const descLen = String(seo.description || '').length;
  return (
    <div style={W.card}>
      <h2 style={{ ...W.h2, marginBottom: 12 }}>Search and sharing</h2>
      <div style={W.field}><label style={W.label}>Site title <span style={{ color: titleLen > 60 ? 'var(--red)' : 'var(--t4)', fontWeight: 500 }}>{titleLen}/60</span></label>
        <input style={W.input} value={seo.title || ''} onChange={(e) => set({ title: e.target.value })} placeholder="Mozz Pizza, Leeds. Sourdough pizza, order online" />
        <div style={W.hint}>What Google shows as the headline. Put the town in it.</div>
      </div>
      <div style={W.field}><label style={W.label}>Description <span style={{ color: descLen > 155 ? 'var(--red)' : 'var(--t4)', fontWeight: 500 }}>{descLen}/155</span></label>
        <textarea style={{ ...W.textarea, minHeight: 70 }} value={seo.description || ''} onChange={(e) => set({ description: e.target.value })} placeholder="Wood fired sourdough pizza in Leeds. Order online for collection or delivery." />
      </div>
      <div style={W.field}><label style={W.label}>Keywords <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional, comma separated</span></label>
        <input style={W.input} value={seo.keywords_text ?? (Array.isArray(seo.keywords) ? seo.keywords.join(', ') : '')} onChange={(e) => set({ keywords_text: e.target.value, keywords: undefined })} placeholder="pizza leeds, sourdough pizza, pizza delivery" />
      </div>
      <div style={W.field}><label style={W.label}>Share image</label>
        <input ref={ogRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={pickOg} />
        <div style={W.row}>
          {seo.og_image_url && <div style={{ width: 96, height: 50, borderRadius: 8, backgroundImage: `url(${seo.og_image_url})`, backgroundSize: 'cover', backgroundPosition: 'center', border: '1px solid var(--bdr2)' }} />}
          <button style={W.ghost} disabled={uploading} onClick={() => ogRef.current?.click()}>{uploading ? 'Uploading…' : seo.og_image_url ? 'Replace image' : 'Upload image'}</button>
          {seo.og_image_url && <button style={W.ghost} onClick={() => set({ og_image_url: '' })}>Remove</button>}
        </div>
        <div style={W.hint}>Shown when someone shares a link on WhatsApp, Instagram or Facebook. About 1200×630.</div>
      </div>
      <div style={W.field}><label style={W.label}>Google verification code</label>
        <input style={{ ...W.input, ...W.mono }} value={seo.google_site_verification || ''} onChange={(e) => set({ google_site_verification: e.target.value.trim() })} placeholder="From Google Search Console, HTML tag method, the content value" />
        <div style={W.hint}>Lets Search Console show how the site ranks. Paste only the code, not the whole tag.</div>
      </div>
      <div style={W.field}><label style={W.label}>Instagram handle</label>
        <input style={W.input} value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="@yourvenue" />
      </div>
      <button style={W.btn} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save search and sharing'}</button>
    </div>
  );
}

function PublishCard({ ws, toast, onPublish, onViewLive, onPreview }) {
  const { site, pages, posts, versions } = ws;
  const [busy, setBusy] = useState('');
  const drafts = draftChanges(site, pages, posts);
  const live = site?.status === 'live';
  const act = async (what, fn, okWords) => {
    setBusy(what);
    const { error } = await fn();
    setBusy('');
    if (error) toast(error.message || 'That did not work', 'error'); else if (okWords) toast(okWords);
  };
  return (
    <div style={W.card}>
      <div style={W.cardHead}>
        <h2 style={W.h2}>Publish</h2>
        <span style={W.pill(live ? 'good' : site?.status === 'offline' ? 'bad' : 'warn')}>{live ? 'Live' : site?.status === 'offline' ? 'Offline' : 'Draft'}</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.6 }}>
        {live ? <>Live at <a href={siteUrl(site)} target="_blank" rel="noreferrer" style={{ color: 'var(--acc)' }}>{siteUrl(site).replace(/^https:\/\//, '')}</a>, published {formatWhen(site?.published_at)}.</> : site?.status === 'offline' ? 'The site is offline. Visitors see a plain "no site here" page and Google is told not to index it.' : 'Not published yet. Publish makes the site live on the free address.'}
        {drafts.count > 0 && <div style={{ marginTop: 4 }}><b>{drafts.count}</b> unpublished change{drafts.count === 1 ? '' : 's'} ({drafts.pages.length} page{drafts.pages.length === 1 ? '' : 's'}, {drafts.posts.length} post{drafts.posts.length === 1 ? '' : 's'}{drafts.site ? ', site settings' : ''}).</div>}
      </div>
      <div style={{ ...W.row, marginTop: 12 }}>
        <button style={W.btn} disabled={!!busy} onClick={() => act('pub', async () => ({ error: (await onPublish('Published from Branding and domain')) ? null : new Error('Publish failed') }), null)}>{busy === 'pub' ? 'Publishing…' : live ? 'Publish changes' : 'Publish'}</button>
        <button style={W.ghost} onClick={() => onPreview('/')}>Preview draft ↗</button>
        {live && <button style={W.ghost} onClick={onViewLive}>View live ↗</button>}
        {live && <button style={W.danger} disabled={!!busy} onClick={() => act('off', ws.unpublish, 'Site taken offline')}>{busy === 'off' ? 'Working…' : 'Take offline'}</button>}
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={W.label}>History</div>
        {(!versions || versions.length === 0) && <div style={W.hint}>Every publish is kept here. One press restores an earlier version.</div>}
        {(versions || []).map((v) => (
          <div key={v.id} style={W.listRow}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>{v.note || 'Published'}</div>
              <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{formatWhen(v.created_at)}{v.id === site?.published_version_id ? ' · live now' : ''}</div>
            </div>
            {v.id !== site?.published_version_id && <button style={W.ghost} disabled={!!busy} onClick={() => act(v.id, () => ws.restore(v.id), 'Restored. That version is live now.')}>{busy === v.id ? 'Restoring…' : 'Restore'}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Branding({ ws, toast, onBrandBasics, onPublish, onViewLive, onPreview }) {
  const { site, branding, defaultLocation } = ws;
  if (!site) return <div style={W.empty}>No site yet. Go to Overview and press Build me a website.</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
      <div>
        <SyncedBrandingCard branding={branding} location={defaultLocation} onBrandBasics={onBrandBasics} />
        <ThemeCard site={site} saveSite={ws.saveSite} toast={toast} />
        <SeoCard key={site.updated_at || site.id} site={site} saveSite={ws.saveSite} uploadAsset={ws.uploadAsset} toast={toast} />
      </div>
      <div>
        <DomainCard site={site} ws={ws} toast={toast} />
        <PublishCard ws={ws} toast={toast} onPublish={onPublish} onViewLive={onViewLive} onPreview={onPreview} />
      </div>
    </div>
  );
}
