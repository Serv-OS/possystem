// src/lib/ops/documents.js
//
// Operations Documents (28 Sep 2026, v5.11.4): the Supabase data layer.
// Table ops_documents + the private 'ops-files' bucket, both from migration
// 20260928c_OPS_documents_forms.sql, which Peter runs. Until it has run every read comes
// back { absent: true } and the screens say "not set up yet"; nothing throws.
//
// Who may do what (the module's existing rule, enforced by row level security):
//   * read and open: Back Office logins of the venue and the venue's paired Operations tablets
//   * upload: the same (a new record, like raising maintenance on the floor)
//   * archive or restore: Back Office logins only (a change to what is there, like templates)
//   * delete: nobody. A document is archived, never deleted.
//
// House pattern (lib/ops/data.js): resolve a real locationId, map snake_case to camelCase,
// return { data, error }, and treat a write that changed 0 rows as the refusal it is.

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { isTrainingMode } from '../trainingMode';
import {
  OPS_FILES_BUCKET, SIGNED_URL_SECONDS, NOT_SET_UP,
  checkDocumentDraft, contentTypeFor, documentPath, isAbsentError, isDocCategory, isUuid, newId, docOpenMode,
} from './formRules';

async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

const NOT_LIVE = 'This needs a live connection to ServOS.';
const NO_VENUE = 'The venue is not resolved yet. Reopen this screen and try again.';

const docFromRow = (r) => ({
  id: r.id, locationId: r.location_id, title: r.title, category: r.category,
  filePath: r.file_path, fileName: r.file_name, mimeType: r.mime_type, sizeBytes: Number(r.size_bytes) || 0,
  uploadedByName: r.uploaded_by_name, source: r.source, createdAt: r.created_at,
  archivedAt: r.archived_at, archivedByName: r.archived_by_name,
});

/** Documents at the venue, newest first. { data, error, absent, message }. */
export async function fetchDocuments(locationId = null, { includeArchived = false } = {}) {
  if (isMock || !supabase) return { data: [], error: null, absent: false, message: '' };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null, absent: false, message: '' };
  try {
    let q = supabase.from('ops_documents').select('*').eq('location_id', locationId);
    if (!includeArchived) q = q.is('archived_at', null);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(1000);
    if (error) {
      return isAbsentError(error)
        ? { data: [], error, absent: true, message: NOT_SET_UP.documents }
        : { data: [], error, absent: false, message: 'Could not load documents. Try again.' };
    }
    return { data: (data || []).map(docFromRow), error: null, absent: false, message: '' };
  } catch (e) {
    return { data: [], error: e, absent: isAbsentError(e), message: isAbsentError(e) ? NOT_SET_UP.documents : 'Could not load documents. Try again.' };
  }
}

/**
 * Upload a file and record it. The file goes first (under a new id's folder), then the row.
 * If the row is refused the file stays behind, unlisted and harmless.
 * @returns {{ data: object|null, error: Error|null, absent?: boolean }}
 */
export async function uploadDocument({ file, title, category, byName = null, byStaffId = null, source = 'back_office' } = {}, locationId = null) {
  if (isMock || !supabase) return { data: null, error: new Error(NOT_LIVE) };
  // TRAINING MODE never writes anything real.
  if (isTrainingMode()) return { data: null, error: new Error('Training mode: documents are not saved.') };
  const check = checkDocumentDraft({ title, category, file });
  if (!check.ok) return { data: null, error: new Error(Object.values(check.errors)[0]) };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error(NO_VENUE) };
  const id = newId();
  const path = documentPath(locationId, id, file.name);
  const contentType = contentTypeFor(file);
  try {
    const { error: upErr } = await supabase.storage.from(OPS_FILES_BUCKET)
      .upload(path, file, { upsert: false, contentType, cacheControl: '3600' });
    if (upErr) {
      if (isAbsentError(upErr)) return { data: null, error: new Error(NOT_SET_UP.documents), absent: true };
      return { data: null, error: new Error(`The file did not upload: ${upErr.message || upErr}`) };
    }
    const row = {
      id, location_id: locationId, title: String(title).trim().slice(0, 200),
      category: isDocCategory(category) ? category : 'other',
      file_path: path, file_name: String(file.name || 'file').slice(0, 300), mime_type: contentType,
      size_bytes: Number(file.size) || 0, uploaded_by_name: byName || null,
      uploaded_by_staff_id: isUuid(byStaffId) ? byStaffId : null,
      source: source === 'tablet' ? 'tablet' : 'back_office',
    };
    const { data, error } = await supabase.from('ops_documents').insert(row).select('*');
    if (error) {
      if (isAbsentError(error)) return { data: null, error: new Error(NOT_SET_UP.documents), absent: true };
      return { data: null, error: new Error(`The file uploaded but the document was NOT saved: ${error.message || error}`) };
    }
    if (!data || !data.length) return { data: null, error: new Error('The document was NOT saved. This login or tablet may not have access to this venue.') };
    return { data: docFromRow(data[0]), error: null };
  } catch (e) {
    return { data: null, error: new Error(`The document was NOT saved: ${e?.message || e}`) };
  }
}

async function setArchived(id, locationId, patch, what) {
  if (isMock || !supabase) return { error: new Error(NOT_LIVE) };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error(NO_VENUE) };
  const { data, error } = await supabase.from('ops_documents').update(patch)
    .eq('location_id', locationId).eq('id', id).select('id');
  if (error) return { error };
  // Row level security answers a refused update with success and 0 rows.
  if (!data || !data.length) return { error: new Error(`Could not ${what} it. Only a Back Office login for this venue can ${what} documents.`) };
  return { error: null };
}
/** Archive (hide) a document. Back Office only; nothing is ever deleted. */
export const archiveDocument = (id, locationId = null, byName = null) =>
  setArchived(id, locationId, { archived_at: new Date().toISOString(), archived_by_name: byName || null }, 'archive');
/** Put an archived document back in the list. Back Office only. */
export const restoreDocument = (id, locationId = null) =>
  setArchived(id, locationId, { archived_at: null, archived_by_name: null }, 'restore');

/** A short lived signed link to one stored file in the private bucket. */
export async function signedFileUrl(path, seconds = SIGNED_URL_SECONDS) {
  if (isMock || !supabase) return { url: null, error: new Error(NOT_LIVE) };
  if (!path) return { url: null, error: new Error('No file') };
  const { data, error } = await supabase.storage.from(OPS_FILES_BUCKET).createSignedUrl(path, seconds);
  if (error || !data?.signedUrl) return { url: null, error: error || new Error('Could not open the file.') };
  return { url: data.signedUrl, error: null };
}

/**
 * Open a document through a short lived signed link (formRules docOpenMode decides how).
 * A browser only allows a new tab straight from the tap, so the tab is opened BEFORE the link
 * is fetched and pointed at it after. The Android device shell hands a link off our site to
 * the phone's own viewer, so there it is a plain navigation. The iOS shells and the Sunmi till
 * app would load the file IN the app with no way back, so there the caller shows it in its
 * in-app viewer (components/OpsDocViewer.jsx).
 * @returns {Promise<{ error: Error|null, url?: string, blocked?: boolean, viewer?: boolean }>}
 *   blocked: the browser refused the tab; show the url as a link to tap.
 *   viewer: show the url in the in-app viewer.
 */
export async function openDocument(doc, win = (typeof window !== 'undefined' ? window : null)) {
  if (!doc?.filePath) return { error: new Error('This document has no file.') };
  const mode = docOpenMode(win);
  let tab = null;
  if (mode === 'tab' && win) {
    try { tab = win.open('', '_blank'); if (tab) tab.opener = null; } catch { tab = null; }
  }
  const { url, error } = await signedFileUrl(doc.filePath, SIGNED_URL_SECONDS);
  if (error || !url) {
    try { tab?.close(); } catch { /* already closed */ }
    return { error: error || new Error('Could not open the document.') };
  }
  if (mode === 'viewer') return { error: null, url, viewer: true };
  if (tab) { tab.location.href = url; return { error: null, url }; }
  if (mode === 'navigate' && win) { win.location.assign(url); return { error: null, url }; }
  return { error: null, url, blocked: true };
}
