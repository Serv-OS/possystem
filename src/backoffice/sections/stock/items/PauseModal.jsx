/**
 * Pause (multi site stock Drop 1): at chosen sites or everywhere, from and until (until empty =
 * until you unpause). Paused means not suggested and cannot be ordered, but still counted and still
 * taken off by sales (stock_pause_items: it never touches a count, a sale or any number).
 *
 * Used by the Stock items bulk bar (section 'inventory') and by a supplier's Items tab, Pause at
 * sites (section 'purchasing').
 */

import { useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { pauseWords } from '../../../../lib/stock/pauseRules';
import { dateBoxWords, itemsWords, pausePlan } from '../../../../lib/stock/itemListRules';
import { useStockScope } from '../../../StockScope';
import { Btn, Modal, Segmented, SiteChecklist, Field, ui } from '../stockUi';

const dateBox = { ...ui.input, width: 170 };

/**
 * A date box with its state in words beside it. Safari draws today's date in grey in an EMPTY date
 * box, so the box alone cannot say whether a day is set: the line under it does, and a set box
 * gets the green border.
 */
function DateBox({ label, value, onChange, min, set, empty }) {
  return (
    <Field label={label}>
      <input type="date" value={value} min={min} onChange={(e) => onChange(e.target.value)} aria-label={label}
        style={{ ...dateBox, ...(value ? { border: '1px solid var(--acc)' } : {}) }} />
      <div style={{ ...ui.row, gap: 6, marginTop: 4, fontSize: 12, color: value ? 'var(--t1)' : 'var(--t3)', fontWeight: value ? 700 : 400 }}>
        <span>{dateBoxWords(value, { set, empty })}</span>
        {value && <Btn kind="link" small onClick={() => onChange('')}>Clear</Btn>}
      </div>
    </Field>
  );
}

export default function PauseModal({ items, sites, groups = [], onDone, onClose, section = 'inventory' }) {
  const showToast = useStore((s) => s.showToast);
  // Pausing everywhere needs company rights (the database refuses it otherwise), so only a company
  // editor in this section is offered it; a Their sites, full control login pauses at its own sites.
  const canEverywhere = !!useStockScope().canEditCompany(section);
  const [where, setWhere] = useState('sites');
  const [chosen, setChosen] = useState([]);
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (paused) => {
    const plan = pausePlan({ items, where, siteIds: chosen, from, until, paused, section });
    if (plan.error) { setError(plan.error); return; }
    setBusy(true); setError('');
    const r = await stockApi.pauseItems(plan.args);
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    const everywhere = where === 'everywhere';
    const siteName = everywhere ? null : chosen.length === 1 ? (sites.find((s) => s.id === chosen[0])?.name || '1 site') : `${chosen.length} sites`;
    const words = paused ? pauseWords({ siteName, everywhere, until: until || null }) : (everywhere ? 'Unpaused everywhere' : `Unpaused at ${siteName}`);
    try { showToast?.(`${itemsWords(items)}: ${words}.`, 'success'); } catch { /* no toast, no harm */ }
    onDone?.(r);
  };

  return (
    <Modal title="Pause" sub={itemsWords(items)} onClose={onClose} width={560} dirty={(chosen.length > 0 || !!from || !!until) && !busy}
      footer={<>
        <span style={{ flex: 1 }} />
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn disabled={busy} onClick={() => run(false)}>Unpause</Btn>
        <Btn kind="primary" disabled={busy} onClick={() => run(true)}>{busy ? 'Saving…' : 'Pause'}</Btn>
      </>}>
      {canEverywhere && (
        <div style={{ marginBottom: 12 }}>
          <Segmented value={where} onChange={setWhere} options={[{ value: 'sites', label: 'At chosen sites' }, { value: 'everywhere', label: 'Everywhere' }]} />
        </div>
      )}
      {where === 'sites' && (
        <Field label="Sites">
          <SiteChecklist sites={sites} value={chosen} onChange={setChosen} groups={groups} />
        </Field>
      )}
      <div style={{ ...ui.row, flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        <DateBox label="From" value={from} onChange={setFrom} set="From" empty="Empty = from now." />
        <DateBox label="Until" value={until} onChange={setUntil} min={from || undefined} set="Until" empty="Empty = until you unpause." />
      </div>
      <div style={ui.sub}>A paused item is not suggested and cannot be ordered there. It is still counted and still taken off by sales.</div>
      {error && <div style={{ ...ui.err, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
