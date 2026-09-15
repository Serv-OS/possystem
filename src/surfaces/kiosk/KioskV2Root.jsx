/**
 * KioskV2Root: the new kiosk design, mounted by KioskApp only when
 * kioskNewDesignOn(profile) is true (lib/kioskFlow.js). Always mounted while the new
 * design is showing.
 *
 * It owns:
 *   - the shell: data-kiosk-theme="design", the venue colour variables, and activity
 *     tracking (a tap, a key or typed input resets the idle timer, as today's shell does)
 *   - the 1080 wide canvas (KioskCanvas)
 *   - venue reads the old flow never needed: the real currency (F5), the table list
 *     (at mount and again for every new customer), the modifier group rules the one
 *     tap add rule needs (again whenever the menu items change), the venue tipping rule
 *     (tipping_config.kiosk) and the Challenge 21 alcohol categories (both again for every
 *     new customer, so a Back Office change reaches the next customer)
 *   - the session key: it goes up every time the shared screen becomes 'attract', and
 *     KioskFlowV2 is keyed on it, so each customer starts with fresh local state
 *   - telling the shared location resolver the kiosk's own venue (D6), so points and CRM
 *     records can be written from a kiosk
 *
 * engine: the shared order state and functions from KioskApp (see the build spec 2.2).
 * api: the network reads (./kioskApi); the DEV preview passes a fixture version.
 * ScreenPay: KioskApp's card screen component, mounted by KioskFlowV2 only on 'pay'.
 */
import { useEffect, useMemo, useState } from 'react';
import { getLang, setLang } from '../../lib/i18n';
import { KIOSK_LANGUAGE_PICKER } from '../../lib/kioskFlow';
import { kioskThemeVars } from '../../lib/kioskTheme';
import { kioskGroupIds } from '../../lib/kioskMenu';
import { kioskTipRule } from '../../lib/tipping';
import { getActiveCurrencyCode } from '../../lib/currency';
import kioskApi from './kioskApi';
import KioskCanvas from './KioskCanvas';
import KioskFlowV2 from './KioskFlowV2';

const NO_IDS = [];

export default function KioskV2Root({ engine, api = kioskApi, ScreenPay = null }) {
  const { locationId, profile, resetIdle, items } = engine;
  const themeVars = useMemo(() => kioskThemeVars(profile), [profile]);

  // Decision 17: the new design launches in English (the language pill is hidden until the
  // new lines are translated), so a language a customer picked on today's kiosk is reset.
  useEffect(() => {
    if (!KIOSK_LANGUAGE_PICKER && getLang() !== 'en') setLang('en');
  }, []);

  // Decision 9: a number given only for "Text me when it's ready" is not a CRM or loyalty sign
  // up. With points switched off at this kiosk, the store's attributeOrderToCustomer skips new
  // design kiosk orders (no customer record, no points, no welcome text). Only this design sets it.
  const loyaltyOn = engine.loyaltyEnabled === true;
  useEffect(() => {
    if (typeof api.setAttributionPolicy === 'function') api.setAttributionPolicy(loyaltyOn ? 'points' : 'off');
  }, [api, loyaltyOn]);

  // D6: tell the shared location resolver this kiosk's own venue, so the CRM and points writes
  // (store attributeOrderToCustomer) can find it on a kiosk (F3). Only when the venue came from
  // the kiosk's own device row. The kiosk pairing keys are kept by the tenant fence
  // (supabase.js TENANT_FENCE_KEEP), so this can never unpair the kiosk.
  const { deviceLocationId } = engine;
  useEffect(() => {
    if (!locationId || !deviceLocationId || deviceLocationId !== locationId) return;
    if (typeof api.adoptLocation === 'function') api.adoptLocation(locationId);
  }, [api, locationId, deviceLocationId]);

  // Session key, derived during render from the previous screen (React's "adjust state
  // when a prop changes" pattern), so the remount happens in the same render as the reset.
  const [session, setSession] = useState({ screen: engine.screen, key: 0 });
  let sessionKey = session.key;
  if (engine.screen !== session.screen) {
    sessionKey = engine.screen === 'attract' ? session.key + 1 : session.key;
    setSession({ screen: engine.screen, key: sessionKey });
  }

  // The venue currency, so money() shows the venue's own symbol and the phone keypad uses the
  // right number rules (UK or US). Seeded from the stored currency until the venue read lands.
  const [currency, setCurrency] = useState(() => getActiveCurrencyCode());
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.loadCurrency(locationId))
      .then((code) => { if (alive && code) setCurrency(code); })
      .catch(() => {});
    return () => { alive = false; };
  }, [api, locationId]);

  // Tables: read at mount and again for each new customer. The last good list stays on
  // screen while a new read is in flight, so the start screen never flickers.
  const [tables, setTables] = useState({ status: 'loading', groups: [] });
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.loadTables(locationId))
      .then((r) => { if (alive && r && r.status) setTables(r); })
      .catch(() => { if (alive) setTables({ status: 'failed', groups: [] }); });
    return () => { alive = false; };
  }, [api, locationId, sessionKey]);

  // Modifier group rules for the one tap add rule. null until read, and after a failed read;
  // then every item with modifier groups opens the sheet instead of adding in one tap.
  const [groupRules, setGroupRules] = useState(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.loadGroupRules(kioskGroupIds(items)))
      .then((rules) => { if (alive) setGroupRules(rules instanceof Map ? rules : null); })
      .catch(() => { if (alive) setGroupRules(null); });
    return () => { alive = false; };
  }, [api, items]);

  // Venue tipping (tipping_config.kiosk). null while reading, so the tip card never flashes
  // up and then vanishes. A failed read falls back to the profile's tip presets.
  const [tippingRead, setTippingRead] = useState({ status: 'loading', row: null });
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.loadTipping?.(locationId))
      .then((r) => { if (alive) setTippingRead(r?.ok ? { status: 'ok', row: r.row } : { status: 'failed', row: null }); })
      .catch(() => { if (alive) setTippingRead({ status: 'failed', row: null }); });
    return () => { alive = false; };
  }, [api, locationId, sessionKey]);
  const tipping = useMemo(
    () => ({ rule: tippingRead.status === 'loading' ? null : kioskTipRule(tippingRead.row, profile) }),
    [tippingRead, profile],
  );

  // Challenge 21 alcohol categories, for the customer's ID reminder on Review and pay.
  const [alcoholIds, setAlcoholIds] = useState(NO_IDS);
  useEffect(() => {
    let alive = true;
    Promise.resolve(api.loadAlcoholCategoryIds?.(locationId))
      .then((ids) => { if (alive && Array.isArray(ids)) setAlcoholIds(ids); })
      .catch(() => {});
    return () => { alive = false; };
  }, [api, locationId, sessionKey]);

  return (
    <div
      data-kiosk-theme="design"
      onPointerDown={resetIdle}
      onKeyDown={resetIdle}
      onInput={resetIdle}
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        background: 'var(--k2Ground)',
        color: 'var(--k2Ink)',
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
        ...themeVars,
      }}
    >
      <KioskCanvas>
        <KioskFlowV2
          key={sessionKey}
          engine={engine}
          tables={tables}
          groupRules={groupRules}
          api={api}
          tipping={tipping}
          alcoholIds={alcoholIds}
          currency={currency}
          ScreenPay={ScreenPay}
        />
      </KioskCanvas>
    </div>
  );
}
