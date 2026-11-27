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
import { menuTimesWords, refreshClash, REFRESH_CLASH_WORDS } from '../../../lib/msm/msmStatus';
import { shownPriceTypes } from '../../../lib/msm/msmOrderTypes';
import { PRICE_TYPE_WORDS, PRICE_TYPE_HELP } from '../../../lib/msm/msmWords';
import { ui } from './msmStyle';
import { useConfirm } from './useConfirm';
import { extraMenus, extraMenuAt, MAIN_MENU_WORDS, menuKeysOf } from '../../../../supabase/functions/_shared/msmMenus.js';
import { menusReady, addMenuChanges, renameMenuChange, removeMenuChange, menuSiteChange, menuAtSiteWords } from '../../../lib/msm/msmEdit';
// 5.12.57 (US basics, batch 6): the words name the venue's own tax (VAT at a UK venue, unchanged).
import { activeTaxText as tt } from '../../../lib/taxWords';

// The order types a group menu can show. Delivery is a platform price (set by the menu that platform
// uses at each site, UI issue 2), so it is not one of them; its VAT row always shows.
const TYPE_CHOICES = ['dineIn', 'takeaway', 'collection', 'driveThru', 'bar'];
const TYPE_HELP = { ...PRICE_TYPE_HELP, bar: 'Shows a Bar tab VAT row. Bar tabs have no price of their own.' };   // taxText: read through tt() below

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
      <Menus client={client} live={live} eff={eff} sites={sites} venueMenus={venueMenus} stage={stage} editable={editable} setNote={setNote} />
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
                    {vm ? <>Goes into the <strong>{vm.name || 'its'}</strong> menu · {menuTimesWords(vm)}{vm.is_default ? ' · the default' : ''}</> : ms?.venue_menu_id ? 'Goes into its menu' : 'A menu is made on first publish'}
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

// 5.12.116: SEVERAL MENUS in one group menu (_shared/msmMenus.js). Peter, 26 Nov 2026: "I like the
// different menus but need to be able to manage centrally in multi site", and "the less menus the
// better ... literal differences like menus with different products can have different menus like
// catering". The Main menu is the one every site already has. Another menu (Catering) is added
// here; categories are ticked into it on the Products tab; publish uses each site's own menu of
// that name, or makes one. Which menu a POS, kiosk, online or catering page uses stays each site's.
function Menus({ client, live, eff, sites, venueMenus, stage, editable, setNote }) {
  const ctx = useMemo(() => ({ live, eff }), [live, eff]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(null);      // { id, value }
  const [confirm, confirmDialog] = useConfirm();
  const ready = menusReady(live);
  const list = extraMenus(eff?.menu);
  const cats = useMemo(() => new Map((eff?.categories || []).map((c) => [c.id, c])), [eff]);
  const countOn = (key) => (eff?.categories || []).filter((c) => !c.archived && !c.parent_id && menuKeysOf(c, cats, eff?.menu).includes(key)).length;
  const say = (r) => { if (r?.words) setNote?.({ tone: 'warn', text: r.words }); };

  const add = async () => {
    const all = venueMenus ? [...venueMenus.values()] : [];
    const first = addMenuChanges(ctx, name, { venueMenus: all });
    if (first.words) { say(first); return; }
    setBusy(true);
    // The site categories already on a matched menu, so they come in ticked and nothing is taken off.
    let on = [];
    const ids = Object.values(first.changes[0].after.extra_menus.find((x) => x.id === first.id)?.sites || {}).filter((v) => typeof v === 'string');
    if (ids.length && client) {
      const [home, links] = await Promise.all([
        readAllRows(() => client.from('menu_categories').select('id,menu_id').in('menu_id', ids).order('id')),
        readAllRows(() => client.from('menu_category_links').select('menu_id,category_id').in('menu_id', ids).order('menu_id').order('category_id')),
      ]);
      if (!home.rows || !links.rows) { setBusy(false); setNote?.({ tone: 'bad', text: 'Could not read what is on the sites\' own menus of that name. Nothing was changed. Try again.' }); return; }
      on = [...home.rows.map((c) => ({ menu_id: c.menu_id, category_id: c.id })), ...links.rows];
    }
    const r = addMenuChanges(ctx, name, { venueMenus: all, onVenueMenus: on });
    if (r.words) { setBusy(false); say(r); return; }
    const nm = name.trim();
    const matched = r.matched.map((loc) => sites.find((x) => x.id === loc)?.name).filter(Boolean);
    const res = await stage(r.changes, { done: `${nm} is in the draft as a new menu.${matched.length ? ` It uses the ${nm} menu ${matched.join(', ')} already ${matched.length === 1 ? 'has' : 'have'}.` : ''}${r.ticked.length ? ` Already on it there, so ticked in: ${r.ticked.join(', ')}.` : ''} Now tick categories into it on the Products tab.` });
    setBusy(false);
    if (res?.ok) setName('');
  };
  const rename = async () => {
    if (!renaming) return;
    const r = renameMenuChange(ctx, renaming.id, renaming.value);
    if (r.words) { say(r); return; }
    setRenaming(null);
    if (r.change) await stage([r.change], { done: `The menu is renamed to ${r.change.after.extra_menus.find((m) => m.id === renaming.id)?.name} in the draft. A site's own menu keeps the name it has.` });
  };
  const remove = async (m) => {
    const r = removeMenuChange(ctx, m.id);
    if (r.words) { say(r); return; }
    const yes = await confirm({
      title: `Remove the ${m.name} menu from the group menu?`,
      words: `When you publish, the group menu's categories come off the ${m.name} menu at every site. Each site's own ${m.name} menu stays there, as the site's own. No product is deleted.`,
      yes: 'Remove it', no: 'Keep it',
    });
    if (!yes) return;
    await stage(r.changes, { done: `${m.name} is removed in the draft.` });
  };
  const setSite = async (m, loc, v) => {
    const r = menuSiteChange(ctx, m.id, loc, v === '' ? null : v === 'off' ? false : v);
    if (r.words) { say(r); return; }
    if (r.change) await stage([r.change], { done: `${m.name} at ${sites.find((x) => x.id === loc)?.name || 'that site'}: in the draft.` });
  };

  return (
    <div style={ui.card} data-testid="msm-menus">
      {confirmDialog}
      <div style={{ ...ui.h2, marginBottom: 4 }}>Menus</div>
      <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>One list of products. Add another menu only when it sells different products, like Catering.</div>
      <div style={{ ...ui.sub, marginBottom: 12 }}>To hide a category on Online or the Kiosk, do not make a menu: use Shows on, on that category's row on the Products tab.</div>
      {!ready && <Notice tone="warn">More than one menu needs one database update that has not been run yet (SQL 20261214a). Ask ServOS to run it.</Notice>}
      <div style={{ padding: '8px 0', borderTop: '1px solid var(--bdr)' }}>
        <div style={{ ...ui.row }}>
          <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700 }}>{MAIN_MENU_WORDS}</div>
          <Pill>{countOn('main')} categor{countOn('main') === 1 ? 'y' : 'ies'}</Pill>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--t2)' }}>The menu every site already has (named under Sites, below).</div>
      </div>
      {list.map((m) => (
        <div key={m.id} style={{ padding: '10px 0', borderTop: '1px solid var(--bdr)' }} data-testid="msm-menu-row">
          <div style={{ ...ui.row }}>
            {renaming?.id === m.id ? (
              <>
                <input autoFocus aria-label={`New name for ${m.name}`} style={{ ...ui.input, flex: 1 }} maxLength={60} value={renaming.value} onChange={(e) => setRenaming({ id: m.id, value: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') rename(); else if (e.key === 'Escape') setRenaming(null); }} />
                <Btn small kind="primary" onClick={rename}>Save</Btn>
                <Btn small kind="link" onClick={() => setRenaming(null)}>Cancel</Btn>
              </>
            ) : (
              <>
                <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700 }}>{m.name}</div>
                <Pill>{countOn(m.id)} categor{countOn(m.id) === 1 ? 'y' : 'ies'}</Pill>
                {editable && <Btn small kind="link" onClick={() => setRenaming({ id: m.id, value: m.name })}>Rename</Btn>}
                {editable && <Btn small kind="link" data-testid="msm-menu-remove" onClick={() => remove(m)}>Remove</Btn>}
              </>
            )}
          </div>
          {sites.map((s) => {
            const at = extraMenuAt(m, s.id, venueMenus || new Map());
            const mainId = (eff?.sites || []).find((x) => x.location_id === s.id)?.venue_menu_id;
            const usedElsewhere = new Set(list.filter((x) => x.id !== m.id).map((x) => extraMenuAt(x, s.id, venueMenus || new Map()).id).filter(Boolean));
            const own = venueMenus ? [...venueMenus.values()].filter((v) => v.location_id === s.id && v.is_active !== false && v.id !== mainId && !usedElsewhere.has(v.id) && !(at.how === 'made' && v.id === at.id)) : [];
            const value = at.off ? 'off' : at.how === 'matched' ? at.id : '';
            return (
              <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0 0 10px', fontSize: 12.5, color: 'var(--t2)', flexWrap: 'wrap' }}>
                <strong style={{ minWidth: 120 }}>{s.name}</strong>
                <span style={{ flex: 1, minWidth: 160 }}>{menuAtSiteWords(m, s.id, venueMenus || new Map())}</span>
                {editable && (
                  <select aria-label={`${m.name} at ${s.name}`} data-testid="msm-menu-site" style={{ ...ui.input, width: 'auto', minWidth: 170, height: 30, padding: '2px 8px', fontSize: 12.5 }} value={value} onChange={(e) => setSite(m, s.id, e.target.value)}>
                    <option value="">{at.how === 'made' ? 'Use the one publish made' : 'Make one on publish'}</option>
                    {own.map((v) => <option key={v.id} value={v.id}>Use its own: {v.name || 'Menu'}</option>)}
                    <option value="off">Not at this site</option>
                  </select>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {editable && ready && (
        <div style={{ ...ui.row, marginTop: 12 }}>
          <input aria-label="New menu name" data-testid="msm-menu-name" style={{ ...ui.input, flex: 1 }} placeholder="A new menu, like Catering" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) add(); }} />
          <Btn kind="primary" data-testid="msm-menu-add" disabled={busy || !name.trim() || venueMenus === undefined} onClick={add}>{busy ? 'Adding…' : 'Add menu'}</Btn>
        </div>
      )}
      <div style={{ ...ui.sub, marginTop: 10 }}>A product is on a menu through its category. Which menu a POS, a kiosk, the online page and catering use is picked at each site, in its Back Office.</div>
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
          <span><strong>{PRICE_TYPE_WORDS[k]}</strong><span style={{ ...ui.sub, display: 'block' }}>{tt(TYPE_HELP[k])}</span></span>
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
      {/* Grey only for a draft that really clashes (the server refuses only those); any other
          waiting change is fine and the server's own words show if it refuses (round 2 review). */}
      {refreshClash(rows) && <div style={{ ...ui.sub, marginBottom: 8 }}>{REFRESH_CLASH_WORDS}</div>}
      {canEdit ? <Btn kind="primary" small disabled={busy || refreshClash(rows)} onClick={run}>{busy ? 'Refreshing…' : 'Refresh option groups from the sites'}</Btn>
        : <div style={ui.sub}>An editor can do it from here.</div>}
    </div>
  );
}
