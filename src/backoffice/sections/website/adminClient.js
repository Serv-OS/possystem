// src/backoffice/sections/website/adminClient.js
//
// One door from the Back Office screens to the website-admin and website-domain edge
// functions, through agent A's src/lib/websiteAdmin.js. A's helpers resolve { ok, data } or
// { ok:false, error, data }; the screens only ever see { data, error } and never a throw, so a
// failed call becomes a toast and the page stays up.

import * as websiteAdmin from '../../../lib/websiteAdmin.js';

function toError(e) {
  if (!e) return null;
  if (e instanceof Error) return e;
  if (typeof e === 'string') return new Error(e);
  return new Error(e.message || e.error || 'Request failed');
}

async function run(name, ...args) {
  const fn = websiteAdmin[name];
  if (typeof fn !== 'function') return { data: null, error: new Error(`Website admin has no "${name}" yet.`) };
  try {
    const res = await fn(...args);
    if (res && typeof res === 'object' && ('ok' in res || 'error' in res || 'data' in res)) {
      const failed = res.ok === false || !!res.error;
      return { data: res.data ?? null, error: failed ? (toError(res.error) || new Error('Request failed')) : null };
    }
    return { data: res ?? null, error: null };
  } catch (e) {
    return { data: null, error: toError(e) };
  }
}

// Named after the contract's actions (section 10). Response shapes, from the edge function:
// get_site {site,pages,posts,versions,messages,locations,company,free_host}; save_site {site};
// save_page {page}; save_post {post}; publish {version_id,published_at,site}; preview_token
// {token,path}; upload_url {signed_url,token,path,public_url}; check_domain {custom_domain,
// apex_domain, domain_status, site}.
export const getSite = () => run('getSite');
export const saveSite = (patch) => run('saveSite', patch);
export const savePage = (pageId, patch) => run('savePage', pageId ?? null, patch);
export const deletePage = (pageId) => run('deletePage', pageId);
export const reorderPages = (ids) => run('reorderPages', ids);
export const savePost = (postId, patch) => run('savePost', postId ?? null, patch);
export const deletePost = (postId) => run('deletePost', postId);
// 5.12.4: the accepted terms version travels with the call (the hook passes it third); a
// wrapper that dropped it left the server answering 428 on every publish.
export const publishSite = (note, opts, acceptTerms = null) => run('publishSite', note || '', opts, acceptTerms);
export const unpublishSite = () => run('unpublishSite');
export const restoreVersion = (versionId) => run('restoreVersion', versionId);
export const previewToken = () => run('previewToken');
export const uploadUrl = (kind, ext) => run('uploadUrl', kind, ext);
export const checkDomain = (customDomain) => run('checkDomain', customDomain);
export const removeDomain = () => run('removeDomain');
