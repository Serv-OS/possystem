// src/backoffice/sections/website/designer/Designer.jsx
//
// The AI designer view of the Website builder (ARCHITECTURE.md section 9.2, agent D). Chat on
// the left (messages from web_ai_messages, the facts the designer read, suggestion chips, input),
// the three layout cards and "Build my site" on the right, and after a build a live preview of the
// pages. Every call goes to /api/website-designer (src/lib/website/designerClient.js); the server
// assembles the venue facts itself, so this screen sends only the site id, the words and a layout.
// BO tokens only (ui.js W styles). Nothing here throws to the screen: a failed call becomes a
// message in the chat and a toast.
//
// Mounted by WebsiteBuilder.jsx (agent C) with: site, pages, posts, locations, publicLocations,
// messages, branding, venueName, mode, pageId, postId, brief, onApplied, onReload, onOpenEditor,
// onOpenBlog, onPreview, toast. The contract's names (onSiteChanged, onOpenEditor) are honoured too.

import { useCallback, useEffect, useMemo, useRef, useState, Component } from 'react';
import { W } from '../ui.js';
import { designerRequest, designerFacts } from '../../../../lib/website/designerClient.js';
import { siteVars } from '../../../../surfaces/website/theme.js';
// The public site's own renderer, context and stylesheet (agent B), so the preview is the real
// site markup: same blocks, same class names, same theme variables. Puck is not involved here.
import { BlockRenderer } from '../../../../surfaces/website/blocks/BlockRenderer.jsx';
import { SiteContext } from '../../../../surfaces/website/siteContext.js';
import { buildCtx } from '../../../../surfaces/website/ssr/renderBlocks.js';
import { SITE_CSS } from '../../../../surfaces/website/siteStyles.js';
import { CUSTOMER_ROOT } from '../../../../lib/env';

// The site stylesheet is scoped to .w-site, so one copy in the Back Office document is harmless.
function ensureSiteCss() {
  try {
    if (document.getElementById('w-css')) return;
    const el = document.createElement('style');
    el.id = 'w-css';
    el.textContent = SITE_CSS;
    document.head.appendChild(el);
  } catch { /* no document, no styles, no crash */ }
}

const LAYOUT_CARDS = [
  { id: 'ember', name: 'Ember', blurb: 'Photo led and warm. Best when most dishes have photos.' },
  { id: 'ledger', name: 'Ledger', blurb: 'Clean and text led. Menu as a list with prices.' },
  { id: 'marquee', name: 'Marquee', blurb: 'Bold type, dark mood, your brand colour as the accent.' },
];

const SUGGESTIONS = [
  'Make the home page shorter',
  'Rewrite the SEO titles and descriptions',
  'Write a blog post about our most popular dishes',
  'Add an FAQ to the catering page',
  'Give every location page a short welcome',
  'Switch to the Marquee layout',
];

/** Oldest first, never throws on odd input. */
function orderMessages(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice()
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

const D = {
  wrap: { display: 'grid', gridTemplateColumns: 'minmax(320px, 5fr) minmax(300px, 6fr)', gap: 16, alignItems: 'start' },
  chat: { ...W.card, display: 'flex', flexDirection: 'column', minHeight: 520, marginBottom: 0 },
  list: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 2px', maxHeight: 460 },
  bubble: (mine) => ({
    alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%', padding: '9px 12px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap',
    background: mine ? 'var(--acc)' : 'var(--bg2)', color: mine ? '#0b0c10' : 'var(--t1)', border: mine ? 'none' : '1px solid var(--bdr)',
  }),
  facts: { border: '1px dashed var(--bdr2)', borderRadius: 10, padding: '8px 12px', marginBottom: 10, background: 'var(--bg2)' },
  factLine: { fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.6 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' },
  chip: { ...W.chip, cursor: 'pointer' },
  inputRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 14 },
  card: (on) => ({ border: `2px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, borderRadius: 14, padding: 12, cursor: 'pointer', background: on ? 'var(--acc-d, rgba(232,116,60,.10))' : 'var(--bg2)', textAlign: 'left', fontFamily: 'inherit' }),
  wire: { height: 92, borderRadius: 8, background: 'var(--bg1)', border: '1px solid var(--bdr)', padding: 6, display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8, overflow: 'hidden' },
  frame: (phone) => ({ width: phone ? 390 : '100%', maxWidth: '100%', margin: '0 auto', border: '1px solid var(--bdr)', borderRadius: 14, overflow: 'auto', maxHeight: 620, background: 'var(--bg2)' }),
};

/** Tiny CSS wireframes so the owner can tell the three looks apart before building. */
function Wireframe({ id }) {
  const bar = (h, w = '100%', bg = 'var(--bg3)') => <div style={{ height: h, width: w, background: bg, borderRadius: 3 }} />;
  if (id === 'ember') {
    return (
      <div style={D.wire}>
        {bar(34, '100%', 'var(--acc)')}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>{bar(18)}{bar(18)}{bar(18)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>{bar(18)}{bar(18)}{bar(18)}</div>
      </div>
    );
  }
  if (id === 'marquee') {
    return (
      <div style={{ ...D.wire, background: 'var(--t1)' }}>
        {bar(10, '70%', 'var(--acc)')}
        {bar(10, '55%', 'var(--acc)')}
        <div style={{ flex: 1 }} />
        {bar(8, '100%', 'var(--t3)')}
        {bar(8, '100%', 'var(--t3)')}
      </div>
    );
  }
  return (
    <div style={D.wire}>
      {bar(12, '100%', 'var(--acc)')}
      {bar(6, '80%')}{bar(6, '70%')}{bar(6, '85%')}{bar(6, '60%')}
    </div>
  );
}

/** Fallback preview: page title and block names, so the right side is never blank. */
function BlockList({ data, page }) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)', marginBottom: 8 }}>{page?.title || 'Page'}</div>
      {blocks.length === 0 && <div style={W.hint}>No blocks on this page yet.</div>}
      {blocks.map((b, i) => (
        <div key={b?.props?.id || i} style={{ ...W.listRow, fontSize: 13, color: 'var(--t2)' }}>
          <span style={W.chip}>{b?.type || 'Block'}</span>
          <span style={{ color: 'var(--t3)' }}>{summariseProps(b?.props)}</span>
        </div>
      ))}
    </div>
  );
}

function summariseProps(props) {
  if (!props || typeof props !== 'object') return '';
  const s = props.headline || props.title || props.md || props.sub || '';
  return typeof s === 'string' ? s.slice(0, 80) : '';
}

// The preview must never take the screen down: a renderer error shows the block list instead.
class PreviewBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { /* the fallback is the message */ }
  render() {
    if (this.state.failed) return <BlockList data={this.props.data} page={this.props.page} />;
    return this.props.children;
  }
}

function Preview({ site, pages, branding, publicLocations, onOpenEditor }) {
  const [slug, setSlug] = useState(pages[0]?.slug ?? '');
  const [phone, setPhone] = useState(false);
  // A chosen slug that no longer exists falls back to the first page; no state write needed.
  const page = pages.find((p) => p.slug === slug) || pages[0] || null;
  const vars = useMemo(() => {
    try { return siteVars(site?.theme || {}, branding || {}); } catch { return {}; }
  }, [site?.theme, branding]);
  useEffect(() => { ensureSiteCss(); }, []);
  // The draft as a snapshot, the shape every renderer reads (drafts count as published here:
  // the owner is checking their own unpublished work).
  const value = useMemo(() => {
    const snapshot = {
      site: { ...(site || {}), status: 'draft' },
      pages: (pages || []).map((p) => ({ ...p, status: 'published' })),
      posts: [],
      locations: Array.isArray(publicLocations) ? publicLocations : [],
    };
    const ctx = buildCtx({ snapshot, host: '', path: '/', menu: null, customerRoot: CUSTOMER_ROOT });
    return { ctx, menu: null, menuLoading: false, here: null, nearestState: 'idle', requestNearest: () => {}, navigate: () => {} };
  }, [site, pages, publicLocations]);
  if (!page) return <div style={W.empty}>No pages yet. Build the site to see a preview here.</div>;
  return (
    <div>
      <div style={{ ...W.row, justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ ...W.row, gap: 6 }}>
          {pages.map((p) => (
            <button key={p.id || p.slug} type="button" style={W.tab(p.slug === page.slug)} onClick={() => setSlug(p.slug)}>
              {p.title || (p.slug === '' ? 'Home' : p.slug)}{p.status === 'draft' ? ' (draft)' : ''}
            </button>
          ))}
        </div>
        <div style={{ ...W.row, gap: 6 }}>
          <button type="button" style={W.seg(!phone)} onClick={() => setPhone(false)}>Desktop</button>
          <button type="button" style={W.seg(phone)} onClick={() => setPhone(true)}>Phone</button>
          {onOpenEditor && <button type="button" style={W.ghost} onClick={() => onOpenEditor(page.id)}>Edit this page</button>}
        </div>
      </div>
      <div style={D.frame(phone)}>
        <div className="w-site" data-layout={site?.theme?.layout || 'ember'} style={{ ...vars, minHeight: 200 }}>
          <PreviewBoundary data={page.layout} page={page}>
            <SiteContext.Provider value={value}>
              <main className="w-main">
                <BlockRenderer layout={page.layout} settings={value.ctx.settings} />
              </main>
            </SiteContext.Provider>
          </PreviewBoundary>
        </div>
      </div>
    </div>
  );
}

export default function Designer(props) {
  const {
    site, pages = [], messages: initialMessages = [], publicLocations = [], branding = null, venueName = '',
    mode = 'chat', pageId = null, postId = null, brief = '',
    onApplied, onReload, onSiteChanged, onOpenEditor, toast,
  } = props;
  const siteId = site?.id || null;
  const notify = useCallback((msg, type = 'success') => { try { toast?.(msg, type); } catch { /* a toast never breaks the screen */ } }, [toast]);
  const refresh = useCallback(async () => {
    const fn = onSiteChanged || onApplied || onReload;
    if (!fn) return;
    try { await fn(); } catch { /* the parent reports its own load errors */ }
  }, [onSiteChanged, onApplied, onReload]);

  const [msgs, setMsgs] = useState(() => orderMessages(initialMessages));
  const [facts, setFacts] = useState([]);
  const [factsOpen, setFactsOpen] = useState(true);
  const [input, setInput] = useState(mode === 'build' ? brief : '');
  const [layout, setLayout] = useState(site?.theme?.layout || null);
  const [busy, setBusy] = useState(false);
  const [showCards, setShowCards] = useState(!pages.length);
  const listRef = useRef(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { setMsgs(orderMessages(initialMessages)); }, [initialMessages]);
  useEffect(() => { if (site?.theme?.layout) setLayout(site.theme.layout); }, [site?.theme?.layout]);
  useEffect(() => { if (mode === 'build' && brief) setInput(brief); }, [mode, brief]);
  useEffect(() => { try { listRef.current?.scrollTo?.({ top: 1e9 }); } catch { /* scrolling is a nicety */ } }, [msgs.length, busy]);

  // What the designer read: fetched from the server without spending anything.
  const loadFacts = useCallback(async () => {
    if (!siteId) return;
    const r = await designerFacts(siteId);
    if (!alive.current) return;
    if (Array.isArray(r?.facts)) setFacts(r.facts);
    if (Array.isArray(r?.messages) && r.messages.length) setMsgs((cur) => (cur.length >= r.messages.length ? cur : orderMessages(r.messages)));
  }, [siteId]);
  useEffect(() => { loadFacts(); }, [loadFacts]);

  const contextPage = useMemo(() => pages.find((p) => p.id === pageId) || null, [pages, pageId]);

  const send = useCallback(async (text, { mode: sendMode = 'chat', layout: sendLayout = null } = {}) => {
    const message = String(text || '').trim();
    if (!siteId || busy) return;
    if (!message && sendMode !== 'build') return;
    setBusy(true);
    const stamp = new Date().toISOString();
    const shown = message || `Build my website${sendLayout ? ` with the ${sendLayout} layout` : ''}.`;
    setMsgs((cur) => [...cur, { role: 'user', content: shown, created_at: stamp, local: true }]);
    setInput('');
    const r = await designerRequest({ site_id: siteId, message, mode: sendMode, page_id: pageId, post_id: postId, layout: sendLayout });
    if (!alive.current) return;
    if (r.error) {
      notify(r.error, 'error');
      setMsgs((cur) => [...cur, { role: 'assistant', content: `I could not do that: ${r.error}`, created_at: new Date().toISOString(), local: true }]);
    } else {
      setMsgs((cur) => [...cur, { role: 'assistant', content: r.reply || 'Done.', created_at: new Date().toISOString(), local: true, applied: r.applied }]);
      if (r.applied) {
        notify(sendMode === 'build' ? 'Your site is built. Check the preview on the right.' : `Updated ${r.pages_changed?.length || 0} page${r.pages_changed?.length === 1 ? '' : 's'}.`);
        setShowCards(false);
        await refresh();
      } else if (Array.isArray(r.errors) && r.errors.length) {
        notify('The designer could not apply that. See the chat for why.', 'error');
      }
    }
    setBusy(false);
    loadFacts();
  }, [siteId, busy, pageId, postId, notify, refresh, loadFacts]);

  const buildSite = useCallback(() => send(input || brief, { mode: 'build', layout }), [send, input, brief, layout]);

  if (!siteId) return <div style={W.empty}>Your website is still loading. Try again in a moment.</div>;

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={W.h1}>AI designer</h2>
        <div style={W.sub}>
          Tell it what you want in plain words. It reads your ServOS menu, locations, hours and channels, so it never needs them typed in.
          {contextPage ? ` Talking about the ${contextPage.title || 'page'} page.` : ''}
        </div>
      </div>

      <div style={D.wrap}>
        <section style={D.chat} aria-label="Designer chat">
          <div style={D.facts}>
            <button type="button" onClick={() => setFactsOpen((v) => !v)} style={{ ...W.ghost, border: 'none', padding: 0, background: 'transparent', color: 'var(--t2)' }}>
              {factsOpen ? 'Hide' : 'Show'} what the designer read
            </button>
            {factsOpen && (
              <div style={{ marginTop: 6 }}>
                {facts.length === 0 && <div style={D.factLine}>Reading your ServOS setup…</div>}
                {facts.map((line, i) => <div key={i} style={D.factLine}>{line}</div>)}
              </div>
            )}
          </div>

          <div ref={listRef} style={D.list}>
            {msgs.length === 0 && (
              <div style={{ ...W.hint, padding: '20px 4px' }}>
                {pages.length ? 'Ask for a change, or pick a suggestion below.' : `No site yet for ${venueName || 'your venue'}. Pick a layout on the right and press Build my site, or just describe what you want.`}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={m.id || `${m.created_at || ''}-${i}`} style={D.bubble(m.role === 'user')}>
                {m.content}
                {m.role === 'assistant' && (m.patch || m.applied) ? <div style={{ ...W.hint, marginTop: 6, color: 'var(--grn)' }}>Changes applied</div> : null}
              </div>
            ))}
            {busy && <div style={D.bubble(false)}>Working on it…</div>}
          </div>

          <div style={D.chips}>
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" style={D.chip} disabled={busy} onClick={() => setInput(s)}>{s}</button>
            ))}
          </div>

          <div style={D.inputRow}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
              placeholder={pages.length ? 'Ask for a change, or paste a site you like and say what to take from it' : 'Describe your site, paste a website you like, or press Build my site'}
              rows={2}
              style={{ ...W.textarea, minHeight: 52 }}
              disabled={busy}
            />
            <button type="button" style={{ ...W.btn, opacity: busy || !input.trim() ? 0.6 : 1 }} disabled={busy || !input.trim()} onClick={() => send(input)}>Send</button>
          </div>
        </section>

        <section aria-label="Layout and preview">
          {showCards || !pages.length ? (
            <div style={{ ...W.card, marginBottom: 0 }}>
              <div style={W.cardHead}>
                <div>
                  <div style={W.h2}>Pick a look</div>
                  <div style={{ ...W.hint, marginTop: 2 }}>Leave it unpicked and the designer chooses by how many of your dishes have photos.</div>
                </div>
                {pages.length > 0 && <button type="button" style={W.ghost} onClick={() => setShowCards(false)}>Back to preview</button>}
              </div>
              <div style={D.cards}>
                {LAYOUT_CARDS.map((c) => (
                  <button key={c.id} type="button" style={D.card(layout === c.id)} onClick={() => setLayout(layout === c.id ? null : c.id)} aria-pressed={layout === c.id}>
                    <Wireframe id={c.id} />
                    <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--t1)' }}>{c.name}</div>
                    <div style={{ ...W.hint, marginTop: 2 }}>{c.blurb}</div>
                  </button>
                ))}
              </div>
              <div style={W.row}>
                <button type="button" style={{ ...W.btn, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={buildSite}>
                  {pages.length ? 'Rebuild my site' : 'Build my site'}
                </button>
                <span style={W.hint}>
                  {pages.length ? 'A rebuild replaces every page the designer makes. Pages you added yourself are kept.' : 'Home, menu, ordering, find us, a page per location, two draft posts and a draft Our story.'}
                </span>
              </div>
            </div>
          ) : (
            <div style={{ ...W.card, marginBottom: 0 }}>
              <div style={W.cardHead}>
                <div style={W.h2}>Live preview</div>
                <button type="button" style={W.ghost} onClick={() => setShowCards(true)}>Change the look</button>
              </div>
              <Preview site={site} pages={pages} branding={branding} publicLocations={publicLocations} onOpenEditor={onOpenEditor} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
