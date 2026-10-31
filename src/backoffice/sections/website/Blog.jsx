// src/backoffice/sections/website/Blog.jsx
//
// Contract 9.5: posts list and a post editor (title, slug, excerpt, cover upload, markdown
// body with preview, tags, publish / unpublish) plus "Write it for me" which hands the post
// to the designer. Writes go through save_post / delete_post.

import { useRef, useState } from 'react';
import { W } from './ui.js';
import { formatWhen, isValidSlug, slugify } from './helpers.js';
// The same renderer the public site uses (agent B), so the preview matches the live post.
import { renderMarkdown, markdownToText } from '../../../surfaces/website/markdown.js';

const PREVIEW_STYLE = { fontSize: 14, lineHeight: 1.65, color: 'var(--t1)', wordBreak: 'break-word' };

function PostEditor({ post, posts, ws, toast, onDone, onWriteForMe }) {
  const isNew = !post?.id;
  const [form, setForm] = useState({
    title: post?.title || '', slug: post?.slug || '', excerpt: post?.excerpt || '', body_md: post?.body_md || '',
    cover_url: post?.cover_url || '', author: post?.author || '', tags: Array.isArray(post?.tags) ? post.tags.join(', ') : '', status: post?.status || 'draft',
  });
  const [slugTouched, setSlugTouched] = useState(!!post?.slug);
  const [tab, setTab] = useState('write');
  const [busy, setBusy] = useState('');
  const coverRef = useRef(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const effSlug = slugTouched ? form.slug : slugify(form.title);

  const toPatch = (status) => ({
    title: form.title.trim(), slug: effSlug, excerpt: form.excerpt.trim() || markdownToText(form.body_md, 160), body_md: form.body_md,
    cover_url: form.cover_url || null, author: form.author.trim() || null,
    // published_at is set by the edge function on the first publish; the validator refuses it here.
    tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean), status,
  });

  const save = async (status = form.status) => {
    if (!form.title.trim()) { toast('Give the post a title.', 'error'); return; }
    if (!isValidSlug(effSlug)) { toast('The address can only use lower case letters, numbers and dashes.', 'error'); return; }
    if (posts.some((p) => p.slug === effSlug && p.id !== post?.id)) { toast('Another post already has that address.', 'error'); return; }
    setBusy(status);
    const { error } = await ws.savePost(post?.id || null, toPatch(status));
    setBusy('');
    if (error) { toast(error.message || 'Could not save the post', 'error'); return; }
    toast(status === 'published' ? 'Post published' : 'Post saved');
    onDone();
  };

  const remove = async () => {
    if (!post?.id) { onDone(); return; }
    if (!window.confirm(`Delete "${post.title}"? This cannot be undone.`)) return;
    setBusy('delete');
    const { error } = await ws.deletePost(post.id);
    setBusy('');
    if (error) toast(error.message || 'Could not delete', 'error'); else { toast('Post deleted'); onDone(); }
  };

  const pickCover = async () => {
    const file = coverRef.current?.files?.[0]; if (!file) return;
    setBusy('cover');
    const { url, error } = await ws.uploadAsset(file, 'post');
    setBusy('');
    if (error) toast(error.message || 'Upload failed', 'error'); else set({ cover_url: url });
  };

  return (
    <div style={W.card}>
      <div style={W.cardHead}>
        <h2 style={W.h2}>{isNew ? 'New post' : 'Edit post'}</h2>
        <div style={W.row}>
          {!isNew && <button style={W.ghost} onClick={() => onWriteForMe(post.id)}>✨ Write it for me</button>}
          <button style={W.ghost} onClick={onDone}>Back to posts</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <div style={W.field}><label style={W.label}>Title</label><input style={W.input} value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Our new autumn menu" /></div>
        <div style={W.field}><label style={W.label}>Address</label>
          <div style={{ ...W.row, gap: 6 }}><span style={{ ...W.mono, color: 'var(--t3)' }}>/blog/</span><input style={{ ...W.input, flex: 1 }} value={effSlug} onChange={(e) => { setSlugTouched(true); set({ slug: slugify(e.target.value) }); }} /></div>
        </div>
      </div>
      <div style={W.field}><label style={W.label}>Excerpt <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional, made from the body when blank</span></label>
        <input style={W.input} value={form.excerpt} onChange={(e) => set({ excerpt: e.target.value })} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
        <div style={W.field}><label style={W.label}>Cover photo</label>
          <input ref={coverRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={pickCover} />
          <div style={W.row}>
            {form.cover_url && <div style={{ width: 96, height: 54, borderRadius: 8, backgroundImage: `url(${form.cover_url})`, backgroundSize: 'cover', backgroundPosition: 'center', border: '1px solid var(--bdr2)' }} />}
            <button style={W.ghost} disabled={busy === 'cover'} onClick={() => coverRef.current?.click()}>{busy === 'cover' ? 'Uploading…' : form.cover_url ? 'Replace' : 'Upload'}</button>
            {form.cover_url && <button style={W.ghost} onClick={() => set({ cover_url: '' })}>Remove</button>}
          </div>
        </div>
        <div style={W.field}><label style={W.label}>Tags <span style={{ color: 'var(--t4)', fontWeight: 500 }}>comma separated</span></label><input style={W.input} value={form.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="news, menu" /></div>
        <div style={W.field}><label style={W.label}>Author <span style={{ color: 'var(--t4)', fontWeight: 500 }}>optional</span></label><input style={W.input} value={form.author} onChange={(e) => set({ author: e.target.value })} /></div>
      </div>
      <div style={W.field}>
        <div style={{ ...W.row, justifyContent: 'space-between', marginBottom: 6 }}>
          <label style={{ ...W.label, marginBottom: 0 }}>Body</label>
          <div style={{ display: 'flex', gap: 4 }}>
            <button style={W.seg(tab === 'write')} onClick={() => setTab('write')}>Write</button>
            <button style={W.seg(tab === 'preview')} onClick={() => setTab('preview')}>Preview</button>
          </div>
        </div>
        {tab === 'write'
          ? <textarea style={{ ...W.textarea, minHeight: 320, ...W.mono }} value={form.body_md} onChange={(e) => set({ body_md: e.target.value })} placeholder={'Write in plain text. # for a heading, **bold**, - for a list, [link text](https://...)'} />
          : <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, padding: '14px 16px', background: 'var(--bg2)', minHeight: 320 }}>
              {form.body_md.trim()
                ? <div style={PREVIEW_STYLE} className="svw-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(form.body_md) }} />
                : <div style={W.hint}>Nothing to preview yet.</div>}
            </div>}
        <div style={W.hint}>Markdown. The live site renders it the same way.</div>
      </div>
      <div style={{ ...W.row, justifyContent: 'space-between' }}>
        <div style={W.row}>
          <button style={W.ghost} disabled={!!busy} onClick={() => save('draft')}>{busy === 'draft' ? 'Saving…' : 'Save draft'}</button>
          {form.status === 'published'
            ? <button style={W.btn} disabled={!!busy} onClick={() => save('published')}>{busy === 'published' ? 'Saving…' : 'Save and keep published'}</button>
            : <button style={W.btn} disabled={!!busy} onClick={() => save('published')}>{busy === 'published' ? 'Publishing…' : 'Publish'}</button>}
          {form.status === 'published' && <button style={W.ghost} disabled={!!busy} onClick={() => save('draft')}>Unpublish</button>}
        </div>
        {!isNew && <button style={W.danger} disabled={!!busy} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>}
      </div>
    </div>
  );
}

export default function Blog({ ws, toast, onWriteForMe }) {
  const { site, posts } = ws;
  const [editing, setEditing] = useState(null); // null | 'new' | post id
  if (!site) return <div style={W.empty}>No site yet. Go to Overview and press Build me a website.</div>;

  if (editing) {
    const post = editing === 'new' ? null : posts.find((p) => p.id === editing);
    return <PostEditor key={editing} post={post} posts={posts} ws={ws} toast={toast} onDone={() => setEditing(null)} onWriteForMe={onWriteForMe} />;
  }

  const sorted = [...(posts || [])].sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0));
  return (
    <div style={W.card}>
      <div style={W.cardHead}>
        <h2 style={W.h2}>Blog</h2>
        <div style={W.row}>
          <button style={W.ghost} onClick={() => onWriteForMe(null)}>✨ Write a post for me</button>
          <button style={W.btn} onClick={() => setEditing('new')}>+ New post</button>
        </div>
      </div>
      {sorted.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.6 }}>No posts yet. Posts help Google find you: new dishes, events, your story. The designer writes starter posts when it builds the site.</div>}
      {sorted.map((p) => (
        <div key={p.id} style={W.listRow}>
          {p.cover_url ? <div style={{ width: 56, height: 36, borderRadius: 6, backgroundImage: `url(${p.cover_url})`, backgroundSize: 'cover', backgroundPosition: 'center', flex: 'none' }} /> : <div style={{ width: 56, height: 36, borderRadius: 6, background: 'var(--bg3)', flex: 'none' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: 'var(--t1)', fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title || 'Untitled'}</div>
            <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>/blog/{p.slug} · {formatWhen(p.updated_at)}{(p.tags || []).length ? ` · ${p.tags.join(', ')}` : ''}</div>
          </div>
          <span style={W.pill(p.status === 'published' ? 'good' : 'warn')}>{p.status === 'published' ? 'Published' : 'Draft'}</span>
          <button style={W.ghost} onClick={() => setEditing(p.id)}>Edit</button>
        </div>
      ))}
    </div>
  );
}
