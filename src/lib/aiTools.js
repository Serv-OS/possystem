/**
 * Serv OS — AI Tool Executor
 * Runs tool calls returned by the AI, reading data from Supabase.
 * Write tools return a "pending" action — the user must confirm before execution.
 */

import { supabase, getLocationId } from './supabase';
import { money } from './currency.js';

// Tools that require user confirmation before executing
export const WRITE_TOOLS = new Set(['add_menu_item', 'update_item_price', 'eighty_six_item', 'add_to_order', 'remove_from_order', 'apply_order_discount']);

/**
 * Execute a tool call from the AI.
 * Returns { result, pendingAction? }
 * If pendingAction is set, show it to the user for confirmation before calling executePendingAction().
 */
export async function executeTool(toolName, toolInput, storeState = {}) {
  const locationId = await getLocationId();

  switch (toolName) {

    case 'get_sales_summary': {
      // Always fetch live from Supabase so data is consistent across all devices
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      let checks = [];
      if (locationId && supabase) {
        const { data } = await supabase.from('closed_checks')
          .select('*').eq('location_id', locationId)
          .gte('closed_at', sod.toISOString()).order('closed_at', { ascending: false });
        checks = data || [];
      } else {
        const { closedChecks = [] } = storeState;
        checks = closedChecks.filter(c => c.closedAt && new Date(c.closedAt) >= sod);
      }
      // Normalise field names (DB uses snake_case, store uses camelCase)
      const norm = checks.map(c => ({ total: c.total, covers: c.covers || c.covers || 1, tip: c.tip || 0, method: c.payment_method || c.method, items: c.items || [], closedAt: c.closed_at || c.closedAt }));
      const revenue = norm.reduce((s, c) => s + (c.total || 0), 0);
      const covers  = norm.reduce((s, c) => s + c.covers, 0);
      const tips    = norm.reduce((s, c) => s + c.tip, 0);
      const card    = norm.filter(c => c.method === 'card').reduce((s, c) => s + c.total, 0);
      const cash    = norm.filter(c => c.method === 'cash').reduce((s, c) => s + c.total, 0);
      const avg     = norm.length ? revenue / norm.length : 0;
      return {
        result: {
          period: 'today',
          checks: norm.length,
          revenue: `${money(revenue)}`,
          covers,
          average_check: `${money(avg)}`,
          tips: `${money(tips)}`,
          card: `${money(card)}`,
          cash: `${money(cash)}`,
        },
      };
    }

    case 'get_top_items': {
      const limit = Math.min(toolInput.limit || 5, 10);
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      let checks = [];
      if (locationId && supabase) {
        const { data } = await supabase.from('closed_checks')
          .select('items').eq('location_id', locationId)
          .gte('closed_at', sod.toISOString());
        checks = data || [];
      } else {
        const { closedChecks = [] } = storeState;
        checks = closedChecks.filter(c => c.closedAt && new Date(c.closedAt) >= sod);
      }
      const itemMap = {};
      checks.forEach(c => (c.items || []).forEach(i => {
        itemMap[i.name] = (itemMap[i.name] || { qty: 0, revenue: 0 });
        itemMap[i.name].qty     += (i.qty || 1);
        itemMap[i.name].revenue += (i.price || 0) * (i.qty || 1);
      }));
      const top = Object.entries(itemMap)
        .sort((a, b) => b[1].qty - a[1].qty)
        .slice(0, limit)
        .map(([name, data]) => ({ name, qty: data.qty, revenue: `${money(data.revenue)}` }));
      return { result: { period: 'today', items: top } };
    }

    case 'get_printer_status': {
      if (!supabase || !locationId) return { result: { error: 'Not connected' } };
      const [{ data: health }, { data: agents }] = await Promise.all([
        supabase.from('printer_health').select('*').eq('location_id', locationId),
        supabase.from('printer_agents').select('*').eq('location_id', locationId),
      ]);
      const now = Date.now();
      const printers = (health || []).map(h => ({
        printer_id:   h.printer_id,
        status:       h.status,
        last_success: h.last_success_at ? `${Math.round((now - new Date(h.last_success_at)) / 60000)}min ago` : 'never',
        last_error:   h.last_error || null,
        failures:     h.consecutive_failures || 0,
      }));
      const agent = agents?.[0];
      const agentStatus = agent
        ? { hostname: agent.hostname, last_seen: `${Math.round((now - new Date(agent.last_seen)) / 1000)}s ago`, status: agent.status }
        : { status: 'not detected — is the print agent running?' };
      return { result: { printers, agent: agentStatus } };
    }

    case 'get_allergen_info': {
      const { menuItems = [] } = storeState;
      const query = toolInput.item_name?.toLowerCase() || '';
      const item = menuItems.find(i => i.name?.toLowerCase().includes(query));
      if (!item) return { result: { error: `No menu item found matching "${toolInput.item_name}"` } };
      return {
        result: {
          name:      item.name,
          allergens: item.allergens?.length ? item.allergens.join(', ') : 'None declared',
          contains:  item.allergens || [],
        },
      };
    }

    case 'get_floor_status': {
      const { tables = [] } = storeState;
      const occupied  = tables.filter(t => t.session?.items?.length > 0).length;
      const seated    = tables.filter(t => t.session && !t.session.items?.length).length;
      const available = tables.length - occupied - seated;
      return {
        result: { total_tables: tables.length, occupied, seated_no_order: seated, available },
      };
    }

    case 'get_open_tables': {
      const { tables = [] } = storeState;
      const now = Date.now();
      const open = tables
        .filter(t => t.session)
        .map(t => {
          const s = t.session;
          const subtotal = (s.items || []).filter(i => !i.voided).reduce((sum, i) => sum + (i.price || 0) * (i.qty || 1), 0);
          const seatedMins = s.seatedAt ? Math.round((now - s.seatedAt) / 60000) : null;
          return {
            table: t.label,
            covers: s.covers || 0,
            server: s.server || 'unassigned',
            items: (s.items || []).filter(i => !i.voided).length,
            subtotal: `${money(subtotal)}`,
            seated_mins: seatedMins,
            seated_for: seatedMins != null ? `${Math.floor(seatedMins / 60) > 0 ? Math.floor(seatedMins / 60) + 'h ' : ''}${seatedMins % 60}m` : 'unknown',
          };
        })
        .sort((a, b) => (b.seated_mins || 0) - (a.seated_mins || 0));
      return { result: { open_count: open.length, tables: open } };
    }

    case 'search_item_sales': {
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      const query = (toolInput.query || '').toLowerCase();
      let checks = [];
      if (locationId && supabase) {
        const { data } = await supabase.from('closed_checks')
          .select('items').eq('location_id', locationId)
          .gte('closed_at', sod.toISOString());
        checks = data || [];
      } else {
        checks = (storeState.closedChecks || []).filter(c => c.closedAt && new Date(c.closedAt) >= sod);
      }
      const matches = {};
      checks.forEach(c => (c.items || []).forEach(i => {
        if ((i.name || '').toLowerCase().includes(query)) {
          const key = i.name;
          matches[key] = matches[key] || { qty: 0, revenue: 0 };
          matches[key].qty     += (i.qty || 1);
          matches[key].revenue += (i.price || 0) * (i.qty || 1);
        }
      }));
      const results = Object.entries(matches)
        .sort((a, b) => b[1].qty - a[1].qty)
        .map(([name, d]) => ({ name, qty_sold: d.qty, revenue: `${money(d.revenue)}` }));
      const totalQty = results.reduce((s, r) => s + r.qty_sold, 0);
      const totalRev = results.reduce((s, r) => s + parseFloat(r.revenue.slice(1)), 0);
      if (!results.length) return { result: { found: false, query, message: `No sales found for "${toolInput.query}" today` } };
      return { result: { query: toolInput.query, found: true, total_sold: totalQty, total_revenue: `${money(totalRev)}`, breakdown: results } };
    }

    case 'get_hourly_breakdown': {
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      let checks = [];
      if (locationId && supabase) {
        const { data } = await supabase.from('closed_checks')
          .select('total, covers, closed_at').eq('location_id', locationId)
          .gte('closed_at', sod.toISOString()).order('closed_at');
        checks = data || [];
      } else {
        checks = (storeState.closedChecks || []).filter(c => c.closedAt && new Date(c.closedAt) >= sod);
      }
      const hourMap = {};
      checks.forEach(c => {
        const ts = c.closed_at || (c.closedAt ? new Date(c.closedAt).toISOString() : null);
        if (!ts) return;
        const h = new Date(ts).getHours();
        const label = `${h.toString().padStart(2,'0')}:00`;
        hourMap[label] = hourMap[label] || { checks: 0, revenue: 0, covers: 0 };
        hourMap[label].checks++;
        hourMap[label].revenue += c.total || 0;
        hourMap[label].covers  += c.covers || 1;
      });
      const hours = Object.entries(hourMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([hour, d]) => ({ hour, checks: d.checks, covers: d.covers, revenue: `${money(d.revenue)}` }));
      const peak = hours.length ? hours.reduce((a, b) => parseFloat(b.revenue.slice(1)) > parseFloat(a.revenue.slice(1)) ? b : a) : null;
      return { result: { hours, peak_hour: peak?.hour || 'n/a', peak_revenue: peak?.revenue || '£0.00' } };
    }

    case 'get_payment_breakdown': {
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      let checks = [];
      if (locationId && supabase) {
        const { data } = await supabase.from('closed_checks')
          .select('total, method, tip, covers').eq('location_id', locationId)
          .gte('closed_at', sod.toISOString());
        checks = data || [];
      } else {
        checks = (storeState.closedChecks || []).filter(c => c.closedAt && new Date(c.closedAt) >= sod);
      }
      const byMethod = {};
      checks.forEach(c => {
        const m = c.method || c.payment_method || 'unknown';
        byMethod[m] = byMethod[m] || { count: 0, total: 0, tips: 0 };
        byMethod[m].count++;
        byMethod[m].total += c.total || 0;
        byMethod[m].tips  += c.tip || 0;
      });
      const breakdown = Object.entries(byMethod).map(([method, d]) => ({
        method, checks: d.count,
        revenue: `${money(d.total)}`,
        tips: d.tips > 0 ? `${money(d.tips)}` : null,
        avg_check: `${money((d.total / d.count))}`,
      }));
      const totalTips = checks.reduce((s, c) => s + (c.tip || 0), 0);
      return { result: { breakdown, total_tips: `${money(totalTips)}` } };
    }

    case 'get_server_performance': {
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      let checks = [];
      if (locationId && supabase) {
        const { data } = await supabase.from('closed_checks')
          .select('total, covers, server').eq('location_id', locationId)
          .gte('closed_at', sod.toISOString());
        checks = data || [];
      } else {
        checks = (storeState.closedChecks || []).filter(c => c.closedAt && new Date(c.closedAt) >= sod);
      }
      const serverMap = {};
      checks.forEach(c => {
        const name = c.server || 'Unknown';
        serverMap[name] = serverMap[name] || { checks: 0, covers: 0, revenue: 0 };
        serverMap[name].checks++;
        serverMap[name].covers  += c.covers || 1;
        serverMap[name].revenue += c.total  || 0;
      });
      const servers = Object.entries(serverMap)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .map(([name, d]) => ({
          server: name, checks: d.checks, covers: d.covers,
          revenue: `${money(d.revenue)}`,
          avg_check: `${money((d.revenue / d.checks))}`,
        }));
      return { result: { servers } };
    }

    case 'get_covers_report': {
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      let checks = [];
      if (locationId && supabase) {
        const { data } = await supabase.from('closed_checks')
          .select('covers, server, closed_at').eq('location_id', locationId)
          .gte('closed_at', sod.toISOString());
        checks = data || [];
      } else {
        checks = (storeState.closedChecks || []).filter(c => c.closedAt && new Date(c.closedAt) >= sod);
      }
      const totalCovers = checks.reduce((s, c) => s + (c.covers || 1), 0);
      const byServer = {};
      const byHour = {};
      checks.forEach(c => {
        const name = c.server || 'Unknown';
        byServer[name] = (byServer[name] || 0) + (c.covers || 1);
        const ts = c.closed_at || (c.closedAt ? new Date(c.closedAt).toISOString() : null);
        if (ts) {
          const h = `${new Date(ts).getHours().toString().padStart(2,'0')}:00`;
          byHour[h] = (byHour[h] || 0) + (c.covers || 1);
        }
      });
      return {
        result: {
          total_covers: totalCovers,
          by_server: Object.entries(byServer).sort((a,b)=>b[1]-a[1]).map(([s,c])=>({ server:s, covers:c })),
          by_hour: Object.entries(byHour).sort((a,b)=>a[0].localeCompare(b[0])).map(([h,c])=>({ hour:h, covers:c })),
        },
      };
    }

    case 'get_shift_summary': {
      const { tables = [] } = storeState;
      const sod = new Date(); sod.setHours(0, 0, 0, 0);
      let checks = [];
      if (locationId && supabase) {
        const { data } = await supabase.from('closed_checks')
          .select('total, covers, method, items, tip').eq('location_id', locationId)
          .gte('closed_at', sod.toISOString());
        checks = data || [];
      } else {
        checks = (storeState.closedChecks || []).filter(c => c.closedAt && new Date(c.closedAt) >= sod);
      }
      const revenue = checks.reduce((s, c) => s + (c.total || 0), 0);
      const covers  = checks.reduce((s, c) => s + (c.covers || 1), 0);
      const occupied = tables.filter(t => t.session?.items?.length > 0).length;
      const onFloor  = tables.filter(t => t.session?.items?.length > 0)
        .reduce((s, t) => s + (t.session?.items?.filter(i=>!i.voided).reduce((x,i)=>x+(i.price||0)*(i.qty||1),0)||0), 0);
      const itemMap = {};
      checks.forEach(c => (c.items || []).forEach(i => {
        itemMap[i.name] = (itemMap[i.name] || 0) + (i.qty || 1);
      }));
      const topItem = Object.entries(itemMap).sort((a,b)=>b[1]-a[1])[0];
      return {
        result: {
          closed_checks: checks.length,
          revenue: `${money(revenue)}`,
          covers_done: covers,
          avg_check: checks.length ? `${money((revenue/checks.length))}` : '£0.00',
          open_tables: occupied,
          revenue_on_floor: `${money(onFloor)}`,
          top_item_today: topItem ? `${topItem[0]} (${topItem[1]} sold)` : 'none',
        },
      };
    }

    case 'get_item_detail': {
      const { menuItems = [], menuCategories = [], modifierGroupDefs = [] } = storeState;
      const query = (toolInput.item_name || '').toLowerCase();
      const matches = menuItems.filter(i => !i.archived && (i.name || '').toLowerCase().includes(query));
      if (!matches.length) return { result: { found: false, message: `No item found matching "${toolInput.item_name}"` } };
      return {
        result: {
          found: true,
          items: matches.slice(0, 3).map(i => {
            const cat = menuCategories.find(c => c.id === (i.cat || i.categoryId));
            const mods = (i.assignedModifierGroups || []).map(mg => {
              const group = modifierGroupDefs.find(g => g.id === (mg.groupId || mg));
              return group ? group.name : mg.groupId || mg;
            });
            return {
              name: i.name,
              price: `${money((i.price || 0))}`,
              category: cat?.label || cat?.name || 'Unknown',
              description: i.description || null,
              allergens: i.allergens?.length ? i.allergens.join(', ') : 'None declared',
              modifiers: mods.length ? mods.join(', ') : 'None',
            };
          }),
        },
      };
    }

    case 'get_menu_items': {
      const { menuItems = [], menuCategories = [] } = storeState;
      const catFilter = toolInput.category?.toLowerCase();
      let items = menuItems.filter(i => !i.archived);
      if (catFilter) {
        const cat = menuCategories.find(c =>
          c.name?.toLowerCase().includes(catFilter) ||
          c.label?.toLowerCase().includes(catFilter)
        );
        if (cat) items = items.filter(i => i.cat === cat.id || i.categoryId === cat.id);
      }
      return {
        result: {
          count: items.length,
          items: items.slice(0, 50).map(i => {
            const cat = menuCategories.find(c => c.id === (i.cat || i.categoryId));
            return {
              id:       i.id,
              name:     i.name,
              price:    `${money((i.price || 0))}`,
              category: cat?.name || cat?.label || 'Unknown',
            };
          }),
        },
      };
    }

    case 'get_order_history': {
      if (!supabase || !locationId) return { result: { error: 'Not connected' } };
      const limit = Math.min(toolInput.limit || 10, 50);
      const { data } = await supabase
        .from('closed_checks')
        .select('id, total, covers, method, closed_at, tip')
        .eq('location_id', locationId)
        .order('closed_at', { ascending: false })
        .limit(limit);
      const orders = (data || []).map(o => ({
        id:     o.id?.slice(0, 8),
        total:  `${money((o.total || 0))}`,
        covers: o.covers,
        method: o.method,
        tip:    o.tip ? `${money(o.tip)}` : null,
        time:   o.closed_at ? new Date(o.closed_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '?',
      }));
      return { result: { orders } };
    }

    // ── v5.5.735: broad read tools — 86 / stock / kitchen queue / activity / waitlist / menu ──

    case 'get_86_status': {
      const { eightySixIds = [], menuItems = [], dailyCounts = {} } = storeState;
      const byId = new Map(menuItems.map(i => [i.id, i]));
      const whenMap = {};   // id -> created_at (when it went 86)
      const nameMap = {};   // id -> name, for 86'd ids missing from the loaded menu (e.g. archived)
      if (supabase && locationId) {
        const { data } = await supabase.from('eighty_six').select('item_id, created_at').eq('location_id', locationId);
        (data || []).forEach(r => { whenMap[r.item_id] = r.created_at; });
        // An item can be 86'd then archived — it stays in eighty_six but drops out of menuItems
        // (fetchMenuItems filters archived=false). Resolve those names so we never misreport it.
        const missing = eightySixIds.filter(id => !byId.has(id));
        if (missing.length) {
          const { data: mi } = await supabase.from('menu_items').select('id, name').in('id', missing);
          (mi || []).forEach(r => { nameMap[r.id] = r.name; });
        }
      }
      const nameOf = (id) => byId.get(id)?.name || nameMap[id] || null;
      // Build the FULL 86 list first — a genuinely-86'd id is never dropped, even if unnamed.
      const full = eightySixIds.map(id => ({
        item: nameOf(id) || `Item ${String(id).slice(0, 8)}`,
        since: whenMap[id] ? new Date(whenMap[id]).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : null,
        stock_remaining: dailyCounts[id] ? dailyCounts[id].remaining : null,
      }));
      const q = (toolInput.item_name || '').toLowerCase();
      if (q) {
        const matched = full.filter(x => (x.item || '').toLowerCase().includes(q));
        if (matched.length) return { result: { count: matched.length, eighty_sixed: matched } };
        // No 86'd item matches the name. Only claim "available" if a KNOWN item by that name exists.
        const known = menuItems.find(i => (i.name || '').toLowerCase().includes(q));
        if (known) return { result: { count: 0, eighty_sixed: [], note: `"${known.name}" is NOT currently 86'd (it's available).` } };
        return {
          result: {
            count: 0, eighty_sixed: [],
            note: full.length
              ? `No 86'd item matches "${toolInput.item_name}", but ${full.length} item(s) are 86'd — try search_activity (kind:'stock') for the history.`
              : `No item matching "${toolInput.item_name}", and nothing is currently 86'd.`,
          },
        };
      }
      return { result: { count: full.length, eighty_sixed: full } };
    }

    case 'get_stock_status': {
      const { dailyCounts = {}, menuItems = [], eightySixIds = [] } = storeState;
      const byId = new Map(menuItems.map(i => [i.id, i]));
      const q = (toolInput.item_name || '').toLowerCase();
      let entries = Object.entries(dailyCounts);
      if (q) entries = entries.filter(([id]) => (byId.get(id)?.name || '').toLowerCase().includes(q));
      const rows = entries.map(([id, c]) => {
        const par = c?.par || 0, rem = c?.remaining ?? 0;
        const status = eightySixIds.includes(id) ? '86 (turned off)' : (rem <= 0 ? 'out' : (rem <= Math.max(1, par * 0.2) ? 'low' : 'ok'));
        return { item: byId.get(id)?.name || String(id), remaining: rem, par, status };
      });
      const flagged = rows.filter(r => r.status !== 'ok');
      return { result: { tracked_items: rows.length, low_or_out: q ? rows : flagged, note: rows.length ? undefined : 'No items have daily stock counts set.' } };
    }

    case 'lookup_item': {
      const { menuItems = [], menuCategories = [], modifierGroupDefs = [], eightySixIds = [], dailyCounts = {} } = storeState;
      const q = (toolInput.item_name || '').toLowerCase();
      const matches = menuItems.filter(i => !i.archived && i.type !== 'spacer' && (i.name || '').toLowerCase().includes(q));
      if (!matches.length) return { result: { found: false, message: `No item matching "${toolInput.item_name}"` } };
      return {
        result: {
          found: true,
          items: matches.slice(0, 5).map(i => {
            const cat = menuCategories.find(c => c.id === (i.cat || i.categoryId));
            const variants = menuItems.filter(v => v.parentId === i.id && !v.archived)
              .map(v => ({ name: v.name, price: money(v.price || 0), sold_out: eightySixIds.includes(v.id) }));
            const mods = (i.assignedModifierGroups || [])
              .map(mg => modifierGroupDefs.find(g => g.id === (mg.groupId || mg))?.name).filter(Boolean);
            const dc = dailyCounts[i.id];
            return {
              name: i.name,
              price: money(i.price || 0),
              category: cat?.label || cat?.name || 'Unknown',
              allergens: i.allergens?.length ? i.allergens.join(', ') : 'None declared',
              sold_out_86: eightySixIds.includes(i.id),
              stock_remaining: dc ? dc.remaining : null,
              ...(variants.length ? { variants } : {}),
              ...(mods.length ? { modifiers: mods.join(', ') } : {}),
            };
          }),
        },
      };
    }

    case 'get_order_queue': {
      let rows = [];
      if (supabase && locationId) {
        const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
        const { data } = await supabase.from('order_queue')
          .select('ref, source, status, total, customer, created_at')
          .eq('location_id', locationId).gte('created_at', since)
          .order('created_at', { ascending: false }).limit(60);
        rows = data || [];
      } else {
        rows = (storeState.orderQueue || []).map(o => ({ ref: o.ref, source: o.source, status: o.status, total: o.total, customer: o.customer, created_at: o.createdAt || o.sentAt }));
      }
      const done = new Set(['collected', 'completed', 'cancelled', 'delivered', 'refunded']);
      const active = rows.filter(o => !done.has((o.status || '').toLowerCase()));
      const byStatus = {};
      active.forEach(o => { const k = o.status || 'pending'; byStatus[k] = (byStatus[k] || 0) + 1; });
      return {
        result: {
          active: active.length,
          by_status: byStatus,
          orders: active.slice(0, 30).map(o => ({
            ref: o.ref, source: o.source, status: o.status,
            total: o.total != null ? money(o.total) : null,
            customer: o.customer?.name || o.customer?.firstName || null,
            time: o.created_at ? new Date(o.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null,
          })),
        },
      };
    }

    case 'search_activity': {
      if (!supabase || !locationId) return { result: { error: 'Not connected' } };
      const hours = Math.min(Math.max(toolInput.hours_back || 24, 1), 168);
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      let qb = supabase.from('activity_events')
        .select('kind, severity, title, body, actor_name, created_at')
        .eq('location_id', locationId).gte('created_at', since)
        .order('created_at', { ascending: false }).limit(80);
      if (toolInput.kind) qb = qb.eq('kind', toolInput.kind);
      const { data } = await qb;
      let rows = data || [];
      const q = (toolInput.query || '').toLowerCase();
      if (q) rows = rows.filter(r => (r.title || '').toLowerCase().includes(q) || (r.body || '').toLowerCase().includes(q));
      return {
        result: {
          count: rows.length,
          events: rows.slice(0, 40).map(r => ({
            kind: r.kind, what: r.title,
            ...(r.body ? { detail: r.body } : {}),
            ...(r.actor_name ? { by: r.actor_name } : {}),
            when: r.created_at ? new Date(r.created_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : null,
          })),
        },
      };
    }

    case 'get_waitlist': {
      const done = new Set(['seated', 'completed', 'cancelled', 'left', 'no_show']);
      const wl = (storeState.waitlist || []).filter(w => !done.has((w.status || '').toLowerCase()));
      return {
        result: {
          waiting: wl.length,
          parties: wl.slice(0, 30).map(w => ({
            name: w.name, size: w.size ?? w.partySize,
            quoted_min: w.quoted ?? w.quotedMinutes,
            status: w.status,
            since: w.addedAt ? new Date(w.addedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : undefined,
          })),
        },
      };
    }

    case 'get_menu_overview': {
      const { menuCategories = [], menuItems = [], eightySixIds = [] } = storeState;
      const live = menuItems.filter(i => !i.archived && i.type !== 'spacer');
      const cats = menuCategories.filter(c => !c.parentId && !c.isSpecial)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
        .map(c => {
          const items = live.filter(i => i.cat === c.id || i.categoryId === c.id);
          return { category: c.label || c.name, items: items.length, sold_out: items.filter(i => eightySixIds.includes(i.id)).length };
        });
      return { result: { categories: cats, total_items: live.length, total_86: eightySixIds.length } };
    }

    // ── Write tools — return pendingAction, don't execute yet ──────────────────

    case 'add_menu_item': {
      const { menuCategories = [] } = storeState;
      const cat = menuCategories.find(c => c.id === toolInput.category_id);
      return {
        result: {
          preview: true,
          message: `Proposed new item — awaiting your confirmation`,
          item: {
            name:     toolInput.name,
            price:    `${money(Number(toolInput.price))}`,
            category: cat?.name || toolInput.category_id,
          },
        },
        pendingAction: {
          type:    'add_menu_item',
          label:   `Add "${toolInput.name}" at ${money(Number(toolInput.price))} to ${cat?.name || 'menu'}`,
          payload: toolInput,
        },
      };
    }

    case 'update_item_price': {
      const { menuItems = [] } = storeState;
      const item = menuItems.find(i => i.id === toolInput.item_id);
      const oldPrice = item ? `${money((item.price || 0))}` : 'unknown';
      return {
        result: {
          preview: true,
          message: `Proposed price change — awaiting your confirmation`,
          change: {
            item:      toolInput.item_name || item?.name || toolInput.item_id,
            old_price: oldPrice,
            new_price: `${money(Number(toolInput.new_price))}`,
          },
        },
        pendingAction: {
          type:    'update_item_price',
          label:   `Change ${item?.name || toolInput.item_id} from ${oldPrice} to ${money(Number(toolInput.new_price))}`,
          payload: toolInput,
        },
      };
    }

    case 'eighty_six_item': {
      return {
        result: {
          preview: true,
          message: `Proposed 86 — awaiting your confirmation`,
          item: toolInput.item_name || toolInput.item_id,
        },
        pendingAction: {
          type:    'eighty_six_item',
          label:   `86 "${toolInput.item_name || toolInput.item_id}" — mark as sold out`,
          payload: toolInput,
        },
      };
    }

    case 'get_current_order': {
      const { tables = [], activeTableId, walkInOrder } = storeState;
      const activeTable = tables.find(t => t.id === activeTableId);
      const session = activeTableId ? activeTable?.session : walkInOrder;
      const items = (session?.items || []).filter(i => !i.voided);
      if (!items.length) {
        return { result: { active: false, message: 'No active order open. Open a table or start a new order on the POS first.' } };
      }
      const subtotal = items.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
      return {
        result: {
          active: true,
          table: activeTable?.label || (activeTableId ? activeTableId : 'Walk-in'),
          covers: session?.covers || 0,
          item_count: items.length,
          items: items.map(i => ({ uid: i.uid, name: i.name, qty: i.qty, price: `${money((i.price||0))}`, notes: i.notes || null })),
          subtotal: `${money(subtotal)}`,
        },
      };
    }

    case 'remove_from_order': {
      const { menuItems = [], tables = [], activeTableId, walkInOrder } = storeState;
      const activeTable = tables.find(t => t.id === activeTableId);
      const session = activeTableId ? activeTable?.session : walkInOrder;
      const items = (session?.items || []).filter(i => !i.voided);
      const query = (toolInput.item_name || '').toLowerCase();
      const match = items.find(i => i.name?.toLowerCase().includes(query));
      if (!match) return { result: { found: false, message: `"${toolInput.item_name}" not found in the current order.` } };
      return {
        result: {
          preview: true,
          message: `Proposed removal — awaiting your confirmation`,
          item: match.name, qty: toolInput.qty || 1,
          reason: toolInput.reason || null,
        },
        pendingAction: {
          type: 'remove_from_order',
          label: `Remove ${toolInput.qty || 1}× ${match.name} from order${toolInput.reason ? ` (${toolInput.reason})` : ''}`,
          payload: { ...toolInput, item_uid: match.uid, item_id: match.id },
        },
      };
    }

    case 'add_to_order': {
      const { menuItems = [], tables = [], activeTableId } = storeState;
      const activeTable = tables.find(t => t.id === activeTableId);
      if (!activeTableId) {
        return { result: { error: 'No active order — staff must open a table or start an order on the POS first.' } };
      }
      const query = toolInput.item_name?.toLowerCase().trim() || '';
      const available = menuItems.filter(i => !i.archived);
      const item = available.find(i => i.name?.toLowerCase() === query)
                || available.find(i => i.name?.toLowerCase().includes(query))
                || available.find(i => query.includes(i.name?.toLowerCase()));
      if (!item) {
        const names = available.slice(0, 20).map(i => i.name).join(', ');
        return { result: { error: `No menu item found matching "${toolInput.item_name}". Available items include: ${names}` } };
      }
      const qty = toolInput.qty || 1;
      return {
        result: {
          preview: true,
          message: 'Proposed order addition — awaiting confirmation',
          item: { name: item.name, price: `${money(item.price)}`, qty, notes: toolInput.notes || null },
          table: activeTable?.label || activeTableId,
          total: `${money((item.price * qty))}`,
        },
        pendingAction: {
          type:  'add_to_order',
          label: `Add ${qty}× ${item.name} (${money(item.price)}) to ${activeTable?.label || 'current order'}${toolInput.notes ? ` — note: "${toolInput.notes}"` : ''}`,
          payload: { item, qty, notes: toolInput.notes || '' },
        },
      };
    }

    case 'apply_order_discount': {
      const { tables = [], activeTableId } = storeState;
      const activeTable = tables.find(t => t.id === activeTableId);
      if (!activeTableId) {
        return { result: { error: 'No active order open.' } };
      }
      const display = toolInput.type === 'percent'
        ? `${toolInput.value}% off`
        : `${money(Number(toolInput.value))} off`;
      return {
        result: {
          preview: true,
          message: 'Proposed discount — awaiting confirmation',
          discount: display,
          reason: toolInput.reason,
          table: activeTable?.label || activeTableId,
        },
        pendingAction: {
          type:  'apply_order_discount',
          label: `Apply ${display} to ${activeTable?.label || 'current order'} — reason: ${toolInput.reason}`,
          payload: { ...toolInput, tableId: activeTableId },
        },
      };
    }

    default:
      return { result: { error: `Unknown tool: ${toolName}` } };
  }
}

/**
 * Execute a confirmed write action.
 * Only called after the user explicitly confirms.
 */
export async function executeConfirmedAction(action, storeActions = {}) {
  const { type, payload } = action;

  switch (type) {
    case 'add_menu_item': {
      const { addMenuItem } = storeActions;
      if (!addMenuItem) return { ok: false, error: 'Not available' };
      const newItem = {
        id:         `item-ai-${Date.now()}`,
        name:       payload.name,
        price:      Number(payload.price),
        categoryId: payload.category_id,
        description: payload.description || '',
        allergens:  [],
        archived:   false,
      };
      const created = await addMenuItem(newItem);
      // v5.5.797: duplicate-name guard — the store refuses a live top-level
      // product whose name matches an existing one (returns null).
      if (!created) return { ok: false, error: `A product called "${payload.name}" already exists` };
      return { ok: true, message: `"${payload.name}" added to the menu at ${money(Number(payload.price))}` };
    }

    case 'update_item_price': {
      const { updateMenuItem } = storeActions;
      if (!updateMenuItem) return { ok: false, error: 'Not available' };
      await updateMenuItem(payload.item_id, { price: Number(payload.new_price) });
      return { ok: true, message: `Price updated to ${money(Number(payload.new_price))}` };
    }

    case 'eighty_six_item': {
      const { toggle86 } = storeActions;
      if (!toggle86) return { ok: false, error: 'Not available' };
      toggle86(payload.item_id);
      return { ok: true, message: `"${payload.item_name}" has been 86'd` };
    }

    case 'add_to_order': {
      const { addItem } = storeActions;
      if (!addItem) return { ok: false, error: 'Not available' };
      addItem(payload.item, [], null, { qty: payload.qty || 1, notes: payload.notes || '' });
      return { ok: true, message: `${payload.qty || 1}× ${payload.item.name} added to the order` };
    }

    case 'remove_from_order': {
      const { voidItem, activeTableId } = storeActions;
      if (!voidItem) return { ok: false, error: 'Not available' };
      voidItem(payload.item_uid, activeTableId);
      return { ok: true, message: `${payload.item_name || 'Item'} removed from the order` };
    }

    case 'apply_order_discount': {
      const { applyDiscount } = storeActions;
      if (!applyDiscount) return { ok: false, error: 'Discount not available' };
      applyDiscount({ type: payload.type, value: payload.value, reason: payload.reason, tableId: payload.tableId });
      const display = payload.type === 'percent' ? `${payload.value}%` : `${money(Number(payload.value))}`;
      return { ok: true, message: `${display} discount applied — ${payload.reason}` };
    }

    default:
      return { ok: false, error: 'Unknown action type' };
  }
}
