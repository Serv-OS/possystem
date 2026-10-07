// src/lib/accounting/xeroMoveWords.js
// The words Back Office shows before a site's sales are moved to another Xero organisation
// (Settings → Xero → Connection, the Xero organisation box). PURE, so the test can hold them to
// what the server does (supabase/functions/_shared/xeroOrg.js, xero-connect set_organisation).

// What a move does, in the order it matters to the person pressing the button.
export function moveWords({ site, from, to, invoice, autoKept = false, setupTab }) {
  const redo = invoice
    ? `Choose them again for ${to}: accounts, VAT rates and tracking under ${setupTab}, the purchases account and VAT on purchases under Posting. Then check a day's figures.`
    : `Choose them again for ${to} under Posting (Account mapping).`;
  const posting = invoice
    ? `Nothing posts for ${site} until that is done. ${autoKept ? 'From then on each day posts by itself.' : `Auto posting is off for ${site}: turn it on under Posting when that is done.`} Days that pass in between are NOT posted by themselves: push each one from Posting.`
    : `Auto posting is turned off for ${site}. Turn it back on under Posting when the accounts are chosen.`;
  return [
    `Post ${site}'s sales to ${to} instead of ${from}?`,
    '',
    `1. ${site}'s Xero setup is cleared: accounts, VAT rates, payment accounts, the purchases account and the Site tracking option. They belong to ${from}. ${redo}`,
    `2. ${posting}`,
    `3. Days already posted stay in ${from}. Ask the accountant to void them there if they should not be.`,
  ].join('\n');
}
