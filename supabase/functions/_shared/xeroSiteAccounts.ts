// supabase/functions/_shared/xeroSiteAccounts.ts
//
// The accounts ServOS can create in Xero for a site from the Setup tab ("Create recommended
// accounts", and from 13 Oct 2026 "Create a Card fees account in Xero"), and the ONE loop that
// creates them (xero-config, action site_create). Moved here from xero-config/index.ts as it
// was, so `npm test` runs the real loop against a made up Xero; the Xero client is passed in.
//
// The rule, the same for every account: read Xero's accounts once; an account with the same
// name OR the same code (case blind) is REUSED, never duplicated; only when there is none is one
// created (PUT /Accounts), and "Enable payments to this account" is set where the account needs
// it. Nothing is saved to the site's setup here: the answer is a `patch` the form fills in, and
// the person presses Save.
//
// One rule more for the card fees account only. The reuse rule takes ANY account of that name or
// code, archived ones and ones of any type included. A wrong clearing account is caught later
// (the Ready checklist needs it to take payments), but nothing would catch a wrong card fees
// account before Xero refused the day's invoice. So an account called "Card fees" (or coded
// SOSFEES) that is not an ACTIVE EXPENSE account is refused in plain words, before anything at
// all is created.

type Api = (path: string, init?: any) => Promise<any>;
type Site = { name: string; code: string };

export const RECOMMENDED: Record<string, (site: Site) => any> = {
  cardClearing: (x) => ({ Name: `Card clearing ${x.name}`.slice(0, 150), Code: `CC${x.code}`.slice(0, 10), Type: 'CURRENT', EnablePaymentsToAccount: true, Description: 'Card takings waiting for the processor payout (ServOS).' }),
  cashInTill: (x) => ({ Name: `Cash in till ${x.name}`.slice(0, 150), Code: `CT${x.code}`.slice(0, 10), Type: 'BANK', BankAccountNumber: `SOS-CASH-${x.code}`.slice(0, 30) }),
  giftLiability: () => ({ Name: 'Gift card liability', Code: 'SOSGIFT', Type: 'CURRLIAB', EnablePaymentsToAccount: true, Description: 'Gift cards sold and not yet spent (ServOS).' }),
  tipsPayable: () => ({ Name: 'ServOS Tips Payable', Code: 'SOSTIPS', Type: 'CURRLIAB', Description: 'Tips owed to staff (ServOS).' }),
  servicePayable: () => ({ Name: 'ServOS Service Charge Payable', Code: 'SOSSVCCHG', Type: 'CURRLIAB', Description: 'Service charge owed to staff (ServOS).' }),
  discounts: () => ({ Name: 'Sales discounts', Code: 'SOSDISC', Type: 'REVENUE', Description: 'Discounts, rewards and comps given at the till (ServOS).' }),
  // 13 Oct 2026: where the "Card fees" line of the daily sales invoice posts. One per organisation.
  cardFees: () => ({ Name: 'Card fees', Code: 'SOSFEES', Type: 'EXPENSE', Description: 'Card processing fees taken by the card processor before each payout (ServOS).' }),
};

/** The keys asked for that ServOS knows how to create. Anything else is ignored. */
export function recommendedKeys(keys: unknown): string[] {
  return (Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && Object.hasOwn(RECOMMENDED, k));
}

const sameAccount = (def: any) => (x: any) => String(x.Name || '').toLowerCase() === String(def.Name).toLowerCase()
  || (def.Code && String(x.Code || '').toUpperCase() === String(def.Code).toUpperCase());

/** An account the Card fees line can post to: active, and an expense account. */
export const canTakeCardFees = (a: any): boolean => !!a && String(a.Status || 'ACTIVE').toUpperCase() === 'ACTIVE' && String(a.Class || '').toUpperCase() === 'EXPENSE';

/** Why ServOS will not reuse an account Xero already has under the card fees name or code. */
export const cardFeesAccountRefusal = (a: any): string => `Xero already has an account called "${a?.Name || ''}"${a?.Code ? ` (code ${a.Code})` : ''} that is not an active expense account, so ServOS will not post card fees to it. Pick an expense account from the list, or change the name and code of that account in Xero and try again.`;

/**
 * Create (or reuse) the accounts named by `keys` for the site `who`. Returns { ok: true,
 * created: [{ key, name, code, id, existed }], patch } or { ok: false, status, error, created }.
 */
export async function createRecommendedAccounts(api: Api, keys: string[], who: Site): Promise<{ ok: true; created: any[]; patch: any } | { ok: false; status: number; error: string; created: any[] }> {
  const accRes = await api('/Accounts');
  const accounts: any[] = accRes?.Accounts || [];
  const created: any[] = [];
  const patch: any = {};
  const ref = (a: any) => a.Code || a.AccountID;
  // The card fees account is checked before ANY account is created (see the top of this file).
  if (keys.includes('cardFees')) {
    const taken = accounts.find(sameAccount(RECOMMENDED.cardFees(who)));
    if (taken && !canTakeCardFees(taken)) return { ok: false, status: 400, error: cardFeesAccountRefusal(taken), created };
  }
  for (const k of keys) {
    const def = RECOMMENDED[k](who);
    let a = accounts.find(sameAccount(def));
    const existed = !!a;
    if (!a) {
      a = (await api('/Accounts', { method: 'PUT', body: JSON.stringify(def) }))?.Accounts?.[0];
      if (!a) return { ok: false, status: 500, error: `Xero did not create ${def.Name}.`, created };
      if (def.EnablePaymentsToAccount && a.EnablePaymentsToAccount !== true) {
        a = (await api(`/Accounts/${a.AccountID}`, { method: 'POST', body: JSON.stringify({ EnablePaymentsToAccount: true }) }))?.Accounts?.[0] || a;
      }
      accounts.push(a);
    }
    created.push({ key: k, name: a.Name, code: a.Code || '', id: a.AccountID, existed });
    if (k === 'cardClearing') patch.clearing = { ...(patch.clearing || {}), card: ref(a) };
    if (k === 'cashInTill') patch.clearing = { ...(patch.clearing || {}), cash: ref(a) };
    if (k === 'giftLiability') { patch.giftLiabilityAccount = ref(a); patch.clearing = { ...(patch.clearing || {}), gift_card: ref(a) }; }
    if (k === 'tipsPayable') patch.tipsAccount = ref(a);
    if (k === 'servicePayable') patch.serviceAccount = ref(a);
    if (k === 'discounts') patch.discountAccount = ref(a);
    // Only the account: whether card fees are ON is the person's own tick on the form.
    if (k === 'cardFees') patch.cardFees = { account: ref(a) };
  }
  return { ok: true, created, patch };
}
