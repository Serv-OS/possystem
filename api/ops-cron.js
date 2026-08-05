/**
 * Restaurant OS — Operations alerts/escalation cron
 *
 * Invoked by Vercel Cron (see vercel.json → crons, every ~5 min). Drives the
 * ops-escalate edge function, which notifies + escalates unacknowledged Operations
 * alerts (temperature breaches, missed checks) via SMS/email per notification rules.
 *
 * Security: Vercel sends `Authorization: Bearer ${CRON_SECRET}` — verified here (fail
 * SECURE), then we call the edge function with a shared OPS_ESCALATE_SECRET so this
 * route never holds the Supabase service-role key.
 *
 * Required Vercel env: CRON_SECRET, OPS_ESCALATE_SECRET (must equal the Supabase edge
 *   secret of the same name). SUPABASE_URL/VITE_SUPABASE_URL already present.
 */
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: 'CRON_SECRET not set on Vercel — refusing to run unauthenticated' });
  if ((req.headers.authorization || '') !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'unauthorised' });

  const runSecret = process.env.OPS_ESCALATE_SECRET;
  if (!runSecret) return res.status(500).json({ error: 'OPS_ESCALATE_SECRET not set on Vercel (must match the Supabase edge secret of the same name)' });

  // No fallback: an unset SUPABASE_URL on a staging/preview project used to silently
  // resolve to the dev Ops database, so a staging cron drove dev data every few minutes
  // with no error anywhere. Fail loudly instead, matching how this route already 500s
  // on a missing run-secret.
  const base = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  if (!base) return res.status(500).json({ error: 'SUPABASE_URL not set on this deployment — refusing to guess which database to drive' });
  try {
    const r = await fetch(`${base}/functions/v1/ops-escalate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-secret': runSecret },
      body: JSON.stringify({}),
    });
    const j = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : 502).json(j);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
