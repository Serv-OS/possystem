// purchasing/orderActions.js: the one send step the company Purchasing screens share (multi site
// stock Drop 3, v5.11.96): after the database answered `send: true` (approve, send anyway), the order
// is emailed through po-send at its own site. The answer's words are cleaned for a toast.

import { supabase } from '../../../lib/supabase';
import { fnErrorText } from '../../../lib/stock/purchasing';

export async function sendOrderEmail(poId, locationId) {
  if (!supabase) return { error: new Error('No database') };
  const { data: res, error } = await supabase.functions.invoke('po-send', { body: { po_id: poId, location_id: locationId } });
  if (!error && res?.ok) return { error: null };
  return { error: new Error(await fnErrorText(res, error, 'the email could not be sent')) };
}
