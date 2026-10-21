/**
 * The Sites grid on the company Stock items list (multi site stock Drop 1, mockup gridHtml): items
 * down, sites across. The Item column stays put while the sites scroll sideways. Each cell is a
 * tick (stocked there or not) and the price there; 'Not here' when it is not stocked there. With a
 * site group picked only that group's columns show (the sites prop is the picker's scope).
 *
 * The box holds the price the site is charged for the supplier's pack (stock_save_item_site
 * price_here). Grey = it follows the company price; type a price to set the price here; empty it
 * (or type the company price) to follow the company again. Under the box: that price in the pack
 * people count in ('£1.38 a bottle').
 *
 * Unticking asks the two choices first (UntickFlow, the same as the Sites pop up).
 */

import { useState } from 'react';
import { money } from '../../../../lib/currency';
import { packPrice, countPackOf } from '../../../../lib/stock/packPrice';
import { linkAt } from '../../../../lib/stock/itemListRules';
import { TableWrap, Th, Td, CellInput } from '../stockUi';
import { UntickFlow } from './SitesPopover';

const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--t1)', fontWeight: 700, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 13 };
const small = { fontSize: 11.5, color: 'var(--t4)', marginTop: 3, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };

/** The company price the box shows in grey while a site follows it (null when not known here). */
function followedPrice(row, link) {
  const same = !link?.supplier_here || link.supplier_here.supplier_item_id === row?.main?.supplier_item_id;
  return same && row?.main?.pack_price != null ? Number(row.main.pack_price) : null;
}

export default function SitesGrid({ rows, sites, onOpen, onTick, onPrice, canPrice = () => false, savingKey = null }) {
  const [untick, setUntick] = useState(null);
  const minWidth = 240 + 150 + (sites || []).length * 150;
  return (
    <>
      <TableWrap minWidth={minWidth}>
        <thead>
          <tr>
            <Th sticky>Item</Th>
            <Th>Company price</Th>
            {sites.map((s) => <Th key={s.id}>{s.name}</Th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const pack = countPackOf(row);
            const cur = row.main?.currency;
            const each = packPrice(row.main?.unit_price, pack, cur);
            return (
              <tr key={row.id}>
                <Td sticky strong>
                  <button type="button" style={linkBtn} onClick={() => onOpen(row.id)}>{row.name}</button>
                  {row.name_suffix && <span style={{ color: 'var(--t4)' }}> {row.name_suffix}</span>}
                </Td>
                <Td num>
                  {each || (row.main?.pack_price != null ? money(row.main.pack_price, cur) : <span style={{ color: 'var(--t4)' }}>No price</span>)}
                  {row.main?.pack_price != null && row.main?.pack_description && <div style={small}>{money(row.main.pack_price, cur)} for {row.main.pack_description}</div>}
                </Td>
                {sites.map((s) => {
                  const link = linkAt(row, s.id);
                  const on = !!link?.on;
                  const saving = savingKey === `${row.id}|${s.id}`;
                  const can = !row.archived_at && canPrice(s.id);
                  const follow = link?.price_here == null;
                  return (
                    <Td key={s.id}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={on} disabled={!can || saving}
                          aria-label={`${row.name} at ${s.name}`}
                          onChange={(e) => { if (e.target.checked) onTick(row, s.id, true); else setUntick({ row, site: s }); }} />
                        {on
                          ? <CellInput value={follow ? followedPrice(row, link) : Number(link.price_here)} follow={follow} places={2}
                              onCommit={(v) => onPrice(row, s.id, v)} disabled={!can || saving} width={84}
                              ariaLabel={`Price here at ${s.name}`} />
                          : <span style={{ color: 'var(--t4)', fontSize: 12.5 }}>Not here</span>}
                      </div>
                      {on && <div style={small}>{saving ? 'Saving…' : packPrice(link.unit_price, pack, cur)}</div>}
                    </Td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
      {untick && (
        <UntickFlow row={untick.row} site={untick.site}
          onTick={(siteId, on, how) => onTick(untick.row, siteId, on, how)}
          onClose={() => setUntick(null)} />
      )}
    </>
  );
}
