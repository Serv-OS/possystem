// _shared/segments-prebuilt.ts — the prebuilt audience catalogue, shared by marketing-segments,
// marketing-campaigns and marketing-workflows so the prebuilt audiences are selectable in EVERY
// segment picker (not just the Segments page). Picking a prebuilt in a campaign/workflow stores the
// ref "prebuilt:<key>"; resolveSegmentRef() find-or-creates a real segment row on save, so the engine
// keeps resolving a normal segment id (no engine change).

export const PREBUILT = [
  { key: 'vips', name: 'VIPs', description: 'Top spenders by lifetime revenue', icon: '💎', definition: { match: 'all', rules: [{ field: 'lifetime_revenue', op: 'gte', value: 250 }] } },
  { key: 'regulars', name: 'Regulars', description: 'Frequent visitors', icon: '🔁', definition: { match: 'all', rules: [{ field: 'visit_count', op: 'gte', value: 5 }] } },
  { key: 'new_customers', name: 'New customers', description: 'Joined in the last 30 days', icon: '🌱', definition: { match: 'all', rules: [{ field: 'signed_up_days', op: 'lte', value: 30 }] } },
  { key: 'lapsed_30', name: 'At risk (30d)', description: 'No visit in 30+ days', icon: '⏳', definition: { match: 'all', rules: [{ field: 'days_since_visit', op: 'gte', value: 30 }] } },
  { key: 'lapsed_90', name: 'Lapsed (90d)', description: 'No visit in 90+ days', icon: '💤', definition: { match: 'all', rules: [{ field: 'days_since_visit', op: 'gte', value: 90 }] } },
  { key: 'birthdays_7', name: 'Birthdays this week', description: 'Birthday within 7 days', icon: '🎂', definition: { match: 'all', rules: [{ field: 'birthday_in_days', op: 'gte', value: 0 }, { field: 'birthday_in_days', op: 'lte', value: 7 }] } },
  { key: 'birthdays_30', name: 'Birthdays this month', description: 'Birthday within 30 days', icon: '🎈', definition: { match: 'all', rules: [{ field: 'birthday_in_days', op: 'gte', value: 0 }, { field: 'birthday_in_days', op: 'lte', value: 30 }] } },
  { key: 'email_optin', name: 'Email subscribers', description: 'Has email + opted in to marketing', icon: '✉️', definition: { match: 'all', rules: [{ field: 'has_email', op: 'is_true' }, { field: 'marketing_opt_in', op: 'is_true' }] } },
  { key: 'sms_optin', name: 'SMS subscribers', description: 'Has mobile + opted in to marketing', icon: '📱', definition: { match: 'all', rules: [{ field: 'has_phone', op: 'is_true' }, { field: 'marketing_opt_in', op: 'is_true' }] } },
];

// Resolve a segment reference to a real segments.id. Accepts: null/'' → null; an existing uuid → as-is;
// "prebuilt:<key>" → find-or-create a persisted segment for that prebuilt audience and return its id.
export async function resolveSegmentRef(sb: any, org_id: string, ref: unknown): Promise<string | null> {
  if (!ref) return null;
  const s = String(ref);
  if (!s.startsWith('prebuilt:')) return s;             // already a real segment id
  const key = s.slice('prebuilt:'.length);
  const pb = PREBUILT.find((p) => p.key === key);
  if (!pb) return null;
  const { data: existing } = await sb.from('segments').select('id').eq('org_id', org_id).eq('prebuilt_key', key).maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await sb.from('segments')
    .insert({ org_id, name: pb.name, description: pb.description, kind: 'prebuilt', prebuilt_key: key, definition: pb.definition, active: true })
    .select('id').maybeSingle();
  return created?.id ?? null;
}
