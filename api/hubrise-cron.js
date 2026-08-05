/**
 * Restaurant OS — HubRise reconcile cron
 *
 * Invoked by Vercel Cron (see vercel.json → crons, every minute). Drains each connected
 * venue's PASSIVE HubRise event log (recovering anything the active webhook missed) and
 * retries failed outbound status pushes. The reconcile edge function is idempotent.
 *
 * Security: Vercel sends `Authorization: Bearer ${CRON_SECRET}` on cron invocations — we
 * verify it (fail SECURE), then call the hubrise-reconcile edge function with a shared
 * HUBRISE_RECONCILE_SECRET so this function never holds the Supabase service-role key.
 *
 * Required Vercel env:
 *   CRON_SECRET               — strong random string (Vercel authenticates the cron call)
 *   HUBRISE_RECONCILE_SECRET  — MUST equal the Supabase edge secret of the same name
 *   (SUPABASE_URL or VITE_SUPABASE_URL is already present for the frontend build)
 */
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET not set on Vercel — refusing to run unauthenticated' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorised' });
  }

  const runSecret = process.env.HUBRISE_RECONCILE_SECRET;
  if (!runSecret) {
    return res.status(500).json({ error: 'HUBRISE_RECONCILE_SECRET not set on Vercel (must match the Supabase edge secret of the same name)' });
  }

  // No fallback: an unset SUPABASE_URL on a staging/preview project used to silently
  // resolve to the dev Ops database, so a staging cron drove dev data every few minutes
  // with no error anywhere. Fail loudly instead, matching how this route already 500s
  // on a missing run-secret.
  const base = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  if (!base) return res.status(500).json({ error: 'SUPABASE_URL not set on this deployment — refusing to guess which database to drive' });

  try {
    const r = await fetch(`${base}/functions/v1/hubrise-reconcile`, {
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
