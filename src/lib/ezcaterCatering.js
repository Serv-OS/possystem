// src/lib/ezcaterCatering.js
//
// ezCater orders are filed as ServOS catering orders. The rules live in
// supabase/functions/_shared/ezcaterCatering.js so the webhook, the edge functions and the app
// run the SAME code. This file only re-exports them for the app.
export {
  EZ_CHANNEL, EZ_PREP_FALLBACK_MINUTES, EZ_COMMITTED, EZ_DEAD,
  FLAG_CHANGED_AFTER_FIRE, FLAG_CANCELLED_AFTER_FIRE, AWAITING_LABEL,
  isEzcaterOrder, mayMessageCustomer, mayBookOurCourier, mayTakeOrRefundMoney, isPrepaidByChannel,
  cateringChannelLabel, ezcaterOrderNumber, cateringOrderNumber, ezcaterBadge, ezcaterFlagText,
  isAwaitingEzcaterAcceptance, RELEASABLE_OR_FILTER, NOT_RELEASABLE_STATUSES_PG, cateringMayRelease,
  advanceStatusLabel, ezLifecycleState, ezcaterPrep, ezcaterCateringTiming, ezcaterCateringRow,
  kitchenFingerprint, ezcaterWritePlan, channelCancelAlert, ezcaterHoldAlertDue, ezcaterHoldAlertText,
} from '../../supabase/functions/_shared/ezcaterCatering.js';
