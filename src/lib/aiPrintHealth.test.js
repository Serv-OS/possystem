// The shift assistant's printing health (lib/aiTools.js get_pos_health, get_printer_status).
// 15 Oct 2026, Peter: "this must be a false error, we dont use a print agent locally". No venue
// runs a LAN print agent, so a missing agent row is the normal case and never a fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('a venue with no print agent is not told one is down', () => {
  const src = read('src/lib/aiTools.js');
  assert.doesNotMatch(src, /No print agent detected/, 'the false alarm is gone');
  assert.doesNotMatch(src, /is the print agent running/, 'and so is its twin in get_printer_status');
  assert.match(src, /if \(agent && agentAge > 120\)/, 'an agent is only reported when the venue has one and it has gone quiet');
});

test('the honest printing signal is a ticket that has waited over 10 minutes', () => {
  const src = read('src/lib/aiTools.js');
  assert.match(src, /from\('print_jobs'\)[\s\S]{0,200}\.in\('status', \['pending', 'claimed'\]\)[\s\S]{0,120}10 \* 60000/, 'pending or claimed jobs older than 10 minutes, the watchdog rule');
  assert.match(src, /waiting over 10 minutes to print/);
  assert.match(src, /checked: \['printers', 'tickets waiting to print', 'ops alerts', 'order queue'\]/);
  assert.doesNotMatch(read('api/ai.js'), /a print agent that has stopped checking in/, 'the tool description no longer promises an agent check');
});
