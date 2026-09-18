// src/lib/cateringAlerts.js
//
// When does a till raise an alert for a catering order that changed AFTER the kitchen had it?
// Pure, so node:test pins it. Called by src/lib/realtime.js on every order_queue UPDATE.
//
// The ezCater webhook never moves a fired order's time. It stamps customer.changedAfterFire
// ({ at, kinds, was, now }) instead (supabase/functions/_shared/ezcaterCatering.js). An alert is
// due when that stamp is new (its `at` differs from the old row's, or the old row is not in the
// payload) or a fired catering order has just turned cancelled. The key is the change's own time,
// so the caller shows each change once even when realtime delivers the same UPDATE twice.
import { isCateringSource, cateringSourceLabel } from './cateringRules.js';
import { changedAfterFireText } from '../../supabase/functions/_shared/ezcaterCatering.js';

export function cateringChangeAlert(row, oldRow) {
  if (!row || !isCateringSource(row.source) || !row.ref) return null;
  const change = row.customer?.changedAfterFire;
  const oldAt = oldRow?.customer?.changedAfterFire?.at || null;
  const label = cateringSourceLabel(row.source) || 'Catering';
  const who = `${label}${row.customer?.ezcater_order_number ? ` ${row.customer.ezcater_order_number}` : ''}`;
  if (change?.at && change.at !== oldAt && Array.isArray(change.kinds) && change.kinds.length) {
    return {
      key: `${row.ref}:${change.at}`,
      alert: {
        source: row.source, kind: change.kinds.includes('cancelled') ? 'cancel' : 'changed',
        who, ref: row.ref, total: 0, orderType: row.type || null, status: row.status || null,
        message: changedAfterFireText(change),
      },
    };
  }
  // A fired catering order cancelled with no stamp (our own catering, cancelled by staff
  // elsewhere, or a webhook from before the stamp existed).
  if (row.status === 'cancelled' && row.kitchen_routed_at && oldRow?.status && oldRow.status !== 'cancelled') {
    return {
      key: `${row.ref}:cancelled`,
      alert: { source: row.source, kind: 'cancel', who, ref: row.ref, total: 0, orderType: row.type || null, status: 'cancelled',
        message: `Cancelled after it went to the kitchen` },
    };
  }
  return null;
}
