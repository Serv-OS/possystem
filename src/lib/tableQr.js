// src/lib/tableQr.js
//
// Printable table QR codes for Back Office, Online Ordering.
//
// Peter, 18 Sep 2026: "none of these download buttons work or the download all".
// Two causes, both browser rules rather than bugs in the drawing:
//
//  1. Each JPEG button used to draw the QR (await), THEN click a link that was
//     never added to the page. Safari only lets a page start a download while it
//     is still handling the person's click; after an await it no longer counts,
//     so the download was dropped without a word. Firefox also ignores a click on
//     a link that is not in the document.
//  2. "Download all" started one download per table, 250 ms apart. Every browser
//     treats a burst like that as a site spamming files and blocks it after the
//     first one or two.
//
// The fix: draw every table's JPEG as soon as the section opens, so a click only
// has to save a finished file, synchronously, inside the click. And "Download
// all" is ONE file, a PDF with a page per table, ready to print.

import QRCode from 'qrcode';
import { jsPDF } from 'jspdf';

export const QR_W = 800;
export const QR_H = 1000;

/** A safe file name for a table's QR. */
export function qrFileName(label) {
  const base = String(label || 'unknown').replace(/[^a-z0-9-]+/gi, '_').replace(/^_+|_+$/g, '') || 'unknown';
  return `qr-table-${base}.jpg`;
}

/** Draw one labelled table QR and return it as a JPEG data URL. Async (QR encode). */
export async function renderTableQrJpeg({ url, label, footer }) {
  const qrCanvas = document.createElement('canvas');
  await QRCode.toCanvas(qrCanvas, url, { width: 720, margin: 2, errorCorrectionLevel: 'M' });
  const out = document.createElement('canvas');
  out.width = QR_W; out.height = QR_H;
  const ctx = out.getContext('2d');
  // White background, easiest to print.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, QR_W, QR_H);
  ctx.drawImage(qrCanvas, (QR_W - 720) / 2, 60, 720, 720);
  ctx.fillStyle = '#000';
  ctx.textAlign = 'center';
  ctx.font = '700 28px -apple-system, system-ui, sans-serif';
  ctx.fillText('SCAN TO ORDER', QR_W / 2, 830);
  ctx.font = '900 84px -apple-system, system-ui, sans-serif';
  ctx.fillText(`Table ${label || '?'}`, QR_W / 2, 920);
  ctx.font = '500 18px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText(String(footer || ''), QR_W / 2, 970);
  // toDataURL is synchronous, so the finished image can be saved inside a click.
  return out.toDataURL('image/jpeg', 0.92);
}

/**
 * Save a file NOW, synchronously, so it happens inside the click that asked for
 * it. The link is added to the page before the click and removed after, because
 * Firefox ignores a click on a link that is not in the document.
 */
export function saveHref(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 0);
}

/** One PDF, one A4 page per table, the same artwork as the JPEG, centred. Synchronous. */
export function buildQrPdf(items) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const w = 150; const h = w * (QR_H / QR_W);          // 150 x 187.5 mm, keeps the 4:5 artwork
  const x = (210 - w) / 2; const y = (297 - h) / 2;
  items.forEach((it, i) => {
    if (i > 0) doc.addPage();
    doc.addImage(it.dataUrl, 'JPEG', x, y, w, h);
  });
  return doc;
}

/** Save the all-tables PDF inside the click. A blob URL keeps a 50 page file out of a huge data URL. */
export function savePdf(doc, filename) {
  const blob = doc.output('blob');
  const href = URL.createObjectURL(blob);
  saveHref(href, filename);
  // Give the browser time to start reading it before the URL is released.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
