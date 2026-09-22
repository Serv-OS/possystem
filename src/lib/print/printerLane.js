// src/lib/print/printerLane.js
//
// ONE PRINTER, ONE JOB AT A TIME.
//
// Peter, 22 Sep 2026, twice in a day: "the printer has disconnected and is not
// printing", "its just gone off again", "this was not happening until the last
// couple of days so this needs proper looking at".
//
// It was never disconnected. The live record says so:
//
//   failed to connect to /10.0.0.104 (port 9100) from /10.0.0.125 (port 45284)
//   after 5000ms: isConnected
//
// A thermal printer on port 9100 (Sunmi, Epson, Star: all of them) accepts ONE
// TCP connection at a time. That is the protocol, not a fault. The dispatcher
// did this:
//
//   for (const job of data) claimAndDispatch(job.id);   // not awaited
//
// so one kiosk order, which makes a kitchen ticket AND a receipt AND a drawer
// kick, opened three sockets to the same printer at once. One printed. The
// others sat on a dead connect until the 5 second timeout and burned an attempt
// each. Five attempts later the receipt was failed_permanent: a ticket that
// never reached paper and never will.
//
// It got worse in the last couple of days because v5.9.27 (mine, 21 Sep) made
// the dispatcher sweep the moment the realtime socket reconnects and then every
// 2s while work exists. That was the right fix for a ticket waiting 12 seconds,
// and it also turned a trickle into bursts, which is what makes two jobs
// collide. Tonight's outage reconnected that socket over and over.
//
// THE RULE HERE: jobs going to the SAME printer run one after another. Jobs for
// DIFFERENT printers still run at the same time, because a kitchen printer and a
// bar printer are two machines and waiting on one for the other is how a kitchen
// ticket ends up behind a receipt.

import { printerErrorKind } from '../printerErrorWords.js';

/** A printer's identity for queueing: its id, else its ip:port, else the venue's one printer. */
export function laneKeyOf(job) {
  const id = String(job?.printer_id ?? '').trim();
  if (id) return 'printer:' + id;
  const ip = String(job?.printer_ip ?? '').trim();
  if (ip) return 'net:' + ip + ':' + String(job?.printer_port ?? 9100);
  // No printer named: still serialise, per venue, because the venue's default
  // printer is what it will resolve to.
  return 'venue:' + String(job?.location_id ?? 'unknown');
}

/**
 * A set of lanes. Each lane runs its jobs one at a time, in the order given.
 * Different lanes run side by side.
 *
 * Deliberately tiny and dependency free: this sits in the path between an order
 * and a piece of paper, so it must be obvious enough to read in one go.
 */
export function createLanes({ onError = null } = {}) {
  /** @type {Map<string, Promise<void>>} the tail of each lane's chain */
  const tails = new Map();
  /** @type {Map<string, number>} how many jobs are waiting or running per lane */
  const depth = new Map();

  function run(key, work) {
    const k = String(key || 'default');
    depth.set(k, (depth.get(k) || 0) + 1);
    const prev = tails.get(k) || Promise.resolve();
    // Never let one job's failure break the chain: the next ticket still prints.
    const next = prev.then(() => work()).catch((e) => {
      try { onError?.(e, k); } catch { /* a logger must never break printing */ }
    }).finally(() => {
      const left = (depth.get(k) || 1) - 1;
      if (left <= 0) { depth.delete(k); if (tails.get(k) === next) tails.delete(k); }
      else depth.set(k, left);
    });
    tails.set(k, next);
    return next;
  }

  return {
    run,
    /** How many jobs are queued or running for this printer. */
    depthOf: (key) => depth.get(String(key || 'default')) || 0,
    /** Every lane with work outstanding, for the status drawer. */
    busy: () => [...depth.entries()].map(([key, n]) => ({ key, n })),
    /** Is anything at all printing? */
    idle: () => depth.size === 0,
  };
}

/**
 * Is this failure a BUSY SOCKET, rather than a printer that is genuinely away?
 *
 * The two need opposite answers: a busy socket clears in seconds, while a
 * printer that is off the network needs a human and should reach the Action
 * Required list quickly rather than after a quarter of an hour of hope.
 *
 * THE FIRST VERSION OF THIS WAS WRONG, and the investigation caught it before it
 * shipped. Android's real message is:
 *
 *   failed to connect to /10.0.0.104 (port 9100) from /10.0.0.125 (port 46886)
 *   after 5000ms: isConnected failed: EHOSTUNREACH (No route to host)
 *
 * It contains BOTH "failed to connect" and "isConnected", so matching on those
 * called 50 of the 53 genuinely-unreachable failures a collision. The tail is
 * what matters, and printerErrorWords.js already reads it correctly: it checks
 * "unreachable" BEFORE "timeout", precisely so this cannot happen. Use it.
 */
export function looksLikeCollision(error) {
  const text = String(error?.message ?? error ?? '').trim();
  if (!text) return false;
  const kind = printerErrorKind(text);
  // A printer that is off, unreachable, blocked or has no network is NOT busy.
  // Only a timeout with no OS reason, or a line the printer dropped mid job, is.
  return kind === 'timeout' || kind === 'dropped';
}
