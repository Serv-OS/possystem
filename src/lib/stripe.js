import { stripeCurrency } from './currency.js';
/**
 * stripe.js — Stripe Terminal integration scaffold
 *
 * In mock mode: simulates terminal discovery and payment completion.
 * In production: uses Stripe Terminal JS SDK via the Sunmi Android WebView bridge.
 *
 * Architecture:
 *   1. App requests a connection token from your backend (POST /api/stripe/token)
 *   2. Stripe Terminal SDK connects to a physical reader
 *   3. Payment intent created on backend (POST /api/stripe/payment-intent)
 *   4. Terminal collects payment → confirms payment intent
 *   5. Result returned to POS for receipt
 *
 * Sunmi hardware: The T2s, T3 Pro, and V2s all support Stripe Terminal via
 * the Sunmi native payment bridge. The NT311 printer handles receipts.
 */

const isMock = import.meta.env.VITE_USE_MOCK !== 'false' || !import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;

// ── Mock terminal ─────────────────────────────────────────────────────────────
const MOCK_READERS = [
  { id:'mock-reader-1', label:'Sunmi T2s Counter', status:'online',  serialNumber:'STPE-1234', location:'loc-demo' },
  { id:'mock-reader-2', label:'Sunmi V2s Handheld', status:'online', serialNumber:'STPE-5678', location:'loc-demo' },
];

let _connectedReader = null;
let _terminal = null;

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Initialise Stripe Terminal. Must be called before any other function.
 * In production: loads the Stripe Terminal JS SDK and creates a terminal instance.
 */
export async function initStripeTerminal() {
  if (isMock) {
    console.info('[Stripe Terminal] Mock mode — using simulated readers');
    return { ok: true, mock: true };
  }
  try {
    // In production, load the Stripe Terminal JS SDK
    // This would be loaded via: <script src="https://js.stripe.com/terminal/v1/"></script>
    if (!window.StripeTerminal) {
      throw new Error('Stripe Terminal SDK not loaded. Add the script tag to index.html.');
    }
    _terminal = window.StripeTerminal.create({
      onFetchConnectionToken: fetchConnectionToken,
      onUnexpectedReaderDisconnect: () => {
        console.warn('[Stripe Terminal] Reader disconnected unexpectedly');
        _connectedReader = null;
      },
    });
    return { ok: true, mock: false };
  } catch (err) {
    console.error('[Stripe Terminal] Init failed:', err);
    return { ok: false, error: err.message };
  }
}

/**
 * Discover nearby Stripe Terminal readers.
 */
export async function discoverReaders() {
  if (isMock) {
    await delay(800);
    return { readers: MOCK_READERS, error: null };
  }
  try {
    const { discoveredReaders, error } = await _terminal.discoverReaders({ simulated: false });
    if (error) return { readers: [], error: error.message };
    return { readers: discoveredReaders, error: null };
  } catch (err) {
    return { readers: [], error: err.message };
  }
}

/**
 * Connect to a specific reader.
 */
export async function connectReader(readerId) {
  if (isMock) {
    await delay(600);
    const reader = MOCK_READERS.find(r => r.id === readerId);
    if (!reader) return { ok: false, error: 'Reader not found' };
    _connectedReader = reader;
    return { ok: true, reader };
  }
  try {
    const reader = { id: readerId }; // in production, comes from discoverReaders
    const { error } = await _terminal.connectReader(reader);
    if (error) return { ok: false, error: error.message };
    _connectedReader = reader;
    return { ok: true, reader };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Collect a card payment for a given amount.
 * @param {number} amountPence - Amount in pence (e.g. 1450 for £14.50)
 * @param {Object} metadata - Order ref, table, server, etc.
 */
export async function collectPayment(amountPence, metadata = {}) {
  if (isMock) {
    // Simulate the card tap / insert / swipe flow
    await delay(400);  // reader blinks
    await delay(1200); // card presented
    await delay(600);  // processing
    // 95% success rate in mock mode
    if (Math.random() < 0.05) return { ok: false, error: 'Card declined — mock failure (5% rate)', declined: true };
    const last4 = String(Math.floor(1000 + Math.random() * 9000));
    return {
      ok: true,
      paymentIntentId: `pi_mock_${Date.now()}`,
      amount: amountPence,
      currency: stripeCurrency(),
      card: { last4, brand:'visa', expMonth:12, expYear:2027 },
      receiptUrl: null,
      mock: true,
    };
  }

  try {
    if (!_connectedReader) return { ok: false, error: 'No reader connected' };

    // Step 1: Create payment intent on backend
    const intentRes = await fetch('/api/stripe/payment-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountPence, currency: stripeCurrency(), metadata }),
    });
    const { clientSecret, error: intentError } = await intentRes.json();
    if (intentError) return { ok: false, error: intentError };

    // Step 2: Collect payment method on terminal
    const { error: collectError } = await _terminal.collectPaymentMethod(clientSecret);
    if (collectError) return { ok: false, error: collectError.message };

    // Step 3: Confirm payment intent
    const { paymentIntent, error: confirmError } = await _terminal.processPayment();
    if (confirmError) {
      return { ok: false, error: confirmError.message, declined: confirmError.code === 'card_declined' };
    }

    return {
      ok: true,
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      card: paymentIntent.payment_method_details?.card_present || null,
      receiptUrl: paymentIntent.charges?.data?.[0]?.receipt_url || null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Cancel the current payment collection.
 */
export async function cancelPayment() {
  if (isMock) return { ok: true };
  try {
    await _terminal.cancelCollectPaymentMethod();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Get current reader status.
 */
export function getReaderStatus() {
  if (isMock) return { connected: true, reader: _connectedReader || MOCK_READERS[0], mock: true };
  return { connected: !!_connectedReader, reader: _connectedReader, mock: false };
}

// ── Internal helpers ──────────────────────────────────────────────────────────
async function fetchConnectionToken() {
  const res = await fetch('/api/stripe/token', { method: 'POST' });
  const { secret } = await res.json();
  return secret;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

export { isMock as isStripeSimulated };
