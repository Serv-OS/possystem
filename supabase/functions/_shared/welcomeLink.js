// welcomeLink.js: the pure half of the loyalty welcome (v5.9.85), shared by send-welcome (Deno)
// and its node tests.
//
// Peter, 27 Sep 2026 (a real welcome text): "Hi Peter! Welcome to our venue! ... View your
// account:" with nothing after it. send-welcome read online_slug from the OPS locations table,
// where that column does not exist, so the whole read failed: no venue name ("our venue") and no
// portal link. The slug lives on PLATFORM locations (Leeds: coffee-boy-leeds).

/** The portal register link for a venue slug, or '' when there is no slug. */
export function welcomePortalUrl(slug, domain = 'serv-os.app') {
  const s = String(slug || '').trim().toLowerCase();
  if (!s || !/^[a-z0-9-]+$/.test(s)) return '';
  return `https://${s}.${String(domain || 'serv-os.app').trim()}/account/register`;
}

/**
 * A rendered message with an empty link never ends on a dangling "View your account:". A line that
 * is only a label and a colon (after the link was left blank) is dropped, and blank lines are
 * squeezed. A message with the link is returned exactly as it was.
 */
export function dropEmptyLinkLines(text) {
  const lines = String(text ?? '').split('\n');
  const kept = lines.filter((l) => !/^\s*[A-Za-z][^:\n]{0,60}:\s*$/.test(l));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

/** The venue name to greet with: the Ops name, else the Platform name, else a neutral phrase. */
export function welcomeVenueName(opsName, platformName) {
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').replace(/\s+-\s+/g, ' ').trim();
  return clean(opsName) || clean(platformName) || 'us';
}
