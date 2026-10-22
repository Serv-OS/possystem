// src/surfaces/manager/ManagerRecipeCard.jsx
//
// Recipe cards on the phone (v5.11.91, multi site stock Drop 2, contract 3.6 and map 4.23). Opened
// from the Kitchen tab. Any active staff PIN at the venue opens it (as the other stock reads);
// search a product with a live recipe link (the snapshot's kitchen.recipes), tap it, and the card
// comes back through manager-approve 'stock.recipe_card' (the service role reads
// stock_recipe_card for THIS venue only). The build, the method, allergens, may contain, kcal and
// use by; never a cost or a price. Nothing is written.

import { useMemo, useState } from 'react';
import { managerApprove } from '../../lib/manager/data';
import { buildRows, cardSteps, cardKcalWords, useByWords as cardUseByWords, portionHeading, searchRecipes } from '../../lib/recipeCard';
import { ALLERGENS } from '../../data/seed';
import { Header, mono } from './ui';
import { useLayout } from './useLayout';

const box = { width: '100%', padding: '11px 12px', borderRadius: 11, border: '1px solid var(--bdr)', background: 'var(--inset, transparent)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };
const btn = (tone = 'var(--t1)') => ({ padding: '11px 16px', borderRadius: 12, border: '1px solid var(--bdr)', cursor: 'pointer', color: tone, fontWeight: 800, fontSize: 14, fontFamily: 'inherit', background: 'transparent' });
const labelOf = (id) => ALLERGENS.find((a) => a.id === id)?.label || (id ? String(id).charAt(0).toUpperCase() + String(id).slice(1) : '');
const labels = (ids) => (Array.isArray(ids) ? ids : []).map(labelOf).filter(Boolean).join(', ');

export default function ManagerRecipeCard({ ctx, onClose }) {
  const { snap, loc } = ctx;
  const L = useLayout();
  const [pin, setPin] = useState('');
  const [pinEntry, setPinEntry] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState(null);   // { menu_item_id, name }
  const [card, setCard] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const products = Array.isArray(snap?.kitchen?.recipes) ? snap.kitchen.recipes : [];
  const shown = useMemo(() => searchRecipes(products, search), [products, search]);

  const open = async (p) => {
    setPicked(p); setCard(null); setErr(''); setBusy(true);
    const r = await managerApprove(loc, pin, 'stock.recipe_card', p.menu_item_id);
    setBusy(false);
    if (!r?.ok) { setErr(r?.error || 'Could not read the recipe card'); return; }
    if (!r.card) { setErr('No recipe card for this product yet.'); return; }
    setCard(r.card);
  };

  if (!pin) {
    return (
      <div style={L.s.page2}>
        <Header title="Recipe cards" sub="Staff PIN" />
        <div className="sv-glass" style={{ padding: 16, marginTop: 12, display: 'grid', gap: 10, ...L.s.span }}>
          <div style={{ fontSize: 13, color: 'var(--t3)' }}>Type your PIN to see the recipe cards for this venue.</div>
          <input type="password" inputMode="numeric" autoComplete="off" value={pinEntry} onChange={(e) => setPinEntry(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="PIN" style={{ ...box, ...mono, letterSpacing: '.2em' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => pinEntry && setPin(pinEntry)} disabled={!pinEntry} style={{ ...btn('var(--acc)'), flex: 1 }}>Continue</button>
            <button onClick={onClose} style={btn('var(--t3)')}>Back</button>
          </div>
        </div>
      </div>
    );
  }

  if (picked) {
    const rows = buildRows(card);
    const steps = cardSteps(card?.method);
    const kcal = cardKcalWords(card);
    const useBy = cardUseByWords(card);
    return (
      <div style={L.s.page2}>
        <Header title={card?.name || picked.name} sub={card?.portion_words || 'Recipe card'} />
        <div className="sv-glass" style={{ padding: 16, marginTop: 12, display: 'grid', gap: 14, ...L.s.span }}>
          {busy && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading the recipe card.</div>}
          {err && <div style={{ fontSize: 13, color: 'var(--red)' }}>{err}</div>}
          {card && (
            <>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>{portionHeading(card)}</div>
                {rows.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 6 }}>No lines on this recipe.</div>}
                {rows.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid var(--bdr)' }}>
                    <span style={{ ...mono, fontSize: 13, fontWeight: 800, color: 'var(--acc)', minWidth: 72, textAlign: 'right', flex: 'none' }}>{r.words}</span>
                    <span style={{ fontSize: 14, color: 'var(--t1)', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{r.name}</span>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', ...mono }}>Method</div>
                {steps.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 6 }}>{card.restricted ? 'The method is kept by head office.' : 'No method written yet.'}</div>}
                {steps.map((s, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                    <span style={{ ...mono, fontSize: 12, fontWeight: 800, color: 'var(--t3)', minWidth: 20, flex: 'none', paddingTop: 2 }}>{i + 1}</span>
                    <span style={{ fontSize: 14, color: 'var(--t1)', lineHeight: 1.5, flex: 1, minWidth: 0 }}>{s}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'grid', gap: 4, fontSize: 13, color: 'var(--t2)' }}>
                <div style={{ fontWeight: 700, color: 'var(--orn, #b45309)' }}>Allergens: {labels(card.allergens) || 'none'}</div>
                {Array.isArray(card.may_contain) && card.may_contain.length > 0 && <div>May contain: {labels(card.may_contain)}</div>}
                {kcal && <div>{kcal} a portion</div>}
                {useBy && <div>{useBy}</div>}
                <div style={{ color: 'var(--t3)' }}>{card.signed_off ? 'Allergens checked at this site.' : 'Allergens not checked at this site yet.'}</div>
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { setPicked(null); setCard(null); setErr(''); }} style={{ ...btn('var(--t1)'), flex: 1 }}>Another product</button>
            <button onClick={onClose} style={btn('var(--t3)')}>Back to Kitchen</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={L.s.page2}>
      <Header title="Recipe cards" sub={`${products.length} product${products.length === 1 ? '' : 's'} with a recipe`} />
      <div className="sv-glass" style={{ padding: 16, marginTop: 12, display: 'grid', gap: 10, ...L.s.span }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search a product" style={box} autoFocus />
        {products.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No product at this venue has a recipe linked yet.</div>}
        {products.length > 0 && shown.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Nothing matches.</div>}
        <div style={{ display: 'grid', gap: 6 }}>
          {shown.map((p) => (
            <button key={p.menu_item_id} onClick={() => open(p)} className="sv-glass"
              style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--bdr)', cursor: 'pointer', color: 'var(--t1)', fontWeight: 700, fontSize: 14, fontFamily: 'inherit', ...L.s.hit }}>
              {p.name}
            </button>
          ))}
        </div>
        {err && <div style={{ fontSize: 13, color: 'var(--red)' }}>{err}</div>}
        <button onClick={onClose} style={btn('var(--t3)')}>Back to Kitchen</button>
      </div>
    </div>
  );
}
