// src/backoffice/sections/website/designer/screenshots.js
//
// 5.12.5: screenshots for the designer (a reference site behind a bot wall, a flyer, a look the
// owner likes). Shrunk in the browser to a 1600 px JPEG so six of them fit one request; the server
// (api/website-designer.js sanitiseImages) drops anything over its caps rather than failing.
export const MAX_SHOTS = 6;
const SHOT_MAX_EDGE = 1600;
export async function shrinkImage(file, { maxEdge = SHOT_MAX_EDGE, quality = 0.82 } = {}) {
  if (!file || !/^image\//.test(file.type || '')) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const cx = canvas.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); // PNG transparency becomes white, not black
    cx.drawImage(bitmap, 0, 0, w, h);
    try { bitmap.close?.(); } catch { /* fine */ }
    const url = canvas.toDataURL('image/jpeg', quality);
    const data = url.split(',')[1] || '';
    if (!data) return null;
    return { name: file.name || 'screenshot', media_type: 'image/jpeg', data, preview: url, bytes: Math.round(data.length * 0.75) };
  } catch {
    return null;
  }
}

