/**
 * printerErrorWords.test.js: raw socket errors from the tills become plain steps.
 * Every raw string below is the real text a bridge or agent produces. Run: `npm test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { printerErrorGuidance, printerErrorKind, printerErrorDevice, printerViewingDevice } from './printerErrorWords.js';

// iOS: NWError.localizedDescription, passed through by ios/ServOSPOS/PrinterBridge.swift.
const IOS_64 = 'The operation couldn’t be completed. (Network.NWError error 64 - Host is down)';
const IOS_65 = 'The operation couldn’t be completed. (Network.NWError error 65 - No route to host)';
const IOS_61 = 'The operation couldn’t be completed. (Network.NWError error 61 - Connection refused)';
const IOS_60 = 'The operation couldn’t be completed. (Network.NWError error 60 - Operation timed out)';
const IOS_50 = 'The operation couldn’t be completed. (Network.NWError error 50 - Network is down)';
const IOS_54 = 'The operation couldn’t be completed. (Network.NWError error 54 - Connection reset by peer)';
const IOS_POLICY = 'The operation couldn’t be completed. (Network.NWError error -65570 - PolicyDenied)';
// The bridge's own 8 second timer.
const IOS_BRIDGE_TIMEOUT = 'Print timeout: check the printer IP and that the iPad is on the same Wi-Fi';

// Android: e.getMessage() from NetworkPrinter.java.
const AND_UNREACH = 'failed to connect to /192.168.1.50 (port 9100) from /192.168.1.23 (port 48212) after 5000ms: isConnected failed: EHOSTUNREACH (No route to host)';
const AND_REFUSED = 'failed to connect to /192.168.1.50 (port 9100) from /:: (port 0) after 5000ms: isConnected failed: ECONNREFUSED (Connection refused)';
const AND_TIMEOUT_LONG = 'failed to connect to /192.168.1.50 (port 9100) from /192.168.1.23 (port 48212) after 5000ms';
const AND_TIMEOUT_SHORT = 'connect timed out';
const AND_RESOLVE = 'Unable to resolve host "printer.local": No address associated with hostname';
const AND_NETUNREACH = 'failed to connect to /192.168.1.50 (port 9100) from /:: (port 0) after 5000ms: connect failed: ENETUNREACH (Network is unreachable)';
const AND_EPERM = 'socket failed: EPERM (Operation not permitted)';

const at = { ip: '192.168.1.50', port: 9100 };

test('iOS error 64 Host is down: unreachable, names the IP and port, iPad steps', () => {
  const g = printerErrorGuidance(IOS_64, at);
  assert.equal(g.kind, 'unreachable');
  assert.equal(g.title, 'No printer found at 192.168.1.50:9100.');
  assert.equal(g.raw, IOS_64);
  assert.deepEqual(g.steps, [
    'Check the printer is a LAN or Wi-Fi model. Bluetooth and USB models cannot print over the network.',
    'Print the printer self test page to confirm its IP. Hold FEED while switching the printer on.',
    'Check the iPad is on the same network as the printer.',
    'On the iPad, open Settings, ServOS POS, and check Local Network is on.',
  ]);
});

test('iOS error 65 No route to host: unreachable, with the Local Network step', () => {
  const g = printerErrorGuidance(IOS_65, at);
  assert.equal(g.kind, 'unreachable');
  assert.ok(g.steps.some(s => /Local Network/.test(s)));
});

test('the 8 second bridge timeout: timeout, known to be an iPad', () => {
  const g = printerErrorGuidance(IOS_BRIDGE_TIMEOUT, at);
  assert.equal(g.kind, 'timeout');
  assert.equal(g.title, 'The printer at 192.168.1.50:9100 did not answer in time.');
  assert.ok(g.steps.includes('Check the iPad is on the same network as the printer.'));
  assert.ok(g.steps.includes('Check the printer is switched on.'));
  assert.equal(g.raw, IOS_BRIDGE_TIMEOUT);
});

test('Android EHOSTUNREACH is unreachable, NOT timeout, even though the text says "after 5000ms"', () => {
  const g = printerErrorGuidance(AND_UNREACH, at);
  assert.equal(g.kind, 'unreachable');
  assert.ok(g.steps.includes('Check the till is on the same network as the printer.'));
  assert.ok(!g.steps.some(s => /Local Network/.test(s)), 'no iPad step on an Android till');
});

test('Android ECONNREFUSED is refused, NOT timeout', () => {
  const g = printerErrorGuidance(AND_REFUSED, at);
  assert.equal(g.kind, 'refused');
  assert.equal(g.title, 'Something answered at 192.168.1.50:9100, but it is not taking print jobs.');
  assert.ok(g.steps.some(s => /another device/.test(s)));
  assert.ok(g.steps.some(s => /9100/.test(s)));
});

test('iOS error 61 Connection refused is refused', () => {
  assert.equal(printerErrorKind(IOS_61), 'refused');
});

test('connect timed out, in both Android shapes and the iOS code, is timeout', () => {
  assert.equal(printerErrorKind(AND_TIMEOUT_SHORT), 'timeout');
  assert.equal(printerErrorKind(AND_TIMEOUT_LONG), 'timeout');
  assert.equal(printerErrorKind(IOS_60), 'timeout');
  // With no device in the text, the words cover both.
  const g = printerErrorGuidance(AND_TIMEOUT_SHORT, at);
  assert.ok(g.steps.includes('Check the till or iPad is on the same network as the printer.'));
  // The viewing device fills the gap when the text does not say.
  const onTill = printerErrorGuidance(AND_TIMEOUT_SHORT, { ...at, device: 'android' });
  assert.ok(onTill.steps.includes('Check the till is on the same network as the printer.'));
});

test('Unable to resolve host: address, names the bad address', () => {
  const g = printerErrorGuidance(AND_RESOLVE, { ip: 'printer.local', port: 9100 });
  assert.equal(g.kind, 'address');
  assert.equal(g.title, 'The printer address printer.local is not a valid IP.');
  assert.ok(g.steps[0].startsWith('Open Back Office, Printers'));
});

test('no address saved, and a bad port, are address faults with their own words', () => {
  assert.equal(printerErrorGuidance('No printer IP address', {}).title, 'This printer has no IP address saved.');
  assert.equal(printerErrorGuidance('No printer address', { ip: '' }).title, 'This printer has no IP address saved.');
  assert.equal(printerErrorGuidance('Invalid printer port 0', at).title, 'The printer port is not valid. It should be 9100.');
});

test('policy denied: permission, points at Local Network on an iPad', () => {
  const g = printerErrorGuidance(IOS_POLICY, at);
  assert.equal(g.kind, 'permission');
  assert.equal(g.title, 'The iPad is not allowed to reach the printer.');
  assert.deepEqual(g.steps, ['Open iPad Settings, ServOS POS, and turn Local Network on.', 'Then try again.']);
  // Bare words, as a newer bridge might send them.
  assert.equal(printerErrorKind('Local network permission denied'), 'permission');
  assert.equal(printerErrorKind('PolicyDenied'), 'permission');
});

test('Android EPERM: permission, points at a VPN or firewall, never at iPad Settings', () => {
  const g = printerErrorGuidance(AND_EPERM, at);
  assert.equal(g.kind, 'permission');
  assert.deepEqual(g.steps, ['On an Android till, turn off any VPN or firewall app.', 'Then try again.']);
});

test('network is down or unreachable: the device has no network', () => {
  assert.equal(printerErrorGuidance(IOS_50, at).kind, 'nonetwork');
  assert.equal(printerErrorGuidance(IOS_50, at).title, 'The iPad has no network connection.');
  assert.equal(printerErrorGuidance(AND_NETUNREACH, at).kind, 'nonetwork');
  assert.equal(printerErrorGuidance(AND_NETUNREACH, at).title, 'The till has no network connection.');
});

test('a reset or broken pipe: the printer was found but dropped the print', () => {
  assert.equal(printerErrorKind(IOS_54), 'dropped');
  assert.equal(printerErrorKind('read ECONNRESET'), 'dropped');
  assert.equal(printerErrorKind('write EPIPE'), 'dropped');
  assert.equal(printerErrorKind('sendto failed: EPIPE (Broken pipe)'), 'dropped');
  assert.ok(printerErrorGuidance(IOS_54, at).steps.some(s => /paper/.test(s)));
});

test('Node print agent texts map the same way', () => {
  assert.equal(printerErrorKind('connect EHOSTUNREACH 192.168.1.50:9100'), 'unreachable');
  assert.equal(printerErrorKind('connect ECONNREFUSED 192.168.1.50:9100'), 'refused');
  assert.equal(printerErrorKind('connect ETIMEDOUT 192.168.1.50:9100'), 'timeout');
  assert.equal(printerErrorKind('TCP timeout (5000ms) to 192.168.1.50:9100'), 'timeout');
  assert.equal(printerErrorKind('Timeout connecting to 192.168.1.50:9100'), 'timeout');
  assert.equal(printerErrorKind('Timeout'), 'timeout');
  assert.equal(printerErrorKind('getaddrinfo ENOTFOUND printer.local'), 'address');
});

test('app written texts stay as they are: unknown, shown as the main line, no second line', () => {
  // These are stored in print_jobs.error_message by the app (the stored texts carry a dash
  // between the two halves, which changes nothing here).
  for (const text of [
    'PRINTED but not recorded, the ticket IS on paper. Dismiss this; Retry would print it a second time.',
    'Worker timeout, reclaimed',
    'subscribe timeout',
    'Invalid print data',
    'Print failed',
    'HTTP error 500',
    'Supabase fetch failed: 650',
  ]) {
    const g = printerErrorGuidance(text, at);
    assert.equal(g.kind, 'unknown', text);
    assert.equal(g.title, text);
    assert.equal(g.raw, '', 'nothing is shown twice');
    assert.deepEqual(g.steps, []);
  }
});

test('no text at all: falls back to the words for this device', () => {
  assert.equal(printerErrorGuidance('', { env: 'native' }).title, 'Printer did not answer. Check it is on and on the same Wi-Fi as this device.');
  assert.equal(printerErrorGuidance(null, { env: 'browser' }).title, 'No printer connection from a browser. Print from the till app on this device.');
  assert.equal(printerErrorGuidance(undefined, { env: 'ios-old' }).kind, 'unknown');
  assert.equal(printerErrorGuidance(undefined).kind, 'unknown');
});

test('no IP known: the words still read well, and a missing port means 9100', () => {
  assert.equal(printerErrorGuidance(IOS_64, {}).title, 'No printer found at that address.');
  assert.equal(printerErrorGuidance(IOS_64, { ip: ' 10.0.0.9 ' }).title, 'No printer found at 10.0.0.9:9100.');
  assert.equal(printerErrorGuidance(IOS_64, { ip: '10.0.0.9', port: 9101 }).title, 'No printer found at 10.0.0.9:9101.');
});

test('the text says which device tried; the viewing device is only a fallback', () => {
  assert.equal(printerErrorDevice(IOS_64), 'ipad');
  assert.equal(printerErrorDevice(IOS_64, 'android'), 'ipad');
  assert.equal(printerErrorDevice(AND_UNREACH, 'ipad'), 'android');
  assert.equal(printerErrorDevice('connect EHOSTUNREACH 192.168.1.50:9100'), null);
  assert.equal(printerErrorDevice('connect timed out', 'ipad'), 'ipad');
  assert.equal(printerErrorDevice('connect timed out', 'laptop'), null);
  assert.equal(printerViewingDevice({ RposIOS: {}, RposPrinter: {} }), 'ipad');
  assert.equal(printerViewingDevice({ RposPrinter: {} }), 'android');
  assert.equal(printerViewingDevice({}), null);
  assert.equal(printerViewingDevice(null), null);
});

test('house style: short lines, no dashes, never blames a print agent', () => {
  const raws = [IOS_64, IOS_65, IOS_61, IOS_60, IOS_50, IOS_54, IOS_POLICY, IOS_BRIDGE_TIMEOUT,
    AND_UNREACH, AND_REFUSED, AND_TIMEOUT_LONG, AND_TIMEOUT_SHORT, AND_RESOLVE, AND_NETUNREACH, AND_EPERM,
    'connect EHOSTUNREACH 192.168.1.50:9100', 'Invalid printer port 0', 'No printer address'];
  for (const raw of raws) {
    for (const device of [null, 'ipad', 'android']) {
      const g = printerErrorGuidance(raw, { ...at, device });
      assert.notEqual(g.kind, 'unknown', raw);
      assert.ok(g.steps.length >= 1 && g.steps.length <= 4, `${g.kind}: 1 to 4 steps`);
      for (const line of [g.title, ...g.steps]) {
        assert.ok(!/[\u2013\u2014]/.test(line), `no dashes: ${line}`);
        assert.ok(!/agent/i.test(line), `no agent: ${line}`);
        assert.ok(line.length <= 110, `short line: ${line}`);
      }
    }
  }
});
