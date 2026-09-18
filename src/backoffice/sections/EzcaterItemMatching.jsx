// src/backoffice/sections/EzcaterItemMatching.jsx
//
// Back Office, Channels, 3rd Party orders, "Item matching" (ezCater).
//
// WHY THIS SCREEN EXISTS
// ezCater gave us the Orders API but NOT the Menus API, so the venue builds its
// ezCater menu by hand in the Partner Portal and their order lines arrive with
// posItemId = null. itemId is what KDS station routing, 86, stock depletion and
// product reporting all key on, so an unmatched ezCater order is a plain text
// ticket: no station, no stock, no product mix. This is where a person says,
// once, which of our products each of their names is.
//
// The rules are in src/lib/ezcaterMatch.js. The view model, every derived
// state, the ordering and all the copy are in src/lib/ezcaterItemRows.js, which
// is tested. This file is the shell: fetch, render, save.
//
// BEFORE THE MIGRATION IS APPLIED it shows one plain line and nothing else. The
// three ways to be in that state (no table, function not deployed, function
// answered enabled:false) are one check, isMatchingOff().

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getActiveLocationSync, isMock, supabase } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { ezcaterItemsList, ezcaterItemsSave, ezcaterItemsPaste } from '../../lib/ezcater';
import {
  rowsFrom, ofKind, countRows, outstandingLine, seenLine,
  ourItemsFrom, ourGroupsFrom, suggestionsFor, searchOurItems,
  matchedLabel, saveBody, applySaved, isMatchingOff,
} from '../../lib/ezcaterItemRows';
// v5.8.100: hand the venue's item codes over, so ezCater can put them on their
// side and this screen stops having anything to ask about.
import { itemCodeRows } from '../../lib/itemCode';
// 18 Sep 2026: load their whole menu before any order, and hand ours over.
import {
  parseEzcaterMenu, parsedCounts, pasteEntries, pasteBody, previewPaste, previewLine,
  PASTE_MAX_ENTRIES,
} from '../../lib/ezcaterMenuPaste';
import { ourMenuText, ourMenuRows } from '../../lib/ezcaterMenuExport';

// Same vocabulary as HubRise.jsx, the section this sits inside. No new tokens.
const S = {
  card: { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 },
  h2: { fontSize: 14, fontWeight: 800, color: 'var(--t1)', margin: '0 0 10px' },
  input: { width: '100%', padding: '9px 11px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit' },
  btn: { padding: '9px 16px', borderRadius: 9, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  btnGhost: { padding: '7px 13px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'transparent', color: 'var(--t1)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnPick: { padding: '7px 12px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t1)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' },
  row: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
  note: (kind) => ({ fontSize: 12.5, padding: '9px 12px', borderRadius: 9, marginTop: 4, background: kind === 'err' ? '#ef444418' : '#22c55e18', color: kind === 'err' ? '#ef4444' : '#16a34a' }),
  tab: (on) => ({ padding: '7px 14px', borderRadius: 9, border: '1px solid ' + (on ? 'transparent' : 'var(--bdr2)'), background: on ? 'var(--acc)' : 'transparent', color: on ? '#0b0c10' : 'var(--t3)', fontSize: 12.5, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }),
  item: { padding: '12px 0', borderBottom: '1px solid var(--bdr)' },
  theirName: { fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' },
  meta: { fontSize: 11.5, color: 'var(--t4)', marginTop: 2 },
  why: { fontSize: 11, color: 'var(--t4)', fontWeight: 500 },
  count: { fontSize: 13, fontWeight: 700, color: 'var(--t1)', margin: '12px 0 4px' },
  off: { fontSize: 13, color: 'var(--t3)', lineHeight: 1.5 },
};

const MAX_SHOWN = 50;
const PREVIEW_SHOWN = 150;

const STATUS_WORDS = {
  matched: { text: 'Matched', color: '#16a34a' },
  decide: { text: 'Needs a decision', color: '#d97706' },
  none: { text: 'Not on our menu', color: 'var(--t3)' },
  ignored: { text: 'You said not on our menu', color: 'var(--t4)' },
};

/** Copy text, with the old way as a fallback for a locked down WebView. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const box = document.createElement('textarea');
      box.value = text;
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(box);
      return ok;
    } catch { return false; }
  }
}

/**
 * "Load your ezCater menu": paste (or pick a CSV), see what was understood and
 * what would match, then save. Nothing is written until Save is pressed, and a
 * save never overwrites a row that is already on the list.
 */
function PasteMenu({ locId, rows, ourItems, ourGroups, onSaved, onOff }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const entries = useMemo(() => (parsed ? pasteEntries(parsed) : []), [parsed]);
  const found = useMemo(() => (parsed ? parsedCounts(parsed) : null), [parsed]);
  const preview = useMemo(
    () => (parsed ? previewPaste(entries, ourItems, ourGroups, rows) : null),
    [parsed, entries, ourItems, ourGroups, rows],
  );

  const read = () => { setNote(null); setParsed(parseEzcaterMenu(text)); };
  const reset = () => { setText(''); setParsed(null); setNote(null); };

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      setNote({ kind: 'err', text: 'We cannot read a PDF here. Open it, select all the text, copy it, and paste it in the box.' });
      return;
    }
    const r = new FileReader();
    r.onload = () => { const t = String(r.result || ''); setText(t); setNote(null); setParsed(parseEzcaterMenu(t)); };
    r.onerror = () => setNote({ kind: 'err', text: 'We could not open that file.' });
    r.readAsText(f);
  };

  const save = async () => {
    if (!entries.length) return;
    setBusy(true); setNote(null);
    try {
      const res = await ezcaterItemsPaste(locId, pasteBody(entries));
      if (res && res.enabled === false) { onOff(); return; }
      const c = (res && res.counts) || {};
      const added = Number(c.fresh) || 0;
      const again = Number(c.already) || 0;
      let msg = added === 1 ? '1 name added to your list.' : added + ' names added to your list.';
      if (again) msg += ' ' + again + ' were already there and were left as they were.';
      if (res && res.menu_ok === false) msg += ' We could not read all of your menu just now, so nothing was matched automatically. Open this page again later to match them.';
      setNote({ kind: 'ok', text: msg });
      setParsed(null); setText('');
      await onSaved();
    } catch (e) {
      if (isMatchingOff(e)) onOff();
      else setNote({ kind: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <div style={S.row}>
        <button style={S.btn} onClick={() => setOpen(true)}>Load your ezCater menu</button>
        <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>Match every item now, before anyone orders it.</span>
      </div>
    );
  }

  return (
    <div>
      <div style={S.h2}>Load your ezCater menu</div>
      <ol style={{ ...S.sub, margin: '0 0 10px', paddingLeft: 18 }}>
        <li>Sign in to ezManage and open Menus. Open your menu as customers see it on ezCater.</li>
        <li>Select everything on the page (Cmd A or Ctrl A) and copy it.</li>
        <li>Paste it below and press Read. Open an item with sizes or choices first if they only show when you click it.</li>
      </ol>
      <div style={{ ...S.sub, marginTop: 0, marginBottom: 8 }}>
        A spreadsheet or CSV works too, with a column called Item or Name (and Size, Price, Option group, Option name if you have them).
      </div>
      <textarea
        style={{ ...S.input, minHeight: 140, resize: 'vertical' }}
        value={text}
        aria-label="Your ezCater menu, pasted"
        placeholder="Paste your ezCater menu here"
        onChange={(e) => { setText(e.target.value); setParsed(null); }}
      />
      <div style={{ ...S.row, marginTop: 8 }}>
        <button style={S.btn} disabled={!text.trim() || busy} onClick={read}>Read</button>
        <label style={{ ...S.btnGhost, display: 'inline-block' }}>
          Choose a file
          <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain,application/pdf" style={{ display: 'none' }} onChange={onFile} />
        </label>
        <button style={S.btnGhost} disabled={busy} onClick={() => { reset(); setOpen(false); }}>Close</button>
      </div>

      {note && <div style={S.note(note.kind)}>{note.text}</div>}

      {parsed && found && preview && (
        <div style={{ marginTop: 12 }}>
          {parsed.warnings.map((w) => <div key={w} style={S.note('err')}>{w}</div>)}
          <div style={S.count}>
            We found {found.items} {found.items === 1 ? 'item' : 'items'}, {found.sizes} {found.sizes === 1 ? 'size' : 'sizes'} and {found.options} {found.options === 1 ? 'option' : 'options'}.
          </div>
          <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 8 }}>{previewLine(preview.counts)}</div>
          {entries.length >= PASTE_MAX_ENTRIES && (
            <div style={S.note('err')}>Only the first {PASTE_MAX_ENTRIES} names are saved. Paste the rest separately.</div>
          )}
          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--bdr)', borderRadius: 9, padding: '0 10px' }}>
            {preview.rows.slice(0, PREVIEW_SHOWN).map((r) => {
              const st = STATUS_WORDS[r.status] || STATUS_WORDS.none;
              return (
                <div key={r.kind + ':' + r.ezKey} style={{ ...S.row, justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ minWidth: 160, flex: '1 1 200px' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{r.ezName}</div>
                    <div style={S.meta}>{r.kind === 'option' ? 'Option' + (r.ezGroup ? ' · ' + r.ezGroup : '') : 'Item'}{r.already ? ' · already on your list' : ''}</div>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: st.color, textAlign: 'right' }}>
                    {st.text}{r.target ? ': ' + r.target : ''}
                  </div>
                </div>
              );
            })}
          </div>
          {preview.rows.length > PREVIEW_SHOWN && (
            <div style={{ ...S.sub, marginTop: 6 }}>And {preview.rows.length - PREVIEW_SHOWN} more.</div>
          )}
          <div style={{ ...S.sub, marginTop: 8 }}>
            If something was read wrongly, fix the text above and press Read again. Saving adds names to your list. It never changes a match you already made.
          </div>
          <div style={{ ...S.row, marginTop: 10 }}>
            <button style={S.btn} disabled={busy || !entries.length} onClick={save}>
              {busy ? 'Saving…' : 'Save ' + entries.length + (entries.length === 1 ? ' name' : ' names') + ' to the list'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One of their names, and what it is. */
function MatchRow({ row, ourItems, ourGroups, suggestions, busy, onSave }) {
  const [query, setQuery] = useState('');
  // "Change" opens the picker over a row that is ALREADY matched. It must not
  // clear the match first: a mis-click would leave that item routing nowhere
  // until somebody noticed and picked again. One press, one write.
  const [changing, setChanging] = useState(false);
  const rowKey = row.kind + ':' + row.ezKey;

  const results = useMemo(
    () => (query.trim() ? searchOurItems(query, ourItems, ourGroups, row.kind) : null),
    [query, ourItems, ourGroups, row.kind],
  );

  const picking = row.state === 'unmatched' || changing;
  const choices = results !== null ? results : suggestions;
  const label = matchedLabel(row, ourItems, ourGroups);

  const send = (choice) => { setChanging(false); setQuery(''); onSave(row, choice); };
  const pick = (c) => send(row.kind === 'option'
    ? { optionId: c.optionId, menuItemId: c.menuItemId }
    : { menuItemId: c.menuItemId });

  return (
    <div style={S.item}>
      <div style={{ ...S.row, justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 180, flex: '1 1 200px' }}>
          <div style={S.theirName}>{row.ezName}</div>
          <div style={S.meta}>
            {row.ezGroup ? row.ezGroup + ' · ' : ''}{seenLine(row)}
          </div>
        </div>

        {row.state === 'matched' && (
          <div style={{ ...S.row, justifyContent: 'flex-end', flex: '1 1 200px' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{label}</span>
            <button style={S.btnGhost} disabled={!!busy}
              onClick={() => setChanging((v) => !v)}>{changing ? 'Cancel' : 'Change'}</button>
          </div>
        )}

        {row.state === 'ignored' && (
          <div style={{ ...S.row, justifyContent: 'flex-end', flex: '1 1 200px' }}>
            <span style={{ fontSize: 13, color: 'var(--t3)' }}>Not on our menu</span>
            <button style={S.btnGhost} disabled={!!busy}
              onClick={() => send({})}>Undo</button>
          </div>
        )}
      </div>

      {picking && (
        <div style={{ marginTop: 10 }}>
          {choices.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420 }}>
              {choices.map((c) => (
                <button key={c.id} style={S.btnPick} disabled={!!busy} onClick={() => pick(c)}>
                  {c.name}
                  {/* Only when we HAVE one. No price is quieter than a false 0.00. */}
                  {typeof c.price === 'number' ? <span style={S.why}>{'  · ' + money(c.price)}</span> : null}
                  {c.note ? <span style={S.why}>{'  · ' + c.note}</span> : null}
                  {c.why ? <span style={S.why}>{'  · ' + c.why}</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>
              {query.trim() ? 'Nothing on our menu matches that.' : 'Nothing on our menu looks like this. Search for it below.'}
            </div>
          )}

          <div style={{ ...S.row, marginTop: 8 }}>
            <input
              style={{ ...S.input, maxWidth: 260 }}
              value={query}
              placeholder={row.kind === 'option' ? 'Search our options' : 'Search our menu'}
              aria-label={'Search our menu for ' + row.ezName}
              onChange={(e) => setQuery(e.target.value)}
            />
            {row.state !== 'ignored' && (
              <button style={S.btnGhost} disabled={!!busy}
                onClick={() => send({ ignored: true })}>Not on our menu</button>
            )}
          </div>
        </div>
      )}

      {busy === rowKey && <div style={{ ...S.meta, marginTop: 6 }}>Saving…</div>}
    </div>
  );
}

export default function EzcaterItemMatching({ locationId }) {
  const [locId, setLocId] = useState(locationId || null);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [rows, setRows] = useState([]);
  const [rawItems, setRawItems] = useState([]);
  const [rawGroups, setRawGroups] = useState([]);
  const [tab, setTab] = useState('item');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [rawCats, setRawCats] = useState([]);
  const [codesOn, setCodesOn] = useState(false);
  const [copied, setCopied] = useState(false);

  const ourItems = useMemo(() => ourItemsFrom(rawItems), [rawItems]);
  const ourGroups = useMemo(() => ourGroupsFrom(rawGroups), [rawGroups]);
  // Straight off the table rows, not ourItems: the codes live on the raw rows.
  const codeRows = useMemo(() => (codesOn ? itemCodeRows(rawItems) : []), [codesOn, rawItems]);
  const menuRowCount = useMemo(() => ourMenuRows(rawItems, rawCats).length, [rawItems, rawCats]);

  // "Copy our menu for ezCater": our names, sizes, prices and item codes, for
  // the caterer or ezCater's menu team, so their names match ours from day one.
  const copyMenu = useCallback(async () => {
    const text = ourMenuText(rawItems, rawCats, rawGroups);
    if (!text) return;
    const ok = await copyText(text);
    // A failed copy must say so rather than look done.
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
    else setMsg({ kind: 'err', text: 'We could not copy that from this browser. Try Chrome or Safari on a computer.' });
  }, [rawItems, rawCats, rawGroups]);

  // quiet: reload behind the screen (after a paste) without swapping it for
  // Loading, which would unmount the paste panel and lose its result line.
  const load = useCallback(async (id, quiet) => {
    if (!id) { setLoading(false); return; }
    // Local dev has no Supabase at all (supabase is null when isMock). That is
    // the same answer as "not switched on yet", not a red error to stare at.
    if (isMock || !supabase) { setEnabled(false); setLoading(false); return; }
    if (!quiet) setLoading(true);
    setMsg(null);
    try {
      // Our own menu is readable straight from the browser (the same select
      // HubRise's ref export uses). Only the link rows have to come through the
      // edge function, because that table is service role only.
      // menu_items has NO price column: the price is in the `pricing` jsonb,
      // the same shape MenuManager and lib/menuPricing.js read. Selecting a
      // column that does not exist fails the WHOLE select, which is how this
      // picker shipped empty with every matched row reading "Deleted from our
      // menu". ourItemsFrom turns pricing into the number the matcher wants.
      //
      // 18 Sep 2026: '*' rather than a column list. The sizes (parent_id), the
      // category, type and sort order are needed now as well, and '*' can never
      // fail on a column that has not been added yet (item_code's migration is
      // run by hand, which is why this used to ask twice). Whether codes are
      // there is read off the rows instead.
      // PostgREST caps a select at 1000 rows; a venue past that sees the first
      // 1000 here, and the webhook, which pages, still matches the rest.
      const [links, itemsRes, groupsRes, catsRes] = await Promise.all([
        ezcaterItemsList(id),
        supabase.from('menu_items').select('*').eq('location_id', id),
        supabase.from('modifier_groups').select('id,name,options').eq('location_id', id),
        supabase.from('menu_categories').select('*').eq('location_id', id),
      ]);
      const itemRows = itemsRes?.data || [];
      setCodesOn(itemRows.some((r) => r && Object.prototype.hasOwnProperty.call(r, 'item_code')));
      if (links && links.enabled === false) { setEnabled(false); setRows([]); }
      else { setEnabled(true); setRows(rowsFrom(links?.links)); }
      setRawItems(itemRows);
      setRawGroups(groupsRes?.data || []);
      setRawCats(catsRes?.data || []);
      // An empty picker must never look like an empty menu. Say it out loud
      // instead, because the silent version of this cost the whole screen.
      if (itemsRes?.error || groupsRes?.error) {
        setMsg({ kind: 'err', text: 'We could not read your menu, so there is nothing to pick from. Try again in a moment.' });
      }
    } catch (e) {
      // Not switched on yet is not an error. Anything else is, and must say so:
      // a venue staring at "not switched on yet" while their orders quietly
      // failed to route would be the worst outcome here.
      if (isMatchingOff(e)) setEnabled(false);
      else setMsg({ kind: 'err', text: e.message });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = locationId || await getActiveLocationSync();
      if (cancelled) return;
      setLocId(id);
      await load(id);
    })();
    return () => { cancelled = true; };
  }, [locationId, load]);

  const save = useCallback(async (row, choice) => {
    const built = saveBody(row, choice);
    if (built.error) { setMsg({ kind: 'err', text: built.error }); return; }
    const rowKey = row.kind + ':' + row.ezKey;
    setBusy(rowKey); setMsg(null);
    try {
      const r = await ezcaterItemsSave(locId, built.body);
      if (r && r.enabled === false) { setEnabled(false); return; }
      setRows((cur) => applySaved(cur, built.body));
    } catch (e) {
      if (isMatchingOff(e)) setEnabled(false);
      else setMsg({ kind: 'err', text: e.message });
    } finally { setBusy(''); }
  }, [locId]);

  const shown = useMemo(() => ofKind(rows, tab), [rows, tab]);
  const counts = useMemo(() => countRows(shown), [shown]);
  const itemCount = useMemo(() => countRows(ofKind(rows, 'item')), [rows]);
  const optCount = useMemo(() => countRows(ofKind(rows, 'option')), [rows]);

  // One suggestion list per visible row, built once per menu change rather than
  // on every keystroke in any row's search box. Matched rows are included too,
  // because "Change" opens the same picker over a row that already has an
  // answer, and it must not have to wait for the list to be built.
  const suggestions = useMemo(() => {
    const map = new Map();
    for (const r of shown.slice(0, MAX_SHOWN)) {
      map.set(r.kind + ':' + r.ezKey, suggestionsFor(r, ourItems, ourGroups, { limit: 4 }));
    }
    return map;
  }, [shown, ourItems, ourGroups]);

  if (!locId) return null;

  return (
    <div style={S.card}>
      <div style={S.h2}>Item matching</div>
      <div style={{ ...S.sub, marginTop: 0 }}>
        ezCater does not send us their menu, so tell us once what each of their items is.
        Load their whole menu below and most of it matches straight away, before anyone orders.
      </div>

      {/* B4, said plainly: matching never stands between an order and the kitchen. */}
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--t2)', background: 'var(--bg3)', border: '1px solid var(--bdr)', borderRadius: 9, padding: '10px 12px', marginTop: 10 }}>
        <strong>An unmatched item never blocks or delays an order.</strong> It still arrives and prints by its ezCater name.
        Matching is what sends it to the right kitchen screen, takes it off stock and counts it in your product reports.
      </div>

      {loading ? (
        <div style={{ ...S.off, marginTop: 14 }}>Loading…</div>
      ) : !enabled ? (
        <div style={{ ...S.off, marginTop: 14 }}>Item matching is not switched on yet.</div>
      ) : (
        <>
          {msg && <div style={S.note(msg.kind)}>{msg.text}</div>}

          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
            <PasteMenu
              locId={locId}
              rows={rows}
              ourItems={ourItems}
              ourGroups={ourGroups}
              onSaved={() => load(locId, true)}
              onOff={() => setEnabled(false)}
            />
          </div>

          {/* The other direction: our names, sizes and prices for the caterer
              or ezCater's menu team, so their menu matches ours from day one.
              Carries the item codes too (v5.8.100) where products have them. */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
            <div style={S.row}>
              <button
                style={{ ...S.btnGhost, ...(menuRowCount ? {} : { opacity: 0.5, cursor: 'default' }) }}
                disabled={!menuRowCount}
                onClick={copyMenu}>
                {copied ? 'Copied' : 'Copy our menu for ezCater'}
              </button>
              <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>
                {menuRowCount === 1 ? '1 item and size' : menuRowCount + ' items and sizes'}
                {codesOn && codeRows.length ? ', ' + codeRows.length + ' with an item code' : ''}
              </span>
            </div>
            <div style={{ ...S.sub, marginTop: 6 }}>
              Our item names, sizes and prices, and our options, ready to paste into an email or a spreadsheet.
              Send it to ezCater's menu team (menus@ezcater.com) when your menu is set up or changed, and ask them to use these names.
              {codesOn && codeRows.length ? ' Ask them to put the item code on each item as its POS id too.' : ''}
            </div>
          </div>

          <div style={{ ...S.row, marginTop: 14 }}>
            <button style={S.tab(tab === 'item')} onClick={() => setTab('item')}>
              Items{itemCount.outstanding ? ' (' + itemCount.outstanding + ')' : ''}
            </button>
            <button style={S.tab(tab === 'option')} onClick={() => setTab('option')}>
              Options{optCount.outstanding ? ' (' + optCount.outstanding + ')' : ''}
            </button>
          </div>

          <div style={S.count}>{outstandingLine(counts, tab)}</div>

          {shown.slice(0, MAX_SHOWN).map((r) => (
            <MatchRow
              key={r.kind + ':' + r.ezKey}
              row={r}
              ourItems={ourItems}
              ourGroups={ourGroups}
              suggestions={suggestions.get(r.kind + ':' + r.ezKey) || []}
              busy={busy}
              onSave={save}
            />
          ))}

          {shown.length > MAX_SHOWN && (
            <div style={{ ...S.sub, marginTop: 10 }}>
              Showing the first {MAX_SHOWN} of {shown.length}. Match these and the rest move up.
            </div>
          )}
        </>
      )}
    </div>
  );
}
