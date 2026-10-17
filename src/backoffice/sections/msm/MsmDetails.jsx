// src/backoffice/sections/msm/MsmDetails.jsx
//
// MULTI SITE MENU (v5.11.75): the menu's details. Its name and description, whether that name is
// written to each site's own menu, and every site with the menu it writes into. Each site's menu
// schedule, priority and default stay that site's own (timed menus are venue owned): shown here,
// never changed by publishing.

import { useEffect, useMemo, useState } from 'react';
import { readAllRows } from '../../../../supabase/functions/_shared/venueMenuCore.js';
import { Btn, Pill, Switch, Field, Notice } from './msmUi';
import { ui } from './msmStyle';

export default function MsmDetails({ client, menu, live, eff, sites, stage, editable }) {
  const effMenu = eff?.menu || menu;
  // What the person is typing; null = show the menu as it is (with the draft).
  const [typed, setTyped] = useState(null);
  const name = typed?.name ?? effMenu?.name ?? '';
  const description = typed?.description ?? effMenu?.description ?? '';
  const setName = (v) => setTyped((t) => ({ name: v, description: t?.description ?? description }));
  const setDescription = (v) => setTyped((t) => ({ name: t?.name ?? name, description: v }));
  const [read, setRead] = useState({ key: '', menus: null });
  const [saving, setSaving] = useState(false);

  const ids = useMemo(() => (live?.sites || []).map((s) => s.venue_menu_id).filter(Boolean), [live]);
  const idsKey = ids.join('|');
  useEffect(() => {
    let on = true;
    if (!client || !ids.length) return undefined;
    readAllRows(() => client.from('menus').select('*').in('id', ids).order('id')).then((r) => {
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

  const save = async (extra = {}) => {
    const after = {};
    const before = {};
    const nm = name.trim();
    if (!nm) return;
    if (nm !== effMenu.name) { after.name = nm; before.name = menu.name; }
    if (description !== (effMenu.description || '')) { after.description = description; before.description = menu.description || ''; }
    Object.assign(after, extra);
    for (const k of Object.keys(extra)) before[k] = menu[k] ?? false;
    if (!Object.keys(after).length) return;
    setSaving(true);
    const r = await stage([{ target: 'menu', entity_id: menu.id, location_id: null, op: 'update', after, before }], { done: 'Menu details are in the draft.' });
    setSaving(false);
    if (r?.ok) setTyped(null);
  };

  const schedText = (m) => {
    if (!m) return '';
    const s = m.schedule || m.availability || null;
    if (!s || (typeof s === 'object' && !Object.keys(s).length)) return 'Times: all day';
    return 'Has its own times';
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
          <label style={{ ...ui.row, fontSize: 13, marginBottom: 14, cursor: 'pointer' }}>
            <Switch on={!!effMenu?.use_name_everywhere} disabled={!editable || saving} onChange={(v) => save({ use_name_everywhere: v })} />
            Use this name and description at every site (kiosk and online menu tabs)
          </label>
          {editable && <Btn kind="primary" disabled={saving || !name.trim()} onClick={() => save()}>Save to the draft</Btn>}
        </fieldset>
        <div style={{ ...ui.sub, marginTop: 16 }}>
          {products.length} products in {(eff?.categories || []).filter((c) => !c.archived).length} categories.
          {menu?.last_published_at ? ` Last published ${new Date(menu.last_published_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${menu.last_published_by ? ` by ${menu.last_published_by}` : ''}.` : ''}
          {menu?.last_version_no ? ` Version ${menu.last_version_no}.` : ''}
        </div>
      </div>
      <div style={ui.card}>
        <div style={{ ...ui.h2, marginBottom: 4 }}>Sites</div>
        <div style={{ ...ui.sub, marginBottom: 12 }}>Each site's own menu, which this group menu writes into when published. Its times and whether it is the default stay that site's own.</div>
        {venueMenus === null && <Notice tone="bad">Could not read the sites' own menus.</Notice>}
        {venueMenus === undefined && <div style={{ ...ui.sub, marginBottom: 8 }}>Reading the sites' own menus…</div>}
        {sites.map((s) => {
          const ms = (live?.sites || []).find((x) => x.location_id === s.id);
          const vm = venueMenus?.get(ms?.venue_menu_id);
          return (
            <div key={s.id} style={{ ...ui.row, padding: '9px 0', borderTop: '1px solid var(--bdr)' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{s.name}</div>
                <div style={ui.sub}>{vm ? `${vm.name || 'Menu'} · ${schedText(vm)}${vm.is_default ? ' · default' : ''}` : ms?.venue_menu_id ? 'Its menu' : 'A menu is made on first publish'}</div>
              </div>
              <Pill>{counts.get(s.id) || 0} on sale</Pill>
              {ms?.last_error && <Pill tone="bad" title={ms.last_error}>Last publish failed</Pill>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
