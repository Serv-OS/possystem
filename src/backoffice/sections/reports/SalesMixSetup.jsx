// "Set up sales groups" (8 Oct 2026, D5): a panel over the Sales mix report that gives each of
// the signed in site's TOP LEVEL categories a group (Food, Drinks, Alcohol, Retail, Other
// sales, or any words). It writes each category's Accounting group through the store's
// updateCategory, the very call Menu Manager's Edit category makes, so sync, sharing and the
// second step fence behave exactly as a Menu Manager edit. Sub categories need no write: the
// resolver follows their parent. Changes are STAGED and saved with one button (13 rows written
// one by one would mean 13 toasts and no way back).
//
// It writes ONLY this site's rows (the writer is venue scoped). Shared categories at other
// sites keep their own text until each site sets it; the panel says so in one line.
//
//   open, onClose    shown or not; onClose runs on Cancel, the cross, the backdrop, Escape and a full save
//   siteName         the signed in site's name
//   categories       the store's menuCategories (the rows updateCategory edits)
//   mapping          the site's Xero mapping ({} when none): a category it overrides is flagged
//   setup            salesMix.setupRows(...) for the period on screen (money per row)
//   fmt              money words
//   auto             the panel opened by itself (more than half of item sales had no group)
//   onSaved          optional: runs after a full save, before onClose

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { Callout, PrimaryBtn, Tag } from './reportKit';
import { SETUP_OPTIONS } from '../../../../supabase/functions/_shared/salesMix.js';
import { groupKeyOf } from '../../../../supabase/functions/_shared/accountingGroups.js';
import {
  CUSTOM_OPTION, setupOptionList, setupValueFor, stagedChanges, saveLabel, savedToast, notSavedToast,
  saveFailure, setupStatus, subWords, subOwnWords,
} from '../../../lib/salesMixView.js';

const NONE = Object.freeze([]);
const inp = { background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:9, padding:'8px 11px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box' };
const th = { fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', textAlign:'left', padding:'8px 10px', borderBottom:'1px solid var(--bdr)' };
const td = { padding:'10px 10px', borderBottom:'1px solid var(--bdr)', verticalAlign:'top', fontSize:13 };
const small = { fontSize:11, color:'var(--t4)', marginTop:3, lineHeight:1.4 };
const secondaryBtn = { padding:'9px 14px', borderRadius:12, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:13, fontWeight:600 };

// `mapping` is not read here: a Xero override is already flagged on each setup row (row.xero).
export default function SalesMixSetup({ open, onClose, siteName = '', categories = [], setup, fmt, auto = false, onSaved }) {
  const updateCategory = useStore((s) => s.updateCategory);
  const markBOChange = useStore((s) => s.markBOChange);
  const showToast = useStore((s) => s.showToast);
  const rows = useMemo(() => setup?.rows || NONE, [setup]);
  // staged[id] = the text the row will be saved with; custom[id] = a text box is open for the row
  const [staged, setStaged] = useState({});
  const [custom, setCustom] = useState({});
  const [failures, setFailures] = useState({});
  const [saving, setSaving] = useState(false);
  // SETUP_OPTIONS: No group yet, Food, Drinks, Alcohol, Retail, Other sales (writes the text 'Other').
  const options = useMemo(() => setupOptionList(rows, SETUP_OPTIONS), [rows]);
  const changes = useMemo(() => stagedChanges(rows, staged), [rows, staged]);
  const status = setupStatus(setup);

  // Escape closes, as every Back Office modal does.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const valueOf = (row) => (row.id in staged ? staged[row.id] : row.text);
  const pick = (row, value) => {
    if (value === CUSTOM_OPTION) { setCustom((c) => ({ ...c, [row.id]: valueOf(row) })); return; }
    setStaged((s) => ({ ...s, [row.id]: value }));
  };
  const commitCustom = (row) => {
    const text = String(custom[row.id] ?? '').trim();
    setCustom((c) => { const n = { ...c }; delete n[row.id]; return n; });
    if (!text) return;                       // empty: back to the previous value
    if (groupKeyOf(text) === '') return;     // refused in the box already (see below)
    setStaged((s) => ({ ...s, [row.id]: text }));
  };

  const save = async () => {
    if (!changes.length || saving) return;
    setSaving(true);
    const failed = {};
    let landed = 0;
    for (const ch of changes) {
      const storeRow = categories.find((c) => String(c.id) === String(ch.id)) || null;
      let r;
      try {
        r = await updateCategory(ch.id, { accountingGroup: ch.text }, { opened: storeRow });
      } catch {
        r = { ok: false, outcome: 'error' };
      }
      const why = saveFailure(r);
      if (why) failed[ch.id] = why; else landed += 1;
    }
    setSaving(false);
    if (landed) markBOChange?.();
    const k = Object.keys(failed).length;
    if (!k) {
      showToast?.(savedToast(landed), 'success');
      setStaged({});
      onSaved?.();
      onClose?.();
      return;
    }
    setFailures(failed);
    // Keep only the staged rows that did not land, so Save tries them again.
    setStaged((s) => Object.fromEntries(Object.entries(s).filter(([id]) => failed[id])));
    showToast?.(notSavedToast(k, changes.length), 'warn', 5000);
  };

  const close = () => { if (!saving) onClose?.(); };

  return (
    <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-label="Set up sales groups" style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:18, width:'100%', maxWidth:640, maxHeight:'88vh', overflow:'auto', padding:20, boxShadow:'var(--sh3)' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
          <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>Set up sales groups</div>
          <button onClick={close} aria-label="Close" style={{ background:'none', border:'none', color:'var(--t4)', cursor:'pointer', fontSize:20, lineHeight:1 }}>×</button>
        </div>
        {auto && <Callout><b>More than half of item sales have no group yet.</b></Callout>}
        <div style={{ fontSize:12.5, color:'var(--t3)', lineHeight:1.5 }}>
          Pick a group for each top level category. Sub categories follow their parent. The same groups show in Sales mix, the Business summary, the Z report, the owner app and the Xero invoice.
        </div>
        <div style={{ fontSize:11.5, color:'var(--t4)', marginTop:6 }}>{siteName ? `${siteName} · ` : ''}Set at this site. Other sites set their own groups.</div>

        {rows.length === 0 ? (
          <>
            <div style={{ fontSize:13, color:'var(--t2)', margin:'18px 0' }}>No categories at this site yet. Add them in Menu Manager first.</div>
            <div style={{ display:'flex', justifyContent:'flex-end' }}><button onClick={close} style={secondaryBtn}>Cancel</button></div>
          </>
        ) : (
          <>
            <div style={{ fontSize:12.5, margin:'14px 0 10px', color: status.ok ? 'var(--grn)' : 'var(--amber, #F5A623)' }}>
              <b>{status.strong}</b>{status.rest}
            </div>

            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Category</th>
                  <th style={{ ...th, textAlign:'right' }}>Sales in this period</th>
                  <th style={{ ...th, width:'40%' }}>Group</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const value = valueOf(row);
                  const changed = value !== row.text;
                  const editing = row.id in custom;
                  const customText = custom[row.id] ?? '';
                  const bad = editing && customText.trim() !== '' && groupKeyOf(customText) === '';
                  return (
                    <tr key={row.id} style={{ borderLeft: changed ? '3px solid var(--acc)' : '3px solid transparent' }}>
                      <td style={td}>
                        <div style={{ color:'var(--t1)' }}>{row.label}</div>
                        <div style={small}>{subWords(row)}</div>
                        {row.subOwn > 0 && <div style={small}>{subOwnWords(row)}</div>}
                      </td>
                      <td style={{ ...td, textAlign:'right', fontFamily:'var(--font-mono)', color:'var(--t2)' }}>
                        {row.money > 0 ? (
                          <>
                            <div>{fmt ? fmt(row.money) : row.money}</div>
                            <div style={small}>{row.share}%</div>
                          </>
                        ) : null}
                      </td>
                      <td style={td}>
                        {editing ? (
                          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                            <input
                              style={inp} value={customText} maxLength={40} autoFocus
                              placeholder="Group name, for example Hot drinks"
                              aria-label={`Group name for ${row.label}`}
                              onChange={(e) => setCustom((c) => ({ ...c, [row.id]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!bad) commitCustom(row); } }}
                              onBlur={() => { if (!bad) commitCustom(row); }}
                            />
                            <button onClick={() => { if (!bad) commitCustom(row); }} style={{ ...secondaryBtn, padding:'7px 10px', fontSize:12 }}>Done</button>
                          </div>
                        ) : (
                          <select value={setupValueFor(value)} onChange={(e) => pick(row, e.target.value)} style={{ ...inp, cursor:'pointer' }} aria-label={`Group for ${row.label}`}>
                            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        )}
                        {bad && <div style={small}>Needs letters or numbers</div>}
                        {row.xero && (
                          <div style={{ ...small, display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                            <Tag tone="warn" label="Set in Xero step 3, that wins"/>
                            <span>({row.xero.name})</span>
                          </div>
                        )}
                        {failures[row.id] && <div style={{ ...small, color:'var(--red)' }}>{failures[row.id]}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div style={{ display:'flex', alignItems:'center', gap:12, marginTop:14, flexWrap:'wrap' }}>
              <div style={{ flex:1, minWidth:220, fontSize:11.5, color:'var(--t4)', lineHeight:1.5 }}>
                Writes the Accounting group of each category, the same field as Menu Manager, Edit category. Tills get it with the next Push to POS; reports and the owner app use it at once.
              </div>
              <button onClick={close} style={secondaryBtn} disabled={saving}>Cancel</button>
              <PrimaryBtn onClick={save} disabled={changes.length === 0 || saving}>{saveLabel(changes.length, saving)}</PrimaryBtn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
