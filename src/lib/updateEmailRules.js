// src/lib/updateEmailRules.js: email an update to Back Office logins, the app side rules.
//
// WHY (Peter, 8 Oct 2026): he writes a what's new email for clients each week. "Do we have a way
// to email it to people that are registered in the back office?"
//
// Pure helpers only (no Supabase, no window, no React). The rules the server also needs (the
// draft check, the Markdown renderer, who gets it, the Sent list rollup) live in
// supabase/functions/_shared/updateEmailRules.js and are re-exported here, so the preview on the
// Company Admin screen is rendered by the very function that renders the email that is sent.

export * from '../../supabase/functions/_shared/updateEmailRules.js';

/** A database that has not had 20261008b yet: the table is not there. */
export function isMissingUpdateEmails(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42P01' || code === 'PGRST205') return true;
  const msg = String(error.message || error.hint || '');
  return /update_emails/i.test(msg) && /(does not exist|could not find|schema cache)/i.test(msg);
}

/** Shown on the admin screen while the database update or the function is missing. */
export const NEEDS_UPDATE_LINE = 'Emailing an update needs a ServOS database update first (20261008b) and the update-emails-admin function deployed. Nothing was sent.';
