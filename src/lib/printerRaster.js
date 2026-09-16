/**
 * printerRaster.js: draw a print document to a 1 bit bitmap with a canvas.
 *
 * DOM only (the web app runs in WebViews with canvas support). Used for the Star TSP100
 * family, which has no fonts: printerDialects.layoutDocRows decides what each row says
 * and how it is styled (pure, tested); this file paints those rows with a monospace font
 * sized so one character is exactly 12 dots wide (Font A on a Star printer), thresholds
 * the pixels to black and white and packs them MSB first, 1 = black, the row format the
 * Star raster command wants. v5.8.84.
 */

import { layoutDocRows, rowHeight, RASTER_METRICS } from './printerDialects.js';

const FONT_STACK = '"Menlo", "DejaVu Sans Mono", "Courier New", "Droid Sans Mono", monospace';

// Pick a font size whose advance width is exactly charW dots. Monospace advance is
// roughly 0.6 of the font size, but the exact ratio differs per font, so measure.
function fontFor(ctx, charW, bold) {
  const probe = 100;
  ctx.font = `${bold ? 'bold ' : ''}${probe}px ${FONT_STACK}`;
  const adv = ctx.measureText('M').width || probe * 0.6;
  const size = Math.max(4, (probe / adv) * charW);
  return `${bold ? 'bold ' : ''}${size.toFixed(2)}px ${FONT_STACK}`;
}

async function qrModules(text, ec) {
  const mod = await import('qrcode');
  const QRCode = mod.default || mod;
  const code = QRCode.create(String(text), { errorCorrectionLevel: ec || 'M' });
  return { size: code.modules.size, data: code.modules.data };
}

/**
 * @param {object} doc      from printDoc.js
 * @param {object} spec     from printerDialects.resolvePrinterSpec (dots, cols)
 * @returns {Promise<{ width:number, height:number, bits:Uint8Array, hasCut:boolean, hasDrawer:boolean }>}
 */
export async function renderDocToBitmap(doc, spec) {
  if (typeof document === 'undefined') throw new Error('renderDocToBitmap needs a DOM (canvas)');
  const width = spec?.dots || 576;
  const { rows, hasCut, hasDrawer } = layoutDocRows(doc, spec);
  const { charW, charH, fontBW } = RASTER_METRICS;

  // Pass 1: heights. QR rows need the symbol size, so encode them up front.
  const qrs = new Map();
  for (const r of rows) {
    if (r.kind === 'qr') {
      try { qrs.set(r, await qrModules(r.text, r.ec)); } catch (e) { console.warn('[Print] QR encode failed, skipping:', e?.message); }
    }
  }
  const heights = rows.map((r) => {
    if (r.kind === 'qr') {
      const q = qrs.get(r);
      if (!q) return 0;
      const cell = Math.max(2, Math.min(8, r.moduleSize | 0));
      return Math.min(width, (q.size + 8) * cell) + 16;
    }
    return rowHeight(r);
  });
  const height = Math.max(1, heights.reduce((a, b) => a + b, 0) + 8);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';

  let y = 0;
  rows.forEach((row, i) => {
    const h = heights[i];
    if (row.kind === 'text') {
      // Measure the row in character cells (double width counts twice) to place it.
      let cells = 0;
      for (const g of row.segs) cells += g.s.length * (g.style.size === 'both' ? 2 : 1) * (g.style.font === 'B' ? fontBW / charW : 1);
      const rowW = cells * charW;
      let x = row.align === 'center' ? Math.max(0, Math.floor((width - rowW) / 2)) : 0;
      const tall = row.segs.some((g) => g.style.size !== 'normal');
      const baseline = y + (tall ? charH * 2 : charH) - 3;
      for (const g of row.segs) {
        const st = g.style;
        const sx = st.size === 'both' ? 2 : 1;
        const sy = st.size === 'normal' ? 1 : 2;
        const cw = st.font === 'B' ? fontBW : charW;
        const bold = st.bold || st.red;   // no red on a raster printer: red lines print bold
        ctx.save();
        ctx.font = fontFor(ctx, cw, bold);
        ctx.translate(x, baseline);
        ctx.scale(sx, sy);
        ctx.fillText(g.s, 0, 0);
        if (bold) ctx.fillText(g.s, 0.6, 0);   // a heavier stroke than the font's bold alone
        ctx.restore();
        const segW = g.s.length * cw * sx;
        if (st.underline) ctx.fillRect(x, baseline + 3, segW, 2);
        x += segW;
      }
    } else if (row.kind === 'bitmap') {
      const bm = row.bitmap;
      const stride = (bm.width + 7) >> 3;
      const x0 = row.align === 'center' ? Math.max(0, Math.floor((width - bm.width) / 2)) : 0;
      const img = ctx.createImageData(Math.min(bm.width, width), bm.height);
      for (let yy = 0; yy < bm.height; yy++) {
        for (let xx = 0; xx < img.width; xx++) {
          const black = (bm.bits[yy * stride + (xx >> 3)] >> (7 - (xx & 7))) & 1;
          const o = (yy * img.width + xx) * 4;
          const v = black ? 0 : 255;
          img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, x0, y + 4);
    } else if (row.kind === 'qr') {
      const q = qrs.get(row);
      if (q) {
        const cell = Math.max(2, Math.min(8, row.moduleSize | 0));
        const size = q.size * cell;
        const x0 = row.align === 'center' ? Math.max(0, Math.floor((width - size) / 2)) : 4 * cell;
        const y0 = y + 8 + 4 * cell;
        for (let r = 0; r < q.size; r++) {
          for (let c = 0; c < q.size; c++) {
            if (q.data[r * q.size + c]) ctx.fillRect(x0 + c * cell, y0 + r * cell, cell, cell);
          }
        }
      }
    }
    y += h;
  });

  // Threshold to 1 bit. Text is anti-aliased; a plain 50% cut keeps glyphs crisp.
  const px = ctx.getImageData(0, 0, width, height).data;
  const stride = (width + 7) >> 3;
  const bits = new Uint8Array(stride * height);
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      const o = (yy * width + xx) * 4;
      const lum = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
      if (lum < 128) bits[yy * stride + (xx >> 3)] |= 0x80 >> (xx & 7);
    }
  }
  return { width, height, bits, hasCut, hasDrawer };
}
