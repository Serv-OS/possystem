// node --test: custom domain rules shared by website-domain (contract section 3 and 13 A):
// hostname cleaning, the records a venue adds, the DNS over HTTPS answer parser, Vercel TXT
// records and the stored domain_status.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseHostname, apexFor, buildDomainRecords, parseDnsAnswer, recordSatisfied, txtRecordsFromVercel,
  domainStatusFrom, sslStateFrom, hostLookupKey, freeHostFor, WEBSITE_CNAME_TARGET, WEBSITE_APEX_A,
} from '../../../supabase/functions/_shared/websiteRules.js';

test('normaliseHostname cleans what an owner types', () => {
  assert.equal(normaliseHostname('https://WWW.MozzPizza.com/menu?x=1'), 'www.mozzpizza.com');
  assert.equal(normaliseHostname('  mozzpizza.co.uk.  '), 'mozzpizza.co.uk');
  assert.equal(normaliseHostname('shop.mozz.pizza:443'), 'shop.mozz.pizza');
  assert.equal(normaliseHostname('mozz'), null);                 // no dot
  assert.equal(normaliseHostname('mozz..com'), null);            // empty label
  assert.equal(normaliseHostname('-mozz.com'), null);            // leading hyphen
  assert.equal(normaliseHostname('mozz.123'), null);             // numeric TLD
  assert.equal(normaliseHostname(''), null);
  assert.equal(normaliseHostname(null), null);
  // Our own hosts and Vercel's are never a custom domain.
  assert.equal(normaliseHostname('mozz.serv-os.app'), null);
  assert.equal(normaliseHostname('mozz.sites.serv-os.app'), null);
  assert.equal(normaliseHostname('x.vercel.app'), null);
  assert.equal(normaliseHostname('localhost'), null);
});

test('apexFor only for www hosts', () => {
  assert.equal(apexFor('www.mozzpizza.com'), 'mozzpizza.com');
  assert.equal(apexFor('WWW.Mozz.co.uk'), 'mozz.co.uk');
  assert.equal(apexFor('mozzpizza.com'), null);
  assert.equal(apexFor('shop.mozzpizza.com'), null);
  assert.equal(apexFor('www.com'), null);
});

test('buildDomainRecords: www host gets CNAME www + A @, other hosts one CNAME', () => {
  const www = buildDomainRecords('www.mozzpizza.com');
  assert.deepEqual(www, [
    { type: 'CNAME', name: 'www', host: 'www.mozzpizza.com', value: WEBSITE_CNAME_TARGET, ok: false },
    { type: 'A', name: '@', host: 'mozzpizza.com', value: WEBSITE_APEX_A, ok: false },
  ]);
  assert.equal(WEBSITE_CNAME_TARGET, 'sites.serv-os.app');
  assert.equal(WEBSITE_APEX_A, '76.76.21.21');
  const sub = buildDomainRecords('order.mozzpizza.com');
  assert.equal(sub.length, 1);
  assert.equal(sub[0].type, 'CNAME');
  assert.equal(sub[0].host, 'order.mozzpizza.com');
  assert.deepEqual(buildDomainRecords('nonsense'), []);
});

test('parseDnsAnswer reads dns.google replies by type, lower case, no trailing dot', () => {
  const cname = { Status: 0, Answer: [{ name: 'www.mozzpizza.com.', type: 5, TTL: 300, data: 'Sites.Serv-OS.app.' }] };
  assert.deepEqual(parseDnsAnswer(cname, 'CNAME'), ['sites.serv-os.app']);
  assert.deepEqual(parseDnsAnswer(cname, 'A'), []);
  const a = { Status: 0, Answer: [{ name: 'mozzpizza.com.', type: 1, data: '76.76.21.21' }, { name: 'mozzpizza.com.', type: 1, data: '76.76.21.98' }] };
  assert.deepEqual(parseDnsAnswer(a, 'A'), ['76.76.21.21', '76.76.21.98']);
  const txt = { Status: 0, Answer: [{ name: '_vercel.mozzpizza.com.', type: 16, data: '"vc-domain-verify=abc"' }] };
  assert.deepEqual(parseDnsAnswer(txt, 'TXT'), ['vc-domain-verify=abc']);
  assert.deepEqual(parseDnsAnswer({ Status: 3 }, 'A'), []);          // NXDOMAIN, no Answer
  assert.deepEqual(parseDnsAnswer(null, 'A'), []);
  assert.deepEqual(parseDnsAnswer('nope', 'A'), []);
});

test('recordSatisfied ignores case and trailing dots', () => {
  const rec = { type: 'CNAME', value: 'sites.serv-os.app' };
  assert.equal(recordSatisfied(rec, ['SITES.SERV-OS.APP.']), true);
  assert.equal(recordSatisfied(rec, ['cname.vercel-dns.com']), false);
  assert.equal(recordSatisfied(rec, []), false);
  assert.equal(recordSatisfied(null, ['x']), false);
});

test('txtRecordsFromVercel turns the verification array into TXT records', () => {
  const v = [{ type: 'TXT', domain: '_vercel.mozzpizza.com', value: 'vc-domain-verify=mozzpizza.com,abc', reason: 'pending_domain_verification' }];
  assert.deepEqual(txtRecordsFromVercel(v), [{ type: 'TXT', name: '_vercel.mozzpizza.com', host: '_vercel.mozzpizza.com', value: 'vc-domain-verify=mozzpizza.com,abc', ok: false }]);
  assert.deepEqual(txtRecordsFromVercel(undefined), []);
  assert.deepEqual(txtRecordsFromVercel([{ type: 'A' }]), []);
});

test('domainStatusFrom: pending, verified, live, error, none', () => {
  const recs = buildDomainRecords('www.mozzpizza.com');
  assert.equal(domainStatusFrom({ records: [], ssl: 'none' }).state, 'none');
  assert.equal(domainStatusFrom({ records: recs, ssl: 'none' }).state, 'pending');
  const allOk = recs.map((r) => ({ ...r, ok: true }));
  assert.equal(domainStatusFrom({ records: allOk, ssl: 'pending' }).state, 'verified');
  assert.equal(domainStatusFrom({ records: allOk, ssl: 'active' }).state, 'live');
  const err = domainStatusFrom({ records: allOk, ssl: 'active', error: 'Vercel did not answer.' });
  assert.equal(err.state, 'error');
  assert.equal(err.error, 'Vercel did not answer.');
  assert.ok(typeof err.checked_at === 'string' && !Number.isNaN(Date.parse(err.checked_at)));
  assert.equal('error' in domainStatusFrom({ records: allOk, ssl: 'active' }), false);
});

test('sslStateFrom reads the Vercel config answer', () => {
  assert.equal(sslStateFrom({ misconfigured: false }), 'active');
  assert.equal(sslStateFrom({ misconfigured: true }), 'pending');
  assert.equal(sslStateFrom(null, { verified: true }), 'pending');
  assert.equal(sslStateFrom(null, null), 'none');
});

test('hostLookupKey mirrors web_resolve_host', () => {
  assert.deepEqual(hostLookupKey('mozz.sites.serv-os.app'), { slug: 'mozz' });
  assert.deepEqual(hostLookupKey('MOZZ.sites.serv-os.app:443'), { slug: 'mozz' });
  assert.deepEqual(hostLookupKey('a.b.sites.serv-os.app'), null);
  assert.deepEqual(hostLookupKey('www.mozzpizza.com'), { host: 'www.mozzpizza.com' });
  assert.deepEqual(hostLookupKey(''), null);
  assert.equal(freeHostFor('mozz'), 'mozz.sites.serv-os.app');
});
