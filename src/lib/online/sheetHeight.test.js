// 5.12.80: a customer sheet (basket, item, checkout, QR checkout, header dialogs) is sized against
// the visible screen, never against the bare viewport unit. Inside the customer app's in-app
// browser (and Safari with its bars showing) a vh is the FULL screen, taller than what is
// visible, so a 96vh sheet anchored to the bottom pushed its own title under the browser bar
// (Peter, 20 Nov 2026, Coffee Boy build 6 at Headingley: "this screen is off the top of the
// display"). The overlay is position fixed inset 0, which IS the visible area, so 100% of it is
// the cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const files = [
  'src/surfaces/online/OnlineCart.jsx',
  'src/surfaces/online/OnlineCheckout.jsx',
  'src/surfaces/online/OnlineSurface.jsx',
  'src/surfaces/online/OnlineHeaderBlock.jsx',
  'src/surfaces/online/OnlineItemSheet.jsx',
  'src/surfaces/qr/QrCheckout.jsx',
];

test('no customer sheet is sized with a bare vh: every one is capped at the visible overlay height', () => {
  for (const f of files) {
    const src = fs.readFileSync(path.resolve(f), 'utf8');
    const bare = src.match(/maxHeight: '9\dvh'/g) || [];
    assert.deepEqual(bare, [], `${f} still sizes a sheet with a bare vh`);
    const capped = src.match(/maxHeight: 'min\(9\dvh, calc\(100% - 12px\)\)'/g) || [];
    assert.ok(capped.length >= 1, `${f} has no capped sheet`);
  }
});
