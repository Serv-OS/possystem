/**
 * MenuImportModal — drop a menu file, let the AI parse it, review, publish.
 *
 * Flow:
 *   1. Drop zone accepts PDF / DOCX / XLSX / JPG / PNG (max 7MB)
 *   2. File base64-encoded and sent to /api/ai/menu-import
 *   3. Claude returns { categories, items, notes }
 *   4. User reviews in an editable preview
 *   5. User clicks Publish — creates categories + items via existing store actions
 *
 * Nothing is written to the database until Publish is clicked.
 */
import { useState, useRef } from 'react';
import { useStore } from '../../store';

const ACCEPTED_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
];

const ACCEPTED_EXT = '.pdf,.docx,.xlsx,.jpg,.jpeg,.png,.webp';
const MAX_BYTES = 7 * 1024 * 1024;

const CONFIDENCE_META = {
  high:   { color:'var(--grn)',  bg:'var(--grn-d)', label:'✓' },
  medium: { color:'#e8a020',     bg:'rgba(232,160,32,0.15)', label:'?' },
  low:    { color:'var(--red)',  bg:'var(--red-d)',          label:'!' },
};

export default function MenuImportModal({ menuId, onClose }) {
  const { addCategory, addMenuItem, showToast, markBOChange } = useStore();

  const [phase, setPhase] = useState('drop'); // drop | uploading | parsing | review | publishing | done
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);   // { categories, items, notes }
  const [meta, setMeta] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef(null);

  // ── File handling ──────────────────────────────────────────────────────────
  const handleFile = async (file) => {
    if (!file) return;
    setError('');

    if (!ACCEPTED_MIME.includes(file.type)) {
      setError(`Unsupported file type. Accepted: PDF, Word, Excel, JPG, PNG.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`File too large — ${Math.round(file.size/1024/1024)}MB. Max 7MB.`);
      return;
    }
    if (file.size < 100) {
      setError('File appears to be empty.');
      return;
    }

    setPhase('uploading');
    setStatusMsg('Reading your menu...');

    try {
      const base64 = await fileToBase64(file);
      setPhase('parsing');
      setStatusMsg('AI is parsing your menu — this can take 15–45 seconds...');

      const res = await fetch('/api/ai/menu-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, mimeType: file.type, base64 }),
      });

      // Read response as text first so we can surface the real error even if
      // the server returned HTML (e.g. Vercel "An error occurred" page) instead
      // of JSON. Previously `res.json()` threw on HTML and hid the real error.
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        // Non-JSON response. Show a truncated preview and the status code so the
        // real server error is visible to the user.
        const preview = rawText.slice(0, 200).replace(/\s+/g, ' ').trim();
        throw new Error(`Server returned non-JSON (${res.status}): ${preview}`);
      }
      if (!res.ok) throw new Error(data.error || `Server error (${res.status})`);

      if (!data.draft || !Array.isArray(data.draft.categories) || !Array.isArray(data.draft.items)) {
        throw new Error('AI response was malformed. Try again or use a clearer file.');
      }
      if (data.draft.categories.length === 0 && data.draft.items.length === 0) {
        throw new Error(data.draft.notes || 'No menu structure detected in this file.');
      }

      setDraft(data.draft);
      setMeta(data.meta);
      setPhase('review');
      setStatusMsg('');
    } catch (err) {
      setError(err.message || 'Something went wrong');
      setPhase('drop');
      setStatusMsg('');
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  };

  // ── Review-stage edits ─────────────────────────────────────────────────────
  const updateCat = (id, patch) => {
    setDraft(d => ({ ...d, categories: d.categories.map(c => c.id === id ? { ...c, ...patch } : c) }));
  };
  const removeCat = (id) => {
    setDraft(d => ({
      ...d,
      categories: d.categories.filter(c => c.id !== id),
      items:      d.items.filter(i => i.categoryId !== id),
    }));
  };
  const updateItem = (id, patch) => {
    setDraft(d => ({ ...d, items: d.items.map(i => i.id === id ? { ...i, ...patch } : i) }));
  };
  const removeItem = (id) => {
    setDraft(d => ({ ...d, items: d.items.filter(i => i.id !== id) }));
  };

  // ── Publish ────────────────────────────────────────────────────────────────
  const handlePublish = async () => {
    setPhase('publishing');
    setStatusMsg('Creating categories and items...');
    try {
      // Generate stable IDs client-side so we don't rely on addCategory's return
      // value (it returns void). Using a batch prefix avoids Date.now() collisions
      // from rapid-fire calls in the same tick.
      const batch = `imp${Date.now().toString(36)}`;
      let cCounter = 0;
      let iCounter = 0;
      const genCatId  = () => `cat-${batch}-${(cCounter++).toString(36)}`;
      const genItemId = () => `m-${batch}-${(iCounter++).toString(36)}`;

      // v5.5.957: resolve the target menu AT COMMIT TIME. The menuId prop is
      // menus?.[0]?.id captured by the parent — undefined when the venue's menus
      // hadn't loaded (or didn't exist yet) at mount. Birmingham's 25 imported
      // categories all landed with menu_id NULL because of exactly that.
      let targetMenuId = menuId || useStore.getState().menus?.[0]?.id || undefined;
      // v5.5.958: a venue with NO menu gets one created for the import, loudly —
      // never a tree of menu-less categories again. The serialised write chain
      // guarantees the menu row lands before the first category (FK-safe).
      if (!targetMenuId) {
        const created = useStore.getState().addMenu({ name: 'Main menu', isActive: true, isDefault: true });
        targetMenuId = created?.id;
        showToast('This venue had no menu — created "Main menu" and attached the import to it', 'success');
      }

      // 1) Create categories with pre-assigned IDs (or reuse existing if user picked one)
      const catIdMap = {};
      for (let i = 0; i < draft.categories.length; i++) {
        const c = draft.categories[i];
        if (c.existingId) {
          // User chose to merge imported items into an existing category
          catIdMap[c.id] = c.existingId;
          continue;
        }
        const realId = genCatId();
        catIdMap[c.id] = realId;
        addCategory({
          id: realId,
          label: c.label,
          icon: c.icon || '🍽',
          color: '#3b82f6',
          menuId: targetMenuId,
          sortOrder: c.sortOrder ?? i,
        });
      }

      // 2) Create items with pre-assigned IDs
      for (const it of draft.items) {
        const realCat = catIdMap[it.categoryId];
        if (!realCat) continue; // category was removed during review
        const hasVariants = Array.isArray(it.variants) && it.variants.length > 0;

        if (hasVariants) {
          // Parent item marked as variants; children are the actual priced skus
          const parentId = genItemId();
          addMenuItem({
            id: parentId,
            name: it.name,
            menuName: it.name,
            description: it.description || '',
            type: 'variants',
            cat: realCat,
            allergens: it.allergens || [],
            pricing: { base: 0, dineIn:null, takeaway:null, collection:null, delivery:null },
          });
          for (const v of it.variants) {
            addMenuItem({
              id: genItemId(),
              name: v.name,
              menuName: v.name,
              type: 'simple',
              parentId,
              cat: realCat,
              allergens: it.allergens || [],
              pricing: { base: Number(v.price) || 0, dineIn:null, takeaway:null, collection:null, delivery:null },
            });
          }
        } else {
          addMenuItem({
            id: genItemId(),
            name: it.name,
            menuName: it.name,
            description: it.description || '',
            type: 'simple',
            cat: realCat,
            allergens: it.allergens || [],
            pricing: { base: Number(it.price) || 0, dineIn:null, takeaway:null, collection:null, delivery:null },
          });
        }
      }

      markBOChange?.();
      showToast(`Imported ${draft.categories.length} categories and ${draft.items.length} items`, 'success');
      setPhase('done');
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(`Publish failed: ${err.message}`);
      setPhase('review');
    }
  };

  // ── Styles shared ──────────────────────────────────────────────────────────
  const input = {
    background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:8,
    padding:'6px 10px', fontSize:13, color:'var(--t1)', fontFamily:'inherit', outline:'none',
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', backdropFilter:'blur(4px)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:999, padding:20,
    }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:16,
        width:'100%', maxWidth: phase==='review' ? 900 : 600,
        maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden',
      }}>
        {/* Header */}
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <h2 style={{ margin:0, fontSize:16, fontWeight:800 }}>↗ Import menu from file</h2>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:3 }}>AI will parse your menu — you review before publish</div>
          </div>
          <button onClick={onClose} style={{ ...input, height:32, cursor:'pointer', background:'var(--bg2)' }}>Close</button>
        </div>

        {/* Body */}
        <div style={{ padding:20, overflow:'auto', flex:1 }}>
          {error && (
            <div style={{ padding:12, borderRadius:8, background:'var(--red-d)', color:'var(--red)', fontSize:13, marginBottom:16 }}>
              {error}
            </div>
          )}

          {phase === 'drop' && (
            <div
              onDragOver={e=>{e.preventDefault();setIsDragging(true);}}
              onDragLeave={()=>setIsDragging(false)}
              onDrop={onDrop}
              onClick={()=>fileInputRef.current?.click()}
              style={{
                border:`2px dashed ${isDragging?'var(--acc)':'var(--bdr2)'}`,
                borderRadius:12, padding:40, textAlign:'center', cursor:'pointer',
                background: isDragging ? 'var(--acc-d)' : 'var(--bg2)',
                transition:'all 0.15s',
              }}>
              <div style={{ fontSize:48, marginBottom:12 }}>📄</div>
              <div style={{ fontSize:15, fontWeight:700, marginBottom:6 }}>Drop your menu here</div>
              <div style={{ fontSize:12, color:'var(--t4)' }}>or click to browse</div>
              <div style={{ fontSize:11, color:'var(--t5)', marginTop:14 }}>PDF · Word · Excel · JPG · PNG · max 7MB</div>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_EXT}
                style={{ display:'none' }}
                onChange={e => handleFile(e.target.files?.[0])}
              />
            </div>
          )}

          {(phase === 'uploading' || phase === 'parsing' || phase === 'publishing') && (
            <div style={{ padding:40, textAlign:'center' }}>
              <div style={{ fontSize:32, marginBottom:14 }}>
                <span style={{ display:'inline-block', animation:'spin 1s linear infinite' }}>⚙</span>
              </div>
              <div style={{ fontSize:14, fontWeight:600 }}>{statusMsg}</div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {phase === 'done' && (
            <div style={{ padding:40, textAlign:'center' }}>
              <div style={{ fontSize:44, marginBottom:12 }}>✓</div>
              <div style={{ fontSize:15, fontWeight:700, color:'var(--grn)' }}>Menu imported</div>
              <div style={{ fontSize:12, color:'var(--t4)', marginTop:6 }}>Remember to click "Push to POS" when you're ready</div>
            </div>
          )}

          {phase === 'review' && draft && (
            <ReviewPanel
              draft={draft} meta={meta}
              updateCat={updateCat} removeCat={removeCat}
              updateItem={updateItem} removeItem={removeItem}
            />
          )}
        </div>

        {/* Footer — only in review phase */}
        {phase === 'review' && draft && (
          <div style={{ padding:16, borderTop:'1px solid var(--bdr)', display:'flex', gap:10, alignItems:'center', justifyContent:'space-between', background:'var(--bg0)' }}>
            <div style={{ fontSize:12, color:'var(--t4)' }}>
              {draft.categories.length} categories · {draft.items.length} items
              {meta?.tokensIn && <span style={{ marginLeft:12, opacity:0.7 }}>({meta.tokensIn + meta.tokensOut} tokens)</span>}
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={onClose} style={{ ...input, height:36, cursor:'pointer', background:'var(--bg2)' }}>Cancel</button>
              <button onClick={handlePublish} disabled={draft.categories.length === 0}
                style={{ ...input, height:36, cursor:'pointer', background:'var(--acc)', color:'white', fontWeight:700, border:'none', opacity: draft.categories.length === 0 ? 0.5 : 1 }}>
                Publish → Menu
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Review panel ─────────────────────────────────────────────────────────────
function ReviewPanel({ draft, meta, updateCat, removeCat, updateItem, removeItem }) {
  const { menuCategories } = useStore();
  const existingRootCats = (menuCategories || []).filter(c => !c.parentId && !c.isSpecial);
  const byCategory = {};
  for (const cat of draft.categories) byCategory[cat.id] = [];
  for (const item of draft.items) {
    if (byCategory[item.categoryId]) byCategory[item.categoryId].push(item);
  }

  const inp = {
    background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:6,
    padding:'4px 8px', fontSize:12, color:'var(--t1)', fontFamily:'inherit', outline:'none',
  };

  return (
    <div>
      {draft.notes && (
        <div style={{ padding:10, borderRadius:8, background:'rgba(232,160,32,0.12)', color:'#c88019', fontSize:12, marginBottom:14 }}>
          <strong>AI notes:</strong> {draft.notes}
        </div>
      )}
      <div style={{ fontSize:11, color:'var(--t4)', marginBottom:14 }}>
        Review everything below. Edit names, prices, allergens. Delete anything wrong. Low-confidence items are flagged in red — give those extra attention.
      </div>

      {draft.categories.map(cat => (
        <div key={cat.id} style={{ marginBottom:18, border:'1px solid var(--bdr)', borderRadius:10, overflow:'hidden' }}>
          {/* Category header */}
          <div style={{ display:'flex', gap:8, alignItems:'center', padding:10, background:'var(--bg2)', borderBottom:'1px solid var(--bdr)', flexWrap:'wrap' }}>
            <select
              value={cat.existingId || ''}
              onChange={e=>updateCat(cat.id, { existingId: e.target.value || null })}
              style={{ ...inp, width:170, fontSize:11 }}
              title="Merge into an existing category instead of creating a new one"
            >
              <option value="">➕ Create new category</option>
              {existingRootCats.map(c => (
                <option key={c.id} value={c.id}>{c.icon || '🍽'} {c.label} (merge)</option>
              ))}
            </select>
            <input style={{ ...inp, width:50, textAlign:'center', opacity: cat.existingId ? 0.4 : 1 }}
              disabled={!!cat.existingId}
              value={cat.existingId ? (existingRootCats.find(c=>c.id===cat.existingId)?.icon || cat.icon) : cat.icon}
              onChange={e=>updateCat(cat.id, { icon: e.target.value })} />
            <input style={{ ...inp, flex:1, fontWeight:700, opacity: cat.existingId ? 0.4 : 1 }}
              disabled={!!cat.existingId}
              value={cat.existingId ? (existingRootCats.find(c=>c.id===cat.existingId)?.label || cat.label) : cat.label}
              onChange={e=>updateCat(cat.id, { label: e.target.value })} />
            <span style={{ fontSize:10, color:'var(--t4)' }}>{byCategory[cat.id]?.length || 0} items</span>
            <button onClick={()=>removeCat(cat.id)}
              style={{ ...inp, cursor:'pointer', color:'var(--red)', background:'transparent' }}>✕</button>
          </div>

          {/* Items in this category */}
          <div>
            {(byCategory[cat.id] || []).map(item => {
              const conf = CONFIDENCE_META[item.confidence] || CONFIDENCE_META.medium;
              const hasVariants = Array.isArray(item.variants) && item.variants.length > 0;
              return (
                <div key={item.id} style={{ padding:10, borderBottom:'1px solid var(--bdr)', display:'flex', gap:8, alignItems:'flex-start', background: item.confidence==='low' ? 'rgba(239,68,68,0.06)' : 'transparent' }}>
                  <div style={{
                    width:22, height:22, borderRadius:'50%', flexShrink:0, marginTop:4,
                    background: conf.bg, color: conf.color, display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:11, fontWeight:800,
                  }}>{conf.label}</div>
                  <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:6 }}>
                    <div style={{ display:'flex', gap:8 }}>
                      <input style={{ ...inp, flex:1, fontWeight:600 }}
                        value={item.name} onChange={e=>updateItem(item.id, { name: e.target.value })} />
                      {!hasVariants && (
                        <input type="number" step="0.01" style={{ ...inp, width:90, textAlign:'right' }}
                          value={item.price} onChange={e=>updateItem(item.id, { price: parseFloat(e.target.value)||0 })} />
                      )}
                      <button onClick={()=>removeItem(item.id)} style={{ ...inp, cursor:'pointer', color:'var(--red)', background:'transparent' }}>✕</button>
                    </div>
                    {item.description && (
                      <input style={{ ...inp, width:'100%', fontSize:11, color:'var(--t3)' }}
                        value={item.description} onChange={e=>updateItem(item.id, { description: e.target.value })} />
                    )}
                    {hasVariants && (
                      <div style={{ paddingLeft:12, borderLeft:'2px solid var(--bdr2)', display:'flex', flexDirection:'column', gap:4 }}>
                        {item.variants.map((v, vi) => (
                          <div key={vi} style={{ display:'flex', gap:6 }}>
                            <input style={{ ...inp, flex:1 }}
                              value={v.name}
                              onChange={e=>{
                                const next = [...item.variants];
                                next[vi] = { ...v, name: e.target.value };
                                updateItem(item.id, { variants: next });
                              }} />
                            <input type="number" step="0.01" style={{ ...inp, width:80, textAlign:'right' }}
                              value={v.price}
                              onChange={e=>{
                                const next = [...item.variants];
                                next[vi] = { ...v, price: parseFloat(e.target.value)||0 };
                                updateItem(item.id, { variants: next });
                              }} />
                          </div>
                        ))}
                      </div>
                    )}
                    {(item.allergens && item.allergens.length > 0) && (
                      <div style={{ fontSize:10, color:'var(--t4)' }}>
                        Allergens: {item.allergens.join(', ')}
                      </div>
                    )}
                    {item.notes && (
                      <div style={{ fontSize:10, color:'#c88019', fontStyle:'italic' }}>⚠ {item.notes}</div>
                    )}
                  </div>
                </div>
              );
            })}
            {(byCategory[cat.id] || []).length === 0 && (
              <div style={{ padding:12, fontSize:11, color:'var(--t5)', textAlign:'center' }}>No items in this category</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Utilities ────────────────────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => {
      const dataUrl = reader.result;
      const base64  = String(dataUrl).split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
