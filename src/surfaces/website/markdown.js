// src/surfaces/website/markdown.js
//
// The one Markdown renderer for the public site: blog posts, Text and Columns blocks, FAQ answers.
// Used by the SSR string renderer and by React (dangerouslySetInnerHTML), so a post looks the same
// to Google and to a visitor. No dependency (none allowed), so it is a small, safe subset:
// headings, paragraphs, bold, italic, links, images, lists, quotes, code, rules.
// Every piece of text is escaped first; a link href must be http(s), mailto, tel or a site path,
// anything else is dropped. So a venue can never inject script through a post.

export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function safeHref(href) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(h)) return h;
  return '';
}

function inline(text) {
  let s = esc(text);
  // images before links (same bracket shape)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
    const u = safeHref(url);
    return u ? `<img src="${esc(u)}" alt="${alt}" loading="lazy">` : alt;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const u = safeHref(url);
    return u ? `<a href="${esc(u)}">${label}</a>` : label;
  });
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  return s;
}

/** Markdown → HTML string. Empty or non string input gives ''. Never throws. */
export function renderMarkdown(md) {
  if (typeof md !== 'string' || !md.trim()) return '';
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  let quote = [];
  let code = null;

  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (code) {
      if (/^```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    if (/^```/.test(line)) { flushAll(); code = []; continue; }
    if (!line.trim()) { flushAll(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushAll(); const lvl = Math.min(6, h[1].length + 1); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushAll(); out.push('<hr>'); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara(); flushQuote();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    flushList(); flushQuote();
    para.push(line.trim());
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}

/** Plain text of a markdown string (for meta descriptions and excerpts), capped. */
export function markdownToText(md, max = 300) {
  const s = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
