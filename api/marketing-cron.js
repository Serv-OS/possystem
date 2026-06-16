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
  // Accept Vercel Cron (GET) and manual POST.
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorised' });
  }

  const runSecret = process.env.MARKETING_RUN_SECRET;
  if (!runSecret) {
    return res.status(500).json({ error: 'MARKETING_RUN_SECRET not set on Vercel (must match the Supabase edge secret of the same name)' });
  }

  const base = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://tbetcegmszzotrwdtqhi.supabase.co').replace(/\/$/, '');

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
