// src/backoffice/sections/website/WebsiteBuilder.jsx
//
// The fifth Appearance tab (contract section 9). One component, five internal views:
// overview | designer | editor | branding | blog, with a small top bar (back to Appearance,
// view title, venue chip, actions). Data and writes come from useWebsite (adminClient →
// website-admin). The designer view belongs to agent D and is mounted here lazily.

import { lazy, Suspense, useCallback, useState } from 'react';
import { useStore } from '../../../store';
import { useWebsite } from './useWebsite.js';
import { W } from './ui.js';
import Overview from './Overview.jsx';
import Editor from './Editor.jsx';
import Branding from './Branding.jsx';
import Blog from './Blog.jsx';
import { buildBrief, siteUrl, freeHost } from './helpers.js';
import { previewToken } from './adminClient.js';
import PublishTermsModal from './PublishTermsModal.jsx';
import { PUBLISH_TERMS_VERSION, publishTermsAccepted } from '../../../lib/website/publishTerms.js';

// Agent D owns the designer view. A glob import resolves to nothing (no build error) when
// the file is not in the tree yet, so this tab still builds and shows a plain placeholder.
const designerModules = import.meta.glob('./designer/Designer.jsx');
const loadDesigner = designerModules['./designer/Designer.jsx'];
const Designer = loadDesigner ? lazy(loadDesigner) : null;

const VIEWS = [
  ['overview', 'Overview'],
  ['designer', 'AI designer'],
  ['editor', 'Pages'],
  ['branding', 'Branding and domain'],
  ['blog', 'Blog'],
];

function DesignerFallback() {
  return <div style={W.empty}>Loading the designer…</div>;
}

function DesignerMissing({ onBack }) {
  return (
    <div style={{ ...W.card, textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>The AI designer is not in this build yet</div>
      <div style={{ ...W.hint, marginBottom: 12 }}>You can still add and edit pages by hand.</div>
      <button style={W.ghost} onClick={onBack}>Back to overview</button>
    </div>
  );
}

export default function WebsiteBuilder({ venueName: fallbackName, onBack }) {
  const ws = useWebsite();
  const showToast = useStore((s) => s.showToast);
  const toast = useCallback((msg, type = 'success') => { try { showToast?.(msg, type, type === 'error' ? 7000 : undefined); } catch { /* a toast never breaks the screen */ } }, [showToast]);

  const [view, setView] = useState('overview');
  // Context handed between views: which page the editor shows, which page or post the
  // designer should talk about, and the designer mode (build | chat | post).
  const [ctx, setCtx] = useState({ pageId: null, postId: null, mode: 'chat', brief: '' });

  const go = useCallback((next, patch = {}) => { setCtx((c) => ({ ...c, ...patch })); setView(next); }, []);
  const openDesigner = useCallback((patch = {}) => go('designer', { mode: 'chat', ...patch }), [go]);
  const openEditor = useCallback((pageId = null) => go('editor', { pageId }), [go]);
  const buildMe = useCallback(() => go('designer', { mode: 'build', brief: buildBrief({ name: ws.venueName || fallbackName, locations: ws.locations }) }), [go, ws.venueName, ws.locations, fallbackName]);

  // Opening the window BEFORE the await keeps browsers from treating it as a popup.
  const openPreview = useCallback(async (path = '/') => {
    const slug = ws.site?.slug;
    if (!slug) { toast('Build the site first, then preview it.', 'info'); return; }
    const win = window.open('about:blank', '_blank');
    const { data, error } = await previewToken();
    const token = data?.token || data?.preview_token || (typeof data === 'string' ? data : null);
    if (error || !token) { try { win?.close(); } catch { /* already gone */ } toast(error?.message || 'Could not make a preview link', 'error'); return; }
    // api/site.js reads the page to show from ?page= (the host rewrite already uses ?path=).
    const url = `${freeHost(slug)}/preview?token=${encodeURIComponent(token)}&page=${encodeURIComponent(path)}`;
    if (win) win.location = url; else window.open(url, '_blank');
  }, [ws.site?.slug, toast]);

  // 5.12.1: the publishing terms gate. The first publish (and the first after the terms change)
  // shows the full statement; Accept and publish sends the version with the publish call and
  // the server records who accepted and when. Every caller still gets a plain true / false.
  const [terms, setTerms] = useState(null); // { note, resolve } while the statement is open
  const [termsBusy, setTermsBusy] = useState(false);
  const runPublish = useCallback(async (note, acceptTerms) => {
    const { error } = await ws.publish(note || 'Published from Back Office', acceptTerms);
    if (error) toast(error.message || 'Publish failed', 'error'); else toast('Your site is live.');
    return !error;
  }, [ws, toast]);
  const publish = useCallback((note) => new Promise((resolve) => {
    if (publishTermsAccepted(ws.site?.settings)) { runPublish(note, null).then(resolve); return; }
    setTerms({ note, resolve });
  }), [ws.site?.settings, runPublish]);
  const acceptTerms = useCallback(async () => {
    if (!terms) return;
    setTermsBusy(true);
    const ok = await runPublish(terms.note, PUBLISH_TERMS_VERSION);
    setTermsBusy(false);
    setTerms(null);
    terms.resolve(ok);
  }, [terms, runPublish]);
  const cancelTerms = useCallback(() => { if (!terms) return; terms.resolve(false); setTerms(null); }, [terms]);

  const viewLive = useCallback(() => {
    const url = siteUrl(ws.site);
    if (url) window.open(url, '_blank', 'noopener');
  }, [ws.site]);

  const title = VIEWS.find(([id]) => id === view)?.[1] || 'Website builder';
  const name = ws.venueName || fallbackName || 'Your venue';

  if (ws.loading) return <div style={W.empty}>Loading your website…</div>;

  return (
    <div>
      {/* Top bar */}
      <div style={W.topBar}>
        <button style={W.ghost} onClick={onBack}>← Appearance</button>
        <div style={{ fontWeight: 800, color: 'var(--t1)', fontSize: 15 }}>{title}</div>
        <span style={W.chip} title={ws.site?.slug ? freeHost(ws.site.slug) : 'No site yet'}>🏷 {name}{ws.site?.slug ? ` · ${ws.site.slug}` : ''}</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
          {VIEWS.map(([id, label]) => (
            <button key={id} style={W.tab(view === id)} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
      </div>

      {ws.loadError && (
        <div style={{ ...W.card, borderColor: 'var(--red-b)', background: 'var(--red-d)', color: 'var(--red)', fontSize: 13 }}>
          {ws.loadError}. <button style={{ ...W.ghost, marginLeft: 8 }} onClick={() => ws.reload()}>Try again</button>
        </div>
      )}

      {view === 'overview' && (
        <Overview
          ws={ws} toast={toast}
          onBuild={buildMe}
          onDesigner={() => openDesigner()}
          onEditor={openEditor}
          onBranding={() => setView('branding')}
          onBlog={() => setView('blog')}
          onViewLive={viewLive}
          onPreview={openPreview}
        />
      )}

      {view === 'designer' && !Designer && <DesignerMissing onBack={() => setView('overview')} />}
      {view === 'designer' && Designer && (
        <Suspense fallback={<DesignerFallback />}>
          <Designer
            site={ws.site} pages={ws.pages} posts={ws.posts} locations={ws.locations} publicLocations={ws.publicLocations} messages={ws.messages} branding={ws.branding} venueName={name}
            mode={ctx.mode} pageId={ctx.pageId} postId={ctx.postId} brief={ctx.brief}
            onApplied={ws.reload} onReload={ws.reload}
            onOpenEditor={openEditor} onOpenBlog={() => setView('blog')} onPreview={openPreview} toast={toast}
          />
        </Suspense>
      )}

      {view === 'editor' && (
        <Editor
          ws={ws} toast={toast} pageId={ctx.pageId}
          onPageChange={(pageId) => setCtx((c) => ({ ...c, pageId }))}
          onAskDesigner={(pageId) => openDesigner({ pageId, mode: 'chat' })}
          onPreview={openPreview} onPublish={publish}
          onExit={() => setView('overview')}
        />
      )}

      {view === 'branding' && (
        <Branding ws={ws} toast={toast} onBrandBasics={onBack} onPublish={publish} onViewLive={viewLive} onPreview={openPreview} />
      )}

      {view === 'blog' && (
        <Blog ws={ws} toast={toast} onWriteForMe={(postId) => openDesigner({ postId, mode: 'post' })} />
      )}

      {terms && <PublishTermsModal busy={termsBusy} onAccept={acceptTerms} onCancel={cancelTerms} />}
    </div>
  );
}
