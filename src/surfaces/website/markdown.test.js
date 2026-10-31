// The one markdown renderer: a safe subset, every value escaped, unsafe links dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, markdownToText, esc, safeHref } from './markdown.js';

test('headings, paragraphs, emphasis, links, images, lists, quotes, code, rules', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** and *it* with a [link](/menu) and ![pic](https://x/y.jpg).\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n---\n\n```\ncode <here>\n```');
  assert.match(html, /<h2>Title<\/h2>/, 'markdown # becomes h2: the page owns the one h1');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>it<\/em>/);
  assert.match(html, /<a href="\/menu">link<\/a>/);
  assert.match(html, /<img src="https:\/\/x\/y\.jpg" alt="pic" loading="lazy">/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<pre><code>code &lt;here&gt;<\/code><\/pre>/);
});

test('user text is escaped and unsafe hrefs are dropped', () => {
  const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.b) "q" & \'a\'');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<a href="https:\/\/a\.b">ok<\/a>/);
  assert.equal(esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(safeHref('data:text/html,x'), '');
  assert.equal(safeHref('tel:+441234'), 'tel:+441234');
});

test('empty and junk give empty, never a throw; markdownToText strips and caps', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(renderMarkdown(42), '');
  assert.equal(markdownToText('# Hi\n\nSome **bold** [link](/x) ![i](u)'), 'Hi Some bold link');
  assert.equal(markdownToText('a'.repeat(400), 20).length, 20);
});
