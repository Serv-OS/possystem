// src/backoffice/sections/msm/MsmDetails.jsx
//
// MULTI SITE MENU (v5.11.75): the menu's details. Its name and description, whether that name is
// written to each site's own menu, and every site with the menu it writes into. Each site's menu
// schedule, priority and default stay that site's own (timed menus are venue owned): shown here,
// never changed by publishing.
//
// ROUND 2 (UI issue 12a): each site's real menu times, the site's OTHER menus (read only), and one
// plain line saying what publishing touches and what stays set at each site.
//
// ROUND 2, builder 3 (design 5.1, 1.9 and 2 items 7 and 24): which order types the screens show
// (a setting, saved at once, never a draft: public.msm_set_order_types); the one time option group
// refresh when the menu still needs it; the "every site" switch now saves with the Save button.

import { useEffect, useMemo, useState } from 'react';
import { readAllRows } from '../../../../supabase/functions/_shared/venueMenuCore.js';
import { groupsNeedRefresh } from '../../../../supabase/functions/_shared/msmPlan.js';
import { Btn, Pill, Switch, Field, Notice } from './msmUi';
import { menuTimesWords } from '../../../lib/msm/msmStatus';
import { shownPriceTypes } from '../../../lib/msm/msmOrderTypes';
import { PRICE_TYPE_WORDS, PRICE_TYPE_HELP } from '../../../lib/msm/msmWords';
import { ui } from './msmStyle';
import { useConfirm } from './useConfirm';

// The order types a group menu can show. Delivery is a platform price (set by the menu that platform
// uses at each site, UI issue 2), so it is not one of them; its VAT row always shows.
const TYPE_CHOICES = ['dineIn', 'takeaway', 'collection', 'driveThru', 'bar'];
const TYPE_HELP = { ...PRICE_TYPE_HELP, bar: 'Bar tabs: shows the Bar tab VAT row.' };

export default function MsmDetails({ api, client, menu, live, eff, sites, stage, editable, canEdit, rows = [], setNote, reload }) {
  const effMenu = eff?.menu || menu;
  // What the person is typing; null = show the menu as it is (with the draft).
  const [typed, setTyped] = useState(null);
  const name = typed?.name ?? effMenu?.name ?? '';
  const description = typed?.description ?? effMenu?.description ?? '';
  const everywhere = typed?.everywhere ?? !!effMenu?.use_name_everywhere;
  const setName = (v) => setTyped((t) => ({ name: v, description: t?.description ?? description, everywhere: t?.everywhere ?? everywhere }));
  const setDescription = (v) => setTyped((t) => ({ name: t?.name ?? name, description: v, everywhere: t?.everywhere ?? everywhere }));
  const setEverywhere = (v) => setTyped((t) => ({ name: t?.name ?? name, description: t?.description ?? description, everywhere: v }));
  const dirty = !!typed && (name.trim() !== (effMenu?.name || '') || description !== (effMenu?.description || '') || everywhere !== !!effMenu?.use_name_everywhere);
  const [read, setRead] = useState({ key: '', menus: null });
  const [saving, setSaving] = useState(false);

  // Every menu at every site of the group menu (the one it writes into, and the site's others).
  const ids = useMemo(() => (live?.sites || []).map((s) => s.location_id).filter(Boolean), [live]);
  const idsKey = ids.join('|');
  useEffect(() => {
    let on = true;
    if (!client || !ids.length) return undefined;
    readAllRows(() => client.from('menus').select('*').in('location_id', ids).order('sort_order').order('id')).then((r) => {
      if (on) setRead({ key: idsKey, menus: r.rows ? new Map(r.rows.map((m) => [m.id, m])) : null });
    });
    return () => { on = false; };
  }, [client, ids, idsKey]);
  // null while reading or when the read failed (failed shows a notice once the read is back).
  const venueMenus = !ids.length ? new Map() : read.key === idsKey ? read.menus : undefined;

  const products = (eff?.products || []).filter((p) => !p.archived);
  const counts = useMemo(() => {
    const m = new Map();
    for (const ps of eff?.productSites || []) if (ps.active !== false) m.set(ps.location_id, (m.get(ps.location_id) || 0) + 1);
    return m;
  }, [eff]);

  const save = async () => {
    const after = {};
    const before = {};
    const nm = name.trim();
    if (!nm) return;
    if (nm !== effMenu.name) { after.name = nm; before.name = menu.name; }
    if (description !== (effMenu.description || '')) { after.description = description; before.description = menu.description || ''; }
    if (everywhere !== !!effMenu.use_name_everywhere) { after.use_name_everywhere = everywhere; before.use_name_everywhere = !!menu.use_name_everywhere; }
    if (!Object.keys(after).length) return;
    setSaving(true);
    const r = await stage([{ target: 'menu', entity_id: menu.id, location_id: null, op: 'update', after, before }], { done: 'Menu details are in the draft.' });
    setSaving(false);
    if (r?.ok) setTyped(null);
  };


  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' }}>
      <div style={ui.card}>
        <div style={{ ...ui.h2, marginBottom: 12 }}>Menu details</div>
        <fieldset disabled={!editable} style={{ border: 'none', padding: 0, margin: 0 }}>
          <Field label="Name"><input style={ui.input} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Description" hint="For your team. Shown on kiosk and online only if the switch below is on.">
            <textarea style={{ ...ui.input, minHeight: 70, resize: 'vertical' }} value={description} maxLength={600} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <label style={{ ...ui.row, fontSize: 13, marginBottom: 4, cursor: 'pointer' }}>
            <Switch on={everywhere} disabled={!editable || saving} onChange={setEverywhere} />
            Use this name and description at every site (kiosk and online menu tabs)
          </label>
          <div style={{ ...ui.sub, marginBottom: 14 }}>Off: each site keeps the name its own menu has.</div>
          {editable && <Btn kind="primary" disabled={saving || !name.trim() || !dirty} onClick={() => save()}>{dirty ? 'Add to draft' : 'Nothing changed yet'}</Btn>}
        </fieldset>
        <div style={{ ...ui.sub, marginTop: 16 }}>
          {products.length} products in {(eff?.categories || []).filter((c) => !c.archived).length} categories.
          {menu?.last_published_at ? ` Last published ${new Date(menu.last_published_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${menu.last_published_by ? ` by ${menu.last_published_by}` : ''}.` : ''}
          {menu?.last_version_no ? ` Version ${menu.last_version_no}.` : ''}
        </div>
      </div>
      <OrderTypes api={api} menu={menu} live={live} canEdit={canEdit} setNote={setNote} reload={reload} />
      {groupsNeedRefresh(live) && <RefreshGroups api={api} menu={menu} canEdit={canEdit} rows={rows} setNote={setNote} reload={reload} />}
      <div style={ui.card}>
        <div style={{ ...ui.h2, marginBottom: 4 }}>Sites</div>
        <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>Changes here go into each site's own menu named below. Times, menu prices and which menu a till or platform uses stay set at each site.</div>
        <div style={{ ...ui.sub, marginBottom: 12 }}>Times and which menu is the default are set at each site and never changed by publishing. To price a platform such as delivery differently, use that platform's own menu at each site, as you do today.</div>
        {venueMenus === null && <Notice tone="bad">Could not read the sites' own menus.</Notice>}
        {venueMenus === undefined && <div style={{ ...ui.sub, marginBottom: 8 }}>Reading the sites' own menus…</div>}
        {sites.map((s) => {
          const ms = (live?.sites || []).find((x) => x.location_id === s.id);
          const vm = venueMenus?.get(ms?.venue_menu_id);
          const others = venueMenus ? [...venueMenus.values()].filter((m) => m.location_id === s.id && m.id !== ms?.venue_menu_id && m.is_active !== false) : [];
          return (
            <div key={s.id} style={{ padding: '10px 0', borderTop: '1px solid var(--bdr)' }}>
              <div style={{ ...ui.row }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--t2)' }}>
                    {vm ? <>Writes into <strong>{vm.name || 'its menu'}</strong> · {menuTimesWords(vm)}{vm.is_default ? ' · the default' : ''}</> : ms?.venue_menu_id ? 'Writes into its menu' : 'A menu is made on first publish'}
                  </div>
                </div>
                <Pill>{counts.get(s.id) || 0} on sale</Pill>
                {ms?.last_error && <Pill tone="bad" title={ms.last_error}>Last publish failed</Pill>}
              </div>
              {others.length > 0 && (
                <div style={{ ...ui.sub, fontSize: 12, marginTop: 4, paddingLeft: 10, borderLeft: '2px solid var(--bdr2)' }}>
                  Its other menus (not changed here): {others.map((m) => `${m.name || 'Menu'} (${menuTimesWords(m)}${m.is_default ? ', the default' : ''})`).join('; ')}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Which order type prices the product sheet shows (design 5.1). A screen setting: saved at once,
// nothing reaches a site, hidden ones keep their prices.
function OrderTypes({ api, menu, live, canEdit, setNote, reload }) {
  const shown = shownPriceTypes(live);
  const fromSetting = Array.isArray(live?.menu?.order_types);
  const current = new Set(fromSetting ? live.menu.order_types : shown.types);
  const [picked, setPicked] = useState(null);      // null = as saved
  const [saving, setSaving] = useState(false);
  const now = picked || current;
  const flip = (k) => { const n = new Set(now); if (n.has(k)) n.delete(k); else n.add(k); setPicked(n); };
  const changed = !!picked && (picked.size !== current.size || [...picked].some((k) => !current.has(k)));
  const save = async () => {
    if (!api?.setOrderTypes) return;
    setSaving(true);
    const r = await api.setOrderTypes(menu.id, TYPE_CHOICES.filter((k) => now.has(k)));
    setSaving(false);
    if (!r.ok) { setNote?.({ tone: 'bad', text: r.words || 'It did not save. Try again.' }); return; }
    setPicked(null);
    setNote?.({ tone: 'good', text: 'Saved. The product sheet shows these order types now. Nothing changed at any site.' });
    reload?.();
  };
  if (live?.round2 === false) return null;
  return (
    <div style={ui.card} data-testid="msm-order-types">
      <div style={{ ...ui.h2, marginBottom: 4 }}>Order types</div>
      <div style={{ ...ui.sub, marginBottom: 10 }}>Only these show on the product sheet. Hidden ones keep their prices. Standard price always shows.{!fromSetting ? ' Not picked yet: the screens show the ones that already have a price.' : ''}</div>
      {TYPE_CHOICES.map((k) => (
        <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', fontSize: 13, cursor: canEdit ? 'pointer' : 'default' }}>
          <input type="checkbox" checked={now.has(k)} disabled={!canEdit || saving} onChange={() => flip(k)} style={{ marginTop: 2 }} />
          <span><strong>{PRICE_TYPE_WORDS[k]}</strong><span style={{ ...ui.sub, display: 'block' }}>{TYPE_HELP[k]}</span></span>
        </label>
      ))}
      {canEdit && <div style={{ marginTop: 8 }}><Btn kind="primary" small disabled={!changed || saving} onClick={save}>{saving ? 'Saving…' : 'Save order types'}</Btn></div>}
      {!canEdit && <div style={ui.sub}>Only editors can change this.</div>}
    </div>
  );
}

// The one time option group refresh (design 1.9): a group menu imported before round 2 holds its
// option groups as one list; this brings each option in with each site's own price. Nothing changes
// at any site, or nothing is saved.
function RefreshGroups({ api, menu, canEdit, rows, setNote, reload }) {
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const run = async () => {
    const yes = await confirm({
      title: 'Refresh option groups from the sites?',
      words: 'We read every site\'s option groups and bring their options in, one by one, with each site\'s own prices. Nothing changes at any site: if anything would, nothing is saved and we say what.',
      yes: 'Refresh them', no: 'Not now',
    });
    if (!yes) return;
    setBusy(true);
    const r = await api.refreshGroups(menu.id);
    setBusy(false);
    if (!r.ok) { setNote?.({ tone: 'bad', text: `Nothing was changed. ${r.words || ''}`.trim() }); return; }
    setNote?.({ tone: 'good', text: r.data?.words || 'Option groups refreshed from the sites. Nothing changed at any site.' });
    reload?.();
  };
  return (
    <div style={ui.card}>
      {confirmDialog}
      <div style={{ ...ui.h2, marginBottom: 4 }}>Option groups need a one time refresh</div>
      <div style={{ ...ui.sub, marginBottom: 10 }}>They were brought in before they could be edited here. The refresh reads every site and brings in each option with each site's own price. Nothing changes at any site.</div>
      {rows.length > 0 && <div style={{ ...ui.sub, marginBottom: 8 }}>Publish or throw away the draft first.</div>}
      {canEdit ? <Btn kind="primary" small disabled={busy || rows.length > 0} onClick={run}>{busy ? 'Refreshing…' : 'Refresh option groups from the sites'}</Btn>
        : <div style={ui.sub}>An editor can do it from here.</div>}
    </div>
  );
}
