// src/backoffice/sections/stock/CaloriesCard.jsx
//
// Show calories (v5.11.93, multi site stock Drop 2, contract 3.6 and decision 12): one venue
// setting, locations.pos_settings.show_calories, read by the kiosk, online ordering, QR, catering,
// the printed menu and the menu boards. Shown in Location settings for every company, multi and
// one site alike.
//
// Its own card, so Location settings stays main's file plus one import and one card line. The tick
// saves at once: pos_settings is read again and only show_calories is laid over it, so nothing
// saved elsewhere is put back. The screen's own Save merges the same way (lib/threeWayMerge.js
// mergeKeys) and keeps this key, because that screen never changes it.

import { useEffect, useState } from 'react';
import { supabase, getLocationId } from '../../../lib/supabase';
import { reportSave } from '../../../lib/saveHealth';
import { showCalories } from '../../../lib/menuStockFacts';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 24, marginBottom: 20 };

export const CALORIES_TITLE = 'Calories';
export const CALORIES_TICK = 'Show calories on the kiosk, online ordering, QR, catering, printed menus and menu boards';

export default function CaloriesCard() {
  const [on, setOn] = useState(null);       // null while it loads
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!supabase) { if (live) setOn(false); return; }
      const loc = await getLocationId().catch(() => null);
      if (!loc || loc === 'loc-demo') { if (live) setOn(false); return; }
      const { data } = await supabase.from('locations').select('pos_settings').eq('id', loc).maybeSingle();
      if (live) setOn(showCalories(data?.pos_settings));
    })().catch(() => { if (live) setOn(false); });
    return () => { live = false; };
  }, []);

  const save = async (next) => {
    setBusy(true); setProblem(''); setSaved(false);
    let err = null;
    try {
      const loc = await getLocationId().catch(() => null);
      if (!supabase || !loc) throw new Error('No venue for this session. Sign out and back in, then try again.');
      const { data: cur, error: readErr } = await supabase.from('locations').select('pos_settings').eq('id', loc).maybeSingle();
      if (readErr || !cur) throw readErr || new Error('Could not read this venue\'s settings, so nothing was saved.');
      const pos = { ...(cur.pos_settings && typeof cur.pos_settings === 'object' ? cur.pos_settings : {}), show_calories: next };
      const { data: rows, error: upErr } = await supabase.from('locations').update({ pos_settings: pos }).eq('id', loc).select('id');
      if (upErr) throw upErr;
      if (!rows || !rows.length) throw new Error('The setting was not saved. You may not have access to change this venue.');
      setOn(next);
      setSaved(true);
    } catch (e) {
      err = e;
      setProblem(e?.message || 'The setting was not saved.');
    }
    reportSave('show calories', err);
    setBusy(false);
  };

  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 4 }}>{CALORIES_TITLE}</div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: busy || on === null ? 'default' : 'pointer', marginTop: 8 }}>
        <input type="checkbox" checked={on === true} disabled={busy || on === null} onChange={(e) => save(e.target.checked)} style={{ marginTop: 3 }} />
        <span style={{ fontSize: 13, color: 'var(--t1)', lineHeight: 1.5 }}>{CALORIES_TICK}</span>
      </label>
      <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8, lineHeight: 1.5 }}>
        Each shows the kcal of a portion and the line "Adults need around 2,000 kcal a day". The figures come from the stock recipe linked at this site. A product with no recipe shows none.
      </div>
      {saved && !problem && <div style={{ fontSize: 12, color: 'var(--grn, #2f8f4e)', marginTop: 8, fontWeight: 700 }}>Saved</div>}
      {problem && <div style={{ fontSize: 12, color: 'var(--red, #b91c1c)', marginTop: 8, fontWeight: 700 }}>{problem}</div>}
    </div>
  );
}
