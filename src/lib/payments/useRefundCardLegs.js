// src/lib/payments/useRefundCardLegs.js
//
// The card legs a refund SCREEN shows: the same answer store.refundCheck will reach
// (lib/payments/refundCardLegs.js resolveRefundCardLegs), so the screen never tells staff
// "No card payment is linked, return the money in the dashboard" while the store goes on to
// refund the card from the sale's row. Following that box would refund the customer twice.
//
// The till's copy first. Only when it has no card leg although a card paid, the row is read
// once per check (the same read the store makes; training never reads, like the store).
//   { legs, checking, failed }  checking: the row is being read; failed: the read failed, and
//   the store will refuse the refund until it works (nothing is recorded).
import { useEffect, useMemo, useState } from 'react';
import { cardLegsOf } from './refundMath';
import { resolveRefundCardLegs, checkSaysCard } from './refundCardLegs';
import { fetchClosedCheckCardRow } from '../db';
import { isTrainingMode } from '../trainingMode';

const NO_LEGS = [];

export function useRefundCardLegs(check) {
  const fromCopy = useMemo(() => (check ? cardLegsOf(check) : NO_LEGS), [check]);
  const checkId = check?.id || null;
  const needsRow = !!checkId && !fromCopy.length && checkSaysCard(check) && !isTrainingMode();
  const [read, setRead] = useState({ id: null, legs: NO_LEGS, failed: false });

  useEffect(() => {
    if (!needsRow) return undefined;
    let alive = true;
    resolveRefundCardLegs(check, { readRow: () => fetchClosedCheckCardRow(checkId) })
      .then((r) => { if (alive) setRead({ id: checkId, legs: r.legs, failed: r.lookupFailed }); })
      .catch(() => { if (alive) setRead({ id: checkId, legs: NO_LEGS, failed: true }); });
    return () => { alive = false; };
    // One read per check: `check` changes on every refund echo, the answer does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsRow, checkId]);

  if (!needsRow) return { legs: fromCopy, checking: false, failed: false };
  if (read.id !== checkId) return { legs: NO_LEGS, checking: true, failed: false };
  return { legs: read.legs, checking: false, failed: read.failed };
}
