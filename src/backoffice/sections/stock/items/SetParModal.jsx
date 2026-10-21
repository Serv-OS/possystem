/**
 * Bulk bar > Set par at sites (multi site stock Drop 1): type one par, or one per site. The numbers
 * are in each item's count pack (6 = 6 bottles of milk, 6 bags of beans) and are saved in base
 * units with stock_save_item_site, one call per item and site, at most 4 at a time. An empty box
 * keeps what the site has. Only sites where the item is stocked get a par.
 */

import { useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { countPackOf } from '../../../../lib/stock/packPrice';
import { bulkOutcome, itemsWords, parPlan, runLimited } from '../../../../lib/stock/itemListRules';
import { Btn, Modal, Segmented, SiteChecklist, Field, ui } from '../stockUi';

const FIELDS = [['par', 'Par'], ['reorder', 'Reorder at'], ['min', 'Min']];
const box = { ...ui.input, width: 90 };

export default function SetParModal({ items, sites, groups = [], onDone, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [how, setHow] = useState('one');
  const [chosen, setChosen] = useState(() => sites.map((s) => s.id));
  const [one, setOne] = useState({ par: '', reorder: '', min: '' });
  const [per, setPer] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const typed = how === 'one' ? Object.values(one).some((v) => v !== '') : Object.values(per).some((x) => Object.values(x || {}).some((v) => v !== ''));

  const run = async () => {
    const siteIds = how === 'one' ? chosen : sites.map((s) => s.id).filter((id) => Object.values(per[id] || {}).some((v) => v !== ''));
    const plan = parPlan(items, siteIds, how === 'one' ? one : per, { perSite: how === 'per', packOf: countPackOf });
    if (plan.error) { setError(plan.error); return; }
    setBusy(true); setError(''); setDone(0); setTotal(plan.calls.length);
    const results = await runLimited(plan.calls.map((c) => () => stockApi.saveItemSite(c.itemId, c.locationId, c.patch, null)), 4, (d) => setDone(d));
    setBusy(false);
    const out = bulkOutcome(results);
    const queued = results.flatMap((r) => r?.value?.queued || []);
    const where = new Set(plan.calls.map((c) => c.locationId)).size;
    if (out.failed) {
      setError(out.ok ? `${out.ok} saved. ${out.failed} did not save: ${out.first}` : out.first);
      if (!out.ok) return;
    }
    try {
      showToast?.(where === 1 ? `Par saved for ${sites.find((s) => s.id === plan.calls[0].locationId)?.name || 'the site'}.` : `Par saved for ${itemsWords(items)} at ${where} sites.`, out.failed ? 'warning' : 'success');
    } catch { /* no toast, no harm */ }
    if (!out.failed) onDone?.({ queued });
  };

  return (
    <Modal title="Set par at sites" sub="Type one par, or one per site." onClose={onClose} width={620} dirty={typed && !busy}
      footer={<>
        {busy && <span style={ui.sub}>{done} of {total} saved</span>}
        <span style={{ flex: 1 }} />
        <Btn onClick={onClose}>{error && !busy ? 'Close' : 'Cancel'}</Btn>
        <Btn kind="primary" disabled={busy || !typed} onClick={run}>{busy ? 'Saving…' : 'Save'}</Btn>
      </>}>
      <div style={{ marginBottom: 12 }}>
        <Segmented value={how} onChange={setHow} options={[{ value: 'one', label: 'One par for every ticked site' }, { value: 'per', label: 'One per site' }]} />
      </div>
      <div style={{ ...ui.sub, marginBottom: 12 }}>{itemsWords(items)}. In each item&apos;s count pack (6 means 6 bottles, or 6 bags). Leave a box empty to keep what each site has.</div>
      {how === 'one' ? (
        <>
          <div style={{ ...ui.row, flexWrap: 'wrap', gap: 12 }}>
            {FIELDS.map(([k, label]) => (
              <Field key={k} label={label} style={{ marginBottom: 8 }}>
                <input type="number" min="0" step="any" value={one[k]} aria-label={label} style={box}
                  onChange={(e) => setOne((o) => ({ ...o, [k]: e.target.value }))} />
              </Field>
            ))}
          </div>
          <Field label="Sites">
            <SiteChecklist sites={sites} value={chosen} onChange={setChosen} groups={groups} />
          </Field>
        </>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) repeat(3, 100px)', gap: 8, ...ui.label }}>
            <span>Site</span>{FIELDS.map(([k, label]) => <span key={k}>{label}</span>)}
          </div>
          {sites.map((s) => (
            <div key={s.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) repeat(3, 100px)', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{s.name}</span>
              {FIELDS.map(([k, label]) => (
                <input key={k} type="number" min="0" step="any" value={per[s.id]?.[k] ?? ''} aria-label={`${label} at ${s.name}`} style={box}
                  onChange={(e) => setPer((p) => ({ ...p, [s.id]: { ...(p[s.id] || {}), [k]: e.target.value } }))} />
              ))}
            </div>
          ))}
        </div>
      )}
      {error && <div style={{ ...ui.err, marginTop: 10 }}>{error}</div>}
    </Modal>
  );
}
