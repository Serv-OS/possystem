/**
 * Restaurant OS — Marketing daily cron (slice 4)
 *
 * Invoked by Vercel Cron (see vercel.json → crons, daily 08:00 UTC). Triggers the campaign engine,
 * which runs every active automation campaign for "today" (birthday-within-N-days, lapsed, …). The
 * engine is idempotent, so an accidental double-fire is a no-op.
 *
 * Security: Vercel automatically sends `Authorization: Bearer ${CRON_SECRET}` on cron invocations when
 * CRON_SECRET is set — we verify it so the endpoint can't be triggered by randoms. We then call the
 * marketing-run edge function with a shared MARKETING_RUN_SECRET (so this function never needs the
 * Supabase service-role key).
 *
 * Required Vercel env:
 *   CRON_SECRET           — any strong random string (Vercel uses it to authenticate the cron call)
 *   MARKETING_RUN_SECRET  — MUST equal the Supabase edge secret of the same name
 *   (SUPABASE_URL or VITE_SUPABASE_URL is already present for the frontend build)
 */
export default async function handler(req, res) {
  // Accept Vercel Cron (GET) and manual POST. Fail SECURE: if CRON_SECRET isn't configured, refuse
  // (don't fall open), and otherwise require an exact match. Vercel sends `Authorization: Bearer
  // <CRON_SECRET>` automatically on scheduled invocations.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return res.status(500).json({ error: 'CRON_SECRET not set on Vercel — refusing to run unauthenticated' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorised' });
  }

  const runSecret = process.env.MARKETING_RUN_SECRET;
  if (!runSecret) {
    return res.status(500).json({ error: 'MARKETING_RUN_SECRET not set on Vercel (must match the Supabase edge secret of the same name)' });
  }

  // No fallback: an unset SUPABASE_URL on a staging/preview project used to silently
  // resolve to the dev Ops database, so a staging cron drove dev data every few minutes
  // with no error anywhere. Fail loudly instead, matching how this route already 500s
  // on a missing run-secret.
  const base = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  if (!base) return res.status(500).json({ error: 'SUPABASE_URL not set on this deployment — refusing to guess which database to drive' });

  try {
    const r = await fetch(`${base}/functions/v1/marketing-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-run-secret': runSecret },
      body: JSON.stringify({}),  // today defaults to the engine's UTC date
    });
    const j = await r.json().catch(() => ({}));
    return res.status(r.ok ? 200 : 502).json(j);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
