// supabase/functions/_shared/template-resolver.ts
//
// Runtime template resolution for sending functions (gift-fulfill, send-sms,
// send-receipt). Loads the operator's custom template from Platform DB,
// falls back to the default from message-types registry, and substitutes
// merge tags.
//
// Usage in a sending function:
//   import { resolveAndRender } from '../_shared/template-resolver.ts';
//   const rendered = await resolveAndRender(companyId, 'gift_card_delivery', 'email', {
//     sender_name: 'James', recipient_name: 'Emma', amount: '£25.00', ...
//   });
//   // rendered = { subject: '...', body: '...', isCustom: false }

import { platformAdmin } from './gift-card-utils.ts';
import { getMessageType, getDefaultTemplate, type ChannelDefault } from './message-types.ts';

export interface RenderedTemplate {
  subject?: string;
  body: string;
  isCustom: boolean;
}

/**
 * Resolve the template for a given company + message type + channel.
 * 1. Check Platform DB for a custom template
 * 2. Fall back to the default from the message-types registry
 * 3. Substitute merge tags
 */
export async function resolveAndRender(
  companyId: string,
  messageType: string,
  channel: 'email' | 'sms',
  data: Record<string, string>,
): Promise<RenderedTemplate | null> {
  // 1. Try custom template
  const { data: custom } = await platformAdmin
    .from('message_templates')
    .select('subject, body_text, enabled')
    .eq('company_id', companyId)
    .eq('message_type', messageType)
    .eq('channel', channel)
    .maybeSingle();

  if (custom && custom.enabled !== false && custom.body_text) {
    return {
      subject: custom.subject ? substituteTags(custom.subject, data) : undefined,
      body: substituteTags(custom.body_text, data),
      isCustom: true,
    };
  }

  // 2. Fall back to default
  const def = getDefaultTemplate(messageType, channel);
  if (!def) return null;

  return {
    subject: def.subject ? substituteTags(def.subject, data) : undefined,
    body: substituteTags(def.body, data),
    isCustom: false,
  };
}

/**
 * Substitute {{tag}} placeholders with values from the data object.
 * Unmatched tags are left as-is (visible in previews, safe in production).
 */
export function substituteTags(
  template: string,
  data: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    return data[key] !== undefined ? data[key] : `{{${key}}}`;
  });
}

/**
 * Wrap plain text body in a clean branded HTML email shell.
 * Used when sending email templates that are stored as plain text.
 * Converts newlines to <br> and wraps in a responsive email layout.
 */
export function wrapInEmailHtml(
  body: string,
  opts?: { venueName?: string; accentColor?: string },
): string {
  // ServOS Brand v2.0: Signal green accent, Ink header (venues can still pass
  // their own accentColor — the default is the platform brand).
  const accent = opts?.accentColor || '#15C26A';
  const venue = opts?.venueName || '';
  // Convert text to HTML paragraphs
  const htmlBody = body
    .split('\n\n')
    .map(para => `<p style="margin:0 0 16px;color:#5E665E;font-size:14.5px;line-height:1.6;">${para.replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F7F4;font-family:'Space Grotesk',system-ui,-apple-system,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7F4;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid rgba(15,18,17,0.08);">
  ${venue ? `<tr><td style="background:#0F1211;padding:24px;text-align:center;">
    <div style="color:#E9ECEA;font-size:18px;font-weight:700;letter-spacing:-0.02em;">${venue}</div>
  </td></tr>` : ''}
  <tr><td style="padding:28px 24px;">
    ${htmlBody}
  </td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid rgba(15,18,17,0.08);text-align:center;">
    <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:0.16em;color:#9AA39A;">Powered by ServOS &middot; serv-os.app</div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
