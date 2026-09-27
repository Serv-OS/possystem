// src/lib/portalProfileReply.js
//
// What the loyalty portal does with loyalty-otp's update_profile reply (27 Sep 2026).
//
// Peter: "I don't want a merge tool, I want it so when someone signs up it auto merges their
// records, matches them as long as they use the same email, it knows the record exists and just
// adds them together." When the email a member saves is on their other (imported) profile, the
// server joins the two and answers with a FRESH session for the joined account, in the same shape
// verify answers (token, customer, loyalty, gift_cards, stamp_cards). The portal must take that
// session at once, or the member keeps looking at the empty profile their phone made. When the
// email stays off the account (it is on a profile with another phone), the other details are
// still saved and the reply says why in plain words; the portal shows those words and never
// pretends the email was saved.

/**
 * @param {any} data the update_profile reply
 * @returns {{ joined: boolean, session: null|{ token: string, customer: object, loyalty: object|null, giftCards: any[], stampCards: any[] }, emailSaved: boolean, notice: string }}
 */
export function readProfileReply(data) {
  const joined = !!(data && data.joined === true && typeof data.token === 'string' && data.token && data.customer);
  return {
    joined,
    session: joined
      ? {
        token: data.token,
        customer: data.customer,
        loyalty: data.loyalty ?? null,
        giftCards: Array.isArray(data.gift_cards) ? data.gift_cards : [],
        stampCards: Array.isArray(data.stamp_cards) ? data.stamp_cards : [],
      }
      : null,
    emailSaved: joined || data?.email_saved !== false,
    notice: typeof data?.message === 'string' ? data.message : '',
  };
}

/**
 * The customer the portal shows after a save that did NOT join: the typed name, and the typed
 * email only when the server saved it (an empty box keeps the one shown, as before).
 * @param {object|null} prev
 * @param {{ name?: string, email?: string|null }} typed
 * @param {{ emailSaved: boolean }} reply readProfileReply's answer
 */
export function customerAfterSave(prev, typed, reply) {
  const next = { ...(prev || {}) };
  if (typeof typed?.name === 'string') next.name = typed.name;
  if (reply?.emailSaved && typed?.email) next.email = typed.email;
  return next;
}

/** A save refused because the session's profile is gone (joined elsewhere): sign in again. */
export function isSignInAgain(err) {
  return err?.code === 'sign_in_again';
}
