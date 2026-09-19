// v5.5.157 — keep the floor-plan table session in sync with open QR tabs.
//
// When a customer opens a QR tab at table 4, OR adds another round, OR an
// operator force-closes a tab, we recompute the active_sessions row for
// table 4 from the live order_queue: aggregate items from every open QR
// round at this table → upsert; if zero remain → delete.
//
// This is what makes a QR tab show up on the floor-plan / TablesSurface as
// "Table 4 — in service" alongside any traditional dine-in items. Multiple
// sub-tabs (4.1, 4.2) at the same table merge into one combined session
// for display purposes — operators on the floor plan see the table is busy
// without having to drill into the QR tabs section. The QR tabs section
// in OrdersHub still groups by payment_intent_id for actual capture.
//
// Keeps the QR + bar_tabs concerns isolated (no bar_tabs touched, per
// the existing memory rule).

// Database fence stage 1 (contract S1, tables never lost): this helper only ever writes or
// deletes a session that is QR's own (session.source === 'qr'). A till's session on the same
// table is never overwritten or removed: the old blind upsert replaced it whenever a QR round
// landed on a table a till had open. Writes are conditional in the database too (insert only
// when there is no row, update and delete only WHERE session->>source = 'qr'), so a till that
// seats the table between our read and our write still wins.
// STAGE 1 CLEANUP: once 20260919b has run the order_queue_qr_floor trigger keeps the floor plan
// (same rule, on the server) and the phone callers (QrCheckout) and OrdersHub force close no
// longer need this; remove the calls then.
import { supabase } from './supabase';
import { qrSessionWriteAction } from './publicOrder';   // pure, tested in publicOrder.test.js

export async function syncQrTableSession(locationId, tableId) {
  if (!supabase || !locationId || !tableId) return;
  try {
    // Resolve the QR-provided tableId to the CANONICAL floor table id (floor_tables.id) before we
    // touch active_sessions. QR URLs/tabs sometimes carry a table LABEL ("T2") or a non-canonical id;
    // writing that verbatim created active_sessions rows that matched no floor table, so neither the
    // POS floor plan nor the waitlist Floor (both key by floor id) could show them — they just became
    // orphaned junk. We still read the QR rounds by the original stashed value (that's how they're
    // keyed in order_queue), but the active_sessions row is always keyed by the floor id.
    let floorId = String(tableId);
    try {
      const { data: ft } = await supabase.from('floor_tables').select('id,label').eq('location_id', locationId);
      const want = String(tableId).trim().toLowerCase();
      const match = (ft || []).find((f) => String(f.id) === String(tableId))
                 || (ft || []).find((f) => String(f.label ?? '').trim().toLowerCase() === want);
      if (match) floorId = String(match.id);
    } catch { /* fall back to the raw tableId if the lookup fails */ }

    // All open QR rounds at this table — by jsonb path on customer.tableId (the original stashed value).
    const { data: rows, error } = await supabase
      .from('order_queue')
      .select('ref, items, customer, total, sent_at')
      .eq('location_id', locationId)
      .eq('source', 'qr')
      .neq('status', 'collected')
      .filter('customer->>tableId', 'eq', String(tableId));
    if (error) { console.warn('[syncQrTableSession] read failed:', error.message); return; }

    // Tag each item with its tab's payment_intent_id so the floor-plan UI
    // (or a future "split this table by tab" feature) can tell rounds apart.
    const allItems = (rows || []).flatMap(r => (r.items || []).map(i => ({
      ...i, tab_pi: r.customer?.payment_intent_id || null,
    })));

    // What is on the table now. A failed read decides nothing (never write blind).
    const { data: existing, error: exErr } = await supabase
      .from('active_sessions').select('session')
      .eq('location_id', locationId).eq('table_id', floorId).maybeSingle();
    if (exErr) { console.warn('[syncQrTableSession] session read failed, not writing:', exErr.message); return; }
    const action = qrSessionWriteAction({ existing, hasItems: allItems.length > 0 });
    if (action === 'skip') return;   // a till owns this table: never touch its session

    if (action === 'delete_qr') {
      // No open QR items: clear the QR session only (source='qr' on the session jsonb).
      await supabase.from('active_sessions')
        .delete().eq('location_id', locationId).eq('table_id', floorId)
        .filter('session->>source', 'eq', 'qr');
      return;
    }

    const subtotal = allItems.reduce((s, i) => {
      const unit = (Number(i.price) || 0) + (i.mods || []).reduce((m, x) => m + (Number(x.price) || 0), 0);
      return s + unit * (i.qty || 1);
    }, 0);

    const session = {
      items: allItems,
      server: 'QR',
      source: 'qr', // marker so the recompute on close knows it's safe to delete
      covers: 1,
      openedAt: rows[0]?.sent_at ? new Date(rows[0].sent_at).getTime() : Date.now(),
      sentAt: Date.now(),
      subtotal,
      total: subtotal,
      // tableLabel grows with sub-numbers as operators view it on the
      // floor plan; useful for "Table 4 has 2 open QR tabs" badge later.
      qr_tab_count: rows.length,
    };

    if (action === 'insert') {
      // Only when the table has no session. A till that seated it meanwhile makes this a
      // unique violation (23505), which leaves the till's session exactly as it is.
      const { error: insErr } = await supabase.from('active_sessions').insert({
        location_id: locationId,
        table_id: floorId,
        session,
        updated_at: new Date().toISOString(),
      });
      if (insErr && insErr.code !== '23505') console.warn('[syncQrTableSession] insert failed:', insErr.message);
      return;
    }
    await supabase.from('active_sessions')
      .update({ session, updated_at: new Date().toISOString() })
      .eq('location_id', locationId).eq('table_id', floorId)
      .filter('session->>source', 'eq', 'qr');
  } catch (e) {
    console.warn('[syncQrTableSession] failed:', e?.message);
  }
}
