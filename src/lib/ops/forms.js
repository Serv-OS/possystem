// src/lib/ops/forms.js
//
// Operations Forms (28 Sep 2026, v5.11.4): the Supabase data layer.
// Tables ops_forms + ops_form_submissions and the private 'ops-files' bucket, all from
// migration 20260928c_OPS_documents_forms.sql, which Peter runs. Until it has run every read
// comes back { absent: true } and the screens say "not set up yet"; nothing throws.
//
// Who may do what (row level security, the module's existing rule):
//   * forms (the questions): read by Back Office and the venue's tablets; written by Back
//     Office only, like checklist templates. Archived, never deleted.
//   * submissions: ADDED by the venue's tablets and Back Office; READ by Back Office only,
//     because they hold personal data (the Accident book). Never changed, never deleted.
//     A tablet cannot read a submission back, so its insert asks for nothing back.
//   * photos and signatures: under <venue>/forms/<submission>/ in 'ops-files'; Back Office
//     reads them through short lived signed links.
//
// The submitted time is stamped by the database, never by the device clock.

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { isTrainingMode } from '../trainingMode';
import {
  OPS_FILES_BUCKET, VIEW_URL_SECONDS, NOT_SET_UP, FILE_TYPES,
  normaliseField, normaliseForm, validateFormDef, validateAnswers, cleanAnswers, formFromTemplate,
  dataUrlToBytes, extForMime, contentTypeFor, fileExtension, formFilePath, shortTag,
  submissionFilePaths, isAbsentError, isUuid, newId,
} from './formRules';

async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

const NOT_LIVE = 'This needs a live connection to ServOS.';
const NO_VENUE = 'The venue is not resolved yet. Reopen this screen and try again.';

const formFromRow = (r) => ({
  id: r.id, locationId: r.location_id, name: r.name, description: r.description || '',
  fields: Array.isArray(r.fields) ? r.fields.map(normaliseField) : [],
  templateKey: r.template_key || null, version: Number(r.version) || 1,
  createdAt: r.created_at, updatedAt: r.updated_at, updatedByName: r.updated_by_name || null,
  archivedAt: r.archived_at,
});
const subFromRow = (r) => ({
  id: r.id, formId: r.form_id, formName: r.form_name, formVersion: Number(r.form_version) || 1,
  fields: Array.isArray(r.fields) ? r.fields.map(normaliseField) : [],
  answers: r.answers && typeof r.answers === 'object' ? r.answers : {},
  submittedByName: r.submitted_by_name || '', source: r.source, submittedAt: r.submitted_at,
});

const loadFail = (error, what) => (isAbsentError(error)
  ? { data: [], error, absent: true, message: NOT_SET_UP.forms }
  : { data: [], error, absent: false, message: `Could not load ${what}. Try again.` });

/** Forms at the venue (active first by name). { data, error, absent, message }. */
export async function fetchForms(locationId = null, { includeArchived = false } = {}) {
  if (isMock || !supabase) return { data: [], error: null, absent: false, message: '' };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null, absent: false, message: '' };
  try {
    let q = supabase.from('ops_forms').select('*').eq('location_id', locationId);
    if (!includeArchived) q = q.is('archived_at', null);
    const { data, error } = await q.order('name');
    if (error) return loadFail(error, 'forms');
    return { data: (data || []).map(formFromRow), error: null, absent: false, message: '' };
  } catch (e) {
    return loadFail(e, 'forms');
  }
}

const saveFail = (error) => {
  if (isAbsentError(error)) return new Error(NOT_SET_UP.forms);
  if (String(error?.code) === '23505') return new Error('This venue already has that ready made form. Archive the old one first.');
  return error instanceof Error ? error : new Error(error?.message || String(error));
};

/**
 * Create or update a form (Back Office only). An update is compare and set on `version`,
 * so two Back Office tabs can never silently overwrite each other's questions.
 */
export async function saveForm(form, locationId = null, byName = null) {
  if (isMock || !supabase) return { data: null, error: new Error(NOT_LIVE) };
  const n = normaliseForm(form);
  const v = validateFormDef(n);
  if (!v.ok) return { data: null, error: new Error(v.errors[0] || 'Check the questions.'), fieldErrors: v.fieldErrors };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error(NO_VENUE) };
  const now = new Date().toISOString();
  const row = { name: n.name, description: n.description || null, fields: n.fields, updated_by_name: byName || null, updated_at: now };
  try {
    if (form.id) {
      const base = Number(form.version) || 1;
      const { data, error } = await supabase.from('ops_forms').update({ ...row, version: base + 1 })
        .eq('location_id', locationId).eq('id', form.id).eq('version', base).select('*');
      if (error) return { data: null, error: saveFail(error) };
      if (!data || !data.length) return { data: null, error: new Error('NOT saved. This form was changed somewhere else, or this login cannot edit forms at this venue. Reload and try again.') };
      return { data: formFromRow(data[0]), error: null };
    }
    const { data, error } = await supabase.from('ops_forms').insert({
      ...row, location_id: locationId, template_key: form.templateKey || null, version: 1, created_by_name: byName || null,
    }).select('*');
    if (error) return { data: null, error: saveFail(error) };
    if (!data || !data.length) return { data: null, error: new Error('NOT saved. This login may not have access to this venue.') };
    return { data: formFromRow(data[0]), error: null };
  } catch (e) {
    return { data: null, error: saveFail(e) };
  }
}

/** Add a ready made form (the Accident book) in one tap. */
export async function addFormFromTemplate(key, locationId = null, byName = null) {
  const t = formFromTemplate(key);
  if (!t) return { data: null, error: new Error('Unknown template') };
  return saveForm(t, locationId, byName);
}

async function setFormArchived(id, locationId, archivedAt) {
  if (isMock || !supabase) return { error: new Error(NOT_LIVE) };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error(NO_VENUE) };
  const { data, error } = await supabase.from('ops_forms').update({ archived_at: archivedAt, updated_at: new Date().toISOString() })
    .eq('location_id', locationId).eq('id', id).select('id');
  if (error) return { error: saveFail(error) };
  if (!data || !data.length) return { error: new Error('Not changed. Only a Back Office login for this venue can archive forms.') };
  return { error: null };
}
/** Archive a form: it leaves the tablet; its submissions stay readable in Back Office. */
export const archiveForm = (id, locationId = null) => setFormArchived(id, locationId, new Date().toISOString());
export const restoreForm = (id, locationId = null) => setFormArchived(id, locationId, null);

/**
 * Submit a completed form. Photos and the signature upload first, each to its own path, then
 * the row goes in. Pass the same `submissionId` on a retry: a row that already landed (the
 * answer was lost on the way back) is then reported as saved, never written twice.
 * @returns {{ data: {id}|null, error: Error|null, fieldErrors?: object, duplicate?: boolean }}
 */
export async function submitForm({ form, answers, operator = null, source = 'tablet', submissionId = null } = {}, locationId = null) {
  if (isMock || !supabase) return { data: null, error: new Error(NOT_LIVE) };
  // TRAINING MODE never writes a real record (an Accident book entry above all).
  if (isTrainingMode()) return { data: null, error: new Error('Training mode: this form was not saved.') };
  if (!form?.id) return { data: null, error: new Error('No form') };
  const fields = (form.fields || []).map(normaliseField);
  const v = validateAnswers(fields, answers);
  if (!v.ok) return { data: null, error: new Error('Some answers need attention.'), fieldErrors: v.errors };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error(NO_VENUE) };
  const id = isUuid(submissionId) ? submissionId : newId();
  const clean = cleanAnswers(fields, answers);
  try {
    for (const f of fields) {
      if (!FILE_TYPES.includes(f.type) || clean[f.id] == null) continue;
      const value = clean[f.id];
      let body; let contentType; let ext;
      if (f.type === 'signature') {
        const d = dataUrlToBytes(value);
        if (!d) return { data: null, error: new Error('The signature could not be read. Clear it and sign again.'), fieldErrors: { [f.id]: 'Sign again.' } };
        body = new Blob([d.bytes], { type: d.mime }); contentType = d.mime; ext = extForMime(d.mime) || 'png';
      } else if (typeof value === 'object') {
        body = value; contentType = contentTypeFor(value); ext = extForMime(contentType) || fileExtension(value.name) || 'jpg';
      } else {
        continue;   // already a stored path
      }
      const path = formFilePath(locationId, id, f.id, ext, shortTag());
      const { error: upErr } = await supabase.storage.from(OPS_FILES_BUCKET)
        .upload(path, body, { upsert: false, contentType, cacheControl: '3600' });
      if (upErr) {
        if (isAbsentError(upErr)) return { data: null, error: new Error(NOT_SET_UP.forms) };
        return { data: null, error: new Error(`${f.label || 'A photo'} did not upload, so the form was NOT saved. Check the signal and try again.`), fieldErrors: { [f.id]: 'Upload failed. Try again.' } };
      }
      clean[f.id] = path;
    }
    const row = {
      id, location_id: locationId, form_id: form.id, form_name: String(form.name || 'Form').slice(0, 200),
      form_version: Number(form.version) || 1, fields, answers: clean,
      submitted_by_name: operator?.name || null, submitted_by_staff_id: isUuid(operator?.id) ? operator.id : null,
      source: source === 'back_office' ? 'back_office' : 'tablet',
    };
    // No .select(): a tablet may add a submission but never read one (manager only).
    const { error } = await supabase.from('ops_form_submissions').insert(row);
    if (error) {
      if (String(error.code) === '23505') return { data: { id }, error: null, duplicate: true };
      if (isAbsentError(error)) return { data: null, error: new Error(NOT_SET_UP.forms) };
      return { data: null, error: new Error(`The form was NOT saved: ${error.message || error}`) };
    }
    return { data: { id }, error: null };
  } catch (e) {
    return { data: null, error: new Error(`The form was NOT saved: ${e?.message || e}`) };
  }
}

/** Submissions of one form, newest first (Back Office only). Pass `before` (an ISO time) for
 *  the next page. { data, error, absent, message, more }. */
export async function fetchSubmissions(formId, locationId = null, { limit = 200, before = null } = {}) {
  if (isMock || !supabase) return { data: [], error: null, absent: false, message: '', more: false };
  locationId = await ensureLoc(locationId);
  if (!locationId || !formId) return { data: [], error: null, absent: false, message: '', more: false };
  try {
    let q = supabase.from('ops_form_submissions').select('*').eq('location_id', locationId).eq('form_id', formId);
    if (before) q = q.lt('submitted_at', before);
    const { data, error } = await q.order('submitted_at', { ascending: false }).limit(limit + 1);
    if (error) return { ...loadFail(error, 'submissions'), more: false };
    const rows = (data || []).map(subFromRow);
    return { data: rows.slice(0, limit), error: null, absent: false, message: '', more: rows.length > limit };
  } catch (e) {
    return { ...loadFail(e, 'submissions'), more: false };
  }
}

/** Signed links for every photo and signature in some submissions: { [path]: url }. */
export async function signSubmissionFiles(submissions, seconds = VIEW_URL_SECONDS) {
  if (isMock || !supabase) return {};
  const paths = [...new Set((submissions || []).flatMap(submissionFilePaths))];
  if (!paths.length) return {};
  const map = {};
  try {
    const { data } = await supabase.storage.from(OPS_FILES_BUCKET).createSignedUrls(paths, seconds);
    (data || []).forEach((d) => { if (d?.path && d?.signedUrl) map[d.path] = d.signedUrl; });
  } catch { /* the picture just will not show; the answer still reads "Photo attached" */ }
  return map;
}
