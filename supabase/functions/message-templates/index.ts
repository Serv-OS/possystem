// supabase/functions/message-templates/index.ts
//
// CRUD edge function for message templates. Operators customise the
// wording of every transactional SMS and email their venue sends.
//
// POST body: { action, location_id, ... }
//
// Actions:
//   list            all types with custom template or default merged in
//   save            upsert a custom template for (company, type, channel)
//   reset           delete a custom template, reverting to default
//   preview         render a template with sample merge-tag data
//   service_status  (loyalty_otp) the state of this venue's code text service, read only
//   fix_service     (loyalty_otp) make or repair this venue's code text service
//
// Auth: Ops DB user JWT (resolves company via location_id). Since 22 Oct 2026 (v5.11.94) every
// write, and the two service actions, also need the caller to be a member of staff for the venue
// (a user_locations link, a verified super admin, a Platform company role, or an owner inside
// their own organisation). authenticateCaller only proves a JWT, and anyone gets one with the
// public key: before this, any session with a valid location id could rewrite a venue's messages.
// Deploys to Ops DB project (tbetcegmszzotrwdtqhi), --no-verify-jwt as today.

import {
  cors, json, platformAdmin, opsAdmin,
  authenticateCaller, resolveCompanyForLocation,
} from '../_shared/gift-card-utils.ts';
import { callerIsStaffFor } from '../_shared/loyalty-utils.ts';
import { isVenueWriter } from '../_shared/venueWriter.js';
import {
  MESSAGE_TYPES, CATEGORIES,
  getMessageType, getDefaultTemplate, buildSampleData,
} from '../_shared/message-types.ts';
import { substituteTags, wrapInEmailHtml } from '../_shared/template-resolver.ts';
import { ensureVenueService, recordVenueResult } from '../_shared/otpService.ts';
import { recordable } from '../_shared/otpServiceRules.js';

const STAFF_ACTIONS = new Set(['save', 'reset', 'service_status', 'fix_service']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Authenticate
  const authResult = await authenticateCaller(req);
  if (authResult instanceof Response) return authResult;
  const userId = authResult.user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const action = body.action as string;
  const locationId = body.location_id as string;

  if (!locationId) return json({ error: 'location_id required' }, 400);

  // Resolve company
  const companyResult = await resolveCompanyForLocation(userId, locationId);
  if (companyResult instanceof Response) return companyResult;
  const companyId = companyResult as string;

  // Who may change a venue's messages: staff of that venue (the money functions' rule) or an
  // owner inside their own organisation (the venue settings rule). Never an anonymous session.
  if (STAFF_ACTIONS.has(action)) {
    const user = authResult.user;
    const allowed = (await callerIsStaffFor(user, locationId, companyId)) || (await isVenueWriter(opsAdmin, user, locationId));
    if (!allowed) return json({ error: 'Only staff of this venue can change its messages.' }, 403);
  }

  switch (action) {
    case 'list':
      return handleList(companyId, locationId);
    case 'save':
      return handleSave(companyId, body);
    case 'reset':
      return handleReset(companyId, body);
    case 'preview':
      return handlePreview(companyId, body);
    case 'service_status':
      return handleService(companyId, body, false);
    case 'fix_service':
      return handleService(companyId, body, true);
    default:
      return json({ error: `Unknown action: ${action}` }, 400);
  }
});

// ── THE CODE TEXT SERVICE (22 Oct 2026) ──────────────────────────────────────
// The name in a loyalty code text is the Twilio Verify SERVICE's friendly name, and each venue has
// its own service. ensureVenueService (_shared/otpService.ts) reads what Twilio has, compares it
// with the name this venue should carry (the override saved here, else the venue name), and when
// `fix` is set makes or repairs the service. Back Office shows the answer under Messages >
// Verification code with a Fix button; Save name and Reset below run the same repair.

// What Back Office just saw (a status read, a Fix, a Save, a Reset) is the venue's real state, so
// it goes into the audit table too: the watchdog then clears (or raises) its morning item without
// waiting for the night.
async function venueService(companyId: string, locationId: string, fix: boolean) {
  const service = await ensureVenueService({ ops: opsAdmin, platform: platformAdmin, opsLocationId: locationId, companyId, fix });
  if (recordable(service)) await recordVenueResult(opsAdmin, service, 'staff');
  return service;
}

async function handleService(companyId: string, body: Record<string, unknown>, fix: boolean) {
  const messageType = String(body.message_type || 'loyalty_otp');
  const mt = getMessageType(messageType);
  if (!mt || !mt.nameEditable) return json({ error: `${messageType} has no text service` }, 400);
  const locationId = String(body.location_id || '');
  const service = await venueService(companyId, locationId, fix);
  if (fix) console.log('[message-templates] fix_service', JSON.stringify({ ...service, words: undefined }));
  return json({ ok: true, service });
}

// ── LIST ─────────────────────────────────────────────────────────────────────
// Returns every message type with its channels, merge tags, and either the
// custom template or the built-in default.

async function handleList(companyId: string, locationId: string) {
  // Load all custom templates for this company
  const { data: customs } = await platformAdmin
    .from('message_templates')
    .select('*')
    .eq('company_id', companyId);

  const customMap = new Map<string, any>();
  for (const c of (customs || [])) {
    customMap.set(`${c.message_type}:${c.channel}`, c);
  }

  const result = MESSAGE_TYPES.map(mt => {
    const templates: Record<string, any> = {};

    for (const ch of mt.channels) {
      const custom = customMap.get(`${mt.type}:${ch}`);
      const def = getDefaultTemplate(mt.type, ch);

      if (custom) {
        templates[ch] = {
          id: custom.id,
          subject: custom.subject,
          body_text: custom.body_text,
          enabled: custom.enabled,
          isCustom: true,
          updated_at: custom.updated_at,
        };
      } else {
        templates[ch] = {
          id: null,
          subject: def?.subject || null,
          body_text: def?.body || '',
          enabled: true,
          isCustom: false,
          updated_at: null,
        };
      }

      // Name-editable provider-managed types (e.g. loyalty_otp): the editable value is the
      // business NAME, not the whole body — and it is PER LOCATION (stored under message_type
      // '<type>:<locationId>'). Expose the fixed body separately for the preview, and make
      // body_text hold ONLY this location's name — '' when unset (so the editor shows an empty
      // name field, not the fixed sentence). The legacy company-wide row is ignored here: it's
      // what let one venue's name clobber its sister venues.
      if (mt.nameEditable) {
        const locCustom = customMap.get(`${mt.type}:${locationId}:${ch}`);
        if (locCustom && locCustom.body_text) {
          templates[ch] = {
            id: locCustom.id,
            subject: null,
            body_text: locCustom.body_text,
            enabled: locCustom.enabled,
            isCustom: true,
            updated_at: locCustom.updated_at,
          };
        } else {
          templates[ch].isCustom = false;
          templates[ch].body_text = '';
        }
        templates[ch].fixedBody = def?.body || '';
      }
    }

    return {
      type: mt.type,
      label: mt.label,
      description: mt.description,
      category: mt.category,
      channels: mt.channels,
      mergeTags: mt.mergeTags,
      providerManaged: mt.providerManaged || false,
      providerNote: mt.providerNote || null,
      nameEditable: mt.nameEditable || false,
      nameLabel: mt.nameLabel || null,
      namePlaceholder: mt.namePlaceholder || null,
      templates,
    };
  });

  return json({ ok: true, categories: CATEGORIES, types: result });
}

// ── SAVE ─────────────────────────────────────────────────────────────────────
// Upsert a custom template. If the template text matches the default exactly,
// we still save it (operator explicitly confirmed).

async function handleSave(companyId: string, body: Record<string, unknown>) {
  const messageType = body.message_type as string;
  const channel = body.channel as string;
  const subject = body.subject as string | null;
  const bodyText = body.body_text as string;
  const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true;

  if (!messageType || !channel) {
    return json({ error: 'message_type and channel required' }, 400);
  }
  if (!bodyText) {
    return json({ error: 'body_text required' }, 400);
  }

  const mt = getMessageType(messageType);
  if (!mt) return json({ error: `Unknown message type: ${messageType}` }, 400);
  if (!mt.channels.includes(channel as any)) {
    return json({ error: `Channel ${channel} not supported for ${messageType}` }, 400);
  }
  // Provider-managed types (e.g. verification codes via Twilio Verify) have a fixed body that
  // isn't sent from message_templates. Reject a free-text body save UNLESS the type is
  // nameEditable — in which case body_text carries only the short business name override
  // (read at send time as the Verify friendlyName). Cap it so it can't hold a whole message.
  if (mt.providerManaged && !mt.nameEditable) {
    return json({ error: `${messageType} is managed by our verification service and can’t be edited.` }, 400);
  }
  const cleanBody = mt.nameEditable ? bodyText.trim().slice(0, 30) : bodyText;
  if (mt.nameEditable && !cleanBody) {
    return json({ error: 'Enter a business name, or reset to use your venue name.' }, 400);
  }

  // Name-editable types store PER LOCATION — each venue keeps its own name (a company-wide row
  // let one venue's save clobber its sister venues' verification texts).
  const saveLocationId = body.location_id as string;
  const storageType = mt.nameEditable ? `${messageType}:${saveLocationId}` : messageType;

  const { data, error } = await platformAdmin
    .from('message_templates')
    .upsert(
      {
        company_id: companyId,
        message_type: storageType,
        channel,
        subject: channel === 'email' ? (subject || null) : null,
        body_text: cleanBody,
        enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'company_id,message_type,channel' },
    )
    .select('id')
    .single();

  if (error) {
    console.error('[message-templates] save error:', error);
    return json({ error: `Save failed: ${error.message}` }, 500);
  }

  // Name-editable provider types (loyalty_otp): the name that actually shows in the code SMS is
  // the Twilio Verify SERVICE's friendly name. The saved name goes onto THIS LOCATION's own
  // service now, through the one shared repair: a venue with no service yet gets one made here
  // (22 Oct 2026; it used to wait for the next customer's sign in, and when that failed the code
  // went out under another venue's name). Never the shared fallback or another venue's service.
  if (mt.nameEditable) {
    const service = await venueService(companyId, saveLocationId, true);
    if (!service.ok) {
      console.error('[message-templates] text service not ready after save:', JSON.stringify({ ...service, words: undefined }));
      return json({ error: `Name saved, but the text service is not ready: ${service.words} Try again.`, service }, 502);
    }
    return json({ ok: true, id: data.id, service });
  }

  return json({ ok: true, id: data.id });
}

// ── RESET ────────────────────────────────────────────────────────────────────
// Delete the custom template, reverting to the built-in default.

async function handleReset(companyId: string, body: Record<string, unknown>) {
  const messageType = body.message_type as string;
  const channel = body.channel as string;

  if (!messageType || !channel) {
    return json({ error: 'message_type and channel required' }, 400);
  }
  // Only registered types are resettable — protects hidden config rows (loyalty_otp_service).
  const mt = getMessageType(messageType);
  if (!mt) {
    return json({ error: `Unknown message type: ${messageType}` }, 400);
  }

  // Name-editable types store per location — delete this location's row only.
  const locationId = body.location_id as string;
  const storageType = mt.nameEditable ? `${messageType}:${locationId}` : messageType;

  const { error } = await platformAdmin
    .from('message_templates')
    .delete()
    .eq('company_id', companyId)
    .eq('message_type', storageType)
    .eq('channel', channel);

  if (error) {
    console.error('[message-templates] reset error:', error);
    return json({ error: `Reset failed: ${error.message}` }, 500);
  }

  // Name-editable provider types: "reset" means "use the venue name". The same repair as save puts
  // the venue name onto THIS LOCATION's own Twilio Verify service (made here when it has none).
  // Never the shared fallback service. The reset stands whatever Twilio says; the answer says it.
  if (mt.nameEditable) {
    const service = await venueService(companyId, locationId, true);
    if (!service.ok) console.error('[message-templates] text service not ready after reset:', JSON.stringify({ ...service, words: undefined }));
    return json({ ok: true, service });
  }

  return json({ ok: true });
}

// ── PREVIEW ──────────────────────────────────────────────────────────────────
// Render a template with sample data for live preview in the back office.

async function handlePreview(companyId: string, body: Record<string, unknown>) {
  const messageType = body.message_type as string;
  const channel = body.channel as string;
  const bodyText = body.body_text as string;
  const subject = body.subject as string | null;
  // Allow custom preview data or use defaults
  const customData = body.preview_data as Record<string, string> | null;

  if (!messageType || !channel || !bodyText) {
    return json({ error: 'message_type, channel, and body_text required' }, 400);
  }

  const mt = getMessageType(messageType);
  if (!mt) return json({ error: `Unknown message type: ${messageType}` }, 400);

  const sampleData = customData || buildSampleData(mt.mergeTags);

  const renderedBody = substituteTags(bodyText, sampleData);
  const renderedSubject = subject ? substituteTags(subject, sampleData) : null;

  // For email, also generate the full HTML preview
  let html: string | null = null;
  if (channel === 'email') {
    // Try to resolve venue name for the HTML wrapper
    let venueName = sampleData.venue_name || '';
    try {
      const { data: loc } = await platformAdmin
        .from('locations')
        .select('name')
        .eq('company_id', companyId)
        .limit(1)
        .maybeSingle();
      if (loc?.name) venueName = loc.name;
    } catch { /* use sample */ }

    html = wrapInEmailHtml(renderedBody, { venueName });
  }

  return json({
    ok: true,
    preview: {
      subject: renderedSubject,
      body: renderedBody,
      html,
      channel,
    },
  });
}
