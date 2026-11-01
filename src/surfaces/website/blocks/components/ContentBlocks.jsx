// src/surfaces/website/blocks/components/ContentBlocks.jsx
// Content blocks plus Reviews and BlogList in React. Markdown goes through the one renderer
// (markdown.js) that the SSR used, so the HTML is identical and already escaped.

import { CN } from '../classNames.js';
import { useSite } from '../../siteContext.js';
import { A } from '../../Link.jsx';
import { renderMarkdown, markdownToText } from '../../markdown.js';
import { publishedPosts } from '../../routes.js';
import { useNested } from '../nested.js';

const cls = (...xs) => xs.filter(Boolean).join(' ');
function Section({ type, id, className, extra, children }) {
  // 5.12.9: inside a Row column the block is marked nested (same attribute as the SSR section()).
  // 5.12.10: `extra` = data attributes the CSS keys on (Image fit/height, Heading align).
  const nested = useNested();
  return <section className={cls(CN.block, className)} data-block={type} data-id={id} data-nested={nested ? 'true' : undefined} {...(extra || {})}><div className={CN.inner}>{children}</div></section>;
}
const Empty = ({ children }) => <p className={CN.empty}>{children}</p>;
// The markdown renderer escapes every piece of user text itself, so this HTML is safe to set.
const Prose = ({ md, className }) => <div className={cls(CN.prose, className)} dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />;

function dateText(iso) {
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return ''; }
}

export function Text({ id, md }) {
  if (!renderMarkdown(md)) return null;
  return <Section type="Text" id={id} className={CN.text}><Prose md={md} /></Section>;
}

export function Columns({ id, cols, items }) {
  const list = (items || []).filter((i) => i && renderMarkdown(i.md));
  if (!list.length) return null;
  return <Section type="Columns" id={id} className={cls(CN.columns, String(cols) === '3' ? CN.cols3 : CN.cols2)}>{list.map((i, n) => <Prose key={n} md={i.md} />)}</Section>;
}

export function Gallery({ id, title, photos, cols }) {
  const list = (photos || []).filter((ph) => ph && /^https?:\/\//i.test(String(ph.url || '')));
  if (!list.length) return null;
  const c = Math.max(1, Math.min(4, Number(cols) || 3));
  return (
    <Section type="Gallery" id={id} className={CN.gallery}>
      {title ? <h2 className={CN.h2}>{title}</h2> : null}
      <div style={{ '--w-gallery-cols': c }}>{list.map((ph, n) => <img key={n} src={ph.url} alt={ph.alt || ''} loading="lazy" />)}</div>
    </Section>
  );
}

// 5.12.10: one photo, optional caption and link (same markup as the SSR Image renderer).
export function Image({ id, url, alt, caption, fit, height, width, rounded, href }) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  const img = <img src={url} alt={alt || ''} loading="lazy" />;
  return (
    <Section type="Image" id={id} className={CN.image} extra={{ 'data-fit': fit || 'cover', 'data-height': height || 'natural', 'data-width': ['page', 'wide', 'full'].includes(width) ? width : 'page', 'data-rounded': rounded === false ? 'false' : 'true' }}>
      <div className={CN.imageBox}>{href ? <A href={href}>{img}</A> : img}</div>
      {caption ? <p className={CN.imageCaption}>{caption}</p> : null}
    </Section>
  );
}

export function Heading({ id, text, level, align, sub }) {
  const t = String(text || '').trim();
  if (!t) return null;
  const Tag = level === '3' ? 'h3' : 'h2';
  return (
    <Section type="Heading" id={id} className={CN.headingBlock} extra={{ 'data-align': align || 'left' }}>
      <Tag className={CN.h2}>{t}</Tag>
      {sub ? <p className={CN.headingSub}>{sub}</p> : null}
    </Section>
  );
}

export function Button({ id, label, href, style }) {
  if (!label) return null;
  const styleCn = style === 'secondary' ? CN.btnSecondary : style === 'link' ? CN.btnLink : CN.btnPrimary;
  return <Section type="Button" id={id}><A className={cls(CN.btn, styleCn)} href={href}>{label}</A></Section>;
}

export function FAQ({ id, title, items }) {
  const list = (items || []).filter((i) => i && i.q && i.a);
  if (!list.length) return null;
  return (
    <Section type="FAQ" id={id} className={CN.faq}>
      {title ? <h2 className={CN.h2}>{title}</h2> : null}
      {list.map((i, n) => <details key={n} className={CN.faqItem}><summary>{i.q}</summary><div dangerouslySetInnerHTML={{ __html: renderMarkdown(i.a) }} /></details>)}
    </Section>
  );
}

export function Instagram({ id, handle }) {
  const h = String(handle || '').replace(/^@/, '').trim();
  if (!/^[a-z0-9._]{1,30}$/i.test(h)) return null;
  return <Section type="Instagram" id={id} className={CN.instagram}><a className={cls(CN.btn, CN.btnSecondary)} href={`https://www.instagram.com/${h}`} target="_blank" rel="noopener">Follow @{h} on Instagram</a></Section>;
}

export function Divider({ id }) {
  return <div className={cls(CN.block, CN.divider)} data-block="Divider" data-id={id}><div className={CN.inner}><hr /></div></div>;
}

export function Spacer({ id, size }) {
  return <div className={cls(CN.spacer, size === 's' ? CN.spacerS : size === 'l' ? CN.spacerL : CN.spacerM)} data-block="Spacer" data-id={id} />;
}

export function CustomHtml({ id, html }) {
  const { ctx } = useSite();
  // Owner only switch; the AI never sets it. Without it the block is simply not there.
  if (!(ctx.settings && ctx.settings.allow_custom_code === true)) return null;
  return <div className={cls(CN.block, CN.customHtml)} data-block="CustomHtml" data-id={id}><div className={CN.inner} dangerouslySetInnerHTML={{ __html: String(html || '') }} /></div>;
}

export function Reviews({ id, title, min_stars, count }) {
  const { ctx } = useSite();
  const list = (Array.isArray(ctx.reviews) ? ctx.reviews : []).filter((r) => r && Number(r.rating) >= Number(min_stars || 0)).slice(0, Number(count) || 6);
  if (!list.length) return null;
  return (
    <Section type="Reviews" id={id} className={CN.reviews}>
      {title ? <h2 className={CN.h2}>{title}</h2> : null}
      <div>{list.map((r, n) => (
        <blockquote key={n} className={cls(CN.card, CN.review)}>
          <div className={CN.stars} aria-label={`${r.rating} stars`}>{'★'.repeat(Math.max(0, Math.min(5, Math.round(Number(r.rating) || 0))))}</div>
          <p>{r.text || r.comment || ''}</p>
          <footer className={CN.muted}>{r.author || r.name || 'Guest'}</footer>
        </blockquote>
      ))}</div>
    </Section>
  );
}

export function BlogList({ id, title, count, show_excerpt }) {
  const { ctx } = useSite();
  const posts = publishedPosts(ctx.snapshot).slice(0, Number(count) || 3);
  const head = title ? <h2 className={CN.h2}>{title}</h2> : null;
  if (!posts.length) return <Section type="BlogList" id={id} className={CN.blogList}>{head}<Empty>No posts yet.</Empty></Section>;
  return (
    <Section type="BlogList" id={id} className={CN.blogList}>
      {head}
      <div>{posts.map((post) => (
        <A key={post.id || post.slug} className={cls(CN.card, CN.post)} href={`/blog/${post.slug}`}>
          {post.cover_url ? <img className={CN.postCover} src={post.cover_url} alt="" loading="lazy" /> : null}
          <h3>{post.title}</h3>
          {post.published_at ? <div className={CN.postMeta}>{dateText(post.published_at)}</div> : null}
          {show_excerpt && (post.excerpt || post.body_md) ? <p className={CN.muted}>{post.excerpt || markdownToText(post.body_md, 160)}</p> : null}
        </A>
      ))}</div>
    </Section>
  );
}

/** A whole blog post page body (the /blog/<slug> route). */
export function PostArticle({ post }) {
  return (
    <article className={cls(CN.block, CN.post)}>
      <div className={CN.inner}>
        {post.cover_url ? <img className={CN.postCover} src={post.cover_url} alt="" /> : null}
        <h1>{post.title}</h1>
        <div className={CN.postMeta}>{[post.author, post.published_at && dateText(post.published_at)].filter(Boolean).join(' · ')}</div>
        {renderMarkdown(post.body_md) ? <Prose md={post.body_md} className={CN.postBody} /> : <Empty>This post has no text yet.</Empty>}
      </div>
    </article>
  );
}
