// src/backoffice/sections/msm/MsmAddToProducts.jsx
//
// MULTI SITE MENU, ROUND 2 (v5.11.75): "Add to products" for an option group (design 1.7). A
// category tree with ticks, search, and "Select all in Hot drinks". A product with sizes means all
// of its sizes (options belong on sizes: lib/menu/modifierAttach.js); a size can be ticked on its
// own. Ticked products that already have the group stay ticked; unticking one takes the group off
// it. Nothing is staged here: the group editor puts the result in its own summary before
// "Add to draft".

import { useMemo, useState } from 'react';
import { productPickTree } from '../../../lib/msm/msmGroupView';
import { categoryTree } from '../../../lib/msm/msmGrid';
import { Btn, Modal, Notice } from './msmUi';
import { ui } from './msmStyle';

/**
 *   ix, groupName
 *   groupId         the group (its current products come ticked)
 *   initial         { add: [ids], off: [ids] } already picked in the editor (not saved yet)
 *   onApply({ add, off })
 */
export default function MsmAddToProducts({ ix, groupId, groupName, initial = null, onApply, onClose }) {
  const tree = useMemo(() => categoryTree(ix), [ix]);
  const [search, setSearch] = useState('');
  const full = useMemo(() => productPickTree(ix, tree, groupId, ''), [ix, tree, groupId]);
  // Which products have the group now (a product row counts when it or all its sizes have it).
  const hasNow = useMemo(() => {
    const m = new Set();
    for (const c of full) for (const p of c.products) { if (p.has) m.add(p.product.id); for (const s of p.sizes) if (s.has) m.add(s.product.id); }
    return m;
  }, [full]);
  const [ticked, setTicked] = useState(() => {
    const s = new Set(hasNow);
    for (const id of initial?.add || []) s.add(id);
    for (const id of initial?.off || []) s.delete(id);
    return s;
  });
  const shown = useMemo(() => productPickTree(ix, tree, groupId, search), [ix, tree, groupId, search]);

  const flip = (ids, on) => setTicked((t) => { const n = new Set(t); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });
  const idsOf = (p) => [p.product.id, ...p.sizes.map((s) => s.product.id)];
  const add = [...ticked].filter((id) => !hasNow.has(id));
  const off = [...hasNow].filter((id) => !ticked.has(id));
  const count = [...ticked].filter((id) => ix.products.has(id) && !(ix.sizes.get(id) || []).length).length;

  return (
    <Modal title={groupName ? `Which products ask "${groupName}"?` : 'Which products ask this option group?'} width={640} onClose={onClose}
      sub="Tick the products that should ask this question. A product with sizes means every size."
      footer={(
        <>
          <div style={{ flex: 1, fontSize: 13, fontWeight: 700 }}>
            {add.length || off.length
              ? `${add.length ? `Added to ${add.length}` : ''}${add.length && off.length ? ', ' : ''}${off.length ? `taken off ${off.length}` : ''}. ${count} product${count === 1 ? '' : 's'} will ask it.`
              : `${count} product${count === 1 ? '' : 's'} ask it.`}
          </div>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" onClick={() => { onApply({ add, off }); onClose(); }}>Done</Btn>
        </>
      )}>
      <input aria-label="Find a product" autoFocus style={{ ...ui.input, marginBottom: 12 }} placeholder="Find a product" value={search} onChange={(e) => setSearch(e.target.value)} />
      {!shown.length && <Notice>{search ? `No products match "${search}".` : 'No products yet.'}</Notice>}
      {shown.map((c) => {
        const ids = c.products.flatMap(idsOf);
        const all = ids.every((id) => ticked.has(id));
        return (
          <div key={c.category.id} style={{ marginBottom: 10, paddingLeft: c.depth * 14 }}>
            <div style={{ ...ui.row, padding: '6px 0', borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ flex: 1, fontSize: 13, fontWeight: 800 }}>{c.category.label}</div>
              <Btn small kind="link" onClick={() => flip(ids, !all)}>{all ? `Untick all in ${c.category.label}` : `Select all in ${c.category.label}`}</Btn>
            </div>
            {c.products.map((p) => {
              const pids = idsOf(p);
              const on = pids.every((id) => ticked.has(id));
              const some = !on && pids.some((id) => ticked.has(id));
              return (
                <div key={p.product.id}>
                  <label style={{ ...ui.row, padding: '5px 4px', fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} ref={(el) => { if (el) el.indeterminate = some; }} onChange={() => flip(pids, !on)} />
                    <span style={{ flex: 1 }}>{p.product.menu_name || p.product.name}</span>
                    {p.sizes.length > 0 && <span style={ui.sub}>{p.sizes.length} size{p.sizes.length === 1 ? '' : 's'}</span>}
                  </label>
                  {p.sizes.map((s) => (
                    <label key={s.product.id} style={{ ...ui.row, padding: '3px 4px 3px 28px', fontSize: 12.5, cursor: 'pointer', color: 'var(--t2)' }}>
                      <input type="checkbox" checked={ticked.has(s.product.id)} onChange={() => flip([s.product.id], !ticked.has(s.product.id))} />
                      <span>{s.product.menu_name || s.product.name}</span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </Modal>
  );
}
