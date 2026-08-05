/**
 * Restaurant OS — Catering scheduled-fire safety net
 *
 * MANUAL / EMERGENCY TRIGGER ONLY. The Vercel cron was removed in v5.5.974 (it never
 * ran — Production-only), replaced by the pg_cron job `catering-release-5min` in the
 * Ops DB. Drives the catering-release edge
 * function, which (server-side, no device dependency) fires any catering pre-order whose
 * kitchen fire time has passed but that no POS device fired — claiming the order and
 * dropping a KDS ticket so the kitchen always sees it.
 *
 * Security: Vercel sends `Authorization: Bearer ${CRON_SECRET}` — verified here (fail
 * SECURE), then we call the edge function with a shared CATERING_RELEASE_SECRET so this
 * route never holds the Supabase service-role key.
 *
 * Required Vercel env: CRON_SECRET, CATERING_RELEASE_SECRET (must equal the Supabase edge
 *   secret of the same name). SUPABASE_URL/VITE_SUPABASE_URL already present.
 */
export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: 'CRON_SECRET not set on Vercel — refusing to run unauthenticated' });
  if ((req.headers.authorization || '') !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'unauthorised' });

  const runSecret = process.env.CATERING_RELEASE_SECRET;
  if (!runSecret) return res.status(500).json({ error: 'CATERING_RELEASE_SECRET not set on Vercel (must match the Supabase edge secret of the same name)' });

  // No fallback: an unset SUPABASE_URL on a staging/preview project used to silently
  // resolve to the dev Ops database, so a staging cron drove dev data every few minutes
  // with no error anywhere. Fail loudly instead, matching how this route already 500s
  // on a missing run-secret.
  const base = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  if (!base) return res.status(500).json({ error: 'SUPABASE_URL not set on this deployment — refusing to guess which database to drive' });
  try {
    const r = await fetch(`${base}/functions/v1/catering-release`, {
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
