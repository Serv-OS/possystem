// OrderDetailsModal (5 Nov 2026, Peter): "Like the table flag number we can force to bring it up:
// a number of guests in the party, order type, new customer question yes or no, yes equals flag
// on the KDS or production ticket. These all need to be able to be turned off and on in the same
// place as the force table flag feature." And: "its not that its forced, its that it pops up. I
// want one screen that has this info and each one can be turned off and on."
//
// ONE screen, POS only. Shown by POSSurface before a walk in order is sent or paid, whichever
// comes first, when any part the device profile switches on is still unanswered
// (lib/tillOrderType.js needsOrderDetails). The parts:
//   Order type     the profile's enabled types as buttons, the till's current type preselected
//   New customer?  Yes / No
//   Flag number    the 30 Sep 2026 keypad (1 to 4 digits), dine in only
//   Guests         how many in the party (1 to 99), dine in only
// The flag and the guests share one keypad; when both show, tap a box to type into it. Picking
// takeaway, collection, delivery or drive thru on this screen hides the flag and the guests.
// Staff cannot skip a part that shows: there is no skip, only Back to the order. Replaces
// FlagNumberModal (30 Sep 2026), whose keypad this keeps.

import { useState } from 'react';
import {
  cleanFlagNumber, flagTableLabel, FLAG_MAX_DIGITS, cleanGuests, GUESTS_MAX, orderDetailsSections, ORDER_TYPE_KEYS,
} from '../lib/tillOrderType';

const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
const TYPE_LABEL = { 'dine-in': 'Dine in', takeaway: 'Takeaway', collection: 'Collection', delivery: 'Delivery', 'drive-thru': 'Drive thru' };
const GUESTS_DIGITS = String(GUESTS_MAX).length;

const LABEL = { display:'block', fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 };

function Choice({ label, on, onClick, ariaLabel }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} aria-label={ariaLabel || label} style={{
      flex:1, minWidth:0, height:46, borderRadius:12, cursor:'pointer', fontFamily:'inherit', fontSize:14, fontWeight:700,
      background: on ? 'var(--acc-d)' : 'var(--bg3)', border:`1.5px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`,
      color: on ? 'var(--acc)' : 'var(--t1)', transition:'all .1s', padding:'0 8px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
    }}>{label}</button>
  );
}

function NumberBox({ label, value, placeholder, active, onClick, ariaLabel }) {
  return (
    <button type="button" onClick={onClick} aria-label={ariaLabel} aria-pressed={active} style={{
      flex:1, minWidth:0, borderRadius:14, padding:'10px 12px', cursor:'pointer', fontFamily:'inherit', textAlign:'center',
      background:'var(--bg3)', border:`1.5px solid ${active ? 'var(--acc)' : 'var(--bdr2)'}`, transition:'all .1s',
    }}>
      <div style={{ fontSize:11, fontWeight:700, color: active ? 'var(--acc)' : 'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em' }}>{label}</div>
      <div aria-live="polite" style={{
        marginTop:4, fontSize:26, fontWeight:800, letterSpacing:'.04em', minHeight:32,
        color: value ? 'var(--t1)' : 'var(--t4)', fontFamily: value ? 'var(--font-mono), ui-monospace, monospace' : 'inherit',
      }}>{value || placeholder}</div>
    </button>
  );
}

/**
 *   action            'send' | 'pay': the button's verb
 *   deviceConfig      the profile switches (orderDetailsSections)
 *   ask               the parts still to ask, from needsOrderDetails
 *   orderType         the till's current type
 *   enabledOrderTypes the profile's enabled types (the order type buttons)
 *   walkInOrder       the answers already on the order (a part answered before is not shown again)
 *   onConfirm(answers) { orderType?, tableFlag?, covers?, newCustomer? }: only the parts shown
 *   onClose           Back to order
 */
export default function OrderDetailsModal({ action = 'send', deviceConfig, ask, orderType, enabledOrderTypes, walkInOrder, onConfirm, onClose }) {
  const on = orderDetailsSections(deviceConfig);
  const need = ask || {};
  const types = (Array.isArray(enabledOrderTypes) && enabledOrderTypes.length ? enabledOrderTypes : ['dine-in']).filter(t => ORDER_TYPE_KEYS.includes(t));
  const [picked, setPicked] = useState(types.includes(orderType) ? orderType : (types[0] || 'dine-in'));
  const [flagVal, setFlagVal] = useState('');
  const [guestsVal, setGuestsVal] = useState('');
  const [newCustomer, setNewCustomer] = useState(null);
  const [focus, setFocus] = useState(null);   // 'flag' | 'guests' | null (the first shown box)

  const dineIn = picked === 'dine-in';
  // A part shows when it is on, still unanswered on the order, and the picked type wants it.
  const showType = !!need.orderType;
  const showNew = !!need.newCustomer;
  const showFlag = on.flag && dineIn && !cleanFlagNumber(walkInOrder?.tableFlag);
  const showGuests = on.guests && dineIn && !cleanGuests(walkInOrder?.covers);
  const flag = cleanFlagNumber(flagVal);
  const guests = cleanGuests(guestsVal);
  const activeBox = showFlag && showGuests ? (focus || 'flag') : showFlag ? 'flag' : showGuests ? 'guests' : null;

  const press = (k) => {
    if (activeBox === 'flag') setFlagVal(v => k === '⌫' ? v.slice(0, -1) : (v.length < FLAG_MAX_DIGITS ? v + k : v));
    else if (activeBox === 'guests') setGuestsVal(v => k === '⌫' ? v.slice(0, -1) : (v.length < GUESTS_DIGITS ? v + k : v));
  };
  const activeVal = activeBox === 'flag' ? flagVal : activeBox === 'guests' ? guestsVal : '';

  const missing = [
    showFlag && !flag && 'flag number',
    showGuests && !guests && 'guests',
    showNew && typeof newCustomer !== 'boolean' && 'new customer',
  ].filter(Boolean);
  const ready = missing.length === 0;
  const verb = action === 'pay' ? 'Pay' : 'Send';

  const submit = () => {
    if (!ready) return;
    const answers = {};
    if (showType) answers.orderType = picked;
    if (showFlag) answers.tableFlag = flag;
    if (showGuests) answers.covers = guests;
    if (showNew) answers.newCustomer = newCustomer;
    onConfirm(answers);
  };

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Order details" style={{
        background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:22,
        width:'100%', maxWidth:400, display:'flex', flexDirection:'column',
        boxShadow:'var(--sh3)', overflow:'hidden', animation:'slideUp .18s cubic-bezier(.2,.8,.3,1)',
      }}>
        <div style={{ padding:'18px 20px 4px' }}>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)' }}>Order details</div>
          <div style={{ fontSize:12, color:'var(--t3)', marginTop:4 }}>Before this order is {action === 'pay' ? 'paid' : 'sent'}.</div>
        </div>

        <div style={{ padding:'12px 20px 0', display:'flex', flexDirection:'column', gap:14 }}>
          {showType && (
            <div>
              <label style={LABEL}>Order type</label>
              <div style={{ display:'flex', gap:8 }}>
                {types.map(t => <Choice key={t} label={TYPE_LABEL[t] || t} on={picked === t} onClick={() => setPicked(t)}/>)}
              </div>
            </div>
          )}

          {showNew && (
            <div>
              <label style={LABEL}>New customer?</label>
              <div style={{ display:'flex', gap:8 }}>
                <Choice label="Yes" ariaLabel="New customer: yes" on={newCustomer === true} onClick={() => setNewCustomer(true)}/>
                <Choice label="No" ariaLabel="New customer: no" on={newCustomer === false} onClick={() => setNewCustomer(false)}/>
              </div>
            </div>
          )}

          {(showFlag || showGuests) && (
            <div>
              <div style={{ display:'flex', gap:8 }}>
                {showFlag && <NumberBox label="Flag number" ariaLabel="Flag number" value={flag ? flagTableLabel(flag) : ''} placeholder="Table" active={activeBox === 'flag'} onClick={() => setFocus('flag')}/>}
                {showGuests && <NumberBox label="Guests" ariaLabel="Guests in the party" value={guests ? String(guests) : ''} placeholder="How many" active={activeBox === 'guests'} onClick={() => setFocus('guests')}/>}
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, marginTop:10 }}>
                {KEYS.map((k, i) => k === ''
                  ? <div key={i} aria-hidden="true"/>
                  : (
                    <button key={i} type="button" onClick={() => press(k)} disabled={k === '⌫' && !activeVal}
                      aria-label={k === '⌫' ? 'Delete' : k} style={{
                        height:50, borderRadius:12, cursor:'pointer', fontFamily:'inherit',
                        background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t1)',
                        fontSize: k === '⌫' ? 20 : 22, fontWeight:700,
                        opacity: k === '⌫' && !activeVal ? .4 : 1,
                      }}>{k}</button>
                  ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding:'14px 20px 18px', display:'flex', gap:8 }}>
          <button type="button" className="btn btn-ghost" style={{ flex:1, height:44 }} onClick={onClose}>Back to order</button>
          <button type="button" className="btn btn-acc" style={{ flex:2, height:44, fontWeight:800 }} disabled={!ready} onClick={submit}>
            {ready ? `${verb}${showFlag && flag ? ` · ${flagTableLabel(flag)}` : ''}` : `Enter the ${missing[0]} to ${verb.toLowerCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}
