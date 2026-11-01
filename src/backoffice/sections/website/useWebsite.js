// src/backoffice/sections/website/useWebsite.js
//
// The one place the website builder loads and mutates state. Reads: get_site through the
// edge function (it also creates the draft site row on first visit), the default location's
// online_branding and the company's locations through the platform client (the same read
// MenuAppearance uses), and the version history under RLS. Writes all go through
// adminClient. Nothing here throws to the screen: errors come back as { error } and the
// caller toasts them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { platformSupabase, getLocationId } from '../../../lib/supabase';
import * as admin from './adminClient.js';
import { orderPages, venuesNeedingGeocode } from './helpers.js';

function pickDefaultLocation(site, locations, ownRow) {
  const want = site?.settings?.default_location_id;
  return (want && locations.find((l) => l.id === want)) || ownRow || locations[0] || null;
}

export function useWebsite() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [site, setSite] = useState(null);
  const [pages, setPages] = useState([]);
  const [posts, setPosts] = useState([]);
  const [versions, setVersions] = useState([]);
  const [messages, setMessages] = useState([]);          // designer chat, oldest first
  const [publicLocations, setPublicLocations] = useState([]); // company locations as the public site sees them
  const [freeHostUrl, setFreeHostUrl] = useState('');
  const [ownRow, setOwnRow] = useState(null);          // platform locations row for this BO session
  const [locations, setLocations] = useState([]);      // every location of the company
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const applySiteData = useCallback((data) => {
    if (!data) return;
    const s = data.site || (data.id ? data : null);
    if (s) setSite(s);
    if (Array.isArray(data.pages)) setPages(orderPages(data.pages));
    if (Array.isArray(data.posts)) setPosts(data.posts);
    if (Array.isArray(data.versions)) setVersions(data.versions);
    if (Array.isArray(data.messages)) setMessages(data.messages);
    if (Array.isArray(data.locations)) setPublicLocations(data.locations);
    if (typeof data.free_host === 'string' && data.free_host) setFreeHostUrl(data.free_host);
  }, []);

  const loadVersions = useCallback(async (siteId) => {
    if (!platformSupabase || !siteId) return;
    try {
      const { data } = await platformSupabase.from('web_site_versions').select('id, note, created_at, created_by').eq('site_id', siteId).order('created_at', { ascending: false }).limit(30);
      if (alive.current && Array.isArray(data) && data.length) setVersions(data);
    } catch { /* history is a nicety, the page works without it */ }
  }, []);

  // 5.12.13: venues are placed on the map from their address, in the background, the first time the
  // builder sees one without coordinates (and again after a publish). Nominatim, cached on
  // settings.geo by the website-admin function; one attempt per set of missing venues per session.
  const geocodeTried = useRef('');
  const geocodeMissing = useCallback(async (s, locs) => {
    const missing = venuesNeedingGeocode(s, locs);
    if (!missing.length) return;
    const key = missing.map((l) => l.id).sort().join(',');
    if (geocodeTried.current === key) return;
    geocodeTried.current = key;
    try {
      const { data } = await admin.geocodeLocations();
      if (alive.current && data && data.site && data.site.id) setSite(data.site);
    } catch { /* the Find my nearest button simply stays off until the next try */ }
  }, []);

  const reload = useCallback(async () => {
    const { data, error } = await admin.getSite();
    if (!alive.current) return { error };
    if (error) { setLoadError(error.message || 'Could not load the website'); return { error }; }
    setLoadError(null);
    applySiteData(data);
    if (data) geocodeMissing(data.site || data, Array.isArray(data.locations) ? data.locations : []);
    const siteId = data?.site?.id || data?.id;
    if (siteId) loadVersions(siteId);
    return { data, error: null };
  }, [applySiteData, loadVersions, geocodeMissing]);

  useEffect(() => {
    (async () => {
      try {
        const opsId = await getLocationId().catch(() => null);
        if (platformSupabase && opsId) {
          let r = (await platformSupabase.from('locations').select('id, name, online_slug, online_branding, company_id, timezone').eq('ops_location_id', opsId).maybeSingle()).data;
          if (!r) r = (await platformSupabase.from('locations').select('id, name, online_slug, online_branding, company_id, timezone').eq('id', opsId).maybeSingle()).data;
          if (alive.current && r) {
            setOwnRow(r);
            if (r.company_id) {
              const { data: locs } = await platformSupabase.from('locations').select('id, name, online_slug, online_branding, company_id, timezone').eq('company_id', r.company_id).order('name');
              if (alive.current && Array.isArray(locs)) setLocations(locs);
            }
          }
        }
      } catch { /* branding panel shows its empty state */ }
      await reload();
      if (alive.current) setLoading(false);
    })();
  }, [reload]);

  const defaultLocation = useMemo(() => pickDefaultLocation(site, locations, ownRow), [site, locations, ownRow]);
  const branding = defaultLocation?.online_branding || ownRow?.online_branding || {};
  const venueName = branding.display_name || defaultLocation?.name || ownRow?.name || 'Your venue';

  // Optimistic local merge so the screen answers at once; the server copy wins on reload.
  const saveSite = useCallback(async (patch) => {
    const res = await admin.saveSite(patch);
    if (!res.error) {
      const s = res.data?.site || res.data;
      if (s && s.id) setSite(s); else setSite((prev) => ({ ...(prev || {}), ...patch, updated_at: new Date().toISOString() }));
    }
    return res;
  }, []);

  const savePage = useCallback(async (pageId, patch) => {
    const res = await admin.savePage(pageId, patch);
    if (!res.error) {
      const saved = res.data?.page || (res.data?.id ? res.data : null);
      setPages((prev) => {
        const now = new Date().toISOString();
        if (pageId) return orderPages(prev.map((p) => (p.id === pageId ? { ...p, ...patch, ...(saved || {}), updated_at: saved?.updated_at || now } : p)));
        if (saved) return orderPages([...prev, saved]);
        return prev;
      });
    }
    return res;
  }, []);

  const deletePage = useCallback(async (pageId) => {
    const res = await admin.deletePage(pageId);
    if (!res.error) setPages((prev) => prev.filter((p) => p.id !== pageId));
    return res;
  }, []);

  const savePost = useCallback(async (postId, patch) => {
    const res = await admin.savePost(postId, patch);
    if (!res.error) {
      const saved = res.data?.post || (res.data?.id ? res.data : null);
      setPosts((prev) => {
        const now = new Date().toISOString();
        if (postId) return prev.map((p) => (p.id === postId ? { ...p, ...patch, ...(saved || {}), updated_at: saved?.updated_at || now } : p));
        if (saved) return [saved, ...prev];
        return prev;
      });
    }
    return res;
  }, []);

  const deletePost = useCallback(async (postId) => {
    const res = await admin.deletePost(postId);
    if (!res.error) setPosts((prev) => prev.filter((p) => p.id !== postId));
    return res;
  }, []);

  const publish = useCallback(async (note, acceptTerms = null) => {
    geocodeMissing(site, publicLocations);
    const res = await admin.publishSite(note, undefined, acceptTerms);
    if (!res.error) await reload();
    return res;
  }, [reload, geocodeMissing, site, publicLocations]);

  const unpublish = useCallback(async () => {
    const res = await admin.unpublishSite();
    if (!res.error) await reload();
    return res;
  }, [reload]);

  const restore = useCallback(async (versionId) => {
    const res = await admin.restoreVersion(versionId);
    if (!res.error) await reload();
    return res;
  }, [reload]);

  // Upload a file through a signed URL from the edge function. Accepts either shape the
  // function may answer with: { path, token } (Supabase signed upload) or { url } (PUT).
  const uploadAsset = useCallback(async (file, kind) => {
    if (!file) return { url: null, error: new Error('No file chosen') };
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const { data, error } = await admin.uploadUrl(kind, ext);
    if (error) return { url: null, error };
    try {
      if (data?.token && data?.path && platformSupabase) {
        const { error: upErr } = await platformSupabase.storage.from(data.bucket || 'web-assets').uploadToSignedUrl(data.path, data.token, file, { contentType: file.type, upsert: true });
        if (upErr) throw upErr;
        const pub = data.public_url || platformSupabase.storage.from(data.bucket || 'web-assets').getPublicUrl(data.path).data?.publicUrl;
        return { url: pub ? `${pub}${pub.includes('?') ? '&' : '?'}t=${Date.now()}` : null, error: pub ? null : new Error('Upload done, no public link') };
      }
      const putUrl = data?.signed_url || data?.upload_url || data?.url;
      if (!putUrl) throw new Error('No upload link returned');
      const r = await fetch(putUrl, { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      if (!r.ok) throw new Error(`Upload failed (${r.status})`);
      const pub = data.public_url || putUrl.split('?')[0];
      return { url: `${pub}?t=${Date.now()}`, error: null };
    } catch (e) {
      return { url: null, error: e instanceof Error ? e : new Error(String(e)) };
    }
  }, []);

  return {
    loading, loadError, site, pages, posts, versions, messages, locations, publicLocations, freeHostUrl, defaultLocation, branding, venueName, ownRow,
    reload, applySiteData, saveSite, savePage, deletePage, savePost, deletePost, publish, unpublish, restore, uploadAsset,
    setPages,
  };
}
