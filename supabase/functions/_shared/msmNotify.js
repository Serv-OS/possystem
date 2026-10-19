// supabase/functions/_shared/msmNotify.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): who hears about a scheduled publish, and in what words
// (design review: "a failed or late scheduled run tells only the venue feed, not the person who
// scheduled it"). Pure, tested (src/lib/msm/msmNotify.test.js). msm-publish sends the emails and
// writes the venue activity feed; a ledger on msm_version_sites (notified) stops a repeat.
//
// EVENTS
//   will_fail   the pre check, 60 minutes before the due time, found a blocking problem
//   failed      a site run failed (with the reason)
//   late        a site run not done 15 minutes after its time
//   done_with_failures   the set finished but at least one site failed
// Each goes to the person who scheduled the set AND every editor of the company.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The message for one event.
 *   kind      'will_fail' | 'failed' | 'late' | 'done_with_failures'
 *   ctx       { title, siteName, words (the reason), when (text), doneCount, siteCount, failedSites: [names] }
 * Returns { subject, text, html, severity }.
 */
export function messageFor(kind, ctx = {}) {
  const title = ctx.title ? `"${ctx.title}"` : 'the menu update';
  const site = ctx.siteName || 'A site';
  let subject, body, severity = 'warning';
  if (kind === 'will_fail') {
    subject = `${site} will not get ${title}`;
    body = `${ctx.words || `${site} will not get ${title}.`} It is due ${ctx.when || 'soon'}. Fix it before then, or open the Multi site menu and press Retry for ${site} afterwards.`;
  } else if (kind === 'failed') {
    severity = 'error';
    subject = `${site} did not get ${title}`;
    body = `${ctx.words || 'The update could not be written.'} Nothing changed at ${site}. Open the Multi site menu and press Retry for ${site} once it is fixed.`;
  } else if (kind === 'late') {
    severity = 'error';
    subject = `${title} is late at ${site}`;
    body = `${title} was due at ${site} ${ctx.when || 'earlier'} and has not run. The usual cause is the msm-publish function not being deployed, or its scheduled job not running. Open the Multi site menu to see where it is.`;
  } else if (kind === 'done_with_failures') {
    subject = `${title} done at ${ctx.doneCount ?? 0} of ${ctx.siteCount ?? 0} sites`;
    body = `${title} is on the tills at ${ctx.doneCount ?? 0} of ${ctx.siteCount ?? 0} sites. Not at: ${(ctx.failedSites || []).join(', ') || 'one site'}. Open the Multi site menu to see why and press Retry.`;
  } else {
    subject = `Multi site menu: ${title}`;
    body = ctx.words || '';
    severity = 'info';
  }
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#0F1211"><p><b>${esc(subject)}</b></p><p>${esc(body)}</p><p style="color:#666;font-size:13px">Sent by ServOS, Multi site menu.</p></div>`;
  return { subject, text: body, html, severity };
}

/** The ledger key for one event at one site, so a run that repeats never sends twice. */
export const notifyKey = (kind) => `${kind}`;

/**
 * Who gets an email: the scheduler and every editor, each address once, real addresses only.
 *   people   [{ user_id, email, role }]  (members of the company, with their emails)
 *   scheduledBy   user id
 */
export function recipients(people, scheduledBy) {
  const out = new Map();
  for (const p of people || []) {
    const email = String(p?.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    if (p.role === 'editor' || p.user_id === scheduledBy) out.set(email, p.user_id);
  }
  return [...out.keys()];
}
