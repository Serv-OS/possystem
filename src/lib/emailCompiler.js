// src/lib/emailCompiler.js — slice 5 email builder.
// Compiles the block list authored in the Back Office into a single responsive HTML email (inline
// styles, ~600px centred container — the lowest-common-denominator that renders across email clients).
// Merge tags ({{first_name}} etc.) are left intact in the output; marketing-send renders them per
// recipient at send time. A small client-side merge renderer powers the live preview.

const esc = (s) => String(s == null ? '' : s);

function blockHtml(b) {
  switch (b?.type) {
    case 'heading':
      return `<h1 style="font-size:24px;line-height:1.3;font-weight:800;margin:0 0 16px;color:#111111;">${esc(b.text)}</h1>`;
    case 'text':
      return `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;color:#333333;">${esc(b.text).replace(/\n/g, '<br>')}</p>`;
    case 'button': {
      const align = b.align === 'center' ? 'center' : b.align === 'right' ? 'right' : 'left';
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;${align === 'center' ? 'margin-left:auto;margin-right:auto;' : align === 'right' ? 'margin-left:auto;' : ''}"><tr><td style="border-radius:8px;background:${esc(b.color || '#111111')};"><a href="${esc(b.url || '#')}" style="display:inline-block;padding:12px 26px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;border-radius:8px;">${esc(b.text || 'Click here')}</a></td></tr></table>`;
    }
    case 'image':
      return b.url ? `<img src="${esc(b.url)}" alt="${esc(b.alt || '')}" style="max-width:100%;height:auto;border-radius:8px;margin:0 0 16px;display:block;" />` : '';
    case 'divider':
      return `<hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0;" />`;
    case 'spacer':
      return `<div style="height:${Number(b.size) || 16}px;line-height:${Number(b.size) || 16}px;font-size:1px;">&nbsp;</div>`;
    case 'html':
      return b.html || '';
    default:
      return '';
  }
}

export function compileEmail(blocks) {
  const inner = (blocks || []).map(blockHtml).join('\n      ');
  return `<div style="margin:0;padding:0;background:#f4f4f5;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;background:#ffffff;border-radius:12px;">
      ${inner}
  </div>
</div>`;
}

// Light, dependency-free merge renderer for the live PREVIEW only (mirrors _shared/marketing-merge.ts).
export function renderMergePreview(tpl, ctx) {
  return String(tpl || '').replace(/\{\{\s*([a-z0-9_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi, (_m, key, fallback) => {
    const v = ctx[String(key).toLowerCase()];
    return (v === undefined || v === null || v === '') ? (fallback !== undefined ? fallback : '') : String(v);
  });
}

// Sample data used to render the preview / a test send.
export const SAMPLE_MERGE = { first_name: 'Sam', last_name: 'Patel', name: 'Sam Patel', email: 'sam@example.com', phone: '+447700900123', promo_code: 'BDAY-7F3K9', offer: '£5 off' };

export const MERGE_TAGS = [
  ['{{first_name}}', 'First name'],
  ['{{name}}', 'Full name'],
  ['{{promo_code}}', 'Promo code'],
  ['{{offer}}', 'Offer label'],
];

export const STARTER_BLOCKS = () => ([
  { type: 'heading', text: 'Happy birthday, {{first_name}}! 🎂' },
  { type: 'text', text: 'Thanks for being one of our regulars. Here\'s a little treat from us.' },
  { type: 'text', text: 'Show this code in store: {{promo_code}} ({{offer}})' },
  { type: 'button', text: 'See the menu', url: 'https://', align: 'left' },
]);
