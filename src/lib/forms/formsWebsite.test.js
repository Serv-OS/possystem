// Marketing forms (5.12.40) on the website builder, the hosted page and the embed: the server
// rendered form works with no JavaScript, the AI tool and the validators accept the Form block,
// and source pins for the paths that must never change shape (the plain post, CORS, the fences).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderPage, renderBlock, buildCtx } from '../../surfaces/website/ssr/renderBlocks.js';
import { resolveRoute } from '../../surfaces/website/routes.js';
import { BLOCK_SCHEMAS, defaultPropsFor, normaliseProps, jsonSchemaFor } from '../../surfaces/website/blocks/schema.js';
import { puckField } from '../../surfaces/website/blocks/puckFields.js';
import { validateLayout, validatePatch, setDefaultSchemas } from '../website/validatePatch.js';
import { CONTRACT_BLOCK_TYPES } from '../../../supabase/functions/_shared/websiteRules.js';
import { schemasFromModule, buildPatchTool } from '../../../api/_lib/website/schemaToTool.js';
import { formIdsOf, siteOpsLocationIds, formsForPage } from '../../../api/_lib/website/formsForPage.js';
import { hostedPage, loaderScript } from '../../../api/form.js';
import { formHtml, submitUrl, FORM_CSS, enhanceScript } from './formHtml.js';
import { HONEYPOT_FIELD } from './formRules.js';
import * as schemaModule from '../../surfaces/website/blocks/schema.js';

const read = (p) => fs.readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
const FORM_ID = '11111111-1111-4111-8111-111111111111';
const VENUE = '7218c716-eeb4-4f96-b284-f3500823595c';
const FORM = {
  id: FORM_ID, name: 'Win a pizza', consent_enabled: true, consent_text: 'Yes, send me <offers>.', submit_label: 'Enter', thanks_text: 'Thanks, good luck!',
  fields: [
    { id: 'first_name', kind: 'first_name', label: 'First name', required: true },
    { id: 'email', kind: 'email', label: 'Email', required: true },
    { id: 'size', kind: 'dropdown', label: 'Favourite size', options: ['Small', 'Large'] },
    { id: 'msg', kind: 'text', label: 'Message', long: true },
    { id: 'adult', kind: 'tickbox', label: 'I am 18 or over', required: true },
  ],
};
const ACTION = submitUrl('https://tbetcegmszzotrwdtqhi.supabase.co/');

function site(blocks) {
  return {
    site: { slug: 'mozz', theme: {}, nav: [], footer: {}, seo: {}, settings: {} },
    pages: [{ id: 'p1', slug: 'join', title: 'Join', kind: 'custom', status: 'published', layout: { root: { props: {} }, content: blocks } }],
    posts: [], locations: [{ id: 'loc1', ops_location_id: VENUE, name: 'Provo', online_slug: 'location1', timezone: 'Europe/London', currency: 'GBP' }],
  };
}
const formBlock = (over = {}) => ({ type: 'Form', props: { id: 'b1', form_id: FORM_ID, title: 'Win a pizza', sub: 'Every Friday', ...over } });
const render = (snapshot, extra = {}) => renderPage({ snapshot, route: resolveRoute(snapshot, '/join'), path: '/join', host: 'mozz.sites.serv-os.app', forms: { [FORM_ID]: FORM }, formAction: ACTION, ...extra });

test('the server rendered Form block is a real <form method="post"> that needs no JavaScript', () => {
  const out = render(site([formBlock()]));
  const m = /<section class="w-block w-formblock" data-block="Form"[\s\S]*?<\/section>/.exec(out.body);
  assert.ok(m, 'the block is on the page');
  const html = m[0];
  assert.match(html, new RegExp(`<form class="w-form-form" method="post" action="https://tbetcegmszzotrwdtqhi\\.supabase\\.co/functions/v1/form-submit" data-servos-form="${FORM_ID}"`));
  assert.match(html, new RegExp(`<input type="hidden" name="form_id" value="${FORM_ID}">`));
  assert.match(html, /<input type="hidden" name="return_to" value="https:\/\/mozz\.sites\.serv-os\.app\/join">/);
  assert.match(html, /<input type="hidden" name="source" value="website">/);
  assert.match(html, new RegExp(`name="${HONEYPOT_FIELD}" tabindex="-1" autocomplete="off"`));
  assert.match(html, /<input class="w-form-input" type="email" id="[^"]+" name="email" autocomplete="email" maxlength="200" required/);
  assert.match(html, /<select class="w-form-input"[^>]* name="size"><option value="">Choose<\/option><option value="Small">Small<\/option>/);
  assert.match(html, /<textarea class="w-form-input"[^>]* name="msg"/);
  assert.match(html, /<input type="checkbox" id="[^"]+" name="adult" value="on" required/);
  assert.match(html, /<input type="checkbox" id="form-[^"]+-consent" name="consent" value="on"> <span>Yes, send me &lt;offers&gt;\.<\/span>/, 'the venue\'s words, escaped, never pre-ticked');
  assert.doesNotMatch(html, /name="consent" value="on" checked/);
  assert.match(html, /<button type="submit" class="w-btn w-btn-primary w-form-submit">Enter<\/button>/);
  assert.match(html, /<h2 class="w-form-title">Win a pizza<\/h2><p class="w-form-sub">Every Friday<\/p>/);
  assert.doesNotMatch(html, /<script/, 'nothing in the form needs a script');
  assert.match(out.head, /\.w-form-input\{/, 'the form CSS ships in the page head');
});

test('after a plain post the page paints the thank you words, or the error line', () => {
  const sent = render(site([formBlock()]), { formState: { sent: FORM_ID, errorFor: null, error: '' } });
  assert.match(sent.body, /<p class="w-form-thanks" role="status">Thanks, good luck!<\/p>/);
  assert.doesNotMatch(sent.body, /<form class="w-form-form"/);
  const failed = render(site([formBlock()]), { formState: { sent: null, errorFor: FORM_ID, error: 'Please enter a real email address.' } });
  assert.match(failed.body, /<p class="w-form-error" role="alert">Please enter a real email address\.<\/p>/);
  assert.match(failed.body, /<form class="w-form-form"/);
  const other = render(site([formBlock()]), { formState: { sent: '99999999-9999-4999-8999-999999999999', errorFor: null, error: '' } });
  assert.match(other.body, /<form class="w-form-form"/, 'another form\'s outcome changes nothing here');
});

test('a Form block inside a Row column renders too; no form, an unknown form or a foreign one paints nothing', () => {
  const row = { type: 'Row', props: { id: 'r1', columns: '2', col1: [formBlock({ id: 'b2' })], col2: [] } };
  assert.match(render(site([row])).body, /data-block="Form" data-id="b2" data-nested="true"/);
  assert.doesNotMatch(render(site([formBlock()]), { forms: {} }).body, /data-block="Form"/);
  assert.doesNotMatch(render(site([formBlock({ form_id: '' })])).body, /data-block="Form"/);
  const ctx = buildCtx({ snapshot: site([]), host: 'h', path: '/' });
  assert.equal(renderBlock(ctx, formBlock()), '', 'no forms in the context: nothing, never a throw');
  assert.equal(renderBlock(ctx, { type: 'Form', props: null }), '');
});

test('the block schema: Form is a ServOS block with a form picker, strings to the AI and the validators', () => {
  assert.equal(BLOCK_SCHEMAS.Form.group, 'servos');
  assert.equal(BLOCK_SCHEMAS.Form.props.form_id.type, 'form');
  assert.deepEqual(defaultPropsFor('Form'), { form_id: '', title: '', sub: '', width: 'page' });
  assert.equal(normaliseProps('Form', { form_id: 42 }).form_id, '42');
  assert.deepEqual(jsonSchemaFor('Form').properties.form_id.type, 'string');
  assert.equal(puckField(BLOCK_SCHEMAS.Form.props.form_id).type, 'text', 'no renderer (tests): a text box');
  const custom = puckField(BLOCK_SCHEMAS.Form.props.form_id, { renderers: { form: () => 'picker' } });
  assert.equal(custom.type, 'custom', 'the editor shows the form dropdown');
  assert.ok(CONTRACT_BLOCK_TYPES.includes('Form'), 'website-admin (no schema module) accepts it');
});

test('the AI designer tool and every validator accept a Form block, and refuse a junk form id', () => {
  const tool = buildPatchTool(schemasFromModule(schemaModule));
  const json = JSON.stringify(tool);
  assert.match(json, /"Form"/);
  const layout = { root: { props: {} }, content: [formBlock()] };
  setDefaultSchemas(null);
  assert.equal(validateLayout(layout).ok, true, 'no schema (website-admin)');
  assert.equal(validateLayout(layout, { schemas: BLOCK_SCHEMAS }).ok, true, 'with the registry (Back Office, designer)');
  const bad = validateLayout({ root: { props: {} }, content: [formBlock({ form_id: '"><script>' })] }, { schemas: BLOCK_SCHEMAS });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /form id/);
  const empty = validateLayout({ root: { props: {} }, content: [formBlock({ form_id: '' })] }, { schemas: BLOCK_SCHEMAS });
  assert.equal(empty.ok, true, 'not picked yet is fine');
  const patch = validatePatch({ reply: 'Added your sign up form.', pages: [{ slug: 'join', title: 'Join', kind: 'custom', layout }] }, { schemas: BLOCK_SCHEMAS });
  assert.equal(patch.ok, true, patch.errors && patch.errors.join(' '));
});

test('the server reads only the page\'s forms, fenced to the website\'s own venues', async () => {
  const s = site([formBlock(), { type: 'Row', props: { id: 'r', columns: '2', col1: [formBlock({ id: 'b3', form_id: '22222222-2222-4222-8222-222222222222' })], col2: [formBlock({ id: 'b4' })] } }]);
  assert.deepEqual(formIdsOf(s.pages[0]), [FORM_ID, '22222222-2222-4222-8222-222222222222']);
  assert.deepEqual(siteOpsLocationIds(s), [VENUE]);
  const calls = [];
  const ops = { rpc: async (name, args) => { calls.push([name, args]); return args.p_form_id === FORM_ID ? { data: FORM, error: null } : { data: null, error: null }; } };
  const forms = await formsForPage(ops, s.pages[0], s);
  assert.deepEqual(Object.keys(forms), [FORM_ID]);
  assert.deepEqual(calls.map((c) => c[0]), ['marketing_form_public', 'marketing_form_public']);
  assert.deepEqual(calls[0][1].p_location_ids, [VENUE], 'the fence: this website\'s venues');
  assert.deepEqual(await formsForPage({ rpc: async () => { throw new Error('down'); } }, s.pages[0], s), {}, 'a failed read never breaks the page');
  assert.deepEqual(await formsForPage(ops, s.pages[0], { locations: [] }), {}, 'no venues: no read');
});

test('the hosted page behind the embed: a whole document, noindex, real form, themed, tells the parent its height', () => {
  const html = hostedPage({ form: FORM, branding: { brand_color: '#c8493b', display_name: 'Provo Pizza' }, venueName: 'Provo Pizza', origin: 'https://app.serv-os.app', action: ACTION, embed: true });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, new RegExp(`<input type="hidden" name="return_to" value="https://app\\.serv-os\\.app/api/form\\?embed=1&amp;id=${FORM_ID}">`));
  assert.match(html, /<input type="hidden" name="source" value="embed">/);
  assert.match(html, /method="post" action="https:\/\/tbetcegmszzotrwdtqhi\.supabase\.co\/functions\/v1\/form-submit"/);
  assert.match(html, /:root\{--w-bg:/, 'the venue Appearance palette');
  assert.match(html, /servos-form-height/);
  assert.doesNotMatch(html, /<script src=/, 'no outside script');
  assert.doesNotMatch(FORM_CSS, /#[0-9a-f]{3,6}\b/i, 'the form CSS has no literal colour: the theme decides');
  const thanks = hostedPage({ form: FORM, origin: 'https://app.serv-os.app', action: ACTION, state: { sent: FORM_ID } });
  assert.match(thanks, /Thanks, good luck!/);
  assert.doesNotMatch(thanks, /<form /);
  assert.match(hostedPage({ form: null, origin: '' }), /This form is not available\./);
});

test('the loader script: one iframe, grows on a message from our origin only', () => {
  const js = loaderScript(FORM_ID, 'https://app.serv-os.app/');
  assert.match(js, /if\(e\.origin!==origin\)return;/);
  assert.match(js, /f\.src=origin\+'\/api\/form\?embed=1&id='\+id/);
  assert.match(js, /Math\.min\(4000,/);
  assert.doesNotMatch(js, /eval|innerHTML|document\.write/);
  assert.doesNotThrow(() => new Function(js), 'it parses');
});

test('the fetch enhancement falls back to the plain post when fetch fails', () => {
  const js = enhanceScript({ onChange: '__svH' });
  assert.match(js, /\.catch\(function\(\)\{f\.__plain=1;f\.submit\(\)\}\)/);
  assert.match(js, /'content-type':'application\/json'/);
  assert.doesNotThrow(() => new Function(js));
  assert.equal(formHtml(null, {}), '', 'no form, no markup');
});

// ── source pins ──────────────────────────────────────────────────────────────────────────────

test('form-submit: public, CORS here only, a plain post answers 303 to an allowed page, sends after the answer', () => {
  const src = read('supabase/functions/form-submit/index.ts');
  assert.match(src, /'Access-Control-Allow-Origin': '\*'/);
  assert.match(src, /const plain = !type\.includes\('application\/json'\);/);
  assert.match(src, /status: 303, headers: \{ \.\.\.cors, Location: location/);
  assert.match(src, /\(await allowedBack\(back\)\) && back \? back : new URL\(`\$\{APP_ORIGIN\}\/api\/form\?id=\$\{formId\}`\)/, 'never an open redirect');
  assert.match(src, /isOwnHost\(u\.hostname, CUSTOMER_DOMAIN\)/);
  assert.match(src, /rt\.waitUntil\(p\)/, 'automations after the answer');
  assert.match(src, /LIMITS\.MAX_PAYLOAD_BYTES/);
  assert.doesNotMatch(src, /secondStepRefusal/, 'a public path has no login to check');
  assert.match(src, /runFormSubmit\(raw, \{/);
  // Only the submit endpoint opens CORS on the app side: the hosted page and the loader set none.
  assert.doesNotMatch(read('api/form.js'), /Access-Control-Allow-Origin/);
  const site = read('api/site.js');
  assert.doesNotMatch(site, /Access-Control-Allow-Origin/);
  assert.match(site, /formsForPage\(ops, route\.page, snapshot\)/);
  assert.match(site, /bootScript\(\{ snapshot, path: pagePath, host, preview, status, forms, formAction, reviews \}\)/);   // 5.12.67: reviews ride the same boot
});

test('marketing-forms: second step, company from the venue, an id must be mine', () => {
  const src = read('supabase/functions/marketing-forms/index.ts');
  const lines = src.split('\n');
  const serve = lines.findIndex((l) => /Deno\.serve\(async \(req\) => \{/.test(l));
  assert.match(lines[serve + 2], /secondStepRefusal\(req\)/);
  assert.match(src, /const org_id = await orgFor\(ops\);/);
  assert.match(src, /\.from\('marketing_forms'\)\.select\('id'\)\.eq\('id', id\)\.eq\('org_id', org_id\)\.maybeSingle\(\);\s*\n\s*if \(!mine\) return json\(\{ error: 'form not found' \}, 404\);/);
  assert.match(src, /normaliseFormDef\(incoming\)/);
  assert.doesNotMatch(src, /upsert\(/, 'never an upsert on a caller id');
});

test('marketing-workflows: a form trigger must name my form, and an automation id must be mine', () => {
  const src = read('supabase/functions/marketing-workflows/index.ts');
  assert.match(src, /trig\.type === 'form_submitted'/);
  assert.match(src, /\.from\('marketing_forms'\)\.select\('id'\)\.eq\('id', fid\)\.eq\('org_id', org_id\)/);
  assert.match(src, /\.from\('workflows'\)\.select\('id'\)\.eq\('id', String\(incoming\.id\)\)\.eq\('org_id', org_id\)/);
});

test('the workflow engine: one enrollment per form run, rounds keyed apart, no code without a channel, codes attributed', () => {
  const src = read('supabase/functions/_shared/workflow-engine.ts');
  assert.match(src, /if \(opts\.enrollmentId\) dueQ = dueQ\.eq\('id', opts\.enrollmentId\);/);
  assert.match(src, /const stepKey = roundStepKey\(step\.key \|\| `s\$\{idx\}`, en\.round\);/);
  assert.match(src, /error: 'no_channel'/);
  assert.match(src, /issueCode\(sb, org, offer, en\.customer_id, \{ form_id: formId, workflow_id: wf\.id \}\)/);
  assert.match(src, /if \(withAttrib && missingColumn\(error\)\)/, 'a database without the SQL still issues codes');
});

test('the SQL: submissions forced and written by nobody but the service role; the public read is narrow', () => {
  const sql = read('supabase/migrations/20261111a_OPS_marketing_forms.sql');
  assert.match(sql, /OPS DB ONLY \(tbetcegmszzotrwdtqhi\)/);
  assert.match(sql, /alter table public\.marketing_form_submissions force row level security;/);
  assert.match(sql, /create policy marketing_form_submissions_read on public\.marketing_form_submissions for select to authenticated\s*\n\s*using \(org_id::text in \(select public\.user_accessible_orgs\(\)\)\);/);
  assert.doesNotMatch(sql, /for (insert|update|delete|all)/i, 'no write rule for anyone');
  assert.match(sql, /revoke all on public\.marketing_form_submissions from anon;/);
  assert.match(sql, /revoke insert, update, delete, truncate on public\.marketing_form_submissions from authenticated;/);
  assert.doesNotMatch(sql, /alter table public\.marketing_forms force row level security/, 'the public read runs as the owner (see the file header)');
  assert.match(sql, /security definer\s*\n\s*set search_path to ''/);
  assert.match(sql, /and f\.status = 'active'/);
  assert.match(sql, /grant execute on function public\.marketing_form_public\(uuid, uuid\[\]\) to anon, authenticated;/);
  assert.match(sql, /pg_column_size\(answers\) <= 16384/);
  assert.doesNotMatch(sql, /\bbegin;|\bcommit;/i, 'the SQL editor chokes on a transaction wrapper');
  const rb = read('supabase/migrations/20261111a_OPS_marketing_forms_ROLLBACK.sql');
  assert.match(rb, /drop table if exists public\.marketing_form_submissions;/);
});

test('the Back Office: Forms under Customers, lazy; Automations offers the trigger and the promo step', () => {
  const nav = read('src/lib/boSections.js');
  assert.match(nav, /\['quicksend','Quick send'\],\['marketing-forms','Forms'\],\['workflows','Automations'\]/);
  const bo = read('src/backoffice/BackOfficeApp.jsx');
  assert.match(bo, /const Forms = lazy\(\(\) => import\('\.\/sections\/marketing\/Forms'\)\);/);
  const wf = read('src/backoffice/sections/marketing/Workflows.jsx');
  assert.match(wf, /<option value="form_submitted">Form submitted<\/option>/);
  assert.match(wf, /\+ Send a promo code/);
  assert.match(wf, /\{\{promo_code\}\}/);
});

test('no long dashes in any forms file (Peter\'s rule)', () => {
  const files = ['supabase/functions/_shared/formRules.js', 'supabase/functions/_shared/formSubmitRun.js', 'supabase/functions/form-submit/index.ts',
    'supabase/functions/marketing-forms/index.ts', 'supabase/migrations/20261111a_OPS_marketing_forms.sql', 'supabase/migrations/20261111a_OPS_marketing_forms_ROLLBACK.sql',
    'src/lib/forms/formHtml.js', 'src/lib/forms/formRules.js', 'src/backoffice/sections/marketing/Forms.jsx', 'src/surfaces/website/blocks/components/FormBlock.jsx',
    'src/surfaces/website/formsOnPage.js', 'api/form.js', 'api/_lib/website/formsForPage.js', 'src/lib/forms/memDb.js',
    'src/lib/forms/formRules.test.js', 'src/lib/forms/formSubmitRun.test.js', 'src/lib/forms/formsWebsite.test.js', 'docs/forms/RELEASE.md'];
  for (const f of files) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f);
});
