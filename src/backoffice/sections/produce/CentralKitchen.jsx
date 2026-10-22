// src/backoffice/sections/produce/CentralKitchen.jsx
//
// MULTI SITE STOCK Drop 3 (map 4.7, design 2.8, mockup scrKitchen, contract 3.4 and 4.4): the route
// 'central-kitchen'. Shown only to multi site companies with a central kitchen, and only to company
// editors or logins that reach the kitchen (the route gate in boSections.js).
//   * The kitchen: the picked site when it is a kitchen, else a select of the company's kitchens.
//   * The day: today on the kitchen's own clock by default, with the days around it.
//   * Tabs: Production plan (KitchenPlan), Orders in (KitchenOrdersIn), Ingredients needed
//     (KitchenIngredients), Pick and send (KitchenPickSend), Recharges (RechargeStatement, company
//     editors only).
// Every figure comes from the database (stock_kitchen_*). Nothing here moves a stock number by itself:
// stock moves only when a person presses Send on a pick (a transfer, in transit until the site
// receives it in Transfers) or orders ingredients.

import { useEffect, useMemo, useState } from 'react';
import { useStockScope } from '../../StockScope';
import { getVenueClock } from '../../../lib/locationTime';
import { buildScheduleCtx } from '../../../lib/scheduleCtx';
import { dayWords, addDaysYmd } from '../../../lib/stock/kitchenRules';
import { PageHead, TabBar, Notice, ui } from '../stock/stockUi';
import { useCompanyKitchens } from '../stock/SiteKindCard';
import KitchenPlan from './KitchenPlan';
import KitchenOrdersIn from './KitchenOrdersIn';
import KitchenIngredients from './KitchenIngredients';
import KitchenPickSend from './KitchenPickSend';
import RechargeStatement from './RechargeStatement';

const TABS = [
  { id: 'plan', label: 'Production plan' },
  { id: 'orders', label: 'Orders in' },
  { id: 'ingredients', label: 'Ingredients needed' },
  { id: 'pick', label: 'Pick and send' },
];

export default function CentralKitchen({ orgCtx = null }) {
  const sc = useStockScope();
  const kitchens = useCompanyKitchens(sc);
  const editor = sc.canEditCompany('produce') || sc.level === 'all';
  const picked = sc.oneSite?.id && kitchens.some((k) => k.id === sc.oneSite.id) ? sc.oneSite.id : null;
  const [chosen, setChosen] = useState(null);
  const kitchenId = picked || chosen || (kitchens.length === 1 ? kitchens[0].id : null);
  const [tz, setTz] = useState(null);
  const [day, setDay] = useState(null);
  const [tab, setTab] = useState('plan');

  useEffect(() => {
    if (!kitchenId) return undefined;
    let live = true;
    getVenueClock(kitchenId).then((c) => { if (live) setTz(c?.timezone || 'Europe/London'); }).catch(() => { if (live) setTz('Europe/London'); });
    return () => { live = false; };
  }, [kitchenId]);
  const today = useMemo(() => (tz ? buildScheduleCtx(tz).ymd : null), [tz]);
  const shownDay = day || today;
  const days = useMemo(() => (today ? [-1, 0, 1, 2, 3].map((n) => addDaysYmd(today, n)) : []), [today]);
  const tabs = editor ? [...TABS, { id: 'recharges', label: 'Recharges' }] : TABS;

  if (!sc.ready) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading…</div>;
  if (!sc.multi) return null;

  return (
    <div style={ui.page}>
      <PageHead title="Central kitchen"
        sub={shownDay ? <>Production plan for <b>{dayWords(shownDay)}</b>. Total ordered by every site, plus catering, plus standing order forecast, less what the kitchen holds.</> : 'Production plan, orders in, ingredients, pick and send.'}>
        {kitchens.length > 1 && !picked && (
          <select value={kitchenId || ''} onChange={(e) => { setChosen(e.target.value || null); setDay(null); }} aria-label="Kitchen" style={{ ...ui.input, width: 'auto' }}>
            <option value="">Pick a kitchen</option>
            {kitchens.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        )}
        {days.length > 0 && (
          <select value={shownDay || ''} onChange={(e) => setDay(e.target.value)} aria-label="Day" style={{ ...ui.input, width: 'auto' }}>
            {days.map((d) => <option key={d} value={d}>{d === today ? `Today, ${dayWords(d)}` : dayWords(d)}</option>)}
          </select>
        )}
      </PageHead>
      {kitchens.length === 0 && <Notice tone="info">No site is a central kitchen yet. Set one in Location settings, What this site is.</Notice>}
      {kitchens.length > 0 && !kitchenId && <Notice tone="info">Pick a kitchen to see its plan.</Notice>}
      {kitchenId && shownDay && (
        <>
          <TabBar tabs={tabs} value={tab} onChange={setTab} />
          {tab === 'plan' && <KitchenPlan key={`${kitchenId}:${shownDay}`} kitchenId={kitchenId} day={shownDay} />}
          {tab === 'orders' && <KitchenOrdersIn key={`${kitchenId}:${shownDay}`} kitchenId={kitchenId} day={shownDay} />}
          {tab === 'ingredients' && <KitchenIngredients key={`${kitchenId}:${shownDay}`} kitchenId={kitchenId} day={shownDay} />}
          {tab === 'pick' && <KitchenPickSend key={`${kitchenId}:${shownDay}`} kitchenId={kitchenId} day={shownDay} />}
          {tab === 'recharges' && editor && <RechargeStatement orgCtx={orgCtx} />}
          {tab === 'plan' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginTop: 16 }}>
              <div style={ui.card}>
                <div style={{ fontWeight: 700, color: 'var(--t1)' }}>Orders in <span style={{ ...ui.sub, fontWeight: 400 }}>Only orders placed with this kitchen</span></div>
                <div style={{ ...ui.sub, marginTop: 6 }}>Every site's order for a delivery day in one list. Kitchen staff never see other sites' other orders.</div>
              </div>
              <div style={ui.card}>
                <div style={{ fontWeight: 700, color: 'var(--t1)' }}>Restricted recipes</div>
                <div style={{ ...ui.sub, marginTop: 6 }}>Method and cost of kitchen recipes sit where site managers cannot read them. Sites only hold the batch as a bought in item.</div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
