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
import { ezcaterItemsList, ezcaterItemsSave } from '../../lib/ezcater';
import {
  rowsFrom, ofKind, countRows, outstandingLine, seenLine,
  ourItemsFrom, ourGroupsFrom, suggestionsFor, searchOurItems,
  matchedLabel, saveBody, applySaved, isMatchingOff,
} from '../../lib/ezcaterItemRows';
// v5.8.100: hand the venue's item codes over, so ezCater can put them on their
// side and this screen stops having anything to ask about.
import { itemCodeRows, itemCodesText, isMissingItemCodeColumn } from '../../lib/itemCode';

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
  const [codesOn, setCodesOn] = useState(false);
  const [copied, setCopied] = useState(false);

  const ourItems = useMemo(() => ourItemsFrom(rawItems), [rawItems]);
  const ourGroups = useMemo(() => ourGroupsFrom(rawGroups), [rawGroups]);
  // Straight off the table rows, not ourItems: the codes live on the raw rows.
  const codeRows = useMemo(() => (codesOn ? itemCodeRows(rawItems) : []), [codesOn, rawItems]);

  const copyCodes = useCallback(async () => {
    const text = itemCodesText(rawItems);
    if (!text) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // A locked down browser or WebView refuses the clipboard API. The old way
      // still works there, and a failed copy must say so rather than look done.
      try {
        const box = document.createElement('textarea');
        box.value = text;
        box.style.position = 'fixed';
        box.style.opacity = '0';
        document.body.appendChild(box);
        box.select();
        ok = document.execCommand('copy');
        document.body.removeChild(box);
      } catch { ok = false; }
    }
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
    else setMsg({ kind: 'err', text: 'We could not copy that. Select the codes in the item editor instead.' });
  }, [rawItems]);

  const load = useCallback(async (id) => {
    if (!id) { setLoading(false); return; }
    // Local dev has no Supabase at all (supabase is null when isMock). That is
    // the same answer as "not switched on yet", not a red error to stare at.
    if (isMock || !supabase) { setEnabled(false); setLoading(false); return; }
    setLoading(true);
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
      // item_code may not exist yet (its migration is run by hand), and a select
      // naming a column that does not exist fails the WHOLE select. So it is
      // asked for, and asked for again without it if that is why it failed.
      const readItems = (columns) => supabase.from('menu_items').select(columns).eq('location_id', id);
      const [links, firstItems, groupsRes] = await Promise.all([
        ezcaterItemsList(id),
        readItems('id,name,menu_name,pricing,archived,item_code'),
        supabase.from('modifier_groups').select('id,name,options').eq('location_id', id),
      ]);
      let itemsRes = firstItems;
      let haveCodes = !firstItems?.error;
      if (firstItems?.error && isMissingItemCodeColumn(firstItems.error)) {
        haveCodes = false;
        itemsRes = await readItems('id,name,menu_name,pricing,archived');
      }
      setCodesOn(haveCodes);
      if (links && links.enabled === false) { setEnabled(false); setRows([]); }
      else { setEnabled(true); setRows(rowsFrom(links?.links)); }
      setRawItems(itemsRes?.data || []);
      setRawGroups(groupsRes?.data || []);
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
        Matched items go to the right station, take the right stock and show up in your reports.
        Unmatched ones still print, as plain text.
      </div>

      {loading ? (
        <div style={{ ...S.off, marginTop: 14 }}>Loading…</div>
      ) : !enabled ? (
        <div style={{ ...S.off, marginTop: 14 }}>Item matching is not switched on yet.</div>
      ) : (
        <>
          {msg && <div style={S.note(msg.kind)}>{msg.text}</div>}

          {/* v5.8.100: hand the codes over. Nothing here is required: an item
              with no code still arrives, it just has to be matched by name. */}
          {codesOn && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
              <div style={S.row}>
                <button
                  style={{ ...S.btnGhost, ...(codeRows.length ? {} : { opacity: 0.5, cursor: 'default' }) }}
                  disabled={!codeRows.length}
                  onClick={copyCodes}>
                  {copied ? 'Copied' : 'Copy item codes'}
                </button>
                <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>
                  {codeRows.length === 1 ? '1 product has a code' : codeRows.length + ' products have a code'}
                </span>
              </div>
              <div style={{ ...S.sub, marginTop: 6 }}>
                {codeRows.length
                  ? 'Send this list to ezCater and ask them to put each code on that item as its POS id. Their orders then name the product for us and there is nothing left to match by hand.'
                  : 'Give a product a code first: Menu, open the item, Item code. Then send the list to ezCater to put on their side.'}
              </div>
            </div>
          )}

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
