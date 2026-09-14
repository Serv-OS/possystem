/**
 * CategoryPhotoField (v5.8.65): upload, replace or remove a category's kiosk tile photo.
 *
 * Lives inside CatModal (MenuManager.jsx). It saves on its own, straight away, like the
 * item photo upload: the photo is NOT part of the modal's Save form.
 *
 *   1. checks the file (type, 5MB), then warns (never blocks) below 572 by 208
 *   2. uploads to product-images/<loc>/categories/<cat>-<ts>.<ext> (new name every time)
 *   3. saveCategoryImage does a targeted update scoped to the venue, with 0 row detection.
 *      It runs INSIDE the store's menu write queue (runInMenuWriteQueue), and the store row
 *      only takes the new photo once that save succeeds. So a category upsert queued before
 *      the change lands first, and one queued after it reads the new photo (never the old one).
 *
 * Old files are never deleted: other venues sharing the category and stale tabs use them.
 * Before the 20260914 migration runs, only a plain "needs a database update" line shows.
 */
import { useEffect, useState } from 'react';
import { useStore, runInMenuWriteQueue } from '../../store';
import { getLocationId } from '../../lib/supabase';
import { uploadCategoryPhoto, saveCategoryImage, categoryPhotosReady } from '../../lib/db';
import { CATEGORY_PHOTO_COPY as COPY, categoryPhotoUrl, checkPhotoFile, photoSizeWarning } from '../../lib/categoryPhoto';

const ACCEPT = 'image/jpeg,image/png,image/webp';

const liveRow = (catId) => (useStore.getState().menuCategories || []).find(c => c.id === catId) || null;

const setStoreImage = (catId, image) => {
  useStore.setState(s => ({
    menuCategories: (s.menuCategories || []).map(c => (c.id === catId ? { ...c, image } : c)),
  }));
};

async function readPixelSize(file) {
  try {
    if (typeof createImageBitmap !== 'function') return { w: null, h: null };
    const bmp = await createImageBitmap(file);
    const size = { w: bmp.width, h: bmp.height };
    try { bmp.close(); } catch { /* close is optional */ }
    return size;
  } catch {
    return { w: null, h: null };
  }
}

export default function CategoryPhotoField({ cat }) {
  const markBOChange = useStore(s => s.markBOChange);
  const showToast = useStore(s => s.showToast);
  const [image, setImage] = useState(() => categoryPhotoUrl(cat));
  const [uploading, setUploading] = useState(false);
  const [warning, setWarning] = useState(null);
  const [ready, setReady] = useState(null);   // null while checking
  const shared = cat?.scope === 'shared' || cat?.scope === 'global';

  useEffect(() => {
    let alive = true;
    categoryPhotosReady().then(ok => { if (alive) setReady(!!ok); }).catch(() => { if (alive) setReady(false); });
    return () => { alive = false; };
  }, []);

  const resolveVenue = async () => {
    const id = await getLocationId().catch(() => null);
    return id && id !== 'loc-demo' ? id : null;
  };

  // The save runs in the menu write queue. prev and the sharing fields come from the LIVE
  // store row at that moment, and the store row takes the new value only on success.
  const saveInQueue = async (locId, nextUrl) => {
    try {
      return await runInMenuWriteQueue(async () => {
        const live = liveRow(cat.id) || cat;
        const prev = categoryPhotoUrl(live);
        const r = await saveCategoryImage(live, locId, nextUrl, prev);
        if (!r.error) setStoreImage(cat.id, nextUrl);
        return r;
      });
    } catch (err) {
      console.error('[CategoryPhotoField] save failed:', err);
      return { error: err, needsMigration: false, peersFailed: false };
    }
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // choosing the same file again still fires onChange
    if (!file || uploading) return;
    const bad = checkPhotoFile(file);
    if (bad === 'type') return showToast(COPY.badType, 'error');
    if (bad === 'size') return showToast(COPY.tooBig, 'error');
    const locId = await resolveVenue();
    if (!locId) return showToast(COPY.noVenue, 'error');

    setUploading(true);
    const shownBefore = image;
    try {
      const { w, h } = await readPixelSize(file);
      const sizeNote = photoSizeWarning(w, h);
      setWarning(null);

      const { url, error } = await uploadCategoryPhoto(cat.id, locId, file);
      if (error || !url) {
        console.error('[CategoryPhotoField] upload failed:', error);
        showToast(COPY.uploadFailed, 'error');
        return;
      }
      setImage(url);   // preview only; the store row changes when the save succeeds
      const res = await saveInQueue(locId, url);
      if (res.error) {
        setImage(shownBefore);
        if (res.needsMigration) { setReady(false); showToast(COPY.notReady, 'error'); }
        else showToast(COPY.saveFailed, 'error');
        return;
      }
      setWarning(sizeNote);   // only about a photo that really saved
      markBOChange();
      if (res.peersFailed) showToast(COPY.peersFailedSaved, 'error');
      else showToast(COPY.saved, 'success');
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async () => {
    if (uploading || !image) return;
    if (!confirm(shared ? COPY.confirmRemoveShared : COPY.confirmRemove)) return;
    const locId = await resolveVenue();
    if (!locId) return showToast(COPY.noVenue, 'error');
    const shownBefore = image;
    setUploading(true);
    try {
      setImage(null);
      const res = await saveInQueue(locId, null);
      if (res.error) {
        setImage(shownBefore);
        showToast(res.needsMigration ? COPY.notReady : COPY.removeFailed, 'error');
        return;
      }
      setWarning(null);
      markBOChange();
      if (res.peersFailed) showToast(COPY.peersFailedRemoved, 'error');
      else showToast(COPY.removed, 'info');
    } finally {
      setUploading(false);
    }
  };

  if (ready === false) {
    return <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>{COPY.notReady}</div>;
  }

  const btn = {
    padding: '9px 14px', borderRadius: 9, cursor: uploading ? 'wait' : 'pointer', fontFamily: 'inherit',
    fontSize: 15, fontWeight: 600, border: '1px solid var(--bdr2)', background: 'var(--bg3)', color: 'var(--t1)',
    opacity: uploading ? 0.6 : 1,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{COPY.title}</div>
        <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45, marginTop: 2 }}>{COPY.help} {COPY.crop}</div>
        <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45, marginTop: 2 }}>{COPY.savesNow}</div>
      </div>

      {image ? (
        <>
          {/* Same shape as the kiosk tile photo slot (about 180 by 104 at 1080 wide), so what
              is trimmed here is what the kiosk trims. */}
          <img src={image} alt="" style={{ width: '100%', maxWidth: 320, aspectRatio: '180 / 104', objectFit: 'cover', borderRadius: 16, display: 'block', border: '1px solid var(--bdr)', background: 'var(--bg3)' }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ ...btn, display: 'inline-flex', alignItems: 'center' }}>
              {uploading ? COPY.uploading : COPY.replace}
              <input type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={handleFile} disabled={uploading || ready !== true} />
            </label>
            <button type="button" onClick={handleRemove} disabled={uploading} style={{ ...btn, background: 'var(--red-d)', border: '1px solid var(--red-b)', color: 'var(--red)' }}>
              {COPY.remove}
            </button>
          </div>
        </>
      ) : (
        <label style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
          padding: '18px 16px', borderRadius: 12, cursor: uploading || ready !== true ? 'wait' : 'pointer',
          border: '2px dashed var(--bdr2)', background: 'var(--bg3)', textAlign: 'center',
          opacity: ready === true ? 1 : 0.6,
        }}>
          {uploading ? (
            <span style={{ fontSize: 15, color: 'var(--t2)' }}>{COPY.uploading}</span>
          ) : (
            <>
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--t1)' }}>{COPY.upload}</span>
              <span style={{ fontSize: 15, color: 'var(--t3)' }}>{COPY.types}</span>
            </>
          )}
          <input type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={handleFile} disabled={uploading || ready !== true} />
        </label>
      )}

      {warning && (
        <div role="status" style={{ fontSize: 15, lineHeight: 1.45, color: 'var(--t1)', background: 'rgba(245,166,35,.12)', border: '1px solid rgba(245,166,35,.45)', borderRadius: 9, padding: '9px 12px' }}>
          {warning}
        </div>
      )}
      {shared && <div style={{ fontSize: 15, color: 'var(--t3)', lineHeight: 1.45 }}>{COPY.shared}</div>}
    </div>
  );
}
