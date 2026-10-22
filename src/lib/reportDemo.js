// src/lib/reportDemo.js: is there demo history in a report's period? (v5.11.99, Reports align)
//
// The Back Office reports leave the demo files' checks out by the one demo rule
// (supabase/functions/_shared/demoHistory.js). When a report reads its own rows it knows what it left
// out. When a long period across sites is added up by the database (report_day_sums, which leaves the
// same checks out from 20261029a), it asks here, once: is the database's demo rule there (_sales_is_demo,
// 20261029a), then one tiny read per site, along the partial index closed_checks_demo_rp, at most one row
// each. A failed read answers false: the note is a courtesy, never a figure.

import { DEMO_NOTE } from '../../supabase/functions/_shared/demoHistory.js';

export { DEMO_NOTE };

const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : typeof v === 'number' ? new Date(v).toISOString() : String(v));

/**
 * True when any of the sites holds a demo check inside its own range.
 *   client  the Supabase client
 *   sites   [{ id, from, to }] (Dates, ms or ISO strings), each site on its own clock
 */
export async function demoChecksIn(client, sites) {
  if (!client?.from) return false;
  // Before 20261029a the database adds demo checks in, so there is nothing left out to say.
  try {
    const probe = await client.rpc('_sales_is_demo', { p_id: 'demo-' });
    if (probe?.error || probe?.data !== true) return false;
  } catch { return false; }
  const list = (sites || []).filter((s) => s && s.id && s.from != null && s.to != null);
  const answers = await Promise.all(list.map(async (s) => {
    try {
      const { data, error } = await client.from('closed_checks').select('id').eq('location_id', String(s.id))
        .like('id', 'demo-%').gte('closed_at', iso(s.from)).lte('closed_at', iso(s.to)).limit(1);
      return !error && Array.isArray(data) && data.length > 0;
    } catch { return false; }
  }));
  return answers.some(Boolean);
}
