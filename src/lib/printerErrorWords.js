/**
 * printerErrorWords.js: turn a raw socket error from a till into words staff can act on.
 *
 * PURE. The iPad and Android print bridges pass the operating system's own error text
 * straight to the screen, for example
 *   "The operation couldn't be completed. (Network.NWError error 64 - Host is down)".
 * That text is right but tells a venue nothing about what to do next. This module reads
 * the text and returns short plain steps. It is used at DISPLAY time only: what printer.js
 * stores in print_jobs.error_message stays the raw text, because support needs it.
 *
 *   printerErrorGuidance(rawText, { ip, port, device, env })
 *     -> { kind, title, steps, raw }
 *
 *   kind   permission | refused | unreachable | nonetwork | address | timeout | dropped | unknown
 *   title  the main line to show
 *   steps  short lines, what to check, in order
 *   raw    the untouched native text for a smaller second line ('' when the title already
 *          IS the raw text, so nothing is shown twice)
 *
 * ORDER MATTERS. Refused and unreachable are checked BEFORE timeout, because the Android
 * text "failed to connect to /192.168.1.50 (port 9100) from ... after 5000ms: connect
 * failed: EHOSTUNREACH (No route to host)" carries both a timeout shape and the real cause.
 *
 * An unknown text is shown as it is. Some print_jobs.error_message values are written by
 * the app and are instructions in their own right ("PRINTED but not recorded ..."), so an
 * unknown text must never be replaced by generic words.
 */
import { printEnvironment, printFailureWords } from './printPathWords.js';

const MATCHERS = [
  // iOS names a blocked local network "PolicyDenied" (-65570). Android gives EPERM or EACCES
  // when a VPN or firewall app blocks the socket.
  ['permission', /policy ?denied|-65570|local network|operation not permitted|permission denied|\beperm\b|\beacces\b/i],
  // Something IS at that IP, but nothing listens on the print port.
  ['refused', /connection refused|econnrefused|error 61\b/i],
  // Nothing answered at that IP on this network. 64 = ARP got no reply, 65 = no route.
  ['unreachable', /host is down|no route to host|ehostdown|ehostunreach|error 6[45]\b/i],
  // The device itself has no network to send on.
  ['nonetwork', /network is down|network is unreachable|enetdown|enetunreach|error 5[01]\b/i],
  // The saved address is not a usable IP.
  ['address', /unable to resolve host|no address associated|nodename nor servname|enotfound|eai_again|nosuchrecord|-65554|\bdns\b|invalid printer port|no printer ip|no printer address/i],
  // No answer in time. Kept narrow so app texts like "Worker timeout" stay unknown.
  ['timeout', /timed out|time out|print timeout|tcp timeout|timeout connecting|etimedout|error 60\b|after \d+ ?ms|^timeout$/i],
  // The printer was reached, then it closed the line.
  ['dropped', /connection reset|econnreset|broken pipe|\bepipe\b|software caused connection abort|econnaborted|error 54\b|error 32\b/i],
];

/** Which kind of fault a raw error text describes. */
export function printerErrorKind(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return 'unknown';
  for (const [kind, re] of MATCHERS) if (re.test(text)) return kind;
  return 'unknown';
}

/**
 * Which device produced the text. The text itself is the best witness: a failed job can be
 * shown on a different device from the one that tried to print it.
 */
export function printerErrorDevice(rawText, fallback = null) {
  const text = String(rawText || '');
  if (/NWError|the iPad|couldn.t be completed/i.test(text)) return 'ipad';
  if (/failed to connect to|\(port \d+\)|\bE[A-Z]{3,}\s*\(/.test(text)) return 'android';
  return fallback === 'ipad' || fallback === 'android' ? fallback : null;
}

/** The device showing the message, for when the text does not say. */
export function printerViewingDevice(w = (typeof window !== 'undefined' ? window : null)) {
  if (w && w.RposIOS) return 'ipad';
  if (w && w.RposPrinter) return 'android';
  return null;
}

function target(ip, port) {
  const cleanIp = String(ip || '').trim();
  if (!cleanIp) return '';
  const cleanPort = Number(port) > 0 ? Number(port) : 9100;
  return `${cleanIp}:${cleanPort}`;
}

const SELF_TEST = 'Print the printer self test page to confirm its IP. Hold FEED while switching the printer on.';

function sameNetworkStep(device) {
  if (device === 'ipad') return 'Check the iPad is on the same network as the printer.';
  if (device === 'android') return 'Check the till is on the same network as the printer.';
  return 'Check the till or iPad is on the same network as the printer.';
}

function localNetworkStep(device) {
  if (device === 'ipad') return 'On the iPad, open Settings, ServOS POS, and check Local Network is on.';
  if (device === 'android') return null;
  return 'On an iPad, also open Settings, ServOS POS, and check Local Network is on.';
}

export function printerErrorGuidance(rawText, { ip, port, device, env } = {}) {
  const raw = String(rawText || '').trim();
  const kind = printerErrorKind(raw);
  const who = printerErrorDevice(raw, device);
  const at = target(ip, port);
  const keep = (list) => list.filter(Boolean);

  switch (kind) {
    case 'unreachable':
      return {
        kind, raw,
        title: at ? `No printer found at ${at}.` : 'No printer found at that address.',
        steps: keep([
          'Check the printer is a LAN or Wi-Fi model. Bluetooth and USB models cannot print over the network.',
          SELF_TEST,
          sameNetworkStep(who),
          localNetworkStep(who),
        ]),
      };
    case 'refused':
      return {
        kind, raw,
        title: at ? `Something answered at ${at}, but it is not taking print jobs.` : 'Something answered, but it is not taking print jobs.',
        steps: keep([
          'That IP may belong to another device, not the printer.',
          SELF_TEST,
          'Fix the IP in Back Office, Printers. The port should be 9100.',
        ]),
      };
    case 'timeout':
      return {
        kind, raw,
        title: at ? `The printer at ${at} did not answer in time.` : 'The printer did not answer in time.',
        steps: keep([
          'Check the printer is switched on.',
          sameNetworkStep(who),
          'Do not use a guest Wi-Fi. Guest Wi-Fi often blocks printers.',
          SELF_TEST,
        ]),
      };
    case 'nonetwork':
      return {
        kind, raw,
        title: who === 'ipad' ? 'The iPad has no network connection.' : who === 'android' ? 'The till has no network connection.' : 'The till or iPad has no network connection.',
        steps: keep([
          'Turn Wi-Fi on and join the same network as the printer.',
          who === 'android' ? null : (who === 'ipad'
            ? 'If Wi-Fi is on, open Settings, ServOS POS, and check Local Network is on.'
            : 'On an iPad with Wi-Fi on, open Settings, ServOS POS, and check Local Network is on.'),
          'Then try again.',
        ]),
      };
    case 'permission':
      return {
        kind, raw,
        title: who === 'ipad' ? 'The iPad is not allowed to reach the printer.' : who === 'android' ? 'The till is not allowed to reach the printer.' : 'The till or iPad is not allowed to reach the printer.',
        steps: keep([
          who === 'android' ? null : (who === 'ipad'
            ? 'Open iPad Settings, ServOS POS, and turn Local Network on.'
            : 'On an iPad, open Settings, ServOS POS, and turn Local Network on.'),
          who === 'ipad' ? null : 'On an Android till, turn off any VPN or firewall app.',
          'Then try again.',
        ]),
      };
    case 'address': {
      const cleanIp = String(ip || '').trim();
      if (/invalid printer port/i.test(raw)) {
        return {
          kind, raw,
          title: 'The printer port is not valid. It should be 9100.',
          steps: ['Open Back Office, Printers, and save the printer again.'],
        };
      }
      const noIp = !cleanIp || /no printer ip|no printer address/i.test(raw);
      return {
        kind, raw,
        title: noIp ? 'This printer has no IP address saved.' : `The printer address ${cleanIp} is not a valid IP.`,
        steps: [
          'Open Back Office, Printers, and type the printer IP. It looks like 192.168.1.50.',
          'To find the IP, print the self test page. Hold FEED while switching the printer on.',
        ],
      };
    }
    case 'dropped':
      return {
        kind, raw,
        title: at ? `The printer at ${at} was found, but it dropped the print.` : 'The printer was found, but it dropped the print.',
        steps: [
          'Check it has paper and the cover is shut.',
          'Switch the printer off and on, then try again.',
        ],
      };
    default:
      // Unknown text is shown as it is. With no text at all, say what this device can do.
      return { kind: 'unknown', raw: '', title: raw || printFailureWords(env || printEnvironment()), steps: [] };
  }
}
