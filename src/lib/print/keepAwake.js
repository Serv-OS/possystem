// src/lib/print/keepAwake.js
//
// STOP THE PRINTER FALLING ASLEEP.
//
// Peter, 22 Sep 2026, over and over through one evening: "its just gone offline
// again!", "clicking print wakes it back up and reconnects it", "nothing has
// changed on the printer its been sat there the entire time", "this is very
// stressful when we didnt have these issues before".
//
// The behaviour he describes is a printer whose network side goes to sleep when
// nothing talks to it, and wakes on traffic. His own evidence pins it down: at
// first PING ANSWERED while port 9100 refused (the link is up, the print server
// is not listening), and later ping failed too (deeper sleep), and in both cases
// pressing print brought it back.
//
// The live record agrees that it is intermittent rather than broken: jobs needing
// a retry ran 9 of 11 on 16 Sep, 11 of 32 on 17 Sep, then ZERO of 12 on 20 Sep,
// then 2 of 17 and 4 of 9. A machine that is failing does not have perfect days.
//
// WHAT WE SEND: DLE EOT n (0x10 0x04 0x01), the ESC/POS real time status query.
// It is the standard "are you there" of this protocol: the printer answers on the
// socket and PRINTS NOTHING. No paper, no wear, no visible mark. We deliberately
// do NOT send ESC @ (initialise), which would reset the printer's settings, and
// we do not open an empty connection, because a connect with nothing in it is
// what some print servers leave half open.
//
// WHAT THIS IS NOT: a fix for a printer that is off, out of paper, or on another
// network. It only keeps a sleeping one awake.

/** ESC/POS real time status request. Prints nothing; the printer answers on the socket. */
export const STATUS_QUERY_BYTES = Object.freeze([0x10, 0x04, 0x01]);

/** How often to knock. Under every sleep timer we have seen, and cheap. */
export const KEEP_AWAKE_MS = 120_000;

/** Spread so two tills in one venue rarely knock at the same moment. */
export const JITTER_MS = 20_000;

/** The same bytes, base64, which is what the Android bridge takes. */
export function statusQueryBase64() {
  const bytes = Uint8Array.from(STATUS_QUERY_BYTES);
  if (typeof btoa === 'function') {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }
  // node, for the tests
  return Buffer.from(bytes).toString('base64');
}

/**
 * Should this device knock on this printer now?
 *
 * No, if anything printed recently: a real job already woke it, and the quietest
 * keep alive is the one that does not happen.
 *
 * @param {{ lastContactAt?: number|null, now?: number, everyMs?: number, enabled?: boolean }} o
 */
export function shouldKnock({ lastContactAt = null, now = Date.now(), everyMs = KEEP_AWAKE_MS, enabled = true } = {}) {
  if (!enabled) return false;
  if (!lastContactAt) return true;
  return (now - lastContactAt) >= everyMs;
}

/** A per device delay so two tills do not knock together. Stable for one device. */
export function jitterFor(deviceId, span = JITTER_MS) {
  const s = String(deviceId ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % Math.max(1, span);
}

/**
 * Keep a set of printers awake.
 *
 * Every knock goes through the SAME lane as real printing (see printerLane.js),
 * so a keep alive can never open a second socket while a ticket is going out.
 * That is the whole reason this is safe to run on a schedule.
 *
 * @param {{
 *   printers: () => Array<{ id?: string, ip: string, port?: number }>,
 *   send: (printer: { id?: string, ip: string, port?: number }, base64: string) => Promise<any>,
 *   lastContact: (printer: any) => number|null,
 *   onContact?: (printer: any, ok: boolean, err?: any) => void,
 *   enabled?: () => boolean,
 *   deviceId?: string,
 *   everyMs?: number,
 *   setTimer?: Function, clearTimer?: Function, now?: () => number,
 * }} o
 */
export function startKeepAwake(o) {
  const setTimer = o.setTimer || setInterval;
  const clearTimer = o.clearTimer || clearInterval;
  const now = o.now || (() => Date.now());
  const everyMs = o.everyMs || KEEP_AWAKE_MS;
  const b64 = statusQueryBase64();
  let stopped = false;

  const round = async () => {
    if (stopped) return;
    if (o.enabled && !o.enabled()) return;
    let list = [];
    try { list = o.printers() || []; } catch { return; }
    for (const p of list) {
      if (!p || !p.ip) continue;
      const last = (() => { try { return o.lastContact ? o.lastContact(p) : null; } catch { return null; } })();
      if (!shouldKnock({ lastContactAt: last, now: now(), everyMs })) continue;
      try {
        await o.send(p, b64);
        o.onContact?.(p, true);
      } catch (e) {
        // A knock that fails is information, never an error to the operator: the
        // next real ticket is what matters, and it has its own retries.
        o.onContact?.(p, false, e);
      }
    }
  };

  const timer = setTimer(round, everyMs);
  return {
    /** Knock now, used once at startup so a sleeping printer wakes before the first order. */
    knockNow: round,
    stop() { stopped = true; clearTimer(timer); },
  };
}
