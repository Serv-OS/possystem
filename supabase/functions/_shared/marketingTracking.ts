// supabase/functions/_shared/marketingTracking.ts (6 Nov 2026, marketing v3)
//
// The Deno half of link tracking: signs each link of one message with the service role key (the
// same key the unsubscribe and preference tokens use) and swaps it into the html. marketing-send
// and the batch sender call trackLinks; marketing-webhook checks the same signature.
import { collectHrefs, wrapTrackedLinks, trackedUrl, campaignDestination, clickSignText, isTrackable } from './marketingLinks.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
export const WEBHOOK_BASE = (Deno.env.get('MARKETING_WEBHOOK_BASE') || `${SUPABASE_URL}/functions/v1/marketing-webhook`).replace(/\/$/, '');
const PREF_BASE = (Deno.env.get('MARKETING_PREF_BASE') || `${SUPABASE_URL}/functions/v1/marketing-preferences`).replace(/\/$/, '');
// Off switch for the whole feature (env MARKETING_LINK_TRACKING=false); on by default.
export const LINK_TRACKING = (Deno.env.get('MARKETING_LINK_TRACKING') || 'true').toLowerCase() !== 'false';

export async function clickToken(messageId: string, url: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SERVICE_ROLE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(clickSignText(messageId, url)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** The html with every trackable link swapped for its signed redirect. Never throws: on any trouble the html is returned as it was. */
export async function trackLinks(html: string, messageId: string, { campaignId = null, workflowId = null }: { campaignId?: string | null; workflowId?: string | null } = {}): Promise<string> {
  if (!LINK_TRACKING || !html || !messageId) return html || '';
  try {
    const hrefs = collectHrefs(html).filter((h: string) => isTrackable(h, [WEBHOOK_BASE, PREF_BASE]));
    if (!hrefs.length) return html;
    const map = new Map<string, string>();
    for (const h of hrefs) {
      const dest = campaignDestination(h, { campaignId: campaignId || workflowId || null, messageId, medium: workflowId && !campaignId ? 'automation' : 'email' });
      map.set(h, trackedUrl(WEBHOOK_BASE, messageId, dest, await clickToken(messageId, dest)));
    }
    return wrapTrackedLinks(html, map);
  } catch (e) {
    console.warn('[marketingTracking] links left untracked:', e instanceof Error ? e.message : String(e));
    return html;
  }
}
