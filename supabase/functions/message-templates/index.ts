// supabase/functions/message-templates/index.ts
//
// CRUD edge function for message templates. Operators customise the
// wording of every transactional SMS and email their venue sends.
//
// POST body: { action, location_id, ... }
//
// Actions:
//   list     — all types with custom template or default merged in
//   save     — upsert a custom template for (company, type, channel)
//   reset    — delete a custom template, reverting to default
//   preview  — render a template with sample merge-tag data
//
// Auth: Ops DB user JWT (resolves company via location_id).
// Deploys to Ops DB project (tbetcegmszzotrwdtqhi).

import {
  cors, json, platformAdmin,
  authenticateCaller, resolveCompanyForLocation,
} from '../_shared/gift-card-utils.ts';
import {
  MESSAGE_TYPES, CATEGORIES,
  getMessageType, getDefaultTemplate, buildSampleData,
} from '../_shared/message-types.ts';
import { substituteTags, wrapInEmailHtml } from '../_shared/template-resolver.ts';

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

  switch (action) {
    case 'list':
      return handleList(companyId);
    case 'save':
      return handleSave(companyId, body);
    case 'reset':
      return handleReset(companyId, body);
    case 'preview':
      return handlePreview(companyId, body);
    default:
      return json({ error: `Unknown action: ${action}` }, 400);
  }
});

// ── LIST ─────────────────────────────────────────────────────────────────────
// Returns every message type with its channels, merge tags, and either the
// custom template or the built-in default.

async function handleList(companyId: string) {
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
  // Provider-managed types (e.g. verification codes via Twilio Verify) have a fixed body
  // that isn't sent from message_templates — reject saves so we never persist a dead custom row.
  if (mt.providerManaged) {
    return json({ error: `${messageType} is managed by our verification service and can’t be edited.` }, 400);
  }

  const { data, error } = await platformAdmin
    .from('message_templates')
    .upsert(
      {
        company_id: companyId,
        message_type: messageType,
        channel,
        subject: channel === 'email' ? (subject || null) : null,
        body_text: bodyText,
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

  const { error } = await platformAdmin
    .from('message_templates')
    .delete()
    .eq('company_id', companyId)
    .eq('message_type', messageType)
    .eq('channel', channel);

  if (error) {
    console.error('[message-templates] reset error:', error);
    return json({ error: `Reset failed: ${error.message}` }, 500);
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
