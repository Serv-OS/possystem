// supabase/functions/_shared/earnFromCheck.ts
//
// loyalty-earn from the server's own closed_checks row, not from the request body.
//
// WHY (18 Sep 2026, round three). loyalty-earn took items and subtotal from the body and never
// checked that closed_check_id existed, so even under LOYALTY_AUTHORITY_MODE=enforce a member
// token (anybody can sign in as themselves) or a forged device could mint any number of points
// with a made up check id. Now:
//   * the check is read at THAT location by id. A check that does not exist is refused (enforce)
//     or recorded and earned the old way (report), because a till may call earn a moment before
//     its closed_checks row lands; the till retries a refused earn (store, customerLookup).
//   * a voided or refunded check earns nothing (enforce) or is recorded (report).
//   * a member token earns only on a check that is THEIRS: the check's customer_id is the
//     member, or its customer phone is the phone they proved. A member cannot claim a stranger's
//     order at the same venue. Tills and staff pick the customer, so this is not asked of them.
//   * the qualifying amount and the stamp items come from the check's own items, capped at the
//     check's own subtotal or total. Categories come from the venue's menu (a variant uses its
//     parent's category, the rule the till used to apply before sending).
//   * one earn per check: the ledger is read for ANY earn row on this check id, whatever key.
// Limits, stated plainly: closed_checks is writable with the Ops anon key until the 20260907b
// Ops fence (file 3) lands, so a determined attacker can still write a check row to earn on.
// This closes "no row at all" and "a stranger's row"; the fence closes the rest.
//
// PURE. No imports, so node tests load it directly.

import { phonesMatch } from './giftCardMatch.ts';

export type CheckRow = {
  id: string;
  location_id?: string | null;
  items?: any[] | null;
  subtotal?: number | string | null;
  total?: number | string | null;
  status?: string | null;
  voided?: boolean | null;
  refunded?: boolean | null;
  customer?: { phone?: unknown; id?: unknown } | null;
  customer_id?: string | null;
  customer_phone?: string | null;
};

export type MenuCatRow = { id: string; cat?: string | null; cats?: string[] | null; parent_id?: string | null };

export type EarnItem = {
  id: string | null; name: string; qty: number; price: number; cat: string | null;
  isComp: boolean; staffDiscount: boolean; isGiftCard: boolean;
};

/** The ids of the menu items (and their parents) this check needs categories for. */
export function checkItemIds(check: CheckRow | null): string[] {
  const out = new Set<string>();
  for (const i of (check?.items || [])) {
    if (!i || i.voided) continue;
    const id = i.itemId || i.id;
    if (id) out.add(String(id));
    if (i.parentId) out.add(String(i.parentId));
  }
  return [...out];
}

/** Items to earn on, from the check. Voided lines never earn. */
export function earnItemsFromCheck(check: CheckRow | null, menu: MenuCatRow[] = []): EarnItem[] {
  const byId = new Map(menu.map((m) => [String(m.id), m]));
  const catOf = (m: MenuCatRow | undefined) => (m ? (m.cat || (m.cats && m.cats[0]) || null) : null);
  const out: EarnItem[] = [];
  for (const i of (check?.items || [])) {
    if (!i || i.voided) continue;
    const id = i.itemId || i.id || null;
    let cat: string | null = null;
    const parentId = i.parentId || byId.get(String(id))?.parent_id || null;
    if (parentId) cat = catOf(byId.get(String(parentId)));
    if (!cat) cat = catOf(byId.get(String(id)));
    if (!cat) cat = i.cat || i.category || null;
    out.push({
      id: id ? String(id) : null,
      name: String(i.name ?? ''),
      qty: Number(i.qty) || 1,
      price: Number(i.price) || 0,
      cat,
      isComp: !!(i.isComp || i.comp),
      staffDiscount: !!(i.isStaffDiscount || i.staffDiscount),
      isGiftCard: !!i.isGiftCard,
    });
  }
  return out;
}

/** The most the check says was sold, in minor units (0 when it says nothing). */
export function checkCapMinor(check: CheckRow | null): number {
  const a = Math.round(Number(check?.subtotal || 0) * 100);
  const b = Math.round(Number(check?.total || 0) * 100);
  return Math.max(0, Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
}

/** Is this check the member's own? customer_id, or the customer phone they proved. */
export function checkBelongsToMember(check: CheckRow | null, member: { customerId: string; phone: string | null }): boolean {
  if (!check) return false;
  if (check.customer_id && String(check.customer_id) === String(member.customerId)) return true;
  const c: any = check.customer || {};
  if (c.id && String(c.id) === String(member.customerId)) return true;
  if (!member.phone) return false;
  return phonesMatch(c.phone ?? check.customer_phone ?? null, member.phone);
}

export function checkIsEarnable(check: CheckRow | null): boolean {
  if (!check) return false;
  if (check.voided || check.refunded) return false;
  const st = String(check.status || 'paid').toLowerCase();
  return !['void', 'voided', 'refunded', 'cancelled'].includes(st);
}

export type EarnSource =
  | { use: 'check'; record: null }
  | { use: 'check'; record: string }
  | { use: 'body'; record: string }
  | { use: 'refuse'; record: string; status: number; code: string; error: string; retryable: boolean };

/**
 * Where the earn comes from. `record` is a reason to write to caller_authority_log.
 *   enforce: no check -> refuse 409 (retryable: the till's row may still be landing);
 *            not earnable -> refuse 409; a member on a check that is not theirs -> refuse 403.
 *   report:  the same situations are recorded and the call carries on the old way (body) when
 *            there is no check; with a check it always earns from the check.
 */
export function decideEarnSource(p: {
  mode: 'report' | 'enforce';
  check: CheckRow | null;
  via: 'member' | 'staff' | 'device' | null;
  member: { customerId: string; phone: string | null } | null;
}): EarnSource {
  const enforce = p.mode === 'enforce';
  if (!p.check) {
    return enforce
      ? { use: 'refuse', record: 'check_not_found', status: 409, code: 'check_not_found', retryable: true, error: 'That order has not been recorded yet. Points will be added once it is.' }
      : { use: 'body', record: 'check_not_found' };
  }
  if (!checkIsEarnable(p.check)) {
    return enforce
      ? { use: 'refuse', record: 'check_not_earnable', status: 409, code: 'check_not_earnable', retryable: false, error: 'That order was voided or refunded.' }
      : { use: 'check', record: 'check_not_earnable' };
  }
  if (p.via === 'member' && p.member && !checkBelongsToMember(p.check, p.member)) {
    return enforce
      ? { use: 'refuse', record: 'check_not_this_member', status: 403, code: 'check_not_this_member', retryable: false, error: 'That order is not yours.' }
      : { use: 'check', record: 'check_not_this_member' };
  }
  return { use: 'check', record: null };
}
