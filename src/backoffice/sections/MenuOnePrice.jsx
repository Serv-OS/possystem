// src/backoffice/sections/MenuOnePrice.jsx
//
// v5.11.109 (Peter, 28 Oct 2026): in a menu's settings in Menu manager, "Set every item on this menu
// to one price". Asks the amount, says how many items change, asks again before writing, then saves
// each item's menu price (pricing.menus[menuId].all, the "Default for this menu" field of the Per
// menu pricing box) through the store's normal save path (bulkUpdateMenuItems: one product at a
// time, compare and set, the honest summary at the end). Base and order type prices are never
// touched, so there is nothing to undo: the menu's schedule decides when the price applies.
// The rules are in lib/menuSetPrice.js.

import { useMemo, useState } from 'react';
import { useStore, bulkUpdateMenuItems, bulkSummaryWords } from '../../store';
import { money } from '../../lib/currency';
import { menuPriceTargets, pricingWithMenuPrice, readAmount, previewWords } from '../../lib/menuSetPrice';

const box = { background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:6, padding:'4px 7px', color:'var(--t1)', fontFamily:'inherit', fontSize:11, outline:'none' };

export default function MenuOnePrice({ menu, categoryLinks }) {
  const menuCategories = useStore(s => s.menuCategories);
  const menuItems = useStore(s => s.menuItems);
  const markBOChange = useStore(s => s.markBOChange);
  const showToast = useStore(s => s.showToast);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [run, setRun] = useState(null);   // { done, total } while saving
  const plan = useMemo(() => menuPriceTargets({ menuId: menu.id, categories: menuCategories, links: categoryLinks, items: menuItems }),
    [menu.id, menuCategories, categoryLinks, menuItems]);
  const amount = readAmount(text);
  const priceText = amount == null ? '' : money(amount);

  const apply = async () => {
    if (run || amount == null || !plan.targets.length) return;
    if (!window.confirm(`${previewWords(plan, menu.name, priceText)}\n\nSet them now?`)) return;
    setRun({ done: 0, total: plan.targets.length });
    const out = await bulkUpdateMenuItems(
      plan.targets.map(t => ({ id: t.id, patch: (row) => ({ pricing: pricingWithMenuPrice(row.pricing, menu.id, amount) }) })),
      { onProgress: (done, total) => setRun({ done, total }) });
    setRun(null);
    markBOChange();
    showToast(bulkSummaryWords(out, `${priceText} on ${menu.name}`), (out.failed || out.skipped || out.gone) ? 'error' : 'success', 9000);
    if (!out.failed && !out.skipped && !out.gone) { setOpen(false); setText(''); }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        style={{ width:'100%', padding:'4px 8px', marginTop:6, fontSize:10, fontWeight:600, borderRadius:5, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t2)', cursor:'pointer', fontFamily:'inherit' }}>
        Set every item on this menu to one price
      </button>
    );
  }
  return (
    <div style={{ marginTop:8, paddingTop:8, borderTop:'1px solid var(--bdr)' }}>
      <div style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>One price for this menu</div>
      <div style={{ display:'flex', gap:5, alignItems:'center', marginBottom:6 }}>
        <input autoFocus inputMode="decimal" value={text} onChange={e => setText(e.target.value)} placeholder="Price, e.g. 5.00"
          onKeyDown={e => { if (e.key === 'Enter') apply(); if (e.key === 'Escape') setOpen(false); }}
          style={{ ...box, flex:1 }} aria-label={`One price for every item on ${menu.name}`} />
        <button onClick={apply} disabled={!!run || amount == null || !plan.targets.length}
          style={{ padding:'4px 8px', fontSize:10, fontWeight:700, borderRadius:5, border:'none', background:'var(--acc)', color:'#0b0c10', cursor:'pointer', fontFamily:'inherit', opacity:(run || amount == null || !plan.targets.length) ? .45 : 1 }}>
          {run ? `${run.done} of ${run.total}` : 'Set'}
        </button>
        <button onClick={() => { setOpen(false); setText(''); }} disabled={!!run}
          style={{ padding:'4px 7px', fontSize:10, borderRadius:5, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t3)', cursor:'pointer', fontFamily:'inherit' }}>Cancel</button>
      </div>
      <div style={{ fontSize:10, color:'var(--t3)', lineHeight:1.45 }}>
        {amount == null
          ? (text.trim() ? 'Type a price like 5 or 4.50.' : `${plan.targets.length} ${plan.targets.length === 1 ? 'item is' : 'items are'} on this menu.`)
          : previewWords(plan, menu.name, priceText)}
        {' '}The menu's schedule decides when this price applies. Each item keeps its own prices for every other time.
      </div>
    </div>
  );
}
