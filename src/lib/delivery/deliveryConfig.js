/**
 * deliveryConfig.js — Back Office client wrapper for per-venue Uber Direct config.
 * Talks to the `uber-direct` edge fn (service role); creds/secrets stay server-side.
 */
import { supabase } from '../supabase.js';

async function call(action, payload) {
  if (!supabase) return { error: 'offline' };
  const { data, error } = await supabase.functions.invoke('uber-direct', { body: { action, ...payload } });
  if (error) return { error: error.message };
  return data;
}

export const getVenueUberConfig = (opsLocationId) => call('get_config', { ops_location_id: opsLocationId });
export const setVenueUberConfig = (opsLocationId, patch) => call('set_config', { ops_location_id: opsLocationId, patch });
export const listDeliveries = (opsLocationId, limit = 50) => call('list_deliveries', { ops_location_id: opsLocationId, limit });
export const cancelDelivery = (opsLocationId, deliveryRowId) => call('cancel_delivery', { ops_location_id: opsLocationId, delivery_row_id: deliveryRowId });
export const deliveryReport = (opsLocationId, since) => call('delivery_report', { ops_location_id: opsLocationId, since });
