// send-sms — Twilio SMS dispatcher for transactional messages.
//
// Sends SMS via Twilio REST API. Used for:
//   - Order ready for collection
//   - Order status updates
//   - Gift card delivery (alternative to email)
//   - Table-ready notifications
//
// Body: {
//   to:           string   — E.164 phone number (e.g. "+447700900123")
//   message:      string   — SMS body text (max 1600 chars, auto-segmented)
//   location_id:  string   — for audit trail
//   type?:        string   — 'order_ready' | 'gift_card' | 'status_update' | 'custom'
//   reference_id?: string  — order/card/check id for linking
// }
//
// Required secrets:
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER   — E.164 format, e.g. "+447576584620"
//
// Deploys to Ops DB project (tbetcegmszzotrwdtqhi).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const FROM_NUMBER = Deno.env.get('TWILIO_FROM_NUMBER') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

interface SmsRequest {
  to: string;
  message: string;
  location_id: string;
  type?: string;
  reference_id?: string;
}

// Caller must be authenticated: the service-role key (internal edge-fn calls)
// or a valid signed-in Supabase user (back office / paired POS session). Closes
// the open relay — previously anyone could POST here and burn the venue's Twilio
// balance / spam its customers.
async function authorize(req: Request): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
  if (!token) return false;
  if (token === SERVICE_ROLE) return true;
  try { const { data: { user } } = await sb.auth.getUser(token); return !!user; } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!(await authorize(req))) return json({ error: 'unauthorized' }, 401);

  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
    return json({ error: 'Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER' }, 500);
  }

  let body: SmsRequest;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }

  if (!body?.to || !body?.message || !body?.location_id) {
    return json({ error: 'missing required fields: to, message, location_id' }, 400);
  }

  // Validate E.164 format
  const phone = body.to.replace(/\s/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    return json({ error: 'invalid phone number — must be E.164 format (e.g. +447700900123)' }, 400);
  }

  // Truncate message to Twilio max (1600 chars)
  const message = body.message.slice(0, 1600);

  // Insert audit row
  const { data: row, error: insertErr } = await sb
    .from('sms_messages')
    .insert({
      location_id: body.location_id,
      to_number: phone,
      from_number: FROM_NUMBER,
      message,
      type: body.type || 'custom',
      reference_id: body.reference_id || null,
      status: 'pending',
    })
    .select('id')
    .single();

  // If the sms_messages table doesn't exist yet, still send the SMS
  const auditId = row?.id || null;
  if (insertErr && !insertErr.message.includes('does not exist')) {
    console.error('[send-sms] audit insert error:', insertErr);
  }

  try {
    // Call Twilio REST API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
    const formData = new URLSearchParams();
    formData.append('To', phone);
    formData.append('From', FROM_NUMBER);
    formData.append('Body', message);

    const res = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const result = await res.json();

    if (!res.ok) {
      const errorMsg = result?.message || `Twilio HTTP ${res.status}`;
      if (auditId) {
        await sb.from('sms_messages').update({
          status: 'failed',
          error: errorMsg,
        }).eq('id', auditId);
      }
      return json({ error: `SMS send failed: ${errorMsg}`, id: auditId }, 502);
    }

    // Update audit row with success
    if (auditId) {
      await sb.from('sms_messages').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        provider_message_id: result.sid || null,
        segments: result.num_segments ? parseInt(result.num_segments) : null,
      }).eq('id', auditId);
    }

    return json({
      ok: true,
      id: auditId,
      twilio_sid: result.sid,
      segments: result.num_segments,
    });
  } catch (e) {
    if (auditId) {
      await sb.from('sms_messages').update({
        status: 'failed',
        error: (e as Error)?.message || String(e),
      }).eq('id', auditId);
    }
    return json({ error: `SMS send error: ${(e as Error)?.message || e}`, id: auditId }, 502);
  }
});
