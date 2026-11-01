// 5.12.1: the publishing terms gate (pure rules + the statement itself).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PUBLISH_TERMS, PUBLISH_TERMS_VERSION, publishTermsText } from './publishTerms.js';
import { publishTermsAccepted, publishTermsRecord, settingsProblems, validateSitePatch } from '../../../supabase/functions/_shared/websiteRules.js';

const read = (rel) => fs.readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

test('the statement names accessibility, disability law, liability and the owner responsibility', () => {
  const text = publishTermsText();
  for (const word of ['WCAG', 'Equality Act 2010', 'Americans with Disabilities Act', 'accessibility', 'indemnify', 'solely responsible', 'service agreement']) {
    assert.ok(text.includes(word), `statement names ${word}`);
  }
  assert.equal(PUBLISH_TERMS.version, PUBLISH_TERMS_VERSION);
  assert.ok(PUBLISH_TERMS.sections.length >= 8);
  assert.ok(!/[–—]/.test(text), 'no em or en dashes');
});

test('acceptance counts only for the current version with a time', () => {
  assert.equal(publishTermsAccepted({}), false);
  assert.equal(publishTermsAccepted(null), false);
  assert.equal(publishTermsAccepted({ publish_terms: { version: 'old', accepted_at: '2026-01-01T00:00:00.000Z' } }), false);
  assert.equal(publishTermsAccepted({ publish_terms: { version: PUBLISH_TERMS_VERSION } }), false);
  const rec = publishTermsRecord({ userId: 'u1', role: 'owner', now: new Date('2026-10-31T20:00:00Z') });
  assert.deepEqual(rec, { version: PUBLISH_TERMS_VERSION, accepted_at: '2026-10-31T20:00:00.000Z', accepted_by: 'u1', role: 'owner' });
  assert.equal(publishTermsAccepted({ publish_terms: rec }), true);
});

test('a settings copy carrying publish_terms still validates, so the channel switches keep saving', () => {
  assert.deepEqual(settingsProblems({ channels: { order: true }, publish_terms: { version: 'x', accepted_at: 'y' } }), []);
  assert.ok(settingsProblems({ publish_terms: 'nope' }).length === 1);
  assert.ok(validateSitePatch({ settings: { channels: { order: true }, publish_terms: { version: 'x', accepted_at: 'y' } } }).ok);
});

test('the publish action is gated on the server and save_site never writes the record', () => {
  const fn = read('supabase/functions/website-admin/index.ts');
  const publishAt = fn.indexOf("if (action === 'publish')");
  const gateAt = fn.indexOf('publishTermsAccepted(settings)', publishAt);
  const nowAt = fn.indexOf('await publishNow(site, note, caller.userId)', publishAt);
  assert.ok(publishAt > 0 && gateAt > publishAt && nowAt > gateAt, 'the gate runs before the publish');
  assert.ok(fn.includes("body.accept_terms !== PUBLISH_TERMS_VERSION") && fn.includes('terms_required: PUBLISH_TERMS_VERSION') && fn.includes(', 428)'));
  assert.ok(fn.includes('publishTermsRecord({ userId: caller.userId, role: caller.role })'));
  assert.ok(fn.includes('delete (clean.settings as Row).publish_terms;'));
  const client = read('src/lib/websiteAdmin.js');
  assert.ok(client.includes('accept_terms: acceptTerms'));
});

// 5.12.4: Peter accepted the statement and the server still answered 428 "Read and accept the
// publishing terms" because the screen's client wrapper forwarded the note alone. The accepted
// version must travel through every hop: screen -> hook -> adminClient -> websiteAdmin -> body.
test('the accepted terms version reaches the publish body through every client hop', () => {
  const client = read('src/backoffice/sections/website/adminClient.js');
  assert.match(client, /export const publishSite = \(note, opts, acceptTerms = null\) => run\('publishSite', note \|\| '', opts, acceptTerms\)/);
  const hook = read('src/backoffice/sections/website/useWebsite.js');
  assert.ok(hook.includes('admin.publishSite(note, undefined, acceptTerms)'));
  const lib = read('src/lib/websiteAdmin.js');
  assert.ok(lib.includes("{ action: 'publish', note, accept_terms: acceptTerms }"));
  const builder = read('src/backoffice/sections/website/WebsiteBuilder.jsx');
  assert.ok(builder.includes('runPublish(terms.note, PUBLISH_TERMS_VERSION)'));
});

test('a terms refusal is not a "changes are not saving" failure', () => {
  const lib = read('src/lib/websiteAdmin.js');
  assert.ok(lib.includes('e.terms_required = body.terms_required'));
  assert.ok(lib.includes('reportSave(entity, failure?.terms_required ? null : failure)'));
});
