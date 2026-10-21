// src/backoffice/StockScope.jsx
//
// MULTI SITE STOCK (v5.11.89, Drop 1, map 3.3 and 3.4): the site picker's scope handed down to the
// stock screens. BackOfficeApp holds the data (the scope read once from stock_site_scope, and the
// choice); this provider only passes it on, with the Which site dialog, the "show closed sites"
// flag and the one shot "open a new count" flag of its own.
//
// Rule 2: a one site company (multi false) always works on the signed in venue with today's rights.
// A screen rendered with no provider (alone, or in a test) gets that same one site answer.

import { createContext, Fragment, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { oneSiteScope, scopeAnswer, scopeName } from '../lib/stock/siteScope';
import { canOpenRoute } from '../lib/boSections';
import WhichSiteDialog from './components/WhichSiteDialog';
import PickASite from './sections/stock/PickASite';

const StockScopeContext = createContext(null);
const noop = () => {};

// No provider: the one site default (ready, not multi, everything editable by today's rule).
const DEFAULT_ANSWER = Object.freeze({
  ...scopeAnswer({ scope: oneSiteScope(null, { failed: false }) }),
  setChoice: noop,
  showClosed: false,
  setShowClosed: noop,
  askWhichSite: () => Promise.resolve(null),
  go: noop,
  takeOpenNew: () => false,
  takeOpen: () => null,
  peekOpen: () => null,
  canOpen: () => false,
  reload: noop,
});

export function StockScopeProvider({ value, children }) {
  const { scope = null, choice = null, setChoice = noop, access = null, userId = null, go = noop, reload = noop } = value || {};
  const [showClosed, setShowClosed] = useState(false);
  const [asking, setAsking] = useState(null);   // { label, resolve }
  const openNewRef = useRef(null);
  const openRef = useRef(null);   // { route, value }: one record to open on arrival (integrator, Drop 1)
  const homeId = scope?.homeSite || null;

  const base = useMemo(
    () => scopeAnswer({ scope, choice, homeId, access, userId, showClosed }),
    [scope, choice, homeId, access, userId, showClosed],
  );
  const pickerName = useMemo(() => scopeName(scope, base.choice, homeId), [scope, base.choice, homeId]);

  const askWhichSite = useCallback((label) => {
    if (base.oneSite?.id) return Promise.resolve(base.oneSite.id);
    return new Promise((resolve) => setAsking({ label: label || 'This', resolve }));
  }, [base.oneSite]);

  const answerAsk = useCallback((siteId) => {
    const ask = asking;
    setAsking(null);
    if (siteId) {
      const closed = base.closedSites.some((s) => s.id === siteId);
      setChoice(closed ? { kind: 'site', id: siteId, closed: true } : { kind: 'site', id: siteId });
    }
    ask?.resolve(siteId || null);
  }, [asking, base.closedSites, setChoice]);

  // Can this login open that Back Office route (the same rule as BackOfficeApp's guarded setSection)?
  const canOpen = useCallback((route) => !!route && canOpenRoute(route, access), [access]);
  // go(route, { openNew, open }): open is one record the next screen opens once on arrival, such as
  // { itemId, tab } for Stock items or { id, tab } for Suppliers. A route this login cannot open
  // leaves nothing waiting (setSection says why).
  const goTo = useCallback((route, { openNew = false, open = null } = {}) => {
    const allowed = canOpenRoute(route, access);
    openNewRef.current = allowed && openNew ? route : null;
    openRef.current = allowed && open ? { route, value: open } : null;
    go(route);
  }, [go, access]);
  const takeOpenNew = useCallback((route) => {
    if (openNewRef.current && openNewRef.current === route) { openNewRef.current = null; return true; }
    return false;
  }, []);
  const takeOpen = useCallback((route) => {
    const o = openRef.current;
    if (o && o.route === route) { openRef.current = null; return o.value; }
    return null;
  }, []);
  // The same record without taking it (pure: safe in a state initializer, which StrictMode runs twice).
  const peekOpen = useCallback((route) => (openRef.current && openRef.current.route === route ? openRef.current.value : null), []);

  const answer = useMemo(() => ({
    ...base,
    setChoice,
    showClosed,
    setShowClosed,
    askWhichSite,
    go: goTo,
    takeOpenNew,
    takeOpen,
    peekOpen,
    canOpen,
    reload,
  }), [base, setChoice, showClosed, askWhichSite, goTo, takeOpenNew, takeOpen, peekOpen, canOpen, reload]);

  return (
    <StockScopeContext.Provider value={answer}>
      {children}
      {asking && (
        <WhichSiteDialog label={asking.label} sites={base.scopeSites} pickerName={pickerName}
          onPick={(id) => answerAsk(id)} onClose={() => answerAsk(null)} />
      )}
    </StockScopeContext.Provider>
  );
}

/**
 * { ready, failed, multi, level, orgId, userId, homeSite, multiSince, sites, closedSites, groups,
 *   editors, editorsText, choice, setChoice, showClosed, setShowClosed, scopeSites, oneSite, isAll,
 *   isGroup, group, siteById, siteName, canEditCompany, canEditSite, askWhichSite, go, takeOpenNew,
 *   takeOpen, peekOpen, canOpen, reload }
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useStockScope() {
  return useContext(StockScopeContext) || DEFAULT_ANSWER;
}

/**
 * A screen that works one site at a time. children is (siteId) => node.
 *   scope not ready: StockOverview's own loading line;
 *   one site company: the screen, on the signed in venue (exactly today);
 *   multi site company on All sites or a group: PickASite;
 *   one site picked: the screen, keyed on the site so its mount loads run again on a picker change.
 */
export function StockSiteGate({ oneSiteId, children }) {
  const sc = useStockScope();
  if (!sc.ready) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading…</div>;
  if (!sc.multi) return <Fragment key={oneSiteId || 'home'}>{children(oneSiteId || null)}</Fragment>;
  if (!oneSiteId) return <PickASite />;
  return <Fragment key={oneSiteId}>{children(oneSiteId)}</Fragment>;
}
