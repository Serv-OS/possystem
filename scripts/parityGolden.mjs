// scripts/parityGolden.mjs: writes src/lib/parity/posGolden.json, the POS figures for every
// golden parity basket. Run ONLY on a commit whose POS money code is the reference
// (v5.11.78: origin/main 2bbd9ecc, v5.11.75, before any parity change). posIdentity.test.js then
// proves the POS still gives byte identical figures. Usage: node scripts/parityGolden.mjs
import { writeFileSync } from 'node:fs';
import { BASKETS } from '../src/lib/parity/fixtures.js';
import { posFigures, posUnit } from '../src/lib/parity/pos.js';

const out = { reference: 'origin/main 2bbd9ecc (v5.11.75)', baskets: {}, units: {} };
for (const b of BASKETS) out.baskets[b.id] = posFigures(b);
for (const id of ['latte', 'beer-half', 'beer-pint', 'baby-l', 'toastie', 'sarnie', 'water'])
  for (const ot of ['dine-in', 'takeaway', 'collection', 'delivery', 'drive-thru', 'bar-tab'])
    for (const m of [null, 'lunch', 'bar']) out.units[`${id}|${ot}|${m || ''}`] = posUnit(id, ot, m);
writeFileSync(new URL('../src/lib/parity/posGolden.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('wrote', Object.keys(out.baskets).length, 'baskets,', Object.keys(out.units).length, 'unit prices');
