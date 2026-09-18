// src/lib/cateringRules.js
//
// The app's door to the ONE catering rule set. The rules live in
// supabase/functions/_shared/cateringRules.js (and the ezCater write rules in
// _shared/ezcaterCatering.js) so the edge functions (ezcater-webhook, catering-release,
// order-notify, courier dispatch) and the app run the very same code, not two copies that can
// drift. Same arrangement as MenuTranslations.jsx and _shared/menuTranslate.js.
export {
  CATERING_SOURCES, CATERING_SOURCES_PG_LIST, DEFAULT_VENUE_TZ, EZ_COMMITTED,
  isCateringSource, isEzcaterOrder, cateringSourceLabel,
  liveQueueOrFilter, isFutureCatering,
  wallTimeToInstantMs, venueWallClock,
  cateringPrepMinutes, cateringFireMs,
  cateringHoldReason, cateringMayFire, cateringReleaseWindow, cateringReleaseDecision,
  inAdvanceList, advanceListStatus,
  mayBookOurCourier, mayMessageCustomer,
} from '../../supabase/functions/_shared/cateringRules.js';
export { changedAfterFireText } from '../../supabase/functions/_shared/ezcaterCatering.js';
