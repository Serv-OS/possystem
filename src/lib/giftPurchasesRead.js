// src/lib/giftPurchasesRead.js
//
// Back Office "Online purchases" reads gift_card_purchases through the gift-list edge function
// (kind: 'purchases', staff only). 18 Sep 2026, lockdown step 1: the table is server only
// (20260918_PLATFORM_gift_purchases_server_only.sql), because the public Platform key could read
// every online gift card code in it.
//
// The one fallback: a gift-list deployed BEFORE this change ignores `kind` and answers with
// { cards }. Only then is the old direct read used, and it still works only until the Platform
// migration runs (after which it returns nothing, never another company's rows).

/** The purchases from a gift-list reply, or the legacy direct read when gift-list is older. */
export async function purchasesFromGiftList(reply, legacyRead) {
  if (reply && Array.isArray(reply.purchases)) return reply.purchases;
  return typeof legacyRead === 'function' ? legacyRead() : [];
}
