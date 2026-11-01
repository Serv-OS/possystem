// src/lib/website/stagedBuild.js
// 5.12.11: the whole site build, in stages. One call to the designer in 'plan' mode (theme, nav,
// footer, seo, posts, and a brief per page), then one 'page' call per planned page. Each call stays
// well inside the server's time limit, and the owner sees "Building page 3 of 7: Menu" instead of a
// spinner that ends in a 504 (Coffee Boy, 1 Nov). Pure apart from the request function, so
// node --test drives it with a stand in. The request function is passed in (designerClient.js pulls
// in the browser Supabase client, which node has no business loading).

/** A chat message that is really "build me a site": long, says build, names pages or a site. */
export function looksLikeSiteBuild(message) {
  const m = String(message || '');
  return m.length >= 600 && /\bbuild\b/i.test(m) && /\b(pages?|website|site)\b/i.test(m) && /\b(home|menu|about|contact)\b/i.test(m);
}

/** Plain lines for the chat after the page steps: what was built, what failed. */
export function summaryLines(plan, results) {
  const built = results.filter((r) => r.ok).map((r) => r.title);
  const failed = results.filter((r) => !r.ok);
  const lines = [];
  if (built.length) lines.push(`Built ${built.length} of ${plan.pages.length} pages: ${built.join(', ')}.`);
  for (const f of failed) lines.push(`The ${f.title} page did not build: ${f.error}. Ask me to build it again, or say what to change.`);
  if (!built.length && !failed.length) lines.push('No pages were planned.');
  return lines;
}

/**
 * Run the staged build. Returns { applied, error, plan, messages, results }.
 *   onStep(text) is called before every call so the UI can show progress.
 */
export async function stagedBuild({ siteId, message, layout = null, images = [], request, onStep = () => {} }) {
  if (typeof request !== 'function') throw new Error('stagedBuild needs a request function');
  onStep('Planning your site…');
  const plan = await request({ site_id: siteId, message, mode: 'plan', layout, ...(images.length ? { images } : {}) });
  if (plan.error) return { applied: false, error: plan.error, plan: null, messages: [`I could not do that: ${plan.error}`], results: [] };
  const pages = Array.isArray(plan.plan?.pages) ? plan.plan.pages : [];
  const messages = [plan.reply || 'Planned your site.'];
  if (!pages.length) return { applied: !!plan.applied, error: '', plan: plan.plan || null, messages: [...messages, 'The plan had no pages, so nothing was built. Tell me which pages you want.'], results: [] };
  const results = [];
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    onStep(`Building page ${i + 1} of ${pages.length}: ${pg.title}`);
    const r = await request({ site_id: siteId, message, mode: 'page', layout, plan: plan.plan, plan_page: pg.slug });
    if (r.error) { results.push({ slug: pg.slug, title: pg.title, ok: false, error: r.error }); continue; }
    if (!r.applied) { results.push({ slug: pg.slug, title: pg.title, ok: false, error: (Array.isArray(r.errors) && r.errors.length ? r.errors.join(' ') : r.reply) || 'nothing was saved' }); continue; }
    results.push({ slug: pg.slug, title: pg.title, ok: true, error: '' });
  }
  const applied = results.some((r) => r.ok);
  const failed = results.filter((r) => !r.ok).length;
  return { applied, error: failed ? `${failed} page${failed === 1 ? '' : 's'} did not build. See the chat.` : '', plan: plan.plan, messages: [...messages, ...summaryLines(plan.plan, results)], results };
}
