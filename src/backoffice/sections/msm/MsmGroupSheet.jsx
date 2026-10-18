// src/backoffice/sections/msm/MsmGroupSheet.jsx
//
// MULTI SITE MENU, ROUND 2 (v5.11.75): one option group, everything about it (design 1.12):
//   * its name ("What the till shows as the question")
//   * the rule: Customers must choose, the kind of choice as three big buttons, the numbers, and the
//     sentence it makes ("Choose exactly 1. Customers must choose before the till moves on.")
//   * each site that keeps its own rule, with [Use the group's]
//   * the options in order: name, the group price, a price and an on or off switch per site (grey
//     follows the group price, bold is that site's own, "Not here yet" where the group is not at a
//     site), the sub item it is, Then ask, and drag (or the arrows) to change the order
//   * Add option, New sub item (also sold on its own or only an option), From an existing product,
//     Set every price in this group
//   * the products that ask it, and [Add to products]
//   * before Add to draft: what it does in sentences, and the warnings that need a tick
//
// Nothing is staged while typing: the form is turned into changes by lib/msm/msmGroupView.js
// (groupSaveChanges, with builder 1's msmGroupEdit rules) and staged in one go.

import { useMemo, useState } from 'react';
import * as edit from '../../../lib/msm/msmGroupEdit';
import {
  groupForm, newGroupForm, newOptionForm, groupSaveChanges, addGroupWithSites, copyGroupWithSites, keptRuleLines, formSentence,
  optionsOf, optionPriceWords, groupSiteIds,
} from '../../../lib/msm/msmGroupView';
import { applyChanges } from '../../../../supabase/functions/_shared/msmDiff.js';
import { summarise, siteList } from '../../../lib/msm/msmSummary';
import { riskChecks, allTicked } from '../../../lib/msm/msmRisk';
import { HELP, CHOICE_WORDS } from '../../../lib/msm/msmWords';
import { whyReadOnly } from '../../../lib/msm/msmStatus';
import { priceInput, categoryTree } from '../../../lib/msm/msmGrid';
import { taxChoices } from '../../../lib/msm/msmEdit';
import { siteRateChoices, choiceToRate } from '../../../lib/msm/msmOrderTypes';
import { isOptionOnlyItem } from '../../../lib/menuRules';
import { Btn, Pill, Switch, Field, Notice, SummaryBox, ConfirmTicks, Popover, MenuButton, Modal } from './msmUi';
import { ui, money } from './msmStyle';
import { useConfirm } from './useConfirm';
import { sheetSaveBlocked } from '../../../lib/msm/msmPublishView';
import MsmAddToProducts from './MsmAddToProducts';

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
const CHOICES = [
  { id: 'single', icon: '①', words: 'Pick one, like a milk' },
  { id: 'multiple', icon: '☰', words: 'Pick a few, like toppings' },
  { id: 'quantity', icon: '✕3', words: 'For boxes, like 3 donuts of any flavour' },
];
const gidOf = (a) => (typeof a === 'string' ? a : a?.groupId ?? a?.id ?? null);

function initDraft(eff, groupId, isNew) {
  const base = isNew ? newGroupForm(groupId) : groupForm(eff, groupId);
  return base ? { ...base, addTo: [], takeOff: [] } : null;
}

export default function MsmGroupSheet({ ctx, eff, ix, sites, stage, editable, canEdit, working, sales, ratesByLoc, groupId, isNew, onSaved, onCancel, openProduct, onChangePrices, onPick }) {
  const [built, setBuilt] = useState(() => ({ eff, draft: initDraft(eff, groupId, isNew), sync: false }));
  const draft = built.draft;
  const startJson = useMemo(() => JSON.stringify(initDraft(built.eff, groupId, isNew)), [built.eff, groupId, isNew]);
  const dirty = !!draft && JSON.stringify(draft) !== startJson;
  // After a save (or while nothing is typed), follow the group menu as the draft now holds it.
  if (built.eff !== eff && (built.sync || !dirty)) setBuilt({ eff, draft: initDraft(eff, groupId, isNew), sync: false });
  const setDraft = (fn) => setBuilt((b) => ({ ...b, draft: typeof fn === 'function' ? fn(b.draft) : fn }));

  const [ticked, setTicked] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [newSub, setNewSub] = useState(null);
  const [drag, setDrag] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const why = whyReadOnly({ canEdit, working });

  const group = (eff?.groups || []).find((g) => g.id === groupId) || null;
  const legacy = !isNew && optionsOf(eff, groupId).legacy;
  const at = useMemo(() => groupSiteIds(eff, groupId), [eff, groupId]);
  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const otherGroups = (eff?.groups || []).filter((g) => !g.archived && g.id !== groupId);
  const users = useMemo(() => (eff?.products || []).filter((p) => !p.archived && (p.modifier_groups || []).some((a) => gidOf(a) === groupId)), [eff, groupId]);

  // The draft's changes, worked out from the form as it is now.
  const result = useMemo(() => {
    if (!draft) return { changes: [], words: '' };
    const r = groupSaveChanges(ctx, draft, edit);
    if (r.words) return r;
    let changes = r.changes;
    if (draft.addTo.length || draft.takeOff.length) {
      const ctxAfter = { live: ctx.live, eff: applyChanges(eff, changes).central };
      changes = [...changes, ...addGroupWithSites(ctxAfter, groupId, draft.addTo, edit), ...edit.removeGroupFromProducts(ctxAfter, groupId, draft.takeOff)];
    }
    return { changes, words: '' };
  }, [ctx, draft, eff, groupId]);
  const effAfter = useMemo(() => (result.changes.length ? applyChanges(eff, result.changes).central : eff), [eff, result.changes]);
  const lines = useMemo(() => summarise(result.changes, effAfter, { siteNames: siteName }), [result.changes, effAfter, siteName]);
  const risks = useMemo(() => riskChecks(result.changes, effAfter, sales ?? null, null, { siteNames: siteName, ratesByLoc }), [result.changes, effAfter, sales, siteName, ratesByLoc]);
  // Sites the group is not at yet (no product sold there asks it): said on screen, never only in a
  // hover title an iPad cannot show (round 2 review).
  const absentSites = sites.filter((s) => !at.has(s.id)).map((s) => s.name);
  const ready = allTicked(risks, ticked);

  if (!draft || (!isNew && !group)) return <div style={ui.card}><Notice>That option group is no longer in the group menu.</Notice></div>;

  // ── Form helpers ─────────────────────────────────────────────────────────
  const setForm = (patch) => setDraft((d) => ({ ...d, form: { ...d.form, ...patch } }));
  const setOpt = (i, patch) => setDraft((d) => ({ ...d, options: d.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const setOptSite = (i, loc, patch) => setDraft((d) => ({ ...d, options: d.options.map((o, j) => (j === i ? { ...o, sites: { ...o.sites, [loc]: { ...o.sites[loc], ...patch, touched: true } } } : o)) }));
  const move = (from, to) => setDraft((d) => {
    if (to < 0 || to >= d.options.length || from === to) return d;
    const list = [...d.options];
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
    return { ...d, options: list };
  });
  const removeOpt = (i) => setDraft((d) => {
    const o = d.options[i];
    return { ...d, options: d.options.filter((_, j) => j !== i), removed: o.isNew ? d.removed : [...d.removed, o.id] };
  });
  const addOpt = (o) => setDraft((d) => ({ ...d, options: [...d.options, o] }));
  const setEvery = (v) => setDraft((d) => ({ ...d, options: d.options.map((o) => ({ ...o, price: Number(v).toFixed(2), sites: Object.fromEntries(Object.entries(o.sites).map(([k, s]) => [k, s.absent ? s : { ...s, own: '', touched: true }])) })) }));

  // ── Actions ──────────────────────────────────────────────────────────────
  const save = async () => {
    if (result.words || !result.changes.length || !ready) return;
    setSaving(true);
    const n = result.changes.length;
    const r = await stage(result.changes, { done: `${draft.name.trim()}: ${isNew ? 'new option group' : `${n} change${n === 1 ? '' : 's'}`} in the draft.` });
    setSaving(false);
    if (r?.ok) { setTicked(new Set()); setBuilt((b) => ({ ...b, sync: true })); onSaved?.(groupId); }
  };
  const removeGroup = async () => {
    const yes = await confirm({
      title: `Remove ${group.name}?`,
      words: `It comes off ${users.length} product${users.length === 1 ? '' : 's'} at every site when you publish. Nothing is deleted at any site, and you can bring it back.`,
      yes: 'Remove it', no: 'Keep it', danger: true,
    });
    if (!yes) return;
    const r = await stage(edit.removeGroupChanges(ctx, groupId), { done: `${group.name} is removed in the draft. It comes off every product when you publish.`, undo: true });
    if (r?.ok) onPick?.(null);
  };
  const bringBack = async () => {
    await stage(edit.groupUpdate(ctx, groupId, { archived: false }), { done: `${group.name} comes back when you publish. Put it on products again with Add to products.` });
  };
  const copyGroup = async () => {
    const c = copyGroupWithSites(ctx, groupId, newId, edit);
    const r = await stage(c.changes, { done: `${group.name} (copy) is in the draft. Change it, then add it to products.` });
    if (r?.ok) onPick?.(c.groupId);
  };
  const takeGroupRule = async (loc, columns) => {
    const gs = (eff?.groupSites || []).find((r) => r.group_id === groupId && r.location_id === loc);
    if (!gs) return;
    const kept = { ...(gs.kept || {}) };
    for (const c of columns) delete kept[c];
    const change = { target: 'modifier_group_site', entity_id: groupId, location_id: loc, op: 'update', after: { kept }, before: { kept: gs.kept || {} } };
    await stage([change], { done: `${siteName.get(loc) || 'That site'} will use the group's rule once published.`, undo: true });
  };

  const taxOptions = (() => {
    const fromSites = siteRateChoices(ratesByLoc || {}, sites.map((s) => s.id));
    return fromSites.length ? fromSites : taxChoices(eff).map((t) => ({ ...t, value: `${t.name || ''}|${t.percent}` }));
  })();
  const kept = isNew ? [] : keptRuleLines(eff, groupId, (l) => siteName.get(l) || 'A site');
  const sentence = formSentence(draft.form);
  const f = draft.form;
  const lock = !editable || legacy;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0 }}>
      {confirmDialog}
      {picking && (
        <MsmAddToProducts ix={ix} groupId={groupId} groupName={draft.name || 'this option group'} initial={{ add: draft.addTo, off: draft.takeOff }}
          onApply={({ add, off }) => setDraft((d) => ({ ...d, addTo: add, takeOff: off }))} onClose={() => setPicking(false)} />
      )}
      {newSub && <NewSubItem eff={eff} ix={ix} taxOptions={taxOptions} onClose={() => setNewSub(null)} onAdd={(o) => { addOpt(o); setNewSub(null); }} />}

      {/* Name and the group's own actions */}
      <div style={ui.card}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 280px' }}>
            <span style={ui.label}>{isNew ? 'New option group' : 'Option group'}</span>
            <input aria-label="Option group name" style={{ ...ui.input, fontSize: 17, fontWeight: 750, padding: '9px 12px' }} value={draft.name} maxLength={80}
              placeholder="Like Milk, or Choose 3 donuts" onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} readOnly={!editable} />
            <div style={{ ...ui.sub, fontSize: 11.5, marginTop: 4 }}>{HELP.groupName}</div>
          </div>
          {!isNew && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingTop: 20 }}>
              <Pill tone="neutral">{users.length ? `On ${users.length} product${users.length === 1 ? '' : 's'}` : 'Not on any product'}</Pill>
              <Pill tone={at.size ? 'blue' : 'neutral'}>{at.size ? `At ${at.size} site${at.size === 1 ? '' : 's'}` : 'At no site yet'}</Pill>
              {editable && (
                <MenuButton label="More" items={[
                  !group.archived && !legacy && { label: 'Change prices', hint: 'Up or down by an amount or a percent, at every site or some.', disabled: dirty, why: 'Add your changes to the draft first.', onClick: () => onChangePrices?.({ optionGroupIds: [groupId] }) },
                  !group.archived && !legacy && { label: 'Copy this group', hint: `Makes "${group.name} (copy)" with the same options and site prices.`, onClick: copyGroup },
                  group.archived ? { label: 'Bring it back', hint: 'It comes back when you publish.', onClick: bringBack }
                    : { label: 'Remove option group', hint: 'Comes off every product when you publish. Nothing is deleted.', onClick: removeGroup },
                ]} />
              )}
            </div>
          )}
        </div>
        {group?.archived && <div style={{ marginTop: 10 }}><Notice>This option group is removed. It is not on any product. Bring it back from More to use it again.</Notice></div>}
        {legacy && <div style={{ marginTop: 10 }}><Notice>Its options come from each site as they are today. Use "Refresh option groups from the sites" above to edit them here. You can still change its name and rule.</Notice></div>}
      </div>

      {/* The rule */}
      <div style={ui.card}>
        <div style={{ ...ui.h2, marginBottom: 10 }}>How customers choose</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8, marginBottom: 12 }}>
          {CHOICES.map((c) => {
            const on = f.choice === c.id;
            return (
              <button key={c.id} type="button" disabled={!editable} onClick={() => setForm({ choice: c.id, ...(c.id === 'quantity' ? { mustChoose: true, max: Math.max(2, Number(f.max) || 3) } : c.id === 'single' ? { max: 1 } : { max: Math.max(2, Number(f.max) || 2) }) })}
                style={{ textAlign: 'left', padding: '11px 12px', borderRadius: 12, cursor: editable ? 'pointer' : 'default', fontFamily: 'inherit', color: 'var(--t1)',
                  border: `1.5px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, background: on ? 'var(--acc-d)' : 'var(--bg2)' }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: on ? 'var(--acc)' : 'var(--t3)', lineHeight: 1 }}>{c.icon}</div>
                <div style={{ fontSize: 13.5, fontWeight: 800, marginTop: 6 }}>{CHOICE_WORDS[c.id]}</div>
                <div style={{ ...ui.sub, fontSize: 11.5 }}>{c.words}</div>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {f.choice !== 'quantity' && (
            <Field label="Customers must choose" hint={HELP.mustChoose} style={{ marginBottom: 0, maxWidth: 260 }}>
              <Switch on={!!f.mustChoose} disabled={!editable} onChange={(v) => setForm({ mustChoose: v, min: v ? Math.max(1, Number(f.min) || 1) : 0 })} />
            </Field>
          )}
          {f.choice === 'multiple' && f.mustChoose && (
            <Field label="At least" style={{ marginBottom: 0 }}>
              <NumBox value={f.min} min={1} max={Math.min(99, Number(f.max) || 99)} disabled={!editable} onChange={(v) => setForm({ min: v })} />
            </Field>
          )}
          {f.choice === 'multiple' && (
            <Field label="Up to" style={{ marginBottom: 0 }}>
              <div style={{ ...ui.row }}>
                {Number(f.max) < 99 && <NumBox value={f.max} min={1} max={98} disabled={!editable} onChange={(v) => setForm({ max: v })} />}
                <label style={{ ...ui.row, fontSize: 12.5, cursor: 'pointer' }}>
                  <input type="checkbox" disabled={!editable} checked={Number(f.max) >= 99} onChange={(e) => setForm({ max: e.target.checked ? 99 : 3 })} /> As many as they like
                </label>
              </div>
            </Field>
          )}
          {f.choice === 'quantity' && (
            <Field label="How many in the box" hint={HELP.quantity} style={{ marginBottom: 0, maxWidth: 300 }}>
              <NumBox value={f.max} min={1} max={98} disabled={!editable} onChange={(v) => setForm({ max: v, min: v })} />
            </Field>
          )}
        </div>
        <div style={{ marginTop: 12, fontSize: 13.5, fontWeight: 750 }} data-testid="msm-rule-sentence">{sentence}</div>
        <div style={{ ...ui.sub, fontSize: 11.5, marginTop: 4 }}>To give some choices free (like the first 2 free), set those options to 0.00.</div>
        {kept.map((k) => (
          <div key={k.locationId} style={{ ...ui.row, marginTop: 10, fontSize: 12.5 }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--blu)', flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{k.words}</span>
            {editable && <Btn small kind="link" onClick={() => takeGroupRule(k.locationId, k.columns)}>Use the group's</Btn>}
          </div>
        ))}
      </div>

      {/* The options */}
      <div style={ui.card}>
        <div style={{ ...ui.row, marginBottom: 4, flexWrap: 'wrap' }}>
          <div style={{ ...ui.h2, flex: 1, margin: 0 }}>Options</div>
          {editable && !legacy && (
            <>
              <Btn small kind="soft" onClick={() => addOpt(newOptionForm(eff, { id: newId(), name: '', price: '0.00' }))}>+ Add option</Btn>
              <Btn small kind="soft" onClick={() => setNewSub({})}>+ New sub item</Btn>
              <ExistingProductPicker eff={eff} onPick={(p) => addOpt(newOptionForm(eff, { id: newId(), name: p.menu_name || p.name, price: '0.00', product_id: p.id }))} />
              {draft.options.length > 1 && <SetEveryPrice onApply={setEvery} />}
            </>
          )}
        </div>
        <div style={{ ...ui.sub, fontSize: 11.5, marginBottom: 10 }}>
          {HELP.option} Grey prices follow the group price; a site's own price is bold. Leave a site's box blank to charge the group price. {HELP.optionVat}
        </div>
        {!draft.options.length && <Notice>No options yet. Add the answers, like Oat milk and Soya milk.</Notice>}
        {draft.options.length > 0 && absentSites.length > 0 && (
          <div data-testid="msm-group-absent" style={{ ...ui.sub, fontSize: 12, margin: '0 0 10px', padding: '8px 10px', borderRadius: 9, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
            Not at {siteList(absentSites)} yet. The group goes to a site when a product sold there asks it: use Add to products below, then Add to draft. Site prices can be set after that.
          </div>
        )}
        {draft.options.length > 0 && (
          <div style={{ overflowX: 'auto', border: '1px solid var(--bdr)', borderRadius: 12 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 + sites.length * 124, fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg2)', color: 'var(--t3)', fontSize: 11.5, textAlign: 'left' }}>
                  <th style={th(36)} aria-label="Order" />
                  <th style={th(200)}>Option</th>
                  <th style={th(96)} title="Every site charges this unless it has its own">Group price</th>
                  {sites.map((s) => <th key={s.id} style={th(124)} title={s.name}><span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 112 }}>{s.name}</span></th>)}
                  <th style={th(160)} title={HELP.thenAsk}>Then ask</th>
                  <th style={th(36)} aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {draft.options.map((o, i) => {
                  const pr = priceInput(o.price);
                  const prod = o.product_id ? (eff?.products || []).find((p) => p.id === o.product_id) : null;
                  return (
                    <tr key={o.id} draggable={editable && !legacy} onDragStart={() => setDrag(i)} onDragOver={(e) => { if (drag != null) e.preventDefault(); }}
                      onDrop={() => { if (drag != null) move(drag, i); setDrag(null); }} onDragEnd={() => setDrag(null)}
                      style={{ borderTop: '1px solid var(--bdr)', background: drag === i ? 'var(--bg2)' : 'transparent' }}>
                      <td style={td}>
                        {editable && !legacy && (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'grab', color: 'var(--t4)' }} title="Drag, or use the arrows, to change the order">
                            <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)} style={arrow}>▲</button>
                            <button type="button" aria-label="Move down" disabled={i === draft.options.length - 1} onClick={() => move(i, i + 1)} style={arrow}>▼</button>
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        <input aria-label="Option name" readOnly={lock} style={{ ...ui.input, padding: '6px 9px', fontWeight: 650 }} value={o.name} placeholder="Like Oat milk" onChange={(e) => setOpt(i, { name: e.target.value })} />
                        {(o.product_id || o.newSub) && (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                            <Pill tone="blue" title={HELP.subItem}>Sub item</Pill>
                            <span style={{ ...ui.sub, fontSize: 11 }}>
                              {o.newSub ? (o.newSub.soldAlone ? 'new, also sold on its own' : 'new, only an option')
                                : prod ? (isOptionOnlyItem(prod) ? 'only an option' : `also sold on its own at ${money(prod.default_price)}`) : 'a product not in the group menu'}
                            </span>
                            {prod && !o.newSub && <Btn small kind="link" style={{ padding: 0 }} onClick={() => openProduct(prod.id)}>Open</Btn>}
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        <input aria-label={`Group price for ${o.name || 'this option'}`} readOnly={lock} inputMode="decimal" style={{ ...ui.input, padding: '6px 8px', textAlign: 'right', width: 84, fontWeight: 700, borderColor: pr.ok && pr.value != null ? 'var(--bdr2)' : 'var(--red)' }}
                          value={o.price} onChange={(e) => setOpt(i, { price: e.target.value })} onBlur={() => { if (pr.ok && pr.value != null) setOpt(i, { price: pr.value.toFixed(2) }); }} />
                        {Number(o.price) < 0 && <div style={{ ...ui.sub, fontSize: 10.5 }}>{optionPriceWords(o.price)}</div>}
                      </td>
                      {sites.map((s) => {
                        const st = o.sites?.[s.id] || { active: false, own: '', absent: true };
                        if (st.absent) {
                          return (
                            <td key={s.id} style={{ ...td, color: 'var(--t4)', fontSize: 11.5 }} title={`${draft.name || 'This group'} is not at ${s.name} yet. It goes there, with its options on, when a product sold there gets it.`}>
                              Not here yet
                            </td>
                          );
                        }
                        const sp = priceInput(st.own);
                        return (
                          <td key={s.id} style={td}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <Switch small on={!!st.active} disabled={lock} title={st.active ? `On at ${s.name}: turn off` : `Off at ${s.name}: turn on`} onChange={(v) => setOptSite(i, s.id, { active: v })} />
                              {st.active
                                ? <input aria-label={`${o.name || 'Option'} price at ${s.name}`} readOnly={lock} inputMode="decimal" placeholder={pr.ok && pr.value != null ? pr.value.toFixed(2) : ''}
                                  style={{ ...ui.input, padding: '5px 7px', width: 72, textAlign: 'right', fontWeight: st.own ? 750 : 500, borderColor: sp.ok ? 'var(--bdr2)' : 'var(--red)' }}
                                  value={st.own} onChange={(e) => setOptSite(i, s.id, { own: e.target.value })} />
                                : <span style={{ fontSize: 11.5, color: 'var(--t4)' }}>Off here</span>}
                            </div>
                          </td>
                        );
                      })}
                      <td style={td}>
                        <select aria-label="Then ask" disabled={lock} style={{ ...ui.input, padding: '6px 8px', fontSize: 12.5 }} value={o.sub_group_id || ''} onChange={(e) => setOpt(i, { sub_group_id: e.target.value || null })}>
                          <option value="">Nothing else</option>
                          {otherGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                        </select>
                      </td>
                      <td style={td}>
                        {editable && !legacy && <button type="button" aria-label={`Remove ${o.name || 'option'}`} title="Take this option out of the group (at every site, when published)" onClick={() => removeOpt(i)} style={{ background: 'none', border: 'none', color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* The products that ask it */}
      <div style={ui.card}>
        <div style={{ ...ui.row, marginBottom: 6 }}>
          <div style={{ ...ui.h2, flex: 1, margin: 0 }}>Used by</div>
          {editable && !group?.archived && <Btn small kind="soft" onClick={() => setPicking(true)}>Add to products</Btn>}
        </div>
        {editable && !group?.archived && absentSites.length > 0 && !draft.addTo.length && (
          <div style={{ ...ui.sub, fontSize: 11.5, marginBottom: 6 }}>Add it to a product sold at {siteList(absentSites)} to bring it there, with its options on.</div>
        )}
        <div style={ui.sub}>
          {users.length ? `${users.length} product${users.length === 1 ? '' : 's'} ask this question.` : isNew ? 'Pick the products that should ask this question.' : 'No product asks this question yet.'}
          {(draft.addTo.length > 0 || draft.takeOff.length > 0) && <strong style={{ color: 'var(--t1)' }}> {draft.addTo.length ? `Adding it to ${draft.addTo.length}` : ''}{draft.addTo.length && draft.takeOff.length ? ', ' : ''}{draft.takeOff.length ? `taking it off ${draft.takeOff.length}` : ''} when you add to draft.</strong>}
        </div>
        {users.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {users.slice(0, 14).map((p) => <Btn key={p.id} small kind="soft" style={{ fontWeight: 600 }} onClick={() => openProduct(p.id)}>{p.menu_name || p.name}</Btn>)}
            {users.length > 14 && <span style={{ ...ui.sub, alignSelf: 'center' }}>and {users.length - 14} more</span>}
          </div>
        )}
      </div>

      {/* Before Add to draft: in sentences, and the ticks */}
      {editable && (dirty || isNew) && (
        <div style={{ ...ui.card, position: 'sticky', bottom: 0, zIndex: 3, display: 'grid', gap: 10, borderColor: 'var(--acc-b, var(--acc))' }}>
          {result.words ? <Notice tone="bad">{result.words}</Notice> : <SummaryBox lines={lines} empty={<div style={ui.sub}>No changes yet.</div>} />}
          {!result.words && <ConfirmTicks risks={risks} ticked={ticked} onChange={setTicked} />}
          <div style={{ ...ui.row, flexWrap: 'wrap' }}>
            <Btn kind="primary" disabled={sheetSaveBlocked({ saving, words: result.words, changes: result.changes.length, ready, salesReading: sales === undefined })} onClick={save} data-testid="msm-group-save">
              {saving ? 'Adding…' : result.changes.length ? `Add ${result.changes.length} change${result.changes.length === 1 ? '' : 's'} to draft` : 'Add to draft'}
            </Btn>
            <Btn onClick={() => { setBuilt({ eff, draft: initDraft(eff, groupId, isNew), sync: false }); setTicked(new Set()); if (isNew) onCancel?.(); }}>{isNew ? 'Cancel' : 'Undo my edits'}</Btn>
            <span style={ui.sub}>{sales === undefined ? "Checking last week's sales, a few seconds." : !ready && risks.length ? 'Tick each warning to go on.' : 'Nothing reaches the tills until you publish.'}</span>
          </div>
        </div>
      )}
      {!editable && why && <div style={ui.sub}>{why}</div>}
    </div>
  );
}

const th = (w) => ({ padding: '8px 8px', fontWeight: 700, width: w, minWidth: w, whiteSpace: 'nowrap', boxSizing: 'border-box' });
const td = { padding: '7px 8px', verticalAlign: 'top' };
const arrow = { background: 'none', border: 'none', color: 'var(--t4)', cursor: 'pointer', fontSize: 9, lineHeight: 1, padding: '1px 4px' };

function NumBox({ value, min = 0, max = 99, disabled, onChange }) {
  const n = Number(value) || 0;
  const set = (v) => onChange(Math.max(min, Math.min(max, Math.round(Number(v) || min))));
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--bdr2)', borderRadius: 9, overflow: 'hidden', background: 'var(--bg2)' }}>
      <button type="button" disabled={disabled || n <= min} onClick={() => set(n - 1)} style={numBtn} aria-label="One less">−</button>
      <input aria-label="Number" inputMode="numeric" disabled={disabled} value={n} onChange={(e) => set(e.target.value)} style={{ width: 44, textAlign: 'center', border: 'none', background: 'transparent', color: 'var(--t1)', fontSize: 14, fontWeight: 750, fontFamily: 'inherit', outline: 'none' }} />
      <button type="button" disabled={disabled || n >= max} onClick={() => set(n + 1)} style={numBtn} aria-label="One more">+</button>
    </div>
  );
}
const numBtn = { width: 32, height: 34, border: 'none', background: 'transparent', color: 'var(--t2)', fontSize: 16, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' };

function SetEveryPrice({ onApply }) {
  const [text, setText] = useState('');
  const p = priceInput(text);
  return (
    <Popover label="Set every price" width={260}>
      {(close) => (
        <div>
          <div style={{ ...ui.sub, marginBottom: 6 }}>One group price for every option, and every site back on it.</div>
          <input autoFocus aria-label="Price for every option" inputMode="decimal" style={{ ...ui.input, marginBottom: 8 }} placeholder="0.50" value={text} onChange={(e) => setText(e.target.value)} />
          {!p.ok && <div style={{ ...ui.err, marginBottom: 6 }}>{p.words}</div>}
          <Btn small kind="primary" disabled={!p.ok || p.value == null} onClick={() => { onApply(p.value); close(); }}>Set them all</Btn>
        </div>
      )}
    </Popover>
  );
}

function ExistingProductPicker({ eff, onPick }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (eff?.products || []).filter((p) => !p.archived && p.type !== 'variants' && (!t || String(p.menu_name || p.name).toLowerCase().includes(t)))
      .sort((a, b) => (Number(b.type === 'subitem') - Number(a.type === 'subitem')) || String(a.name).localeCompare(String(b.name))).slice(0, 30);
  }, [eff, q]);
  return (
    <Popover label="+ From an existing product" width={320}>
      {(close) => (
        <div>
          <div style={{ ...ui.sub, marginBottom: 6 }}>Pick a product to be an option. It becomes a sub item here; its own price when sold on its own does not change.</div>
          <input autoFocus aria-label="Find a product" style={{ ...ui.input, marginBottom: 8 }} placeholder="Find a product" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {!list.length && <div style={ui.sub}>No products match.</div>}
            {list.map((p) => (
              <button key={p.id} type="button" onClick={() => { onPick(p); close(); }}
                style={{ display: 'flex', width: '100%', gap: 8, alignItems: 'center', textAlign: 'left', padding: '6px 8px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
                <span style={{ flex: 1 }}>{p.menu_name || p.name}</span>
                {p.type === 'subitem' && <Pill tone="blue">Sub item</Pill>}
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

// "New sub item": a product picked as an option, made with its option in one step (design 1.5).
function NewSubItem({ ix, taxOptions, onAdd, onClose }) {
  const tree = useMemo(() => categoryTree(ix), [ix]);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('0.00');
  const [soldAlone, setSoldAlone] = useState(false);
  const [own, setOwn] = useState('');
  const [cat, setCat] = useState('');
  const [tax, setTax] = useState(taxOptions[0]?.value || '');
  const p = priceInput(price);
  const op = priceInput(own);
  const problem = !name.trim() ? 'Give it a name, like Galaxy donut.'
    : !p.ok || p.value == null ? 'Give the option a price (0.00 for free).'
      : soldAlone && (!op.ok || op.value == null) ? 'Give it a price for when it is sold on its own.'
        : soldAlone && !cat ? 'Pick the category it is sold in.' : '';
  return (
    <Modal title="New sub item" width={520} onClose={onClose} dirty={!!name.trim()} sub={HELP.subItem}
      footer={(
        <>
          <div style={{ flex: 1, ...ui.sub }}>{problem || 'It goes into this group. Add to draft when you are done.'}</div>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" disabled={!!problem} onClick={() => onAdd(newOptionForm({ sites: [] }, { id: newId(), name: name.trim(), price: p.value.toFixed(2), newSub: { productId: newId(), soldAlone, productPrice: soldAlone ? op.value : p.value, categoryId: soldAlone ? cat : null, tax: choiceToRate(tax) } }))}>Add it to the group</Btn>
        </>
      )}>
      <Field label="Name" hint="Its name on the till and in the kitchen.">
        <input autoFocus style={ui.input} value={name} maxLength={120} placeholder="Like Galaxy donut" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Price when picked as an option" hint="What it adds to the product, for example 0.00 in a box of 3.">
        <input inputMode="decimal" style={{ ...ui.input, width: 140 }} value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <Field label="Also sold on its own" hint={HELP.soldAlone}>
        <Switch on={soldAlone} onChange={setSoldAlone} />
        {soldAlone && <div style={{ ...ui.sub, fontSize: 11.5, marginTop: 6 }}>It goes on sale on its own at every site. Turn it off at a site on the Products tab.</div>}
      </Field>
      {soldAlone && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Price on its own" hint="Its price on the till as a product.">
            <input inputMode="decimal" style={ui.input} value={own} placeholder="2.50" onChange={(e) => setOwn(e.target.value)} />
          </Field>
          <Field label="Category" hint="Where it sits on the till.">
            <select style={ui.input} value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Pick a category</option>
              {tree.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.depth)}{t.label}</option>)}
            </select>
          </Field>
          <Field label="VAT" hint="Each site uses its own rate with this name." style={{ gridColumn: '1 / -1' }}>
            <select style={ui.input} value={tax} onChange={(e) => setTax(e.target.value)}>
              {taxOptions.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
        </div>
      )}
      <div style={{ ...ui.sub, fontSize: 11.5 }}>When it is picked as an option, the kitchen screen and receipt show the option's name, with its product. Its stock and 86 work at each site as they do today.</div>
    </Modal>
  );
}
