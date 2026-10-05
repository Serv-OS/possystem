// src/admin/sections/AdminVenueMessages.jsx
//
// Company Admin, Messages to venues (ServOS staff only).
//
// WHY (Peter, 5 Oct 2026): "another feature: we need to be able to send a notification, like a
// message, to all customers or certain customers asking them to do things, like a POP UP from
// the admin: send a message, in this case saying 'Hi, I have just made an update, you need to do
// XYZ'." ("Customers" are ServOS's customers: the venues.) His calls: it pops up in Back Office
// AND on tills, it stays until someone taps Got it, admin sees WHO did and when (one
// confirmation clears it for that venue), and he sends to chosen companies or venues from a tick
// list with search and Select all.
//
// This screen only asks. The venue-messages-admin edge function decides who may send (ServOS
// staff with the second sign in step done), checks the message again and writes the rows; the
// database lets a venue read only its own (20261005a_OPS_venue_messages.sql).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import VenueMessageCard from '../../components/VenueMessageCard';
import {
  MESSAGE_MAX, TITLE_MAX, KIND_LABEL, cleanDraft, expandRecipients, rollupBroadcasts, countsLine, sendQuestion,
  groupVenues, venueStatusLine, formatVenueTime, sendResultLine, NEEDS_UPDATE_LINE,
} from '../../lib/venueMessageRules';

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const REFRESH_MS = 30 * 1000;

async function callVenueMessages(action, payload = {}) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('Sign in again, then try once more.');
  let res;
  try {
    res = await fetch(`${FUNCTIONS_URL}/venue-messages-admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch {
    // Also what an undeployed function looks like from a browser (its 404 carries no CORS header).
    throw new Error('Could not reach the messages service. Check the connection. If this is the first use, the venue-messages-admin function has to be deployed first.');
  }
  const j = await res.json().catch(() => ({}));
  // The function is not deployed yet (404 from the gateway), or the table is not there (409).
  if (res.status === 404 || j.code === 'not_ready') { const e = new Error(NEEDS_UPDATE_LINE); e.notReady = true; throw e; }
  if (!res.ok || j.error) { const e = new Error(j.message || j.error || `HTTP ${res.status}`); e.code = j.code; throw e; }
  return j;
}

const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null);

const S = {
  h1: { fontSize: 22, fontWeight: 800, color: 'var(--t1)', marginBottom: 4, letterSpacing: '-.01em' },
  sub: { fontSize: 14, color: 'var(--t3)', marginBottom: 20, maxWidth: 760, lineHeight: 1.5 },
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: 'var(--sh)' },
  h2: { fontSize: 16, fontWeight: 800, color: 'var(--t1)', marginBottom: 12 },
  label: { fontSize: 13, fontWeight: 700, color: 'var(--t2)', marginBottom: 6, display: 'block' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  btn: { padding: '10px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, fontFamily: 'inherit' },
  primary: { background: 'var(--acc)', color: '#0b0c10' },
  ghost: { background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr2)' },
  danger: { background: 'transparent', color: 'var(--red)', border: '1px solid var(--red-b)' },
  error: { padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 14, border: '1px solid var(--red-b)' },
  note: { padding: 12, background: 'var(--acc-d)', color: 'var(--t1)', borderRadius: 8, marginBottom: 14, fontSize: 14, border: '1px solid var(--acc-b)' },
  pill: (tone) => ({
    display: 'inline-block', padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
    background: tone === 'red' ? 'var(--red-d)' : tone === 'acc' ? 'var(--acc-d)' : 'var(--bg3)',
    color: tone === 'red' ? 'var(--red)' : tone === 'acc' ? 'var(--acc)' : 'var(--t2)',
    border: `1px solid ${tone === 'red' ? 'var(--red-b)' : tone === 'acc' ? 'var(--acc-b)' : 'var(--bdr)'}`,
  }),
};

export default function AdminVenueMessages() {
  const [venues, setVenues] = useState([]);
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [notReady, setNotReady] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState('info');
  const [ticked, setTicked] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null);          // the Sent message whose venues are showing
  // One id per draft: a retry after a lost reply can never send the same message twice. One id
  // is one text: the server refuses the id (already_sent) if the words changed in between.
  const draftId = useRef(newId());

  const load = useCallback(async ({ quiet = false } = {}) => {
    try {
      const res = await callVenueMessages('list');
      setVenues(res.venues || []);
      setRows(res.rows || []);
      setNotReady(res.ready === false);
      if (!quiet) setErr('');
    } catch (e) {
      if (e.notReady) setNotReady(true);
      else if (!quiet) setErr(e.message);
    } finally {
      setLoaded(true);
    }
  }, []);

  // Load now, then keep the Sent list current (who has confirmed) while the page is open.
  useEffect(() => {
    const first = setTimeout(() => load(), 0);
    const iv = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, REFRESH_MS);
    return () => { clearTimeout(first); clearInterval(iv); };
  }, [load]);

  const groups = useMemo(() => groupVenues(venues, search), [venues, search]);
  const shownIds = useMemo(() => groups.flatMap((g) => g.venues.map((v) => String(v.id))), [groups]);
  // Only venues that still exist count, whatever is left in the tick set.
  const picked = useMemo(() => expandRecipients({ venueIds: [...ticked], venues }).venueIds, [ticked, venues]);
  const sent = useMemo(() => rollupBroadcasts(rows, venues), [rows, venues]);
  const draft = useMemo(() => cleanDraft({ title, body, kind }), [title, body, kind]);
  const bodyLen = [...body].length;

  const toggle = (ids, on) => setTicked((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.add(String(id)); else next.delete(String(id)); }
    return next;
  });
  const allShownTicked = shownIds.length > 0 && shownIds.every((id) => ticked.has(id));

  const send = async () => {
    setErr(''); setNote('');
    if (!draft.ok) { setErr(draft.error); return; }
    if (!picked.length) { setErr('Tick at least one venue.'); return; }
    if (!window.confirm(sendQuestion(picked.length))) return;
    setBusy('send');
    try {
      const res = await callVenueMessages('send', {
        title: draft.title, body: draft.body, kind: draft.kind, venue_ids: picked,
        expect_count: picked.length, broadcast_id: draftId.current,
      });
      // From what the server really WROTE, not what was picked: a second try of a send whose
      // reply was lost writes nothing, and must not read as a second send.
      setNote(sendResultLine({ sent: res.sent, written: res.written }));
      setTitle(''); setBody(''); setKind('info'); setTicked(new Set());
      draftId.current = newId();
      await load({ quiet: true });
    } catch (e) {
      if (e.notReady) setNotReady(true);
      setErr(e.message);
      // An earlier try DID arrive (its reply was lost) and the words have changed since. That
      // send keeps its id and its words; this draft is a new message from here on. Show the
      // Sent list so the first one can be seen (and withdrawn) before sending this one.
      if (e.code === 'already_sent') {
        draftId.current = newId();
        await load({ quiet: true });
      }
    } finally {
      setBusy('');
    }
  };

  const resend = async (g) => {
    setErr(''); setNote('');
    if (!window.confirm(g.waiting === 1 ? 'Send again to the 1 venue still waiting?' : `Send again to the ${g.waiting} venues still waiting?`)) return;
    setBusy(`resend:${g.broadcastId}`);
    try {
      const res = await callVenueMessages('resend', { broadcast_id: g.broadcastId });
      setNote(res.resent === 1 ? 'Sent again to 1 venue.' : `Sent again to ${res.resent} venues.`);
      await load({ quiet: true });
    } catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const withdraw = async (g) => {
    setErr(''); setNote('');
    if (!window.confirm('Withdraw this message? The pop up disappears from every till and Back Office at once.')) return;
    setBusy(`withdraw:${g.broadcastId}`);
    try {
      await callVenueMessages('withdraw', { broadcast_id: g.broadcastId });
      setNote('Withdrawn. It is gone from every till and Back Office.');
      await load({ quiet: true });
    } catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };

  return (
    <div data-testid="admin-venue-messages">
      <div style={S.h1}>Messages to venues</div>
      <div style={S.sub}>
        Send a message that pops up on the tills and in Back Office of the venues you tick. It stays until someone
        there taps Got it, and you see who did and when. It never shows over a payment, or on a kiosk, kitchen screen
        or customer screen.
      </div>

      {notReady && <div style={S.error} role="alert">{NEEDS_UPDATE_LINE}</div>}
      {err && !notReady && <div style={S.error} role="alert">{err}</div>}
      {note && <div style={S.note}>{note}</div>}

      {/* ── Compose ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
        <div style={S.card}>
          <div style={S.h2}>New message</div>

          <label style={S.label} htmlFor="vm-kind">Kind</label>
          <div id="vm-kind" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {['info', 'action'].map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
                style={{ ...S.btn, ...(kind === k ? (k === 'action' ? { background: 'var(--red-d)', color: 'var(--red)', border: '1px solid var(--red-b)' } : { background: 'var(--acc-d)', color: 'var(--acc)', border: '1px solid var(--acc-b)' }) : S.ghost) }}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>

          <label style={S.label} htmlFor="vm-title">Title (optional)</label>
          <input id="vm-title" style={{ ...S.input, marginBottom: 14 }} value={title} maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)} placeholder="New update" />

          <label style={S.label} htmlFor="vm-body">Message</label>
          <textarea id="vm-body" style={{ ...S.input, minHeight: 150, resize: 'vertical', lineHeight: 1.5 }} value={body}
            onChange={(e) => setBody(e.target.value)} placeholder="Hi, I have just made an update, you need to do XYZ" />
          <div style={{ fontSize: 13, marginTop: 6, color: bodyLen > MESSAGE_MAX ? 'var(--red)' : 'var(--t3)' }}>
            {bodyLen} of {MESSAGE_MAX} characters. Plain text. Line breaks are kept. Links are shown as text, not opened.
          </div>
        </div>

        <div>
          <div style={{ ...S.label, marginBottom: 8 }}>How it looks at the venue</div>
          <VenueMessageCard preview message={{ kind, title: draft.ok ? draft.title : title.trim(), body: draft.ok ? draft.body : body }}
            sentText={formatVenueTime(new Date().toISOString(), null)} whoName="the person who taps" />
        </div>
      </div>

      {/* ── Recipients ── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ ...S.h2, marginBottom: 0, flex: 1 }}>
            Send to {picked.length === 1 ? '1 venue' : `${picked.length} venues`} <span style={{ fontWeight: 500, color: 'var(--t3)', fontSize: 14 }}>of {venues.length}</span>
          </div>
          <button type="button" style={{ ...S.btn, ...S.ghost }} disabled={!shownIds.length}
            onClick={() => toggle(shownIds, !allShownTicked)}>
            {allShownTicked ? 'Clear all' : (search.trim() ? 'Select all shown' : 'Select all')}
          </button>
        </div>
        <input style={{ ...S.input, marginBottom: 12 }} value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search companies and venues" aria-label="Search companies and venues" />
        {!loaded && <div style={{ fontSize: 14, color: 'var(--t3)' }}>Loading…</div>}
        {loaded && groups.length === 0 && <div style={{ fontSize: 14, color: 'var(--t3)' }}>{venues.length ? 'Nothing matches that search.' : 'No venues to show.'}</div>}
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {groups.map((g) => {
            const ids = g.venues.map((v) => String(v.id));
            const n = ids.filter((id) => ticked.has(id)).length;
            return (
              <div key={g.orgId || 'none'} style={{ borderTop: '1px solid var(--bdr)', padding: '10px 0' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>
                  <input type="checkbox" checked={n === ids.length} ref={(el) => { if (el) el.indeterminate = n > 0 && n < ids.length; }}
                    onChange={(e) => toggle(ids, e.target.checked)} style={{ width: 18, height: 18 }} />
                  {g.company}
                  <span style={{ fontWeight: 500, color: 'var(--t3)', fontSize: 13 }}>{n} of {ids.length}</span>
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 4, margin: '8px 0 0 28px' }}>
                  {g.venues.map((v) => (
                    <label key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, color: 'var(--t1)', padding: '4px 0' }}>
                      <input type="checkbox" checked={ticked.has(String(v.id))} onChange={(e) => toggle([v.id], e.target.checked)} style={{ width: 16, height: 16 }} />
                      <span style={{ overflowWrap: 'anywhere' }}>{v.name || 'Unnamed venue'}</span>
                      {v.status && v.status !== 'active' && <span style={S.pill('plain')}>{v.status}</span>}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          <button type="button" style={{ ...S.btn, ...S.primary, opacity: (busy || notReady) ? 0.6 : 1 }} disabled={!!busy || notReady} onClick={send}>
            {busy === 'send' ? 'Sending…' : (picked.length === 1 ? 'Send to 1 venue' : `Send to ${picked.length} venues`)}
          </button>
          {!draft.ok && body.trim() !== '' && <span style={{ fontSize: 14, color: 'var(--red)' }}>{draft.error}</span>}
        </div>
      </div>

      {/* ── Sent ── */}
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{ ...S.h2, marginBottom: 0, flex: 1 }}>Sent <span style={{ fontWeight: 500, color: 'var(--t3)', fontSize: 14 }}>last 90 days</span></div>
          <button type="button" style={{ ...S.btn, ...S.ghost }} onClick={() => load()}>Refresh</button>
        </div>
        {loaded && sent.length === 0 && <div style={{ fontSize: 14, color: 'var(--t3)' }}>Nothing sent yet.</div>}
        {sent.map((g) => {
          const isOpen = open === g.broadcastId;
          const done = g.total > 0 && g.confirmed === g.total;
          return (
            <div key={g.broadcastId} style={{ borderTop: '1px solid var(--bdr)', padding: '14px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={S.pill(g.kind === 'action' ? 'red' : 'acc')}>{KIND_LABEL[g.kind]}</span>
                <span style={S.pill(g.withdrawn ? 'plain' : done ? 'acc' : 'red')}>{countsLine(g)}</span>
                <span style={{ fontSize: 13, color: 'var(--t3)' }}>
                  Sent {formatVenueTime(g.sentAt, Intl.DateTimeFormat().resolvedOptions().timeZone)} your time{g.sentByName ? ` by ${g.sentByName}` : ''}
                  {g.resentAt ? `, sent again ${formatVenueTime(g.resentAt, Intl.DateTimeFormat().resolvedOptions().timeZone)}` : ''}
                </span>
              </div>
              {g.title && <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)', overflowWrap: 'anywhere' }}>{g.title}</div>}
              <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--t1)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 2 }}>{g.body}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <button type="button" style={{ ...S.btn, ...S.ghost }} onClick={() => setOpen(isOpen ? null : g.broadcastId)} aria-expanded={isOpen}>
                  {isOpen ? 'Hide venues' : (g.total === 1 ? 'Show the venue' : `Show the ${g.total} venues`)}
                </button>
                {g.waiting > 0 && (
                  <button type="button" style={{ ...S.btn, ...S.ghost }} disabled={!!busy} onClick={() => resend(g)}>
                    {busy === `resend:${g.broadcastId}` ? 'Sending…' : 'Send again to those still waiting'}
                  </button>
                )}
                {!g.withdrawn && (
                  <button type="button" style={{ ...S.btn, ...S.danger }} disabled={!!busy} onClick={() => withdraw(g)}>
                    {busy === `withdraw:${g.broadcastId}` ? 'Withdrawing…' : 'Withdraw'}
                  </button>
                )}
              </div>
              {isOpen && (
                <div style={{ marginTop: 10 }}>
                  {g.venues.map((v) => (
                    <div key={v.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderTop: '1px dashed var(--bdr)', fontSize: 14 }}>
                      <span style={{ minWidth: 240, fontWeight: 700, color: 'var(--t1)' }}>
                        {v.companyName ? `${v.companyName}, ` : ''}{v.venueName}
                      </span>
                      <span style={{ color: v.status === 'waiting' ? 'var(--red)' : 'var(--t2)' }}>
                        {venueStatusLine(v)}
                        {v.status !== 'waiting' && v.confirmedAt ? ` (venue time${v.confirmedVia === 'till' ? `, on ${v.confirmedDevice || 'a till'}` : v.confirmedVia === 'backoffice' ? ', in Back Office' : ''})` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
