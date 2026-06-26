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
export const getDeliveryDetail = (opsLocationId, { id, orderRef } = {}) => call('get_delivery_detail', { ops_location_id: opsLocationId, id, order_ref: orderRef });

// Per-location Stuart account: connect this venue's OWN Stuart credentials (verified server-side
// before saving; the secret is never returned), test the connection, or disconnect.
export const setStuartCreds = (opsLocationId, { clientId, clientSecret, env } = {}) =>
  call('set_stuart_creds', { ops_location_id: opsLocationId, client_id: clientId, client_secret: clientSecret, env });
export const testStuart = (opsLocationId) => call('test_stuart', { ops_location_id: opsLocationId });
export const disconnectStuart = (opsLocationId) => call('disconnect_stuart', { ops_location_id: opsLocationId });

// Platform onboarding (Organizations API): create a per-venue Uber Direct sub-org (returns its
// customer_id), check its status, and (re)invite the merchant to manage their own org.
// Parked: Uber Direct is gated in the UK; the Delivery screen uses Stuart. Kept for when an
// Uber Direct partnership lands. Not surfaced in the BO.
export const onboardVenueOrg = (opsLocationId, info = {}) => call('onboard_org', { ops_location_id: opsLocationId, ...info });
export const getVenueOrgStatus = (opsLocationId) => call('org_status', { ops_location_id: opsLocationId });
export const inviteVenueOrgMember = (opsLocationId, email, role) => call('invite_org_member', { ops_location_id: opsLocationId, email, role });
export const cancelDelivery = (opsLocationId, deliveryRowId) => call('cancel_delivery', { ops_location_id: opsLocationId, delivery_row_id: deliveryRowId });
export const deliveryReport = (opsLocationId, since) => call('delivery_report', { ops_location_id: opsLocationId, since });
