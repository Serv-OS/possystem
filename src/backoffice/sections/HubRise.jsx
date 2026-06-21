// src/backoffice/sections/HubRise.jsx
//
// Back Office → Channels → "Delivery channels (HubRise)".
// Connect a venue to HubRise (OAuth or a pasted access token), publish the menu,
// resync stock, set the accept policy, and see sync status. The access token lives
// server-side only — this screen talks to the hubrise-* edge functions.

import { useEffect, useState, useCallback } from 'react';
import { getActiveLocationSync, platformSupabase, supabase } from '../../lib/supabase';
import {
  hubriseStatus, hubriseOAuthStart, hubriseConnectToken, hubriseSetPolicy, hubriseSetMenus,
  hubriseRegister, hubriseDisconnect, hubrisePushCatalog, hubriseResyncStock,
  setHubriseConnected, setHubriseAutoReceipt,
} from '../../lib/hubrise';

const S = {
  wrap: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 },
  card: { background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 },
  h1: { fontSize: 20, fontWeight: 800, color: 'var(--t1)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 },
  h2: { fontSize: 14, fontWeight: 800, color: 'var(--t1)', margin: '0 0 10px' },
  label: { fontSize: 12, fontWeight: 700, color: 'var(--t3)', marginBottom: 6 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t1)', fontSize: 13, fontFamily: 'inherit' },
  btn: { padding: '9px 16px', borderRadius: 9, border: 'none', background: 'var(--acc)', color: '#0b0c10', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' },
  btnGhost: { padding: '9px 16px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'transparent', color: 'var(--t1)', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  btnDanger: { padding: '9px 16px', borderRadius: 9, border: '1px solid #ef444455', background: 'transparent', color: '#ef4444', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  row: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
  kv: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--bdr)', fontSize: 13 },
  k: { color: 'var(--t3)' },
  v: { color: 'var(--t1)', fontWeight: 600, textAlign: 'right' },
  pill: (ok) => ({ display: 'inline-block', padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 800, background: ok ? '#22c55e22' : '#88878022', color: ok ? '#22c55e' : 'var(--t3)' }),
  note: (kind) => ({ fontSize: 12.5, padding: '9px 12px', borderRadius: 9, marginTop: 4, background: kind === 'err' ? '#ef444418' : '#22c55e18', color: kind === 'err' ? '#ef4444' : '#16a34a' }),
  empty: { color: 'var(--t3)', fontSize: 14, padding: 24 },
};

const fmt = (t) => (t ? new Date(t).toLocaleString() : '—');

export default function HubRise() {
  const [locId, setLocId] = useState(null);
  const [venueName, setVenueName] = useState('');
  const [status, setStatus] = useState(null);
  const [menus, setMenus] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState(null); // {kind, text}

  const refresh = useCallback(async (id) => {
    try {
      const r = await hubriseStatus(id);
      setStatus(r?.status || { connected: false });
      setHubriseConnected(id, !!r?.status?.connected);
      setHubriseAutoReceipt(id, r?.status?.auto_print_receipt !== false);
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  }, []);

  useEffect(() => {
    (async () => {
      const id = await getActiveLocationSync();
      setLocId(id);
      if (!id) { setLoading(false); return; }
      try {
        const { data: pl } = await platformSupabase.from('locations').select('name').or(`ops_location_id.eq.${id},id.eq.${id}`).limit(1).maybeSingle();
        setVenueName(pl?.name || '');
      } catch { /* name optional */ }
      try {
        const { data: ms } = await supabase.from('menus').select('id, name, is_active').eq('location_id', id).order('sort_order', { ascending: true });
        setMenus(ms || []);
      } catch { /* menus optional */ }
      // Surface the OAuth redirect result, then clean the URL.
      try {
        const q = new URLSearchParams(window.location.search);
        if (q.get('hubrise') === 'connected') setMsg({ kind: 'ok', text: 'Connected to HubRise.' });
        if (q.get('hubrise') === 'error') setMsg({ kind: 'err', text: `Connection failed: ${q.get('msg') || 'unknown error'}` });
        if (q.get('hubrise')) { q.delete('hubrise'); q.delete('msg'); window.history.replaceState({}, '', `${window.location.pathname}?${q.toString()}`.replace(/\?$/, '')); }
      } catch { /* ignore */ }
      await refresh(id);
      setLoading(false);
    })();
  }, [refresh]);

  const run = async (key, fn, okText) => {
    setBusy(key); setMsg(null);
    try { await fn(); if (okText) setMsg({ kind: 'ok', text: okText }); await refresh(locId); }
    catch (e) { setMsg({ kind: 'err', text: e.message }); }
    finally { setBusy(''); }
  };

  const toggleMenu = (id) => {
    const cur = new Set(status?.menu_ids || []);
    cur.has(id) ? cur.delete(id) : cur.add(id);
    run('menus', () => hubriseSetMenus(locId, [...cur]));
  };

  if (loading) return <div style={S.empty}>Loading…</div>;
  if (!locId) return <div style={S.empty}>Pick a location to set up HubRise.</div>;

  const connected = !!status?.connected;

  return (
    <div style={S.wrap}>
      <div>
        <h1 style={S.h1}>🔗 Delivery channels — HubRise</h1>
        <div style={S.sub}>
          Connect this venue to HubRise to receive Deliveroo / Uber Eats / Just Eat and HubRise
          online orders straight into the Orders Hub + kitchen, publish your menu to those channels,
          and keep stock in sync. Orders flow back their status automatically as you advance them.
        </div>
      </div>

      {msg && <div style={S.note(msg.kind)}>{msg.text}</div>}

      {/* Connection */}
      <div style={S.card}>
        <div style={{ ...S.row, justifyContent: 'space-between' }}>
          <div style={S.h2}>Connection</div>
          <span style={S.pill(connected)}>{connected ? 'Connected' : 'Not connected'}</span>
        </div>

        {connected ? (
          <>
            <div style={S.kv}><span style={S.k}>HubRise account</span><span style={S.v}>{status.account_name || '—'}</span></div>
            <div style={S.kv}><span style={S.k}>Location</span><span style={S.v}>{status.hubrise_location_name || status.hubrise_location_id || '—'}</span></div>
            <div style={S.kv}><span style={S.k}>Currency</span><span style={S.v}>{status.currency || '—'}</span></div>
            <div style={S.kv}><span style={S.k}>Order callbacks</span><span style={S.v}>{status.callbacks_registered_at ? `registered ${fmt(status.callbacks_registered_at)}` : 'not registered'}</span></div>
            <div style={{ ...S.row, marginTop: 14 }}>
              <button style={S.btnGhost} disabled={busy === 'reg'} onClick={() => run('reg', () => hubriseRegister(locId), 'Order callbacks re-registered.')}>
                {busy === 'reg' ? '…' : 'Re-register callbacks'}
              </button>
              <button style={S.btnDanger} disabled={busy === 'disc'} onClick={() => {
                if (!confirm('Disconnect this venue from HubRise? Channels will stop receiving orders and the menu will no longer update.')) return;
                run('disc', () => hubriseDisconnect(locId), 'Disconnected from HubRise.');
              }}>{busy === 'disc' ? '…' : 'Disconnect'}</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ ...S.sub, marginTop: 0, marginBottom: 14 }}>
              Link your HubRise account. The quickest path is to authorize in HubRise; or paste a
              personal access token created in your HubRise back office (Settings → Developer).
            </div>
            <div style={S.row}>
              <button style={S.btn} disabled={busy === 'oauth'} onClick={() => run('oauth', async () => {
                const r = await hubriseOAuthStart(locId, venueName);
                if (r?.url) window.location.href = r.url; else throw new Error('Could not start authorization');
              })}>{busy === 'oauth' ? '…' : 'Connect with HubRise'}</button>
            </div>
            <div style={{ ...S.label, marginTop: 16 }}>…or paste a personal access token</div>
            <div style={S.row}>
              <input style={{ ...S.input, flex: 1, minWidth: 240 }} placeholder="HubRise access token" value={token} onChange={(e) => setToken(e.target.value)} />
              <button style={S.btnGhost} disabled={busy === 'tok' || !token.trim()} onClick={() => run('tok', async () => {
                await hubriseConnectToken(locId, token.trim()); setToken('');
              }, 'Connected to HubRise.')}>{busy === 'tok' ? '…' : 'Connect'}</button>
            </div>
          </>
        )}
      </div>

      {/* Which menu publishes */}
      {connected && (
        <div style={S.card}>
          <div style={S.h2}>Menu to publish</div>
          <div style={{ ...S.sub, marginTop: 0, marginBottom: 10 }}>
            Choose which menu(s) go to the delivery channels. Prices use each item's <b>Delivery</b> price
            (set per item, or a per-menu “Deliveroo +0.50” tier in Menu → item → Per-menu pricing tiers).
            Leave all unticked to publish every online-visible item at its delivery price.
          </div>
          {menus.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>No menus found for this location.</div>
          ) : menus.map((m) => {
            const on = (status?.menu_ids || []).includes(m.id);
            return (
              <label key={m.id} style={{ ...S.row, cursor: 'pointer', padding: '5px 0' }}>
                <input type="checkbox" checked={on} disabled={busy === 'menus'} onChange={() => toggleMenu(m.id)} />
                <span style={{ fontSize: 13, color: 'var(--t1)' }}>{m.name}</span>
                {m.is_active === false && <span style={{ fontSize: 10, color: 'var(--t4)' }}>(inactive)</span>}
              </label>
            );
          })}
          <div style={{ ...S.sub, marginTop: 8 }}>
            {(status?.menu_ids || []).length
              ? `Publishing ${status.menu_ids.length} selected menu(s). Re-publish below after changing this.`
              : 'Publishing all online-visible items.'}
          </div>
        </div>
      )}

      {/* Menu + stock */}
      {connected && (
        <div style={S.card}>
          <div style={S.h2}>Menu &amp; stock</div>
          <div style={S.kv}><span style={S.k}>Catalog</span><span style={S.v}>{status.catalog_name || (status.catalog_id ? 'published' : 'not published')}</span></div>
          <div style={S.kv}><span style={S.k}>Menu last pushed</span><span style={S.v}>{fmt(status.catalog_pushed_at)}</span></div>
          <div style={S.kv}><span style={S.k}>Stock last synced</span><span style={S.v}>{fmt(status.inventory_synced_at)}</span></div>
          {status.catalog_push_error && <div style={S.note('err')}>Last menu push error: {status.catalog_push_error}</div>}
          <div style={{ ...S.row, marginTop: 14 }}>
            <button style={S.btn} disabled={busy === 'cat'} onClick={() => run('cat', () => hubrisePushCatalog(locId), 'Menu published to HubRise.')}>
              {busy === 'cat' ? 'Publishing…' : (status.catalog_id ? 'Re-publish menu' : 'Push menu to HubRise')}
            </button>
            <button style={S.btnGhost} disabled={busy === 'stk'} onClick={() => run('stk', () => hubriseResyncStock(locId), 'Stock resynced to HubRise.')}>
              {busy === 'stk' ? 'Syncing…' : 'Resync stock'}
            </button>
          </div>
          <div style={{ ...S.sub, marginTop: 10 }}>
            Re-publish whenever you change the menu. Out-of-stock (86) items are pushed automatically and
            also reconciled in the background.
          </div>
        </div>
      )}

      {/* Order handling policy */}
      {connected && (
        <div style={S.card}>
          <div style={S.h2}>Order handling</div>
          <label style={{ ...S.row, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!status.auto_accept} disabled={busy === 'pol'}
              onChange={(e) => run('pol', () => hubriseSetPolicy(locId, { auto_accept: e.target.checked }))} />
            <span style={{ fontSize: 13, color: 'var(--t1)' }}>Auto-accept incoming channel orders</span>
          </label>
          <label style={{ ...S.row, cursor: 'pointer', marginTop: 8 }}>
            <input type="checkbox" checked={status.auto_print_receipt !== false} disabled={busy === 'pol'}
              onChange={(e) => run('pol', () => hubriseSetPolicy(locId, { auto_print_receipt: e.target.checked }))} />
            <span style={{ fontSize: 13, color: 'var(--t1)' }}>Always print a customer receipt for delivery orders</span>
          </label>
          <div style={{ ...S.label, marginTop: 14 }}>Default prep time (minutes) sent to the channel on accept</div>
          <div style={S.row}>
            <input type="number" min="0" style={{ ...S.input, width: 110 }} defaultValue={status.default_prep_minutes ?? 20}
              onBlur={(e) => run('pol', () => hubriseSetPolicy(locId, { default_prep_minutes: Number(e.target.value) }))} />
          </div>
          <div style={{ ...S.sub, marginTop: 10 }}>
            With auto-accept off (recommended), staff accept each order in the Orders Hub and choose a prep
            time; that confirmed time is sent back to the channel.
          </div>
        </div>
      )}

      {/* Sync status */}
      {connected && (
        <div style={S.card}>
          <div style={S.h2}>Sync status</div>
          <div style={S.kv}><span style={S.k}>Last order received</span><span style={S.v}>{fmt(status.last_event_at)}</span></div>
          <div style={S.kv}><span style={S.k}>Last reconcile</span><span style={S.v}>{fmt(status.last_reconcile_at)}</span></div>
          {status.last_error && <div style={S.note('err')}>Last error: {status.last_error}</div>}
        </div>
      )}
    </div>
  );
}
