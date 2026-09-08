/**
 * Receipt rasterisation helpers — turn URLs and strings into ESC/POS bytes.
 *
 * Two outputs:
 *
 *   1. imageUrlToEscPosRaster(url, targetWidthDots)
 *      Fetches an image URL, rescales to targetWidthDots, converts to
 *      monochrome with Floyd-Steinberg dithering, and emits a GS v 0
 *      raster-bit-image sequence ready to append to a print buffer.
 *
 *   2. qrTextToEscPosBytes(text, moduleSize, errorCorrection)
 *      Emits the native ESC/POS QR-code command sequence (GS ( k).
 *      Printers that support GS v 0 rasters almost all support GS ( k QR,
 *      and the native command produces a far crisper QR than a rasterised
 *      image at 80mm paper widths.
 *
 * Both helpers return Uint8Array so the caller can either spread them into
 * an EscPosBuilder byte list or concatenate directly.
 */

// ───────────────────────────────────────────────────────────────────────────
// Low-level: GS v 0 raster image
// ───────────────────────────────────────────────────────────────────────────

const GS = 0x1d;

/**
 * Build a GS v 0 raster-image ESC/POS sequence from 1bpp packed pixel data.
 *
 * @param {Uint8Array} bits - Packed monochrome pixels, row-major, MSB=leftmost.
 *                             Each row is (widthDots+7)>>3 bytes. 1=black, 0=white.
 * @param {number} widthDots
 * @param {number} heightDots
 * @returns {Uint8Array}
 */
export function buildGsV0(bits, widthDots, heightDots) {
  const widthBytes = (widthDots + 7) >> 3;
  const xL = widthBytes & 0xff, xH = (widthBytes >> 8) & 0xff;
  const yL = heightDots & 0xff, yH = (heightDots >> 8) & 0xff;
  const header = [GS, 0x76, 0x30, 0x00, xL, xH, yL, yH];
  const out = new Uint8Array(header.length + bits.length);
  out.set(header, 0);
  out.set(bits, header.length);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// High-level: image URL → raster bytes with dithering
// ───────────────────────────────────────────────────────────────────────────

async function loadImage(url, timeoutMs = 2000) {
  // Cross-origin logos should work because Supabase Storage bucket is public
  // and sends CORS headers. If you switch to signed URLs, the bucket's
  // CORS policy needs to include the site origin.
  // v5.5.560: hard timeout — a slow/unreachable CDN must never stall the receipt build.
  // Callers wrap this in try/catch and skip the logo/QR on failure, so a timeout just
  // means a logo-less receipt instead of a hung print.
  return new Promise((resolve, reject) => {
    const img = new Image();
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => finish(reject, new Error(`Image load timed out: ${url}`)), timeoutMs);
    img.crossOrigin = 'anonymous';
    img.onload = () => finish(resolve, img);
    img.onerror = () => finish(reject, new Error(`Image load failed: ${url}`));
    img.src = url;
  });
}

/**
 * Rasterise an image URL to an ESC/POS GS v 0 byte sequence.
 *
 * @param {string} url
 * @param {number} targetWidthDots  (must be a multiple of 8; otherwise it's
 *                                   rounded up silently)
 * @returns {Promise<Uint8Array>}
 */
export async function imageUrlToEscPosRaster(url, targetWidthDots = 384) {
  if (typeof document === 'undefined') {
    throw new Error('imageUrlToEscPosRaster requires a DOM (canvas)');
  }
  const widthDots = ((targetWidthDots + 7) >> 3) << 3; // round up to byte
  const img = await loadImage(url);
  const ratio = img.height / img.width;
  const heightDots = Math.max(1, Math.round(widthDots * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = widthDots;
  canvas.height = heightDots;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, widthDots, heightDots);
  ctx.drawImage(img, 0, 0, widthDots, heightDots);
  const imgData = ctx.getImageData(0, 0, widthDots, heightDots);

  // Floyd-Steinberg dither to 1bpp. Work on a Float grayscale grid.
  const gray = new Float32Array(widthDots * heightDots);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    const r = imgData.data[i], g = imgData.data[i+1], b = imgData.data[i+2], a = imgData.data[i+3];
    // Composite onto white for alpha
    const alpha = a / 255;
    const rr = r * alpha + 255 * (1 - alpha);
    const gg = g * alpha + 255 * (1 - alpha);
    const bb = b * alpha + 255 * (1 - alpha);
    // Rec. 601 luma
    gray[j] = 0.299 * rr + 0.587 * gg + 0.114 * bb;
  }

  const bits = new Uint8Array(((widthDots + 7) >> 3) * heightDots);
  const rowBytes = (widthDots + 7) >> 3;
  for (let y = 0; y < heightDots; y++) {
    for (let x = 0; x < widthDots; x++) {
      const idx = y * widthDots + x;
      const old = gray[idx];
      const newV = old < 128 ? 0 : 255;
      const err = old - newV;
      if (newV === 0) {
        // mark bit (1 = black)
        bits[y * rowBytes + (x >> 3)] |= (0x80 >> (x & 7));
      }
      // Distribute error (Floyd-Steinberg)
      if (x + 1 < widthDots)                          gray[idx + 1]                += err * 7 / 16;
      if (y + 1 < heightDots && x > 0)                gray[idx + widthDots - 1]    += err * 3 / 16;
      if (y + 1 < heightDots)                         gray[idx + widthDots]        += err * 5 / 16;
      if (y + 1 < heightDots && x + 1 < widthDots)    gray[idx + widthDots + 1]    += err * 1 / 16;
    }
  }

  return buildGsV0(bits, widthDots, heightDots);
}

// ───────────────────────────────────────────────────────────────────────────
// ESC/POS native QR code (GS ( k — Model 2)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Emit a native ESC/POS QR-code byte sequence. Supported by all Sunmi,
 * Epson TM-series, and Star TSP-series printers.
 *
 * @param {string} text - QR payload (URL, text, etc.). Max ~7000 chars.
 * @param {number} moduleSize - Dot size per QR module, 1-16. Default 6 gives
 *                               a ~25mm QR on 80mm paper.
 * @param {'L'|'M'|'Q'|'H'} errorCorrection - Default 'M' (15% redundancy).
 * @returns {Uint8Array}
 */
export function qrTextToEscPosBytes(text, moduleSize = 6, errorCorrection = 'M') {
  const ecMap = { L: 48, M: 49, Q: 50, H: 51 };
  const ec = ecMap[errorCorrection] ?? 49;
  const size = Math.max(1, Math.min(16, moduleSize | 0));

  // Select QR model (Model 2)
  const setModel     = [GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00];
  // Set module (dot) size
  const setSize      = [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size];
  // Set error-correction level
  const setEC        = [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, ec];
  // Store data in symbol buffer
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);
  const dataLen = textBytes.length + 3;
  const pL = dataLen & 0xff, pH = (dataLen >> 8) & 0xff;
  const storeHeader  = [GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30];
  // Print symbol from buffer
  const printSymbol  = [GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30];

  const parts = [setModel, setSize, setEC, storeHeader, textBytes, printSymbol];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    if (p instanceof Uint8Array) out.set(p, o); else out.set(p, o);
    o += p.length;
  }
  return out;
}
