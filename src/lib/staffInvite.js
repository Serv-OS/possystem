// src/lib/staffInvite.js
//
// THE STAFF APP INVITE, AND WHEN IT CAN BE SENT.
//
// LIVE, 21 Sep 2026. Peter onboarded two people at San Mateo 1 and Provo and
// neither got an email. The records say why:
//
//   Tom Davies   email on the record when onboarding started  -> invited 19:22:24
//   neil test 1  email added at 19:15:51, onboarding started before it -> never invited
//   Alex Carter  email added at 19:16:36, onboarding started 19:15:28   -> never invited
//
// The invite fired ONCE, inside "Start onboarding", and only when the record
// already had an email. Add the email a minute later, as anybody would when
// they are setting a person up, and there was no way to send it at all: no
// button, no retry, nothing. Peter: "if the user doesnt have an email to start
// with you cant use the onboarding flow, so in onboarding screen there should
// be a way to resend the onboarding email".
//
// So the button exists now, and this is the rule behind it.

/** A live invite (not yet expired)? */
export function inviteLive(member, now = Date.now()) {
  const t = Date.parse(member?.portalInviteExpires ?? '');
  return Number.isFinite(t) && t > now;
}

/**
 * What the onboarding screen shows for the staff app, in the words it uses.
 *   kind: 'has_app' | 'sent' | 'expired' | 'ready' | 'no_email'
 *   can:  may the button be pressed
 */
export function inviteState(member, now = Date.now()) {
  if (member?.portalUserId) {
    return { kind: 'has_app', can: false, label: 'Has the app', hint: 'They have set their login up already.' };
  }
  if (!String(member?.email ?? '').trim()) {
    return { kind: 'no_email', can: false, label: 'Send app invite', hint: 'No email on file, add one in Staff first.' };
  }
  if (inviteLive(member, now)) {
    const when = new Date(member.portalInviteExpires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return { kind: 'sent', can: true, label: 'Send again', hint: `Invite sent, it works until ${when}.` };
  }
  if (member?.portalInviteExpires) {
    return { kind: 'expired', can: true, label: 'Send again', hint: 'Their last invite has run out.' };
  }
  return { kind: 'ready', can: true, label: 'Send app invite', hint: 'Emails them a link to set their login up.' };
}
