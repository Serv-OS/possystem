// supabase/functions/_shared/promoLookup.ts
//
// How promo-redeem finds a promo code: exactly, case insensitively, inside the venue's own company.
//
// WHY (18 Sep 2026, lockdown step 1, review round three item d). promo-redeem looked a code up
// with .ilike('code', <raw input>) and no org filter. ilike treats % and _ as wildcards (and
// PostgREST turns * into %), so { action: 'validate', code: '%' } matched some company's code,
// and prefixes ('BDAY-%', 'A%') enumerated every company's live codes and their offers, from the
// public till endpoint. Now:
//   * the code must look like a code the platform issues (genCode in _shared/promo.ts: letters,
//     digits and single hyphens, A to Z 0 to 9 only), so no wildcard character can reach the query;
//   * the like pattern is escaped anyway (belt and braces);
//   * the lookup is scoped to the org of the venue the request is for, resolved server side;
//   * the row that comes back must equal the code exactly (upper case) and be that org's.
//
// PURE. No imports, so node tests load it directly.

/** A code the platform could have issued: A to Z, 0 to 9 and inner hyphens, 1 to 64 long. */
const CODE_SHAPE = /^[A-Z0-9](?:[A-Z0-9-]{0,62}[A-Z0-9])?$/;

/** The code as stored for comparison (trimmed, upper case), or null when it cannot be a code. */
export function normalisePromoCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return CODE_SHAPE.test(c) ? c : null;
}

/** Escape LIKE metacharacters so the pattern only ever matches itself. */
export function escapeLike(s: string): string {
  return String(s).replace(/[\\%_*]/g, (ch) => `\\${ch}`);
}

/** Is this row exactly the code asked for, in the venue's own org? */
export function promoRowMatches(row: { code?: unknown; org_id?: unknown } | null | undefined, code: string, orgId: string): boolean {
  if (!row || !code || !orgId) return false;
  return String(row.code ?? '').trim().toUpperCase() === code && String(row.org_id ?? '') === String(orgId);
}

/** Pick the one matching row from what the query returned (never "the first row"). */
export function pickPromoRow<T extends { code?: unknown; org_id?: unknown }>(rows: T[] | null | undefined, code: string, orgId: string): T | null {
  return (rows || []).find((r) => promoRowMatches(r, code, orgId)) ?? null;
}
