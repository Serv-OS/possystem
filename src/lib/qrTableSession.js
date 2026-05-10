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

import { supabase } from './supabase';

export async function syncQrTableSession(locationId, tableId) {
  if (!supabase || !locationId || !tableId) return;
  try {
    // All open QR rounds at this table — by jsonb path on customer.tableId.
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

    if (!allItems.length) {
      // No open QR items — clear the QR session if it exists. Don't blanket-
      // delete other dine-in sessions that an operator may have started
      // on this table via POS — only delete if the existing session was
      // QR-managed (source='qr' on the session jsonb).
      const { data: existing } = await supabase
        .from('active_sessions').select('session')
        .eq('location_id', locationId).eq('table_id', tableId).maybeSingle();
      if (existing?.session?.source === 'qr') {
        await supabase.from('active_sessions')
          .delete().eq('location_id', locationId).eq('table_id', tableId);
      }
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

    await supabase.from('active_sessions').upsert({
      location_id: locationId,
      table_id: tableId,
      session,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'location_id,table_id' });
  } catch (e) {
    console.warn('[syncQrTableSession] failed:', e?.message);
  }
}
