// src/lib/emailCompiler.js — visual email builder (v2).
// Compiles the block list into a responsive HTML email with inline styles (max compatibility).
// Email-level design (page/card background, width, font, header logo + colour, brand colour) is carried
// in a special block `{ type:'settings', ... }` kept at index 0 — so the whole design travels inside
// `email_blocks` and flows through campaigns / quick-send / workflow steps with no extra columns.
// Per-block styling: bgColor (section background), pad (padding px), align, textColor. Merge tags are
// left intact for send-time rendering; a tiny client renderer powers the live preview.

const esc = (s) => String(s == null ? '' : s);

export const DEFAULT_SETTINGS = {
  pageBg: '#f4f4f5', cardBg: '#ffffff', width: 600,
  font: 'Arial, Helvetica, sans-serif',
  headerLogo: '', headerBg: '', brandColor: '#111111',
};

export const FONTS = [
  ['Arial, Helvetica, sans-serif', 'Arial'],
  ['Georgia, "Times New Roman", serif', 'Georgia'],
  ['"Trebuchet MS", Helvetica, sans-serif', 'Trebuchet'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
  ['"Courier New", monospace', 'Courier'],
];

const padOf = (b) => (b.pad != null ? Number(b.pad) : (b.type === 'spacer' || b.type === 'divider' || b.type === 'html' ? 0 : 16));

function blockInner(b, settings) {
  const align = b.align || 'left';
  switch (b.type) {
    case 'heading':
      return `<h1 style="margin:0;font-size:${Number(b.fontSize) || 24}px;line-height:1.3;font-weight:800;color:${b.textColor || '#111111'};font-family:inherit">${esc(b.text)}</h1>`;
    case 'text':
      return `<p style="margin:0;font-size:${Number(b.fontSize) || 15}px;line-height:1.6;color:${b.textColor || '#333333'};font-family:inherit">${esc(b.text).replace(/\n/g, '<br>')}</p>`;
    case 'button': {
      const wrapAlign = align === 'center' ? 'margin:0 auto;' : align === 'right' ? 'margin-left:auto;' : '';
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${wrapAlign}"><tr><td style="border-radius:${b.radius != null ? Number(b.radius) : 8}px;background:${b.color || settings.brandColor}"><a href="${esc(b.url || '#')}" style="display:inline-block;padding:12px 26px;color:${b.fontColor || '#ffffff'};text-decoration:none;font-weight:700;font-size:15px;font-family:inherit;border-radius:${b.radius != null ? Number(b.radius) : 8}px">${esc(b.text || 'Click here')}</a></td></tr></table>`;
    }
    case 'image':
      return b.url ? `<img src="${esc(b.url)}" alt="${esc(b.alt || '')}" style="max-width:100%;height:auto;border-radius:${b.radius != null ? Number(b.radius) : 8}px;display:block;${align === 'center' ? 'margin:0 auto;' : align === 'right' ? 'margin-left:auto;' : ''}" />` : '';
    case 'divider':
      return `<hr style="border:none;border-top:1px solid ${b.color || '#e5e5e5'};margin:0" />`;
    case 'spacer':
      return `<div style="height:${Number(b.size) || 16}px;line-height:${Number(b.size) || 16}px;font-size:1px">&nbsp;</div>`;
    case 'html':
      return b.html || '';
    default:
      return '';
  }
}

function blockHtml(b, settings) {
  const inner = blockInner(b, settings);
  if (!inner) return '';
  const pad = padOf(b);
  const bg = b.bgColor ? `background:${b.bgColor};` : '';
  return `<div style="${bg}padding:${pad}px;text-align:${b.align || 'left'}">${inner}</div>`;
}

export function compileEmail(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const settings = { ...DEFAULT_SETTINGS, ...(list.find((b) => b && b.type === 'settings') || {}) };
  const content = list.filter((b) => b && b.type !== 'settings');
  const header = settings.headerLogo
    ? `<div style="text-align:center;padding:18px 16px;background:${settings.headerBg || settings.cardBg}"><img src="${esc(settings.headerLogo)}" alt="" style="max-height:60px;max-width:70%;display:inline-block" /></div>`
    : '';
  const inner = content.map((b) => blockHtml(b, settings)).join('\n      ');
  return `<div style="margin:0;padding:24px 0;background:${settings.pageBg}">
  <div style="max-width:${Number(settings.width) || 600}px;margin:0 auto;font-family:${settings.font};color:#1a1a1a;background:${settings.cardBg};border-radius:12px;overflow:hidden">
    ${header}
      ${inner}
  </div>
</div>`;
}

// Light merge renderer for the live PREVIEW only (mirrors _shared/marketing-merge.ts).
export function renderMergePreview(tpl, ctx) {
  return String(tpl || '').replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi, (_m, key, fallback) => {
    const v = ctx[String(key).toLowerCase()];
    return (v === undefined || v === null || v === '') ? (fallback !== undefined ? fallback : '') : String(v);
  });
}

export const SAMPLE_MERGE = { first_name: 'Sam', last_name: 'Patel', name: 'Sam Patel', email: 'sam@example.com', phone: '+447700900123', promo_code: 'BDAY-7F3K9', offer: '£5 off' };

export const MERGE_TAGS = [
  ['{{first_name}}', 'First name'],
  ['{{name}}', 'Full name'],
  ['{{promo_code}}', 'Promo code'],
  ['{{offer}}', 'Offer label'],
];

export const STARTER_BLOCKS = () => ([
  { type: 'settings', ...DEFAULT_SETTINGS },
  { type: 'heading', text: 'Happy birthday, {{first_name}}! 🎂', align: 'center' },
  { type: 'text', text: 'Thanks for being one of our regulars. Here\'s a little treat from us.', align: 'center' },
  { type: 'text', text: 'Show this code in store: {{promo_code}} ({{offer}})', align: 'center', bgColor: '#f7f7f9' },
  { type: 'button', text: 'See the menu', url: 'https://', align: 'center' },
]);
