// src/lib/payments/useRefundCardLegs.js
//
// The card legs a refund SCREEN shows: the same answer store.refundCheck will reach
// (lib/payments/refundCardLegs.js resolveRefundCardLegs), so the screen never tells staff
// "No card payment is linked, return the money in the dashboard" while the store goes on to
// refund the card from the sale's row. Following that box would refund the customer twice.
//
// The till's copy first. Only when it has no card leg although a card paid, the row is read
// (the same read the store makes; training never reads, like the store), once per opening of
// the check and again on retry().
//   { legs, checking, failed, retry }  checking: the row is being read; failed: the read
//   failed, and the store would refuse the refund (nothing is recorded) until it works.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cardLegsOf } from './refundMath';
import { resolveRefundCardLegs, checkSaysCard } from './refundCardLegs';
import { fetchClosedCheckCardRow } from '../db';
import { isTrainingMode } from '../trainingMode';

const NO_LEGS = [];
const NO_READ = { key: null, legs: NO_LEGS, failed: false };

export function useRefundCardLegs(check) {
  const fromCopy = useMemo(() => (check ? cardLegsOf(check) : NO_LEGS), [check]);
  const checkId = check?.id || null;
  const needsRow = !!checkId && !fromCopy.length && checkSaysCard(check) && !isTrainingMode();
  const [attempt, setAttempt] = useState(0);
  const key = needsRow ? `${checkId}#${attempt}` : null;
  const [read, setRead] = useState(NO_READ);
  // A closed panel forgets its answer, so reopening the same sale reads again and shows
  // "checking" meanwhile, never the last opening's result (Back Office keeps this mounted).
  const [seenKey, setSeenKey] = useState(key);
  if (key !== seenKey) {
    setSeenKey(key);
    if (read.key !== null) setRead(NO_READ);
  }

  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    resolveRefundCardLegs(check, { readRow: () => fetchClosedCheckCardRow(checkId) })
      .then((r) => { if (alive) setRead({ key, legs: r.legs, failed: r.lookupFailed }); })
      .catch(() => { if (alive) setRead({ key, legs: NO_LEGS, failed: true }); });
    return () => { alive = false; };
    // One read per opening (or retry): `check` changes on every refund echo, the answer does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (!needsRow) return { legs: fromCopy, checking: false, failed: false, retry };
  if (read.key !== key) return { legs: NO_LEGS, checking: true, failed: false, retry };
  return { legs: read.legs, checking: false, failed: read.failed, retry };
}
