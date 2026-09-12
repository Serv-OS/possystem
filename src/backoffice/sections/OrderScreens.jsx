// src/backoffice/sections/OrderScreens.jsx
//
// Back Office, Channels, Order screens. A TV that shows customers and delivery drivers
// which orders are received, preparing, ready and collected.
//
// A config is an order_status_displays row (sections, status words, timing, colours).
// A TV is a menu_board_screens row paired by code with claim_order_status_screen, so the
// menu board APK and its pairing code screen serve both kinds of display.
// Saves are live: paired TVs pick up a change on their next poll or ping.
//
// Before 20260911_OPS_order_status_displays.sql is applied, this section renders one
// line and nothing else (listOrderDisplays returns absent).
//
// House rules here: text 15px or more, one primary button per box, no dashes in copy.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getActiveLocationSync } from '../../lib/supabase';
import { getLocationConfig } from '../../lib/locationTime';
import OrderBoard from '../../surfaces/orderScreen/OrderBoard';
import {
  CHANNELS, ORDER_TYPES, STEPS, DEFAULT_LABELS, MAX_SECTIONS, MAX_LANDSCAPE_SECTIONS,
  newDisplayTemplate, newSection, normaliseDisplay, validateDisplay,
  evaluateOrder, sampleOrders, sortRows, lastSeenLabel, resolveNumberClashes,
} from '../../lib/orderScreen/orderScreenStatus';
import {
  listOrderDisplays, saveOrderDisplay, deleteOrderDisplay,
  listOrderScreens, pairOrderScreen, setOrderScreen, removeOrderScreen,
  loadKeepPaidSetting, saveKeepPaidSetting, uploadOrderScreenLogo, loadVenueName,
  loadNamesEnabled, LOGO_TYPES,
} from '../../lib/orderScreen/orderScreenData';

const ABSENT_LINE = 'Order screens need a database update before you can use them. Ask ServOS support to switch them on.';
const NAME_OPTIONS = [
  ['short', 'First name and last initial'],
  ['full', 'Full name'],
  ['number', 'Order number only'],
];
const COLOUR_FIELDS = [
  ['headerBg', 'Header background'],
  ['headerText', 'Header text'],
  ['bg', 'Page background'],
  ['text', 'Page text'],
  ['readyBg', 'Ready highlight'],
  ['readyText', 'Ready text'],
];
const LABEL_FIELDS = [
  ['received', 'When the order is received'],
  ['preparing', 'While it is being made'],
  ['ready', 'When it is ready'],
  ['collected', 'After it is collected'],
];
const EMPTY_SET = new Set();
const HEX_RE = /^#[0-9a-f]{6}$/i;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const toggleIn = (list, key) => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]);

export default function OrderScreens() {
  // Back Office remounts sections on a venue switch, so the venue is read once here.
  const [locId] = useState(() => getActiveLocationSync());
  const [loading, setLoading] = useState(() => !!locId);
  const [absent, setAbsent] = useState(false);
  const [displays, setDisplays] = useState([]);
  const [screens, setScreens] = useState([]);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // State is set only in the promise callback, never synchronously inside the effect.
  const load = useCallback(() => {
    if (!locId) return Promise.resolve();
    return Promise.all([listOrderDisplays(locId), listOrderScreens(locId)]).then(([d, s]) => {
      setNow(Date.now());
      if (d.absent) { setAbsent(true); setLoading(false); return; }
      setAbsent(false);
      setDisplays(d.data || []);
      setScreens(s.absent ? [] : (s.data || []));
      setErr(d.error ? d.message : (s.error && !s.absent ? s.message : ''));
      setLoading(false);
    });
  }, [locId]);
  useEffect(() => { load(); }, [load]);

  // Paired TVs reload every 30 seconds while this section is open, so "Online" stays true.
  const reloadScreens = useCallback(async () => {
    if (!locId) return;
    const s = await listOrderScreens(locId);
    setNow(Date.now());
    if (!s.error && !s.absent) setScreens(s.data || []);
  }, [locId]);
  useEffect(() => {
    if (!locId || absent) return undefined;
    const t = setInterval(reloadScreens, 30000);
    return () => clearInterval(t);
  }, [locId, absent, reloadScreens]);

  const del = async (d) => {
    if (!window.confirm('Delete this order screen? Any TV showing it will go back to its pairing code.')) return;
    setBusy('del-' + d.id);
    const r = await deleteOrderDisplay(d.id, locId);
    setBusy('');
    if (r.error) { setErr(r.message || 'Could not delete. Try again.'); return; }
    setErr('');
    load();
  };

  if (loading) return <div style={S.empty}>Loading order screens.</div>;
  if (!locId) return <div style={S.empty}>Choose a venue at the top of Back Office first.</div>;
  if (absent) return <div style={S.absent}>{ABSENT_LINE}</div>;

  if (editing) {
    return (
      <Editor
        initial={editing}
        locId={locId}
        onSaved={load}
        onClose={() => { setEditing(null); load(); }}
      />
    );
  }

  const tvCount = (id) => screens.filter(s => s.order_display_id === id && s.status === 'paired').length;

  return (
    <div style={S.page}>
      <Head title="Order screens" />
      {err && <div style={S.errBar} role="alert">{err}</div>}

      <Box title="Order screens" help={['Show customers and delivery drivers when their order is ready.']}>
        <div style={S.cards}>
          {displays.map(d => {
            const n = normaliseDisplay(d);
            return (
              <div key={d.id} style={S.card}>
                <div style={S.cardTitle}>{n.name}</div>
                <div style={S.meta}>{n.orientation === 'landscape' ? 'Landscape' : 'Portrait'}</div>
                <div style={S.meta}>{plural(n.sections.length, 'section')}</div>
                <div style={S.meta}>{plural(tvCount(d.id), 'TV')} paired</div>
                {!n.is_active && <div style={{ ...S.meta, color: 'var(--red)', fontWeight: 700 }}>Turned off</div>}
                <div style={S.row}>
                  <button type="button" style={S.btn} onClick={() => setEditing(n)}>Edit</button>
                  <button type="button" style={S.btnGhost} onClick={() => del(d)} disabled={busy === 'del-' + d.id}>
                    {busy === 'del-' + d.id ? 'Deleting' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}
          {displays.length === 0 && <div style={S.help}>No order screens yet.</div>}
        </div>
        <div style={{ marginTop: 16 }}>
          <button type="button" style={S.btnPrimary} onClick={() => setEditing(newDisplayTemplate())}>New order screen</button>
        </div>
      </Box>

      <PairedTvs displays={displays} screens={screens} now={now} onChanged={load} />

      <KeepPaidBox locId={locId} />
    </div>
  );
}

// ── Box 2: paired TVs ──────────────────────────────────────────────────────────────

function PairedTvs({ displays, screens, now, onChanged }) {
  const [code, setCode] = useState('');
  const [displayId, setDisplayId] = useState('');
  const [msg, setMsg] = useState({ ok: true, text: '' });
  const [busy, setBusy] = useState('');

  const pair = async () => {
    if (!code.trim() || !displayId) {
      setMsg({ ok: false, text: 'Type the code on the TV and choose an order screen.' });
      return;
    }
    setBusy('pair'); setMsg({ ok: true, text: '' });
    const r = await pairOrderScreen(code, displayId);
    setBusy('');
    if (r.error || r.absent) { setMsg({ ok: false, text: r.message }); return; }
    setCode(''); setDisplayId('');
    setMsg({ ok: true, text: 'Screen paired. It shows orders within a few seconds.' });
    onChanged();
  };

  const reassign = async (screenId, value) => {
    if (!value && !window.confirm('Stop showing orders on this TV? It will show its pairing code again.')) return;
    setBusy('tv-' + screenId); setMsg({ ok: true, text: '' });
    const r = await setOrderScreen(screenId, value || null);
    setBusy('');
    if (r.error || r.absent) { setMsg({ ok: false, text: r.message }); return; }
    setMsg({
      ok: true,
      text: value
        ? 'TV updated. It shows that order screen within a few seconds.'
        : 'TV unpaired. It shows its pairing code again within a few seconds.',
    });
    onChanged();
  };

  const remove = async (screenId) => {
    if (!window.confirm('Remove this TV? It shows a new pairing code next time it starts.')) return;
    setBusy('tv-' + screenId); setMsg({ ok: true, text: '' });
    const r = await removeOrderScreen(screenId);
    setBusy('');
    if (r.error) { setMsg({ ok: false, text: r.message }); return; }
    onChanged();
  };

  const nameOf = (id) => displays.find(d => d.id === id)?.name || 'Order screen';

  return (
    <Box title="Paired TVs" help={[
      'Open the Serv OS Menu app on the TV. Type the code it shows in the box below, choose an order screen and tap Pair screen.',
      'On an iPad or a TV browser, open ServOS and choose Order screen to see its code.',
    ]}>
      <div style={{ ...S.row, alignItems: 'flex-end' }}>
        <div style={{ width: 300 }}>
          <Field label="Code on the TV">
            <input
              style={{ ...S.inp, textTransform: 'uppercase' }}
              placeholder="For example K7P2 9XQM"
              value={code}
              onChange={e => setCode(e.target.value)}
            />
          </Field>
        </div>
        <div style={{ width: 260 }}>
          <Field label="Order screen">
            <select style={S.inp} value={displayId} onChange={e => setDisplayId(e.target.value)}>
              <option value="">Choose an order screen</option>
              {displays.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
        </div>
        <button type="button" style={S.btnPrimary} onClick={pair} disabled={busy === 'pair' || displays.length === 0}>
          {busy === 'pair' ? 'Pairing' : 'Pair screen'}
        </button>
      </div>
      {displays.length === 0 && <div style={{ ...S.help, marginTop: 10 }}>Create an order screen above before you pair a TV.</div>}
      {msg.text && <div style={{ ...S.help, marginTop: 10, color: msg.ok ? 'var(--grn)' : 'var(--red)' }} role="status">{msg.text}</div>}

      {screens.length === 0 ? (
        <div style={{ ...S.help, marginTop: 14 }}>No TVs are paired yet.</div>
      ) : (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {screens.map(s => {
            const seen = lastSeenLabel(s.last_seen_at, now);
            const rowBusy = busy === 'tv-' + s.id;
            return (
              <div key={s.id} style={S.tvRow}>
                <span style={{ ...S.dot, background: seen.online ? 'var(--grn)' : 'var(--bdr2)' }} aria-hidden="true" />
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={S.cardTitle}>{s.order_display_id ? nameOf(s.order_display_id) : 'Not showing anything'}</div>
                  <div style={S.meta}>{s.code} · {seen.text}</div>
                </div>
                <select
                  style={{ ...S.inp, width: 240 }}
                  value={s.order_display_id || ''}
                  disabled={rowBusy}
                  aria-label="What this TV shows"
                  onChange={e => reassign(s.id, e.target.value)}
                >
                  <option value="">Not showing anything</option>
                  {displays.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <button type="button" style={S.btnGhost} onClick={() => remove(s.id)} disabled={rowBusy}>Remove</button>
              </div>
            );
          })}
        </div>
      )}
    </Box>
  );
}

// ── Box 3: keep paid till orders in the queue ────────────────────────────────────────

function KeepPaidBox({ locId }) {
  const [value, setValue] = useState(null);
  const [msg, setMsg] = useState({ ok: true, text: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    loadKeepPaidSetting(locId).then(r => {
      if (!alive) return;
      if (r.error) setMsg({ ok: false, text: 'Could not load this setting. Refresh to try again.' });
      else setValue(r.data === true);
    });
    return () => { alive = false; };
  }, [locId]);

  const change = async (next) => {
    const prev = value;
    setValue(next); setBusy(true); setMsg({ ok: true, text: '' });
    const r = await saveKeepPaidSetting(locId, next);
    setBusy(false);
    if (r.error) { setValue(prev); setMsg({ ok: false, text: 'Could not save. Try again.' }); return; }
    setMsg({ ok: true, text: 'Saved' });
  };

  return (
    <Box title="Paid till orders" help={[
      'Turn this on when customers pay at the till and then wait for their order.',
      'Staff must tap Ready and then Collected in Orders Hub, so the order screen stays right.',
      'Until staff tap Collected, the order stays open and adds to the wait time online and kiosk customers see.',
      'Customers who gave a phone number or email may get messages when their order is confirmed and when it is ready.',
      'Tills pick up this change the next time they start.',
    ]}>
      <Check
        checked={value === true}
        disabled={value === null || busy}
        onChange={change}
        label="Keep paid till orders in Orders Hub until they are collected"
      />
      {msg.text && <div style={{ ...S.help, marginTop: 8, color: msg.ok ? 'var(--grn)' : 'var(--red)' }} role="status">{msg.text}</div>}
    </Box>
  );
}

// ── Editor ─────────────────────────────────────────────────────────────────────────

function Editor({ initial, locId, onSaved, onClose }) {
  const [draft, setDraft] = useState(initial);
  const [msgs, setMsgs] = useState([]);
  const [notice, setNotice] = useState('');
  const [saveErr, setSaveErr] = useState('');
  const [busy, setBusy] = useState('');
  const [tz, setTz] = useState(null);
  const [venueName, setVenueName] = useState('');
  // true: TVs may show names. false: numbers only until the order security update. null: unknown.
  const [namesEnabled, setNamesEnabled] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  // Venue clock for the preview, never the device zone. The venue name is what the TV
  // header shows when Header text is blank.
  useEffect(() => {
    let alive = true;
    getLocationConfig(locId).then(c => { if (alive) setTz(c?.timezone || null); }).catch(() => {});
    loadVenueName(locId).then(r => { if (alive && r.data) setVenueName(r.data); });
    loadNamesEnabled().then(r => { if (alive) setNamesEnabled(r.data); });
    return () => { alive = false; };
  }, [locId]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setSettings = (patch) => setDraft(d => ({ ...d, settings: { ...d.settings, ...patch } }));
  const setTheme = (patch) => setDraft(d => ({ ...d, theme: { ...d.theme, ...patch } }));
  const setLabels = (patch) => setDraft(d => ({ ...d, labels: { ...d.labels, ...patch } }));
  const setSection = (i, patch) => setDraft(d => ({ ...d, sections: d.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const moveSection = (i, dir) => setDraft(d => {
    const j = i + dir;
    if (j < 0 || j >= d.sections.length) return d;
    const a = [...d.sections];
    [a[i], a[j]] = [a[j], a[i]];
    return { ...d, sections: a };
  });
  const removeSection = (i) => setDraft(d => ({ ...d, sections: d.sections.filter((_, j) => j !== i) }));
  const addSection = () => setDraft(d => {
    if (d.sections.length >= (d.orientation === 'landscape' ? MAX_LANDSCAPE_SECTIONS : MAX_SECTIONS)) return d;
    const used = new Set(d.sections.map(s => s.id));
    let k = d.sections.length + 1;
    while (used.has(`s${k}`)) k += 1;
    return { ...d, sections: [...d.sections, newSection(k)] };
  });

  const upload = async (file) => {
    if (!file) return;
    setBusy('logo'); setSaveErr('');
    const r = await uploadOrderScreenLogo(locId, file);
    setBusy('');
    if (r.error) { setSaveErr(r.message); return; }
    setTheme({ logoUrl: r.data });
  };

  const save = async () => {
    const found = validateDisplay(draft);
    setMsgs(found); setNotice(''); setSaveErr('');
    if (found.length) return;
    setBusy('save');
    const r = await saveOrderDisplay({ ...draft, location_id: locId });
    setBusy('');
    if (r.error) { setSaveErr(r.message || 'Could not save. Try again.'); return; }
    setDraft(d => ({ ...d, id: r.data.id }));
    setNotice('Saved. Paired TVs update within a few seconds.');
    onSaved();
  };

  // Same rules as the TV feed: no names while the TV shows numbers only, and 4 characters
  // for online, catering and QR codes that clash in a section.
  const preview = useMemo(() => {
    const display = normaliseDisplay(draft);
    const opts = { namesEnabled: namesEnabled !== false };
    const rows = sortRows(resolveNumberClashes(
      sampleOrders(now).map(o => evaluateOrder(o, display, now, opts)).filter(r => r.visible).map(r => r.row),
    ));
    return { display, rows };
  }, [draft, now, namesEnabled]);

  const portrait = draft.orientation !== 'landscape';
  const sections = Array.isArray(draft.sections) ? draft.sections : [];
  const maxSections = portrait ? MAX_SECTIONS : MAX_LANDSCAPE_SECTIONS;
  const settings = draft.settings || {};
  const theme = draft.theme || {};
  const labels = draft.labels || {};

  return (
    <div style={S.page}>
      <button type="button" style={S.back} onClick={onClose}>Back to order screens</button>
      <Head title={draft.id ? 'Edit order screen' : 'New order screen'} />

      <div style={S.editorGrid}>
        <div style={S.formCol}>
          {/* 1. Screen */}
          <Box title="Screen">
            <Field label="Name">
              <input style={S.inp} maxLength={60} value={draft.name || ''} onChange={e => set({ name: e.target.value })} />
            </Field>
            <Field label="Shape">
              <div style={S.row}>
                <Radio name="orientation" checked={portrait} onChange={() => set({ orientation: 'portrait' })} label="Portrait" />
                <Radio name="orientation" checked={!portrait} onChange={() => set({ orientation: 'landscape', rotate: 0 })} label="Landscape" />
              </div>
            </Field>
            {portrait && (
              <Field label="If the TV shows the picture sideways">
                <div style={S.row}>
                  <Radio name="rotate" checked={Number(draft.rotate) === 0} onChange={() => set({ rotate: 0 })} label="Do not turn" />
                  <Radio name="rotate" checked={Number(draft.rotate) === 90} onChange={() => set({ rotate: 90 })} label="Turn right" />
                  <Radio name="rotate" checked={Number(draft.rotate) === 270} onChange={() => set({ rotate: 270 })} label="Turn left" />
                </div>
                <p style={S.helpP}>The Serv OS Menu TV app always runs landscape. If your TV hangs portrait, choose Turn right or Turn left.</p>
              </Field>
            )}
            <Check checked={draft.is_active !== false} onChange={v => set({ is_active: v })} label="Show orders on this screen" />
          </Box>

          {/* 2. Header */}
          <Box title="Header">
            <Field label="Header text">
              <input style={S.inp} maxLength={40} value={settings.headerText ?? ''} onChange={e => setSettings({ headerText: e.target.value })} />
              <p style={S.helpP}>Leave blank to show your venue name.</p>
            </Field>
            <div style={S.row}>
              <label style={{ ...S.btn, display: 'inline-block', opacity: busy === 'logo' ? 0.6 : 1 }}>
                {busy === 'logo' ? 'Uploading' : 'Upload logo'}
                <input type="file" accept={Object.keys(LOGO_TYPES).join(',')} hidden disabled={busy === 'logo'}
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; upload(f); }} />
              </label>
              {theme.logoUrl && <button type="button" style={S.btnGhost} onClick={() => setTheme({ logoUrl: '' })}>Remove logo</button>}
            </div>
            <div style={S.colourGrid}>
              {COLOUR_FIELDS.map(([key, label]) => (
                <Field key={key} label={label}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="color" aria-label={label} value={HEX_RE.test(theme[key] || '') ? theme[key] : '#000000'}
                      onChange={e => setTheme({ [key]: e.target.value.toUpperCase() })} style={S.swatch} />
                    <input style={{ ...S.inp, width: 120 }} aria-label={`${label} colour code`} value={theme[key] ?? ''}
                      onChange={e => setTheme({ [key]: e.target.value.trim() })} />
                  </div>
                </Field>
              ))}
            </div>
          </Box>

          {/* 3. Sections */}
          <Box title="Sections" help={[
            'If an order matches more than one section, it shows in the first one.',
            'Delivery app orders show the app name and its order code, so drivers can find theirs.',
          ]}>
            {sections.map((sec, i) => (
              <SectionCard
                key={sec.id || i}
                index={i}
                count={sections.length}
                sec={sec}
                labels={labels}
                namesEnabled={namesEnabled}
                onChange={patch => setSection(i, patch)}
                onMove={dir => moveSection(i, dir)}
                onRemove={() => removeSection(i)}
              />
            ))}
            <div>
              <button type="button" style={S.btn} onClick={addSection} disabled={sections.length >= maxSections}>Add section</button>
              {sections.length >= maxSections && (
                <span style={{ ...S.help, marginLeft: 12 }}>
                  {portrait ? 'You can have up to 4 sections.' : 'Landscape screens fit up to 3 sections.'}
                </span>
              )}
            </div>
          </Box>

          {/* 4. Status words */}
          <Box title="Status words">
            <div style={S.colourGrid}>
              {LABEL_FIELDS.map(([key, label]) => (
                <Field key={key} label={label}>
                  <input style={S.inp} maxLength={24} placeholder={DEFAULT_LABELS[key]} value={labels[key] ?? ''}
                    onChange={e => setLabels({ [key]: e.target.value })} />
                </Field>
              ))}
            </div>
          </Box>

          {/* 4b. Customer names, only while the orders table still has its old open permission */}
          {namesEnabled === false && (
            <Box title="Customer names" help={[
              'Your orders table still has an old permission that lets any caller add an order.',
              'So names are hidden on TVs until that is fixed, and screens show order numbers.',
            ]}>
              <Check checked={settings.showNamesNow === true} onChange={v => setSettings({ showNamesNow: v })}
                label="Show customer names now" />
              {settings.showNamesNow === true && (
                <div style={S.warn} role="note">
                  Names will show on this screen. Someone who knows how could place a fake order and put words on it. Turn this off if that worries you.
                </div>
              )}
            </Box>
          )}

          {/* 5. Timing and sound */}
          <Box title="Timing and sound" help={['Orders show as Ready when staff tap Ready in Orders Hub or on the handheld till.']}>
            <Field label="Keep collected orders on screen for this many minutes" help="0 means the order leaves the screen the moment staff tap Collected.">
              <input type="number" min={0} max={30} step={1} style={{ ...S.inp, width: 120 }}
                value={settings.lingerMinutes ?? ''} onChange={e => setSettings({ lingerMinutes: e.target.value })} />
            </Field>
            <Field label="Hide orders older than this many hours">
              <input type="number" min={1} max={24} step={1} style={{ ...S.inp, width: 120 }}
                value={settings.maxAgeHours ?? ''} onChange={e => setSettings({ maxAgeHours: e.target.value })} />
            </Field>
            <Check checked={settings.showUnacceptedPlatform === true} onChange={v => setSettings({ showUnacceptedPlatform: v })}
              label="Show delivery app orders before you accept them" />
            <Check checked={settings.chime === true} onChange={v => setSettings({ chime: v })}
              label="Play a sound when an order is ready" />
          </Box>

          {/* 7. Save bar */}
          <div style={S.saveBar}>
            {msgs.length > 0 && (
              <ul style={S.msgList} role="alert">
                {msgs.map(m => <li key={m}>{m}</li>)}
              </ul>
            )}
            {saveErr && <div style={S.errBar} role="alert">{saveErr}</div>}
            {notice && <div style={{ ...S.help, color: 'var(--grn)' }} role="status">{notice}</div>}
            <div style={S.row}>
              <button type="button" style={S.btnPrimary} onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? 'Saving' : 'Save changes'}
              </button>
              <button type="button" style={S.btn} onClick={onClose}>Cancel</button>
            </div>
          </div>
        </div>

        {/* 6. Preview */}
        <div style={S.previewCol}>
          <Box title="Preview" help={['Sample orders only. Real customer names never show here.', 'Text on the TV is much larger than this preview.']}>
            <div style={{
              position: 'relative', width: '100%', maxWidth: portrait ? 360 : 640,
              aspectRatio: portrait ? '9 / 16' : '16 / 9', overflow: 'hidden',
              borderRadius: 12, border: '1px solid var(--bdr)', background: preview.display.theme.bg,
            }}>
              <OrderBoard
                mode="preview"
                display={preview.display}
                venueName={venueName}
                rows={preview.rows}
                nowMs={now}
                tz={tz || 'Europe/London'}
                lastUpdatedMs={now}
                offline={false}
                justReady={EMPTY_SET}
              />
            </div>
          </Box>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ index, count, sec, labels, namesEnabled, onChange, onMove, onRemove }) {
  const channels = Array.isArray(sec.channels) ? sec.channels : [];
  const orderTypes = Array.isArray(sec.orderTypes) ? sec.orderTypes : [];
  const statuses = Array.isArray(sec.statuses) ? sec.statuses : [];
  const nameFormat = sec.nameFormat || 'short';
  const group = (g) => CHANNELS.filter(c => c.group === g);
  const radioName = `name-${sec.id || index}`;

  return (
    <div style={S.sectionCard}>
      <div style={S.sectionHead}>Section {index + 1}</div>
      <Field label="Title">
        <input style={S.inp} maxLength={40} value={sec.title || ''} onChange={e => onChange({ title: e.target.value })} />
      </Field>
      <Field label="Second line">
        <input style={S.inp} maxLength={60} value={sec.subtitle || ''} onChange={e => onChange({ subtitle: e.target.value })} />
      </Field>

      <Field label="Orders from">
        <div style={S.subHead}>Your venue</div>
        <div style={S.checkWrap}>
          {group('venue').map(c => (
            <Check key={c.key} checked={channels.includes(c.key)} label={c.label}
              onChange={() => onChange({ channels: toggleIn(channels, c.key) })} />
          ))}
        </div>
        <div style={S.subHead}>Delivery apps</div>
        <div style={S.checkWrap}>
          {group('apps').map(c => (
            <Check key={c.key} checked={channels.includes(c.key)} label={c.label}
              onChange={() => onChange({ channels: toggleIn(channels, c.key) })} />
          ))}
        </div>
      </Field>

      <Field label="Order types">
        <div style={S.checkWrap}>
          {ORDER_TYPES.map(t => (
            <Check key={t.key} checked={orderTypes.includes(t.key)} label={t.label}
              onChange={() => onChange({ orderTypes: toggleIn(orderTypes, t.key) })} />
          ))}
        </div>
      </Field>

      <Field label="Show these steps">
        <div style={S.checkWrap}>
          {STEPS.map(k => (
            <Check key={k} checked={statuses.includes(k)} label={(labels[k] || '').trim() || DEFAULT_LABELS[k]}
              onChange={() => onChange({ statuses: toggleIn(statuses, k) })} />
          ))}
        </div>
      </Field>

      <Field label="Name on screen">
        <div style={S.checkWrap}>
          {NAME_OPTIONS.map(([v, label]) => (
            <Radio key={v} name={radioName} checked={nameFormat === v} onChange={() => onChange({ nameFormat: v })} label={label} />
          ))}
        </div>
        {namesEnabled === false && nameFormat !== 'number' && (
          <p style={S.helpP}>The TV shows order numbers only until the security update to your orders, unless you tick Show customer names now above.</p>
        )}
        {nameFormat === 'full' && (
          <div style={S.warn} role="note">Anyone nearby can read full names. Check your privacy notice says names show on a screen.</div>
        )}
      </Field>

      <Check checked={sec.showChannel !== false} onChange={v => onChange({ showChannel: v })} label="Show where the order came from" />

      <div style={S.row}>
        <button type="button" style={S.btn} onClick={() => onMove(-1)} disabled={index === 0}>Move up</button>
        <button type="button" style={S.btn} onClick={() => onMove(1)} disabled={index === count - 1}>Move down</button>
        <button type="button" style={S.btnGhost} onClick={onRemove}>Remove section</button>
      </div>
    </div>
  );
}

// ── Little UI helpers ────────────────────────────────────────────────────────────────

const Head = ({ title }) => (
  <div style={{ marginBottom: 6 }}>
    <div style={S.eyebrow}>Channels</div>
    <h1 style={S.h1}>{title}</h1>
  </div>
);

const Box = ({ title, help = [], children }) => (
  <section style={S.box}>
    {title && <h2 style={S.h2}>{title}</h2>}
    {help.map(h => <p key={h} style={S.helpP}>{h}</p>)}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: title || help.length ? 12 : 0 }}>{children}</div>
  </section>
);

const Field = ({ label, help, children }) => (
  <div>
    <div style={S.lbl}>{label}</div>
    {help && <div style={{ ...S.help, marginTop: 2 }}>{help}</div>}
    <div style={{ marginTop: 6 }}>{children}</div>
  </div>
);

const Check = ({ checked, onChange, label, disabled }) => (
  <label style={{ ...S.check, opacity: disabled ? 0.6 : 1 }}>
    <input type="checkbox" checked={!!checked} disabled={disabled} onChange={e => onChange(e.target.checked)} style={S.checkbox} />
    <span>{label}</span>
  </label>
);

const Radio = ({ name, checked, onChange, label }) => (
  <label style={S.check}>
    <input type="radio" name={name} checked={!!checked} onChange={onChange} style={S.checkbox} />
    <span>{label}</span>
  </label>
);

const S = {
  page: { maxWidth: 1180, display: 'flex', flexDirection: 'column', gap: 18 },
  empty: { textAlign: 'center', padding: '50px 20px', color: 'var(--t3)', fontSize: 15 },
  absent: { padding: '24px 4px', color: 'var(--t2)', fontSize: 16, lineHeight: 1.5 },
  eyebrow: { fontSize: 15, color: 'var(--t3)', fontWeight: 700 },
  h1: { fontSize: 26, fontWeight: 800, color: 'var(--t1)', margin: '2px 0 0' },
  h2: { fontSize: 20, fontWeight: 800, color: 'var(--t1)', margin: 0 },
  helpP: { fontSize: 15, color: 'var(--t3)', margin: '6px 0 0', lineHeight: 1.5, maxWidth: 760 },
  help: { fontSize: 15, color: 'var(--t3)', lineHeight: 1.5 },
  errBar: { background: 'var(--red-d)', border: '1px solid var(--red-b)', color: 'var(--red)', borderRadius: 8, padding: '10px 14px', fontSize: 15 },
  box: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18 },
  cards: { display: 'flex', flexWrap: 'wrap', gap: 12 },
  card: { width: 260, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: 800, color: 'var(--t1)' },
  meta: { fontSize: 15, color: 'var(--t3)' },
  row: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 4 },
  tvRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 12px', border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--bg2)' },
  dot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  lbl: { fontSize: 15, fontWeight: 700, color: 'var(--t2)' },
  subHead: { fontSize: 15, fontWeight: 600, color: 'var(--t3)', margin: '6px 0 4px' },
  inp: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--bdr2)', borderRadius: 8, padding: '9px 11px', fontSize: 15, fontFamily: 'inherit', color: 'var(--t1)', background: 'var(--bg2)', outline: 'none' },
  swatch: { width: 40, height: 36, border: '1px solid var(--bdr)', borderRadius: 8, background: 'none', cursor: 'pointer', padding: 2 },
  colourGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 },
  check: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, color: 'var(--t1)', cursor: 'pointer', minHeight: 32 },
  checkWrap: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px' },
  checkbox: { width: 18, height: 18, accentColor: 'var(--acc)', cursor: 'pointer', margin: 0 },
  sectionCard: { border: '1px solid var(--bdr)', borderRadius: 12, padding: 14, background: 'var(--bg2)', display: 'flex', flexDirection: 'column', gap: 12 },
  sectionHead: { fontSize: 17, fontWeight: 800, color: 'var(--t1)' },
  warn: { marginTop: 8, fontSize: 15, color: 'var(--t1)', background: 'var(--acc-d)', border: '1px solid var(--acc-b)', borderRadius: 8, padding: '8px 12px', lineHeight: 1.5 },
  editorGrid: { display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' },
  formCol: { flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 },
  previewCol: { flex: '1 1 380px', minWidth: 0, maxWidth: 680, position: 'sticky', top: 12 },
  saveBar: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 10 },
  msgList: { margin: 0, paddingLeft: 20, color: 'var(--red)', fontSize: 15, lineHeight: 1.6 },
  btn: { padding: '9px 16px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnGhost: { padding: '9px 16px', borderRadius: 8, border: 'none', background: 'transparent', color: 'var(--t3)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  btnPrimary: { padding: '10px 18px', borderRadius: 8, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  back: { alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--t3)', fontSize: 15, cursor: 'pointer', fontFamily: 'inherit', padding: 0 },
};
