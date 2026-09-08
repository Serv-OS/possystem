import { useState, useEffect, useRef, useCallback } from 'react';
import { executeTool, executeConfirmedAction, WRITE_TOOLS } from '../lib/aiTools';
import { useStore } from '../store';

const API_ENDPOINT = '/api/ai';

function ToolCallBadge({ name }) {
  const labels = {
    get_sales_summary:    '📊 Looking up sales…',
    get_shift_summary:    '📊 Pulling shift overview…',
    get_top_items:        '🏆 Checking top sellers…',
    search_item_sales:    '🔍 Searching item sales…',
    get_hourly_breakdown: '⏰ Checking hourly data…',
    get_payment_breakdown:'💳 Checking payment breakdown…',
    get_server_performance:'👤 Checking server stats…',
    get_covers_report:    '🧑 Loading covers report…',
    get_floor_status:     '🪑 Checking floor status…',
    get_open_tables:      '🪑 Loading open tables…',
    get_printer_status:   '🖨 Checking printers…',
    get_allergen_info:    '⚠️ Looking up allergens…',
    get_item_detail:      '📋 Looking up item…',
    get_menu_items:       '📋 Loading menu…',
    get_order_history:    '🧾 Loading order history…',
    get_current_order:    '🛒 Checking current order…',
    add_to_order:         '🛒 Preparing to add item…',
    remove_from_order:    '🗑 Preparing to remove item…',
    apply_order_discount: '🏷 Preparing discount…',
    add_menu_item:        '✨ Preparing new item…',
    update_item_price:    '💰 Preparing price change…',
    eighty_six_item:      '🚫 Preparing 86…',
  };
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:10, background:'var(--acc-d)', border:'1px solid var(--acc-b)', fontSize:12, color:'var(--acc)', fontWeight:600, marginBottom:8 }}>
      <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--acc)', animation:'pulse 1s infinite' }}/>
      {labels[name] || `Using ${name}…`}
    </div>
  );
}

function PendingActionCard({ action, onConfirm, onCancel }) {
  return (
    <div style={{ border:'1.5px solid var(--acc-b)', borderRadius:12, overflow:'hidden', marginBottom:12 }}>
      <div style={{ padding:'10px 14px', background:'var(--acc-d)', borderBottom:'1px solid var(--acc-b)', fontSize:11, fontWeight:700, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.06em' }}>
        ⚡ Action requires confirmation
      </div>
      <div style={{ padding:'12px 14px', background:'var(--bg3)' }}>
        <div style={{ fontSize:13, color:'var(--t1)', marginBottom:12, lineHeight:1.5 }}>{action.label}</div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={onConfirm} style={{ flex:1, padding:'9px', borderRadius:8, border:'none', background:'var(--acc)', color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>
            ✓ Confirm
          </button>
          <button onClick={onCancel} style={{ flex:1, padding:'9px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t2)', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AIChat({ mode = 'foh', initialContext = '', placeholder = 'Ask anything…', compact = false, staff = null }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [toolRunning, setToolRunning] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  const store = useStore();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, pendingAction]);

  // Always read fresh from store.getState() — never use stale snapshot
  // This ensures the AI always sees the current menu, even if items loaded after mount
  const getStoreState = () => {
    const s = useStore.getState();
    return {
      menuItems:         s.menuItems || [],
      menuCategories:    s.menuCategories || [],
      modifierGroupDefs: s.modifierGroupDefs || [],
      menus:             s.menus || [],
      closedChecks:      s.closedChecks || [],
      tables:            s.tables || [],
      activeTableId:     s.activeTableId || null,
      walkInOrder:       s.walkInOrder || null,
      eightySixIds:      s.eightySixIds || [],
      // v5.5.735: broader operational state so the AI can answer stock / queue / waitlist questions
      dailyCounts:       s.dailyCounts || {},
      orderQueue:        s.orderQueue || [],
      waitlist:          s.waitlist || [],
      staffMembers:      s.staffMembers || [],
      discountPresets:   s.discountPresets || [],
    };
  };

  const getStoreActions = useCallback(() => ({
    addMenuItem:    store.addMenuItem,
    updateMenuItem: store.updateMenuItem,
    toggle86:       store.toggle86,
    addItem:        store.addItem,
    voidItem:       store.voidItem,
    activeTableId:  store.activeTableId,
    applyDiscount:  store.applyDiscount || store.setOrderDiscount,
  }), [store]);

  // Build messages array for the API (full conversation history with tool results)
  const buildApiMessages = useCallback((msgs) => {
    return msgs.map(m => {
      if (m.role === 'tool_result') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.tool_use_id, content: JSON.stringify(m.result) }],
        };
      }
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          role: 'assistant',
          content: m.tool_calls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }, []);

  const sendToAPI = useCallback(async (msgs) => {
    const res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: buildApiMessages(msgs), mode }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'API error');
    }
    return res.json();
  }, [mode, buildApiMessages]);

  const processResponse = useCallback(async (data, currentMessages) => {
    // Tool use response — execute tools and continue the loop
    if (data.stop_reason === 'tool_use') {
      const toolCalls = data.content.filter(c => c.type === 'tool_use');

      // Add assistant tool_call message
      const assistantMsg = { role: 'assistant', tool_calls: toolCalls, content: data.content.find(c => c.type === 'text')?.text || '' };
      const withAssistant = [...currentMessages, assistantMsg];
      setMessages(withAssistant);

      // Execute each tool
      const toolResults = [];
      for (const tc of toolCalls) {
        setToolRunning(tc.name);
        const { result, pendingAction: pa } = await executeTool(tc.name, tc.input, getStoreState());

        if (pa) {
          // Write tool — show confirmation UI, pause the loop
          setToolRunning(null);
          setPendingAction({ ...pa, tool_use_id: tc.id, pendingMessages: withAssistant });
          setLoading(false);
          return;
        }

        toolResults.push({ role: 'tool_result', tool_use_id: tc.id, result });
      }
      setToolRunning(null);

      const withResults = [...withAssistant, ...toolResults];
      setMessages(withResults);

      // Continue the loop
      const nextData = await sendToAPI(withResults);
      await processResponse(nextData, withResults);

    } else {
      // Final text response
      const text = data.content?.find(c => c.type === 'text')?.text || 'No response.';
      setMessages(m => [...m, { role: 'assistant', content: text }]);
      setLoading(false);
    }
  }, [getStoreState, sendToAPI]);

  const send = useCallback(async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput('');
    setError(null);
    setPendingAction(null);
    setLoading(true);

    const userMsg = { role: 'user', content: msg };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);

    try {
      const data = await sendToAPI(newMessages);
      await processResponse(data, newMessages);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }, [input, loading, messages, sendToAPI, processResponse]);

  const confirmAction = useCallback(async () => {
    if (!pendingAction) return;
    const { pendingMessages, ...action } = pendingAction;
    setPendingAction(null);
    setLoading(true);

    // Execute the action
    const result = await executeConfirmedAction(action, getStoreActions());

    // Tell the AI what happened
    const toolResult = { role: 'tool_result', tool_use_id: action.tool_use_id, result };
    const withResult = [...pendingMessages, toolResult];
    setMessages(withResult);

    try {
      const data = await sendToAPI(withResult);
      await processResponse(data, withResult);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }, [pendingAction, getStoreActions, sendToAPI, processResponse]);

  const cancelAction = useCallback(() => {
    if (!pendingAction) return;
    const { pendingMessages } = pendingAction;
    const toolResult = {
      role: 'tool_result',
      tool_use_id: pendingAction.tool_use_id,
      result: { cancelled: true, message: 'User cancelled this action' },
    };
    const withResult = [...pendingMessages, toolResult];
    setMessages(withResult);
    setPendingAction(null);
    setLoading(true);

    sendToAPI(withResult)
      .then(data => processResponse(data, withResult))
      .catch(err => { setError(err.message); setLoading(false); });
  }, [pendingAction, sendToAPI, processResponse]);

  const clearChat = () => { setMessages([]); setPendingAction(null); setError(null); };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Filter display messages — hide internal tool messages from the UI
  const displayMessages = messages.filter(m => !m.tool_calls && m.role !== 'tool_result');

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
      {/* Messages */}
      <div style={{ flex:1, overflowY:'auto', padding: compact ? '12px 16px' : '16px 24px' }}>
        {displayMessages.length === 0 && (
          <div style={{ textAlign:'center', padding:'40px 20px', color:'var(--t4)' }}>
            <div style={{ fontSize:32, marginBottom:10 }}>✦</div>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--t2)', marginBottom:6 }}>
              {mode === 'boh' ? 'Restaurant AI Assistant' : 'AI Shift Assistant'}
            </div>
            <div style={{ fontSize:12, color:'var(--t4)', lineHeight:1.7 }}>
              {mode === 'boh'
                ? 'Ask about sales, servers, items sold, open tables, or say "update a price"'
                : 'Ask about the shift, item sales, open tables, allergens, or add to an order'}
            </div>
            {mode === 'boh' && (
              <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:16, justifyContent:'center' }}>
                {["How's the shift going?", "How many lattes sold?", "Who's selling the most?", "What's been the busiest hour?", "What tables are still open?", "Show payment breakdown"].map(q => (
                  <button key={q} onClick={() => send(q)} style={{ padding:'6px 12px', borderRadius:20, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t2)', fontSize:11, cursor:'pointer', fontFamily:'inherit', fontWeight:600 }}>{q}</button>
                ))}
              </div>
            )}
            {mode === 'foh' && (
              <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:16, justifyContent:'center' }}>
                {["How's the shift going?", "What tables are open?", "How many pints sold?", "Who's been seated longest?", "Allergens in the risotto?", "Is the kitchen printer online?"].map(q => (
                  <button key={q} onClick={() => send(q)} style={{ padding:'6px 12px', borderRadius:20, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t2)', fontSize:11, cursor:'pointer', fontFamily:'inherit', fontWeight:600 }}>{q}</button>
                ))}
              </div>
            )}
          </div>
        )}

        {displayMessages.map((m, i) => (
          <div key={i} style={{ display:'flex', gap:10, marginBottom:14, justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {m.role === 'assistant' && (
              <div style={{ width:28, height:28, borderRadius:8, background:'var(--acc-d)', border:'1px solid var(--acc-b)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, flexShrink:0, marginTop:2 }}>✦</div>
            )}
            <div style={{
              maxWidth:'80%', padding:'10px 14px',
              borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '4px 16px 16px 16px',
              background: m.role === 'user' ? 'var(--acc)' : 'var(--bg3)',
              border: m.role === 'user' ? 'none' : '1px solid var(--bdr)',
              color: m.role === 'user' ? '#0b0c10' : 'var(--t1)',
              fontSize: compact ? 12 : 13,
              lineHeight: 1.6,
              fontWeight: m.role === 'user' ? 600 : 400,
              whiteSpace: 'pre-wrap',
            }}>
              {m.content}
            </div>
            {m.role === 'user' && staff && (
              <div style={{ width:28, height:28, borderRadius:'50%', background:(staff.color||'var(--acc)')+'22', border:`2px solid ${(staff.color||'var(--acc)')}44`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, color:staff.color||'var(--acc)', flexShrink:0, marginTop:2 }}>
                {staff.initials || '?'}
              </div>
            )}
          </div>
        ))}

        {toolRunning && <div style={{ paddingLeft: 38 }}><ToolCallBadge name={toolRunning}/></div>}

        {loading && !toolRunning && (
          <div style={{ display:'flex', gap:10, marginBottom:14 }}>
            <div style={{ width:28, height:28, borderRadius:8, background:'var(--acc-d)', border:'1px solid var(--acc-b)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:13 }}>✦</div>
            <div style={{ padding:'12px 16px', borderRadius:'4px 16px 16px 16px', background:'var(--bg3)', border:'1px solid var(--bdr)', display:'flex', gap:5, alignItems:'center' }}>
              {[0,1,2].map(i => <div key={i} style={{ width:6, height:6, borderRadius:'50%', background:'var(--acc)', opacity:.6, animation:`bounce 1.2s ease-in-out ${i * .2}s infinite` }}/>)}
            </div>
          </div>
        )}

        {pendingAction && (
          <div style={{ paddingLeft: 38 }}>
            <PendingActionCard action={pendingAction} onConfirm={confirmAction} onCancel={cancelAction}/>
          </div>
        )}

        {error && (
          <div style={{ padding:'10px 14px', borderRadius:10, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, marginBottom:10 }}>
            ⚠ {error}
          </div>
        )}

        <div ref={bottomRef}/>
      </div>

      {/* Input */}
      <div style={{ padding: compact ? '10px 12px' : '14px 16px', borderTop:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
        <div style={{ display:'flex', gap:8, alignItems:'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder}
            rows={1}
            disabled={loading}
            style={{
              flex:1, padding:'10px 14px', borderRadius:10,
              border:'1px solid var(--bdr)', background:'var(--bg)',
              color:'var(--t1)', fontSize: compact ? 12 : 13,
              fontFamily:'inherit', resize:'none', outline:'none',
              lineHeight:1.5, maxHeight:120, overflowY:'auto',
              opacity: loading ? .5 : 1,
            }}
          />
          <button
            onClick={() => send()}
            disabled={!input.trim() || loading}
            style={{
              width:38, height:38, borderRadius:10, border:'none', flexShrink:0,
              background: input.trim() && !loading ? 'var(--acc)' : 'var(--bg3)',
              color: input.trim() && !loading ? '#fff' : 'var(--t4)',
              cursor: input.trim() && !loading ? 'pointer' : 'default',
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:16,
            }}
          >→</button>
        </div>
        {messages.length > 0 && (
          <button onClick={clearChat} style={{ fontSize:10, color:'var(--t4)', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit', marginTop:6 }}>Clear conversation</button>
        )}
      </div>

      <style>{`
        @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:.3} }
      `}</style>
    </div>
  );
}
