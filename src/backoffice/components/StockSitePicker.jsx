// src/backoffice/components/StockSitePicker.jsx
//
// MULTI SITE STOCK (v5.11.89, Drop 1, map 3.1, mockup pickerHtml): the one site picker in the Back
// Office top bar, shown by BackOfficeApp only for a multi site company on an Inventory, Produce or
// Purchasing screen (never Daily counts, never Reports). One select: All sites (N), the site groups,
// the sites, and Show closed sites when the company has closed sites in reach. A login with one site
// sees it locked: "Your site only".
//
// It only moves the stock screens' scope. It NEVER writes rpos-bo-location, never calls
// setResolvedLocationId and never reloads: that is the venue switcher (LocationSwitcher.jsx).

import { useStockScope } from '../StockScope';

const SHOW_CLOSED = '__show_closed';
const HIDE_CLOSED = '__hide_closed';

const wrap = { display: 'inline-flex', alignItems: 'center', gap: 8, marginRight: 6 };
const label = { fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' };
const select = {
  padding: '6px 10px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)',
  fontSize: 13, fontWeight: 600, fontFamily: 'inherit', outline: 'none', maxWidth: 240,
};
const lock = { fontSize: 11.5, color: 'var(--t4)' };

const valueOf = (choice) => {
  if (!choice || choice.kind === 'all') return 'all';
  return `${choice.kind === 'group' ? 'g' : 's'}:${choice.id}`;
};

export default function StockSitePicker() {
  const sc = useStockScope();
  if (!sc.ready || !sc.multi) return null;
  const open = sc.sites;
  const closed = sc.closedSites;
  // A login with exactly one site: nothing to choose.
  if (open.length + closed.length <= 1) {
    return (
      <div style={wrap} data-testid="stock-site-picker">
        <label htmlFor="stock-site-picker" style={label}>Sites</label>
        <select id="stock-site-picker" disabled style={{ ...select, opacity: 0.7 }} value="one">
          <option value="one">{open[0]?.name || closed[0]?.name || 'Your site'}</option>
        </select>
        <span style={lock}>Your site only</span>
      </div>
    );
  }
  const allCount = open.length + (sc.showClosed ? closed.length : 0);
  const onChange = (e) => {
    const v = e.target.value;
    if (v === SHOW_CLOSED) { sc.setShowClosed(true); return; }
    if (v === HIDE_CLOSED) {
      sc.setShowClosed(false);
      if (sc.choice?.closed) sc.setChoice({ kind: 'all' });
      return;
    }
    if (v === 'all') { sc.setChoice({ kind: 'all' }); return; }
    const id = v.slice(2);
    if (v.startsWith('g:')) { sc.setChoice({ kind: 'group', id }); return; }
    const isClosed = closed.some((s) => s.id === id);
    sc.setChoice(isClosed ? { kind: 'site', id, closed: true } : { kind: 'site', id });
  };
  return (
    <div style={wrap} data-testid="stock-site-picker">
      <label htmlFor="stock-site-picker" style={label}>Sites</label>
      <select id="stock-site-picker" value={valueOf(sc.choice)} onChange={onChange} style={select}>
        <option value="all">{`All sites (${allCount})`}</option>
        {sc.groups.length > 0 && (
          <optgroup label="Site groups">
            {sc.groups.map((g) => {
              const n = g.locationIds.filter((id) => open.some((s) => s.id === id) || (sc.showClosed && closed.some((s) => s.id === id))).length;
              return <option key={g.id} value={`g:${g.id}`}>{`${g.name} (${n})`}</option>;
            })}
          </optgroup>
        )}
        <optgroup label="Sites">
          {open.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
          {sc.showClosed && closed.map((s) => <option key={s.id} value={`s:${s.id}`}>{`${s.name} (closed)`}</option>)}
        </optgroup>
        {closed.length > 0 && (
          <option value={sc.showClosed ? HIDE_CLOSED : SHOW_CLOSED}>{sc.showClosed ? 'Hide closed sites' : 'Show closed sites'}</option>
        )}
      </select>
    </div>
  );
}
