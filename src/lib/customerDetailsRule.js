/**
 * customerDetailsRule.js: what the till asks for when a customer goes on an order, by order type
 * and the venue's one customer details setting. Peter, Coffee Boy, 30 Sep 2026.
 *
 *   "Dine in users' phone and name still forced. It only turns it off for collection and
 *   takeaway. Should make it not forced under the same setting as it is now."
 *
 * The setting is locations.pos_settings.takeaway_customer_details ('full' | 'name' | 'none'),
 * kept under its old key for compatibility; the store holds it as takeawayCustomerDetails. Until
 * today it only relaxed takeaway and collection (v5.5.799) and drive thru (16 Sep 2026): the
 * dine in form ("Add customer to table") always demanded a name AND a phone. Now one rule covers
 * every till order type:
 *
 *   'full'   name and phone required (delivery also needs the address, always).
 *   'name'   a name is enough. Takeaway and collection hide the phone as before; dine in keeps
 *            it as an optional field, because a dine in customer is attached for loyalty and
 *            the returning customer search runs on the phone.
 *   'none'   nothing is asked when the order type is picked or sent. Staff can still add a
 *            customer from the button, and that form asks the same as 'name'.
 *
 * Drive thru is name only whatever the setting says (the car is at the window, there is no one
 * to phone). Delivery always takes the full form. Nothing here touches online, QR or kiosk.
 *
 * Pure, import free, so node:test can load it (customerDetailsRule.test.js).
 */

export const CUSTOMER_DETAILS_MODES = ['full', 'name', 'none'];

/** The setting as stored, or 'full' for anything unknown or missing (the safe old behaviour). */
export function customerDetailsMode(raw) {
  return CUSTOMER_DETAILS_MODES.includes(raw) ? raw : 'full';
}

/** The order types the venue setting relaxes when the type is picked or the order is sent. */
const QUICK_TYPES = ['takeaway', 'collection', 'drive-thru'];

/**
 * What the customer form shows and requires for this order type under this setting.
 *   name        always required (a customer with no name is no customer)
 *   phone       phone required
 *   phoneShown  the phone and email fields are on the form at all
 *   address     delivery address and postcode required
 */
export function customerFieldsFor({ orderType, mode } = {}) {
  const m = customerDetailsMode(mode);
  if (orderType === 'delivery') return { name: true, phone: true, phoneShown: true, address: true };
  if (orderType === 'drive-thru') return { name: true, phone: false, phoneShown: false, address: false };
  if (orderType === 'takeaway' || orderType === 'collection') {
    const full = m === 'full';
    return { name: true, phone: full, phoneShown: full, address: false };
  }
  // Dine in (and anything else the till treats like it): the phone is required only on 'full',
  // and stays on the form as optional otherwise, for the loyalty lookup.
  return { name: true, phone: m === 'full', phoneShown: true, address: false };
}

/**
 * Does picking this order type on the till open the customer form first?
 * Dine in never does (it is the type every order starts on). Delivery always does. The quick
 * types ask unless the setting is 'none'.
 */
export function promptsOnTypeChange({ orderType, mode } = {}) {
  if (orderType === 'dine-in') return false;
  if (orderType === 'delivery') return true;
  if (QUICK_TYPES.includes(orderType)) return customerDetailsMode(mode) !== 'none';
  return true;
}

/**
 * Can Send go straight through with no customer on this order?
 *   A quick type under 'none' sends with an empty name (Orders shows the short ref).
 *   A quick type or delivery that already has a name sends as well.
 *   Dine in is not decided here: it goes to the send modal (table, counter or bar tab).
 */
export function sendsWithoutPrompt({ orderType, mode, hasName } = {}) {
  if (hasName && (QUICK_TYPES.includes(orderType) || orderType === 'delivery')) return true;
  return QUICK_TYPES.includes(orderType) && customerDetailsMode(mode) === 'none';
}

/**
 * The form's own gate: is what staff typed enough to attach this customer?
 * Returns null when it is, or the plain English reason when it is not.
 */
export function customerFormProblem({ orderType, mode, name, phone, address, postcode } = {}) {
  const f = customerFieldsFor({ orderType, mode });
  const hasName = !!String(name ?? '').trim();
  const hasPhone = !!String(phone ?? '').trim();
  if (!hasName || (f.phone && !hasPhone)) return f.phone ? 'Name and phone number are required' : 'Customer name is required';
  if (f.address && (!String(address ?? '').trim() || !String(postcode ?? '').trim())) return 'Delivery address and postcode are required';
  return null;
}
