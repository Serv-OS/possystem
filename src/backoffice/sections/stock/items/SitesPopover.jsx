/**
 * The Sites column pop up on the company Stock items list (multi site stock Drop 1, mockup
 * "Sites for <item>"): the sites text as a pill; inside, a tick per site with the price there or
 * 'Not here', 'Open the Sites tab' and 'Done'.
 *
 * Ticking a site on calls onTick(siteId, true) (stock_set_item_sites: the site's row is made at
 * once with on hand 0). Unticking first reads the item once (stock_item_detail) for what that site
 * holds and which recipes there use it, then asks the two choices (UntickChoiceModal) and calls
 * onTick(siteId, false, 'runout' | 'remove').
 *
 * UntickFlow (also used by the Sites grid) is that read and that question.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { packPrice, countPackOf } from '../../../../lib/stock/packPrice';
import { linkAt, rowSitesText, untickFacts } from '../../../../lib/stock/itemListRules';
import { Btn, Popover, ui } from '../stockUi';
import UntickChoiceModal from './UntickChoiceModal';

/** Take one item off one site: read what it holds there, then ask Stop ordering or Remove now. */
export function UntickFlow({ row, site, onTick, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [facts, setFacts] = useState(null);
  const [busy, setBusy] = useState(false);
  // The parent hands a new onClose each render; the one read below must run once per item and site.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    let live = true;
    stockApi.itemDetail(row.id).then((r) => {
      if (!live) return;
      if (r.error) { try { showToast?.(r.error.message, 'error'); } catch { /* no toast, no harm */ } closeRef.current?.(); return; }
      setFacts(untickFacts(r.data, site.id));
    });
    return () => { live = false; };
  }, [row.id, site.id, showToast]);
  const choose = async (how) => {
    setBusy(true);
    try { await onTick(site.id, false, how); } finally { setBusy(false); }
    onClose();
  };
  return (
    <UntickChoiceModal itemName={row.name} siteName={site.name}
      holds={facts?.holds ?? null} usedBy={facts?.usedBy || []} busy={busy || !facts}
      onRunOut={() => choose('runout')} onRemoveNow={() => choose('remove')} onClose={onClose} />
  );
}

export default function SitesPopover({ row, sites, onTick, onOpenSitesTab, canTick = () => false }) {
  const [busySite, setBusySite] = useState(null);
  const [untick, setUntick] = useState(null);
  const label = rowSitesText(row, { sites });
  const pack = countPackOf(row);

  const tickOn = async (siteId) => {
    setBusySite(siteId);
    try { await onTick(siteId, true); } finally { setBusySite(null); }
  };

  return (
    <>
      <Popover label={label} width={320} ariaLabel={`Sites for ${row.name}: ${label}`}
        btnStyle={{ borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, background: 'var(--bg2)', color: 'var(--t1)' }}>
        {(close) => (
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>Sites for {row.name}</div>
            <div style={{ display: 'grid', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
              {sites.map((s) => {
                const link = linkAt(row, s.id);
                const on = !!link?.on;
                const can = canTick(s.id);
                const price = on ? packPrice(link.unit_price, pack, row.main?.currency) : '';
                return (
                  <label key={s.id} style={{ ...ui.row, justifyContent: 'space-between', padding: '6px 2px', borderBottom: '1px solid var(--bdr)', fontSize: 13, cursor: can ? 'pointer' : 'default', opacity: can ? 1 : 0.55 }}>
                    <span style={ui.row}>
                      <input type="checkbox" checked={on} disabled={!can || busySite === s.id}
                        aria-label={`${row.name} at ${s.name}`}
                        onChange={(e) => {
                          if (e.target.checked) tickOn(s.id);
                          else { close(); setUntick(s); }
                        }} />
                      <span>{s.name}</span>
                    </span>
                    <span style={{ fontSize: 12, color: on ? 'var(--t2)' : 'var(--t4)', fontVariantNumeric: 'tabular-nums' }}>
                      {busySite === s.id ? 'Saving…' : on ? (price || 'No price yet') : 'Not here'}
                    </span>
                  </label>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
              <Btn small onClick={() => { close(); onOpenSitesTab?.(); }}>Open the Sites tab</Btn>
              <Btn small kind="primary" onClick={close}>Done</Btn>
            </div>
          </div>
        )}
      </Popover>
      {untick && <UntickFlow row={row} site={untick} onTick={onTick} onClose={() => setUntick(null)} />}
    </>
  );
}
