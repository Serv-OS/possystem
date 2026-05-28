// src/backoffice/sections/MessageTemplates.jsx
//
// Back office section for editing transactional message templates.
// Operators customise every SMS and email their venue sends — order ready,
// gift card delivery, table ready, receipts, etc.
//
// Calls the message-templates edge function for CRUD + preview.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useStore } from '../../store';
import { supabase, isMock, getLocationId } from '../../lib/supabase';

const FUNC_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/message-templates`;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function callApi(action, payload) {
  if (isMock) return { ok: true, types: [] };
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');
  const locationId = await getLocationId();
  if (!locationId) throw new Error('No location');

  const res = await fetch(FUNC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action, location_id: locationId, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const CHANNEL_LABELS = { email: 'Email', sms: 'SMS' };
const CHANNEL_ICONS = { email: '✉️', sms: '📱' };
const CATEGORY_ICONS = {
  Orders: '📋',
  'Gift Cards': '🎁',
  Tables: '🍽️',
  Receipts: '🧾',
  Loyalty: '⭐',
};

// ── Component ───────────────────────────────────────────────────────────────

export default function MessageTemplates() {
  const { showToast } = useStore();
  const [loading, setLoading] = useState(true);
  const [categories, setCategories] = useState([]);
  const [types, setTypes] = useState([]);
  const [selectedType, setSelectedType] = useState(null);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editEnabled, setEditEnabled] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const bodyRef = useRef(null);

  // ── Load templates ────────────────────────────────────────────────────────

  const loadTemplates = useCallback(async (reselectType, reselectChannel) => {
    try {
      setLoading(true);
      const data = await callApi('list', {});
      const freshTypes = data.types || [];
      setCategories(data.categories || []);
      setTypes(freshTypes);
      // Re-select the given type from fresh data, or auto-select first
      const typeKey = reselectType || (!selectedType && freshTypes.length ? freshTypes[0].type : null);
      if (typeKey) {
        const mt = freshTypes.find(t => t.type === typeKey);
        if (mt) {
          const ch = reselectChannel || mt.channels[0];
          setSelectedType(typeKey);
          setSelectedChannel(ch);
          const tpl = mt.templates[ch];
          setEditSubject(tpl?.subject || '');
          setEditBody(tpl?.body_text || '');
          setEditEnabled(tpl?.enabled !== false);
          setDirty(false);
          setShowPreview(false);
          setPreviewData(null);
        }
      }
    } catch (e) {
      console.error('[MessageTemplates] load error:', e);
      showToast?.(`Failed to load templates: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  // ── Select a message type ─────────────────────────────────────────────────

  const selectType = (typeKey, channel) => {
    const mt = types.find(t => t.type === typeKey);
    if (!mt) return;
    const ch = channel || mt.channels[0];
    setSelectedType(typeKey);
    setSelectedChannel(ch);
    const tpl = mt.templates[ch];
    setEditSubject(tpl?.subject || '');
    setEditBody(tpl?.body_text || '');
    setEditEnabled(tpl?.enabled !== false);
    setDirty(false);
    setShowPreview(false);
    setPreviewData(null);
  };

  // ── Save template ─────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!selectedType || !selectedChannel) return;
    try {
      setSaving(true);
      await callApi('save', {
        message_type: selectedType,
        channel: selectedChannel,
        subject: selectedChannel === 'email' ? editSubject : null,
        body_text: editBody,
        enabled: editEnabled,
      });
      showToast?.('Template saved', 'success');
      setDirty(false);
      // Reload and re-select from fresh data (avoids stale closure)
      await loadTemplates(selectedType, selectedChannel);
    } catch (e) {
      showToast?.(`Save failed: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Reset to default ──────────────────────────────────────────────────────

  const handleReset = async () => {
    if (!selectedType || !selectedChannel) return;
    const mt = types.find(t => t.type === selectedType);
    const tpl = mt?.templates?.[selectedChannel];
    if (!tpl?.isCustom) {
      showToast?.('Already using the default template', 'info');
      return;
    }
    try {
      setSaving(true);
      await callApi('reset', {
        message_type: selectedType,
        channel: selectedChannel,
      });
      showToast?.('Reset to default', 'success');
      setDirty(false);
      await loadTemplates(selectedType, selectedChannel);
    } catch (e) {
      showToast?.(`Reset failed: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // ── Preview ───────────────────────────────────────────────────────────────

  const handlePreview = async () => {
    if (!selectedType || !selectedChannel) return;
    try {
      setLoadingPreview(true);
      const data = await callApi('preview', {
        message_type: selectedType,
        channel: selectedChannel,
        body_text: editBody,
        subject: selectedChannel === 'email' ? editSubject : null,
      });
      setPreviewData(data.preview);
      setShowPreview(true);
    } catch (e) {
      showToast?.(`Preview failed: ${e.message}`, 'error');
    } finally {
      setLoadingPreview(false);
    }
  };

  // ── Insert merge tag at cursor ────────────────────────────────────────────

  const insertTag = (tag) => {
    const el = bodyRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = `{{${tag}}}`;
    const before = editBody.slice(0, start);
    const after = editBody.slice(end);
    const newBody = before + text + after;
    setEditBody(newBody);
    setDirty(true);
    // Restore cursor position after React re-render
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // ── Current selection data ────────────────────────────────────────────────

  const currentMt = types.find(t => t.type === selectedType);
  const currentTpl = currentMt?.templates?.[selectedChannel];
  const charCount = selectedChannel === 'sms' ? editBody.length : 0;
  const smsSegments = selectedChannel === 'sms' ? Math.ceil(charCount / 160) || 1 : 0;

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--t4)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>Loading templates...</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 0, minHeight: 'calc(100vh - 120px)' }}>
      {/* ── Left: Message type list ─────────────────────────────── */}
      <div style={{
        width: 280, minWidth: 280, borderRight: '1px solid var(--bdr)',
        background: 'var(--bg2)', overflowY: 'auto', padding: '20px 0',
      }}>
        <div style={{ padding: '0 16px 16px', borderBottom: '1px solid var(--bdr)' }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--t1)' }}>Messages</h2>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--t4)' }}>
            Customise the messages sent to your customers
          </p>
        </div>

        {categories.map(cat => {
          const catTypes = types.filter(t => t.category === cat);
          if (!catTypes.length) return null;
          return (
            <div key={cat} style={{ marginTop: 16 }}>
              <div style={{
                padding: '0 16px', marginBottom: 6, fontSize: 10,
                fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
                color: 'var(--t4)',
              }}>
                {CATEGORY_ICONS[cat] || ''} {cat}
              </div>
              {catTypes.map(mt => {
                const isSelected = selectedType === mt.type;
                const hasCustom = mt.channels.some(ch => mt.templates[ch]?.isCustom);
                return (
                  <button
                    key={mt.type}
                    onClick={() => selectType(mt.type)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      width: '100%', padding: '10px 16px', border: 'none',
                      background: isSelected ? 'var(--acc)' : 'transparent',
                      color: isSelected ? '#0b0c10' : 'var(--t1)',
                      cursor: 'pointer', fontSize: 13, fontWeight: isSelected ? 700 : 500,
                      textAlign: 'left', borderRadius: 0, transition: 'background 0.15s',
                    }}
                    onMouseEnter={e => { if (!isSelected) e.target.style.background = 'var(--bg3)'; }}
                    onMouseLeave={e => { if (!isSelected) e.target.style.background = 'transparent'; }}
                  >
                    <span style={{ flex: 1 }}>{mt.label}</span>
                    <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {mt.channels.map(ch => (
                        <span key={ch} style={{
                          fontSize: 9, padding: '2px 5px', borderRadius: 4,
                          background: isSelected ? 'rgba(0,0,0,0.15)' : 'var(--bg3)',
                          color: isSelected ? '#0b0c10' : 'var(--t4)',
                          fontWeight: 600,
                        }}>
                          {ch.toUpperCase()}
                        </span>
                      ))}
                      {hasCustom && (
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%',
                          background: isSelected ? '#0b0c10' : 'var(--acc)',
                        }} title="Custom template" />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* ── Right: Template editor ──────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 28 }}>
        {!currentMt ? (
          <div style={{ textAlign: 'center', color: 'var(--t4)', paddingTop: 80 }}>
            Select a message type to edit
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
                <h3 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: 'var(--t1)' }}>
                  {currentMt.label}
                </h3>
                {currentTpl?.isCustom && (
                  <span style={{
                    fontSize: 10, padding: '3px 8px', borderRadius: 6,
                    background: 'var(--acc)', color: '#0b0c10', fontWeight: 700,
                  }}>
                    CUSTOMISED
                  </span>
                )}
              </div>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--t4)' }}>
                {currentMt.description}
              </p>
            </div>

            {/* Channel tabs */}
            {currentMt.channels.length > 1 && (
              <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--bdr)' }}>
                {currentMt.channels.map(ch => (
                  <button
                    key={ch}
                    onClick={() => selectType(selectedType, ch)}
                    style={{
                      flex: 1, padding: '10px 16px', border: 'none', cursor: 'pointer',
                      background: selectedChannel === ch ? 'var(--acc)' : 'var(--bg2)',
                      color: selectedChannel === ch ? '#0b0c10' : 'var(--t1)',
                      fontWeight: selectedChannel === ch ? 700 : 500, fontSize: 13,
                    }}
                  >
                    {CHANNEL_ICONS[ch]} {CHANNEL_LABELS[ch]}
                    {currentMt.templates[ch]?.isCustom && (
                      <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.7 }}>(edited)</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Enabled toggle */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20,
              padding: '10px 14px', background: 'var(--bg2)', borderRadius: 8,
            }}>
              <label style={{
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                fontSize: 13, color: 'var(--t1)',
              }}>
                <input
                  type="checkbox"
                  checked={editEnabled}
                  onChange={e => { setEditEnabled(e.target.checked); setDirty(true); }}
                  style={{ width: 16, height: 16, accentColor: 'var(--acc)' }}
                />
                <span style={{ fontWeight: 600 }}>
                  {editEnabled ? 'Enabled' : 'Disabled'}
                </span>
                <span style={{ color: 'var(--t4)', fontWeight: 400 }}>
                  — {editEnabled
                    ? `this ${selectedChannel === 'sms' ? 'SMS' : 'email'} will be sent automatically`
                    : `this ${selectedChannel === 'sms' ? 'SMS' : 'email'} will NOT be sent`}
                </span>
              </label>
            </div>

            {/* Subject (email only) */}
            {selectedChannel === 'email' && (
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--t4)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Subject Line
                </label>
                <input
                  type="text"
                  value={editSubject}
                  onChange={e => { setEditSubject(e.target.value); setDirty(true); }}
                  placeholder="Email subject..."
                  style={{
                    width: '100%', padding: '10px 14px', fontSize: 14,
                    background: 'var(--bg2)', border: '1px solid var(--bdr)',
                    borderRadius: 8, color: 'var(--t1)', outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            )}

            {/* Body editor */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {selectedChannel === 'sms' ? 'Message' : 'Email Body'}
                </label>
                {selectedChannel === 'sms' && (
                  <span style={{ fontSize: 11, color: charCount > 160 ? '#f59e0b' : 'var(--t4)' }}>
                    {charCount} chars · {smsSegments} segment{smsSegments !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <textarea
                ref={bodyRef}
                value={editBody}
                onChange={e => { setEditBody(e.target.value); setDirty(true); }}
                placeholder={`Enter your ${selectedChannel === 'sms' ? 'SMS message' : 'email body'}...`}
                rows={selectedChannel === 'sms' ? 5 : 12}
                style={{
                  width: '100%', padding: '12px 14px', fontSize: 14, lineHeight: 1.6,
                  background: 'var(--bg2)', border: '1px solid var(--bdr)',
                  borderRadius: 8, color: 'var(--t1)', outline: 'none',
                  resize: 'vertical', fontFamily: 'system-ui, sans-serif',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Merge tags */}
            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--t4)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Available Tags — click to insert
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {currentMt.mergeTags.map(tag => (
                  <button
                    key={tag.tag}
                    onClick={() => insertTag(tag.tag)}
                    title={`${tag.label} — e.g. "${tag.example}"`}
                    style={{
                      padding: '5px 10px', fontSize: 12, fontWeight: 600,
                      background: 'var(--bg3)', border: '1px solid var(--bdr)',
                      borderRadius: 6, color: 'var(--acc)', cursor: 'pointer',
                      fontFamily: 'monospace', transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { e.target.style.background = 'var(--acc)'; e.target.style.color = '#0b0c10'; }}
                    onMouseLeave={e => { e.target.style.background = 'var(--bg3)'; e.target.style.color = 'var(--acc)'; }}
                  >
                    {'{{' + tag.tag + '}}'}
                  </button>
                ))}
              </div>
              <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--t4)' }}>
                Tags are replaced with real values when the message is sent. Hover a tag to see an example.
              </p>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 28 }}>
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                style={{
                  padding: '10px 24px', fontSize: 14, fontWeight: 700,
                  background: dirty ? 'var(--acc)' : 'var(--bg3)',
                  color: dirty ? '#0b0c10' : 'var(--t4)',
                  border: 'none', borderRadius: 8, cursor: dirty ? 'pointer' : 'default',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'Saving...' : 'Save Template'}
              </button>
              <button
                onClick={handlePreview}
                disabled={loadingPreview}
                style={{
                  padding: '10px 24px', fontSize: 14, fontWeight: 600,
                  background: 'var(--bg2)', color: 'var(--t1)',
                  border: '1px solid var(--bdr)', borderRadius: 8, cursor: 'pointer',
                  opacity: loadingPreview ? 0.6 : 1,
                }}
              >
                {loadingPreview ? 'Loading...' : 'Preview'}
              </button>
              {currentTpl?.isCustom && (
                <button
                  onClick={handleReset}
                  disabled={saving}
                  style={{
                    padding: '10px 24px', fontSize: 14, fontWeight: 600,
                    background: 'transparent', color: '#ef4444',
                    border: '1px solid #ef4444', borderRadius: 8, cursor: 'pointer',
                  }}
                >
                  Reset to Default
                </button>
              )}
            </div>

            {/* Template status */}
            <div style={{
              padding: '10px 14px', background: 'var(--bg2)', borderRadius: 8,
              fontSize: 12, color: 'var(--t4)', marginBottom: 24,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: currentTpl?.isCustom ? 'var(--acc)' : '#6b7280',
              }} />
              {currentTpl?.isCustom
                ? `Custom template · Last edited ${currentTpl.updated_at ? new Date(currentTpl.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'recently'}`
                : 'Using default template'}
            </div>

            {/* Preview panel */}
            {showPreview && previewData && (
              <div style={{
                border: '1px solid var(--bdr)', borderRadius: 12,
                overflow: 'hidden', marginBottom: 24,
              }}>
                <div style={{
                  padding: '12px 16px', background: 'var(--bg3)',
                  borderBottom: '1px solid var(--bdr)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>
                    {selectedChannel === 'sms' ? 'SMS Preview' : 'Email Preview'}
                  </span>
                  <button
                    onClick={() => setShowPreview(false)}
                    style={{
                      background: 'none', border: 'none', color: 'var(--t4)',
                      cursor: 'pointer', fontSize: 18, lineHeight: 1,
                    }}
                  >
                    &times;
                  </button>
                </div>

                {selectedChannel === 'sms' ? (
                  /* SMS bubble preview */
                  <div style={{ padding: 20, background: 'var(--bg)' }}>
                    <div style={{
                      maxWidth: 320, padding: '12px 16px',
                      background: '#dcf8c6', borderRadius: '12px 12px 12px 4px',
                      color: '#111', fontSize: 14, lineHeight: 1.5,
                      boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                    }}>
                      {previewData.body}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 6, marginLeft: 4 }}>
                      {previewData.body.length} characters · {Math.ceil(previewData.body.length / 160)} SMS segment{Math.ceil(previewData.body.length / 160) !== 1 ? 's' : ''}
                    </div>
                  </div>
                ) : (
                  /* Email preview */
                  <div style={{ background: '#f4f4f6' }}>
                    {previewData.subject && (
                      <div style={{
                        padding: '12px 16px', background: 'var(--bg2)',
                        borderBottom: '1px solid var(--bdr)',
                        fontSize: 13, color: 'var(--t1)',
                      }}>
                        <strong>Subject:</strong> {previewData.subject}
                      </div>
                    )}
                    {previewData.html ? (
                      <iframe
                        srcDoc={previewData.html}
                        style={{ width: '100%', height: 500, border: 'none' }}
                        title="Email preview"
                        sandbox=""
                      />
                    ) : (
                      <div style={{
                        padding: 20, fontSize: 14, lineHeight: 1.6,
                        color: '#333', whiteSpace: 'pre-wrap',
                      }}>
                        {previewData.body}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
