import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  accentReadout, bundleIdFor, cleanPayload, decideTenantWriter, defaultPayload, formProblems, slugify, withFormDefaults,
} from '../../supabase/functions/_shared/customerAppBrand.js';
import { validateTenantPayload } from '../../supabase/functions/_shared/customerAppRules.js';

const schema = JSON.parse(fs.readFileSync(new URL('../../supabase/functions/_shared/tenantAppSchema.json', import.meta.url), 'utf8'));

test('slugify turns an organisation name into an app id the gateway accepts', () => {
  assert.equal(slugify('Coffee Boy'), 'coffee-boy');
  assert.equal(slugify('  MOZZ Pizza & Co. '), 'mozz-pizza-co');
  assert.equal(slugify('123 Bar'), 'a123-bar');
  assert.equal(slugify(''), 'app');
  assert.equal(bundleIdFor('coffee-boy'), 'uk.co.servos.coffeeboy');
});

test('defaultPayload is complete and schema valid once cleaned', () => {
  const p = defaultPayload({ orgName: 'Coffee Boy', currency: 'gbp', locale: 'en-GB' });
  assert.ok(formProblems(p).some((s) => s.startsWith('Upload the logo')));
  p.logo = { light: 'https://cdn.example/light.svg', dark: 'https://cdn.example/dark.svg' };
  assert.deepEqual(formProblems(p), []);
  assert.deepEqual(validateTenantPayload(schema, cleanPayload(p)).errors, []);
  assert.equal(p.currency, 'GBP');
});

test('withFormDefaults fills what an old row lacks', () => {
  const p = withFormDefaults({ tenantId: 'mozz', displayName: 'MOZZ', color: { accent: '#A6412F' } }, defaultPayload({ orgName: 'x' }));
  assert.equal(p.color.ink, '#14110F');
  assert.equal(p.support.privacyUrl, '');
  assert.equal(p.modules.stamps, true);
});

test('formProblems names each bad field in plain words', () => {
  const p = defaultPayload({ orgName: 'Coffee Boy' });
  p.displayName = '';
  p.color.accent = 'red';
  p.shape.radius = 99;
  p.support.privacyUrl = 'ftp://x';
  const out = formProblems(p);
  assert.ok(out.includes('App name is required.'));
  assert.ok(out.some((s) => s.startsWith('Accent colour')));
  assert.ok(out.some((s) => s.startsWith('Corner radius')));
  assert.ok(out.some((s) => s.startsWith('privacy link')));
});

test('cleanPayload drops blank optional keys so the schema never sees an empty string', () => {
  const c = cleanPayload({ ...defaultPayload({ orgName: 'Coffee Boy' }), logo: { light: 'https://cdn.example/l.svg', dark: 'https://cdn.example/d.svg' } });
  assert.equal(c.icon, undefined);
  assert.equal(c.support, undefined);
  assert.equal(c.color.accent, '#A6412F');
  assert.equal(validateTenantPayload(schema, c).ok, true);
});

test('accentReadout passes a deep accent and corrects a pale one', () => {
  const deep = accentReadout('#A6412F');
  assert.equal(deep.passes, true);
  assert.equal(deep.accentText, '#A6412F');
  const pale = accentReadout('#F4C542');
  assert.equal(pale.passes, false);
  assert.notEqual(pale.accentText, '#F4C542');
  assert.ok(pale.ratio < 4.5);
});

test('decideTenantWriter: own org ok, second id for the org refused, another org id taken', () => {
  assert.equal(decideTenantWriter({ role: 'owner', orgId: 'o1', rowOrgId: null, orgRowTenantId: null, tenantId: 'a' }).ok, true);
  assert.equal(decideTenantWriter({ role: 'owner', orgId: 'o1', rowOrgId: 'o1', orgRowTenantId: 'a', tenantId: 'a' }).ok, true);
  assert.equal(decideTenantWriter({ role: 'owner', orgId: 'o1', rowOrgId: 'o2', orgRowTenantId: null, tenantId: 'a' }).code, 'tenant_taken');
  assert.equal(decideTenantWriter({ role: 'owner', orgId: 'o1', rowOrgId: null, orgRowTenantId: 'a', tenantId: 'b' }).code, 'org_has_app');
  assert.equal(decideTenantWriter({ role: 'manager', orgId: 'o1', rowOrgId: null, orgRowTenantId: null, tenantId: 'a' }).code, 'forbidden');
  assert.equal(decideTenantWriter({ role: 'super_admin', orgId: null, rowOrgId: 'o2', orgRowTenantId: null, tenantId: 'a' }).ok, true);
});
