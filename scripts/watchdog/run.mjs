#!/usr/bin/env node
// scripts/watchdog/run.mjs
//
// THE THING THAT WATCHES, SO A CUSTOMER DOES NOT HAVE TO.
//
// Peter is 8 hours behind the UK: venues trade while he sleeps, and until now
// every fault was found by somebody standing at a counter.
//
// IT RUNS OUTSIDE THE SYSTEM IT WATCHES. That is the whole point. On 22 Sep the
// database went down for 45 minutes and took its own scheduled jobs with it:
// the two sweeps that rescue stranded card payments are database jobs, and both
// died at 01:35 with everything else. A watchdog living there would have been
// just as dead. This one runs on GitHub's machines, so it is still alive to say
// "the database is not answering" — which is the single most important thing it
// can ever say.
//
// IT HOLDS NO KEYS. It asks ONE function, `watchdog-status`, which can count
// four things and name the venue, and can do nothing else: no order contents,
// no customer, no money, no writes. GitHub therefore stores a random token
// instead of a service-role key that could read and rewrite every venue.
//
// WHAT IT NEEDS
//   WATCHDOG_TOKEN   repo secret, the same random string as the edge function's
//   GITHUB_TOKEN     given to the workflow automatically
//   TWILIO_* + ALERT_TO   optional. Without them you still get the GitHub issue
//                         and the email GitHub sends you for it.
//
// HOW IT SPEAKS
//   One GitHub issue per problem per venue, labelled `watchdog`. Opening the
//   issue emails whoever watches the repo. The issue stays open while the fault
//   lasts, is reminded at most every 6 hours, and CLOSES ITSELF when the fault
//   clears, with a note saying how long it lasted. So the issue list is a true
//   picture of what is wrong right now, not a pile of stale noise.
//
// It never writes to the database. Reading is all it does.

import { evaluate, pages, alertDecision, resolved, smsText, runSummary, WINDOWS, REMINDER_HOURS } from './checks.mjs';

const OPS_URL = process.env.SUPABASE_URL || 'https://tbetcegmszzotrwdtqhi.supabase.co';
const TOKEN = process.env.WATCHDOG_TOKEN || '';
const REPO = process.env.GITHUB_REPOSITORY || 'Serv-OS/possystem';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const LABEL = 'watchdog';
const DRY = process.argv.includes('--dry-run');

const TIMEOUT_MS = 20_000;

class WatchdogBug extends Error {}     // our fault: no token, a wrong request
class Unreachable extends Error {}     // their fault: the system did not answer

/**
 * Ask the one question, and be very careful about what the answer means.
 *
 * A MISCONFIGURED WATCHDOG MUST NEVER ANNOUNCE AN OUTAGE. On its first live run
 * this script had no key at all, got a 401, and opened an issue saying the
 * venues could not take card payments. That is the exact class of mistake it
 * exists to catch, so it had better not make it: 4xx is ours, 5xx and silence
 * are theirs.
 */
async function measure() {
  if (!TOKEN) {
    throw new WatchdogBug('no WATCHDOG_TOKEN. Set the repo secret to the same string as the edge function.');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${OPS_URL}/functions/v1/watchdog-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-watchdog-token': TOKEN },
      body: JSON.stringify({ windows: WINDOWS }),
      signal: ctrl.signal,
    });
  } catch (e) {
    // Timed out, DNS gone, connection refused: nothing answered.
    throw new Unreachable(e.name === 'AbortError' ? `no answer in ${TIMEOUT_MS / 1000}s` : e.message);
  } finally { clearTimeout(t); }

  const text = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }

  if (res.ok && body?.ok) {
    return {
      reachable: true,
      cardStranded: body.cardStranded || [],
      ticketsLost: body.ticketsLost || [],
      printStuck: body.printStuck || [],
      ordersOpen: body.ordersOpen || [],
    };
  }

  // 401 bad/absent token, 400 bad request, 404 never deployed: all ours.
  const ours = res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status);
  const detail = (body?.error || body?.detail || text || res.statusText || '').slice(0, 200);
  if (ours) throw new WatchdogBug(`${res.status} ${detail}`);
  throw new Unreachable(`${res.status} ${detail}`);
}

// ── GitHub: the issue list IS the state, so nothing else has to be ──────────

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path}: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  return res.status === 204 ? null : res.json();
}

const keyOf = (issue) => (String(issue.body || '').match(/<!-- watchdog-key: (.+?) -->/) || [])[1] || null;

async function openIssues() {
  if (!GH_TOKEN) return new Map();
  const list = await gh(`/issues?state=open&labels=${LABEL}&per_page=100`);
  const map = new Map();
  for (const i of list) {
    const k = keyOf(i);
    if (k) map.set(k, { number: i.number, lastAlertedAt: i.updated_at, openedAt: i.created_at });
  }
  return map;
}

function issueBody(finding) {
  return [
    `**${finding.body}**`,
    '',
    `**What to do:** ${finding.fix}`,
    '',
    `Venue: ${finding.venue}`,
    `First seen: ${new Date().toISOString()}`,
    '',
    'This issue closes itself when the problem clears. It is opened by the watchdog, which runs outside the database so it can still speak when the database cannot.',
    '',
    `<!-- watchdog-key: ${finding.key} -->`,
  ].join('\n');
}

async function sms(text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const to = process.env.ALERT_TO;
  if (!sid || !token || !from || !to) return false;
  const body = new URLSearchParams({ To: to, From: from, Body: text });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  return res.ok;
}

async function main() {
  let measured;
  try {
    measured = await measure();
  } catch (e) {
    if (e instanceof WatchdogBug) {
      // OUR OWN FAULT. Say that nothing is being watched — never that the
      // venues are down, which we have no idea about.
      console.error('[watchdog] THE WATCHDOG ITSELF IS BROKEN:', e.message);
      measured = { watchdogBroken: e.message };
    } else {
      // THE CASE THIS EXISTS FOR. Nothing answered, so say exactly that rather
      // than reporting a clean bill of health from no data.
      console.error('[watchdog] could not reach the system:', e.message);
      measured = { reachable: false };
    }
  }

  const findings = evaluate(measured);
  const open = await openIssues().catch((e) => { console.error('[watchdog] issues unreadable:', e.message); return new Map(); });

  let sent = 0;
  for (const f of findings) {
    const existing = open.get(f.key) || null;
    const decision = alertDecision({ finding: f, openIssue: existing });
    console.log(`[watchdog] ${f.severity} ${f.key}: ${decision.alert ? 'SAYING IT' : 'quiet'} (${decision.reason})`);
    if (DRY || !GH_TOKEN) continue;

    if (!existing) {
      await gh('/issues', { method: 'POST', body: JSON.stringify({ title: f.title, body: issueBody(f), labels: [LABEL, f.severity] }) });
    } else if (decision.alert) {
      await gh(`/issues/${existing.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: `Still happening, ${REMINDER_HOURS} hours on. ${f.body}` }),
      });
    }
    if (decision.alert && await sms(smsText(f))) sent++;
  }

  // Close what has cleared, so the list is only ever what is wrong NOW. Only
  // ever from a run that actually measured: a failed run knows nothing, and
  // closing a real fault's issue because we could not look would be the worst
  // thing this script could do.
  if (!DRY && GH_TOKEN && measured.reachable === true) {
    for (const key of resolved(findings, [...open.keys()])) {
      const issue = open.get(key);
      const lasted = Math.round((Date.now() - new Date(issue.openedAt).getTime()) / 60_000);
      await gh(`/issues/${issue.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Cleared by itself after about ${lasted} minutes.` }) });
      await gh(`/issues/${issue.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
      console.log('[watchdog] cleared:', key);
    }
  }

  const summary = runSummary(findings, sent);
  console.log('[watchdog]', summary);
  // A red tick in the Actions list is itself a signal, and GitHub emails it.
  if (pages(findings).length || measured.watchdogBroken) process.exitCode = 1;
}

main().catch((e) => { console.error('[watchdog] crashed:', e); process.exitCode = 1; });
