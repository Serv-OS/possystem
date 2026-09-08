/**
 * OrderTypeModal — shown when Send is pressed with no table/type set up
 *
 * Step 1: Choose the order type
 * Step 2: Collect required details (name, table, time, etc.)
 * Step 3: Confirm → sends to kitchen, routes to correct hub, clears POS
 *
 * This replaces SendWithoutTableModal entirely.
 */
import { useState, useRef } from 'react';
import { useStore } from '../store';
import { sortTables } from '../lib/sortTables';
import { money } from '../lib/currency';

const TYPES = [
  {
    id: 'counter',
    label: 'Counter / named',
    icon: '🏷',
    color: '#22d3ee',
    desc: 'Named order at the counter — goes straight to kitchen',
    shortDesc: 'Named counter order',
  },
  {
    id: 'dine-in',
    label: 'Seat at table',
    icon: '⬚',
    color: '#3b82f6',
    desc: 'Assign to a specific table on the floor plan',
    shortDesc: 'Table order',
  },
  {
    id: 'bar',
    label: 'Bar tab',
    icon: '🍸',
    color: '#a855f7',
    desc: 'Open a new bar tab or add to an existing one',
    shortDesc: 'Bar tab',
  },
  {
    id: 'takeaway',
    label: 'Takeaway',
    icon: '🥡',
    color: '#e8a020',
    desc: 'Customer will collect — provide name and collection time',
    shortDesc: 'Takeaway',
  },
  {
    id: 'collection',
    label: 'Click & collect',
    icon: '📦',
    color: '#22c55e',
    desc: 'Pre-ordered collection — name and time required',
    shortDesc: 'Collection',
  },
  {
    id: 'delivery',
    label: 'Delivery',
    icon: '🛵',
    color: '#ef4444',
    desc: 'Delivered to the customer — name and address required',
    shortDesc: 'Delivery',
  },
];

const inp = {
  background: 'var(--bg3)',
  border: '1.5px solid var(--bdr2)',
  borderRadius: 10,
  padding: '10px 13px',
  color: 'var(--t1)',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  transition: 'border-color .15s',
};

export default function OrderTypeModal({ items, onClose, onComplete }) {
  const { tables, tabs, seatTableWithItems, mergeItemsToTable, splitTableCheck, openTab, showToast, staff, takeawayCustomerDetails } = useStore();
  const [step, setStep] = useState('type');       // type | details | table_pick | tab_pick
  const [selectedType, setSelectedType] = useState(null);
  const [form, setForm] = useState({ name: '', phone: '', time: '', address: '', isASAP: false, tabName: '' });
  const nameRef = useRef(null);

  const itemCount = items?.length || 0;
  const subtotal  = items?.reduce((s, i) => s + i.price * i.qty, 0) || 0;

  // v5.5.13: natural-sorted by section + label so the picker shows T1, T2,
  // T9, T10 in expected order rather than store-order.
  const availableTables = sortTables(tables.filter(t => t.status === 'available'));
  const occupiedTables  = sortTables(tables.filter(t => t.status !== 'available' && t.session));
  const openTabs        = tabs?.filter(t => t.status !== 'closed') || [];

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // v5.5.799: venue setting — how much customer detail takeaway/collection asks for.
  // 'none' skips the details step entirely; 'name' shows only the name field below.
  const takeawayMode = takeawayCustomerDetails || 'full';

  const handleTypeSelect = (type) => {
    setSelectedType(type);
    if (type.id === 'dine-in') { setStep('table_pick'); return; }
    if (type.id === 'bar')     { setStep('tab_pick');   return; }
    if ((type.id === 'takeaway' || type.id === 'collection') && takeawayMode === 'none') {
      // Straight to kitchen — the order carries its short ref like an unnamed walk-in.
      onComplete({ type: type.id, name: '', phone: '', time: '', isASAP: true, orderType: type.id, channel: type.id });
      return;
    }
    setStep('details');
    setTimeout(() => nameRef.current?.focus(), 80);
  };

  // ── Confirm actions ──────────────────────────────────────────────────────
  const confirmCounter = () => {
    const name = form.name.trim() || `Order ${Date.now() % 10000}`;
    onComplete({ type: 'counter', name, orderType: 'dine-in', channel: 'counter' });
  };

  const confirmTakeaway = () => {
    if (!form.name.trim()) { showToast('Customer name required', 'error'); return; }
    onComplete({ type: selectedType.id, name: form.name.trim(), phone: form.phone, time: form.time, isASAP: form.isASAP, orderType: selectedType.id, channel: selectedType.id });
  };

  const confirmDelivery = () => {
    if (!form.name.trim()) { showToast('Customer name required', 'error'); return; }
    onComplete({ type: 'delivery', name: form.name.trim(), phone: form.phone, address: form.address, orderType: 'delivery', channel: 'delivery' });
  };

  const confirmNewTab = () => {
    const name = form.tabName.trim() || (form.name.trim()) || `Tab ${Date.now() % 1000}`;
    onComplete({ type: 'bar', tabName: name, orderType: 'dine-in', channel: 'bar', action: 'new' });
  };

  const confirmAddToTab = (tab) => {
    onComplete({ type: 'bar', tabId: tab.id, tabName: tab.name, orderType: 'dine-in', channel: 'bar', action: 'add' });
  };

  const confirmSeatTable = (table) => {
    onComplete({ type: 'dine-in', tableId: table.id, tableLabel: table.label, orderType: 'dine-in', channel: 'table', action: 'new' });
  };

  const confirmMergeTable = (table) => {
    onComplete({ type: 'dine-in', tableId: table.id, tableLabel: table.label, orderType: 'dine-in', channel: 'table', action: 'merge' });
  };

  // ── Shared layout ────────────────────────────────────────────────────────
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 20,
        width: '100%', maxWidth: 480, maxHeight: '88vh',
        display: 'flex', flexDirection: 'column', boxShadow: 'var(--sh3)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          {step !== 'type' && (
            <button onClick={() => setStep('type')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)', fontSize: 20, lineHeight: 1, padding: '0 4px 0 0' }}>‹</button>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>
              {step === 'type'       && 'How is this order being served?'}
              {step === 'details'    && selectedType?.label}
              {step === 'table_pick' && 'Choose a table'}
              {step === 'tab_pick'   && 'Bar tab'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>
              {itemCount} item{itemCount !== 1 ? 's' : ''} · {money(subtotal)}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--t4)', cursor: 'pointer', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>

          {/* ── Step 1: Type picker ── */}
          {step === 'type' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {TYPES.map(type => (
                <button key={type.id} onClick={() => handleTypeSelect(type)} style={{
                  padding: '14px 16px', borderRadius: 13, cursor: 'pointer', fontFamily: 'inherit',
                  textAlign: 'left', border: `1.5px solid ${type.color}33`,
                  background: `${type.color}0a`, display: 'flex', alignItems: 'center', gap: 14,
                  transition: 'all .12s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = `${type.color}18`; e.currentTarget.style.borderColor = `${type.color}66`; }}
                onMouseLeave={e => { e.currentTarget.style.background = `${type.color}0a`; e.currentTarget.style.borderColor = `${type.color}33`; }}>
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: `${type.color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>
                    {type.icon}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', marginBottom: 2 }}>{type.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.4 }}>{type.desc}</div>
                  </div>
                  <span style={{ color: 'var(--t4)', fontSize: 18 }}>›</span>
                </button>
              ))}
            </div>
          )}

          {/* ── Step 2a: Counter / named ── */}
          {step === 'details' && selectedType?.id === 'counter' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ padding: '12px 14px', background: 'var(--bg3)', borderRadius: 11, border: '1px solid var(--bdr)', fontSize: 12, color: 'var(--t3)', lineHeight: 1.5 }}>
                🏷 Order will be sent to kitchen immediately and appear in the Orders Hub with this name. The POS will clear ready for the next order.
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 6 }}>Customer name or reference (optional)</div>
                <input ref={nameRef} style={inp} value={form.name} onChange={e => setField('name', e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && confirmCounter()}
                  placeholder="e.g. Table 3, John, Walk-in 1, Counter" />
              </div>
              <button onClick={confirmCounter} style={{ ...sendBtn('#22d3ee'), marginTop: 4 }}>
                Send to kitchen →
              </button>
            </div>
          )}

          {/* ── Step 2b: Takeaway / Collection ── */}
          {step === 'details' && (selectedType?.id === 'takeaway' || selectedType?.id === 'collection') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 6 }}>Customer name *</div>
                <input ref={nameRef} style={inp} value={form.name} onChange={e => setField('name', e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && confirmTakeaway()}
                  placeholder="Customer name" autoFocus />
              </div>
              {/* v5.5.799: 'Name only' mode — just the name, no phone */}
              {takeawayMode !== 'name' && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 6 }}>Phone (optional)</div>
                <input style={inp} type="tel" value={form.phone} onChange={e => setField('phone', e.target.value)} placeholder="+44 7700 000000" />
              </div>
              )}
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 6 }}>Collection time</div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                  <input type="checkbox" checked={form.isASAP} onChange={e => setField('isASAP', e.target.checked)} style={{ accentColor: 'var(--acc)', width: 16, height: 16 }} />
                  <span style={{ fontSize: 13, color: 'var(--t2)' }}>⚡ ASAP</span>
                </label>
                {!form.isASAP && (
                  <input style={inp} type="time" value={form.time} onChange={e => setField('time', e.target.value)} />
                )}
              </div>
              <button onClick={confirmTakeaway} disabled={!form.name.trim()} style={{ ...sendBtn(selectedType.color), opacity: form.name.trim() ? 1 : .4 }}>
                Send {selectedType.icon} →
              </button>
            </div>
          )}

          {/* ── Step 2c: Delivery ── */}
          {step === 'details' && selectedType?.id === 'delivery' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 6 }}>Customer name *</div>
                <input ref={nameRef} style={inp} value={form.name} onChange={e => setField('name', e.target.value)} placeholder="Customer name" autoFocus />
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 6 }}>Phone</div>
                <input style={inp} type="tel" value={form.phone} onChange={e => setField('phone', e.target.value)} placeholder="+44 7700 000000" />
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 6 }}>Delivery address</div>
                <textarea style={{ ...inp, resize: 'none', height: 64 }} value={form.address} onChange={e => setField('address', e.target.value)} placeholder="Street, city, postcode" />
              </div>
              <button onClick={confirmDelivery} disabled={!form.name.trim()} style={{ ...sendBtn('#ef4444'), opacity: form.name.trim() ? 1 : .4 }}>
                Send for delivery 🛵 →
              </button>
            </div>
          )}

          {/* ── Step 3: Table picker ── */}
          {step === 'table_pick' && (
            <div>
              {availableTables.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 10 }}>Available tables</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))', gap: 8, marginBottom: 16 }}>
                    {availableTables.map(t => (
                      <button key={t.id} onClick={() => confirmSeatTable(t)} style={{
                        height: 72, borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
                        background: 'var(--grn-d)', border: '1.5px solid var(--grn-b)',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
                        transition: 'all .12s',
                      }}>
                        <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--grn)' }}>{t.label}</span>
                        <span style={{ fontSize: 10, color: 'var(--grn)', opacity: .7 }}>Seat here</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              {occupiedTables.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 10 }}>Occupied — choose how to add</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {occupiedTables.map(t => (
                      <div key={t.id} style={{ padding: '12px', borderRadius: 11, border: '1px solid var(--bdr)', background: 'var(--bg3)' }}>
                        <div style={{ marginBottom: 8 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{t.label}</div>
                          <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 2 }}>
                            {t.session?.items?.filter(i => !i.voided).length || 0} items · {money((t.session?.subtotal || 0))} · {t.session?.server || 'no server'}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => confirmMergeTable(t)} style={{ flex: 1, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--acc-d)', border: '1px solid var(--acc-b)', color: 'var(--acc)', fontSize: 11, fontWeight: 700 }}>
                            ⊕ Add to this check
                          </button>
                          <button onClick={() => onComplete({ type: 'dine-in', action: 'split', tableId: t.id, tableLabel: t.label })} style={{ flex: 1, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--bg1)', border: '1px solid var(--bdr2)', color: 'var(--t2)', fontSize: 11, fontWeight: 600 }}>
                            ⊗ New separate check
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {availableTables.length === 0 && occupiedTables.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--t4)' }}>
                  <div style={{ fontSize: 32, marginBottom: 10, opacity: .3 }}>⬚</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t2)' }}>No tables configured</div>
                  <div style={{ fontSize: 11, marginTop: 4 }}>Set up your floor plan in Back Office → Floor plan</div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 4: Bar tab picker ── */}
          {step === 'tab_pick' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* New tab */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 8 }}>Open new bar tab</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input ref={nameRef} style={{ ...inp, flex: 1, width: 'auto', minWidth: 0 }} value={form.tabName} onChange={e => setField('tabName', e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && form.tabName.trim() && confirmNewTab()}
                    placeholder="Tab name (e.g. John, Table 5 bar)" autoFocus />
                  <button onClick={confirmNewTab} disabled={!form.tabName.trim()} style={{ ...sendBtn('#a855f7'), padding: '10px 16px', width: 'auto', flexShrink: 0, opacity: form.tabName.trim() ? 1 : .4 }}>
                    Open →
                  </button>
                </div>
              </div>

              {/* Existing tabs */}
              {openTabs.length > 0 && (
                <>
                  <div style={{ height: 1, background: 'var(--bdr)' }} />
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 4 }}>Add to existing tab</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {openTabs.map(tab => (
                      <button key={tab.id} onClick={() => confirmAddToTab(tab)} style={{
                        padding: '11px 14px', borderRadius: 11, cursor: 'pointer', fontFamily: 'inherit',
                        border: '1.5px solid var(--bdr)', background: 'var(--bg3)', textAlign: 'left',
                        display: 'flex', alignItems: 'center', gap: 10, transition: 'all .12s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = '#a855f755'; e.currentTarget.style.background = '#a855f710'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--bdr)'; e.currentTarget.style.background = 'var(--bg3)'; }}>
                        <span style={{ fontSize: 20 }}>🍸</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{tab.name || tab.id}</div>
                          <div style={{ fontSize: 10, color: 'var(--t4)' }}>
                            {money((tab.total || 0))} · {tab.rounds?.length || 0} round{tab.rounds?.length !== 1 ? 's' : ''}
                          </div>
                        </div>
                        <span style={{ color: 'var(--t3)', fontSize: 16 }}>›</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function sendBtn(color) {
  return {
    padding: '13px 20px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
    background: color, border: 'none', color: '#0b0c10', fontSize: 14, fontWeight: 800,
    width: '100%', transition: 'opacity .15s',
  };
}
