// src/backoffice/sections/website/Overview.jsx
//
// Contract 9.1: status card, pages list, "Connected to your ServOS" switches, site health
// checklist, the four buttons, and the first visit "Build me a website" card.

import { useState } from 'react';
import { W } from './ui.js';
import Toggle from './Toggle.jsx';
import { CHANNELS, channelOn, draftChanges, formatWhen, healthChecklist, orderPages, pagePath, siteUrl, PAGE_KINDS } from './helpers.js';

const kindLabel = (k) => PAGE_KINDS.find(([id]) => id === k)?.[1] || 'Page';

function StatusCard({ site, pages, posts, onViewLive, onPreview }) {
  const st = site?.domain_status || {};
  const live = site?.status === 'live';
  const drafts = draftChanges(site, pages, posts);
  return (
    <div style={W.card}>
      <div style={W.cardHead}>
        <h2 style={W.h2}>Your site</h2>
        <span style={W.pill(live ? 'good' : site?.status === 'offline' ? 'bad' : 'warn')}>{live ? 'Live' : site?.status === 'offline' ? 'Offline' : 'Draft'}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, fontSize: 13 }}>
        <div><div style={W.label}>Address</div><div style={{ ...W.mono, color: 'var(--t1)', wordBreak: 'break-all' }}>{siteUrl(site).replace(/^https:\/\//, '') || 'not set'}</div></div>
        <div><div style={W.label}>Domain</div><div style={{ color: 'var(--t1)' }}>{site?.custom_domain ? `${site.custom_domain} · ${st.state || 'pending'}` : 'Free address'}</div></div>
        <div><div style={W.label}>SSL</div><div style={{ color: 'var(--t1)' }}>{site?.custom_domain ? (st.ssl === 'active' ? 'Active' : st.ssl || 'none') : 'Active (free address)'}</div></div>
        <div><div style={W.label}>Published</div><div style={{ color: 'var(--t1)' }}>{formatWhen(site?.published_at)}{drafts.count ? ` · ${drafts.count} unpublished change${drafts.count === 1 ? '' : 's'}` : ''}</div></div>
      </div>
      <div style={{ ...W.row, marginTop: 14 }}>
        {live && <button style={W.ghost} onClick={onViewLive}>View live site ↗</button>}
        <button style={W.ghost} onClick={() => onPreview('/')}>Preview draft ↗</button>
      </div>
    </div>
  );
}

function PagesCard({ pages, onEditor }) {
  const list = orderPages(pages);
  return (
    <div style={W.card}>
      <div style={W.cardHead}>
        <h2 style={W.h2}>Pages</h2>
        <button style={W.ghost} onClick={() => onEditor(null)}>Edit pages</button>
      </div>
      {list.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No pages yet. Ask the designer to build the site, or add a page in the editor.</div>}
      {list.map((p) => (
        <div key={p.id} style={W.listRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: 'var(--t1)', fontSize: 13.5 }}>{p.title || 'Untitled'}</div>
            <div style={{ ...W.mono, color: 'var(--t3)', fontSize: 11.5 }}>{pagePath(p)} · {kindLabel(p.kind)}</div>
          </div>
          <span style={W.pill(p.status === 'published' ? 'good' : 'warn')}>{p.status === 'published' ? 'Published' : 'Draft'}</span>
          <button style={W.ghost} onClick={() => onEditor(p.id)}>Edit</button>
        </div>
      ))}
    </div>
  );
}

function ChannelsCard({ site, saveSite, toast }) {
  const [busy, setBusy] = useState(null);
  const settings = site?.settings || {};
  const flip = async (key, on) => {
    setBusy(key);
    const channels = { ...(settings.channels || {}), [key]: on };
    const { error } = await saveSite({ settings: { ...settings, channels } });
    setBusy(null);
    if (error) toast(error.message || 'Could not save', 'error');
  };
  return (
    <div style={W.card}>
      <h2 style={W.h2}>Connected to your ServOS</h2>
      <div style={W.hint}>Off hides that part of the site everywhere: blocks, nav links and the ordering buttons.</div>
      <div style={{ marginTop: 10 }}>
        {CHANNELS.map(([key, label]) => {
          const on = channelOn(settings, key);
          return (
            <div key={key} style={W.switchRow}>
              <span style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>{label}</span>
              <Toggle on={on} label={label} onChange={(v) => busy ? null : flip(key, v)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HealthCard({ site, pages, branding, onBranding }) {
  const items = healthChecklist({ site, pages, branding });
  const okCount = items.filter((i) => i.ok).length;
  return (
    <div style={W.card}>
      <div style={W.cardHead}>
        <h2 style={W.h2}>Site health</h2>
        <span style={W.pill(okCount === items.length ? 'good' : 'warn')}>{okCount} of {items.length}</span>
      </div>
      {items.map((i) => (
        <div key={i.id} style={W.listRow}>
          <span style={{ width: 20, textAlign: 'center', color: i.ok ? 'var(--grn)' : 'var(--acc)', fontWeight: 900 }}>{i.ok ? '✓' : '!'}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: 'var(--t1)', fontSize: 13 }}>{i.label}</div>
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>{i.words}</div>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 12 }}><button style={W.ghost} onClick={onBranding}>Branding and domain</button></div>
    </div>
  );
}

export default function Overview({ ws, toast, onBuild, onDesigner, onEditor, onBranding, onBlog, onViewLive, onPreview }) {
  const { site, pages, posts, branding } = ws;
  const empty = !site || (pages || []).length === 0;

  if (empty) {
    return (
      <div style={{ ...W.card, padding: '48px 28px', textAlign: 'center', borderStyle: 'dashed' }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🌐</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)' }}>Build me a website</div>
        <div style={{ fontSize: 13.5, color: 'var(--t3)', margin: '8px auto 20px', maxWidth: 520, lineHeight: 1.6 }}>
          The designer reads your menu, hours, locations and branding, then builds a full site: home, live menu, ordering, loyalty, gift cards, find us, one page per location and a blog. You can change anything after.
        </div>
        <div style={{ ...W.row, justifyContent: 'center' }}>
          <button style={{ ...W.btn, padding: '12px 24px', fontSize: 15 }} onClick={onBuild}>Build me a website</button>
          <button style={W.ghost} onClick={onDesigner}>Talk to the designer first</button>
        </div>
        {!!site && <div style={{ ...W.hint, marginTop: 18 }}>Or add pages yourself: <button style={{ ...W.ghost, padding: '3px 8px' }} onClick={() => onEditor(null)}>Open the editor</button></div>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ ...W.row, marginBottom: 16 }}>
        <button style={W.btn} onClick={onDesigner}>✨ Open AI designer</button>
        <button style={W.ghost} onClick={() => onEditor(null)}>Edit pages</button>
        <button style={W.ghost} onClick={onBranding}>Branding and domain</button>
        <button style={W.ghost} onClick={onBlog}>Blog{posts?.length ? ` (${posts.length})` : ''}</button>
        {site?.status === 'live' && <button style={{ ...W.ghost, marginLeft: 'auto' }} onClick={onViewLive}>View live site ↗</button>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
        <div>
          <StatusCard site={site} pages={pages} posts={posts} onViewLive={onViewLive} onPreview={onPreview} />
          <PagesCard pages={pages} onEditor={onEditor} />
        </div>
        <div>
          <ChannelsCard site={site} saveSite={ws.saveSite} toast={toast} />
          <HealthCard site={site} pages={pages} branding={branding} onBranding={onBranding} />
        </div>
      </div>
    </div>
  );
}
