// scripts/watchdog/checks.mjs
//
// WHAT COUNTS AS "A VENUE IS IN TROUBLE", AND WHO SHOULD BE WOKEN.
//
// Peter, 22 Sep 2026: "what happens if something breaks when I am asleep" — he
// is 8 hours behind the UK, so venues trade while he sleeps and every fault so
// far has been found by a customer standing at a counter:
//
//   * Apple Pay dead on the checkout, found by a customer
//   * menu categories failing to save for FIVE MONTHS, found by a staff member
//   * a kiosk card payment stranded with the customer at the machine
//   * 72 print jobs that never reached paper since April, 39 of them kitchen
//     tickets, found by nobody at all until we counted them
//
// The system knew about every one of those and told no one.
//
// TWO RULES THIS FILE EXISTS TO OBEY
//
// 1. NEVER CRY WOLF. An alert that fires when nothing is wrong gets muted, and
//    a muted alert is worse than none. Every threshold below was measured
//    against 30 days of live data first:
//      stranded card jobs over 10 min ....... 0 in 30 days
//      print jobs stuck pending over 10 min . 0 in 30 days
//      tickets permanently failed ........... 14 in 30 days (~1 every 2 days)
//      orders open over 45 min .............. 18 in 30 days
//    The first three are silent unless something is genuinely wrong. The fourth
//    is noisier, so it never wakes anybody; it waits for the morning.
//
// 2. NEVER WAKE SOMEONE FOR SOMETHING THEY CANNOT ACT ON. Every finding carries
//    the venue, what happened, and the thing to do about it. If we cannot say
//    what to do, it is not a page.
//
// The checks are pure: give them numbers and a clock, they give back findings.
// run.mjs does the talking to Supabase, GitHub and Twilio.

/** Wake someone now. */
export const PAGE = 'page';
/** Worth knowing, waits for the morning. */
export const WARN = 'warn';

/** How long a continuing problem stays quiet before it speaks again. */
export const REMINDER_HOURS = 6;

/**
 * Every signal, with the words a person reads at 3am.
 *
 * `minutes` and `atLeast` are the measured thresholds above. Keep them honest:
 * loosening one to silence an alert is how a real fault gets missed.
 */
export const SIGNALS = Object.freeze({
  db_unreachable: {
    severity: PAGE,
    title: 'The database is not answering',
    // The 22 Sep outage: 45 minutes, and the clock only started when Peter
    // happened to look. Nothing else on this list matters if this one fires.
    say: () => 'Tills cannot take card payments, and Back Office will not load. Cash still works and tickets still print at the venue.',
    fix: 'Check status.supabase.com, then the project dashboard. If the database is up but REST is not, restart the project from Settings, Infrastructure.',
  },
  watchdog_broken: {
    // NOT a page. If the watchdog is broken, Peter cannot fix it at 3am and
    // nobody should be woken for it — but it must be VISIBLE, because while it
    // lasts nothing is watching the venues at all. An issue (and the red run
    // GitHub emails) is the right volume.
    //
    // It exists because on its first live run this thing had no key, got a 401,
    // and announced that the venues could not take card payments. A broken
    // watchdog knows NOTHING about the venues, and must say only that.
    severity: WARN,
    title: 'The watchdog itself is not working',
    say: (f) => `The watchdog could not run: ${f.detail || 'unknown reason'}. This says nothing about whether the venues are up — while it lasts, nobody is watching them.`,
    fix: 'Look at the last Watchdog run in GitHub Actions. Usually a missing WATCHDOG_TOKEN secret or the watchdog-status function not deployed.',
  },
  card_stranded: {
    severity: PAGE,
    minutes: 10,
    say: (f) => `${f.count === 1 ? 'A card payment has' : `${f.count} card payments have`} been mid-flight for over ${f.minutes} minutes at ${f.venue}. The customer may be stood at the reader.`,
    title: 'A card payment is stranded',
    fix: 'Open Back Office, Card payments, Action required. Ask the reader for the result before refunding or retrying, or the customer can be charged twice.',
  },
  ticket_lost: {
    severity: PAGE,
    // Each one is an order the kitchen never saw. 14 in 30 days, so this is
    // rare enough to wake someone and serious enough to deserve it.
    say: (f) => `${f.count === 1 ? 'A ticket' : `${f.count} tickets`} gave up trying to print at ${f.venue}. The kitchen has not seen ${f.count === 1 ? 'that order' : 'those orders'}.`,
    title: 'A ticket never printed',
    fix: 'Check the printer is on and on the network, then reprint from Back Office, Printers, Action required.',
  },
  print_stuck: {
    severity: PAGE,
    minutes: 10,
    say: (f) => `${f.count === 1 ? 'A ticket has' : `${f.count} tickets have`} been waiting over ${f.minutes} minutes to print at ${f.venue}.`,
    title: 'Tickets are queuing and not printing',
    fix: 'The printer is usually asleep or off the network. Power cycle it, and check the till can reach it.',
  },
  orders_open: {
    severity: WARN,
    minutes: 45,
    say: (f) => `${f.count} order${f.count === 1 ? '' : 's'} at ${f.venue} ${f.count === 1 ? 'has' : 'have'} been open for over ${f.minutes} minutes.`,
    title: 'Orders have been open a long time',
    fix: 'Usually a collection nobody marked as collected. Worth a look in Orders, not worth getting up for.',
  },
});

/**
 * The time windows the QUERIES use, in minutes.
 *
 * They live here, beside the words, because the wording and the query must
 * never drift apart: a message saying "over 10 minutes" above a query asking
 * for 45 is a lie told by a machine, and a test below pins them together.
 *
 *   olderThan — how long the thing has been in trouble before it counts
 *   within    — how far back we are willing to look at all
 */
export const WINDOWS = Object.freeze({
  card_stranded: { olderThan: 10 },
  // Only the last hour. A permanent print failure from last week is history,
  // and history does not need waking anybody.
  ticket_lost: { within: 60 },
  print_stuck: { olderThan: 10 },
  // TODAY's orders only. The first live run reported six venues, every one of
  // them an order abandoned weeks ago: permanent wallpaper, which is exactly
  // how an alert list gets ignored.
  orders_open: { olderThan: 45, within: 24 * 60 },
});

/** Signals that are about the system as a whole, not about one venue's count. */
const ALWAYS = Object.freeze({ db_unreachable: true, watchdog_broken: true });

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Turn what we measured into findings.
 *
 * @param {{
 *   reachable?: boolean,
 *   cardStranded?: Array<{ venue: string, count: number }>,
 *   ticketsLost?: Array<{ venue: string, count: number }>,
 *   printStuck?: Array<{ venue: string, count: number }>,
 *   ordersOpen?: Array<{ venue: string, count: number }>,
 * }} measured
 * @returns {Array<{ key: string, signal: string, severity: string, venue: string, count: number, title: string, body: string, fix: string }>}
 */
export function evaluate(measured = {}) {
  const out = [];
  const add = (signal, venue, count, detail) => {
    const def = SIGNALS[signal];
    if (!def) return;
    const f = { venue: venue || (ALWAYS[signal] ? 'all venues' : 'a venue'), count: num(count), minutes: def.minutes, detail };
    if (!ALWAYS[signal] && f.count < 1) return;
    out.push({
      // The key is what makes an alert ONE alert: the same trouble at the same
      // venue is the same issue until it clears, however many times we look.
      key: signal + ':' + (venue || 'all'),
      signal,
      severity: def.severity,
      venue: f.venue,
      count: f.count,
      title: def.title + (ALWAYS[signal] ? '' : ' — ' + f.venue),
      body: def.say(f),
      fix: def.fix,
    });
  };

  // OURSELVES first. A watchdog that could not run knows nothing about the
  // venues, so it says that and stops. Anything else would be a guess dressed
  // up as a measurement.
  if (measured.watchdogBroken) {
    add('watchdog_broken', null, 1, String(measured.watchdogBroken));
    return out;
  }

  // The database next: if it is unreachable nothing else could be measured,
  // and reporting "0 stranded payments" then would be a lie.
  if (measured.reachable === false) {
    add('db_unreachable', null, 1);
    return out;
  }

  for (const r of measured.cardStranded || []) add('card_stranded', r.venue, r.count);
  for (const r of measured.ticketsLost || []) add('ticket_lost', r.venue, r.count);
  for (const r of measured.printStuck || []) add('print_stuck', r.venue, r.count);
  for (const r of measured.ordersOpen || []) add('orders_open', r.venue, r.count);
  return out;
}

/** Anything worth waking a person for. */
export function pages(findings) {
  return (findings || []).filter((f) => f.severity === PAGE);
}

/**
 * Should this finding be said OUT LOUD right now?
 *
 * An open issue means we already said it. We repeat only after REMINDER_HOURS,
 * so a fault nobody has fixed nags gently instead of every five minutes.
 *
 * @param {{ finding: object, openIssue: { lastAlertedAt?: string|number|null }|null, now?: number }} o
 * @returns {{ alert: boolean, reason: string }}
 */
export function alertDecision({ finding, openIssue = null, now = Date.now() } = {}) {
  if (!finding) return { alert: false, reason: 'nothing to say' };
  if (finding.severity !== PAGE) return { alert: false, reason: 'not urgent enough to wake anybody' };
  if (!openIssue) return { alert: true, reason: 'new' };
  const last = openIssue.lastAlertedAt ? new Date(openIssue.lastAlertedAt).getTime() : 0;
  if (!last) return { alert: true, reason: 'never actually said' };
  const hours = (now - last) / 3_600_000;
  if (hours >= REMINDER_HOURS) return { alert: true, reason: 'still broken after ' + Math.floor(hours) + 'h' };
  return { alert: false, reason: 'already said ' + Math.floor(hours * 60) + ' minutes ago' };
}

/** The findings that have cleared: open issues with no matching finding. */
export function resolved(findings, openKeys) {
  const live = new Set((findings || []).map((f) => f.key));
  return (openKeys || []).filter((k) => !live.has(k));
}

/** One SMS. Short, because it is read on a lock screen at 3am. */
export function smsText(finding) {
  if (!finding) return '';
  const head = 'ServOS: ' + finding.title;
  const body = finding.body;
  return (head + '. ' + body).slice(0, 300);
}

/** What the run says in its own log, whether or not anything is wrong. */
export function runSummary(findings, alerted) {
  const f = findings || [];
  if (!f.length) return 'All clear.';
  const p = pages(f).length;
  const bits = [];
  if (p) bits.push(p + ' urgent');
  const w = f.length - p;
  if (w) bits.push(w + ' for the morning');
  return bits.join(', ') + '. ' + (alerted ? alerted + ' sent.' : 'nothing new to send.');
}
