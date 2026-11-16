/**
 * primeCost.test.js: the head office scorecard's arithmetic.
 * Run: `npm test`, or `node --test src/lib/hq/primeCost.test.js`.
 *
 * Pinned:
 *   1. Prime cost = (COGS + labour) / net sales. A missing part is null, never 0.
 *   2. The till wins: snapshot sales and labour beat typed ones; typed fills a day the till did not see.
 *   3. COGS comes from the stock block's actual GP first, theoretical second, typed last.
 *   4. The ladder ranks lowest prime cost first; no figure goes last.
 *   5. The group's prime cost is weighted by sales.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  primeCostPct, cogsPctFromStock, moraleWord, primeTone, siteRow, rankSites, portfolio, shortCode, shortMoney,
} from './primeCost.js';

test('primeCostPct: the arithmetic and the nulls', () => {
  assert.equal(primeCostPct({ net: 5230, cogs: 1510, labour: 1560 }), 58.7);
  assert.equal(primeCostPct({ net: 0, cogs: 1, labour: 1 }), null);
  assert.equal(primeCostPct({ net: 100, cogs: null, labour: 10 }), null);
  assert.equal(primeCostPct({ net: 100, cogs: 10 }), null);
  assert.equal(primeCostPct({ net: '100', cogs: '30', labour: '30' }), 60);
});

test('cogsPctFromStock: actual GP first, theoretical second, nothing when there is no block', () => {
  assert.equal(cogsPctFromStock({ gp_pct_actual: 68.5, gp_pct_theo: 70 }), 31.5);
  assert.equal(cogsPctFromStock({ gp_pct_actual: null, gp_pct_theo: 70 }), 30);
  assert.equal(cogsPctFromStock(null), null);
  assert.equal(cogsPctFromStock({}), null);
});

test('moraleWord and primeTone', () => {
  assert.equal(moraleWord(9), 'Strong');
  assert.equal(moraleWord(8), 'Strong');
  assert.equal(moraleWord(7.1), 'Steady');
  assert.equal(moraleWord(6), 'Watch');
  assert.equal(moraleWord(null), null);
  assert.equal(primeTone(57.5), 'grn');
  assert.equal(primeTone(60), 'orn');
  assert.equal(primeTone(null), null);
});

test('siteRow: the till wins, typed fills the gaps, every source is named', () => {
  const venue = { today: { net_sales: 7900, labour: 2370 }, stock: { gp_pct_actual: 70 }, compare: { pct: -0.6, reason: 'ok' }, week_compare: { pct: 3.2 }, currency: 'USD' };
  const typed = { net_sales: 1, cogs: 1, labour: 1, cash_on_hand: 9997, morale_score: 9, hires_needed: 5, turnover_pct: 39, review_rating: 4.69, reviews_count: 61, projected_lunch: 2700, business_date: '2026-11-16' };
  const r = siteRow({ id: 'a', name: 'Delta Center', venue, typed });
  assert.equal(r.net, 7900);
  assert.equal(r.labourPct, 30);
  assert.equal(r.cogsPct, 30);
  assert.equal(r.prime, 60);
  assert.equal(r.tone, 'orn');
  assert.deepEqual(r.from, { net: 'till', labour: 'till', cogs: 'stock' });
  assert.equal(r.momPct, -0.6);
  assert.equal(r.wowPct, 3.2);
  assert.equal(r.cash, 9997);
  assert.equal(r.moraleWord, 'Strong');
  assert.equal(r.code, 'DLC');
  assert.equal(r.projected.lunch, 2700);
  assert.equal(r.currency, 'USD');
});

test('siteRow: no till figures, typed sales, COGS and labour carry the row', () => {
  const typed = { net_sales: 5230, cogs: 1510, labour: 1560 };
  const r = siteRow({ id: 'b', name: 'Provo', venue: null, typed });
  assert.equal(r.net, 5230);
  assert.equal(r.cogsPct, 28.9);
  assert.equal(r.labourPct, 29.8);
  assert.equal(r.prime, 58.7);
  assert.deepEqual(r.from, { net: 'typed', labour: 'typed', cogs: 'typed' });
});

test('siteRow: till sales with no stock and no typed COGS leaves prime cost null, never 0', () => {
  const r = siteRow({ id: 'c', name: 'Sandy', venue: { today: { net_sales: 4200, labour: 1300 } }, typed: null });
  assert.equal(r.net, 4200);
  assert.equal(r.labourPct, 31);
  assert.equal(r.cogsPct, null);
  assert.equal(r.prime, null);
  assert.equal(r.tone, null);
  assert.equal(r.morale, null);
});

test('siteRow: a till day of zero sales does not hide a typed day', () => {
  const r = siteRow({ id: 'd', name: 'Woodbine', venue: { today: { net_sales: 0, labour: 0 } }, typed: { net_sales: 4800, cogs: 1400, labour: 1580 } });
  assert.equal(r.net, 4800);
  assert.equal(r.from.net, 'typed');
  assert.equal(r.prime, 62.1);
});

test('rankSites: lowest prime cost first, no figure last, sales break ties', () => {
  const rows = [
    { id: 'a', name: 'A', prime: 62, net: 100 },
    { id: 'b', name: 'B', prime: null, net: 900 },
    { id: 'c', name: 'C', prime: 57.5, net: 50 },
    { id: 'd', name: 'D', prime: 62, net: 200 },
  ];
  const ranked = rankSites(rows);
  assert.deepEqual(ranked.map((r) => r.id), ['c', 'd', 'a', 'b']);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3, null]);
});

test('portfolio: weighted prime cost, averages and sums', () => {
  const rows = [
    { id: 'a', prime: 50, net: 1000, morale: 9, hires: 5, cash: 100, turnoverPct: 40, rating: 4.0, reviews: 10 },
    { id: 'b', prime: 70, net: 3000, morale: 7, hires: 2, cash: 50, turnoverPct: 60, rating: 5.0, reviews: 30 },
    { id: 'c', prime: null, net: 500, morale: null, hires: null, cash: null, turnoverPct: null, rating: null, reviews: null },
  ];
  const p = portfolio(rows);
  assert.equal(p.prime, 65);        // (500 + 2100) / 4000
  assert.equal(p.primeSites, 2);
  assert.equal(p.netToday, 4500);
  assert.equal(p.morale, 8);
  assert.equal(p.hires, 7);
  assert.equal(p.cash, 150);
  assert.equal(p.turnover, 50);
  assert.equal(p.rating, 4.75);     // weighted by reviews
  assert.equal(p.reviews, 40);
  assert.equal(p.leader.id, 'a');
  assert.deepEqual(portfolio([]).prime, null);
});

test('shortCode: three letters a human would pick', () => {
  assert.equal(shortCode('Delta Center'), 'DLC');
  assert.equal(shortCode('Provo'), 'PRV');
  assert.equal(shortCode('Milk Block'), 'MLB');
  assert.equal(shortCode('Sandy'), 'SND');
  assert.equal(shortCode('Woodbine'), 'WDB');
  assert.equal(shortCode('Daybreak'), 'DYB');
  assert.equal(shortCode('Coffee Boy Leeds City'), 'CBL');
  assert.equal(shortCode(''), '');
});

test('shortMoney: thousands shortened, small sums whole', () => {
  assert.equal(shortMoney(7900), '$7.9k');
  assert.equal(shortMoney(33856), '$34k');
  assert.equal(shortMoney(412), '$412');
  assert.equal(shortMoney(1703.3, 'GBP'), '£1.7k');
  assert.equal(shortMoney(-250), '-$250');
  assert.equal(shortMoney(null), null);
});
