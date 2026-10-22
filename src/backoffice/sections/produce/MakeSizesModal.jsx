// src/backoffice/sections/produce/MakeSizesModal.jsx
//
// MULTI SITE STOCK Drop 2 (design D10, contract decision 6): sizes from one recipe by a factor
// ('Regular 1, Large 1.4'). One stock_make_sizes call makes every size in one transaction: one new
// company recipe per size ('<name> (<size name>)'), every line scaled by its factor, the same
// type, target and method, on the same sites with no till link (the Sites tab links each later).
// At most 10 sizes at a time.

import { useState } from 'react';
import { stockApi } from '../../../lib/stock/stockApi';
import { sizesPlan, scaleLines } from '../../../lib/stock/recipeRules';
import { Btn, Modal, Notice, ui } from '../stock/stockUi';

const NOTE = 'Each size becomes its own recipe with every amount scaled by its factor, on the same sites. Link each to its till product on the Sites tab.';

export default function MakeSizesModal({ detail, onDone, onClose }) {
  const recipe = detail?.recipe || {};
  const [rows, setRows] = useState([{ name: 'Regular', factor: '1' }]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const upd = (i, patch) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const remove = (i) => setRows((r) => r.filter((_, j) => j !== i));
  const lines = detail?.lines || [];
  const sample = rows.find((r) => Number(r.factor) > 0 && Number(r.factor) !== 1) || null;
  const preview = sample && lines[0] ? scaleLines([lines[0]], sample.factor)[0] : null;

  const run = async () => {
    setProblem(null);
    const { sizes, error } = sizesPlan(rows);
    if (error) { setProblem(error); return; }
    setBusy(true);
    const r = await stockApi.makeSizes(recipe.id, sizes, detail?.row_version ?? recipe.row_version ?? null);
    setBusy(false);
    if (r.error) { setProblem(r.error.message); return; }
    onDone?.(r.data);
  };

  return (
    <Modal title={`Make sizes from ${recipe.name || 'this recipe'}`} sub={NOTE} onClose={busy ? () => {} : onClose} width={560} dirty={!busy && rows.some((r) => r.name !== 'Regular' || r.factor !== '1')}
      footer={<><span style={{ flex: 1 }} /><Btn onClick={onClose} disabled={busy}>Cancel</Btn><Btn kind="primary" onClick={run} disabled={busy || !rows.length}>{busy ? 'Making…' : 'Make sizes'}</Btn></>}>
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px 40px', gap: 8, alignItems: 'center' }}>
          <span style={ui.label}>Size name</span><span style={ui.label}>Factor</span><span />
          {rows.map((r, i) => (
            <RowFields key={i} row={r} onChange={(patch) => upd(i, patch)} onRemove={rows.length > 1 ? () => remove(i) : null} disabled={busy} />
          ))}
        </div>
        {rows.length < 10 && <div><Btn small kind="soft" disabled={busy} onClick={() => setRows((r) => [...r, { name: '', factor: '' }])}>+ Add a size</Btn></div>}
        {preview && lines[0] && (
          <div style={ui.sub}>{sample.name || 'That size'} at {sample.factor}: {lines[0].name} {lines[0].qty} becomes {preview.qty} {lines[0].pack_id ? (lines[0].pack_name || 'pack') : lines[0].unit}.</div>
        )}
        {problem && <Notice tone="bad">{problem}</Notice>}
      </div>
    </Modal>
  );
}

function RowFields({ row, onChange, onRemove, disabled }) {
  return (
    <>
      <input value={row.name} disabled={disabled} onChange={(e) => onChange({ name: e.target.value })} style={ui.input} aria-label="Size name" placeholder="Large" />
      <input type="number" min="0" step="any" value={row.factor} disabled={disabled} onChange={(e) => onChange({ factor: e.target.value })} style={ui.input} aria-label="Factor" placeholder="1.4" />
      {onRemove ? <Btn small kind="ghost" disabled={disabled} onClick={onRemove} aria-label="Remove this size">x</Btn> : <span />}
    </>
  );
}
