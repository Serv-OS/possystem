// src/lib/closeMoney.js: the money fields of a closed check record, shared by the till's two
// close paths (store/index.js buildCloseRecord for a table, recordWalkInClosed for everything
// else), so a test can drive them in node.
//
// 16 Oct 2026: a table check stored a subtotal of 38.25 while its only live line was 5 x 2.25
// (11.25). The session's running subtotal had gone stale (an item added after a void summed the
// voided 18 x 1.50 line back in) and the close stored it. What was charged, the VAT and the
// card payment were right. The stored subtotal is now the goods on the record's own lines.
//
//   subtotal  linesGoods(lines): non voided price x qty (options ride in the line price),
//             BEFORE item and check discounts, the same sum the VAT share is taken from
//   total     what was charged: paymentInfo.grand, else the caller's fallback (`??`, so a
//             100% comp that charged 0 books 0)
//   tenders   what paid it (lib/accounting/tenders.js), from the same total and tip
//
// It never reads a running subtotal, so nothing stale can reach the record. PURE.

import { linesGoods } from './taxShare.js';
import { tendersFromPaymentInfo } from './accounting/tenders.js';

export function closeMoney(lines, paymentInfo = {}, fallbackTotal = 0) {
  const info = paymentInfo || {};
  const subtotal = linesGoods(lines || []);
  const total = info.grand ?? fallbackTotal ?? 0;
  const tip = info.tip || 0;
  return { subtotal, total, tip, tenders: tendersFromPaymentInfo(info, { total, tip }) };
}
