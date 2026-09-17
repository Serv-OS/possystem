// src/backoffice/sections/EzcaterSettings.jsx
//
// Back Office, Channels, 3rd Party orders, "Connect ezCater".
//
// WHY THIS SCREEN EXISTS
// The ezcater-connect edge function has implemented every action since day one,
// and nothing in Back Office called most of them, so there was no way for an
// operator to connect ezCater at all. Peter asked where the settings were. This
// is them: paste the token, pick which of your ezCater locations sends orders
// here, set how orders are taken, disconnect.
//
// THE TOKEN. ezCater issue one static token per API user, by email, and CANNOT
// re-issue it. It is typed into a password box, handed to the edge function
// once, and cleared from this component the moment the call returns. It is never
// logged, never put in localStorage, and never in an error message. Everything
// the function sends back about the connection is already scrubbed.
//
// The pure rules, every derived state and all the words are in
// src/lib/ezcaterSettings.js, which is tested. This file is the shell: fetch,
// render, send.
//
// BEFORE THE TABLES OR THE FUNCTION EXIST it shows one plain line and nothing
// else, and any single failed call shows one plain line while the rest of the
// page keeps working. isSetupOff() is the one test for that.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getActiveLocationSync, isMock, supabase } from '../../lib/supabase';
import {
  ezcaterStatus, ezcaterConnectToken, ezcaterListCaterers, ezcaterMapCaterer,
  ezcaterUnmapCaterer, ezcaterSetPolicy, ezcaterResubscribe, ezcaterDisconnect,
} from '../../lib/ezcater';
import {
  statusFrom, isConnected, statusWords, errorWords, isSetupOff,
  catererRows, caterersWhere, catererLine, connectBody, mapBody, unmapBody,
  policyPayload, apiEnvironment, gateWords, SWITCH_HELP,
} from '../../lib/ezcaterSettings';

// Same vocabulary as HubRise.jsx and EzcaterItemMatching.jsx, the cards this
// sits between. No new tokens, no new design language.
const S = {
  card: { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 },
  h2: { fontSize: 14, fontWeight: 800, color: 'var(--t1)', margin: '0 0 10px' },
  label: { fontSize: 12, fontWeight: 700, color: 'var(--t3)', marginBottom: 6 },
  input: { width: '100%', padding: '9px 11px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit' },
  btn: { padding: '9px 16px', borderRadius: 9, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  btnGhost: { padding: '7px 13px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'transparent', color: 'var(--t1)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnDanger: { padding: '9px 16px', borderRadius: 9, border: '1px solid #ef444455', background: 'transparent', color: '#ef4444', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  row: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
  field: { maxWidth: 420, marginTop: 12 },
  note: (kind) => ({
    fontSize: 12.5, padding: '9px 12px', borderRadius: 9, marginTop: 8, lineHeight: 1.5,
    background: kind === 'err' ? '#ef444418' : kind === 'warn' ? '#f59e0b18' : '#22c55e18',
    color: kind === 'err' ? '#ef4444' : kind === 'warn' ? '#b45309' : '#16a34a',
  }),
  pill: (tone) => ({
    display: 'inline-block', padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 800,
    background: tone === 'warn' ? '#f59e0b22' : tone === 'ok' ? '#22c55e22' : '#88878022',
    color: tone === 'warn' ? '#b45309' : tone === 'ok' ? '#22c55e' : 'var(--t3)',
  }),
  item: { padding: '12px 0', borderBottom: '1px solid var(--bdr)' },
  name: { fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' },
  meta: { fontSize: 11.5, color: 'var(--t4)', marginTop: 2 },
  help: { fontSize: 11.5, color: 'var(--t4)', lineHeight: 1.5, margin: '2px 0 0 24px', maxWidth: 460 },
  heading: { fontSize: 12.5, fontWeight: 800, color: 'var(--t1)', margin: '16px 0 2px' },
  off: { fontSize: 13, color: 'var(--t3)', lineHeight: 1.5 },
  ro: { width: '100%', padding: '9px 11px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t3)', fontSize: 12.5, fontFamily: 'var(--font-mono, monospace)' },
};

/** A checkbox with its own plain line underneath saying what it really does. */
function Switch({ on, disabled, onChange, children, help }) {
  return (
    <div style={{ marginTop: 8 }}>
      <label style={{ ...S.row, cursor: disabled ? 'default' : 'pointer' }}>
        <input type="checkbox" checked={!!on} disabled={!!disabled} onChange={(e) => onChange(e.target.checked)} />
        <span style={{ fontSize: 13, color: 'var(--t1)' }}>{children}</span>
      </label>
      {help ? <div style={S.help}>{help}</div> : null}
    </div>
  );
}

/** One ezCater location, and the one thing the operator can do with it. */
function CatererRow({ row, busy, onMap, onUnmap, onPolicy }) {
  const key = row.catererUuid;
  return (
    <div style={S.item}>
      <div style={{ ...S.row, justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 180, flex: '1 1 220px' }}>
          <div style={S.name}>{row.name}</div>
          <div style={S.meta}>{row.whereText}</div>
        </div>
        <div style={{ ...S.row, justifyContent: 'flex-end' }}>
          {row.where === 'here' && (
            <button style={S.btnGhost} disabled={!!busy} onClick={() => onUnmap(row)}>
              {busy === 'unmap:' + key ? 'Working…' : 'Unmap'}
            </button>
          )}
          {row.where === 'unmapped' && (
            <button style={S.btn} disabled={!!busy} onClick={() => onMap(row)}>
              {busy === 'map:' + key ? 'Working…' : 'Use this venue'}
            </button>
          )}
        </div>
      </div>

      {row.where === 'here' && (
        <div style={{ marginTop: 4 }}>
          <Switch
            on={row.autoAccept}
            disabled={busy === 'pol:' + key}
            help={SWITCH_HELP.autoAccept}
            onChange={(v) => onPolicy(row, { autoAccept: v })}>
            Take orders automatically
          </Switch>
          <Switch
            on={row.active}
            disabled={busy === 'pol:' + key}
            help={SWITCH_HELP.active}
            onChange={(v) => onPolicy(row, { active: v })}>
            Active
          </Switch>
        </div>
      )}
    </div>
  );
}

export default function EzcaterSettings({ locationId }) {
  const [locId, setLocId] = useState(locationId || null);
  const [loading, setLoading] = useState(true);
  const [off, setOff] = useState(false);
  const [status, setStatus] = useState({ connected: false });
  // Two sources describe the caterers and they answer different questions.
  // status knows what THIS venue has, and what nobody has claimed. list_caterers
  // knows everything the ezCater account has, including the locations set up on
  // your other venues. They are merged and deduped by catererRows, and the list
  // is dropped the moment a mapping changes, because then status is the only
  // one of the two still telling the truth.
  const [answer, setAnswer] = useState(null);
  const [listed, setListed] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);         // { kind, text }
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const connected = isConnected(status);
  const words = useMemo(() => statusWords(status), [status]);
  const env = useMemo(() => apiEnvironment(status && status.api_url), [status]);
  const rows = useMemo(() => catererRows({
    caterers: [...(listed || []), ...((answer && answer.caterers) || [])],
    unmapped: (answer && answer.unmapped) || [],
  }, locId), [answer, listed, locId]);
  const here = useMemo(() => caterersWhere(rows, 'here'), [rows]);
  const unmapped = useMemo(() => caterersWhere(rows, 'unmapped'), [rows]);
  const elsewhere = useMemo(() => caterersWhere(rows, 'other'), [rows]);

  const load = useCallback(async (id) => {
    if (!id) { setLoading(false); return; }
    // Local dev has no Supabase at all. That is the same answer as "not
    // switched on yet", not a red error to stare at.
    if (isMock || !supabase) { setOff(true); setLoading(false); return; }
    setLoading(true);
    try {
      const r = await ezcaterStatus(id);
      setOff(false);
      setStatus(statusFrom(r));
      setAnswer(r);
    } catch (e) {
      // Not switched on yet is not an error. Anything else is, and says so in
      // plain words, on one line, with the rest of the page still working.
      if (isSetupOff(e)) setOff(true);
      else setMsg({ kind: 'err', text: errorWords(e) });
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

  const refreshStatus = useCallback(async () => {
    const r = await ezcaterStatus(locId);
    setStatus(statusFrom(r));
    setAnswer(r);
  }, [locId]);

  /** Run one call, show one plain line either way, then re-read the status. */
  const run = useCallback(async (key, fn, okText) => {
    setBusy(key); setMsg(null);
    try {
      await fn();
      if (okText) setMsg({ kind: 'ok', text: okText });
      // A mapping just changed, so the cached account-wide list is out of date
      // and would keep showing a caterer here after it was unmapped.
      setListed(null);
      await refreshStatus();
    } catch (e) {
      if (isSetupOff(e)) setOff(true);
      else setMsg({ kind: 'err', text: errorWords(e) });
    } finally { setBusy(''); }
  }, [refreshStatus]);

  const connect = useCallback(async () => {
    const built = connectBody({ token, label, apiUrl });
    if (built.error) { setMsg({ kind: 'err', text: built.error }); return; }
    setBusy('connect'); setMsg(null);
    try {
      const r = await ezcaterConnectToken(locId, built.body);
      // Gone from this component the moment it has been sent. Nothing keeps it.
      setToken('');
      setStatus(statusFrom(r));
      // connect_token answers with the caterers that token can see, which is
      // exactly the list the operator now has to pick from.
      setListed(Array.isArray(r && r.caterers) ? r.caterers : []);
      setMsg({ kind: 'ok', text: 'Connected to ezCater. Now pick which of your ezCater locations sends its orders to this venue.' });
      // And the stored view of those same caterers, which is what the mapping
      // buttons act on. Best effort: the list above is already on screen, so a
      // slow status read must not turn a good connect into a red line.
      try { await refreshStatus(); } catch { /* the connect answer stands */ }
      if (r && r.webhook_repoint_error) {
        setMsg({ kind: 'err', text: 'ezCater is still sending orders to an older address, so nothing will arrive here yet. Press "Re-register for orders", and tell us if it stays this way.' });
      }
    } catch (e) {
      if (isSetupOff(e)) setOff(true);
      else setMsg({ kind: 'err', text: errorWords(e) });
    } finally { setBusy(''); }
  }, [locId, token, label, apiUrl, refreshStatus]);

  /**
   * Ask ezCater again which locations this account has.
   *
   * Not through run(), because run() drops the account-wide list on purpose and
   * this is the one call whose whole point is to fetch it.
   */
  const refreshList = useCallback(async () => {
    setBusy('list'); setMsg(null);
    try {
      const r = await ezcaterListCaterers(locId);
      setListed(Array.isArray(r && r.caterers) ? r.caterers : []);
      await refreshStatus();
    } catch (e) {
      if (isSetupOff(e)) setOff(true);
      else setMsg({ kind: 'err', text: errorWords(e) });
    } finally { setBusy(''); }
  }, [locId, refreshStatus]);

  const mapOne = useCallback((row) => {
    const built = mapBody({ catererUuid: row.catererUuid, name: row.name });
    if (built.error) { setMsg({ kind: 'err', text: built.error }); return; }
    run('map:' + row.catererUuid, () => ezcaterMapCaterer(locId, built.body),
      row.name + ' now sends its orders to this venue.');
  }, [run, locId]);

  const unmapOne = useCallback((row) => {
    const built = unmapBody({ catererUuid: row.catererUuid });
    if (built.error) { setMsg({ kind: 'err', text: built.error }); return; }
    if (!window.confirm('Stop ' + row.name + ' sending its orders to this venue? Orders already here are not affected.')) return;
    run('unmap:' + row.catererUuid, () => ezcaterUnmapCaterer(locId, built.body),
      row.name + ' no longer sends its orders here.');
  }, [run, locId]);

  const setCatererPolicy = useCallback((row, patch) => {
    const payload = policyPayload({ catererUuid: row.catererUuid, ...patch });
    run('pol:' + row.catererUuid, () => ezcaterSetPolicy(locId, payload));
  }, [run, locId]);

  const setGate = useCallback((on) => {
    run('gate', () => ezcaterSetPolicy(locId, policyPayload({ acceptEnabled: on })));
  }, [run, locId]);

  const copyWebhook = useCallback(async () => {
    const text = (status && status.webhook_url) || '';
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
    else setMsg({ kind: 'err', text: 'We could not copy that. Select the address and copy it by hand.' });
  }, [status]);

  const disconnect = useCallback(() => {
    if (!window.confirm('Disconnect ezCater? Orders from ezCater stop arriving at this venue straight away, and you will have to paste your API token again to start them. Orders already taken are not affected.')) return;
    run('disc', () => ezcaterDisconnect(locId), 'Disconnected from ezCater. Orders from ezCater will no longer arrive.');
  }, [run, locId]);

  if (!locId) return null;

  return (
    <div style={S.card}>
      <div style={{ ...S.row, justifyContent: 'space-between' }}>
        <div style={S.h2}>Connect ezCater</div>
        <div style={S.row}>
          {connected && <span style={S.pill(env.tone)}>{env.label}</span>}
          <span style={S.pill(connected ? 'ok' : 'off')}>{connected ? 'Connected' : 'Not connected'}</span>
        </div>
      </div>

      {loading ? (
        <div style={{ ...S.off, marginTop: 10 }}>Loading…</div>
      ) : off ? (
        <div style={{ ...S.off, marginTop: 10 }}>ezCater is not switched on for this venue yet.</div>
      ) : (
        <>
          {msg && <div style={S.note(msg.kind)}>{msg.text}</div>}

          {!connected ? (
            <>
              {/* A connection that went wrong is still not connected, and the
                  operator has to be told why the box is asking for a token
                  again rather than just seeing an empty form. The cure is
                  offered here too, because the connected view they would
                  normally find it on is the one they cannot see. */}
              {words.tone === 'warn' && (
                <>
                  <div style={S.note('warn')}>{words.text}</div>
                  <div style={{ ...S.row, marginTop: 10 }}>
                    <button style={S.btnGhost} disabled={busy === 'resub'}
                      onClick={() => run('resub', () => ezcaterResubscribe(locId), 'Registered with ezCater again. New orders should arrive here.')}>
                      {busy === 'resub' ? 'Working…' : 'Re-register for orders'}
                    </button>
                  </div>
                </>
              )}
              <div style={{ ...S.sub, marginTop: 8 }}>
                Your ezCater API token is the long code ezCater issue to your account. Get it from the
                ezCater Partner Portal, Settings, Integrations, then paste it below. ezCater cannot show
                it to you twice, so keep your own copy somewhere safe.
              </div>

              <div style={S.field}>
                <div style={S.label}>ezCater API token</div>
                <input
                  type="password"
                  style={S.input}
                  value={token}
                  autoComplete="off"
                  spellCheck="false"
                  placeholder="Paste the token from ezCater"
                  aria-label="ezCater API token"
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>

              <div style={S.field}>
                <div style={S.label}>Name for this connection (optional)</div>
                <input
                  style={S.input}
                  value={label}
                  placeholder="For example, Main kitchen"
                  aria-label="Name for this ezCater connection"
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>

              <div style={S.field}>
                <div style={S.label}>API address (optional)</div>
                <input
                  style={S.input}
                  value={apiUrl}
                  autoComplete="off"
                  spellCheck="false"
                  placeholder="Leave empty for the live ezCater API"
                  aria-label="ezCater API address"
                  onChange={(e) => setApiUrl(e.target.value)}
                />
                <div style={{ ...S.sub, marginTop: 6 }}>
                  Leave this empty. Empty means the live ezCater API, which is what almost everyone wants.
                  Paste an address here only if ezCater gave you a sandbox one to test with, and remember
                  that a sandbox takes test orders only.
                </div>
              </div>

              <div style={{ ...S.row, marginTop: 14 }}>
                <button style={S.btn} disabled={busy === 'connect'} onClick={connect}>
                  {busy === 'connect' ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={S.note(words.tone)}>{words.text}</div>
              <div style={S.note(env.tone === 'warn' ? 'warn' : 'ok')}>{env.text}</div>

              <div style={{ ...S.field, maxWidth: 520 }}>
                <div style={S.label}>Where ezCater send your orders</div>
                <div style={S.row}>
                  <input style={{ ...S.ro, flex: '1 1 260px' }} readOnly value={status.webhook_url || ''} aria-label="Webhook address" />
                  <button style={S.btnGhost} onClick={copyWebhook}>{copied ? 'Copied' : 'Copy'}</button>
                </div>
                <div style={{ ...S.sub, marginTop: 6 }}>
                  We set this up with ezCater for you. There is nothing to do with it unless ezCater ask for it.
                </div>
              </div>

              <div style={{ ...S.row, marginTop: 14 }}>
                <button style={S.btnGhost} disabled={busy === 'list'} onClick={refreshList}>
                  {busy === 'list' ? 'Refreshing…' : 'Refresh list'}
                </button>
                <button style={S.btnGhost} disabled={busy === 'resub'}
                  onClick={() => run('resub', () => ezcaterResubscribe(locId), 'Registered with ezCater again. New orders should arrive here.')}>
                  {busy === 'resub' ? 'Working…' : 'Re-register for orders'}
                </button>
              </div>
              <div style={{ ...S.sub, marginTop: 6 }}>
                Refresh list asks ezCater which locations your account has. Re-register asks ezCater to send
                this venue its orders again, which is the first thing to try if orders stop arriving.
              </div>

              <div style={S.heading}>Your ezCater locations</div>
              <div style={{ ...S.sub, marginTop: 0 }}>{catererLine(rows)}</div>

              {here.map((r) => (
                <CatererRow key={r.catererUuid} row={r} busy={busy}
                  onMap={mapOne} onUnmap={unmapOne} onPolicy={setCatererPolicy} />
              ))}

              {unmapped.length > 0 && (
                <>
                  <div style={S.heading}>Seen on ezCater, not set up yet</div>
                  <div style={{ ...S.sub, marginTop: 0 }}>
                    Pick the one that belongs to this venue and its orders will come here.
                  </div>
                  {unmapped.map((r) => (
                    <CatererRow key={r.catererUuid} row={r} busy={busy}
                      onMap={mapOne} onUnmap={unmapOne} onPolicy={setCatererPolicy} />
                  ))}
                </>
              )}

              {elsewhere.length > 0 && (
                <>
                  <div style={S.heading}>Set up on your other venues</div>
                  {elsewhere.map((r) => (
                    <CatererRow key={r.catererUuid} row={r} busy={busy}
                      onMap={mapOne} onUnmap={unmapOne} onPolicy={setCatererPolicy} />
                  ))}
                </>
              )}

              <div style={S.heading}>What ezCater have switched on</div>
              <Switch
                on={status.accept_enabled === true}
                disabled={busy === 'gate'}
                help={SWITCH_HELP.acceptEnabled}
                onChange={setGate}>
                ezCater have switched accept and reject on for us
              </Switch>
              <div style={{ ...S.sub, marginTop: 6 }}>{gateWords(status.accept_enabled)}</div>

              <div style={{ ...S.row, marginTop: 18 }}>
                <button style={S.btnDanger} disabled={busy === 'disc'} onClick={disconnect}>
                  {busy === 'disc' ? 'Working…' : 'Disconnect'}
                </button>
                <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>
                  Orders from ezCater stop arriving as soon as you do this.
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
