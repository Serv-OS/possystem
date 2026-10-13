// Public pages must scroll by themselves.
//
// 13 Oct 2026: on the guest WiFi sign in page a small phone could not reach the "Connect to WiFi"
// button. The app locks page scrolling for the tills (globals.css: html, body and #root are
// overflow hidden, height 100%), and this page was a plain block with minHeight 100vh, so anything
// below the fold was cut off with no way to scroll. Measured live at 360 by 560: page 816 px tall,
// button at 618 px, nothing scrollable. The review page and the waitlist join page were built the
// same way. Each is now its own scroller. This test keeps it that way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const PAGES = ['src/surfaces/WifiSurface.jsx', 'src/surfaces/ReviewSurface.jsx', 'src/surfaces/waitlist/WaitlistJoinSurface.jsx'];
const pageLine = (src) => src.split('\n').find((l) => /^\s*page: \{/.test(l)) || '';

test('the app still locks page scrolling at the root, which is why public pages need their own', () => {
  const css = read('src/styles/globals.css');
  const block = css.match(/html, body, #root \{[^}]*\}/);
  assert.ok(block, 'the html, body, #root rule is there');
  assert.match(block[0], /overflow:\s*hidden/);
});

for (const p of PAGES) {
  test(`${p}: the page is its own scroller`, () => {
    const line = pageLine(read(p));
    assert.ok(line, 'the page style is found');
    assert.match(line, /position: 'fixed'/);
    assert.match(line, /inset: 0/);
    assert.match(line, /overflowY: 'auto'/);
    assert.match(line, /WebkitOverflowScrolling: 'touch'/);
    assert.doesNotMatch(line, /minHeight: '100vh'/, 'a 100vh block cannot scroll inside the locked root');
    assert.match(line, /safe-area-inset-bottom/, 'room is left under the last button');
  });

  test(`${p}: the page style is still the outer element`, () => {
    const src = read(p);
    assert.match(src, /\.\.\.S\.page|style=\{S\.page\}/, 'S.page is spread into or used as the outer style');
  });
}
