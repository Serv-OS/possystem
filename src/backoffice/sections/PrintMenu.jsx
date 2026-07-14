// src/backoffice/sections/PrintMenu.jsx
//
// Back office → Channels → "Print menu". Design a printable/PDF menu from the programmed menu:
// choose + order categories, columns, orientation, paper size, font, logo placement, what to
// show (description / allergens / price / dietary), and allergen + service-charge disclaimers.
// The preview and the export are the SAME jsPDF document (buildMenuPdf) — we generate the PDF
// ourselves rather than relying on the browser's print engine, so it looks identical in every
// browser (Safari included) and there are no CSS-print surprises. Config persists per location.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, isMock, platformSupabase, getActiveLocationSync } from '../../lib/supabase';
import { fetchMenuCategories, fetchMenuItems } from '../../lib/db';
import { DEFAULT_PRINT_CONFIG, PRINT_FONTS, PAPER } from '../../lib/printMenu';
import { buildMenuPdf } from '../../lib/printMenuPdf';

const CUR = { gbp: '£', usd: '$', eur: '€', aud: '$', cad: '$', nzd: '$' };

const S = {
  wrap: { display: 'grid', gridTemplateColumns: 'minmax(0,340px) minmax(0,1fr)', gap: 20, alignItems: 'start' },
  card: { border: '1px solid var(--bdr)', borderRadius: 14, background: 'var(--bg1)', padding: 16, marginBottom: 14 },
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, letterSpacing: '-.01em' },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, marginBottom: 16 },
  h2: { fontSize: 13.5, fontWeight: 800, color: 'var(--t1)', margin: '0 0 10px' },
  label: { display: 'block', fontSize: 11.5, fontWeight: 700, color: 'var(--t2)', marginBottom: 5 },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 9, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  field: { marginBottom: 12 },
  hint: { fontSize: 11, color: 'var(--t4)', marginTop: 4, lineHeight: 1.45 },
  btn: { padding: '10px 16px', borderRadius: 9, border: 'none', cursor: 'pointer', fontSize: 13.5, fontWeight: 800, fontFamily: 'inherit', background: 'var(--acc)', color: '#0b0c10' },
  ghost: { padding: '5px 9px', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  empty: { textAlign: 'center', padding: '60px 20px', color: 'var(--t3)', fontSize: 14 },
  catRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--bdr2)', marginBottom: 6, background: 'var(--bg2)' },
};

function Pills({ opts, val, on }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {opts.map(([v, l]) => (
        <button key={v} onClick={() => on(v)} style={{
          padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
          border: `1px solid ${String(val) === String(v) ? 'var(--acc)' : 'var(--bdr2)'}`,
          background: String(val) === String(v) ? 'var(--acc)' : 'var(--bg2)',
          color: String(val) === String(v) ? '#0b0c10' : 'var(--t2)',
        }}>{l}</button>
      ))}
    </div>
  );
}
function Toggle({ on, label, set }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', padding: '5px 0' }}>
      <input type="checkbox" checked={!!on} onChange={e => set(e.target.checked)} style={{ width: 16, height: 16 }} />
      <span style={{ fontSize: 12.5, color: 'var(--t1)' }}>{label}</span>
    </label>
  );
}
function Range({ label, val, min, max, step = 1, unit = '', set }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <label style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--t2)' }}>{label}</label>
        <span style={{ fontSize: 11, color: 'var(--t3)', fontWeight: 600 }}>{val}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={val}
        onChange={e => set(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--acc)', cursor: 'pointer' }} />
    </div>
  );
}

export default function PrintMenu() {
  const [locId, setLocId] = useState(null);
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [branding, setBranding] = useState({ logoUrl: null, brandColor: '#1a1a1a' });
  const [venueName, setVenueName] = useState('Menu');
  const [currencySymbol, setCurrencySymbol] = useState('£');
  const [cfg, setCfg] = useState(DEFAULT_PRINT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState('');   // '', 'saving', 'saved'
  const saveTimer = useRef(null);
  const loadedRef = useRef(false);
  const [logo, setLogo] = useState({ dataUri: null, aspect: 3 });   // logo fetched to a data-URI for the PDF
  const [pdfUrl, setPdfUrl] = useState(null);
  const pdfUrlRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const id = getActiveLocationSync();
      setLocId(id);
      if (isMock || !supabase || !id) { setLoading(false); return; }
      const [c, it, locRes] = await Promise.all([
        fetchMenuCategories(id),
        fetchMenuItems(id),
        supabase.from('locations').select('name, currency, print_menu_config').eq('id', id).maybeSingle(),
      ]);
      // menu_categories stores the display name in `label` (not `name`); normalise so
      // the checklist AND the printed headers both read `name`.
      setCats((c?.data || [])
        .filter(x => !x.parent_id && !x.is_special)
        .map(x => ({ ...x, name: x.label ?? x.name ?? 'Category' }))
        .sort((a, z) => (a.sort_order || 0) - (z.sort_order || 0)));
      setItems(it?.data || []);
      const loc = locRes?.data || {};
      setVenueName(loc.name || 'Menu');
      setCurrencySymbol(CUR[String(loc.currency || 'gbp').toLowerCase()] || '£');
      if (loc.print_menu_config && typeof loc.print_menu_config === 'object') {
        setCfg({ ...DEFAULT_PRINT_CONFIG, ...loc.print_menu_config,
          allergenNote: { ...DEFAULT_PRINT_CONFIG.allergenNote, ...(loc.print_menu_config.allergenNote || {}) },
          serviceNote: { ...DEFAULT_PRINT_CONFIG.serviceNote, ...(loc.print_menu_config.serviceNote || {}) } });
      }
      // Branding (logo + colour) lives on the platform location's online_branding.
      try {
        const { data: p } = await platformSupabase.from('locations').select('online_branding').or(`ops_location_id.eq.${id},id.eq.${id}`).maybeSingle();
        const b = p?.online_branding || {};
        setBranding({ logoUrl: b.logo_url || null, brandColor: b.brand_color || b.accent_color || '#1a1a1a' });
        if (b.logo_url) {                                   // fetch the logo to a data-URI so jsPDF can embed it
          try {
            const res = await fetch(b.logo_url);
            const blob = await res.blob();
            const dataUri = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(blob); });
            let aspect = 3;
            if (dataUri) aspect = await new Promise(r => { const im = new Image(); im.onload = () => r((im.naturalWidth / im.naturalHeight) || 3); im.onerror = () => r(3); im.src = dataUri; });
            setLogo({ dataUri: dataUri || null, aspect });
          } catch { setLogo({ dataUri: null, aspect: 3 }); }
        } else setLogo({ dataUri: null, aspect: 3 });
      } catch { /* branding best-effort */ }
      loadedRef.current = true;
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Persist config (debounced) once the initial load is done.
  useEffect(() => {
    if (!loadedRef.current || !locId || isMock || !supabase) return;
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await supabase.from('locations').update({ print_menu_config: cfg }).eq('id', locId);
        setSaveState('saved'); setTimeout(() => setSaveState(s => (s === 'saved' ? '' : s)), 1800);
      } catch { setSaveState(''); }
    }, 700);
    return () => clearTimeout(saveTimer.current);
  }, [cfg, locId]);

  const set = (patch) => setCfg(c => ({ ...c, ...patch }));
  const setNote = (key, patch) => setCfg(c => ({ ...c, [key]: { ...c[key], ...patch } }));

  const itemsByCat = useMemo(() => {
    const vis = items.filter(it => !it.archived && !(it.visibility && it.visibility.kiosk === false));
    const byId = Object.fromEntries(vis.map(i => [i.id, i]));
    const kids = {};
    for (const it of vis) if (it.parent_id && byId[it.parent_id]) (kids[it.parent_id] ||= []).push(it);
    for (const k in kids) kids[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const m = {};
    for (const it of vis) {
      if (it.parent_id && byId[it.parent_id]) continue;
      for (const cid of [it.cat, ...(Array.isArray(it.cats) ? it.cats : [])].filter(Boolean)) (m[cid] ||= []).push({ ...it, _variants: kids[it.id] || [] });
    }
    for (const k in m) m[k].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    return m;
  }, [items]);

  // Ordered category list for the picker: chosen (in order) first, then the rest.
  const chosenIds = (cfg.categoryIds && cfg.categoryIds.length) ? cfg.categoryIds.filter(id => cats.some(k => k.id === id)) : [];
  const orderedCats = [
    ...chosenIds.map(id => cats.find(k => k.id === id)).filter(Boolean),
    ...cats.filter(k => !chosenIds.includes(k.id)),
  ];
  const isChosen = (id) => chosenIds.length === 0 ? true : chosenIds.includes(id);  // empty selection = all
  const nItems = (id) => (itemsByCat[id] || []).length;

  const toggleCat = (id) => {
    // Start from the effective list (all when empty), then add/remove this id.
    const base = chosenIds.length ? chosenIds : cats.map(k => k.id);
    const next = base.includes(id) ? base.filter(x => x !== id) : [...base, id];
    set({ categoryIds: next });
  };
  const moveCat = (id, dir) => {
    const base = chosenIds.length ? [...chosenIds] : cats.map(k => k.id);
    const i = base.indexOf(id); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= base.length) return;
    [base[i], base[j]] = [base[j], base[i]];
    set({ categoryIds: base });
  };

  // Build the actual PDF (debounced) and expose it as a blob URL for the preview + export.
  // The preview IS the real PDF, so what you see is exactly what prints/saves.
  const genData = useMemo(() => ({
    venueName, logoDataUri: cfg.logo === 'none' ? null : logo.dataUri, logoAspect: logo.aspect,
    brandColor: branding.brandColor, currencySymbol, categories: cats, itemsByCat,
  }), [venueName, cfg.logo, logo, branding.brandColor, currencySymbol, cats, itemsByCat]);

  useEffect(() => {
    if (loading || !locId) return;
    const t = setTimeout(() => {
      try {
        const doc = buildMenuPdf(cfg, genData);
        const url = URL.createObjectURL(doc.output('blob'));
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        pdfUrlRef.current = url;
        setPdfUrl(url);
      } catch { /* keep the previous preview on a transient error */ }
    }, 180);
    return () => clearTimeout(t);
  }, [cfg, genData, loading, locId]);

  useEffect(() => () => { if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current); }, []);

  const printNow = () => {
    if (!pdfUrl) return;
    const w = window.open(pdfUrl, '_blank');   // opens the PDF viewer → user can print or save
    if (!w) alert('Please allow pop-ups to open the menu PDF for printing / saving.');
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!supabase || !locId) return <div style={S.empty}>Pick a location to design its print menu.</div>;

  const paper = PAPER[cfg.paper] || PAPER.a4;
  const land = cfg.orientation === 'landscape';

  return (
    <div>
      <h1 style={S.h1}>Print menu</h1>
      <div style={S.sub}>Design a printable menu from your programmed menu, then print it or save it as a PDF. Everything you change updates the preview live.</div>

      <div style={S.wrap}>
        {/* ── controls ── */}
        <div>
          {/* Heading + logo */}
          <div style={S.card}>
            <div style={S.h2}>Heading</div>
            <div style={S.field}><label style={S.label}>Title</label>
              <input style={S.input} value={cfg.title} placeholder={venueName} onChange={e => set({ title: e.target.value })} /></div>
            <div style={S.field}><label style={S.label}>Subtitle (optional)</label>
              <input style={S.input} value={cfg.subtitle} placeholder="e.g. Autumn menu · served 12–9pm" onChange={e => set({ subtitle: e.target.value })} /></div>
            <div style={S.field}><label style={S.label}>Logo</label>
              <Pills opts={[['top-center', 'Top centre'], ['top-left', 'Top left'], ['none', 'No logo']]} val={cfg.logo} on={v => set({ logo: v })} />
              {!branding.logoUrl && cfg.logo !== 'none' && <div style={S.hint}>No logo set — add one in <b>Menu appearance</b> to show it here.</div>}
            </div>
          </div>

          {/* Layout */}
          <div style={S.card}>
            <div style={S.h2}>Layout</div>
            <div style={S.field}><label style={S.label}>Paper size</label>
              <Pills opts={Object.entries(PAPER).map(([k, v]) => [k, v.label])} val={cfg.paper} on={v => set({ paper: v })} /></div>
            <div style={S.field}><label style={S.label}>Orientation</label>
              <Pills opts={[['portrait', 'Portrait'], ['landscape', 'Landscape']]} val={cfg.orientation} on={v => set({ orientation: v })} /></div>
            <div style={S.field}><label style={S.label}>Columns</label>
              <Pills opts={[['1', '1'], ['2', '2'], ['3', '3']]} val={String(cfg.columns)} on={v => set({ columns: Number(v) })} /></div>
            <div style={S.field}><label style={S.label}>Font</label>
              <select style={S.input} value={cfg.font} onChange={e => set({ font: e.target.value })}>
                {Object.entries(PRINT_FONTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select></div>
            <div style={S.field}><label style={S.label}>Accent colour</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(cfg.accent) ? cfg.accent : (branding.brandColor || '#1a1a1a')} onChange={e => set({ accent: e.target.value })} style={{ width: 42, height: 34, border: '1px solid var(--bdr2)', borderRadius: 8, background: 'none', cursor: 'pointer' }} />
                <button style={S.ghost} onClick={() => set({ accent: '' })}>Use brand colour</button>
              </div></div>
          </div>

          {/* Spacing & size */}
          <div style={S.card}>
            <div style={S.h2}>Spacing &amp; size</div>
            <div style={S.field}><label style={S.label}>Text size</label>
              <Pills opts={[['0.9', 'Small'], ['1', 'Medium'], ['1.15', 'Large']]} val={String(cfg.fontScale)} on={v => set({ fontScale: Number(v) })} /></div>
            <Range label="Space between items" val={cfg.itemGap} min={0} max={24} unit="px" set={v => set({ itemGap: v })} />
            <Range label="Space between sections" val={cfg.sectionGap} min={2} max={40} unit="px" set={v => set({ sectionGap: v })} />
            {Number(cfg.columns) > 1 && <Range label="Space between columns" val={cfg.columnGap} min={8} max={36} unit="px" set={v => set({ columnGap: v })} />}
          </div>

          {/* Show / hide */}
          <div style={S.card}>
            <div style={S.h2}>Show on the menu</div>
            <Toggle on={cfg.showDescription} label="Descriptions" set={v => set({ showDescription: v })} />
            <Toggle on={cfg.showPrice} label="Prices" set={v => set({ showPrice: v })} />
            <Toggle on={cfg.leaders} label="Dotted line to the price" set={v => set({ leaders: v })} />
            <Toggle on={cfg.showAllergens} label="Allergens (per item)" set={v => set({ showAllergens: v })} />
            <Toggle on={cfg.showDietary} label="Dietary badges (GF / V / VG)" set={v => set({ showDietary: v })} />
          </div>

          {/* Categories */}
          <div style={S.card}>
            <div style={S.h2}>Categories</div>
            <div style={S.hint}>Tick to include, drag order with the arrows. Empty categories are skipped.</div>
            <div style={{ marginTop: 8 }}>
              {orderedCats.length === 0 && <div style={{ fontSize: 12, color: 'var(--t4)' }}>No categories yet.</div>}
              {orderedCats.map((k) => (
                <div key={k.id} style={{ ...S.catRow, opacity: nItems(k.id) ? 1 : 0.5 }}>
                  <input type="checkbox" checked={isChosen(k.id)} onChange={() => toggleCat(k.id)} style={{ width: 15, height: 15 }} />
                  <span style={{ flex: 1, fontSize: 12.5, color: 'var(--t1)', fontWeight: 600 }}>{k.name} <span style={{ color: 'var(--t4)', fontWeight: 500 }}>· {nItems(k.id)}</span></span>
                  <button style={{ ...S.ghost, padding: '2px 7px' }} onClick={() => moveCat(k.id, -1)} title="Move up">▲</button>
                  <button style={{ ...S.ghost, padding: '2px 7px' }} onClick={() => moveCat(k.id, 1)} title="Move down">▼</button>
                </div>
              ))}
            </div>
          </div>

          {/* Disclaimers */}
          <div style={S.card}>
            <div style={S.h2}>Disclaimers &amp; footer</div>
            <Toggle on={cfg.allergenNote.show} label="Allergen disclaimer" set={v => setNote('allergenNote', { show: v })} />
            {cfg.allergenNote.show && <textarea style={{ ...S.input, minHeight: 54, resize: 'vertical', marginBottom: 10 }} value={cfg.allergenNote.text} onChange={e => setNote('allergenNote', { text: e.target.value })} />}
            <Toggle on={cfg.serviceNote.show} label="Service-charge disclaimer" set={v => setNote('serviceNote', { show: v })} />
            {cfg.serviceNote.show && <textarea style={{ ...S.input, minHeight: 44, resize: 'vertical', marginBottom: 10 }} value={cfg.serviceNote.text} onChange={e => setNote('serviceNote', { text: e.target.value })} />}
            <div style={S.field}><label style={S.label}>Footer line (optional)</label>
              <input style={S.input} value={cfg.footer} placeholder="e.g. 12 High St · 01234 567890 · yourvenue.com" onChange={e => set({ footer: e.target.value })} /></div>
          </div>
        </div>

        {/* ── preview + export ── */}
        <div style={{ position: 'sticky', top: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <button style={S.btn} onClick={printNow}>Print / Save as PDF</button>
            <span style={{ fontSize: 11.5, color: 'var(--t3)' }}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : `${paper.label} · ${land ? 'Landscape' : 'Portrait'} · ${cfg.columns} col`}
            </span>
          </div>
          <div style={{ background: 'var(--bg0)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 8, height: 780 }}>
            {pdfUrl
              ? <iframe key={cfg.paper + cfg.orientation} title="Menu preview" src={`${pdfUrl}#toolbar=0&navpanes=0&view=FitH`}
                  style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8, background: '#fff' }} />
              : <div style={S.empty}>Generating preview…</div>}
          </div>
          <div style={S.hint}>This preview is the real PDF — exactly what prints. Scroll to see every page. Use <b>Print / Save as PDF</b> to open it in your browser’s viewer, then print or save.</div>
        </div>
      </div>
    </div>
  );
}
